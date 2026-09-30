# Deployment

TraceLayer is five processes: the web app (static files behind nginx), the API, the worker,
PostgreSQL and Redis. This guide runs them on one server with Docker Compose, which suits a
team or a demo. Every component can also be moved to a managed service; the settings below are
the same wherever they run.

## What each part needs

| Part       | Needs                                                                        | Scales                                              |
| ---------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| Web app    | Static hosting; `/api` and `/socket.io` routed to the API on the same origin | Any CDN or nginx                                    |
| API        | PostgreSQL, Redis, the secrets below; one public HTTP port behind TLS        | Horizontally: rate limits and Socket.IO share Redis |
| Worker     | PostgreSQL, Redis, `ENCRYPTION_KEY`, outbound internet, SMTP for alerts      | Horizontally: BullMQ spreads jobs across workers    |
| PostgreSQL | Version 16, persistent storage, backups                                      | Vertically                                          |
| Redis      | Version 7, persistence (AOF), `maxmemory-policy noeviction`                  | Vertically                                          |

The web app must be served from the **same origin** as the API (the Docker image's nginx does
this): the refresh cookie is `SameSite=Strict`, and the Content-Security-Policy only allows
connections to the page's own origin.

## Settings

Copy [`.env.example`](../.env.example) to `.env` on the server and set at least these.

| Variable                                                            | Production value                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`                                  | Two **different** random values of 32+ characters: `openssl rand -base64 48`                                                                                                                                          |
| `ENCRYPTION_KEY`                                                    | 32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Back it up**: losing it makes every stored secret unreadable                                                |
| `POSTGRES_PASSWORD`                                                 | A strong password (the compose file builds `DATABASE_URL` from it)                                                                                                                                                    |
| `PUBLIC_URL`                                                        | The public origin, e.g. `https://tracelayer.example.com`. With Docker Compose it sets the API's `FRONTEND_URL` (CORS, Socket.IO) and the worker's `APP_URL` (links in alert emails); elsewhere set those two directly |
| `COOKIE_SECURE`                                                     | `true` (the default in production): the site must be served over HTTPS                                                                                                                                                |
| `ALLOW_DEV_SECRETS`                                                 | `false`. The compose file defaults it to `true` for the local stack; override it                                                                                                                                      |
| `ALLOW_PRIVATE_NETWORK_TARGETS`                                     | `false` (SSRF protection on)                                                                                                                                                                                          |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Your mail provider, for alert emails. Without `SMTP_HOST` emails are only logged                                                                                                                                      |

Optional: `LOG_LEVEL` (default `info`), `WORKER_CONCURRENCY` (default 10), `BCRYPT_ROUNDS`
(default 12), `JWT_ACCESS_TTL` (default `15m`), `JWT_REFRESH_TTL_DAYS` (default 7),
`QUEUE_PREFIX` (default `tracelayer`; must match between API and worker).

**Safety net:** with `NODE_ENV=production`, the API and the worker refuse to start while a
development placeholder secret is still in use, unless `ALLOW_DEV_SECRETS=true`.

## Running with Docker Compose

1. **Install** Docker Engine with the Compose plugin on a Linux server, and clone the
   repository there.
2. **Configure** `.env` as above.
3. **Keep internal services private.** The compose file publishes PostgreSQL (`5434`), Redis
   (`6379`), the API (`4000`) and Mailpit (`8025`) on the host for local development. On a
   server, either firewall those ports or remove their `ports:` entries, so only the web app's
   port is reachable. Remove the `mailpit` service once real SMTP is configured, and point
   `SMTP_HOST` at your provider.
4. **Put TLS in front.** Terminate HTTPS in a reverse proxy (Caddy, Traefik, nginx or a cloud
   load balancer) that forwards to the web app's port (`8080` by default). Add
   `Strict-Transport-Security` there; the app does not set it because it cannot know it is
   behind HTTPS. The proxy must pass WebSocket upgrades for `/socket.io`.
5. **Start** the stack:

   ```bash
   docker compose up -d --build --wait
   ```

   The backend applies database migrations before it starts; the worker waits for it.

6. **Check** `https://<your-domain>/api/health`: the database, Redis and the worker should all
   be `up`.
7. **Optionally** load the demo workspace:
   `docker compose exec backend node apps/backend/dist/scripts/seed-demo.js --owner you@example.com`.

## Operations

- **Upgrades.** `git pull && docker compose up -d --build --wait`. Migrations run automatically
  and only ever apply pending changes.
- **Backups.** Back up PostgreSQL (`docker compose exec postgres pg_dump -U tracelayer tracelayer >
backup.sql`) and keep `ENCRYPTION_KEY` safe with it: a backup without the key has unreadable
  secrets. Redis holds queues and counters that rebuild themselves; it needs no backup.
- **Health.** Point an uptime check at `/api/health/live` (the process is up) or `/api/health`
  (it can reach the database, Redis and a live worker; returns 503 when a data store is down).
- **Logs.** The API and worker log one JSON line per event to stdout (`docker compose logs`),
  with credentials, cookies and tokens redacted. Each request has an `x-request-id` that also
  appears in error responses.
- **Scaling.** Run more API containers behind the load balancer and more worker containers;
  they coordinate through Redis. Keep PostgreSQL and Redis single, sized to the number of
  monitors (each check is one small insert).
- **Data retention.** Monitor runs older than 30 days are deleted daily; request history keeps
  the newest 5,000 entries per project.

## Production checklist

- [ ] Real, different JWT secrets and a new `ENCRYPTION_KEY`, backed up
- [ ] `ALLOW_DEV_SECRETS=false` and `ALLOW_PRIVATE_NETWORK_TARGETS=false`
- [ ] HTTPS with HSTS, `COOKIE_SECURE=true`, and `PUBLIC_URL` set to the public origin
- [ ] PostgreSQL, Redis and the API not reachable from the internet
- [ ] SMTP configured, and a test notification sent from Settings → Notifications
- [ ] Database backups scheduled and a restore tested
- [ ] An external uptime check on `/api/health`
