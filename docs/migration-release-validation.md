# Release Validation: devflow-be -> devflow-backend Migration

Date: 2026-06-13

## CI/CD Pipeline

- be-pipeline-caller.yml: VALID — no changes required. Branch triggers (test, uat, main),
  `secrets: inherit`, permissions block, and all `with:` inputs are correct. The `run_deploy`
  pass-through correctly enables deploy lanes on push events.
- k6 path: tests/performance [EXISTS] — contains api-smoke.js.
  The script uses env-var-driven base URLs with no hardcoded service names that needed updating.
- central workflow ref: ImplementSprint/central-workflow/.github/workflows/master-pipeline-be.yml@main [CONFIRMED]

## Docker

- Root Dockerfile (Dockerfile): UPDATED — added `COPY prisma ./prisma` and `RUN npx prisma generate`
  before `RUN npm run build:api`. Prisma client must be generated before TypeScript compilation
  because app code imports from `@prisma/client`.
- apps/api/Dockerfile: UPDATED — same Prisma steps added (file was an identical copy of root Dockerfile).
- Prisma generate step: ADDED to both Dockerfiles
- Port: 3000 [CONFIRMED] — EXPOSE 3000 and HEALTHCHECK both target port 3000
- CMD: node dist/apps/api/main [CONFIRMED]
- Non-root user: nestjs (uid 1001) [CONFIRMED]

## Sonar

- sonar-project.properties: UPDATED — expanded from a single lcov line to full monorepo config.
- Sources: apps,libs — covers all NestJS apps and shared libraries
- Tests: tests,apps/api/src,libs — includes standalone test dir and co-located spec files
- Test inclusions: **/*.spec.ts,tests/**/*.ts
- Exclusions: node_modules, dist, coverage
- Coverage: coverage/lcov.info
- Note: sonar.projectKey and sonar.organization remain injected by CI via CLI args (not hardcoded)

## .dockerignore

[EXISTS] — added `test-results` entry. Existing entries cover node_modules, dist, .env,
.env.* (with !.env.example carve-out), coverage, .git, .github, .vscode, logs, tests, README.

## .trivyignore

[EXISTS with 1 entry] — CVE-2026-33671 (picomatch ReDoS, HIGH) suppressed. Justification is
valid: npm is not invoked at runtime; the production image CMD runs `node dist/apps/api/main`
directly. No changes made.

## Builder Stage Order (both Dockerfiles, post-fix)

```
COPY tsconfig*.json nest-cli.json ./
COPY apps ./apps
COPY libs ./libs
COPY prisma ./prisma
RUN npx prisma generate
RUN npm run build:api
```

## Items Requiring No Action

- .npmrc / GITHUB_TOKEN secret mount pattern: correct, no changes
- nest-cli.json monorepo build target (build:api): assumed correct per vp-engineering migration
- tsconfig.json / tsconfig.build.json: not modified by this validation pass
- render-build.sh: not in scope for this validation
