# Security

How TraceLayer protects accounts, workspaces, secrets and the networks it can reach. The
platform sends HTTP requests to URLs its users choose, so SSRF protection is the central concern
(spec §40). The rest is standard practice, applied carefully.

At a glance:

- **Accounts.** Passwords are hashed with bcrypt. Access tokens are short-lived and held in
  memory. Refresh tokens rotate, live in an httpOnly cookie, and reuse of an old one revokes the
  session.
- **Authorization.** One permission table, enforced by the API on every request. Non-members get
  404, not 403.
- **Secrets.** Encrypted at rest (AES-256-GCM) and write-only. They are only ever sent to their
  own environment's origin, and masked everywhere else.
- **SSRF.** Every address a request actually connects to is checked, including after redirects
  and when DNS answers change between checks.
- **Hardening.** Rate limits, security headers and a Content-Security-Policy, a CORS allowlist,
  size limits and timeouts, production secret checks, redacted logs, and non-root containers.

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
| `incidents.manage`  |   ✓   |   ✓   |   ✓    |        |

What each permission covers:

| Permission                             | Allows                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `workspace.read`                       | Seeing the workspace and everything in it                                    |
| `workspace.update`, `workspace.delete` | Renaming and deleting the workspace                                          |
| `members.manage`                       | Adding, removing and changing the roles of members; notification channels    |
| `projects.manage`                      | Creating, editing and deleting projects and environments (including secrets) |
| `monitoring.manage`                    | Endpoints, sending requests, monitors, alert rules and the dependency map    |
| `incidents.manage`                     | Changing incident status, severity and assignee, and commenting              |

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

## Request execution and SSRF protection

The platform sends HTTP requests to URLs that users choose, which makes **server-side request
forgery (SSRF)** its biggest security risk: without protection, anyone who can edit an endpoint
could make the server fetch `http://169.254.169.254/` (cloud credentials), `http://postgres:5432`
or anything else on the internal network.

All execution goes through `@tracelayer/executor` (`packages/executor`). The API uses it for
requests sent from the request builder, and the worker uses the same code for monitor checks.

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

## Security hardening

This section covers how the security hardening checklist (spec §40–42) is met, and which test
proves each item. Security that is part of a feature lives in that feature's section: authentication,
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

**Known gaps:**

- HSTS on the web app needs HTTPS, which the local stack does not have. Behind a TLS-terminating
  proxy in production, add it there (see [deployment](deployment.md)).
- The server images contain development dependencies; slimming them to production-only
  dependencies would shrink them and reduce what an attacker could use.
