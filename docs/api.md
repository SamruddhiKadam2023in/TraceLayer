# API reference

Base path: `/api`. All request and response bodies are JSON.

## Conventions

### Response envelope

Every response uses one of two shapes.

```json
{ "success": true, "data": { "...": "..." } }
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "email", "message": "Enter a valid email address" }],
    "requestId": "8f0c6f0e-5b1a-4a57-9d2e-1c1f0b7a4e21"
  }
}
```

`details` appears on validation errors and on conflicts tied to a field, with one entry per
problem. `requestId` matches the `x-request-id` response header and the server log line for the
request.

### Error codes

| Code                | HTTP | Meaning                                                          |
| ------------------- | ---- | ---------------------------------------------------------------- |
| `VALIDATION_ERROR`  | 400  | Body failed validation, or the JSON was malformed                |
| `UNAUTHENTICATED`   | 401  | Missing, invalid or expired credentials                          |
| `FORBIDDEN`         | 403  | Authenticated but not allowed                                    |
| `NOT_FOUND`         | 404  | Unknown route or resource                                        |
| `CONFLICT`          | 409  | The request clashes with existing data (e.g. email taken)        |
| `PAYLOAD_TOO_LARGE` | 413  | Body over 1 MB                                                   |
| `RATE_LIMITED`      | 429  | Too many requests; see the `Retry-After` header                  |
| `INTERNAL_ERROR`    | 500  | Unexpected failure. Details are logged server-side, not returned |

### Authentication

Two credentials work together:

| Credential    | Where it lives                                                       | Lifetime | Used for                        |
| ------------- | -------------------------------------------------------------------- | -------- | ------------------------------- |
| Access token  | Response body; sent back as `Authorization: Bearer <token>`          | 15 min   | Every protected endpoint        |
| Refresh token | `tl_refresh` cookie: `HttpOnly`, `SameSite=Strict`, `Path=/api/auth` | 7 days   | `/auth/refresh`, `/auth/logout` |

When a protected call returns 401, call `POST /api/auth/refresh` to get a new access token, then
retry. Each refresh replaces the refresh cookie. Presenting an old refresh token again is treated
as theft: the whole session is revoked and the user must sign in again.

### Rate limits

Limits apply per client IP and are shared across API instances (stored in Redis). Responses
carry the standard `RateLimit` and `RateLimit-Policy` headers; a 429 also sets `Retry-After`
(seconds).

| Endpoint                       | Limit                             |
| ------------------------------ | --------------------------------- |
| `POST /auth/login`             | 10 **failed** attempts per 15 min |
| `POST /auth/register`          | 5 per hour                        |
| `POST /auth/refresh`           | 60 per 15 min                     |
| `POST /workspaces`             | 20 per hour, per user             |
| `POST /workspaces/:id/members` | 30 per 15 min, per user           |
| `POST /projects`               | 30 per hour, per user             |
| `POST /endpoints`              | 100 per hour, per user            |
| `POST /requests/execute`       | 60 per minute, per user           |
| `POST /monitors`               | 60 per hour, per user             |
| `POST /monitors/:id/run`       | 30 per minute, per user           |

## Health

### `GET /api/health/live`

Liveness probe. Always `200` while the process is serving HTTP.

```json
{ "success": true, "data": { "status": "ok" } }
```

### `GET /api/health`

