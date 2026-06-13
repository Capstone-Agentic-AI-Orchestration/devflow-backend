# Prisma Migration Strategy: devflow-backend

## Schema Placement

The Prisma schema lives at `prisma/schema.prisma` at the monorepo root. This is
the standard placement for NestJS monorepos — the Prisma CLI resolves the schema
from the directory where `prisma` commands are run (the repo root).

## Library Architecture

PrismaService and PrismaModule are in `libs/prisma/src/` and exported via the
`@app/prisma` path alias. The module is decorated with `@Global()` so any module
in the monorepo can inject PrismaService without explicit imports.

## Build Integration

The Dockerfile runs `npx prisma generate` before `npm run build:api`. This is
required because `@prisma/client` is generated at the `prisma generate` step —
the TypeScript compilation will fail if this step is skipped.

## Migration Commands

- `npm run prisma:generate` — generate Prisma client (must run after schema changes)
- `npm run prisma:migrate` — run migrations in development (creates migration files)
- `npx prisma migrate deploy` — apply migrations in production (non-interactive)

## pgvector Extension

The schema uses `pgvector(map: "vector")` for the `AgentMemory.embedding` field.
This requires the pgvector extension to be installed in PostgreSQL. In production
(Supabase), pgvector is available by default. For local development, use the
docker-compose.yml which starts postgres with pgvector.

## Production Migration Approach

1. Run `npx prisma migrate deploy` as part of the deployment pipeline (before starting the app)
2. The central CI pipeline handles this via the deploy step
3. Never run `prisma migrate dev` in production

## Key Models

- `Profile` — Supabase user profiles (synced on auth)
- `Project` — core project entity
- `AgentMemory` — LangGraph agent memory with pgvector embeddings
- `OrchestrationRun` — tracks LangGraph run status
- `WorkOrder` — individual agent task dispatches
- `ClientInquiry` / `ClientInvite` — client onboarding flow
