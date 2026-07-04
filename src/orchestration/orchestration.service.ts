import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { Annotation, END, START, StateGraph, NodeInterrupt, type CompiledStateGraph } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createCheckpointer } from './graph/checkpointer';
import { buildDevFlowGraph, buildGraph } from './graph/devflow.graph';
import { buildSimulationNodeImpls } from './graph/simulation-nodes';
import { DevFlowStateType, ProjectContract } from './graph/devflow.state';
import { PrismaService } from '../prisma/prisma.service';
import { RequirementsParserNode } from './nodes/requirements-parser.node';
import { ContractNegotiatorNode } from './nodes/contract-negotiator.node';
import { FrontendAgentNode } from './nodes/frontend-agent.node';
import { BackendAgentNode } from './nodes/backend-agent.node';
import { DatabaseAgentNode } from './nodes/database-agent.node';
import { ArchitectureAgentNode } from './nodes/architecture-agent.node';
import { ValidatorNode } from './nodes/validator.node';
import { GithubCommitNode } from './nodes/github-commit.node';
import { SelfCritiqueNode } from './nodes/self-critique.node';
import { MemoryService } from '../memory/memory.service';
import { DevFlowGateway } from '../gateway/devflow.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import {
  GithubDeliveryStatus,
  GithubDeliveryVerification,
  GithubService,
} from '../github/github.service';
import { AgentProviderRegistry } from './providers/agent-provider.registry';
import { ArtifactContractValidator } from './providers/artifact-contract.validator';
import { OutputValidationService } from './output-validation/output-validation.service';
import {
  GraphLlmProvider,
  GraphLlmProviderVerification,
} from './providers/graph-llm.provider';
import { OrchestrationEmitter } from './streaming/orchestration-emitter.service';
import { AgentProviderMode, AgentProviderStatus } from './providers/agent-provider.types';
import {
  agentArtifactContractFor,
  ORCHESTRATION_CONTRACT_VERSION,
} from './providers/agent-contracts';
import {
  ArtifactValidationStatus,
  NotificationType,
  OrchestrationRunStatus,
  OrchestrationRunTrigger,
  Prisma,
  ProjectStatus,
  ProjectTaskActivityType,
  ProjectTaskStatus,
  ProjectTimelineEventType,
  ProjectTimelineVisibility,
  WorkOrderAgentType,
  WorkOrderExecutionStatus,
  WorkOrderStatus,
} from '@prisma/client';

// ─── Thread Config Helper ─────────────────────────────────────────────────────

function threadConfig(
  projectId: string,
  runId: string,
): RunnableConfig & { configurable: { thread_id: string } } {
  return {
    configurable: {
      thread_id: `devflow:project-${projectId}:run-${runId}`,
    },
  };
}

// ─── Status Shape ─────────────────────────────────────────────────────────────

export interface OrchestrationStatus {
  status: string;
  currentNode: string;
  retryCount: number;
  error: string | null;
  /** Architecture contract from graph state, so Gate 1 review can show what is being approved. */
  contract?: ProjectContract | null;
}

// ─── Mid-run control (Phase 2) ──────────────────────────────────────────────

export type OrchestrationControlAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry_node'
  | 'skip_node'
  | 'modify_params';

export interface OrchestrationControlOptions {
  nodeId?: string;
  params?: Record<string, unknown>;
  actorId?: string;
}

export interface OrchestrationControlResult {
  accepted: boolean;
  action: OrchestrationControlAction;
  status: string;
}

export interface WorkOrderExecutionResult {
  executionRunId: string;
  artifactId: string;
}

interface WorkOrderExecutionOptions {
  emitLifecycleEvents?: boolean;
  parentRunId?: string;
  trigger?: OrchestrationRunTrigger;
  allowFailedRetry?: boolean;
}

interface SupervisorRecoveryOptions {
  reason: string;
  retryAttempt: number;
  maxRetries: number;
}

export interface SupervisorRecoveryResult {
  runId: string;
  readyWorkOrders: number;
  completedWorkOrders: number;
  failedWorkOrders: number;
  status: OrchestrationRunStatus;
  error: string | null;
}

export type OrchestrationProviderStatus = AgentProviderStatus & {
  githubDelivery: GithubDeliveryStatus;
};

const MOCK_NODE = {
  LOAD_READY_WORK_ORDERS: 'load_ready_work_orders',
  EXECUTE_READY_WORK_ORDERS: 'execute_ready_work_orders',
  FINALIZE: 'finalize_mock_orchestration',
} as const;
const SUPERVISOR_RECOVERY_NODE = 'supervisor_recovery';

/**
 * Maps a just-completed DevFlow graph node to the coarse project status carried
 * in `run.status` events. Drives the typed protocol channel without depending on
 * the scattered legacy emitStatusUpdate calls (kept for back-compat).
 */
const NODE_PROJECT_STATUS: Record<string, ProjectStatus> = {
  parse_requirements: ProjectStatus.NEGOTIATING_CONTRACT,
  negotiate_contract: ProjectStatus.AWAITING_GATE_1,
  gate_1_check: ProjectStatus.GENERATING_CODE,
  frontend_agent: ProjectStatus.GENERATING_CODE,
  backend_agent: ProjectStatus.GENERATING_CODE,
  database_agent: ProjectStatus.GENERATING_CODE,
  architecture_agent: ProjectStatus.GENERATING_CODE,
  validate_outputs: ProjectStatus.GENERATING_CODE,
  gate_2_check: ProjectStatus.COMMITTING,
  commit_to_github: ProjectStatus.COMMITTING,
  mark_delivered: ProjectStatus.DELIVERED,
  mark_failed: ProjectStatus.FAILED,
};

const MockWorkOrderState = Annotation.Root({
  projectId: Annotation<string>(),
  runId: Annotation<string>(),
  trigger: Annotation<OrchestrationRunTrigger>({
    default: () => OrchestrationRunTrigger.START,
    reducer: (_, next) => next,
  }),
  actorId: Annotation<string | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),
  readyWorkOrderIds: Annotation<string[]>({
    default: () => [],
    reducer: (_, next) => next,
  }),
  completedArtifactIds: Annotation<string[]>({
    default: () => [],
    reducer: (existing, next) => [...existing, ...next],
  }),
  failedWorkOrderIds: Annotation<string[]>({
    default: () => [],
    reducer: (existing, next) => [...existing, ...next],
  }),
  error: Annotation<string | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),
});

type MockWorkOrderStateType = typeof MockWorkOrderState.State;

