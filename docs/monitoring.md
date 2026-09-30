# Monitoring

How TraceLayer turns scheduled requests into knowledge:

- monitors run checks;
- checks become metrics and health;
- alert rules turn breaches into alerts and incidents;
- every change reaches the browser live.

```text
monitor ──schedule──▶ check (worker) ──▶ monitor_runs ──▶ metrics & health (SQL)
                                     └──▶ alert rules ──▶ alerts ──▶ incidents ──▶ notifications
                                     └──▶ real-time events ──▶ dashboard
```

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

7. Evaluates the monitor's alert rules, opening or resolving alerts and incidents (steps 13–14;
   see [Alerts and notifications](#alerts-and-notifications) and [Incidents](#incidents)).
8. Publishes real-time events to the workspace (step 15; see
   [Real-time updates](#real-time-updates)).

**Configuration errors surface early.** When a monitor is saved, the API test-prepares its
request (variables defined, base URL set, secrets allowed) and refuses the save with the reason.
If the setup breaks later (the endpoint changed, or the environment was deleted), each run is
recorded as `CONFIG_ERROR` with the reason, and nothing is sent.

**Data.** `monitor_runs` stores everything spec §20 lists: timestamp, status code, response
time, response size, success, failure reason, timeout, and the monitor, endpoint and environment
ids (copied onto the run, so metrics need no joins). It is indexed by
`(monitor_id, started_at DESC)` and `(project_id, started_at DESC)` for the time-series queries
behind metrics and analytics. A daily maintenance job (03:17 UTC) deletes runs older than **30 days**.

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
