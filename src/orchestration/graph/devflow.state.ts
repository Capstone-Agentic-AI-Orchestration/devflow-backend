import { Annotation } from '@langchain/langgraph';

// ─── Domain Types ─────────────────────────────────────────────────────────────

export interface TechStack {
  frontend: string;
  backend: string;
  database: string;
  styling: string;
}

export interface RequirementsDocument {
  projectType: string;
  features: string[];
  techStack: TechStack;
  complexity: 'simple' | 'medium' | 'complex';
  estimatedFiles: number;
}

export interface ProjectContract {
  projectId: string;
  projectName: string;
  description: string;
  requirements: RequirementsDocument;
  fileManifest: string[];
  acceptanceCriteria: string[];
  lockedAt: string;
}

export type ArtifactSource = 'llm' | 'scaffold' | 'skip' | 'mock';

/**
 * A single agent's retry instruction emitted by the validator: which code agent
 * to re-run and the validation feedback scoped to that agent's own failures.
 */
export interface RetryDirective {
  agentType: 'frontend' | 'backend' | 'database' | 'architecture';
  feedback: string;
}

export interface GeneratedArtifact {
  agentType: 'frontend' | 'backend' | 'database' | 'architecture';
  filePath: string;
  content: string;
  language: string;
  source?: ArtifactSource;
}

export function mergeArtifactsByPath(
  existing: GeneratedArtifact[],
  next: GeneratedArtifact[],
): GeneratedArtifact[] {
  const order: string[] = [];
  const artifactsByPath = new Map<string, GeneratedArtifact>();

  for (const artifact of [...existing, ...next]) {
    if (!artifactsByPath.has(artifact.filePath)) {
      order.push(artifact.filePath);
    }
    artifactsByPath.set(artifact.filePath, artifact);
  }

  return order
    .map((filePath) => artifactsByPath.get(filePath))
    .filter((artifact): artifact is GeneratedArtifact => Boolean(artifact));
}

// ─── LangGraph State Annotation ───────────────────────────────────────────────

export const DevFlowState = Annotation.Root({
  projectId: Annotation<string>(),
  runId: Annotation<string>(),
  brief: Annotation<string>(),
  stackKey: Annotation<string>(),
  companyName: Annotation<string>(),

  requirements: Annotation<RequirementsDocument | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),

  contract: Annotation<ProjectContract | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),

  artifacts: Annotation<GeneratedArtifact[]>({
    default: () => [],
    reducer: mergeArtifactsByPath,
  }),

  gate1Approved: Annotation<boolean>({
    default: () => false,
    reducer: (_, next) => next,
  }),

  gate2Approved: Annotation<boolean>({
    default: () => false,
    reducer: (_, next) => next,
  }),

  gate1Notes: Annotation<string>({
    default: () => '',
    reducer: (_, next) => next,
  }),

  gate2Notes: Annotation<string>({
    default: () => '',
    reducer: (_, next) => next,
  }),

  retryCount: Annotation<number>({
    default: () => 0,
    reducer: (_, next) => next,
  }),

  repoUrl: Annotation<string | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),

  /**
   * Top-level complexity derived from the parsed requirements.
   * Set by RequirementsParserNode after parsing. Drives the Phase 2D
   * conditional fan-out: 'complex' → parallel code generation via Send(),
   * 'simple' | 'medium' → sequential execution.
   */
  complexity: Annotation<'simple' | 'medium' | 'complex' | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),

  error: Annotation<string | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),

  validationFeedback: Annotation<string | null>({
    default: () => null,
    reducer: (_, next) => next,
  }),

  /**
   * Agents the validator wants to re-run, each with feedback scoped to its own
   * failures. A non-empty plan drives a parallel retry fan-out from
   * validate_outputs; an empty plan means validation either passed or exhausted
   * its retry budget.
   */
  retryPlan: Annotation<RetryDirective[]>({
    default: () => [],
    reducer: (_, next) => next,
  }),

  /**
   * Cross-agent contract summary extracted from backend/database artifacts.
   * Injected into frontend/architecture agents so they know exactly what the
   * backend exposes (routes, DTOs, Prisma models).
   */
  contractSummary: Annotation<string>({
    default: () => '',
    reducer: (_, next) => next,
  }),

  /**
   * Self-critique feedback from the review node. Contains quality issues
   * found by having the LLM review its own output against the contract
   * before formal validation runs.
   */
  selfCritique: Annotation<string>({
    default: () => '',
    reducer: (_, next) => next,
  }),
});

export type DevFlowStateType = typeof DevFlowState.State;
