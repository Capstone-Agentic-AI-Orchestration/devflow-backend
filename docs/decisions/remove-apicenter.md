# ADR-001: Remove APICenter Integration

## Status

Accepted

## Date

2026-06-13

## Context

The devflow-backend monorepo was scaffolded from a template built to integrate with an internal
"APICenter" gateway system. That integration provided three things:

1. **Service registration** — a `tribe-manifest.json` declared the service to the gateway on
   startup via `TribeClient`.
2. **Geo proxy** — an orphaned `apps/location-service` app routed geolocation requests through
   the APICenter gateway.
3. **Health augmentation** — the health check module injected `TribeClient` and treated its
   presence as a proxy for gateway connectivity.

The integration is delivered through the private SDK `@implementsprint/sdk`, hosted on GitHub
Packages. This creates a hard authentication dependency: every `npm install` and every Docker
build must present a valid `GITHUB_TOKEN` with `read:packages` scope. That token must be
available as a CI secret, a Docker build secret, and a local developer env var.

None of the three APICenter features are used by the actual DevFlow feature set:

- `location-service` has zero callers in the frontend or the `api` app (confirmed by grep across
  the full monorepo). It exists only as scaffolding residue.
- The health check does not ping the gateway. It evaluates `!!tribeClient` — a boolean that is
  always `true` when the env vars are set. It reveals nothing about real service health.
- Service registration is a no-op from the DevFlow product's perspective; the service is deployed
  directly on Render and not accessed through the APICenter gateway.

The private SDK therefore provides no functional value while imposing a concrete operational cost
on every install, every build, and every CI run.

## Decision

Remove the APICenter integration in full:

- Delete `libs/api-center` and all code in it.
- Delete `apps/location-service`.
- Remove `@implementsprint/sdk` from all `package.json` files.
- Remove `TribeClient` injection from the health module; replace with a database-only health
  check (Supabase connectivity ping).
- Remove `tribe-manifest.json` and any gateway registration startup logic.
- Remove all references to GitHub Packages (`@implementsprint` scope) from `.npmrc` and
  `Dockerfile`.

### Before

```
NestJS monorepo
  -> TribeClient (@implementsprint/sdk)
       -> APICenter gateway: service registration
       -> APICenter gateway: geo proxy (location-service)
       -> Health check: TribeClient presence (boolean)
  npm install: requires GITHUB_TOKEN + GitHub Packages auth
  Docker build: requires --secret id=github_token
```

### After

```
NestJS monorepo
  -> REST + WebSocket API (direct, no gateway)
  -> Health check: Supabase database ping only
  npm install: public npm registry only
  Docker build: no secret mounts required
  Deployed directly on Render
```

## Consequences

**Positive:**

- CI pipelines no longer require a `GITHUB_TOKEN` secret for `npm install`.
- Dockerfile no longer requires a secret mount; the build is simpler and cache-friendlier.
- `npm install` is faster (no private registry round-trip or auth overhead).
- The health endpoint becomes accurate: the database is the only real runtime dependency, and the
  check now reflects actual liveness rather than env var presence.
- Onboarding friction is reduced; developers can clone and install without configuring GitHub
  Packages access.

**Neutral / Risk:**

- No functional capability is lost. `location-service` had zero callers. The health boolean was
  not a meaningful liveness signal. Service registration had no downstream consumer within the
  DevFlow product.
- If the team ever integrates a future gateway, a new ADR and integration layer will be required
  at that time. The current removal does not preclude that.
