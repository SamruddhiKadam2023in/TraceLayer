# Testing

TraceLayer is tested at four levels (spec §47). The aim is meaningful coverage of the critical
business logic, not a percentage.

| Level               | Tool                     | Where                                                      | Runs against                                                          |
| ------------------- | ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Unit                | Jest                     | `packages/shared/tests`, `packages/executor/src/*.test.ts` | Pure functions, real local HTTP servers                               |
| Backend integration | Jest + Supertest         | `apps/backend/tests`                                       | The Express app, a real PostgreSQL and Redis                          |
| Worker integration  | Jest                     | `apps/worker/tests`                                        | Real checks, PostgreSQL, Redis (BullMQ)                               |
| Frontend            | Vitest + Testing Library | `apps/frontend/src/test`                                   | The real router and components, a fake HTTP adapter and a fake socket |
| End-to-end          | Playwright               | `apps/e2e/tests`                                           | The running Docker stack, through nginx, in a real browser            |

## Running

```bash
pnpm infra:up                  # PostgreSQL and Redis (for backend and worker tests)
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test                      # unit, integration and frontend tests

docker compose up -d --build   # the full stack, for end-to-end tests
pnpm test:e2e
```

The backend and worker use their own databases (`tracelayer_test` and `tracelayer_worker_test`).
These are created and migrated automatically, so development data is never touched. The backend
tests also use their own Redis queue prefix (`tracelayer-test`), so a worker running against the
same Redis never picks up test jobs.

## What is covered

**Unit (shared, 73 tests; executor, 88 tests).**

- Validation of every input the product accepts:
  - accounts: email normalisation, and passwords of 8+ characters and at most 72 bytes;
  - environments: base URLs;
  - endpoints: URL forms, credentials only as variable references in headers and every auth
    type, JSON bodies with templates, no body on GET/HEAD, tags;
  - monitors: intervals, type-specific rules;
  - the dependency map: its structural rules.
- Check evaluation for every monitor type, and JSON assertions for every operator.
- The health status rules at their boundaries (streak, ratio, window).
- Host resolution for the dependency map, and the wording of the incident timeline.
- The SSRF rules, including IPv6 transition formats and disguised IPv4 literals, plus real HTTP
  execution: timeouts, gzip, size caps, redirects and credential handling.

**Backend integration (230 tests).**

- Authentication: tokens, rotation, theft detection and rate limits.
- Authorization: every role, 404 for outsiders.
- CRUD for workspaces, projects, environments, secrets, endpoints, monitors, alert rules,
  channels, incidents and the dependency map.
- Request execution and history.
- Metrics: exact P50/P95/P99, uptime and error rate against hand-computed values.
- Incident changes, comments and permissions.
- Real-time delivery over Socket.IO, including through Redis the way the worker publishes.
- The BullMQ producers against real Redis.
- The security hardening checks.

Race conditions are tested by forcing the overlap, not by hoping for it:

- two owners demoting each other at once;
- two monitor checks firing the same rule;
- a person resolving an incident while the worker auto-resolves it;
- two saves of the same dependency map.

Each of these tests fails when its lock is removed.

**Worker integration (70 tests).**

- Real checks against a local server, rule evaluation over time windows, and the
  pending → firing → resolved lifecycle.
- Incident creation, grouping, escalation and auto-resolution.
- Notification delivery: retries, disabled channels, test sends.
- Real-time events.
- Scheduler reconciliation and run retention.

**Frontend (114 tests).**

- The specified flows: login, the dashboard, endpoint creation, monitor creation, incident
  filtering, chart rendering and empty states.
- Settings, request execution and history, alerts and channels, incidents, the dependency map,
  and live updates (reconnection, token renewal, notifications, refresh on events).

## End-to-end

`apps/e2e/tests/critical-flow.spec.ts` walks the critical flow from spec §47 through the real UI:
register → login → create workspace → create project → create environment → create endpoint →
execute the API → create monitor → run it → view metrics → trigger an alert → view the incident
→ resolve it.

