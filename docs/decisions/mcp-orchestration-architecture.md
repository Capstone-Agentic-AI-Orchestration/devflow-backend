# ADR-002: Project-Type-Aware MCP Architecture for the Agent Orchestrator

Status: Proposed (awaiting sign-off)
Date: 2026-06-13

## Context

DevFlow is an AI orchestrator: 8 LLM agent nodes (requirements-parser,
contract-negotiator, frontend, backend, database, architecture, validator,
github-commit) collaboratively build a complete website/app from a customer
brief and deliver it to GitHub. Today the agents emit JSON file artifacts via
direct LLM HTTP calls — they generate code "blind," with no grounding, and the
validator does only regex checks.

We want agents to use MCP (Model Context Protocol) tools. The defining
constraint: customers ask for **arbitrary project types** (e-commerce, SaaS
dashboard, marketing site, mobile app, data/AI app, internal tools). Different
projects need different tools. A fixed tool list cannot serve this.

## Decision

Adopt a **two-tier, project-type-aware MCP capability system**: a fixed
**universal grounding layer** that every code agent always gets, plus a
**dynamic capability layer** selected per project from a **curated catalog**,
keyed off the classification the requirements-parser already produces.

### The two tiers (this is the core idea)

**Tier 1 — Universal grounding tools** (every project, every code-gen agent).
These fix the current hallucination/drift weaknesses and are project-type
independent:

| Tool (MCP server) | Fixes | Agents | Build/Reuse |
|---|---|---|---|
| Repo + artifact reader | Cross-agent blindness (backend can't see frontend's output or the schema) | all code agents | Reuse official filesystem server, workspace-scoped |
| Compiler/validator-in-loop (`tsc --noEmit`, `eslint`, `prisma validate`) | Validator is regex-only today | validator + retry loop | Custom, sandboxed |
| Package/version resolver (npm/PyPI) | Agents invent dependency versions | backend, frontend, database | Reuse/thin custom |
| Library-docs lookup (Context7-style) | Agents guess framework APIs for `stackKey` | all code agents | Reuse Context7 |
| DB schema introspection | DB-agent queries don't match real columns | database, backend | Custom over PrismaService |

**Tier 2 — Capability tools** (selected per project type). Examples:

| Archetype (`projectType`) | Capabilities resolved | Example MCP servers |
|---|---|---|
| e-commerce | payments, product-schema, inventory, auth, email | Stripe, schema-gen, auth, email |
| SaaS dashboard | auth, charts, analytics, db-schema | auth, charting-docs, analytics |
| marketing site | cms, seo, image/asset-gen | CMS, SEO, image-gen |
| data / AI app | warehouse, vector-db, etl | warehouse, vector-db, pipeline |
| mobile app | rn/expo tooling, push, store-config | expo, push, build |

The split is the answer to "MCPs for different kinds of projects": a stable
grounding floor + a swappable capability set.

### Flow (where it plugs into the existing graph)

```
Customer brief
  -> requirements-parser  (EXISTING: classifies projectType, stackKey, complexity)
       -> + capabilities[]   (NEW: extend the parser output schema)
  -> Capability Resolver  (NEW: archetype manifest maps projectType -> capability set)
  -> MCP Catalog          (NEW: curated registry maps capability -> vetted MCP servers + tools)
  -> Tool Provisioner     (NEW: spin up sandboxed, workspace-scoped MCP servers for THIS run)
  -> per-agent allowlist  (NEW: intersection(agent-role tools, project capability tools))
  -> agent .execute()     (EXISTING node, NEW tool-calling loop via provider layer)
       Gate 1 / Gate 2    (UNCHANGED human interrupts)
  -> github-commit        (UNCHANGED direct REST delivery)
```

### Key decisions

1. **Curated catalog, NOT open/marketplace discovery.** Customer deliverables
   must be secure, reproducible, cost-bounded, and gate-reviewable. Arbitrary
   third-party MCP servers are an RCE/exfiltration and non-determinism risk.
   Catalog servers are vetted and version-pinned. An `experimental` tier may sit
   behind a flag later, never on the default customer path.

