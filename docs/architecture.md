# Architecture

TraceLayer is a pnpm monorepo with three runnable apps (frontend, backend, worker) and three
shared packages:

- `packages/db`: the database client and incident logic;
- `packages/shared`: shared types and rules;
- `packages/executor`: the SSRF-safe request executor.

PostgreSQL is the system of record. Redis carries the job queues, the worker heartbeat,
rate-limit counters and real-time fan-out.

This document covers the system as a whole and how its parts fit together. The details are in:

| Document                       | Covers                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| [monitoring.md](monitoring.md) | Monitors, scheduling, metrics and health, analytics, alerts, incidents, real-time updates, the dependency map |
| [security.md](security.md)     | Authentication, authorization, request execution and SSRF protection, security hardening                      |
| [database.md](database.md)     | The schema, relationships, constraints, indexes and migrations                                                |
| [api.md](api.md)               | Every REST route and the Socket.IO events                                                                     |
| [testing.md](testing.md)       | The test suites, end-to-end tests and CI                                                                      |
| [deployment.md](deployment.md) | Running TraceLayer in production                                                                              |

## System diagram

```text
                    ┌──────────────────────────┐
  Browser  ───────▶ │  Frontend (React + Vite) │  served by nginx in Docker
                    └────────────┬─────────────┘
                                 │  /api/*  (REST)        /socket.io/*  (WebSocket)
                                 ▼
                    ┌──────────────────────────┐
                    │   Backend (Express API)  │ ── Socket.IO server (Redis adapter)
                    │  routes → controllers →  │
                    │        services          │
                    └──────┬───────────┬───────┘
                           │           │
                 Prisma    │           │  ioredis: BullMQ producers, rate limits
                           ▼           ▼
                   ┌────────────┐ ┌────────────┐
                   │ PostgreSQL │ │   Redis    │
                   └─────▲──────┘ └─────┬──────┘
                         │              │  BullMQ queues "monitor-checks", "notifications"
                         │              ▼
                         │     ┌──────────────────┐        ┌───────────────┐
                         └──── │  Worker (BullMQ) │ ─────▶ │ External APIs │  (SSRF-protected)
                               └────────┬─────────┘        └───────────────┘
                                        │  events through Redis (Socket.IO emitter)
                                        ▼
                               Socket.IO on the backend → React dashboard
```

The spec's three flows (§55) map onto this as:

| Flow                                              | Purpose                                             |
| ------------------------------------------------- | --------------------------------------------------- |
| React → Express API → Service layer → PostgreSQL  | Every user-driven read and write                    |
| Express → Redis → BullMQ → Worker → External APIs | Scheduled and on-demand monitor checks, off the API |
| Worker → Socket.IO → React dashboard              | Live check results, incidents and health changes    |

**What each component does:**

- **React app.** The UI, a single-page app. It talks to the API over REST and listens for live
  events over one WebSocket.
- **Express API.** Authentication, authorization, validation and every read and write. It also:
  - runs the requests people send from the request builder;
  - schedules monitors;
  - pushes the incident changes people make.
- **Service layer.** Business rules, kept separate from HTTP: permission checks, the row locks
  that prevent race conditions, and database access through Prisma.
- **PostgreSQL.** Everything durable: accounts, workspaces, configuration, every monitor run,
  alerts and incidents. Metrics are computed from the runs in SQL.
- **Redis + BullMQ.** The job queues between the API and the worker, their schedules, rate-limit
  counters, the worker heartbeat, and the channel that real-time events travel on.
- **Worker.** A separate process that:
  - runs checks against external APIs, with SSRF protection;
  - stores each run and evaluates alert rules;
  - opens and resolves incidents;
  - sends notification emails;
  - publishes live events.
- **Socket.IO.** Delivers those events to every browser subscribed to the workspace, whichever
  API instance it is connected to.

## Repository layout

