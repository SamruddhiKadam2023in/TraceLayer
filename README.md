# TraceLayer

**API Reliability & Observability Platform.** TraceLayer helps developers and engineering teams
understand whether their APIs are healthy, how they are performing, when they fail, and what
caused the failure.

> **Project status: Phase 1 of 20 (Foundation) complete.** The monorepo, frontend, backend,
> worker, database and Docker stack are running end to end. Product features are added phase by
> phase following the [master specification](docs/SPEC.md). Sections below marked _(planned)_
> describe features that do not exist yet.

## Contents

- [Problem statement](#problem-statement)
- [Product features](#product-features)
- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [Local development](#local-development)
- [Testing and code quality](#testing-and-code-quality)
- [API](#api)
- [Security](#security)
- [Roadmap](#roadmap)
- [Documentation](#documentation)

## Problem statement

Most API tools answer "what did this one request return?". Teams running APIs in production need
different answers: _Is the API up right now? Is it getting slower? When did it start failing,
and why?_ TraceLayer schedules recurring checks against your endpoints, records every result,
turns threshold breaches into incidents with a timeline, and alerts the right people. It is a
monitoring and investigation tool, not a Postman clone.

## Product features

| Feature                                                            | Status                    |
| ------------------------------------------------------------------ | ------------------------- |
| System status page (live API, database, Redis and worker health)   | ✅ Phase 1                |
| Accounts and authentication (JWT access + rotating refresh tokens) | _(planned, Phase 2)_      |
| Workspaces with roles (owner, admin, member, viewer)               | _(planned, Phase 3)_      |
| Projects, environments and API endpoints                           | _(planned, Phases 4–5)_   |
| Manual request builder with history                                | _(planned, Phase 6)_      |
| Scheduled monitors (availability, status, performance, validation) | _(planned, Phase 7)_      |
| Metrics and analytics dashboards                                   | _(planned, Phases 8–9)_   |
| Alert rules, incidents and incident timelines                      | _(planned, Phases 10–11)_ |
| Real-time dashboard updates                                        | _(planned, Phase 12)_     |
| API dependency map                                                 | _(planned, Phase 13)_     |

## Architecture

```text
React (Vite) ──/api──▶ Express API ──▶ Service layer ──▶ PostgreSQL (Prisma)
                            │
                            └──▶ Redis ──▶ BullMQ ──▶ Worker ──▶ External APIs
                                                         │
                               React dashboard ◀── Socket.IO ◀┘
```

- **Frontend:** a React SPA. In Docker it is served by nginx, which also proxies `/api` to the
  backend, so the browser only ever talks to one origin.
- **Backend:** Express REST API with a routes → controllers → services structure, validated
  configuration, structured logging with request IDs, and one consistent JSON response format.
- **Worker:** a separate process that runs monitor checks from a BullMQ queue, so slow external
  APIs never block the API server. It reports liveness through a heartbeat in Redis.
- **Data:** PostgreSQL is the system of record; Redis holds the job queue and heartbeat.

The full design, including every component and the Docker topology, is in
[docs/architecture.md](docs/architecture.md).

## Technology stack

| Area     | Technology                                                                   |
| -------- | ---------------------------------------------------------------------------- |
| Frontend | React 19, TypeScript, Vite 6, Tailwind CSS 4, React Router 7, Zustand, axios |
| Backend  | Node.js 20+, Express 5, TypeScript, Zod, pino                                |
| Database | PostgreSQL 16, Prisma 6                                                      |
| Jobs     | Redis 7, BullMQ 5, ioredis                                                   |
| Testing  | Jest + Supertest (backend, worker), Vitest + Testing Library (frontend)      |
| Tooling  | pnpm workspaces, ESLint 9, Prettier 3, Docker Compose                        |

## Local development

### Prerequisites

- Node.js 20.17 or newer (see `.nvmrc`)
- pnpm 10 (`corepack enable` installs the version pinned in `package.json`)
- Docker Desktop (runs PostgreSQL and Redis; optionally the whole stack)

### Setup

```bash
pnpm install
cp .env.example .env        # development defaults work as-is
```

### Option A: everything in Docker

```bash
docker compose up --build
```

| Service    | URL                                          |
| ---------- | -------------------------------------------- |
| App        | http://localhost:8080                        |
| API health | http://localhost:4000/api/health             |
| PostgreSQL | `localhost:5434` (user/pass/db `tracelayer`) |
| Redis      | `localhost:6379`                             |

The backend applies database migrations automatically on start. Stop with `docker compose down`;
add `-v` to also delete the database and Redis volumes.

### Option B: apps on your machine, databases in Docker

Faster feedback while coding: hot reload for all three apps, and nothing is rebuilt into images.

```bash
pnpm infra:up      # start only PostgreSQL and Redis in Docker
pnpm db:generate   # generate the Prisma client
pnpm db:migrate    # apply migrations to the dev database
pnpm dev           # frontend, backend and worker with hot reload
```

The app runs at http://localhost:5180 (Vite proxies `/api` to the backend on port 4000).
If the Docker `backend` container is also running, stop it first
(`docker compose stop backend worker frontend`), since both use port 4000.

PostgreSQL is published on port **5434** so it does not clash with a PostgreSQL already installed
on your machine. To use a different port, change `POSTGRES_PORT` and `DATABASE_URL` in `.env`.

### Useful scripts

| Command                        | What it does                               |
| ------------------------------ | ------------------------------------------ |
| `pnpm dev`                     | Run all apps in watch mode                 |
| `pnpm build`                   | Build every package and app                |
| `pnpm typecheck`               | Type-check the whole workspace             |
| `pnpm lint`                    | ESLint                                     |
| `pnpm format:check`            | Prettier check (`pnpm format` to fix)      |
| `pnpm test`                    | Run all test suites                        |
| `pnpm infra:up` / `infra:down` | Start / stop PostgreSQL and Redis          |
| `pnpm db:migrate`              | Create and apply a migration (development) |

## Testing and code quality

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

Current coverage (Phase 1): the backend health, 404 and error-envelope behaviour (Jest +
Supertest), the worker heartbeat (Jest), and the System Status page (Vitest + Testing Library).
End-to-end tests with Playwright arrive in Phase 15, and a GitHub Actions pipeline running all of
the above in Phase 16.

## API

All endpoints live under `/api` and return one of two shapes:

```json
{ "success": true, "data": {} }
{ "success": false, "error": { "code": "NOT_FOUND", "message": "…", "requestId": "…" } }
```

| Method | Path               | Description                                                               |
| ------ | ------------------ | ------------------------------------------------------------------------- |
| GET    | `/api/health/live` | Liveness check                                                            |
| GET    | `/api/health`      | Status of the database, Redis and worker; **503** if a data store is down |

Full API documentation is added as endpoints are built _(planned: `docs/api.md`)_.

## Security

In place from Phase 1:

- Security headers via `helmet`; `x-powered-by` disabled.
- CORS limited to the configured frontend origin.
- JSON request bodies capped at 1 MB.
- Configuration validated at startup; the server refuses to start with missing or weak secrets.
- Request logs are allowlisted: headers, cookies and tokens are never written to logs.
- Unexpected errors return a generic message; stack traces stay server-side.
- No real secrets in the repository: `.env` is git-ignored and `.env.example` holds
  development-only placeholders.

Planned: authentication and role-based access (Phases 2–3), SSRF protection for monitor
requests (Phase 7), rate limiting and further hardening (Phase 14).

## Roadmap

Development follows the 20 phases in [docs/SPEC.md](docs/SPEC.md#56-implementation-order):
foundation → authentication → workspaces → projects → endpoints → request builder → monitor
engine → metrics → analytics → alerts → incidents → real-time → dependency map → security
hardening → testing → CI/CD → demo data → UI polish → documentation → deployment.

## Documentation

| Document                                     | Contents                                         |
| -------------------------------------------- | ------------------------------------------------ |
| [docs/SPEC.md](docs/SPEC.md)                 | The master product and engineering specification |
| [docs/architecture.md](docs/architecture.md) | System architecture and components               |

Further guides (database, API, monitoring, security, deployment) are added in the phases that
build those parts.
