# TraceLayer

**API Reliability & Observability Platform.** TraceLayer helps developers and engineering teams
understand whether their APIs are healthy, how they are performing, when they fail, and what
caused the failure.

> **Project status: Phase 15 of 20 (Testing) complete.** The monorepo, frontend, backend,
> worker, database and Docker stack run end to end. Users can sign in, share workspaces with
> teammates under role-based permissions, organise their APIs into projects with environments
> and encrypted secret variables, save API endpoints with their full request configuration, and run them through an
> SSRF-protected request builder with a response viewer and searchable request history. Monitors
> run endpoints on a schedule (Redis + BullMQ + a dedicated worker) and record every result;
> uptime, error rate, latency percentiles and health are computed from those runs and shown
> on a workspace dashboard and per-project, per-endpoint and per-monitor analytics with charts.
> Alert rules on monitors fire and resolve alerts automatically and email the workspace's
> notification channels. Firing alerts open incidents that the team acknowledges, assigns,
> comments on and resolves, with a full timeline; incidents resolve automatically when the
> monitor recovers. Monitor status, incidents and the dashboard update live over Socket.IO,
> with notifications when incidents open or resolve. Each project has an editable dependency map
> (React Flow) with live health, and can detect dependencies from the hosts its endpoints call.
> Product features are added phase by
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

| Feature                                                                                 | Status      |
| --------------------------------------------------------------------------------------- | ----------- |
| System status page (live API, database, Redis and worker health)                        | ✅ Phase 1  |
| Accounts and authentication (JWT access + rotating refresh tokens)                      | ✅ Phase 2  |
| Workspaces with roles (owner, admin, member, viewer)                                    | ✅ Phase 3  |
| Projects, environments and environment variables (encrypted secrets)                    | ✅ Phase 4  |
| API endpoints: method, URL, headers, params, body, auth, timeout, tags                  | ✅ Phase 5  |
| Request builder with response viewer and request history, SSRF-protected                | ✅ Phase 6  |
| Scheduled monitors (availability, status, performance, validation)                      | ✅ Phase 7  |
| Metrics: uptime, error rate, P50/P95/P99, status codes, health                          | ✅ Phase 8  |
| Analytics dashboard: metric cards, latency/error/volume/status charts, monitor health   | ✅ Phase 9  |
| Alert rules with severities, fired-alert history, email notification channels           | ✅ Phase 10 |
| Incidents: severity, status, assignment, comments, timeline, auto-resolution            | ✅ Phase 11 |
| Real-time updates (Socket.IO): live monitor status, incidents, dashboard, notifications | ✅ Phase 12 |
| API dependency map (React Flow): manual and inferred dependencies, live node health     | ✅ Phase 13 |

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

| Area     | Technology                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| Frontend | React 19, TypeScript, Vite 6, Tailwind CSS 4, React Router 7, Zustand, axios, React Hook Form, Zod, Recharts |
| Backend  | Node.js 20+, Express 5, TypeScript, Zod, pino, jsonwebtoken, bcrypt (bcryptjs), express-rate-limit           |
| Database | PostgreSQL 16, Prisma 6                                                                                      |
| Jobs     | Redis 7, BullMQ 5, ioredis                                                                                   |
| Testing  | Jest + Supertest (backend, worker), Vitest + Testing Library (frontend)                                      |
| Tooling  | pnpm workspaces, ESLint 9, Prettier 3, Docker Compose                                                        |

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

| Service    | URL                                            |
| ---------- | ---------------------------------------------- |
| App        | http://localhost:8080                          |
| API health | http://localhost:4000/api/health               |
| PostgreSQL | `localhost:5434` (user/pass/db `tracelayer`)   |
| Redis      | `localhost:6379`                               |
| Mailpit    | http://localhost:8025 (alert emails land here) |

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
Open it and create an account; every page except sign-in and sign-up requires one.
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
pnpm infra:up                  # PostgreSQL and Redis for the integration tests
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test