type MockWorkOrderGraphBuilder = {
  addNode(
    name: string,
    action: (
      state: MockWorkOrderStateType,
    ) => Partial<MockWorkOrderStateType> | Promise<Partial<MockWorkOrderStateType>>,
  ): MockWorkOrderGraphBuilder;
  addEdge(start: string, end: string): MockWorkOrderGraphBuilder;
  compile(input: {
    checkpointer: PostgresSaver;
  }): CompiledStateGraph<
    MockWorkOrderStateType,
    Partial<MockWorkOrderStateType>,
    string
  >;
};

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class OrchestrationService implements OnModuleInit {
  private readonly logger = new Logger(OrchestrationService.name);

  private graph!: CompiledStateGraph<
    DevFlowStateType,
    Partial<DevFlowStateType>,
    string
  >;
  // Phase 3: simulation graph — same topology, deterministic event-rich nodes.
  private simulationGraph!: CompiledStateGraph<
    DevFlowStateType,
    Partial<DevFlowStateType>,
    string
  >;
  private mockWorkOrderGraph!: CompiledStateGraph<
    MockWorkOrderStateType,
    Partial<MockWorkOrderStateType>,
    string
  >;
  private checkpointer!: PostgresSaver;

  /**
   * In-flight runs keyed by runId, each with an AbortController. Created when a
   * run starts streaming; deleted when it settles. Phase 2 mid-run `cancel`
   * aborts the controller; Phase 1 only needs the lifecycle bookkeeping.
   */
  private readonly activeRuns = new Map<string, AbortController>();

  /**
   * Projects manually paused via the control API. In-memory by design: pause is
   * a short-lived interactive operation. While present, the supervisor skips
   * auto-recovery for the project (manual intervention takes precedence).
   */
  private readonly pausedRuns = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly requirementsParser: RequirementsParserNode,
    private readonly contractNegotiator: ContractNegotiatorNode,
    private readonly frontendAgent: FrontendAgentNode,
    private readonly backendAgent: BackendAgentNode,
    private readonly databaseAgent: DatabaseAgentNode,
    private readonly architectureAgent: ArchitectureAgentNode,
    private readonly selfCritique: SelfCritiqueNode,
    private readonly validator: ValidatorNode,
    private readonly githubCommit: GithubCommitNode,
    private readonly memory: MemoryService,
    private readonly artifactContractValidator: ArtifactContractValidator,
    private readonly outputValidation: OutputValidationService,
    private readonly agentProviderRegistry: AgentProviderRegistry,
    private readonly notifications: NotificationsService,
    private readonly github: GithubService,
    @Optional() @Inject(GraphLlmProvider)
    private readonly graphLlmProvider: GraphLlmProvider | null,
    // Optional: WebSocket gateway may not be present in all environments
    @Optional() private readonly gateway: DevFlowGateway | null,
    @Optional() private readonly emitter: OrchestrationEmitter | null,
  ) {}

  getProviderStatus(): OrchestrationProviderStatus {
    return {
      ...this.agentProviderRegistry.getStatus(),
      githubDelivery: this.github.getDeliveryStatus(),
    };
  }

  verifyGithubDeliveryAccess(): Promise<GithubDeliveryVerification> {
    return this.github.verifyDeliveryAccess();
  }

  verifyLlmProviderAccess(): Promise<GraphLlmProviderVerification> {
    if (!this.graphLlmProvider) {
      throw new Error('Graph LLM provider is not available in this runtime.');
    }

    return this.graphLlmProvider.verifyConnection();
  }

  async autoAnalyzeBrief(input: {
    companyName: string;
    brief: string;
    stackKey: string;
  }): Promise<{
    enhancedBrief: string;
    suggestedFeatures: string[];
    suggestedTechStack: { frontend: string; backend: string; database: string; styling: string };
    complexity: 'simple' | 'medium' | 'complex';
    estimatedFiles: number;
  }> {
    if (!this.graphLlmProvider) {
      throw new BadRequestException(
        'Auto-analyze requires an LLM provider, but the Graph LLM provider is not available in this runtime. Ensure the OrchestrationModule is properly configured.',
      );
    }

    if (!this.graphLlmProvider.isAvailable()) {
      const keyName =
        this.graphLlmProvider.providerName() === 'anthropic' ? 'ANTHROPIC_API_KEY' :
        this.graphLlmProvider.providerName() === 'opencode' ? 'OPENCODE_API_KEY' :
        this.graphLlmProvider.providerName() === 'gemini' ? 'GEMINI_API_KEY' :
        this.graphLlmProvider.providerName() === 'openai' ? 'OPENAI_API_KEY' :
        'OPENROUTER_API_KEY';
      throw new BadRequestException(
        `Auto-analyze requires an LLM API key. Set the ${keyName} environment variable, or configure the provider in Admin > Providers.`,
      );
    }

    // Fetch global memory context so the analyzer can learn from past brief
    // analyses — successful project patterns, common feature groupings, and
    // past mistakes to avoid — even before a project is created.
    const memoryQuery = [
      input.stackKey,
      input.brief.slice(0, 200),
      'brief analysis requirements',
    ].filter(Boolean).join(' ');

    const memoryContext = await this.memory.readRelevant('requirements', memoryQuery, 3).catch(() => []);

    const contextBlock = memoryContext.length > 0
      ? `\n\nContext from similar past analyses:\n${this.memory.formatAsContext(memoryContext)}`
      : '';

    const systemPrompt = `You are a product analyst helping a PM turn a rough idea into a structured project brief.
Return a valid JSON object with this exact shape:
{
  "enhancedBrief": string,
  "suggestedFeatures": string[],
  "suggestedTechStack": {
    "frontend": string,
    "backend": string,
    "database": string,
    "styling": string
  },
  "complexity": "simple" | "medium" | "complex",
  "estimatedFiles": number
}

Rules:
- enhancedBrief: Rewrite the rough idea as a clear, professional 2-4 sentence project brief. Preserve the user's intent but add clarity.
- suggestedFeatures: 4-8 concrete features as short noun phrases (e.g. "User authentication", "Dashboard analytics").
- suggestedTechStack: Infer from the stack key hint; use sensible defaults if not clear.
- complexity: "simple" for <4 features, "medium" for 4-7, "complex" for 8+.
- estimatedFiles: Rough file count based on features and complexity.
Respond ONLY with the JSON object — no markdown fences, no prose.${contextBlock}`;

    const userPrompt = `Analyze this project idea and produce a structured brief.

Company name: ${input.companyName}
Stack key: ${input.stackKey}
Rough idea: ${input.brief}`;

    const result = await this.graphLlmProvider.generateJson<Record<string, unknown>>({
      agentName: 'auto_analyze',
      systemPrompt,
      userPrompt,
      expectedShape: 'object',
    });

    const value = result.value;
    const suggestedFeatures = Array.isArray(value['suggestedFeatures'])
      ? (value['suggestedFeatures'] as unknown[]).filter(
          (f): f is string => typeof f === 'string' && f.trim().length > 0,
        )
      : [];

    const rawTechStack = value['suggestedTechStack'];
    const techStack =
      rawTechStack && typeof rawTechStack === 'object' && !Array.isArray(rawTechStack)
        ? (rawTechStack as Record<string, unknown>)
        : {};

    const rawComplexity = value['complexity'];
    const complexity =
      rawComplexity === 'simple' || rawComplexity === 'medium' || rawComplexity === 'complex'
        ? rawComplexity
        : 'medium';

    const estimatedFiles =
      typeof value['estimatedFiles'] === 'number' && (value['estimatedFiles'] as number) > 0
        ? Math.ceil(value['estimatedFiles'] as number)
        : Math.max(suggestedFeatures.length + 6, 8);

    return {
      enhancedBrief:
        typeof value['enhancedBrief'] === 'string' && value['enhancedBrief'].trim().length > 0
          ? value['enhancedBrief'] as string
          : input.brief,
      suggestedFeatures: suggestedFeatures.length > 0 ? suggestedFeatures : ['Core application workflow'],
      suggestedTechStack: {
        frontend: typeof techStack['frontend'] === 'string' ? techStack['frontend'] : 'Next.js',
        backend: typeof techStack['backend'] === 'string' ? techStack['backend'] : 'NestJS',
        database: typeof techStack['database'] === 'string' ? techStack['database'] : 'PostgreSQL',
        styling: typeof techStack['styling'] === 'string' ? techStack['styling'] : 'Tailwind CSS',
      },
      complexity,
      estimatedFiles,
    };
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing orchestration graph...');
    this.checkpointer = await createCheckpointer();
    this.graph = buildDevFlowGraph(
      this.requirementsParser,
      this.contractNegotiator,
      this.frontendAgent,
      this.backendAgent,
      this.databaseAgent,
      this.architectureAgent,
      this.selfCritique,
      this.validator,
      this.githubCommit,
      this.prisma,
      this.checkpointer,
      this.emitter,
    );
    this.simulationGraph = buildGraph(
      buildSimulationNodeImpls(this.emitter),
      this.prisma,
      this.checkpointer,
      this.emitter,
    );
    this.mockWorkOrderGraph = this.buildMockWorkOrderGraph();
    this.logger.log('Orchestration graph initialized and compiled');
  }

  /**
   * Drives the DevFlow graph via graph.stream() (Phase 1). Consumes streamed
   * node updates, emitting typed run.status events and persisting currentNode as
   * each node completes. NodeInterrupt (a gate pause) ends the stream without
   * throwing — the gate node has already set AWAITING_GATE_* and emitted its
   * lifecycle. Real errors surface as run.error + markRunFailed. An
   * AbortController is registered for the run's lifetime so Phase 2 `cancel` can
   * abort mid-stream.
   *
   * Fire-and-forget: callers do `void this.runGraph(...)` to keep returning the
   * runId immediately, matching the previous graph.invoke().catch() behavior.
   */
  private async runGraph(
    projectId: string,
    runId: string,
    config: RunnableConfig & { configurable: { thread_id: string } },
    input: Partial<DevFlowStateType> | null,
    graph: CompiledStateGraph<DevFlowStateType, Partial<DevFlowStateType>, string> = this.graph,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);

    try {
      const stream = await graph.stream(input as Partial<DevFlowStateType>, {
        ...config,
        streamMode: 'updates',
        signal: controller.signal,
      });

      for await (const update of stream) {
        if (!update || typeof update !== 'object') continue;
        for (const nodeName of Object.keys(update)) {
          const status = NODE_PROJECT_STATUS[nodeName] ?? ProjectStatus.GENERATING_CODE;
          this.emitter?.runStatus(projectId, runId, status, nodeName);
          await this.prisma.orchestrationRun
            .update({ where: { runId }, data: { currentNode: nodeName } })
            .catch(() => undefined);
        }
      }
    } catch (err) {
      if (err instanceof NodeInterrupt) {
        // Expected pause at a gate — not a failure.
        return;
      }
      if (controller.signal.aborted) {
        // Operator pause/cancel aborted the stream. The control handler already
        // set the appropriate run state + emitted events; the checkpoint is
        // intact so the run can resume. Not a failure.
        this.logger.log(`Graph run ${runId} aborted by operator (pause/cancel).`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Graph run ${runId} for project ${projectId} encountered an error: ${message}`,
      );
      this.emitter?.runError(projectId, runId, {
        code: 'NODE_FAILED',
        severity: 'permanent',
        message,
      });
      await this.markRunFailed(runId, 'graph', message);
    } finally {
      // Only clear if this controller is still the active one (a resume/retry
      // may have already registered a new controller for this runId).
      if (this.activeRuns.get(runId) === controller) {
        this.activeRuns.delete(runId);
      }
    }
  }

  /**
   * Starts a new graph run for a project.
   * Called by ProjectsService on POST /projects.
   * Returns the generated runId.
   */
  async startRun(
    projectId: string,
    brief: string,
    stackKey: string,
    companyName: string,
    actorId?: string,
    trigger: OrchestrationRunTrigger = OrchestrationRunTrigger.START,
  ): Promise<string> {
    const runId = createId();
    this.agentProviderRegistry.getActiveProviderOrThrow();

    this.logger.log(
      `Starting run ${runId} for project ${projectId} (${companyName})`,
    );

    await this.prisma.project.update({
      where: { id: projectId },
      data: { runId },
    });

    const readyWorkOrders = await this.prisma.workOrder.count({
      where: {
        projectId,
        status: WorkOrderStatus.READY,
        instructions: { not: null },
      },
    });

    await this.prisma.orchestrationRun.create({
      data: {
        projectId,
        runId,
        providerMode: this.agentProviderMode(),
        trigger,
        status: OrchestrationRunStatus.RUNNING,
        currentNode: this.agentProviderMode() === 'mock'
          ? MOCK_NODE.LOAD_READY_WORK_ORDERS
          : 'parse_requirements',
        actorId: actorId ?? null,
        readyWorkOrders,
      },
    });

    // Project-scoped budget counters are reset at run start until budgets become run-scoped.
    await this.prisma.runBudget.upsert({
      where: { projectId },
      update: {
        tokensConsumed: 0,
        retryCount: 0,
      },
      create: { projectId },
    }).catch(() => undefined);

    const config = threadConfig(projectId, runId);

    if (this.agentProviderMode() === 'mock') {
      const initialInput: Partial<MockWorkOrderStateType> = {
        projectId,
        runId,
        trigger,
        actorId: actorId ?? null,
      };

      this.mockWorkOrderGraph.invoke(initialInput, config).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Mock orchestration run ${runId} for project ${projectId} failed: ${message}`,
        );
        void this.markRunFailed(runId, MOCK_NODE.FINALIZE, message);
      });

      this.gateway?.emitStatusUpdate(
        projectId,
        ProjectStatus.GENERATING_CODE,
        MOCK_NODE.LOAD_READY_WORK_ORDERS,
      );

      return runId;
    }

    if (this.agentProviderMode() === 'simulation') {
      // Simulation runs the real-shaped graph with deterministic, event-rich
      // nodes. Gate approvals are pre-seeded so the run flows hands-free for UI
      // testing (no human gate steps, no LLM/GitHub access).
      const simulationInput: Partial<DevFlowStateType> = {
        projectId,
        runId,
        brief,
        stackKey,
        companyName,
        gate1Approved: true,
        gate2Approved: true,
      };
      void this.runGraph(projectId, runId, config, simulationInput, this.simulationGraph);
      this.gateway?.emitStatusUpdate(projectId, 'PARSING_REQUIREMENTS', 'parse_requirements');
      this.emitter?.runStatus(
        projectId,
        runId,
        ProjectStatus.PARSING_REQUIREMENTS,
        'parse_requirements',
      );
      return runId;
    }

    const initialInput: Partial<DevFlowStateType> = {
      projectId,
      runId,
      brief,
      stackKey,
      companyName,
    };

    // Drive the graph via the streaming run loop (Phase 1). Errors are handled
    // inside runGraph (run.error + markRunFailed); fire-and-forget here.
    void this.runGraph(projectId, runId, config, initialInput);

    // Notify subscribers that the graph has started and is parsing requirements.
    // Legacy event kept for back-compat; runGraph also emits typed run.status.
    this.gateway?.emitStatusUpdate(
      projectId,
      'PARSING_REQUIREMENTS',
      'parse_requirements',
    );
    this.emitter?.runStatus(
      projectId,
      runId,
      ProjectStatus.PARSING_REQUIREMENTS,
      'parse_requirements',
    );

    return runId;
  }

  /**
   * Called when the user approves or rejects Gate 1 (architecture review).
   *
   * Phase 2A memory write policy:
   *   REJECTED → write MISTAKE memory immediately
   *   APPROVED → no memory write yet (SKILL/PATTERN written only on Gate 2 approval)
   */
  async resumeGate1(
    projectId: string,
    approved: boolean,
    notes?: string,
  ): Promise<void> {
    this.logger.log(
      `Resuming gate 1 for project ${projectId}: approved=${approved}`,
    );

    const runId = await this.getRunId(projectId);
    const config = threadConfig(projectId, runId);
    const checkpoint = await this.checkpointer.get(config).catch(() => null);
    const state = checkpoint?.channel_values as Partial<DevFlowStateType> | undefined;

    if (!approved) {
      await Promise.all([
        this.prisma.gateEvent.create({
          data: { projectId, gateType: 'ARCHITECTURE_REVIEW', decision: 'REJECTED', notes: notes ?? null },
        }),
        this.prisma.project.update({
          where: { id: projectId },
          data: { status: 'FAILED' },
        }),
      ]);

      // Write mistake memory: contract that was rejected at Gate 1
      if (state?.contract) {
        await this.memory.writeMistake({
          agentType: 'contract',
          rejectedContent: JSON.stringify(state.contract, null, 2),
          rejectionNotes: notes ?? 'No reason provided',
          projectId,
          gateType: 'GATE_1',
          stackKey: state.stackKey ?? 'unknown',
          approvalSource: 'GATE_1',
        });
      }

      this.logger.log(`Gate 1 rejected for project ${projectId} — mistake recorded`);
      // Notify subscribers: gate rejection leads to FAILED state
      this.gateway?.emitStatusUpdate(projectId, 'FAILED', 'gate_rejected', 'Gate 1 rejected');
      return;
    }

    await this.prisma.gateEvent.create({
      data: {
        projectId,
        gateType: 'ARCHITECTURE_REVIEW',
        decision: 'APPROVED',
        notes: notes ?? null,
      },
    });

    if (state?.contract) {
      await this.memory.writeProjectCoreMemory({
        projectId,
        agentType: 'project_core',
        memoryType: 'PATTERN',
        sourceType: 'gate_1_approved_contract',
        approvalSource: 'GATE_1',
        importance: 1,
        content: [
          'APPROVED ARCHITECTURE CONTRACT',
          `STACK: ${state.stackKey ?? 'unknown'}`,
          `PROJECT: ${state.contract.projectName}`,
          `DESCRIPTION: ${state.contract.description}`,
          `FILES: ${state.contract.fileManifest.join(', ')}`,
          `ACCEPTANCE: ${state.contract.acceptanceCriteria.join('; ')}`,
          notes ? `GATE NOTES: ${notes}` : null,
        ].filter(Boolean).join('\n'),
        metadata: {
          stackKey: state.stackKey ?? 'unknown',
          gateType: 'ARCHITECTURE_REVIEW',
          projectType: state.contract.requirements.projectType,
          complexity: state.contract.requirements.complexity,
          fileCount: state.contract.fileManifest.length,
        },
      });
    }

    await this.graph.updateState(config, {
      gate1Approved: true,
      gate1Notes: notes ?? '',
    });

    // Notify subscribers that code generation has begun after Gate 1 approval
    this.gateway?.emitStatusUpdate(projectId, 'GENERATING_CODE', 'gate_1_check');
    this.emitter?.runStatus(projectId, runId, ProjectStatus.GENERATING_CODE, 'gate_1_check');

    void this.runGraph(projectId, runId, config, null);
  }

  /**
   * Called when the user approves or rejects Gate 2 (code review).
   *
   * Phase 2A memory write policy:
   *   REJECTED → write MISTAKE memories for each artifact that failed
   *   APPROVED → write SKILL memories for all artifacts + PATTERN for the contract
   */
  async resumeGate2(
    projectId: string,
    approved: boolean,
    notes?: string,
  ): Promise<void> {
    this.logger.log(
      `Resuming gate 2 for project ${projectId}: approved=${approved}`,
    );

    const runId = await this.getRunId(projectId);
    const config = threadConfig(projectId, runId);

    const checkpoint = await this.checkpointer.get(config).catch(() => null);
    const state = checkpoint?.channel_values as Partial<DevFlowStateType> | undefined;

    if (!approved) {
      await Promise.all([
        this.prisma.gateEvent.create({
          data: { projectId, gateType: 'CODE_REVIEW', decision: 'REJECTED', notes: notes ?? null },
        }),
        this.prisma.project.update({
          where: { id: projectId },
          data: { status: 'FAILED' },
        }),
      ]);

      // Write MISTAKE memory for each artifact that was rejected
      if (state?.artifacts?.length) {
        await Promise.allSettled(
          state.artifacts.map((artifact) =>
            this.memory.writeMistake({
              agentType: artifact.agentType,
              rejectedContent: `FILE: ${artifact.filePath}\n\n${artifact.content}`,
              rejectionNotes: notes ?? 'No reason provided',
            projectId,
            gateType: 'GATE_2',
            stackKey: state.stackKey ?? 'unknown',
            approvalSource: 'GATE_2',
          }),
        ),
      );
        this.logger.log(
          `Gate 2 rejected: ${state.artifacts.length} mistake memories written for project ${projectId}`,
        );
      }

      // Notify subscribers: gate rejection leads to FAILED state
      this.gateway?.emitStatusUpdate(projectId, 'FAILED', 'gate_rejected', 'Gate 2 rejected');
      return;
    }

    if (this.agentProviderMode() === 'llm') {
      const githubDelivery = this.github.getDeliveryStatus();
      if (!githubDelivery.available) {
        throw new Error(
          githubDelivery.reason ??
            'GitHub delivery is not configured for Gate 2 repository delivery.',
        );
      }
    }

    // Gate 2 APPROVED — write SKILL + PATTERN memories
    await this.prisma.gateEvent.create({
      data: {
        projectId,
        gateType: 'CODE_REVIEW',
        decision: 'APPROVED',
        notes: notes ?? null,
      },
    });

    if (state?.artifacts?.length && state?.contract) {
      const projectType = state.contract.requirements.projectType;
      const stackKey = state.stackKey ?? 'unknown';

      // SKILL: one memory per artifact
      await Promise.allSettled(
        state.artifacts.map((artifact) =>
          this.memory.writeSkill({
            agentType: artifact.agentType,
            systemPrompt: '',
            artifactContent: artifact.content,
            filePath: artifact.filePath,
            projectId,
            stackKey,
            projectType,
            approvalSource: 'GATE_2',
            sourceType: 'gate_2_approved_artifact',
          }),
        ),
      );

      // PATTERN: one memory for the successful contract
      await this.memory.writePattern({
        contract: state.contract,
        projectId,
        stackKey,
        approvalSource: 'GATE_2',
        sourceType: 'gate_2_approved_contract_pattern',
      });

      await this.memory.writeProjectCoreMemory({
        projectId,
        agentType: 'project_core',
        memoryType: 'PATTERN',
        sourceType: 'gate_2_approved_delivery',
        approvalSource: 'GATE_2',
        importance: 1,
        content: [
          'APPROVED DELIVERY MEMORY',
          `STACK: ${stackKey}`,
          `PROJECT TYPE: ${projectType}`,
          `ARTIFACTS: ${state.artifacts.map((artifact) => `${artifact.agentType}:${artifact.filePath}`).join(', ')}`,
          `ACCEPTANCE: ${state.contract.acceptanceCriteria.join('; ')}`,
          notes ? `GATE NOTES: ${notes}` : null,
        ].filter(Boolean).join('\n'),
        metadata: {
          stackKey,
          gateType: 'CODE_REVIEW',
          projectType,
          artifactCount: state.artifacts.length,
          artifactFiles: state.artifacts.map((artifact) => artifact.filePath),
        },
      });

      this.logger.log(
        `Gate 2 approved: ${state.artifacts.length} skill memories + 1 pattern + project core memory written for project ${projectId}`,
      );
    }

    await this.graph.updateState(config, {
      gate2Approved: true,
      gate2Notes: notes ?? '',
    });

    // Notify subscribers that commit phase has begun after Gate 2 approval
    this.gateway?.emitStatusUpdate(projectId, 'COMMITTING', 'gate_2_check');
    this.emitter?.runStatus(projectId, runId, ProjectStatus.COMMITTING, 'gate_2_check');

    void this.runGraph(projectId, runId, config, null);
  }

  /**
   * Returns a combined status from the latest checkpoint + DB project row.
   */
  async getStatus(projectId: string): Promise<OrchestrationStatus> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true, runId: true },
    });

    if (!project?.runId) {
      return {
        status: project?.status ?? 'UNKNOWN',
        currentNode: 'none',
        retryCount: 0,
        error: null,
      };
    }

    const config = threadConfig(projectId, project.runId);

    try {
      const checkpoint = await this.checkpointer.get(config);
      const channelValues = checkpoint?.channel_values as
        | Partial<DevFlowStateType>
        | undefined;

      const rawError = channelValues?.error ?? null;
      const publicError =
        rawError?.startsWith('RETRY:') ? null : rawError;

      return {
        status: project.status,
        currentNode: this.getCurrentNode(checkpoint),
        retryCount: channelValues?.retryCount ?? 0,
        error: publicError,
        contract: channelValues?.contract ?? null,
      };
    } catch {
      return {
        status: project.status,
        currentNode: 'unknown',
        retryCount: 0,
        error: null,
      };
    }
  }

  async executeWorkOrder(
    projectId: string,
    workOrderId: string,
    actorId?: string,
    options: WorkOrderExecutionOptions = {},
  ): Promise<WorkOrderExecutionResult> {
    const executionRunId = createId();
    const startedAt = new Date();
    const workOrder = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, projectId },
      include: {
        project: {
          select: {
            id: true,
            companyName: true,
            brief: true,
            stackKey: true,
          },
        },
        task: {
          select: {
            id: true,
            title: true,
            description: true,
            assignedToId: true,
            status: true,
          },
        },
        artifact: {
          select: {
            id: true,
            filePath: true,
            displayName: true,
            content: true,
          },
        },
      },
    });

    if (!workOrder) {
      throw new Error(`Work order ${workOrderId} not found`);
    }

    this.assertWorkOrderExecutable(workOrder, options);

    const provider = this.agentProviderRegistry.getActiveProviderOrThrow();
    const attempt = workOrder.executionAttempt + 1;
    const nodeName = this.workOrderNodeName(workOrder.agentType);
    const contractMetadata = this.workOrderContractMetadata(workOrder.agentType);
    const orchestrationRun = await this.findOrCreateWorkOrderRun(projectId, {
      runId: options.parentRunId ?? executionRunId,
      executionRunId,
      trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
      actorId,
      currentNode: nodeName,
    });

    await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: {
        status: WorkOrderStatus.DISPATCHED,
        dispatchedAt: workOrder.dispatchedAt ?? startedAt,
        executionRunId,
        executionAttempt: attempt,
        executionStartedAt: startedAt,
        executionCompletedAt: null,
        executionError: null,
        lastEventAt: startedAt,
      },
    });

    await this.prisma.workOrderExecution.create({
      data: {
        projectId,
        orchestrationRunId: orchestrationRun.id,
        workOrderId,
        executionRunId,
        attempt,
        agentType: workOrder.agentType,
        status: WorkOrderExecutionStatus.RUNNING,
        startedAt,
        metadata: {
          trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
          sourceArtifactId: workOrder.artifactId,
          providerMode: this.agentProviderMode(),
          requestedProviderMode: this.requestedAgentProviderMode(),
          contract: contractMetadata,
        },
      },
    });

    await this.updateRunProgress(orchestrationRun.id, {
      currentNode: nodeName,
      status: OrchestrationRunStatus.RUNNING,
    });

    if (options.emitLifecycleEvents) {
      await Promise.all([
        this.recordWorkOrderTimelineEvent(projectId, actorId, {
          type: ProjectTimelineEventType.WORK_ORDER_DISPATCHED,
          taskId: workOrder.taskId,
          artifactId: workOrder.artifactId,
          title: 'Work order dispatched',
          body: workOrder.title,
          metadata: {
            workOrderId,
            executionRunId,
            attempt,
            agentType: workOrder.agentType,
          },
        }),
        this.notifyWorkOrderLifecycle(projectId, actorId, workOrder, {
          type: NotificationType.WORK_ORDER_DISPATCHED,
          title: 'Work order dispatched',
          status: WorkOrderStatus.DISPATCHED,
          executionRunId,
        }),
      ]);
    }

    await this.prisma.eventLog.create({
      data: {
        projectId,
        nodeName,
        eventType: 'STARTED',
        costMeta: {
          workOrderId,
          executionRunId,
          attempt,
          agentType: workOrder.agentType,
          providerMode: this.agentProviderMode(),
          requestedProviderMode: this.requestedAgentProviderMode(),
          contract: contractMetadata,
        },
        runTokens: 0,
        occurredAt: startedAt,
      },
    });

    this.gateway?.emitStatusUpdate(projectId, 'GENERATING_CODE', nodeName);

    try {
      const completedAt = new Date();
      const agentContext = {
        project: workOrder.project,
        workOrder: {
          id: workOrder.id,
          title: workOrder.title,
          instructions: workOrder.instructions,
          agentType: workOrder.agentType,
          priority: workOrder.priority,
        },
        task: workOrder.task,
        sourceArtifact: workOrder.artifact,
        executionRunId,
      };
      const output = await provider.generateWorkOrderOutput(agentContext);
      const validation = this.outputValidation.validate(output, agentContext);

      if (!validation.valid) {
        throw new Error(`Output validation failed: ${validation.errors.map(e => e.message).join('; ')}`);
      }

      const artifact = await this.prisma.artifact.create({
        data: {
          projectId,
          agentType: workOrder.agentType.toLowerCase(),
          filePath: output.filePath,
          displayName: output.displayName,
          content: output.content,
          clientVisible: false,
          validationStatus: ArtifactValidationStatus.PASSED,
          validationSummary: validation.summary,
          validationErrors: validation.errors as unknown as Prisma.InputJsonValue,
        },
      });

      await this.prisma.workOrder.update({
        where: { id: workOrderId },
        data: {
          status: WorkOrderStatus.COMPLETED,
          artifactId: artifact.id,
          completedAt,
          failedAt: null,
          executionCompletedAt: completedAt,
          executionError: null,
          lastEventAt: completedAt,
        },
      });

      if (workOrder.taskId) {
        await this.prisma.projectTask.update({
          where: { id: workOrder.taskId },
          data: { status: ProjectTaskStatus.IN_REVIEW, artifactId: artifact.id },
        });

        await this.prisma.projectTaskActivity.create({
          data: {
            projectId,
            taskId: workOrder.taskId,
            actorId,
            type: ProjectTaskActivityType.ARTIFACT_CHANGED,
            message: 'Work order execution produced an artifact',
            metadata: {
              workOrderId,
              executionRunId,
              artifactId: artifact.id,
            },
          },
        });
      }

      await this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName,
          eventType: 'COMPLETED',
          costMeta: {
            workOrderId,
            executionRunId,
            attempt,
            artifactId: artifact.id,
            agentType: workOrder.agentType,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            contract: contractMetadata,
            output: {
              filePath: output.filePath,
              language: output.language,
              metadata: output.metadata ?? {},
            },
            validation: {
              summary: validation.summary,
              errors: validation.errors as unknown as Prisma.InputJsonValue,
            } satisfies Prisma.InputJsonValue,
          },
          runTokens: 0,
          occurredAt: completedAt,
        },
      });

      await Promise.all([
        this.prisma.workOrderExecution.update({
          where: { executionRunId },
          data: {
            status: WorkOrderExecutionStatus.SUCCEEDED,
            artifactId: artifact.id,
            completedAt,
            metadata: {
              trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
              sourceArtifactId: workOrder.artifactId,
              providerMode: this.agentProviderMode(),
              requestedProviderMode: this.requestedAgentProviderMode(),
              contract: contractMetadata,
              output: {
                filePath: output.filePath,
                language: output.language,
                metadata: output.metadata ?? {},
              },
              validation: {
                summary: validation.summary,
                errors: validation.errors as unknown as Prisma.InputJsonValue,
              } satisfies Prisma.InputJsonValue,
            },
          },
        }),
        this.incrementRunCompletion(orchestrationRun.id, {
          artifactId: artifact.id,
          currentNode: nodeName,
          completeRun: !options.parentRunId,
        }),
      ]);

      if (options.emitLifecycleEvents) {
        await Promise.all([
          this.recordWorkOrderTimelineEvent(projectId, actorId, {
            type: ProjectTimelineEventType.WORK_ORDER_STATUS_CHANGED,
            taskId: workOrder.taskId,
            artifactId: artifact.id,
            title: 'Work order execution completed',
            body: workOrder.title,
            metadata: {
              workOrderId,
              from: WorkOrderStatus.DISPATCHED,
              to: WorkOrderStatus.COMPLETED,
              executionRunId,
              artifactId: artifact.id,
            },
          }),
          this.notifyWorkOrderLifecycle(projectId, actorId, workOrder, {
            type: NotificationType.WORK_ORDER_STATUS_CHANGED,
            title: 'Work order completed',
            status: WorkOrderStatus.COMPLETED,
            executionRunId,
            artifactId: artifact.id,
          }),
        ]);
      }

      this.gateway?.emitStatusUpdate(projectId, 'AWAITING_GATE_2', nodeName);
      return { executionRunId, artifactId: artifact.id };
    } catch (error) {
      const failedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.workOrder.update({
        where: { id: workOrderId },
        data: {
          status: WorkOrderStatus.FAILED,
          failedAt,
          executionError: message,
          lastEventAt: failedAt,
        },
      });
      await this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName,
          eventType: 'FAILED',
          costMeta: {
            workOrderId,
            executionRunId,
            attempt,
            agentType: workOrder.agentType,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            contract: contractMetadata,
            error: message,
          },
          runTokens: 0,
          occurredAt: failedAt,
        },
      });
      await Promise.all([
        this.prisma.workOrderExecution.update({
          where: { executionRunId },
          data: {
            status: WorkOrderExecutionStatus.FAILED,
            error: message,
            completedAt: failedAt,
            metadata: {
              trigger: options.trigger ?? OrchestrationRunTrigger.WORK_ORDER_DISPATCH,
              sourceArtifactId: workOrder.artifactId,
              providerMode: this.agentProviderMode(),
              requestedProviderMode: this.requestedAgentProviderMode(),
              contract: contractMetadata,
              error: message,
            },
          },
        }),
        this.incrementRunFailure(orchestrationRun.id, {
          error: message,
          currentNode: nodeName,
          completeRun: !options.parentRunId,
        }),
      ]);
      this.gateway?.emitStatusUpdate(projectId, 'FAILED', nodeName, message);
      throw error;
    }
  }

  async recoverStaleProject(
    projectId: string,
    options: SupervisorRecoveryOptions,
  ): Promise<SupervisorRecoveryResult> {
    const runId = createId();
    const startedAt = new Date();
    const trigger = OrchestrationRunTrigger.RERUN_READY_WORK_ORDERS;
    const readyWorkOrders = await this.prisma.workOrder.findMany({
      where: {
        projectId,
        status: WorkOrderStatus.READY,
        instructions: { not: null },
      },
      select: { id: true, instructions: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    const readyWorkOrderIds = readyWorkOrders
      .filter((workOrder) => workOrder.instructions?.trim())
      .map((workOrder) => workOrder.id);

    await this.prisma.orchestrationRun.create({
      data: {
        projectId,
        runId,
        providerMode: this.agentProviderMode(),
        trigger,
        status: OrchestrationRunStatus.RUNNING,
        currentNode: SUPERVISOR_RECOVERY_NODE,
        actorId: null,
        readyWorkOrders: readyWorkOrderIds.length,
      },
    });

    await Promise.all([
      this.prisma.project.update({
        where: { id: projectId },
        data: { runId, status: ProjectStatus.GENERATING_CODE },
      }),
      this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName: SUPERVISOR_RECOVERY_NODE,
          eventType: 'STARTED',
          costMeta: {
            runId,
            trigger,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            readyWorkOrderIds,
          },
          runTokens: 0,
          occurredAt: startedAt,
        },
      }),
      this.prisma.projectTimelineEvent.create({
        data: {
          projectId,
          actorId: null,
          type: ProjectTimelineEventType.PROJECT_UPDATED,
          visibility: ProjectTimelineVisibility.TEAM,
          title: 'Supervisor recovery started',
          body: `${readyWorkOrderIds.length} ready work order${readyWorkOrderIds.length === 1 ? '' : 's'} queued for automatic recovery.`,
          metadata: {
            runId,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            readyWorkOrderIds,
          },
        },
      }),
    ]);

    this.gateway?.emitStatusUpdate(
      projectId,
      ProjectStatus.GENERATING_CODE,
      SUPERVISOR_RECOVERY_NODE,
    );

    const completedArtifactIds: string[] = [];
    const failedWorkOrderIds: string[] = [];
    let error: string | null = null;

    if (readyWorkOrderIds.length === 0) {
      error = 'Supervisor recovery found no READY work orders with instructions.';
    }

    for (const workOrderId of readyWorkOrderIds) {
      try {
        const result = await this.executeWorkOrder(
          projectId,
          workOrderId,
          undefined,
          {
            emitLifecycleEvents: true,
            parentRunId: runId,
            trigger,
          },
        );
        completedArtifactIds.push(result.artifactId);
      } catch (err) {
        failedWorkOrderIds.push(workOrderId);
        error = err instanceof Error ? err.message : String(err);
      }
    }

    const failed = Boolean(error) || failedWorkOrderIds.length > 0;
    const completedAt = new Date();
    const status = failed
      ? OrchestrationRunStatus.FAILED
      : OrchestrationRunStatus.SUCCEEDED;
    const projectStatus = failed
      ? ProjectStatus.FAILED
      : ProjectStatus.AWAITING_GATE_2;
    const body = failed
      ? error
      : `${completedArtifactIds.length} recovered artifact${completedArtifactIds.length === 1 ? '' : 's'} ready for PM output review.`;

    await Promise.all([
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: projectStatus },
      }),
      this.prisma.eventLog.create({
        data: {
          projectId,
          nodeName: SUPERVISOR_RECOVERY_NODE,
          eventType: failed ? 'FAILED' : 'COMPLETED',
          costMeta: {
            runId,
            trigger,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            providerMode: this.agentProviderMode(),
            requestedProviderMode: this.requestedAgentProviderMode(),
            readyWorkOrderIds,
            completedArtifactIds,
            failedWorkOrderIds,
            error,
          },
          runTokens: 0,
          occurredAt: completedAt,
        },
      }),
      this.prisma.projectTimelineEvent.create({
        data: {
          projectId,
          actorId: null,
          type: ProjectTimelineEventType.PROJECT_UPDATED,
          visibility: ProjectTimelineVisibility.TEAM,
          title: failed
            ? 'Supervisor recovery failed'
            : 'Supervisor recovery completed',
          body,
          metadata: {
            runId,
            reason: options.reason,
            retryAttempt: options.retryAttempt,
            maxRetries: options.maxRetries,
            readyWorkOrderIds,
            completedArtifactIds,
            failedWorkOrderIds,
            error,
          },
        },
      }),
      this.prisma.orchestrationRun.updateMany({
        where: { projectId, runId },
        data: {
          status,
          currentNode: SUPERVISOR_RECOVERY_NODE,
          error,
          completedWorkOrders: completedArtifactIds.length,
          failedWorkOrders: failedWorkOrderIds.length,
          completedArtifacts: completedArtifactIds.length,
          completedAt,
        },
      }),
    ]);

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(projectId),
      actorId: null,
      projectId,
      type: NotificationType.WORK_ORDER_STATUS_CHANGED,
      title: failed
        ? 'Supervisor recovery failed'
        : 'Supervisor recovery completed',
      body,
      metadata: {
        runId,
        reason: options.reason,
        retryAttempt: options.retryAttempt,
        maxRetries: options.maxRetries,
        completedArtifacts: completedArtifactIds.length,
        failedWorkOrders: failedWorkOrderIds.length,
      },
    });

    this.gateway?.emitStatusUpdate(
      projectId,
      projectStatus,
      SUPERVISOR_RECOVERY_NODE,
      error ?? undefined,
    );

    return {
      runId,
      readyWorkOrders: readyWorkOrderIds.length,
      completedWorkOrders: completedArtifactIds.length,
      failedWorkOrders: failedWorkOrderIds.length,
      status,
      error,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildMockWorkOrderGraph(): CompiledStateGraph<
    MockWorkOrderStateType,
    Partial<MockWorkOrderStateType>,
    string
  > {
    const graph = new StateGraph(
      MockWorkOrderState,
    ) as unknown as MockWorkOrderGraphBuilder;

    graph.addNode(MOCK_NODE.LOAD_READY_WORK_ORDERS, async (state) => {
      const readyWorkOrders = await this.prisma.workOrder.findMany({
        where: {
          projectId: state.projectId,
          status: WorkOrderStatus.READY,
        },
        select: { id: true, instructions: true },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      });

      const readyWorkOrderIds = readyWorkOrders
        .filter((workOrder) => workOrder.instructions?.trim())
        .map((workOrder) => workOrder.id);

      if (readyWorkOrderIds.length === 0) {
        return {
          error: 'No READY work orders with instructions are available for orchestration.',
        };
      }

      const startedAt = new Date();
      await Promise.all([
        this.prisma.project.update({
          where: { id: state.projectId },
          data: { status: ProjectStatus.GENERATING_CODE },
        }),
        this.prisma.eventLog.create({
          data: {
            projectId: state.projectId,
            nodeName: MOCK_NODE.LOAD_READY_WORK_ORDERS,
            eventType: 'STARTED',
            costMeta: {
              provider: this.agentProviderMode(),
              runId: state.runId,
              workOrderCount: readyWorkOrderIds.length,
            },
            runTokens: 0,
            occurredAt: startedAt,
          },
        }),
        this.prisma.projectTimelineEvent.create({
          data: {
            projectId: state.projectId,
            actorId: state.actorId,
            type: ProjectTimelineEventType.PROJECT_UPDATED,
            visibility: ProjectTimelineVisibility.TEAM,
            title: 'Orchestration started',
            body: `${readyWorkOrderIds.length} ready work order${readyWorkOrderIds.length === 1 ? '' : 's'} queued for mock agent execution.`,
            metadata: {
              provider: this.agentProviderMode(),
              runId: state.runId,
              readyWorkOrderIds,
            },
          },
        }),
      ]);

      return { readyWorkOrderIds };
    });

    graph.addNode(MOCK_NODE.EXECUTE_READY_WORK_ORDERS, async (state) => {
      if (state.error) return {};

      const completedArtifactIds: string[] = [];
      const failedWorkOrderIds: string[] = [];

      for (const workOrderId of state.readyWorkOrderIds) {
        try {
          const result = await this.executeWorkOrder(
            state.projectId,
            workOrderId,
            state.actorId ?? undefined,
            {
              emitLifecycleEvents: true,
              parentRunId: state.runId,
              trigger: state.trigger,
            },
          );
          completedArtifactIds.push(result.artifactId);
        } catch {
          failedWorkOrderIds.push(workOrderId);
        }
      }

      return {
        completedArtifactIds,
        failedWorkOrderIds,
        error:
          failedWorkOrderIds.length > 0
            ? `${failedWorkOrderIds.length} work order execution${failedWorkOrderIds.length === 1 ? '' : 's'} failed.`
            : null,
      };
    });

    graph.addNode(MOCK_NODE.FINALIZE, async (state) => {
      const failed = state.error || state.failedWorkOrderIds.length > 0;
      const completedAt = new Date();
      const status = failed
        ? ProjectStatus.FAILED
        : ProjectStatus.AWAITING_GATE_2;
      const title = failed
        ? 'Orchestration failed'
        : 'Orchestration outputs ready';
      const body = failed
        ? state.error
        : `${state.completedArtifactIds.length} artifact${state.completedArtifactIds.length === 1 ? '' : 's'} ready for PM output review.`;

      await Promise.all([
        this.prisma.project.update({
          where: { id: state.projectId },
          data: { status },
        }),
        this.prisma.eventLog.create({
          data: {
            projectId: state.projectId,
            nodeName: MOCK_NODE.FINALIZE,
            eventType: failed ? 'FAILED' : 'COMPLETED',
            costMeta: {
              provider: this.agentProviderMode(),
              runId: state.runId,
              completedArtifactIds: state.completedArtifactIds,
              failedWorkOrderIds: state.failedWorkOrderIds,
              error: state.error,
            },
            runTokens: 0,
            occurredAt: completedAt,
          },
        }),
        this.prisma.projectTimelineEvent.create({
          data: {
            projectId: state.projectId,
            actorId: state.actorId,
            type: ProjectTimelineEventType.PROJECT_UPDATED,
            visibility: ProjectTimelineVisibility.TEAM,
            title,
            body,
            metadata: {
              provider: this.agentProviderMode(),
              runId: state.runId,
              completedArtifactIds: state.completedArtifactIds,
              failedWorkOrderIds: state.failedWorkOrderIds,
            },
          },
        }),
        this.prisma.orchestrationRun.updateMany({
          where: { projectId: state.projectId, runId: state.runId },
          data: {
            status: failed ? OrchestrationRunStatus.FAILED : OrchestrationRunStatus.SUCCEEDED,
            currentNode: MOCK_NODE.FINALIZE,
            error: failed ? state.error : null,
            completedWorkOrders: state.completedArtifactIds.length,
            failedWorkOrders: state.failedWorkOrderIds.length,
            completedArtifacts: state.completedArtifactIds.length,
            completedAt,
          },
        }),
      ]);

      if (!failed) {
        await this.notifications.notify({
          recipientIds: await this.notifications.projectManagers(state.projectId),
          actorId: state.actorId,
          projectId: state.projectId,
          type: NotificationType.WORK_ORDER_STATUS_CHANGED,
          title: 'Orchestration outputs ready',
          body,
          metadata: {
            provider: this.agentProviderMode(),
            runId: state.runId,
            artifactCount: state.completedArtifactIds.length,
          },
        });
      }

      this.gateway?.emitStatusUpdate(
        state.projectId,
        status,
        MOCK_NODE.FINALIZE,
        state.error ?? undefined,
      );

      return {};
    });

    graph.addEdge(START, MOCK_NODE.LOAD_READY_WORK_ORDERS);
    graph.addEdge(MOCK_NODE.LOAD_READY_WORK_ORDERS, MOCK_NODE.EXECUTE_READY_WORK_ORDERS);
    graph.addEdge(MOCK_NODE.EXECUTE_READY_WORK_ORDERS, MOCK_NODE.FINALIZE);
    graph.addEdge(MOCK_NODE.FINALIZE, END);

    return graph.compile({ checkpointer: this.checkpointer });
  }

  private assertWorkOrderExecutable(
    workOrder: {
      id: string;
      status: WorkOrderStatus;
      instructions: string | null;
      executionRunId: string | null;
      executionStartedAt: Date | null;
    },
    options: WorkOrderExecutionOptions,
  ): void {
    const isReady = workOrder.status === WorkOrderStatus.READY;
    const isFreshManualDispatch =
      workOrder.status === WorkOrderStatus.DISPATCHED &&
      !workOrder.executionRunId &&
      !workOrder.executionStartedAt;
    const isAllowedFailedRetry =
      options.allowFailedRetry === true &&
      workOrder.status === WorkOrderStatus.FAILED;

    if (!isReady && !isFreshManualDispatch && !isAllowedFailedRetry) {
      throw new Error(
        `Work order ${workOrder.id} must be READY before agent execution`,
      );
    }

    if (!workOrder.instructions?.trim()) {
      throw new Error(
        `Work order ${workOrder.id} needs instructions before agent execution`,
      );
    }
  }

  private workOrderContractMetadata(
    agentType: WorkOrderAgentType,
  ): Prisma.InputJsonObject {
    const contract = agentArtifactContractFor(agentType);
    return {
      version: ORCHESTRATION_CONTRACT_VERSION,
      agentType,
      agentSlug: contract.slug,
      nodeName: contract.nodeName,
      requiredExtensions: contract.requiredExtensions,
      requiredSignals: contract.requiredSignals,
      handoffChecklist: contract.handoffChecklist,
    };
  }

  private agentProviderMode(): AgentProviderMode {
    return this.agentProviderRegistry.activeMode();
  }

  private requestedAgentProviderMode(): AgentProviderMode {
    return this.agentProviderRegistry.requestedMode();
  }

  // ─── Mid-run control (Phase 2) ────────────────────────────────────────────

  /**
   * Whether a project is currently paused (or otherwise manually halted) via the
   * control API. The supervisor calls this to give manual intervention
   * precedence over automatic stuck-run recovery.
   */
  isManuallyHalted(projectId: string): boolean {
    return this.pausedRuns.has(projectId);
  }

  /**
   * Mid-run control entry point. Routes a control action to its handler. Built
   * on the same primitives as gate resume — graph.updateState() + re-stream via
   * runGraph(), plus the per-run AbortController for pause/cancel.
   */
  async control(
    projectId: string,
    action: OrchestrationControlAction,
    options: OrchestrationControlOptions = {},
  ): Promise<OrchestrationControlResult> {
    const runId = await this.getRunId(projectId);
    const config = threadConfig(projectId, runId);
    this.logger.log(`Control '${action}' for project ${projectId} (run ${runId})`);

    switch (action) {
      case 'cancel':
        return this.cancelRun(projectId, runId, options.actorId);
      case 'pause':
        return this.pauseRun(projectId, runId);
      case 'resume':
        return this.resumeRun(projectId, runId, config);
      case 'retry_node':
        return this.retryNode(projectId, runId, config, options.nodeId);
      case 'skip_node':
        return this.skipNode(projectId, runId, config, options.nodeId);
      case 'modify_params':
        return this.modifyParams(projectId, runId, config, options.params);
      default:
        throw new BadRequestException(`Unknown control action: ${String(action)}`);
    }
  }

  private async cancelRun(
    projectId: string,
    runId: string,
    actorId?: string,
  ): Promise<OrchestrationControlResult> {
    this.activeRuns.get(runId)?.abort();
    this.activeRuns.delete(runId);
    this.pausedRuns.delete(projectId);

    const now = new Date();
    const reason = `Cancelled${actorId ? ` by ${actorId}` : ''}`;
    await Promise.allSettled([
      this.prisma.orchestrationRun.updateMany({
        where: { runId, status: OrchestrationRunStatus.RUNNING },
        data: { status: OrchestrationRunStatus.CANCELLED, error: reason, completedAt: now },
      }),
      // ProjectStatus has no CANCELLED — FAILED is the terminal state that
      // excludes the project from supervisor auto-recovery.
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.FAILED },
      }),
      this.prisma.workOrder.updateMany({
        where: { projectId, status: WorkOrderStatus.DISPATCHED },
        data: { status: WorkOrderStatus.CANCELLED, executionCompletedAt: now, lastEventAt: now },
      }),
    ]);

    this.emitter?.runStatus(projectId, runId, 'CANCELLED', 'cancelled');
    this.emitter?.runError(projectId, runId, {
      code: 'CANCELLED',
      severity: 'permanent',
      message: reason,
    });

    return { accepted: true, action: 'cancel', status: 'CANCELLED' };
  }

  private async pauseRun(
    projectId: string,
    runId: string,
  ): Promise<OrchestrationControlResult> {
    this.pausedRuns.add(projectId);
    // Abort the in-flight stream. The LangGraph checkpoint is written after each
    // node, so only in-flight node(s) are lost; resume re-streams from the
    // checkpoint. runGraph treats the abort as non-fatal.
    this.activeRuns.get(runId)?.abort();
    this.activeRuns.delete(runId);

    this.emitter?.runStatus(projectId, runId, 'PAUSED', 'paused');
    return { accepted: true, action: 'pause', status: 'PAUSED' };
  }

  private async resumeRun(
    projectId: string,
    runId: string,
    config: RunnableConfig & { configurable: { thread_id: string } },
  ): Promise<OrchestrationControlResult> {
    const run = await this.prisma.orchestrationRun.findUnique({
      where: { runId },
      select: { status: true },
    });
    if (run?.status === OrchestrationRunStatus.CANCELLED) {
      throw new BadRequestException('Run was cancelled and cannot be resumed');
    }

    this.pausedRuns.delete(projectId);
    this.emitter?.runStatus(projectId, runId, ProjectStatus.GENERATING_CODE, 'resumed');
    void this.runGraph(projectId, runId, config, null);
    return { accepted: true, action: 'resume', status: 'RUNNING' };
  }

  private async retryNode(
    projectId: string,
    runId: string,
    config: RunnableConfig & { configurable: { thread_id: string } },
    nodeId?: string,
  ): Promise<OrchestrationControlResult> {
    // Clear the error and reset the retry counter so the graph re-enters the
    // failed step from the last checkpoint. Precise per-node re-routing lands in
    // Phase 3 with the node-factory refactor (asNode targeting).
    await this.graph.updateState(config, { error: null, retryCount: 0 });
    await this.prisma.orchestrationRun.updateMany({
      where: { runId },
      data: { status: OrchestrationRunStatus.RUNNING, error: null, completedAt: null },
    });

    this.pausedRuns.delete(projectId);
    this.emitter?.runStatus(
      projectId,
      runId,
      ProjectStatus.GENERATING_CODE,
      nodeId ?? 'retry',
    );
    void this.runGraph(projectId, runId, config, null);
    return { accepted: true, action: 'retry_node', status: 'RUNNING' };
  }

  private async skipNode(
    projectId: string,
    runId: string,
    config: RunnableConfig & { configurable: { thread_id: string } },
    nodeId?: string,
  ): Promise<OrchestrationControlResult> {
    if (!nodeId) {
      throw new BadRequestException('skip_node requires a nodeId');
    }
    // Write state "as" the node with no changes so the graph routes past it via
    // that node's outgoing edges (LangGraph updateState asNode form).
    await this.graph.updateState(config, { error: null }, nodeId);

    this.pausedRuns.delete(projectId);
    this.emitter?.nodeLifecycle(projectId, runId, nodeId, 'skipped');
    this.emitter?.runStatus(projectId, runId, ProjectStatus.GENERATING_CODE, nodeId);
    void this.runGraph(projectId, runId, config, null);
    return { accepted: true, action: 'skip_node', status: 'RUNNING' };
  }

  private async modifyParams(
    projectId: string,
    runId: string,
    config: RunnableConfig & { configurable: { thread_id: string } },
    params?: Record<string, unknown>,
  ): Promise<OrchestrationControlResult> {
    if (!params || typeof params !== 'object') {
      throw new BadRequestException('modify_params requires a params object');
    }

    // Whitelist graph-state fields that are safe to patch mid-run.
    const patch: Partial<DevFlowStateType> = {};
    if (typeof params.retryCount === 'number') patch.retryCount = params.retryCount;
    if (typeof params.brief === 'string') patch.brief = params.brief;
    if (typeof params.gate1Notes === 'string') patch.gate1Notes = params.gate1Notes;
    if (typeof params.gate2Notes === 'string') patch.gate2Notes = params.gate2Notes;

    // Budget knobs live on RunBudget, not graph state.
    const budgetPatch: { tokenBudget?: number; maxRetries?: number } = {};
    if (typeof params.tokenBudget === 'number') budgetPatch.tokenBudget = params.tokenBudget;
    if (typeof params.maxRetries === 'number') budgetPatch.maxRetries = params.maxRetries;

    if (Object.keys(patch).length === 0 && Object.keys(budgetPatch).length === 0) {
      throw new BadRequestException(
        'No modifiable parameters provided (allowed: retryCount, brief, gate1Notes, gate2Notes, tokenBudget, maxRetries)',
      );
    }

    await Promise.allSettled([
      Object.keys(patch).length > 0
        ? this.graph.updateState(config, patch)
        : Promise.resolve(),
      Object.keys(budgetPatch).length > 0
        ? this.prisma.runBudget.update({ where: { projectId }, data: budgetPatch })
        : Promise.resolve(),
    ]);

    this.emitter?.runStatus(projectId, runId, 'PARAMS_UPDATED', 'modify_params');
    return { accepted: true, action: 'modify_params', status: 'RUNNING' };
  }

  private async getRunId(projectId: string): Promise<string> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { runId: true },
    });
    if (!project?.runId) {
      throw new Error(
        `Project ${projectId} has no runId — cannot resume graph`,
      );
    }
    return project.runId;
  }

  private async findOrCreateWorkOrderRun(
    projectId: string,
    input: {
      runId: string;
      executionRunId: string;
      trigger: OrchestrationRunTrigger;
      actorId?: string;
      currentNode: string;
    },
  ): Promise<{ id: string }> {
    const existing = await this.prisma.orchestrationRun.findUnique({
      where: { runId: input.runId },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.orchestrationRun.update({
        where: { id: existing.id },
        data: {
          currentNode: input.currentNode,
          status: OrchestrationRunStatus.RUNNING,
        },
      });
      return existing;
    }

    return this.prisma.orchestrationRun.create({
      data: {
        projectId,
        runId: input.runId,
        providerMode: this.agentProviderMode(),
        trigger: input.trigger,
        status: OrchestrationRunStatus.RUNNING,
        currentNode: input.currentNode,
        actorId: input.actorId ?? null,
        readyWorkOrders: 1,
      },
      select: { id: true },
    });
  }

  private async updateRunProgress(
    id: string,
    data: Prisma.OrchestrationRunUpdateInput,
  ): Promise<void> {
    await this.prisma.orchestrationRun.update({
      where: { id },
      data,
    });
  }

  private async incrementRunCompletion(
    id: string,
    input: { artifactId: string; currentNode: string; completeRun: boolean },
  ): Promise<void> {
    await this.prisma.orchestrationRun.update({
      where: { id },
      data: {
        currentNode: input.currentNode,
        completedWorkOrders: { increment: 1 },
        completedArtifacts: { increment: 1 },
        status: input.completeRun ? OrchestrationRunStatus.SUCCEEDED : undefined,
        completedAt: input.completeRun ? new Date() : undefined,
      },
    });
  }

  private async incrementRunFailure(
    id: string,
    input: { error: string; currentNode: string; completeRun: boolean },
  ): Promise<void> {
    await this.prisma.orchestrationRun.update({
      where: { id },
      data: {
        currentNode: input.currentNode,
        failedWorkOrders: { increment: 1 },
        error: input.error,
        status: input.completeRun ? OrchestrationRunStatus.FAILED : undefined,
        completedAt: input.completeRun ? new Date() : undefined,
      },
    });
  }

  private async markRunFailed(
    runId: string,
    currentNode: string,
    error: string,
  ): Promise<void> {
    await this.prisma.orchestrationRun.updateMany({
      where: { runId },
      data: {
        status: OrchestrationRunStatus.FAILED,
        currentNode,
        error,
        completedAt: new Date(),
      },
    });
  }

  private getCurrentNode(checkpoint: unknown): string {
    if (!checkpoint || typeof checkpoint !== 'object') return 'none';
    const cp = checkpoint as Record<string, unknown>;
    const metadata = cp['metadata'] as Record<string, unknown> | undefined;
    if (metadata?.['source'] === 'loop') {
      const writes = metadata?.['writes'] as Record<string, unknown> | null;
      if (writes && Object.keys(writes).length > 0) {
        return Object.keys(writes)[0] ?? 'none';
      }
    }
    const next = cp['next'] as string[] | undefined;
    return next?.[0] ?? 'none';
  }

  private workOrderNodeName(agentType: WorkOrderAgentType): string {
    return `work_order_${agentType.toLowerCase()}`;
  }

  private async recordWorkOrderTimelineEvent(
    projectId: string,
    actorId: string | undefined,
    input: {
      type: ProjectTimelineEventType;
      title: string;
      body?: string | null;
      taskId?: string | null;
      artifactId?: string | null;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await this.prisma.projectTimelineEvent.create({
      data: {
        projectId,
        actorId: actorId ?? null,
        taskId: input.taskId ?? null,
        artifactId: input.artifactId ?? null,
        type: input.type,
        visibility: ProjectTimelineVisibility.TEAM,
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? {},
      },
    });
  }

  private async notifyWorkOrderLifecycle(
    projectId: string,
    actorId: string | undefined,
    workOrder: {
      id: string;
      title: string;
      agentType: WorkOrderAgentType;
      taskId: string | null;
      task: { assignedToId: string | null } | null;
    },
    input: {
      type: NotificationType;
      title: string;
      status: WorkOrderStatus;
      executionRunId: string;
      artifactId?: string;
    },
  ): Promise<void> {
    await this.notifications.notify({
      recipientIds: [
        ...(await this.notifications.projectManagers(projectId)),
        ...(workOrder.task?.assignedToId ? [workOrder.task.assignedToId] : []),
      ],
      actorId: actorId ?? null,
      projectId,
      taskId: workOrder.taskId,
      artifactId: input.artifactId ?? null,
      type: input.type,
      title: input.title,
      body: workOrder.title,
      metadata: {
        workOrderId: workOrder.id,
        status: input.status,
        agentType: workOrder.agentType,
        executionRunId: input.executionRunId,
      },
    });
  }
}
