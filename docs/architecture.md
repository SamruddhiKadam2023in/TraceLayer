# Architecture

TraceLayer is a pnpm monorepo with three runnable apps (frontend, backend, worker) and two shared
packages (database client, shared types). PostgreSQL is the system of record; Redis carries the job
queue, the worker heartbeat and, later, real-time fan-out.

> **Status:** this document describes the Phase 1 foundation. Sections marked _(planned)_ describe
> the target design from [SPEC.md](SPEC.md) and are filled in by the phase noted.

## System diagram

```text
                    ┌──────────────────────────┐
  Browser  ───────▶ │  Frontend (React + Vite) │  served by nginx in Docker
                    └────────────┬─────────────┘
                                 │  /api/*  (REST)      /socket.io/*  (WebSocket, planned)
                                 ▼
                    ┌──────────────────────────┐
                    │   Backend (Express API)  │
                    │  routes → controllers →  │
                    │        services          │
                    └──────┬───────────┬───────┘
                           │           │
                 Prisma    │           │  ioredis / BullMQ producer (planned)
                           ▼           ▼
                   ┌────────────┐ ┌────────────┐
                   │ PostgreSQL │ │   Redis    │
                   └─────▲──────┘ └─────┬──────┘
                         │              │  BullMQ queue "monitor-checks"
                         │              ▼
                         │     ┌──────────────────┐        ┌───────────────┐
                         └──── │  Worker (BullMQ) │ ─────▶ │ External APIs │  (planned, Phase 7)
                               └────────┬─────────┘        └───────────────┘
                                        │  events via Redis (planned, Phase 12)
                                        ▼
                               Socket.IO on the backend → React dashboard
```

The spec's three flows map onto this as:

| Flow                                              | Purpose                               | Available from |
| ------------------------------------------------- | ------------------------------------- | -------------- |
| React → Express API → Service layer → PostgreSQL  | All user-driven reads and writes      | Phase 1        |
| Express → Redis → BullMQ → Worker → External APIs | Scheduled monitor checks, off the API | Phase 7        |
| Worker → Socket.IO → React dashboard              | Live check results, incidents, status | Phase 12       |

## Repository layout

```text
apps/
  frontend/   React 19 + Vite 6 + Tailwind 4 SPA
  backend/    Express 5 REST API
  worker/     BullMQ worker process
packages/
  db/         Prisma schema, migrations and the generated client (@tracelayer/db)
  shared/     Types and constants used by all apps (@tracelayer/shared)
docker/       nginx config for the frontend container
docs/         Specification and technical documentation
Dockerfile    Multi-target build: backend, worker, frontend
docker-compose.yml
```

## Components

### Frontend — `apps/frontend`

- React 19, TypeScript (strict), Vite, Tailwind CSS 4, React Router 7, Zustand for client state.
- Structure: `pages/` (route screens), `layouts/`, `components/`, `hooks/`, `services/` (API
  calls), `stores/` (Zustand), `utils/`.
- `services/api.ts` is the single HTTP client: an axios instance with base URL `/api`, cookies
  enabled and a 15 s timeout. Feature services (e.g. `health.service.ts`) build on it and read the
  backend's response envelope (see [Response format](#response-format)).
- Theme (light/dark) is stored in a Zustand store and applied before first paint.
- **In development** Vite serves the app on `http://localhost:5180` and proxies `/api` and
  `/socket.io` to the backend, so the browser sees a single origin.
- **In Docker** the app is built to static files and served by nginx, which also reverse-proxies
  `/api` and `/socket.io` to the backend (`docker/nginx.conf`). Unknown paths fall back to
  `index.html` for client-side routing; hashed assets are cached for a year, the HTML shell never.
- Phase 1 ships one real screen, **System Status**, which renders the live `/api/health` report.

### Backend — `apps/backend`

Layered so HTTP concerns never leak into business logic:

```text
routes/        URL → controller mapping
controllers/   parse the request, call a service, shape the response
services/      business logic; the only layer that talks to Prisma/Redis
middleware/    cross-cutting concerns (errors; auth and validation in later phases)
lib/           long-lived clients (Prisma, Redis)
config/env.ts  environment validated with Zod at startup — the process exits on bad config
utils/         logger, AppError
```

Request pipeline (in order): `helmet` security headers → CORS restricted to `FRONTEND_URL` with
credentials → `pino-http` request logging → JSON body parser (1 MB limit) → cookie parser → `/api`
router → 404 handler → error handler.

- **Request IDs.** Every request gets an ID (a valid incoming `x-request-id` is reused, otherwise
  a UUID). It is returned in the `x-request-id` header, attached to logs, and included in error
  responses so a user-reported error can be traced to its log line.
- **Logging.** Structured JSON via pino. Request logs use an allowlist (`id`, `method`, `url`,
  `statusCode`, response time); headers are never logged, so `Authorization` values and cookies
  cannot end up in logs. Health-check requests are not logged to keep noise down.