2. **Per-run provisioning, hybrid lifecycle.** Universal grounding servers are
   pooled/warm (always needed). Capability servers are spun up on-demand per run
   and torn down at run end (don't run a Stripe MCP for a marketing site). All
   share the run's isolated workspace volume.

3. **Tool-loop lives in the provider layer.** Add `generateWithTools()` beside the
   existing `generateJson()` on `GraphLlmProvider` (the JSON path stays unchanged).
   It translates MCP tool defs to each provider's function-calling schema, runs an
   execute->observe->continue loop sending the **full message history** each
   iteration, and parses the final output with the node's Zod schema. The allowlist
   is enforced **server-side** — each node gets an `McpClient` bound to only its
   permitted tools; a prompt cannot widen it.
   - **Provider translation differs**: OpenAI/OpenRouter use `role:"tool"` result
     messages; Anthropic returns `tool_use` blocks and takes results as
     `role:"user"` `tool_result` content; Gemini uses `functionCall`/`functionResponse`
     parts. A `supportsToolCalling` flag per provider/model gates this.
   - **Fallback**: when `supportsToolCalling:false` (all free-tier models, OpenCode),
     fall back to `generateJson()` with tool descriptions injected as an
     `<available_capabilities>` block — the model knows tools exist but can't call
     them. Keeps the graph running; logs a degradation warning.

4. **Budget + gates + mock respected.**
   - **Iterations scale with complexity**: 4 (simple) / 6 (medium) / 8 (complex).
   - **Budget**: increment `RunBudget.tokensConsumed` from the **actual** usage field
     **after every sub-call** (not at node completion — the only crash-safe pattern);
     hard-stop at the per-complexity cap and mark `BUDGET_EXCEEDED`. Add a separate
     `toolCallRetryCount` (cap 3) so tool failures don't conflate with node retries.
   - **Gate boundary (critical safety rule)**: tool calls happen **entirely within a
     node**; gate interrupts happen **between nodes**. They never overlap. On
     crash/resume a node re-runs from scratch, which is safe because grounding tools
     are **idempotent** — EXCEPT `apply_migration`, which is non-idempotent and must
     **never** run inside a tool loop. DB migrations stay in `github-commit` after
     Gate 2, under human control, as today.
   - **Mock**: `AGENT_PROVIDER=mock` returns deterministic per-tool stubs (e.g.
     `run-tsc` -> `{errors:[]}`), still runs the Zod parse to catch schema drift, and
     writes nothing to budget so test assertions stay clean.

5. **Tool outputs feed back into pgvector memory.** A successful scaffold output is
   written as a `SKILL`; a recurring compiler fix is written as a `MISTAKE` — via the
   existing `writeSkill`/`writeMistake` services, so the next agent run gets it
   injected automatically. Do NOT write raw Context7 docs to memory (large, externally
   versioned, pollutes the store) — only synthesized, project-derived knowledge.

### Security (non-negotiable, owner: CISO)

**P0 — fix before any tool gets a secret: LangGraph checkpoints serialize graph
state to the DB in plaintext.** The brief is attacker-controlled, state is
brief-derived, the checkpoint is state-derived — so any secret placed in state is
permanently exposed in the `checkpoints` table. Break that chain: secrets must
**never** enter graph state. (Note: this is the same `PostgresSaver` checkpointer
flagged in ADR/earlier audit — its data sensitivity is now load-bearing.)

The five controls, in priority order:
1. **Orchestrator-enforced allowlist (P0)** — two separate actors: the *agent*
   decides what to call, the *orchestrator* decides whether it's permitted. The
   agent's decision is never final. Enforced server-side, not via prompt.
2. **gVisor + `--network none` for the compiler sandbox (P0)** — `tsc`/`eslint`
   need zero network; a user-space kernel + no network namespace closes the two
   real escape paths (kernel exploit, npm postinstall exfiltration).
3. **Secrets injected at MCP container spawn, never in state (P0)** — e.g. a
   customer's Stripe test key goes into the MCP server's env at spawn, never into
   a prompt or the checkpoint.
4. **Pre-commit artifact scanner (P1)** — `trufflehog` + custom rules for env-var
   echoing / infra-path leakage, as the last gate before generated code reaches a
   customer repo.
5. **Durable tool-call audit log (P2)** — immutable, append-only, 90-day retention,
   correlated by run-id; the forensic prerequisite when prevention fails.

Brief sanitization is the **weakest** mitigation (stops only unsophisticated
attacks) — the **allowlist** is the primary prompt-injection defense, not the filter.

### Runtime (owner: VP-DevOps)

**Hybrid model.** The compiler-validator runs as an **ephemeral per-run container**
(OS-level isolation is mandatory for executing untrusted generated code):
`node:20-alpine` (distroless can't run tsc/eslint as child processes), read-only
rootfs, `--cap-drop ALL`, no network, 0.5 CPU / 512Mi / 60s timeout, **stdio MCP
transport** (one-shot process, not a persistent server). `devflow-api` holds the
Docker socket and spawns it via dockerode, reads the MCP response, removes the
container. All **other** MCP servers (filesystem, npm-resolver, github, context7)
are **long-lived shared** processes on an internal network — their cold-start +
connection overhead outweighs isolation benefit since they execute no code.
On-demand validator spawning is cost-correct below **~288 runs/day**; past that a
2-container warm pool (~$32/mo) breaks even and cuts latency. Workspaces are
host-bind-mounted and cleaned by a NestJS `@Cron` 24h-TTL job.

### Cost (owner: CFO)

A tool loop costs **1.6-2.0x** a JSON-only run at GPT-4.1-mini pricing (2.5-3.0x on
Haiku — its 4x output rate is punishing). Counter-intuitively, the **dominant cost
is memory injection** (~3K tokens/node/call), not the tool iterations — halving the
injected context (3K -> 1.5K) saves nearly as much as cutting iterations. Free-tier
models are unreliable at function-calling, so **tool-use realistically requires paid
models**; **$9/mo** is the defensible minimum paid tier. Enforce RunBudget token caps
of **150K / 400K / 900K** (simple / medium / complex) — ~3x headroom over nominal for
retries — incrementing `tokensConsumed` from actual usage **after every sub-call**
(crash-safe), hard-stopping at the cap.

### Integration seam (owner: VP-Engineering, code-verified)

Additive, low-blast-radius. **New files**: `providers/mcp-tool.types.ts` (interfaces),
`providers/mcp-tool-registry.ts` (the registry/allowlist enforcer),
`providers/mcp-capability.config.ts` (server connection info + per-node allowlists).
**One existing file changes**: `graph-llm.provider.ts` gains two public methods
(`generateWithTools<T>()`, `supportsToolCalling()`) + one private tool-aware
request-body builder — all existing methods untouched. `LlmAgentProvider` (the
separate work-order path) is out of scope.

Three code-verified constraints that shape the build:
- **Mock is free**: every node's `MOCK_MODE` check sits above the LLM call site, so
  `generateWithTools()` inherits mock protection with zero changes to mock blocks.
- **Validator/github-commit have NO LLM hook** (they don't call `generateJson()`).
  So the compiler-validator is **not** an LLM tool-loop inside ValidatorNode — the
  node invokes the MCP tool **directly** and routes on the result via the existing
  `RETRY:` edges. (Refines the Tier-1 framing: grounding tools are LLM-callable in
  the *generating* agents; in the validator the tool is a direct call.)
- **Concurrency**: `withLlmRequest()` wraps one HTTP call + one concurrency slot —
  call it **per round-trip**, never hoisted around the whole loop (would hold a slot
  for minutes). `DatabaseAgentNode` is the highest-ROI first target (its
  `checkPrismaSchema()` is weak regex today).

## Phased build path

- **Phase 0** — MCP client infra + provider tool-loop behind a flag; mock stubs;
  extend requirements-parser output with `capabilities[]`. No behavior change.
- **Phase 1 (MVP)** — Tier-1 grounding tools only for ONE archetype (recommend:
  fullstack-TS SaaS dashboard). Build the 3 custom servers in ROI order:
  **(1) compiler-validator** (highest ROI — catches TS errors before Gate 2),
  **(2) prisma-schema** (closes the database-agent feedback loop),
  **(3) npm-resolver** (kills stale version commits). Reuse official filesystem +
  Context7 directly. `docker-sandbox` is **deferred pending security sign-off**.
- **Phase 2** — Capability Resolver + archetype manifest + 2-3 capability MCPs
  (auth, payments, CMS). Two more archetypes.
- **Phase 3** — Sandboxed exec hardening, per-run secrets, more archetypes.
- **Phase 4** — Optional experimental/open tier behind a flag.

## Open decisions for sign-off

1. Which archetypes to prioritize first (MVP targets one).
2. Build vs buy for the sandboxed validator runtime.
3. Accept that reliable tool-use requires paid LLM models (vs free-tier default)?
4. MCP container hosting: same cluster/sidecars vs a separate pool.

## Consequences

- Agents become grounded (read real files, validate against a real compiler,
  use real package versions/docs) instead of hallucinating — the single biggest
  output-quality lever.
- The system scales to new project types by adding archetype manifest entries +
  catalog servers, not by changing agent code.
- Added operational surface: MCP server runtime, sandboxing, per-run secrets, and
  higher per-run LLM cost — all bounded by the curated-catalog + RunBudget choices.
