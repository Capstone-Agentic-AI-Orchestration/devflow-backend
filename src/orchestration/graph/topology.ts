import { Send } from '@langchain/langgraph';
import type { DevFlowStateType } from './devflow.state';

/**
 * Declarative DevFlow graph topology (Phase 3).
 *
 * Node names, the set of parallel code agents, and the routing decisions live
 * here as data + pure functions so the graph builder is mechanical and the
 * routers are unit-testable in isolation. Adding a code agent is a matter of
 * extending {@link CODE_AGENTS} (+ providing an implementation) — the fan-out
 * and validator retry routing pick it up automatically.
 */

export const NODE = {
  PARSE_REQUIREMENTS: 'parse_requirements',
  NEGOTIATE_CONTRACT: 'negotiate_contract',
  GATE_1_CHECK: 'gate_1_check',
  FRONTEND_AGENT: 'frontend_agent',
  BACKEND_AGENT: 'backend_agent',
  DATABASE_AGENT: 'database_agent',
  ARCHITECTURE_AGENT: 'architecture_agent',
  SELF_CRITIQUE: 'self_critique',
  VALIDATE_OUTPUTS: 'validate_outputs',
  GATE_2_CHECK: 'gate_2_check',
  COMMIT_TO_GITHUB: 'commit_to_github',
  MARK_DELIVERED: 'mark_delivered',
  MARK_FAILED: 'mark_failed',
} as const;

export type NodeName = (typeof NODE)[keyof typeof NODE];

/**
 * Code-gen agents dispatched in parallel after Gate 1 and joined at
 * validate_outputs via the artifacts append reducer. The single source of truth
 * for both the Gate 1 fan-out and the validator retry map.
 */
export const CODE_AGENTS = [
  NODE.FRONTEND_AGENT,
  NODE.BACKEND_AGENT,
  NODE.DATABASE_AGENT,
  NODE.ARCHITECTURE_AGENT,
] as const;

export type CodeAgentNode = (typeof CODE_AGENTS)[number];

/** Maps a retry directive's agent type to the agent node to re-run. */
export const RETRY_HINT_TO_NODE: Record<string, NodeName> = {
  frontend: NODE.FRONTEND_AGENT,
  backend: NODE.BACKEND_AGENT,
  database: NODE.DATABASE_AGENT,
  architecture: NODE.ARCHITECTURE_AGENT,
};

// ─── Pure routers (unit-tested directly) ───────────────────────────────────────

/**
 * After Gate 1: a pre-codegen error routes to the terminal failure node (which
 * records FAILED state); otherwise fan out in parallel to every code agent.
 */
export function gate1Router(state: DevFlowStateType): NodeName | Send[] {
  if (state.error) return NODE.MARK_FAILED;
  return CODE_AGENTS.map((node) => new Send(node, state));
}

/**
 * After validation: a non-empty retry plan fans out in parallel to every agent
 * that needs to re-run, each receiving the validation feedback scoped to its own
 * failures (unknown agent types restart at frontend). An empty plan proceeds to
 * Gate 2.
 */
export function validatorRouter(state: DevFlowStateType): NodeName | Send[] {
  const plan = state.retryPlan ?? [];
  if (plan.length > 0) {
    return plan.map(
      (directive) =>
        new Send(RETRY_HINT_TO_NODE[directive.agentType] ?? NODE.FRONTEND_AGENT, {
          ...state,
          validationFeedback: directive.feedback,
        }),
    );
  }
  return NODE.GATE_2_CHECK;
}

/**
 * After Gate 2: any error is terminal and routes to the failure node, otherwise
 * commit. Retries are signalled via {@link DevFlowStateType.retryPlan} and never
 * reach Gate 2, so an error present here is always a hard failure.
 */
export function gate2Router(state: DevFlowStateType): NodeName {
  return state.error != null ? NODE.MARK_FAILED : NODE.COMMIT_TO_GITHUB;
}

// ─── Per-node provider selection (Phase 3b extension point) ─────────────────────

export interface NodeProviderSelector {
  provider?: string;
  model?: string;
}

/**
 * Resolves an optional per-node provider/model override. Configure via the
 * `NODE_PROVIDER_OVERRIDES` env var (JSON map keyed by node name), e.g.
 *   NODE_PROVIDER_OVERRIDES={"backend_agent":{"model":"claude-opus-4-8"},"self_critique":{"model":"gpt-4.1"}}
 *
 * Returns null when no override applies — callers fall back to the global
 * provider/model. This is the mechanism; nodes opt in by consulting it when
 * they build their LLM request. Default behavior is unchanged.
 *
 * Recommended per-node overrides for quality:
 *  - negotiate_contract: use a stronger model (drives all downstream output)
 *  - self_critique: use a strong model for thorough review
 *  - architecture_agent: use a strong model for better docs
 *  - code agents (frontend/backend/database): flash models are fine for speed
 */
export function resolveNodeProvider(nodeName: string): NodeProviderSelector | null {
  const raw = process.env.NODE_PROVIDER_OVERRIDES;
  if (!raw) return null;
  try {
    const map = JSON.parse(raw) as Record<string, NodeProviderSelector>;
    const selector = map[nodeName];
    return selector && typeof selector === 'object' ? selector : null;
  } catch {
    return null;
  }
}