- **Errors.** All failures go through one error handler. Known errors (`AppError`, Zod
  validation, malformed or oversized JSON) map to a stable error code and HTTP status. Anything
  unexpected is logged in full server-side and returned to the client as a generic
  `INTERNAL_ERROR` with no stack trace.
- **Proxy awareness.** `trust proxy` is set to one hop, matching nginx locally and the platform
  load balancer in production, so client IPs are correct for rate limiting (Phase 14).

#### Response format

Success:

```json
{ "success": true, "data": { "...": "..." } }
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "email", "message": "Invalid email" }],
    "requestId": "8f0c…"
  }
}
```

Both shapes are defined once in `@tracelayer/shared` and used by the backend and the frontend.

#### Health endpoints

| Endpoint               | Meaning                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/health/live` | Liveness: the process is serving HTTP. Used by the Docker health check.                                                                                                                                                                                                              |
| `GET /api/health`      | Readiness: probes PostgreSQL (`SELECT 1`) and Redis (`PING`), each with a 2 s timeout, and reads the worker heartbeat. Returns **200** if the database and Redis are up and **503** otherwise. The body's `status` is `ok` only when the worker is also alive, otherwise `degraded`. |

### Worker — `apps/worker`

- A separate Node process consuming the BullMQ queue `monitor-checks`, so slow or failing
  external APIs can never block the HTTP server.
- Concurrency is configurable (`WORKER_CONCURRENCY`, default 10).
- **Heartbeat.** Every 10 s the worker writes the current time to the Redis key
  `tracelayer:worker:heartbeat` with a 30 s expiry. The API reads that key: if it has expired,
  the worker is reported down. No extra endpoint or port is needed on the worker.
- **Graceful shutdown.** On `SIGTERM`/`SIGINT` it stops taking jobs, waits for in-flight jobs
  to finish (hard exit after 15 s), removes its heartbeat and closes its connections.
- Phase 1 only logs received jobs. Monitor execution (SSRF-safe HTTP checks, result storage,
  alert-rule evaluation) arrives in Phase 7.

### Database — PostgreSQL + Prisma (`packages/db`)

- PostgreSQL 16 is the system of record. Prisma 6 provides the schema, migrations and a typed
  client, published inside the monorepo as `@tracelayer/db` and shared by the backend and worker.
- Models are added phase by phase, each with its own migration. Phase 1 contains only the
  datasource and generator, no tables yet.
- The backend container runs `prisma migrate deploy` before starting, so a fresh
  `docker compose up` always has an up-to-date schema. The worker waits for the backend to
  become healthy, which guarantees migrations have run first.

### Redis

- Redis 7 in append-only mode with `maxmemory-policy noeviction`: BullMQ stores jobs in Redis,
  and an evicting policy could silently drop queued work.
- Current uses: the BullMQ queue and the worker heartbeat. Planned: scheduled (repeatable)
  monitor jobs, rate-limit counters (Phase 14), and Socket.IO event fan-out (Phase 12).

### Shared package — `packages/shared`

Types and constants every app agrees on: the API envelope types, `HealthReport`, HTTP methods,
workspace roles (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`), queue names and Redis key names.
Defining them once stops the frontend, backend and worker from drifting apart.

## Configuration

All configuration comes from environment variables; see [`.env.example`](../.env.example) for
the complete, commented list. The backend and worker validate their variables with Zod at
startup and refuse to start with a clear message if anything is missing or malformed. Real
secrets are never committed: `.env` is git-ignored and every value in `.env.example` is a
development-only placeholder.

## Runtime topology (Docker Compose)

| Service    | Image / target                 | Host port     | Notes                                            |
| ---------- | ------------------------------ | ------------- | ------------------------------------------------ |
| `postgres` | `postgres:16-alpine`           | `5434` → 5432 | Named volume `pgdata`                            |
| `redis`    | `redis:7-alpine`               | `6379`        | Named volume `redisdata`, AOF, `noeviction`      |
| `backend`  | `Dockerfile` target `backend`  | `4000`        | Runs migrations, then the API; health-checked    |
| `worker`   | `Dockerfile` target `worker`   | —             | Starts after the backend is healthy              |
| `frontend` | `Dockerfile` target `frontend` | `8080` → 80   | nginx: static SPA + reverse proxy to the backend |

The Postgres host port defaults to `5434` so it does not clash with a locally installed
PostgreSQL on 5432/5433.

The `Dockerfile` is one multi-stage build: a shared dependency stage installs the whole workspace
once (with a pnpm store cache mount), then separate stages compile the server apps and the
frontend. The server images currently run as root; switching them to the unprivileged `node`
user and slimming them to production-only dependencies is part of Phase 14 (security hardening).
