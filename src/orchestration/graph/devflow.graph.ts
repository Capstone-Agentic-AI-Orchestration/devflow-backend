import { Logger } from '@nestjs/common';
import {
  StateGraph,
  END,
  START,
  NodeInterrupt,
  CompiledStateGraph,
} from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { DevFlowState, DevFlowStateType } from './devflow.state';
import { RequirementsParserNode } from '../nodes/requirements-parser.node';
import { ContractNegotiatorNode } from '../nodes/contract-negotiator.node';
import { FrontendAgentNode } from '../nodes/frontend-agent.node';
import { BackendAgentNode } from '../nodes/backend-agent.node';
import { DatabaseAgentNode } from '../nodes/database-agent.node';
import { ArchitectureAgentNode } from '../nodes/architecture-agent.node';
import { ValidatorNode } from '../nodes/validator.node';
import { GithubCommitNode } from '../nodes/github-commit.node';
import { SelfCritiqueNode } from '../nodes/self-critique.node';
import { PrismaService } from '../../prisma/prisma.service';
import { OrchestrationEmitter } from '../streaming/orchestration-emitter.service';
import { NODE, gate1Router, validatorRouter, gate2Router } from './topology';

export { NODE } from './topology';

type CompiledDevFlowGraph = CompiledStateGraph<
  DevFlowStateType,
  Partial<DevFlowStateType>,
  string
>;

/** A swappable processing-node implementation (real LLM agents or simulation). */
export type NodeImpl = (
  state: DevFlowStateType,
) => Partial<DevFlowStateType> | Promise<Partial<DevFlowStateType>>;

/**
 * The processing nodes whose behavior varies by run mode. Gate checks and
 * mark_delivered are infrastructure (built identically for every mode) and are
 * NOT part of this map.
 */
export interface DevFlowNodeImpls {
  [NODE.PARSE_REQUIREMENTS]: NodeImpl;
  [NODE.NEGOTIATE_CONTRACT]: NodeImpl;
  [NODE.FRONTEND_AGENT]: NodeImpl;
  [NODE.BACKEND_AGENT]: NodeImpl;
  [NODE.DATABASE_AGENT]: NodeImpl;
  [NODE.ARCHITECTURE_AGENT]: NodeImpl;
  [NODE.SELF_CRITIQUE]: NodeImpl;
  [NODE.VALIDATE_OUTPUTS]: NodeImpl;
  [NODE.COMMIT_TO_GITHUB]: NodeImpl;
}

// ─── Generic builder ────────────────────────────────────────────────────────────

/**
 * Builds and compiles the DevFlow graph from a declarative topology and a set of
 * processing-node implementations. The same topology + builder serve the live
 * (LLM) graph and the simulation graph — only the impls differ.
 */
