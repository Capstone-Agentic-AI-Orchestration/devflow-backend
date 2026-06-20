import { Injectable, Logger } from '@nestjs/common';
import { DevFlowStateType, RetryDirective } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';
import { OutputValidationService } from '../output-validation/output-validation.service';
import type { ValidationError } from '../output-validation/schemas/schema.types';

type AgentType = 'frontend' | 'backend' | 'database' | 'architecture';

interface ValidationResult {
  valid: boolean;
  missingFiles: string[];
  syntaxIssues: string[];
  typeIssues: string[];
  schemaIssues: string[];
  contractIssues: string[];
  /** Cross-artifact integration violations (frontend↔backend↔database). */
  integrationIssues: string[];
  /** Every failing issue grouped under the agent responsible for fixing it. */
  agentIssues: Map<AgentType, string[]>;
}

@Injectable()
export class ValidatorNode {
  private readonly logger = new Logger(ValidatorNode.name);
  private static readonly MAX_RETRIES = 3;

  constructor(
    private readonly memory: MemoryService,
    private readonly streamEmitter: StreamEmitter,
    private readonly outputValidation: OutputValidationService,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    const { projectId, runId } = state;
    this.logger.log(
      `[${projectId}] Validating outputs (attempt ${state.retryCount + 1}/${ValidatorNode.MAX_RETRIES})`,
    );

    if (!state.contract) {
      this.streamEmitter.emit(projectId, 'validator', runId ?? '', 'error', 'Validator skipped: contract is missing');
      return { error: 'ValidatorNode: contract is null' };
    }

    try {
      if (process.env.MOCK_MODE === 'true') {
        this.streamEmitter.emit(projectId, 'validator', runId ?? '', 'decision', 'Mock mode: returning pass validation');
      }
      const result = this.validate(state);

      if (result.valid) {
        this.logger.log(`[${state.projectId}] Validation passed`);
        this.streamEmitter.emit(projectId, 'validator', runId ?? '', 'decision', 'Validation passed: all artifacts meet contract requirements');
        return {};
      }

      this.logger.warn(
        `[${state.projectId}] Validation failed: missing=${result.missingFiles.length}, syntax=${result.syntaxIssues.length}, type=${result.typeIssues.length}, schema=${result.schemaIssues.length}, integration=${result.integrationIssues.length}, contract=${result.contractIssues.length}`,
      );

      this.streamEmitter.emit(projectId, 'validator', runId ?? '', 'decision', `Validation failed: ${result.missingFiles.length} missing files, ${result.syntaxIssues.length} syntax issues, ${result.typeIssues.length} type issues, ${result.schemaIssues.length} schema issues, ${result.integrationIssues.length} integration issues, ${result.contractIssues.length} contract issues`);

      const validationIssueText = [
        ...result.missingFiles.map((f) => `MISSING FILE: ${f}`),
        ...result.syntaxIssues.map((s) => `SYNTAX: ${s}`),
        ...result.typeIssues.map((s) => `TYPE: ${s}`),
        ...result.schemaIssues.map((s) => `SCHEMA: ${s}`),
        ...result.integrationIssues.map((s) => `INTEGRATION: ${s}`),
        ...result.contractIssues.map((s) => `CONTRACT: ${s}`),
      ].join('\n');

      // Each failing agent gets feedback scoped to its own issues; this also
      // drives which agents are re-run and which mistakes are remembered.
      const retryPlan = this.buildRetryPlan(result, validationIssueText);
      const impliedAgents = retryPlan.map((d) => d.agentType);

      const stackKey = state.stackKey ?? 'unknown';
      await Promise.allSettled(
        retryPlan.map((directive) =>
          this.memory.writeMistake({
            agentType: directive.agentType,
            rejectedContent: directive.feedback,
            rejectionNotes: `Validator rejected ${directive.agentType} output at retry ${state.retryCount}: ${directive.feedback.slice(0, 300)}`,
            projectId: state.projectId,
            gateType: 'GATE_2',
            stackKey,
            sourceType: 'validator_failure',
            approvalSource: 'VALIDATOR',
          }),
        ),
      );

      if (state.retryCount < ValidatorNode.MAX_RETRIES - 1) {
        const nextRetry = state.retryCount + 1;
        this.logger.log(
          `[${state.projectId}] Scheduling retry ${nextRetry} for agents: ${impliedAgents.join(', ') || 'frontend'}`,
        );
        return {
          retryCount: nextRetry,
          retryPlan,
          error: null,
        };
      }

      this.logger.warn(
        `[${state.projectId}] Max retries reached, proceeding with partial validation`,
      );
      return {
        error: `Validation exceeded max retries. Issues: ${[
          ...result.missingFiles.map((f) => `missing:${f}`),
          ...result.syntaxIssues,
          ...result.typeIssues,
          ...result.schemaIssues,
          ...result.integrationIssues,
          ...result.contractIssues,
        ].join('; ')}`,
        retryPlan: [],
        retryCount: state.retryCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Validator failed: ${message}`);
      this.streamEmitter.emit(projectId, 'validator', runId ?? '', 'error', `Validation failed: ${humanReadableError(message)}`);
      return { error: `ValidatorNode failed: ${message}` };
    }
  }

  private validate(state: DevFlowStateType): ValidationResult {
    if (process.env.MOCK_MODE === 'true') {
      return {
        valid: true,
        missingFiles: [],
        syntaxIssues: [],
        typeIssues: [],
        schemaIssues: [],
        contractIssues: [],
        integrationIssues: [],
        agentIssues: new Map(),
      };
    }

    const contract = state.contract!;
    const generatedPaths = new Set(state.artifacts.map((a) => a.filePath));

    const missingFiles = contract.fileManifest.filter(
      (f) => !generatedPaths.has(f),
    );

    // Run real syntax + type-aware checks via OutputValidationService
    const validationErrors = this.outputValidation.validateBatch(state.artifacts, state.projectId);
    const syntaxIssues = validationErrors
      .filter((e) => e.code === 'TS_SYNTAX' || e.code === 'SQL_SYNTAX' || e.code === 'MD_SYNTAX')
      .map((e) => e.message);
    const typeIssues = validationErrors
      .filter((e) => e.code === 'TS_TYPE')
      .map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`);
    const schemaIssues = validationErrors
      .filter((e) => e.code === 'SCHEMA_VIOLATION' || e.code === 'BASE')
      .map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`);
    const integrationIssues = validationErrors
      .filter((e) => e.code === 'CONTRACT')
      .map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`);

    const contractIssues: string[] = [];
    if (contract.acceptanceCriteria.length > 0) {
      contractIssues.push(...this.checkAcceptanceCriteria(state));
    }

    const valid =
      missingFiles.length === 0 &&
      syntaxIssues.length === 0 &&
      typeIssues.length === 0 &&
      schemaIssues.length === 0 &&
      integrationIssues.length === 0 &&
      contractIssues.length === 0;

    const agentIssues = valid
      ? new Map<AgentType, string[]>()
      : this.groupIssuesByAgent(validationErrors, missingFiles, contractIssues);

    return { valid, missingFiles, syntaxIssues, typeIssues, schemaIssues, contractIssues, integrationIssues, agentIssues };
  }