Dependency status. `200` when PostgreSQL and Redis are reachable, `503` otherwise. The body is
the same in both cases. `status` is `ok` only when the worker heartbeat is also present;
otherwise it is `degraded`.

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "version": "0.1.0",
    "uptimeSeconds": 273,
    "timestamp": "2026-09-29T12:07:13.992Z",
    "dependencies": {
      "database": { "status": "up", "latencyMs": 3 },
      "redis": { "status": "up", "latencyMs": 1 },
      "worker": { "status": "up", "latencyMs": null, "lastHeartbeatAt": "2026-09-29T12:07:06.003Z" }
    }
  }
}
```

## Auth

The `user` object returned by these endpoints never includes the password or its hash:

```json
{
  "id": "ae2e4df7-0cca-4b78-915f-ac7e57e8149f",
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "createdAt": "2026-09-29T12:36:43.260Z"
}
```

A **session** response (register, login, refresh) is:

```json
{ "user": { "...": "..." }, "accessToken": "eyJhbGciOi…", "expiresIn": 900 }
```

and sets the `tl_refresh` cookie.

### `POST /api/auth/register`

Creates an account and signs it in.

| Field             | Rules                                                     |
| ----------------- | --------------------------------------------------------- |
| `name`            | 1–100 characters after trimming                           |
| `email`           | Valid email, max 254 characters; trimmed and lowercased   |
| `password`        | At least 8 characters and at most 72 bytes (bcrypt limit) |
| `confirmPassword` | Must equal `password`                                     |

- `201` with a session.
- `400 VALIDATION_ERROR` with one `details` entry per invalid field.
- `409 CONFLICT` if the email is registered (compared case-insensitively), with
  `details: [{ "path": "email", … }]`.
- `429 RATE_LIMITED`.

### `POST /api/auth/login`

| Field      | Rules                            |
| ---------- | -------------------------------- |
| `email`    | Valid email; trimmed, lowercased |
| `password` | Required, at most 72 bytes       |

- `200` with a session.
- `401 UNAUTHENTICATED` with message `Invalid email or password`. The response is identical for
  an unknown email and a wrong password.
- `429 RATE_LIMITED` after 10 failed attempts in 15 minutes. Successful logins do not count.

### `POST /api/auth/refresh`

No body; uses the `tl_refresh` cookie.

- `200` with a new session and a new refresh cookie. The old refresh token stops working.
- `401 UNAUTHENTICATED` if the cookie is missing, unknown, expired or already used. The cookie is
  cleared. Reusing an already-rotated token also revokes every token in that session.

### `POST /api/auth/logout`

No body; uses the `tl_refresh` cookie if present.

- `204`. Revokes the session and clears the cookie. Always succeeds, even without a session.
  Other sessions of the same user (other devices) stay signed in.

### `GET /api/auth/me`

Requires `Authorization: Bearer <access token>`.

- `200` with the `user` object.
- `401 UNAUTHENTICATED` if the token is missing, malformed, expired (`Access token expired`),
  signed with the wrong key, or belongs to a deleted account.

## Workspaces

All workspace endpoints require `Authorization: Bearer <access token>`. Access is checked on
every request against the caller's role (see [architecture.md](architecture.md#authorization)):

- A workspace the caller does not belong to, or a malformed id, returns
  **`404 NOT_FOUND`** ("Workspace not found"). It never returns 403, so workspace ids cannot be
  probed.
- A member without the required permission gets **`403 FORBIDDEN`**.

A **workspace** is returned as seen by the caller:

```json
{
  "id": "25dd6ecf-9c6f-4528-9a47-6c39b293a323",
  "name": "Acme Engineering",
  "role": "OWNER",
  "memberCount": 3,
  "createdAt": "2026-09-29T12:36:43.260Z"
}
```

`role` is the caller's role: `OWNER`, `ADMIN`, `MEMBER` or `VIEWER`.

| Method | Path                  | Required role | Result                                          |
| ------ | --------------------- | ------------- | ----------------------------------------------- |
| GET    | `/api/workspaces`     | any user      | `200`, the caller's workspaces sorted by name   |
| POST   | `/api/workspaces`     | any user      | `201`, new workspace with the caller as owner   |
| GET    | `/api/workspaces/:id` | any member    | `200`, the workspace                            |
| PATCH  | `/api/workspaces/:id` | owner         | `200`, the renamed workspace                    |
| DELETE | `/api/workspaces/:id` | owner         | `204`; members (and later projects) are deleted |

Body for create and rename: `{ "name": string }`, 1–100 characters after trimming.

### Members

A **member** looks like:

```json
{
  "userId": "ae2e4df7-0cca-4b78-915f-ac7e57e8149f",
  "name": "Grace Hopper",
  "email": "grace@example.com",
  "role": "ADMIN",
  "joinedAt": "2026-09-29T12:40:00.000Z"
}
```

| Method | Path                                  | Required role                         | Result                            |
| ------ | ------------------------------------- | ------------------------------------- | --------------------------------- |
| GET    | `/api/workspaces/:id/members`         | any member                            | `200`, members by role, then name |
| POST   | `/api/workspaces/:id/members`         | owner or admin                        | `201`, the new member             |
| PATCH  | `/api/workspaces/:id/members/:userId` | owner or admin                        | `200`, the updated member         |
| DELETE | `/api/workspaces/:id/members/:userId` | owner or admin; anyone for themselves | `204`                             |

**Add** takes `{ "email": string, "role": Role }`. The email must belong to an existing
TraceLayer account (compared case-insensitively).

- `404 NOT_FOUND` with `details: [{ "path": "email", … }]` if no account uses the email.
- `409 CONFLICT` with `details: [{ "path": "email", … }]` if the user is already a member.

**Change role** takes `{ "role": Role }`.

Rules for add, change role and remove:

- Only owners may assign the `OWNER` role, or change or remove an existing owner (`403`).
- Removing yourself (leaving) needs no management permission.
- The last owner cannot be demoted, removed or leave: `409 CONFLICT` ("A workspace must always
  have at least one owner"). Promote another member to owner first, or delete the workspace.
- A `:userId` that is not a member of the workspace returns `404` ("Member not found").

## Projects

All project endpoints require `Authorization: Bearer <access token>`. Access follows the
project's workspace: every member can read, owners and admins (`projects.manage`) can change.
Anyone outside the workspace, and any malformed id, gets `404 NOT_FOUND` ("Project not
found").

A **project**:

```json
{
  "id": "3f1c…",
  "workspaceId": "25dd…",
  "name": "Payments API",
  "description": "Card processing",
  "createdBy": { "id": "ae2e…", "name": "Ada Lovelace" },
  "environmentCount": 3,
  "createdAt": "2026-09-29T13:30:18.696Z",
  "updatedAt": "2026-09-29T13:30:18.696Z"
}
```

`createdBy` is `null` if the creator's account no longer exists.

| Method | Path                          | Required role  | Result                                   |
| ------ | ----------------------------- | -------------- | ---------------------------------------- |
| GET    | `/api/projects?workspaceId=…` | any member     | `200`, the workspace's projects by name  |
| POST   | `/api/projects`               | owner or admin | `201`, the project, with 3 environments  |
| GET    | `/api/projects/:id`           | any member     | `200`, the project                       |
| PATCH  | `/api/projects/:id`           | owner or admin | `200`, the updated project               |
| DELETE | `/api/projects/:id`           | owner or admin | `204`; environments and variables go too |

- **Create** takes `{ "workspaceId": uuid, "name": string, "description"?: string }`.
- **Update** takes `{ "name"?: string, "description"?: string }`, with at least one field.
- `name`: 1–100 characters after trimming, unique within the workspace ignoring case
  (`409 CONFLICT` with `details: [{ "path": "name", … }]`).
- `description`: up to 500 characters; an empty string clears it.
- A workspace can hold at most **50** projects (`409 CONFLICT`).
- New projects get the environments **Development**, **Staging** and **Production**, with no
  base URL set.

### Environments

An **environment**, with its variables:

```json
{
  "id": "9a0e…",
  "projectId": "3f1c…",
  "name": "Production",
  "baseUrl": "https://api.example.com",
  "variables": [
    { "id": "…", "key": "API_KEY", "isSecret": true, "value": null, "updatedAt": "…" },
    { "id": "…", "key": "CLIENT_ID", "isSecret": false, "value": "web-app", "updatedAt": "…" }
  ],
  "createdAt": "…",
  "updatedAt": "…"
}
```

| Method | Path                                            | Required role  | Result                         |
| ------ | ----------------------------------------------- | -------------- | ------------------------------ |
| GET    | `/api/projects/:id/environments`                | any member     | `200`, environments in order   |
| POST   | `/api/projects/:id/environments`                | owner or admin | `201`, the new environment     |
| PATCH  | `/api/projects/:id/environments/:environmentId` | owner or admin | `200`, the updated environment |
| DELETE | `/api/projects/:id/environments/:environmentId` | owner or admin | `204`                          |

- **Create** takes `{ "name": string, "baseUrl"?: string }`; **update** takes either field.
- `name`: 1–50 characters, unique within the project ignoring case (`409`).
- `baseUrl`: an `http` or `https` URL, at most 2048 characters. It may not contain
  credentials, a query string or a fragment (`400`). It is stored lower-cased without a
  trailing slash, and an empty string clears it.
- A project holds at most **10** environments, and deleting the **last** one is refused (`409`).
- An `:environmentId` that belongs to a different project returns `404`.

### Variables

| Method | Path                                                                  | Required role  | Result              |
| ------ | --------------------------------------------------------------------- | -------------- | ------------------- |
| POST   | `/api/projects/:id/environments/:environmentId/variables`             | owner or admin | `201`, the variable |
| PATCH  | `/api/projects/:id/environments/:environmentId/variables/:variableId` | owner or admin | `200`, the variable |
| DELETE | `/api/projects/:id/environments/:environmentId/variables/:variableId` | owner or admin | `204`               |

- **Create** takes `{ "key": string, "value": string, "isSecret"?: boolean }`.
  - `key`: letters, digits and underscores, not starting with a digit, at most 100
    characters, and unique within the environment (`409`).
  - `value`: at most 4096 characters.
  - An environment holds at most **50** variables.
- **Update** takes `{ "key"?, "value"?, "isSecret"? }`, at least one field.
  - Omitting `value` keeps the stored value.
  - Making a plain variable secret encrypts its current value.
  - Making a secret plain **requires** a new `value` (`400`, path `value`), because a secret's
    value is never revealed.

**Secrets are write-only.** For `isSecret: true` every response carries `value: null`. The
value is stored encrypted (AES-256-GCM) and is only ever decrypted on the server.

## Endpoints

Require `Authorization: Bearer <access token>`. Every member of the project's workspace can
read; owners, admins and members (`monitoring.manage`) can create, change and delete. Anyone
outside the workspace, and any malformed id, gets `404 NOT_FOUND` ("Endpoint not found").

An **endpoint**:

```json
{
  "id": "5b0d…",
  "projectId": "3f1c…",
  "name": "Create order",
  "description": null,
  "method": "POST",
  "url": "/orders",
  "environmentId": "9a0e…",
  "headers": [{ "key": "Authorization", "value": "Bearer {{API_TOKEN}}", "enabled": true }],
  "queryParams": [{ "key": "dryRun", "value": "true", "enabled": false }],
  "body": { "type": "json", "content": "{\"qty\": {{QTY}}}" },
  "auth": { "type": "none" },
  "timeoutMs": 10000,
  "expectedStatus": 201,
  "tags": ["orders"],
  "createdBy": { "id": "ae2e…", "name": "Ada Lovelace" },
  "createdAt": "…",
  "updatedAt": "…"
}
```

| Method | Path                                                | Required role          | Result                      |
| ------ | --------------------------------------------------- | ---------------------- | --------------------------- |
| GET    | `/api/endpoints?projectId=…[&search=&method=&tag=]` | any member             | `200`, endpoints by name    |
| POST   | `/api/endpoints`                                    | owner, admin or member | `201`, the endpoint         |
| GET    | `/api/endpoints/:id`                                | any member             | `200`, the endpoint         |
| PATCH  | `/api/endpoints/:id`                                | owner, admin or member | `200`, the updated endpoint |
| DELETE | `/api/endpoints/:id`                                | owner, admin or member | `204`                       |

The list endpoint filters with `search` (case-insensitive, on name or URL), `method` and `tag`.

**Create** takes `projectId`, `name`, `method` and `url`. Everything else is optional, with these
defaults: no description, no environment, no headers or params, body `{ "type": "none" }`, auth
`{ "type": "none" }`, `timeoutMs` 10000, `expectedStatus` `null` and no tags. **Update** takes any
subset of the fields. It is merged into the stored endpoint, and the whole result must be valid.

| Field            | Rules                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `name`           | 1–100 characters, unique in the project ignoring case (`409`)                                    |
| `method`         | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` or `OPTIONS`                                     |
| `url`            | `/path`, `{{VAR}}/path` or `http(s)://…`; at most 2048 characters; no `?` or `#`                 |
| `environmentId`  | an environment of the **same** project (else `404`, path `environmentId`), or `null`             |
| `headers`        | up to 50 `{ key, value, enabled }`; `key` must be a valid header name                            |
| `queryParams`    | up to 50 `{ key, value, enabled }`                                                               |
| `body`           | `none`, `json` (valid JSON), `text` or `form` (fields). Not allowed for GET or HEAD.             |
| `auth`           | `none`, `bearer` (`token`), `basic` (`username`, `password`) or `apiKey` (`in`, `name`, `value`) |
| `timeoutMs`      | 1000–30000                                                                                       |
| `expectedStatus` | 100–599, or `null` for "any 2xx"                                                                 |
| `tags`           | up to 10; lower-cased; letters, digits and dashes; duplicates removed                            |

