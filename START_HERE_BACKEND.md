# START_HERE_BACKEND

DevFlow runs standalone — no APICenter gateway. Deploy directly to Render with DATABASE_URL, SUPABASE_URL, and LLM provider keys.

## 1) What This Repository Is

It contains a deployable runtime and shared libraries:

```text
apps/api                 HTTP API runtime
libs/common              config, security, filters, middleware, seed data
libs/contracts           shared message patterns and DTO contracts
libs/supabase            Supabase module and health helpers
```

The API is a NestJS project in a monorepo workspace. Shared libraries are co-located under `libs/`.

## 2) Day-0 GitHub Setup

Set `BACKEND_MULTI_SYSTEMS_JSON` in repository variables. Example:

```json
[
  {
    "name": "devflow-api",
    "dir": ".",
    "install_dir": ".",
    "project": "api",
    "image": "ghcr.io/your-org/devflow-api",
    "backend_stack": "nestjs",
    "version_stream": "api",
    "test_command": "npm run test:cov -- --selectProjects api",
    "build_command": "npm run build:api",
    "dockerfile_path": "apps/api/Dockerfile",
    "k6_script_path": "tests/performance/api-smoke.js"
  }
]
```

Do not use `BACKEND_SINGLE_SYSTEMS_JSON` for this template.

## 3) Runtime Env

Required in production:

- `NODE_ENV=production`
- `PORT`
- `ALLOWED_ORIGINS`
- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Supabase can use the default `SUPABASE_URL` plus `SUPABASE_SERVICE_ROLE_KEY`, or service-scoped pairs such as `PAYMENT_SERVICE_SUPABASE_URL` plus `PAYMENT_SERVICE_SUPABASE_SECRET_KEY`.

## 4) Development Commands

```bash
npm install
npm run start:dev
npm run lint
npm run typecheck
npm run build
npm run test:cov
npm run test:e2e
```

On Windows, if Jest worker spawning is blocked locally, use:

```bash
npm run test:cov -- --runInBand
npm run test:e2e -- --runInBand
```

## 5) Adding Features

- Put HTTP-facing controllers and API composition under `apps/api/src`.
- Put independently deployable domain workers under `apps/<domain>-service`.
- Put cross-app DTOs, message patterns, and event names under `libs/contracts`.
- Put shared Supabase access under `libs/supabase`.

New microservices should get their own Dockerfile, test selector, image name, and `BACKEND_MULTI_SYSTEMS_JSON` entry.

## 6) Common Mistakes To Avoid

- Reintroducing a root `src/` app as the primary runtime.
- Using `BACKEND_SINGLE_SYSTEMS_JSON` for this monorepo.
- Putting secrets in frontend code or plaintext files committed to version control.