docker compose up -d --build   # the full stack, for the end-to-end test
pnpm test:e2e
```

| Level       | Tool                     | Covers                                                                                                                                         |
| ----------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Jest                     | Validation, check evaluation, health rules, SSRF rules, request execution, timeline text                                                       |
| Integration | Jest + Supertest         | Every API route against real PostgreSQL and Redis; the worker's checks, alerts, incidents, notifications and schedules; forced race conditions |
| Frontend    | Vitest + Testing Library | Login, dashboard, endpoint and monitor creation, incident filtering, charts, empty states, live updates                                        |
| End-to-end  | Playwright               | The critical flow in a real browser against the Docker stack: register → … → resolve incident                                                  |

Integration tests use separate test databases, so development data is never touched. The
end-to-end test uses the Microsoft Edge that ships with Windows, so no browser download is
needed. Details, settings and what each suite covers: [docs/testing.md](docs/testing.md).

A GitHub Actions pipeline running all of this arrives in Phase 16.

## API

All endpoints live under `/api` and return one of two shapes:

```json
{ "success": true, "data": {} }
{ "success": false, "error": { "code": "NOT_FOUND", "message": "…", "requestId": "…" } }
```

| Method | Path                           | Auth           | Description                                                             |
| ------ | ------------------------------ | -------------- | ----------------------------------------------------------------------- |
| GET    | `/api/health/live`             | —              | Liveness check                                                          |
| GET    | `/api/health`                  | —              | Database, Redis and worker status; **503** if a data store is down      |
| POST   | `/api/auth/register`           | —              | Create an account and start a session                                   |
| POST   | `/api/auth/login`              | —              | Start a session                                                         |
| POST   | `/api/auth/refresh`            | Refresh cookie | Rotate the refresh token, get a new access token                        |
| POST   | `/api/auth/logout`             | Refresh cookie | End the session                                                         |
| GET    | `/api/auth/me`                 | Bearer token   | The signed-in user                                                      |
| —      | `/api/workspaces/…`            | Bearer token   | Workspace CRUD and members (see the API reference)                      |
| —      | `/api/projects/…`              | Bearer token   | Projects, environments and variables (see the API reference)            |
| —      | `/api/endpoints/…`             | Bearer token   | Saved API endpoints (see the API reference)                             |
| POST   | `/api/requests/execute`        | Bearer token   | Send a request (SSRF-protected)                                         |
| GET    | `/api/requests/history`        | Bearer token   | Request history with filters and paging                                 |
| —      | `/api/monitors/…`              | Bearer token   | Monitors, run now and run history (see the API reference)               |
| GET    | `/api/metrics…`                | Bearer token   | Metrics summary, per-monitor overview, latency and error series         |
| —      | `/api/alerts/…`                | Bearer token   | Alert rules and fired alerts (see the API reference)                    |
| —      | `/api/notification-channels/…` | Bearer token   | Email notification channels and test sends                              |
| —      | `/api/incidents/…`             | Bearer token   | Incidents, status/assignee changes and comments (see the API reference) |
| —      | `/api/dependencies…`           | Bearer token   | Dependency map: load, save (versioned), inferred suggestions            |

Request and response details for every endpoint: [docs/api.md](docs/api.md).

## Security

In place so far:

- **Passwords** are hashed with bcrypt (cost 12) and never stored or logged in plaintext. Login
  takes the same time whether or not the email exists, so accounts cannot be discovered by timing.
- **Access tokens** are short-lived (15 min) HS256 JWTs with a pinned algorithm, issuer and
  audience. The browser keeps them in memory only, never in `localStorage`.
- **Refresh tokens** are random 256-bit values in an `httpOnly`, `SameSite=Strict` cookie scoped
  to `/api/auth`. Only an HMAC of each token is stored. Every refresh rotates the token, and
  reusing an old one revokes the whole session, which cuts off a stolen token.
- **Rate limits** (stored in Redis, shared across API instances): 10 failed sign-ins per 15 min,
  5 registrations per hour, 60 refreshes per 15 min, per client IP; 20 new workspaces per hour
  and 30 member additions per 15 min, per user.
- **Secret variables** are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`) and are
  write-only: no endpoint ever returns them, not even to owners. A database CHECK constraint
  makes it impossible to store a secret in plaintext.
- **No credentials in endpoint configuration.** Bearer tokens, basic-auth passwords, API keys and
  credential headers (`Authorization`, `Cookie`, `X-Api-Key`, …) must reference an environment
  variable such as `{{API_TOKEN}}`, so credentials only ever live in encrypted secrets.
- **SSRF protection** for every request the platform sends: private, loopback, link-local,
  cloud-metadata and internal hostnames are blocked, checked at connection time (so DNS
  rebinding cannot bypass it) and on every redirect. Secrets may only be sent to their
  environment's base URL and are masked in everything returned. See
  [architecture](docs/architecture.md#request-execution-and-ssrf-protection).
- **Authorization** is enforced by the API on every request, from one permission table shared
  with the frontend (which only uses it to hide controls). Non-members get **404**, not 403, so
  workspace ids cannot be probed. Member changes run inside a transaction that locks the
  workspace's member rows and re-checks the actor's current role, so a workspace can never be
  left without an owner, even under concurrent requests.

- **Headers:** Helmet on the API (CSP, HSTS, `nosniff`, no `x-powered-by`), and a strict
  Content-Security-Policy on the web app (no inline or third-party scripts, never framed).
- **CORS** is an allowlist of the configured frontend origin only.
- **Limits:** a per-IP backstop of 600 API requests per minute on top of the per-endpoint limits.
  JSON bodies are capped at 1 MB. Every request is answered within 45 s. Slow clients are cut off
  by Node and nginx.
- **Secrets:** configuration is validated at startup. In production the API and worker refuse to
  start with the public development secrets or a reused JWT secret.
- **Logs:** request logs are allowlisted, and every log line is deep-redacted: credentials,
  cookies, tokens and keys are masked at any depth and inside error messages.
- **Errors:** unexpected errors return a generic message; stack traces stay server-side.
- **Containers:** the API and worker run as an unprivileged user.
- No real secrets in the repository: `.env` is git-ignored and `.env.example` holds
  development-only placeholders.

Details and the tests behind each item:
[architecture → Security hardening](docs/architecture.md#security-hardening).

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
| [docs/api.md](docs/api.md)                   | REST API reference                               |
| [docs/testing.md](docs/testing.md)           | Test strategy, suites and how to run them        |

Further guides (database, monitoring, security, deployment) are added in the phases that
build those parts.