export function buildGraph(
  impls: DevFlowNodeImpls,
  prisma: PrismaService,
  checkpointer: PostgresSaver,
  emitter?: OrchestrationEmitter | null,
): CompiledDevFlowGraph {
  const logger = new Logger('DevFlowGraph');

  const graph = new StateGraph(DevFlowState) as any;

  // ── Per-node instrumentation ──────────────────────────────────────────────
  //
  // Wraps every node to emit precise lifecycle (entering/exiting/error) and
  // wall-time telemetry on the typed protocol channel. NodeInterrupt (gate
  // pauses) is re-thrown without being reported as an error — it is an expected
  // control-flow signal.
  const instrument =
    (nodeId: string, action: (state: any) => any) =>
    async (state: any): Promise<any> => {
      const { projectId, runId } = state ?? {};
      emitter?.nodeLifecycle(projectId, runId ?? '', nodeId, 'entering');
      const startedAt = Date.now();
      try {
        const result = await action(state);
        emitter?.nodeTelemetry(projectId, nodeId, {
          runId: runId ?? undefined,
          wallMs: Date.now() - startedAt,
        });
        const phase = result && result.error ? 'error' : 'exiting';
        emitter?.nodeLifecycle(projectId, runId ?? '', nodeId, phase);
        return result;
      } catch (error) {
        if (error instanceof NodeInterrupt) {
          emitter?.nodeLifecycle(projectId, runId ?? '', nodeId, 'exiting');
          throw error;
        }
        emitter?.nodeLifecycle(projectId, runId ?? '', nodeId, 'error');
        throw error;
      }
    };

  const addProcessingNode = (name: keyof DevFlowNodeImpls): void => {
    graph.addNode(name, instrument(name, (state: any) => impls[name](state)));
  };

  // ── Processing nodes (swappable) ──────────────────────────────────────────

  addProcessingNode(NODE.PARSE_REQUIREMENTS);
  addProcessingNode(NODE.NEGOTIATE_CONTRACT);
  addProcessingNode(NODE.FRONTEND_AGENT);
  addProcessingNode(NODE.BACKEND_AGENT);
  addProcessingNode(NODE.DATABASE_AGENT);
  addProcessingNode(NODE.ARCHITECTURE_AGENT);
  addProcessingNode(NODE.SELF_CRITIQUE);
  addProcessingNode(NODE.VALIDATE_OUTPUTS);
  addProcessingNode(NODE.COMMIT_TO_GITHUB);

  // ── Infrastructure nodes (identical across modes) ─────────────────────────

  graph.addNode(NODE.GATE_1_CHECK, instrument(NODE.GATE_1_CHECK, async (state: any) => {
    if (state.error) {
      logger.error(`[${state.projectId}] Error before gate 1: ${state.error}`);
      return {};
    }
    if (!state.gate1Approved) {
      logger.log(`[${state.projectId}] Interrupting at gate 1`);
      await prisma.project.update({
        where: { id: state.projectId },
        data: { status: 'AWAITING_GATE_1' },
      });
      throw new NodeInterrupt({ type: 'GATE_1_REQUIRED', projectId: state.projectId });
    }
    logger.log(`[${state.projectId}] Gate 1 approved, continuing`);
    await prisma.project.update({
      where: { id: state.projectId },
      data: { status: 'GENERATING_CODE' },
    });
    return {};
  }));

  graph.addNode(NODE.GATE_2_CHECK, instrument(NODE.GATE_2_CHECK, async (state: any) => {
    if (!state.gate2Approved) {
      logger.log(`[${state.projectId}] Interrupting at gate 2`);
      await prisma.project.update({
        where: { id: state.projectId },
        data: { status: 'AWAITING_GATE_2' },
      });
      throw new NodeInterrupt({ type: 'GATE_2_REQUIRED', projectId: state.projectId });
    }
    logger.log(`[${state.projectId}] Gate 2 approved, committing`);
    return {};
  }));

  graph.addNode(NODE.MARK_DELIVERED, instrument(NODE.MARK_DELIVERED, async (state: any) => {
    logger.log(`[${state.projectId}] Marking project as delivered`);
    await prisma.project.update({
      where: { id: state.projectId },
      data: { status: 'DELIVERED' },
    });
    return {};
  }));

  // Terminal failure: a hard error (pre-codegen failure or validation that
  // exhausted its retries) records FAILED immediately instead of leaving the
  // project in GENERATING_CODE until the supervisor's stale-detection escalates
  // it. Emits a structured run.error so the failure surfaces live, not minutes
  // later. Mirrors mark_delivered (authoritative status write) on the sad path.
  graph.addNode(NODE.MARK_FAILED, instrument(NODE.MARK_FAILED, async (state: any) => {
    const reason: string = state.error ?? 'Run failed';
    logger.warn(`[${state.projectId}] Marking project as failed: ${reason}`);
    await prisma.project.update({
      where: { id: state.projectId },
      data: { status: 'FAILED' },
    });
    emitter?.runError(state.projectId, state.runId ?? '', {
      code: /validation/i.test(reason) ? 'VALIDATION_FAILED' : 'NODE_FAILED',
      severity: 'permanent',
      message: reason,
    });
    return {};
  }));

  // ── Edge wiring (declarative routers from topology.ts) ────────────────────

  graph.addEdge(START, NODE.PARSE_REQUIREMENTS);
  graph.addEdge(NODE.PARSE_REQUIREMENTS, NODE.NEGOTIATE_CONTRACT);
  graph.addEdge(NODE.NEGOTIATE_CONTRACT, NODE.GATE_1_CHECK);

  // Gate 1 → parallel fan-out to every code agent (Send), joined at
  // validate_outputs via the artifacts append reducer.
  graph.addConditionalEdges(NODE.GATE_1_CHECK, gate1Router);

  // Code agents fan-in to self_critique (which accumulates all artifacts via reducer)
  graph.addEdge(NODE.FRONTEND_AGENT, NODE.SELF_CRITIQUE);
  graph.addEdge(NODE.BACKEND_AGENT, NODE.SELF_CRITIQUE);
  graph.addEdge(NODE.DATABASE_AGENT, NODE.SELF_CRITIQUE);
  graph.addEdge(NODE.ARCHITECTURE_AGENT, NODE.SELF_CRITIQUE);

  // Self-critique → validate_outputs
  graph.addEdge(NODE.SELF_CRITIQUE, NODE.VALIDATE_OUTPUTS);

  // Validation → parallel retry fan-out to failing agents (retryPlan) or Gate 2.
  graph.addConditionalEdges(NODE.VALIDATE_OUTPUTS, validatorRouter);

  // Gate 2 → END (terminal error) or commit.
  graph.addConditionalEdges(NODE.GATE_2_CHECK, gate2Router);

  graph.addEdge(NODE.COMMIT_TO_GITHUB, NODE.MARK_DELIVERED);
  graph.addEdge(NODE.MARK_DELIVERED, END);

  // Terminal failure node (target of gate1/gate2 error routing) → END.
  graph.addEdge(NODE.MARK_FAILED, END);

  return graph.compile({ checkpointer }) as CompiledDevFlowGraph;
}