  /**
   * Builds one retry directive per failing agent, each carrying feedback scoped
   * to that agent's own issues, so a parallel fan-out re-runs exactly the agents
   * that failed. Falls back to a single frontend directive carrying the full
   * issue text if nothing could be attributed (defensive — should not occur once
   * validation has failed).
   */
  private buildRetryPlan(
    result: ValidationResult,
    fallbackFeedback: string,
  ): RetryDirective[] {
    const plan: RetryDirective[] = [];
    for (const [agentType, issues] of result.agentIssues) {
      plan.push({ agentType, feedback: issues.join('\n') });
    }
    if (plan.length === 0) {
      plan.push({ agentType: 'frontend', feedback: fallbackFeedback });
    }
    return plan;
  }

  /**
   * Groups every validation issue under the agent responsible for fixing it so
   * each retried agent receives feedback about only its own failures:
   *  - content errors (syntax/type/schema/base) use the agentType stamped on the
   *    error during batch validation (falling back to the file path);
   *  - missing files are attributed by file extension;
   *  - contract issues are attributed from their "<agent>: ..." prefix.
   */
  private groupIssuesByAgent(
    validationErrors: ValidationError[],
    missingFiles: string[],
    contractIssues: string[],
  ): Map<AgentType, string[]> {
    const grouped = new Map<AgentType, string[]>();
    const add = (agent: AgentType, text: string): void => {
      const list = grouped.get(agent);
      if (list) list.push(text);
      else grouped.set(agent, [text]);
    };

    for (const error of validationErrors) {
      const agent = error.agentType ?? this.agentForFile(error.path ?? '');
      add(agent, `${this.labelFor(error.code)}: ${error.path ? `${error.path}: ` : ''}${error.message}`);
    }

    for (const file of missingFiles) {
      add(this.agentForFile(file), `MISSING FILE: ${file}`);
    }

    for (const issue of contractIssues) {
      add(this.agentFromContractIssue(issue), `CONTRACT: ${issue}`);
    }

    return grouped;
  }