- A project holds at most **200** endpoints (`409`).
- **Variables:** any value may reference an environment variable as `{{NAME}}`. It is substituted
  when the request runs.
- **Credentials must be references:** `auth.token`, `auth.password` and `auth.value` must be
  exactly one `{{NAME}}`, and credential headers (`Authorization`, `Cookie`, `X-Api-Key`, …) must
  contain one. Otherwise the request is rejected with `400` on that field.

## Requests

### `POST /api/requests/execute`

Sends a request through the platform, with SSRF protection. Requires owner, admin or member
(`monitoring.manage`) in the project's workspace. Viewers get `403`, because running a request
uses the environment's secrets. Rate limit: 60 per minute per user.

```json
{
  "projectId": "3f1c…",
  "environmentId": "9a0e…",
  "endpointId": "5b0d…",
  "request": {
    "method": "GET",
    "url": "/orders/{{ORDER_ID}}",
    "headers": [],
    "queryParams": [],
    "body": { "type": "none" },
    "auth": { "type": "bearer", "token": "{{API_TOKEN}}" },
    "timeoutMs": 10000
  },
  "saveToHistory": true
}
```

- `environmentId` may be `null`; then only absolute URLs without variables can run.
- `endpointId` is optional (default `null`) and links the run to a saved endpoint in history.
- `request` follows the endpoint rules; see [Endpoints](#endpoints).
- `saveToHistory` defaults to `true`.

**Configuration problems** return `400 VALIDATION_ERROR`, and nothing is sent:

- a variable is not defined in the environment;
- a relative URL is used without a base URL;
- a header value would contain a line break;
- a secret would be sent anywhere other than the environment's base-URL origin
  (`details: [{ "path": "url", … }]`).

An environment or endpoint from another project returns `404`.

**Otherwise `200`**, even if the request itself failed:

```json
{
  "result": {
    "startedAt": "2026-09-29T14:02:11.120Z",
    "durationMs": 243,
    "timeToFirstByteMs": 201,
    "request": {
      "method": "GET",
      "url": "https://api.example.com/orders/42",
      "headers": [
        ["Authorization", "Bearer ••••••"],
        ["User-Agent", "TraceLayer/0.1 (…)"]
      ]
    },
    "redirects": [],
    "note": null,
    "response": {
      "status": 200,
      "statusText": "",
      "headers": [["content-type", "application/json"]],
      "contentType": "application/json",
      "body": "{\"id\":42}",
      "bodyKind": "text",
      "sizeBytes": 9,
      "truncated": false
    },
    "error": null
  },
  "historyId": "c81e…"
}
```

- When no response arrived, `response` is `null` and `error` is
  `{ "code", "message" }`. The codes are `BLOCKED_TARGET`, `TIMEOUT`, `DNS_FAILURE`,
  `CONNECTION_REFUSED`, `CONNECTION_RESET`, `TLS_ERROR`, `INVALID_RESPONSE` and `REQUEST_FAILED`.
- Bodies are capped at 1 MB after decompression (`truncated: true`).
- Binary bodies have `bodyKind: "binary"` and `body: null`.
- **Secret values are masked** (`••••••`) everywhere in the result.
- `note` explains a redirect that was deliberately not followed.

### `GET /api/requests/history`

Readable by every workspace member.

| Query parameter        | Meaning                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `projectId` (required) | The project                                                           |
| `endpointId`           | Only runs of this endpoint                                            |
| `environmentId`        | Only runs in this environment                                         |
| `method`               | HTTP method                                                           |
| `status`               | `2xx`, `3xx`, `4xx`, `5xx`, or `error` (no response)                  |
| `from`, `to`           | ISO 8601 date-times (inclusive); `to` must not be before `from`       |
| `search`               | Case-insensitive match on the URL                                     |
| `sort`                 | `createdAt` (default), `durationMs` or `status`                       |
| `order`                | `desc` (default) or `asc`; failed runs sort first ascending by status |
| `page`, `pageSize`     | Default 1 and 25; `pageSize` at most 100                              |

The response is:

```json
{ "items": [HistoryEntry], "total": 60, "page": 2, "pageSize": 25 }
```

Each entry has `id`, `method`, `url` (secrets masked), `status` (or `null` with `errorCode` and
`errorMessage`), `durationMs`, `sizeBytes`, `createdAt`, and `endpoint`, `environment` and
`user` (each `{ id, name }` or `null`). Response bodies are never stored. The newest 5,000 entries
per project are kept.

## Monitors

Require `Authorization: Bearer <access token>`. Every workspace member can read. Owners, admins
and members (`monitoring.manage`) can create, change, delete and run monitors. Anyone outside the
workspace, and any malformed id, gets `404` ("Monitor not found").

A **monitor**:

```json
{
  "id": "d1c6…",
  "projectId": "3f1c…",
  "name": "Production health",
  "endpointId": "5b0d…",
  "environmentId": "9a0e…",
  "type": "RESPONSE_VALIDATION",
  "intervalSeconds": 60,
  "timeoutMs": 4000,
  "expectedStatus": 200,
  "latencyThresholdMs": null,
  "assertions": [{ "path": "status", "operator": "equals", "value": "healthy" }],
  "enabled": true,
  "endpoint": { "id": "5b0d…", "name": "Health", "method": "GET", "url": "/health" },
  "environment": { "id": "9a0e…", "name": "Production" },
  "lastRunAt": "2026-09-30T18:33:47.120Z",
  "lastRunSuccess": true,
  "consecutiveFailures": 0,
  "createdBy": { "id": "ae2e…", "name": "Ada Lovelace" },
  "createdAt": "…",
  "updatedAt": "…"
}
```

| Method | Path                        | Required role          | Result                                 |
| ------ | --------------------------- | ---------------------- | -------------------------------------- |
| GET    | `/api/monitors?projectId=…` | any member             | `200`, monitors by name                |
| POST   | `/api/monitors`             | owner, admin or member | `201`, the monitor (scheduled at once) |
| GET    | `/api/monitors/:id`         | any member             | `200`, the monitor                     |
| PATCH  | `/api/monitors/:id`         | owner, admin or member | `200`, the monitor (rescheduled)       |
| DELETE | `/api/monitors/:id`         | owner, admin or member | `204`; runs are deleted too            |
| POST   | `/api/monitors/:id/run`     | owner, admin or member | `202 { "queued": true }`               |
| GET    | `/api/monitors/:id/runs`    | any member             | `200`, runs newest first               |

**Create** takes `projectId`, `name`, `endpointId`, `environmentId` and `type`. The optional
fields have these defaults: `intervalSeconds` 300, `timeoutMs` the endpoint's timeout,
`expectedStatus` `null`, `latencyThresholdMs` `null`, `assertions` `[]` and `enabled` `true`.
**Update** takes any subset of the fields. It is merged into the stored monitor, and the whole
result must be valid.

| Field                         | Rules                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                        | 1–100 characters, unique in the project ignoring case (`409`)                                                                                                                                                                                                       |
| `endpointId`, `environmentId` | must belong to the project (`404`), and the endpoint's request must be buildable in that environment (`400` on `environmentId`, with the reason)                                                                                                                    |
| `type`                        | `AVAILABILITY`, `STATUS`, `PERFORMANCE` or `RESPONSE_VALIDATION`                                                                                                                                                                                                    |
| `intervalSeconds`             | one of 60, 300, 600, 900, 1800, 3600                                                                                                                                                                                                                                |
| `timeoutMs`                   | 1000–30000                                                                                                                                                                                                                                                          |
| `expectedStatus`              | 100–599, or `null` (the endpoint's expected status, else any 2xx)                                                                                                                                                                                                   |
| `latencyThresholdMs`          | required for `PERFORMANCE`: 50–30000 and lower than `timeoutMs`                                                                                                                                                                                                     |
| `assertions`                  | required (at least 1, at most 10) for `RESPONSE_VALIDATION`: `{ path, operator, value? }`; `path` is a dot path; `operator` is `equals`, `notEquals`, `exists`, `notExists` or `contains`; `value` is any JSON value (required except for `exists` and `notExists`) |

- A project holds at most **50** monitors (`409`).
- **Run now** queues a check for the worker and returns at once. If the queue is unavailable
  the response is `502 UPSTREAM_ERROR`. The run appears in `/runs` when it finishes.

**Runs** take `limit` (1–100, default 25) and `before` (an ISO date-time cursor: runs that
started before it). Each run looks like:

```json
{
  "id": "…",
  "monitorId": "d1c6…",
  "startedAt": "2026-09-30T18:33:48.012Z",
  "success": false,
  "statusCode": 500,
  "durationMs": 917,
  "sizeBytes": 0,
  "timedOut": false,
  "failureReason": "UNEXPECTED_STATUS",
  "failureMessage": "Expected 200, received 500"
}
```

`statusCode`, `durationMs` and `sizeBytes` are `null` when no response arrived, for example with
`TIMEOUT`, `BLOCKED_TARGET` or `CONFIG_ERROR`. Runs are kept for 30 days.