```text
apps/
  frontend/   React 19 + Vite 6 + Tailwind 4 SPA
  backend/    Express 5 REST API and Socket.IO server
  worker/     BullMQ worker process
  e2e/        Playwright end-to-end and accessibility tests
packages/
  db/         Prisma schema, migrations, generated client, incident lifecycle (@tracelayer/db)
  shared/     Types, Zod schemas, permissions and rules used by all apps (@tracelayer/shared)
  executor/   SSRF-safe HTTP request execution and secret encryption (@tracelayer/executor)
docker/       nginx config and security headers for the frontend container
docs/         Specification and technical documentation
.github/      CI workflow and Dependabot settings
Dockerfile    Multi-stage build: backend, worker, frontend
docker-compose.yml
```

The [README](../README.md#project-structure) shows each app's folders in more detail.

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
- Routes are split into **public** (the landing page `/welcome`, `/privacy`, `/terms`, and
  `/login`, `/register` in `AuthLayout`) and **protected**
  (everything else, in `AppLayout`, the persistent shell: top bar, collapsible sidebar, main
  content). See [Authentication](security.md#authentication) for how the guards decide.
- Signed-in routes also sit behind `RequireWorkspace`, which loads the user's workspaces and
  guarantees a current one. Users with none see the "create your first workspace" screen.
- Screens:
  - Public: the **landing page** (hero, features, how it works, a real dashboard preview, how to
    try the demo), sign-in, sign-up, privacy and terms. Signed-out visitors to `/` land on it;
    deeper links ask them to sign in.
  - Signed in: first-workspace onboarding, the **Dashboard** (home page), **Projects**,
    workspace-wide **Incidents**, **System Status** and **Workspace settings**.
  - A **project page** with tabs: Overview, Endpoints, Monitors, Analytics, Incidents, Alerts,
    Dependencies, History, Environments and Settings.
  - Endpoints, monitors, analytics and dependencies belong to a project, so they are project
    tabs rather than sidebar entries.

#### UI conventions (spec §5–7, §43–46)

- **Typography.** Inter for everything people read, including dashboard metrics (tabular digits
  keep columns aligned). JetBrains Mono only for technical values: URLs, methods, JSON, ids,
  status codes, timestamps in tables, variables.
- **States.** Every data panel has a skeleton while loading, an error with Retry, and an empty
  state that says what to do next. No blank screens.
- **Responsive.**
  - The sidebar collapses on desktop and becomes a drawer on phones.
  - Rows of badges and text wrap so titles keep a line of their own on narrow screens.
  - Wide tables scroll inside their own box.
  - The request builder's URL row wraps on phones.
  - Every page was checked at 390 px wide, and none scrolls sideways.
- **Dark mode.** Light, dark or system, persisted and applied before first paint (by
  `/theme-init.js`, a file rather than an inline script so the Content-Security-Policy can
  forbid inline scripts). Colours are tokens with a light and a dark value; text on coloured
  buttons has its own token (e.g. `--tl-fail-fg`) so contrast holds in both themes.
- **Status never relies on colour.** Health, severity, incident status, the live indicator and
  manual/inferred edges all carry text or shape as well: "Healthy ✓", "Failing ×", a dashed
  border for inferred.
- **Accessibility.**
  - Semantic landmarks and headings, a skip link, and labels for every control.
  - Dialogs trap focus and return it on close.
  - Visible focus rings.
  - Charts carry a text summary, and live notifications are announced to screen readers.
  - axe-core checks every main page in both themes in the end-to-end suite (see
    [testing](testing.md)).
- **Motion.** Only where it explains a change: dialogs, menus and notifications fade and rise
  in over 120–160 ms, skeletons pulse, the live dot pulses while connecting. Everything is
  switched off when the system asks to reduce motion.

### Backend — `apps/backend`

Layered so HTTP concerns never leak into business logic:

```text
routes/        URL → controller mapping
controllers/   parse the request, call a service, shape the response
services/      business logic; the only layer that talks to Prisma/Redis
middleware/    cross-cutting concerns: errors, requireAuth, rate limiting
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
  load balancer in production, so client IPs are correct for rate limiting.

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

- A separate Node process consuming the BullMQ queues `monitor-checks` (checks, then alert-rule
  evaluation) and `notifications` (email delivery), so slow or failing external APIs and mail
  servers can never block the HTTP server.
- Concurrency is configurable (`WORKER_CONCURRENCY`, default 10).
- **Heartbeat.** Every 10 s the worker writes the current time to the Redis key
  `tracelayer:worker:heartbeat` with a 30 s expiry. The API reads that key: if it has expired,
  the worker is reported down. No extra endpoint or port is needed on the worker.
- **Graceful shutdown.** On `SIGTERM`/`SIGINT` it stops taking jobs, waits for in-flight jobs
  to finish (hard exit after 15 s), removes its heartbeat and closes its connections.
- See _Monitoring engine_ and _Alerts and notifications_ for what the jobs do.

### Database — PostgreSQL + Prisma (`packages/db`)

- PostgreSQL 16 is the system of record. Prisma 6 provides the schema, migrations and a typed
  client, published inside the monorepo as `@tracelayer/db` and shared by the backend and worker.
- Models are added phase by phase, each with its own migration. Current tables: `users`,
  `refresh_tokens`, `workspaces`, `workspace_members` (role is the Postgres enum
  `workspace_role`), `projects`, `environments`, `environment_variables`, `endpoints` (method
  is the enum `http_method`), `request_history`, `monitors` (type is the enum `monitor_type`) and
  `monitor_runs`. Tables and columns use snake_case (`@@map`/`@map`); ids are UUIDs and
  timestamps are `timestamptz`.
- The backend container runs `prisma migrate deploy` before starting, so a fresh
  `docker compose up` always has an up-to-date schema. The worker waits for the backend to
  become healthy, which guarantees migrations have run first.

### Redis

- Redis 7 in append-only mode with `maxmemory-policy noeviction`: BullMQ stores jobs in Redis,
  and an evicting policy could silently drop queued work.
- Uses: the BullMQ queues (monitor checks and notifications) and their schedulers, the worker
  heartbeat, rate-limit counters, and Socket.IO event fan-out between the worker and every API
  instance.

### Shared package — `packages/shared`

Types, constants and validation schemas every app agrees on: the API envelope types,
`HealthReport`, HTTP methods, workspace roles (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`), queue and
Redis key names, and the Zod schemas for sign-in and sign-up. The backend validates requests
with the same schemas the frontend forms use, so the two can never disagree on the rules.

## Projects, environments and secrets

A workspace holds up to 50 **projects**; each project holds up to 10 **environments** (created
with Development, Staging and Production), and each environment up to 50 **variables**.
Project and environment names are unique within their parent, compared case-insensitively.
Owners and admins manage all of them (`projects.manage`). Every member can read them, except
secret values, which nobody can read.

**Consistency under concurrency.** Unique indexes cannot express "case-insensitive" or "at most
N children". So creates and renames first lock the parent row (`lib/locks.ts`,
`SELECT … FOR UPDATE` on the workspace, project or environment), then check names and limits,
then write, all in one transaction. Two simultaneous requests cannot both pass the checks.