  private labelFor(code: ValidationError['code']): string {
    if (code === 'TS_TYPE') return 'TYPE';
    if (code === 'TS_SYNTAX' || code === 'SQL_SYNTAX' || code === 'MD_SYNTAX') return 'SYNTAX';
    if (code === 'CONTRACT') return 'INTEGRATION';
    return 'SCHEMA';
  }

  /** Best-effort agent attribution from a file path's extension/suffix. */
  private agentForFile(filePath: string): AgentType {
    if (/\.(tsx|jsx|css)$/.test(filePath)) return 'frontend';
    if (/\.(module|controller|service|guard|pipe|interceptor|dto)\.ts$/.test(filePath)) return 'backend';
    if (/\.(prisma|sql)$/.test(filePath)) return 'database';
    if (/\.md$/.test(filePath)) return 'architecture';
    return 'backend';
  }

  /** Contract issues are emitted prefixed with "<agent>: ..."; parse the agent. */
  private agentFromContractIssue(issue: string): AgentType {
    const prefix = issue.split(':', 1)[0]?.trim().toLowerCase();
    if (
      prefix === 'frontend' ||
      prefix === 'backend' ||
      prefix === 'database' ||
      prefix === 'architecture'
    ) {
      return prefix;
    }
    return 'frontend';
  }

  private checkAcceptanceCriteria(state: DevFlowStateType): string[] {
    const issues: string[] = [];
    const contract = state.contract!;

    for (const criterion of contract.acceptanceCriteria) {
      const lower = criterion.toLowerCase();

      if (lower.includes('frontend') || lower.includes('ui') || lower.includes('component')) {
        const hasFrontend = state.artifacts.some(
          (a) => a.agentType === 'frontend' && a.content.trim().length > 50,
        );
        if (!hasFrontend) {
          issues.push(`frontend: acceptance criterion "${criterion}" — no meaningful frontend artifacts`);
        }
      }

      if (lower.includes('api') || lower.includes('endpoint') || lower.includes('backend')) {
        const hasBackend = state.artifacts.some(
          (a) => a.agentType === 'backend' && a.content.trim().length > 50,
        );
        if (!hasBackend) {
          issues.push(`backend: acceptance criterion "${criterion}" — no meaningful backend artifacts`);
        }
      }

      if (lower.includes('database') || lower.includes('schema') || lower.includes('model')) {
        const hasDatabase = state.artifacts.some(
          (a) => a.agentType === 'database' && a.content.trim().length > 50,
        );
        if (!hasDatabase) {
          issues.push(`database: acceptance criterion "${criterion}" — no meaningful database artifacts`);
        }
      }

      if (lower.includes('documentation') || lower.includes('readme') || lower.includes('architecture')) {
        const hasDocs = state.artifacts.some(
          (a) => a.filePath.endsWith('.md') && a.content.trim().length > 50,
        );
        if (!hasDocs) {
          issues.push(`architecture: acceptance criterion "${criterion}" — no meaningful documentation artifacts`);
        }
      }
    }

    return issues;
  }
}
