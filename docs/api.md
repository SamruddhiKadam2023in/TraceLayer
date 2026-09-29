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