**Access checks for nested resources.** `authorizeProject()` finds the project's workspace and
applies the workspace permission table. Anyone outside the workspace gets "Project not found".
Environments and variables are always looked up _through_ the authorized project
(`WHERE id = … AND project_id = …`). An id from another project therefore returns 404, even if
the caller can see that other project.

**Base URLs** are validated when saved: http or https only, no embedded credentials, no query
string or fragment, normalised without a trailing slash. Saving a URL is not the same as being
allowed to call it: blocking private and internal addresses (SSRF protection) happens when a
request is actually made (see [security](security.md#request-execution-and-ssrf-protection)).

**Secret variables.**

- Encrypted with AES-256-GCM (`utils/secret-box.ts`) using `ENCRYPTION_KEY`, with a random IV
  per value. The authentication tag makes tampering detectable: a modified ciphertext fails to
  decrypt instead of producing garbage. Stored as `v1.<iv>.<tag>.<ciphertext>`; the version
  prefix allows key rotation later.
- **Write-only.** API responses carry `value: null` for secrets, and the frontend never
  receives a secret's value. Editing a secret without typing a new value keeps it. Turning a
  secret back into a plain variable requires a new value, so the old one is never revealed.
- A database CHECK constraint (`environment_variables_value_matches_secret_flag`) requires
  secrets to have only `encrypted_value` and plain variables only `value`. A bug elsewhere
  therefore cannot store a secret in plaintext.
- Changing `ENCRYPTION_KEY` makes existing secrets unreadable; keep it stable.
- Secrets are decrypted only on the server, when a request is executed by the API or a check by
  the worker.

**Frontend.** `ProjectLayout` loads the project for `/projects/:projectId/*` and shares it with
its tabs. Opening a project that belongs to another of the user's workspaces switches to that
workspace. Switching workspace while viewing a project returns to the new workspace's project
list. Tabs are added only when their feature exists: Endpoints, Monitors, Analytics, Incidents
and Dependencies join in later phases.

## Endpoints

An endpoint is a saved API request belonging to a project (up to 200 per project, names unique
per project ignoring case). Owners, admins **and members** manage endpoints
(`monitoring.manage`); viewers can only read them.

**Storage.** Scalar fields are columns (`name`, `method` as the `http_method` enum, `url`,
`timeout_ms`, `expected_status`, `tags` as `varchar[]`). The structured parts (`headers`,
`query_params`, `body`, `auth`) are JSONB, validated by the shared Zod schemas
(`packages/shared/src/endpoint.ts`) on every write _and_ every read. A stored row that fails
validation on read is reported as a 500 and logged. It is never sent to the client, and never
blamed on the client with a 400.

**Variables.** URL, header and parameter values, bodies and auth fields may reference
environment variables as `{{NAME}}`. They are substituted when a request runs, with the
environment chosen then. Each endpoint has an optional _default_ environment, cleared if that
environment is deleted. A URL is either a path relative to the environment's base URL
(`/orders/{{ID}}`), a URL that starts with a variable (`{{GATEWAY}}/orders`) or an absolute
`http(s)` URL. Query strings go in `queryParams`, never in the URL. JSON bodies are syntax-checked
with every `{{VAR}}` replaced by a placeholder, so `{"qty": {{QTY}}}` is accepted.

**Credentials are never stored on endpoints.** Endpoint configuration is readable by every
workspace member, so:

- `auth` credential fields (bearer token, basic-auth password, API key value) must be exactly
  one variable reference, e.g. `{{API_TOKEN}}`;
- headers that carry credentials (`Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`,
  `Api-Key`, `X-Auth-Token`, `X-Access-Token`) must contain a variable reference.

The actual values then live in secret environment variables: encrypted, write-only, and able to
differ per environment (for example a staging token and a production token).

**Cross-field rules.** GET and HEAD cannot have a body. A `PATCH` is merged into the stored
configuration and the _complete_ result is validated, so a rule cannot be dodged by splitting the
change across requests (e.g. adding a body, then switching the method to GET).

**Frontend.** The editor (`components/endpoints/EndpointForm.tsx`) has a request line (method and
URL, with the resolved URL for the default environment) and tabs for Params, Headers, Auth, Body
and Settings. Tabs follow the WAI-ARIA pattern: arrow keys switch between them, and a tab
containing errors is marked. A panel lists the variables the request uses and warns about any
missing from the default environment. It works on unfinished input too. For viewers the whole
form is a disabled `fieldset`.

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
| `mailpit`  | `axllent/mailpit`              | `8025`        | Local SMTP sink; web inbox for alert emails      |
| `frontend` | `Dockerfile` target `frontend` | `8080` → 80   | nginx: static SPA + reverse proxy to the backend |

The Postgres host port defaults to `5434` so it does not clash with a locally installed
PostgreSQL on 5432/5433.

The `Dockerfile` is one multi-stage build: a shared dependency stage installs the whole workspace
once (with a pnpm store cache mount), then separate stages compile the server apps and the
frontend. The API and worker images run as the unprivileged `node` user (see _Security
hardening_).
