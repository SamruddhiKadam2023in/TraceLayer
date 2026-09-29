# Architecture

TraceLayer is a pnpm monorepo with three runnable apps (frontend, backend, worker) and two shared
packages (database client, shared types). PostgreSQL is the system of record; Redis carries the job
queue, the worker heartbeat, rate-limit counters and, later, real-time fan-out.

> **Status:** this document covers Phases 1–7 (foundation, authentication, workspaces, projects, endpoints, request
> execution, monitoring). Sections marked _(planned)_ describe
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
  a **project page** with Overview, Endpoints, Monitors, History, Environments and Settings
  tabs, the **endpoint
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