// ─── Live (LLM) graph ───────────────────────────────────────────────────────────

/**
 * Builds the live DevFlow graph backed by the real agent node implementations.
 * Thin wrapper over {@link buildGraph} that maps the injected node instances to
 * the implementation map.
 */
export function buildDevFlowGraph(
  requirementsParser: RequirementsParserNode,
  contractNegotiator: ContractNegotiatorNode,
  frontendAgent: FrontendAgentNode,
  backendAgent: BackendAgentNode,
  databaseAgent: DatabaseAgentNode,
  architectureAgent: ArchitectureAgentNode,
  selfCritique: SelfCritiqueNode,
  validator: ValidatorNode,
  githubCommit: GithubCommitNode,
  prisma: PrismaService,
  checkpointer: PostgresSaver,
  emitter?: OrchestrationEmitter | null,
): CompiledDevFlowGraph {
  const impls: DevFlowNodeImpls = {
    [NODE.PARSE_REQUIREMENTS]: (state) => requirementsParser.execute(state),
    [NODE.NEGOTIATE_CONTRACT]: (state) => contractNegotiator.execute(state),
    [NODE.FRONTEND_AGENT]: (state) => frontendAgent.execute(state),
    [NODE.BACKEND_AGENT]: (state) => backendAgent.execute(state),
    [NODE.DATABASE_AGENT]: (state) => databaseAgent.execute(state),
    [NODE.ARCHITECTURE_AGENT]: (state) => architectureAgent.execute(state),
    [NODE.SELF_CRITIQUE]: (state) => selfCritique.execute(state),
    [NODE.VALIDATE_OUTPUTS]: (state) => validator.execute(state),
    [NODE.COMMIT_TO_GITHUB]: (state) => githubCommit.execute(state),
  };

  return buildGraph(impls, prisma, checkpointer, emitter);
}
