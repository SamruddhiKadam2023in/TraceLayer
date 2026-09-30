# Architecture

TraceLayer is a pnpm monorepo with three runnable apps (frontend, backend, worker) and two shared
packages (database client, shared types). PostgreSQL is the system of record; Redis carries the job
queue, the worker heartbeat, rate-limit counters and, later, real-time fan-out.

> **Status:** this document covers Phases 1–9 (foundation, authentication, workspaces, projects, endpoints, request
> execution, monitoring, metrics, analytics). Sections marked _(planned)_ describe
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
- Routes are split into **public** (`/login`, `/register`, in `AuthLayout`) and **protected**
  (everything else, in `AppLayout`, the persistent shell: top bar, collapsible sidebar, main
  content). See [Authentication](#authentication) for how the guards decide.
- Signed-in routes also sit behind `RequireWorkspace`, which loads the user's workspaces and
  guarantees a current one. Users with none see the "create your first workspace" screen.
- Screens so far: sign-in, sign-up, first-workspace onboarding, **Projects** (list and create),
  the **Dashboard** (home page), a **project page** with Overview, Endpoints, Monitors,
  Analytics, History, Environments and Settings tabs, the **endpoint
  editor**, **System Status** (the live
  `/api/health` report) and **Workspace settings** (rename, members, leave, delete). The top
  bar holds the workspace switcher. Sidebar entries are added as each feature is built, so there
  are no placeholder pages.

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
- Current uses: the BullMQ queue, the worker heartbeat and the auth rate-limit counters. Planned:
  scheduled (repeatable) monitor jobs (Phase 7) and Socket.IO event fan-out (Phase 12).

### Shared package — `packages/shared`

Types, constants and validation schemas every app agrees on: the API envelope types,
`HealthReport`, HTTP methods, workspace roles (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`), queue and
Redis key names, and the Zod schemas for sign-in and sign-up. The backend validates requests
with the same schemas the frontend forms use, so the two can never disagree on the rules.

## Authentication

```text
 Browser                                   API                              PostgreSQL
 ───────                                   ───                              ──────────
 POST /auth/login {email, password} ──▶  bcrypt.compare ──────────────────▶ users
                                          issue refresh token ────────────▶ refresh_tokens (HMAC only)
 ◀── { user, accessToken (15 min) } + Set-Cookie: tl_refresh (httpOnly, 7 days)

 GET /api/… Authorization: Bearer <access> ──▶ requireAuth verifies JWT (no DB lookup)
 ◀── 401 when expired
 POST /auth/refresh (cookie sent automatically) ──▶ rotate: revoke old row, insert new row
 ◀── new accessToken + new cookie; the original request is retried
```

**Access token.** An HS256 JWT signed with `JWT_SECRET`, containing only the user id (`sub`),
issuer, audience and expiry. Verification pins the algorithm, which rejects `alg: none` and
algorithm-confusion tokens. It is stateless, so protected routes need no database lookup. The
browser keeps it in memory (Zustand) only: nothing in `localStorage` for an injected script to
read, at the cost of one refresh call per page load.

**Refresh token.** 32 random bytes, sent only as the `tl_refresh` cookie:

- `HttpOnly`: page scripts cannot read it.
- `SameSite=Strict`: browsers never attach it to cross-site requests. This is the CSRF defence
  for the two cookie-authenticated endpoints, refresh and logout.
- `Path=/api/auth`: it is not sent with ordinary API calls.
- `Secure` in production (`COOKIE_SECURE`; off for the plain-HTTP local Docker stack).

The database stores `HMAC-SHA256(JWT_REFRESH_SECRET, token)`, never the token, so a database
leak alone is not enough to present a valid token.

**Rotation and theft detection.** Each login starts a token _family_. Every refresh revokes the
presented token and issues a new one in the same family, inside a transaction whose conditional
update lets exactly one of two concurrent refreshes win. Presenting a token that was already
revoked means two parties hold the same token, so one of them stole it. The API then revokes
the whole family, signing out both the attacker and the victim, who simply signs in again.
Logout revokes the current family only, so other devices stay signed in.

**Passwords.** bcrypt with a configurable cost (`BCRYPT_ROUNDS`, default 12). Passwords are
limited to 72 bytes because bcrypt silently ignores anything longer. For an unknown email,
login still runs a bcrypt comparison against a dummy hash, so response time does not reveal
whether an account exists; the error message is identical too.

**Rate limiting.** `express-rate-limit` with a small Redis store
(`middleware/rate-limit.ts`): `INCR` plus `PEXPIRE NX` in one `MULTI`, so counters are shared
by every API instance. Failed logins, registrations and refreshes are limited per client IP. If
Redis is unreachable the limiter fails open and logs the error: availability wins over
throttling.

**Frontend flow.**

1. On page load, `RootLayout` calls `/auth/refresh`. Until it answers, protected routes show a
   loader instead of flashing the sign-in page.
2. `RequireAuth` sends signed-out users to `/login`, remembering the requested page.
   `RedirectIfAuthenticated` sends them back there after sign-in. Only same-app paths are
   accepted, to prevent open redirects.
3. The axios client adds the bearer token to every request. On a 401 it refreshes once and
   replays the request. Concurrent 401s share a single refresh call. Across browser tabs, the Web
   Locks API makes refreshes take turns: two tabs refreshing with the same cookie at once would
   otherwise look like token theft.

## Authorization

Every workspace-scoped action is checked on the server against one permission table in
`@tracelayer/shared` (`PERMISSIONS`):

| Permission          | Owner | Admin | Member | Viewer |
| ------------------- | :---: | :---: | :----: | :----: |
| `workspace.read`    |   ✓   |   ✓   |   ✓    |   ✓    |
| `workspace.update`  |   ✓   |       |        |        |
| `workspace.delete`  |   ✓   |       |        |        |
| `members.manage`    |   ✓   |   ✓   |        |        |
| `projects.manage`   |   ✓   |   ✓   |        |        |
| `monitoring.manage` |   ✓   |   ✓   |   ✓    |        |

(`projects.manage` and `monitoring.manage` are defined now and enforced from Phases 4–7.)

Rules beyond the table:

- Only owners can make someone an owner, or change or remove an owner. Admins manage everyone else.
- Any member can leave. A workspace always keeps at least one owner: the last owner cannot be
  demoted, removed or leave, and must promote someone or delete the workspace instead.
- Non-members get **404** for a workspace, never 403, so ids cannot be probed for existence.
  Malformed ids also return 404.

How it is enforced:

- `requireWorkspace(permission)` middleware (`middleware/workspace-access.ts`) resolves the
  caller's membership for `:workspaceId` and rejects with 404 or 403. It is built on
  `authorizeWorkspace()` in `services/access.service.ts`, which later phases reuse for
  resources that belong to a workspace (projects, endpoints, monitors).
- Member mutations (`services/member.service.ts`) run in a transaction that first locks every
  member row of the workspace (`SELECT … FOR UPDATE`) and then checks permissions against those
  locked rows. Concurrent changes to one workspace's members are serialized, and each sees the
  others' results. For example, if two owners demote each other at the same moment, one
  succeeds; the other then finds it is no longer an owner and is refused. An integration test
  forces exactly this race and fails if the lock is removed.
- The frontend imports the same table (`hasPermission`, `assignableRoles`, `canManageMember`)
  purely to hide controls the user cannot use.

**Workspace selection** lives in the client (`stores/workspace.store.ts`). The current
workspace id is persisted in `localStorage`, and a remembered id the user can no longer access
falls back to their first workspace. The store is cleared on sign-out, so a shared browser never
shows one user's workspaces to the next.

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
request is actually made, in Phase 7.

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
- Secrets are decrypted only on the server, when the worker executes requests (Phase 7).

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
environment variables as `{{NAME}}`. They are substituted when a request runs (Phase 6), with
the environment chosen then. Each endpoint has an optional _default_ environment, cleared if that
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

## Request execution and SSRF protection

The platform sends HTTP requests to URLs that users choose, which makes **server-side request
forgery (SSRF)** its biggest security risk: without protection, anyone who can edit an endpoint
could make the server fetch `http://169.254.169.254/` (cloud credentials), `http://postgres:5432`
or anything else on the internal network.

All execution goes through `@tracelayer/executor` (`packages/executor`). The API uses it for
manual requests now, and the worker will use the same code for scheduled monitors (Phase 7).

```text
endpoint config + environment ──▶ prepareRequest ──▶ executeRequest ──▶ ExecutionResult
   ({{VARS}}, relative URL)        substitute vars     SSRF-checked        secrets masked
                                   build auth/body     HTTP via undici     errors classified
                                   secret-origin rule  limits, redirects
```

**1. Preparation** (`prepare.ts`)

- Substitutes `{{VARIABLES}}` from the chosen environment. Secrets are decrypted only here, on
  the server. Every missing variable is reported at once (`400`), and nothing is sent.
- Relative paths are joined to the environment's base URL. Query parameters, bearer, basic or
  API-key auth, bodies and default headers (`Content-Type`, `User-Agent`) are added.
- Header values containing line breaks are refused, which prevents header injection through a
  variable.
- **Secret-origin rule.** A request that uses any secret variable may only go to the
  environment's base-URL origin (scheme, host and port). Only owners and admins can change base
  URLs, so a member cannot send `{{API_TOKEN}}` to a server they control, and a secret cannot be
  downgraded to plain `http`.

**2. SSRF protection** (`ssrf.ts`)

- Only `http` and `https` are allowed.
- `localhost`, `*.localhost`, `*.local`, `*.internal`, `metadata.google.internal` and hostnames
  without a dot (Docker service names such as `postgres`) are refused.
- Every address is checked against private, loopback, link-local (including `169.254.169.254`),
  CGNAT, documentation, multicast and reserved ranges, for IPv4 and IPv6. IPv4-mapped
  (`::ffff:127.0.0.1`) and NAT64 addresses are unwrapped first. URL tricks such as
  `http://0x7f.1/` or `http://2130706433/` normalise to `127.0.0.1` and are caught.
- **The check happens at connection time.** The HTTP client's socket uses a custom DNS lookup
  that rejects the connection if _any_ resolved address is internal. The address that is
  validated is the one that is dialled, so DNS rebinding (a public answer at check time, a private
  one at connect time) cannot bypass it. IP literals skip DNS and are checked before connecting.
- **Redirects** are followed manually, at most 5, and each hop is checked again:
  - Credentials (`Authorization`, `Cookie`, the API-key header) are dropped on a cross-origin
    hop, as browsers do.
  - A request that uses secrets does not follow a cross-origin redirect at all.
  - 303 (and 301/302 after a POST) switch to GET without a body.
- `ALLOW_PRIVATE_NETWORK_TARGETS=true` turns the address checks off, for local development
  against APIs on your own machine only. It defaults to `false`, including in Docker Compose.

**3. Limits and results** (`execute.ts`)

- One deadline (the endpoint's `timeoutMs`, at most 30 s) covers all redirects and reading the
  body.
- Response bodies are decompressed (gzip, deflate, br) and capped at **1 MB of decoded
  bytes**, which also defuses compression bombs. Binary bodies are measured but not returned.
- **Masking.** Secret values are masked (`••••••`) in everything returned: the sent URL and
  headers, response headers and body (an API might echo a token back), and error messages. The
  raw, URL-encoded, form-encoded and Basic-auth base64 forms are all masked.
- Network outcomes are _results_, not API errors: `BLOCKED_TARGET`, `TIMEOUT`, `DNS_FAILURE`,
  `CONNECTION_REFUSED`, `CONNECTION_RESET`, `TLS_ERROR`, `INVALID_RESPONSE`, `REQUEST_FAILED`.
  They are shown to the user and stored in history like any response.

**Permissions.** Running a request needs `monitoring.manage` (owner, admin or member). Viewers
cannot run requests, because doing so uses the environment's secrets. History is readable by
every member.

**History.** Each run is stored in `request_history`: method, final URL with secrets masked,
status or error code, duration, size, endpoint, environment and user. Bodies are never stored.
The newest 5,000 entries per project are kept. The list supports filters (method, status class,
endpoint, environment, date range, URL search), sorting (time, duration, status) with stable
tie-breakers, and pagination.

**Frontend.** The endpoint editor doubles as the request builder: **Send** runs the form as it is
now, including unsaved edits, in the environment chosen next to it. The response viewer shows
status, time, size and timestamp, a pretty-printed, syntax-highlighted JSON body (with a raw
view and copy), response headers, and the request as actually sent (secrets masked). The JSON
viewer is a small built-in tokenizer rather than Monaco, which would add several megabytes for
read-only display. The History tab keeps its filters in the URL, so a filtered view can be
shared.

## Monitoring engine

A **monitor** runs one endpoint in one environment on a schedule and records every result.
Owners, admins and members manage monitors (`monitoring.manage`); viewers can read them.

```text
 API (save monitor) ──▶ monitors table ◀──────────── reconcile (every 5 min + on start)
        │                                                   │
        └─▶ BullMQ job scheduler "monitor:<id>" ◀───────────┘
                     │ every N seconds (Redis)
                     ▼
              queue "monitor-checks" ──▶ worker ──▶ executor (SSRF-safe HTTP)
                                            │
                                            ├─▶ evaluate (monitor type)
                                            └─▶ monitor_runs + monitor's cached last result
```

**Types** (the evaluation logic is `evaluateCheck` in `packages/shared/src/monitor.ts`, a pure,
deterministic function):

| Type                | Passes when                                                                           |
| ------------------- | ------------------------------------------------------------------------------------- |
| Availability        | A response arrives with a status below 500                                            |
| Status              | The status equals the expected one (the monitor's, else the endpoint's, else any 2xx) |
| Performance         | The status check passes **and** the duration is at most the threshold                 |
| Response validation | The status check passes **and** every JSON check holds                                |

JSON checks use dot paths (`data.items.0.id`) with `equals`, `notEquals`, `exists`,
`notExists` or `contains`. Values are compared as JSON, deeply for objects and arrays. A failed
check stores a `failureReason` (`UNEXPECTED_STATUS`, `SERVER_ERROR`, `LATENCY_EXCEEDED`,
`ASSERTION_FAILED`, `CONFIG_ERROR`, or the network codes `TIMEOUT`, `BLOCKED_TARGET`, …) and a
human-readable `failureMessage`, such as "Expected 200, received 500".

**Scheduling: Redis and BullMQ, no `setInterval`.**

- Each enabled monitor has one BullMQ _job scheduler_ (`monitor:<id>`, repeating every
  `intervalSeconds`: 1, 5, 10, 15, 30 or 60 minutes). It lives in Redis, so it survives worker
  restarts, and several workers can share the queue.
- The API creates, updates or removes a monitor's scheduler whenever the monitor is saved,
  paused or deleted. It also removes the schedulers of monitors deleted by cascade (their
  endpoint, project or workspace was deleted).
- The **monitors table is the source of truth.** On start and every 5 minutes the worker
  reconciles BullMQ against it: missing schedulers are added (for example after a save while
  Redis was down), intervals that drifted are fixed, and schedulers without an enabled monitor
  are removed. Reconciling is idempotent.
- A job carries only `{ monitorId }`. The worker loads the _current_ configuration when the job
  runs, so edits apply from the next run on. A job for a deleted monitor is skipped, and so is a
  scheduled job for a paused one. **Run now** queues a one-off job marked `manual`, which runs
  even when the monitor is paused.
- Checks are never retried (`attempts: 1`): a failure is a result to record, not a job to redo.

**The worker** (`apps/worker`, spec §19):

1. Receives the job and loads the monitor, endpoint and environment.
2. Decrypts secret variables, using the same `SecretBox` code and `ENCRYPTION_KEY` as the API.
3. Builds the request with the monitor's own timeout.
4. Runs it through `@tracelayer/executor`: SSRF protection, the secret-origin rule, limits, and
   timing, status, size, timeout and connection-failure detection. This is the same code as
   the request builder.
5. Evaluates the result for the monitor type.
6. Stores a `monitor_runs` row and updates the monitor's cached `lastRunAt`, `lastRunSuccess`
   and `consecutiveFailures` in one transaction. The failure counter uses an atomic increment.

Alert rules, incidents and real-time updates (§19 steps 13–15) plug in after step 6 in
Phases 10–12.

**Configuration errors surface early.** When a monitor is saved, the API test-prepares its
request (variables defined, base URL set, secrets allowed) and refuses the save with the reason.
If the setup breaks later (the endpoint changed, or the environment was deleted), each run is
recorded as `CONFIG_ERROR` with the reason, and nothing is sent.

**Data.** `monitor_runs` stores everything spec §20 lists: timestamp, status code, response
time, response size, success, failure reason, timeout, and the monitor, endpoint and environment
ids (copied onto the run, so metrics need no joins). It is indexed by
`(monitor_id, started_at DESC)` and `(project_id, started_at DESC)` for the time-series queries
of Phases 8–9. A daily maintenance job (03:17 UTC) deletes runs older than **30 days**.

**Limits.** Up to 50 monitors per project, intervals of at least 1 minute, and timeouts of at
most 30 s. Creating monitors is rate-limited to 60 per hour per user, and manual runs to 30 per
minute per user.

## Metrics and health

Every number comes from `monitor_runs` at query time. There are no counters or cached
aggregates that could drift from the raw data. The calculations run in PostgreSQL
(`apps/backend/src/services/metrics.service.ts`), so they cost the same whether a window holds
ten runs or forty thousand.

| Metric                      | Definition                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Total / successful / failed | Runs in the window, by the run's `success` (its monitor type's verdict)                                                |
| Uptime                      | `successful / total × 100`, two decimals; **null** when there were no runs                                             |
| Error rate                  | `failed / total × 100`; null when there were no runs                                                                   |
| Avg / min / max latency     | Over runs **that received a response**                                                                                 |
| P50 / P95 / P99             | `percentile_cont` over the same runs (linear interpolation between ranks)                                              |
| Status distribution         | Runs by 2xx / 3xx / 4xx / 5xx, plus _no response_ (timeouts, connection errors, blocked targets, configuration errors) |

**Why latency excludes timeouts.** A timed-out run's duration is just the timeout. Including it
would put the timeout value into the percentiles. For example, one 5 s timeout among responses
around 300 ms turns a 301 ms average into 889 ms, a case the tests cover. Timeouts still count
fully in uptime, error rate and the status distribution.

**No fake numbers.** With no runs, uptime, error rate and latency are `null` (shown as "—"),
never 0 % or 100 %.

**Time ranges and buckets.** Series cover fixed windows ending now:

| Range | Bucket | Points |
| ----- | ------ | ------ |
| 1h    | 1 min  | ~60    |
| 6h    | 5 min  | ~72    |
| 24h   | 15 min | ~96    |
| 7d    | 1 h    | ~168   |
| 30d   | 6 h    | ~120   |

Buckets are aligned with `date_bin`, and every bucket in the window is returned (built with
`generate_series`, left-joined with runs). An empty bucket has volume 0 and latency `null`, so
charts show a gap instead of joining the points either side of it.

**Filters.** Every metrics endpoint is scoped to one project the caller can read, and can be
narrowed to a monitor, endpoint or environment. The queries use the
`(project_id, started_at DESC)` and `(monitor_id, started_at DESC)` indexes on `monitor_runs`.

**Health status (spec §24)** is computed, never set by hand. `computeHealth` in
`packages/shared/src/metrics.ts` looks at a monitor's **latest 10 runs**:

- **Failing:** the 3 most recent runs all failed, or at least half of the 10 failed.
- **Degraded:** any other failure among the 10 (intermittent problems).
- **Healthy:** none of the 10 failed.
- **No data:** the monitor has not run yet.

The latest runs for a whole list of monitors are fetched in one query (`row_number()` per
monitor). The same function drives the badges in the UI, `health` on every monitor, and the
health counts in `GET /api/metrics`. The UI shows health with an icon and a word
(Healthy ✓, Degraded !, Failing ×), not by colour alone.

## Analytics dashboard

One component, `AnalyticsView` (`apps/frontend/src/components/analytics`), renders analytics for
any scope. It appears in four places:

| Where                          | Scope                   | Shows                                            |
| ------------------------------ | ----------------------- | ------------------------------------------------ |
| **Dashboard** (`/`, home page) | the current workspace   | everything, with the project on each monitor row |
| Project → **Analytics** tab    | one project             | everything                                       |
| Endpoint page → Analytics      | one endpoint (spec §23) | everything, limited to its monitors              |
| Monitor page                   | one monitor             | cards and charts (no monitor table)              |

**Contents** (spec §21–22):

- **Metric cards:** uptime, checks (and failures), error rate, average, P95, P99, and either
  the monitor count (with how many are failing) or P50.
- **Charts** (Recharts):
  - latency over time (average, P95, P99);
  - error rate over time;
  - request volume (passed/failed stacked bars);
  - status codes (a donut with counts in the legend).
- **Monitor health:** counts per state and a table with uptime, error rate, average and P95 per
  monitor, linking to each monitor.
- A **range picker** (1h, 6h, 24h, 7d, 30d) refetches every panel.

All data comes from the metrics API (see _Metrics and health_). On the dashboard the scope is
`workspaceId`, and the API aggregates every project in the workspace. Nothing is hard-coded or
sampled.

**States (spec §43).**

- Every panel loads independently, with a skeleton while loading.
- A failed panel shows the error and a Retry button, and the other panels still show their data.
- An empty period says so ("No responses in this period.") rather than drawing an empty chart.
- A scope with no monitors shows "No monitors configured yet" with a link to create one.

**Accessibility and theming.**

- Each chart is a `figure` with `role="img"` and a one-sentence text summary of its data, e.g.
  "Latency last 24 hours: average 184 ms, P95 641 ms, P99 1.20 s", read by screen readers in
  place of the picture.
- Health uses icon plus text badges.
- Chart colours are read from the theme's CSS variables (`useChartColors`) and re-read when
  the light/dark class on `<html>` changes, so charts follow the theme.
- Time axes show clock time for ranges up to 24 hours and dates beyond that.
- Empty buckets stay gaps: lines are not joined across periods without data.

**Bundle size.** Recharts is the largest dependency. `LazyAnalyticsView` loads the analytics code
on demand, so it is not part of the initial download (sign-in, projects, settings). Vite's
`manualChunks` puts React/React Router and the form libraries in separate long-cached files.
This cut the initial JavaScript from one 1.1 MB file to about 667 KB (205 KB gzipped). The
charts file (about 445 KB) is fetched the first time a page with charts opens.

## Alerts and notifications

An **alert rule** watches one monitor. It says "IF a metric crosses a threshold (FOR a duration)
THEN raise an alert of this severity and notify these channels" (spec §25–28).

**Metrics.** A rule measures one of six things:

| Metric                 | Fires when                                                             | Duration means                                  |
| ---------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| `LATENCY_P95`          | P95 latency > threshold (ms)                                           | the window measured, e.g. "over the last 5 min" |
| `ERROR_RATE`           | error rate > threshold (%)                                             | the window measured                             |
| `UPTIME`               | uptime < threshold (%)                                                 | the window measured                             |
| `STATUS_CODE`          | the latest check returned exactly this code                            | how long it must persist (0 = at once)          |
| `RESPONSE_TIME`        | the latest check took > threshold (ms); no response counts as too slow | how long it must persist                        |
| `CONSECUTIVE_FAILURES` | more than N checks in a row failed                                     | not used                                        |

Thresholds are range-checked per metric (for example 0–100 for percentages, 100–599 for status
codes). The rules live in `packages/shared/src/alert.ts`, so the form and the API validate
the same way.

**Evaluation.** The worker evaluates a monitor's enabled rules right after storing each check
result, in one transaction (`apps/worker/src/alerts/evaluate-rules.ts`):

1. The rule rows are locked (`SELECT … FOR UPDATE`), so two checks of the same monitor finishing
   together (a scheduled run and a manual "Run now") cannot both fire the same alert. A test
   forces this overlap and fails without the lock.
2. Window statistics are computed in SQL with the same rules as the metrics API (latency only
   from runs that got a response), once per distinct window length.
3. The pure functions `checkCondition` and `nextRuleState` decide the new state:
   - `OK` → `FIRING` when the condition is breached. Sustained metrics go through `PENDING`
     first and fire only once the breach has lasted `durationMinutes`.
   - `FIRING` → `OK` as soon as the condition clears. The open alert is marked resolved.
   - No data in the window (for example a paused monitor) changes nothing.
4. A transition to `FIRING` creates an `Alert` row. A transition back resolves it. At most one
   alert per rule is open at a time.

Editing a rule's condition, disabling it or deleting it resolves its open alert and resets the
rule to `OK`, so an alert never stays open against a condition that no longer exists. Alerts of
a deleted rule are kept (with `ruleId` set to null) as history.

**Notifications.** Every fired or resolved alert creates one `Notification` row per enabled
channel of the rule, and a job on the BullMQ `notifications` queue per row.

- A second worker (concurrency 5) delivers the jobs through a channel adapter registry. Only
  email exists for now (nodemailer). Other channel types can be added as adapters.
- Delivery is retried 5 times with exponential backoff (30 s, 1 min, 2 min, 4 min). Each attempt
  updates the row: `SENT`, `PENDING` with the error while retries remain, then `FAILED`.
- The workspace settings page shows each channel's last delivery status, and **Send test**
  queues a `TEST` notification.
- Messages are rendered as text and HTML (all values escaped) and link back to the monitor via
  `APP_URL`.
- With `SMTP_HOST` empty, the worker logs emails instead of sending them. The Docker stack
  points it at the bundled **Mailpit** (http://localhost:8025), which catches every email.

**Permissions.** Everyone in the workspace can see rules, alerts and channels. Creating or
editing rules needs `monitoring.manage` (owner, admin, member). Channels hold email addresses of
people, so managing them needs `members.manage` (owner, admin). A rule may only notify channels
of its own workspace. Limits: 20 rules per monitor, 20 channels per workspace, 20 recipients and
10 channels per rule.

**Frontend.**

- Each monitor page has an **Alert rules** section with state (OK, Pending, Firing, Disabled),
  severity, the condition in words and the last observed value. The create/edit dialog previews
  the condition ("Fires when error rate > 5% over 10 min").
- Each project has an **Alerts** tab listing fired alerts, open ones first.
- Workspace settings has a **Notifications** section for email channels.

## Incidents

An **incident** groups the alerts of one monitor into one problem that people work on (spec
§26–27). Incidents are numbered per project (#1, #2, …) from a counter on the project row.

**Lifecycle.** The code lives in `packages/db/src/incidents.ts`, shared by the worker and the
API:

- **Opened by an alert.** When a rule fires, the worker (in the same transaction as the alert)
  either joins the monitor's active incident or opens a new one.
  - The new incident takes the alert's severity and a title such as
    "Orders health: Error rate 8.7% > 5% over 5 min".
  - A more severe alert joining later raises the incident's severity.
- **Worked on by people.** Status moves between `OPEN`, `ACKNOWLEDGED`, `INVESTIGATING`,
  `IDENTIFIED` and `RESOLVED` in any order. Setting `RESOLVED` resolves the incident manually,
  and leaving `RESOLVED` reopens it. The first move away from `OPEN` records the
  acknowledgement time. Incidents can be assigned to workspace members who can work on them
  (owners, admins and members, not viewers).
- **Resolved automatically.** When the monitor recovers and the incident's last firing alert
  resolves, the incident resolves with no `resolvedBy`, and the timeline says it resolved
  automatically.
- **Rule changes don't resolve.** When a person changes, disables or deletes a rule, its open
  alert closes, but the incident stays open. The rule change doesn't show that the problem went
  away, so a person resolves the incident. The timeline notes why the alert closed.
- **Manual resolution sticks.** An incident a person resolved stays resolved. A later recovery
  is only noted on its timeline. A new failure after that opens a new incident.

**Timeline.** Every step is an `IncidentEvent`:

| Event                                       | Written by             |
| ------------------------------------------- | ---------------------- |
| `DETECTED`, `ALERT_FIRED`, `ALERT_RESOLVED` | TraceLayer             |
| `STATUS_CHANGED`, `SEVERITY_CHANGED`        | TraceLayer or a person |
| `ASSIGNED`                                  | a person               |
| `COMMENT`                                   | a person               |

The actor is null for events TraceLayer records. Events written in one step share a timestamp
and are ordered by type, so the timeline always reads in the order things happened.

**Concurrency.** Every change locks the incident row (`SELECT … FOR UPDATE`), always after any
alert-rule locks, so the lock order is the same everywhere:

- The worker takes the monitor's rule locks, which serialize two checks of one monitor, so
  they cannot open two incidents. A test forces this race and fails without the lock.
- The incident lock serializes a person's changes with the worker's automatic resolution. A
  person resolving at the same moment the monitor recovers gives one resolution, not two. A
  test holds the lock to force this ordering and fails without it.
- A database `CHECK` constraint keeps `status = RESOLVED` and `resolved_at` consistent.

**History.** Deleting a monitor keeps its incidents (with `monitorId` set to null). Deleting a
user keeps their timeline entries without the name.

**Frontend.**

- Each project has an **Incidents** tab with filters stored in the URL (active, a specific
  status or all; severity; "Assigned to me") and paging.
- The **incident page** shows status, severity, monitor, assignee, acknowledgement and
  resolution, the linked alerts and the timeline. People who can work on incidents get
  Acknowledge, Resolve/Reopen, status, severity and assignee controls, and a comment box.
- The **dashboard** lists the workspace's five newest active incidents.
- The **Alerts** tab links each alert to its incident.

## Real-time updates

Monitors, incidents and the dashboard update in the browser as things happen, without a manual
refresh (spec §29), using Socket.IO.

```text
Worker ──(Redis pub/sub, @socket.io/redis-emitter)──┐
                                                    ▼
API ──(publish)──▶ Socket.IO server + Redis adapter ──▶ browsers in room workspace:<id>
```

**Transport.**

- The worker never connects to the API. It publishes through Redis with
  `@socket.io/redis-emitter`.
- The API's Socket.IO server uses the matching `@socket.io/redis-adapter`, keyed
  `<QUEUE_PREFIX>:socket.io`. Every API instance delivers to its own connected browsers.
- The API publishes the incident changes people make directly.
- nginx and the Vite dev server proxy `/socket.io` (WebSocket upgrade) to the API, so the
  browser keeps one origin.

**Events.** Every event is sent to one workspace's room:

| Event                    | When                                                                                                                          | Sent by       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `monitor.checked`        | After every completed check. Carries the run, and the monitor's health before and after                                       | Worker        |
| `monitor.failed`         | A check failed after one that passed, or the first check failed. Only on the change, so a monitor that stays down stays quiet | Worker        |
| `monitor.recovered`      | A check passed after one that failed                                                                                          | Worker        |
| `monitor.status_changed` | The health (latest 10 runs, same rule as the metrics API) changed                                                             | Worker        |
| `incident.created`       | An alert opened an incident                                                                                                   | Worker        |
| `incident.updated`       | See the `change` list below                                                                                                   | Worker or API |

`incident.updated` carries a `change` field:

- From the worker: `alert_added` or `resolved_automatically`.
- From the API: `status`, `severity`, `assignee`, `comment`, or `alert_closed` (a rule was
  changed or deleted).

Incident payloads include the actor, or `null` when TraceLayer made the change itself. Payload
types live in `packages/shared/src/realtime.ts`, so all three apps agree on them.

**Access control.**

- The handshake must carry a valid access token, or the connection is refused with
  `UNAUTHENTICATED`.
- A socket receives nothing until it subscribes to a workspace, and subscribing checks
  membership. Each socket is in one workspace room at a time.
- Removing a member (or the member leaving) takes their open sockets out of the room at once.
  Deleting a workspace empties its room.
- Each socket is disconnected when its access token expires. The client reconnects with a fresh
  token, so access is re-checked at least every 15 minutes.
- Incoming messages are capped at 10 KB. Clients only ever send `subscribe`.

**Frontend.**

- `services/realtime.ts` owns the tab's single connection:
  - It reads the current token on every (re)connect.
  - When the server rejects the token, it refreshes the session and reconnects.
  - It re-subscribes after reconnects and when the user switches workspace.
  - After a reconnect it sends pages a `resync` message, because events may have been missed.
- A **Live / Connecting… / Offline** indicator in the top bar shows the state as a dot plus
  text.
- **Pop-up notifications** (announced to screen readers) for:
  - an incident opening;
  - an incident resolving, automatically or by someone else.
    People don't get notifications about their own changes, and comments and assignments don't
    trigger one.
- `useRealtimeRefresh(match, reload, minInterval)` reloads a page's data when a matching event
  arrives. It is throttled, so a burst of checks becomes one refetch and the last event is
  never lost:
  - dashboard and analytics: at most every 15 s;
  - active incidents, incident lists and detail, the Alerts tab: every 3 s or faster;
  - the monitor list, monitor detail and alert rules: on each check.
- The monitor page's timer polling now runs only as a fallback, when the live connection is
  down (and while waiting for "Run now").

## Dependency map

Each project has a map of how its services depend on each other, drawn with React Flow
(spec §30). It lives in the project's **Dependencies** tab. Arrows point from a caller to what
it depends on.

**Model.**

- `DependencyNode`: a label, a kind (Frontend, API gateway, Service, Database, Cache, Queue,
  External API), a position, an origin (`MANUAL` or `INFERRED`) and an optional `host`.
- `DependencyEdge`: source → target, origin, and an optional label.
- A unique index prevents duplicate connections, and a `CHECK` constraint forbids a node
  depending on itself.
- Node ids are chosen by the editor, so new connections can reference new nodes before the
  first save.

**Saving.** The editor saves the whole diagram at once (`PUT /api/dependencies`):

1. The transaction locks the project row and compares the version the editor started from with
   the project's `dependencyVersion`.
2. If someone saved in between, the save is refused with `409`, and the editor offers to reload.
   Without this, two people editing the same map would silently overwrite each other. A test
   forces two saves from the same version to race and fails without the lock.
3. Ids that belong to another project are rejected.
4. Validation is shared between the form and the API: at most 100 nodes and 300 connections,
   connections only between nodes on the map, no duplicates, and bounded coordinates.

This replaces the per-item `POST/PATCH/DELETE /api/dependencies/:id` routes sketched in spec
§37, because a canvas editor changes many items at once. One versioned save keeps the map
consistent, with no half-saved state.

**Health on the map.** A node with a `host` shows the worst health (spec §24) among the
project's monitors whose endpoint resolves to that host. The URL is resolved against the
monitor's environment base URL. The page refreshes health live on `monitor.status_changed`,
without touching nodes being edited.

**Manual vs inferred** (spec §30 asks to distinguish them clearly).

- **Detect dependencies** asks the API for suggestions (`GET /api/dependencies/suggestions`):
  - every host the project's monitors and saved endpoints call, if it isn't on the map yet,
    becomes an inferred service node;
  - it is connected from the map's entry point (the first Frontend or API gateway node, or a
    suggested inferred "Clients" node).
- Suggestions are added to the canvas unsaved, so people review them before saving.
- Inferred nodes have a dashed border and an "Inferred" tag. Inferred connections are dashed
  and labelled "inferred". Manual ones are solid. A legend explains this, and the side panel
  names the origin of every node and connection in text.

**Editing.**

- On the canvas: drag to move, drag from a node's bottom handle to another node to connect,
  and press Delete to remove.
- In the side panel: add, select, rename, change kind or host, remove nodes, and add or remove
  connections. So the map works with a keyboard and a screen reader, not just a mouse.
- "Save map" is enabled only when there are changes. "Discard changes" restarts from the saved
  map. Leaving the page with unsaved changes asks for confirmation.
- Viewers see the map and node details read-only.
- React Flow (about 180 KB) loads only on this page.

## Security hardening

This section covers how the Phase 14 checklist (spec §40–42) is met, and which test proves each
item. Security that is part of a feature lives in that feature's section: authentication,
authorization, encrypted secrets and SSRF protection.

| Area                        | What is in place                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Tests                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **SSRF**                    | See _Request execution and SSRF protection_. Hardened in this phase: every IPv6 address is expanded before checking, so IPv4-mapped, NAT64, IPv4-compatible and 6to4 addresses are judged by the IPv4 they carry, in any spelling (`64:ff9b:0:0:0:0:7f00:1` is 127.0.0.1). Teredo, local-use NAT64 and IPv4-translated ranges are refused outright. Disguised IPv4 literals in URLs (`0177.0.0.1`, `127.1`, `2130706433`, `0x7f.1`) normalise to their real address and are blocked | `packages/executor/src/ssrf.test.ts`                                |
| **Rate limiting**           | Per-endpoint limits (see the API reference), plus a per-IP backstop of 600 requests per minute on the whole API. Health checks are exempt. Limits live in Redis, so they hold across API instances                                                                                                                                                                                                                                                                                  | `security.test.ts`, per-feature suites                              |
| **Helmet**                  | CSP `default-src 'self'`, `frame-ancestors 'self'`, HSTS, `nosniff`, `Referrer-Policy: no-referrer`. `x-powered-by` is off                                                                                                                                                                                                                                                                                                                                                          | `security.test.ts`                                                  |
| **Web app headers**         | nginx sends a strict Content-Security-Policy on the SPA (details below), plus `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` and COOP. The early theme script moved out of `index.html` into `/theme-init.js`, so no inline script is needed                                                                                                                                                                                                           | live check after each rebuild                                       |
| **CORS**                    | An allowlist containing only `FRONTEND_URL`. A matching `Origin` is echoed back with credentials; any other origin gets no CORS headers, preflights included. Socket.IO uses the same origin                                                                                                                                                                                                                                                                                        | `security.test.ts`                                                  |
| **Request size**            | JSON bodies are capped at 1 MB (413 `PAYLOAD_TOO_LARGE`). nginx caps bodies at 2 MB. Socket.IO messages are capped at 10 KB. Executed requests' response bodies are capped at 1 MB                                                                                                                                                                                                                                                                                                  | `security.test.ts`, `app.test.ts`                                   |
| **Timeouts**                | Every API request gets an answer within 45 s: 504 `TIMEOUT`, and a late handler result is dropped safely. That is above the 30 s maximum for executed requests. Node rejects clients that take more than 20 s to send headers or 50 s for the whole request. nginx closes slow clients after 15 s. Executed requests and monitor checks have their own timeouts                                                                                                                     | `security.test.ts`                                                  |
| **Secure secrets**          | In production, the API and the worker refuse to start with the public development secrets from `.env.example`, any `change-me…` value, or a reused JWT secret. The local Docker stack (which runs with `NODE_ENV=production`) opts out explicitly with `ALLOW_DEV_SECRETS=true` and logs a warning. The API also warns at startup when `ALLOW_PRIVATE_NETWORK_TARGETS` is on in production                                                                                          | `security.test.ts` (starts a real process with production settings) |
| **Sensitive-log filtering** | Request logs contain only method, URL, status and request id. On top of that, every log line from the API and the worker passes through `redactSensitive` (`packages/shared/src/security.ts`): values under keys that look like credentials are replaced at any depth, and `Bearer`/`Basic` credentials and `token=`, `password=` and similar query values are masked inside strings. Errors are flattened so their attached request config is redacted too                         | `security.test.ts`                                                  |
| **Containers**              | The API and worker images run as the unprivileged `node` user. The application files stay root-owned, so a compromised process cannot modify the code                                                                                                                                                                                                                                                                                                                               | live check after each rebuild                                       |

**Content-Security-Policy of the web app** (`docker/security-headers.conf`):

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self';
form-action 'self'; frame-ancestors 'none'
```

- Scripts come only from this origin: no inline scripts, no `eval`, no third-party code.
- Inline style attributes are allowed because charts and the dependency map position elements
  with `style="…"`. Style attributes cannot run code.
- `connect-src 'self'` covers the REST API and the Socket.IO WebSocket, which are on the same
  origin.

**Not in this phase:**

- HSTS on the web app: it needs HTTPS, which the local stack does not have. It is added with
  deployment in Phase 20.
- Slimming the server images to production-only dependencies.

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