- **Registration and login:** registration happens in one browser, then login happens in a
  fresh one, so both are exercised on their own.
- **Nothing is mocked:** a real upstream API (httpbin.org by default) is monitored, and it is
  switched from `200` to `503` to trigger the alert.
- **Live updates:** the incident is seen arriving live as a notification.
- **Clean-up:** each run uses a new account and deletes its workspace at the end. If a run fails
  part-way, an `afterEach` hook deletes the workspace through the API instead.

| Setting               | Default                  | Purpose                                                                                                                              |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `E2E_BASE_URL`        | `http://localhost:8080`  | The app under test                                                                                                                   |
| `E2E_UPSTREAM_URL`    | `https://httpbin.org`    | An API with `/status/<code>` routes to monitor                                                                                       |
| `E2E_BROWSER_CHANNEL` | `msedge` on Windows      | An installed browser, so no download is needed. Elsewhere, run `pnpm --filter @tracelayer/e2e exec playwright install chromium` once |
| `E2E_REDIS_URL`       | `redis://localhost:6379` | Local stack only: see below                                                                                                          |

**Rate limits.** The API allows 5 sign-ups per hour per address, and every run signs up. Before
each run, the setup resets only the sign-up and sign-in counters of a local stack, which it
reaches through `E2E_REDIS_URL`. This is skipped quietly when Redis is not reachable; set
`E2E_RESET_RATE_LIMITS=false` to turn it off.

On failure, Playwright keeps a screenshot and a trace in `apps/e2e/test-results`
(`pnpm --filter @tracelayer/e2e exec playwright show-trace <trace.zip>`).

**What the end-to-end test found.** On its first run it caught a real bug that every other level
had missed. The new-project form sends `null` for an empty description, and the API rejected it,
so a project without a description could not be created from the UI. The frontend test used a
fake API that accepted anything, and the backend tests never sent `null`. The API now accepts
`null`, and a backend regression test covers it.

## Accessibility

`apps/e2e/tests/accessibility.spec.ts` runs axe-core (WCAG 2.1 A and AA rules, including
colour contrast) in a real browser, in both themes, on:

- the landing, sign-in, sign-up and privacy pages;
- the dashboard, projects, incidents, workspace settings and system status;
- a project's overview, new-endpoint editor, monitors, environments and dependency map;
- a dialog.

Any violation fails the run. It has caught a real one: white text on the dark theme's bright
red danger button, fixed with a dark-on-red text token for that button.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main`, on every pull request, and on demand
(spec §50). Any failing step fails the workflow.

**Job 1: checks** (PostgreSQL and Redis run as service containers):

1. Install dependencies from the lockfile (`--frozen-lockfile`), with the pnpm store cached.
2. Generate the Prisma client.
3. Lint, then check formatting.
4. Type check every package.
5. Unit tests: shared logic, SSRF rules and request execution.
6. Integration tests: API and worker, against the service databases.
7. Frontend tests.
8. Build the frontend.
9. Build the backend and worker (with the packages they depend on).

**Job 2: e2e** runs only after the checks pass:

- It starts the same Docker Compose stack as local development and waits until every service
  is healthy.
- It installs Playwright's Chromium and runs the critical-flow test.
- On failure, it prints the stack's logs and uploads the Playwright report, screenshots and
  trace as an artifact (kept for 7 days).
- The stack is always torn down at the end.

**Other settings:**

- A newer push to the same branch cancels a run in progress.
- The workflow token is read-only.
- Dependabot opens weekly update pull requests for npm packages (minor and patch updates
  grouped), GitHub Actions and the Docker base images. CI checks each one.

**Running the same checks locally:**

```bash
pnpm infra:up
pnpm db:generate && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
docker compose up -d --build --wait && pnpm test:e2e
```

**Status badge:** once the repository is on GitHub, add this line to the top of the README,
with the real owner and repository name:

```markdown
[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)
```

To block merges that break the build, protect `main` and require the **Lint, type-check, test,
build** and **End-to-end** checks (GitHub → Settings → Branches).
