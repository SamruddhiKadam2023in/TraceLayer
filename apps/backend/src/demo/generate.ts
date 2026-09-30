import {
  checkCondition,
  describeBreach,
  evaluateCheck,
  nextRuleState,
  type AlertRuleState,
  type ExecutionResult,
  type FailureReason,
} from '@tracelayer/shared';
import type { DemoMonitor, DemoScenario } from './demo-data';

/**
 * Generates a monitor's history and replays its alert rule over it, using the product's own
 * logic: every run is judged by `evaluateCheck`, and the rule moves through `checkCondition` /
 * `nextRuleState`, exactly as the worker does. So demo alerts, incidents and rule states are the
 * ones the platform would have produced for these runs.
 *
 * Deterministic: the same monitor and `now` always give the same history.
 */

export interface GeneratedRun {
  startedAt: Date;
  success: boolean;
  statusCode: number | null;
  durationMs: number | null;
  sizeBytes: number | null;
  timedOut: boolean;
  failureReason: FailureReason | null;
  failureMessage: string | null;
}

export interface GeneratedIncident {
  firedAt: Date;
  /** null while the incident is still going on. */
  resolvedAt: Date | null;
  message: string;
  value: number | null;
  scenario: DemoScenario | null;
}

export interface GeneratedHistory {
  runs: GeneratedRun[];
  incidents: GeneratedIncident[];
  rule: {
    state: AlertRuleState;
    pendingSince: Date | null;
    lastValue: number | null;
    lastEvaluatedAt: Date | null;
  };
  consecutiveFailures: number;
}

/** Small, fast, seedable PRNG (mulberry32). */
export function createRandom(seedText: string): () => number {
  let seed = 0;
  for (const char of seedText) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) | 0;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box–Muller). */
function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Busier afternoons (UTC) are a little slower than quiet nights. */
function dailyLoad(at: Date): number {
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  return 1 + 0.18 * Math.sin(((hour - 8) / 24) * 2 * Math.PI);
}

function activeScenario(scenarios: DemoScenario[], at: Date, now: Date): DemoScenario | undefined {
  return scenarios.find((s) => {
    const start = now.getTime() - s.startHoursAgo * 3_600_000;
    return at.getTime() >= start && at.getTime() < start + s.durationMinutes * 60_000;
  });
}

function execution(
  at: Date,
  durationMs: number,
  response: { status: number; body: string | null; sizeBytes: number } | null,
  error: ExecutionResult['error'] = null,
): ExecutionResult {
  return {
    startedAt: at.toISOString(),
    durationMs,
    timeToFirstByteMs: response ? Math.round(durationMs * 0.8) : null,
    request: { method: 'GET', url: '', headers: [] },
    redirects: [],
    note: null,
    response: response && {
      status: response.status,
      statusText: '',
      headers: [],
      contentType: 'application/json',
      body: response.body,
      bodyKind: response.body === null ? 'empty' : 'text',
      sizeBytes: response.sizeBytes,
      truncated: false,
    },
    error,
  };
}

export function generateHistory(monitor: DemoMonitor, now: Date, days: number): GeneratedHistory {
  const random = createRandom(`${monitor.name}:${monitor.endpoint}`);
  const step = monitor.intervalSeconds * 1000;
  // Checks run on a fixed schedule, the latest one just before now.
  const first = now.getTime() - days * 86_400_000;
  const runs: GeneratedRun[] = [];
  const incidents: GeneratedIncident[] = [];
  const settings = {
    type: monitor.type,
    expectedStatus: monitor.expectedStatus,
    latencyThresholdMs: monitor.latencyThresholdMs ?? null,
    assertions: monitor.assertions ?? [],
  };

  let state: { state: AlertRuleState; pendingSince: Date | null } = {
    state: 'OK',
    pendingSince: null,
  };
  let lastValue: number | null = null;
  let consecutiveFailures = 0;
  let open: GeneratedIncident | null = null;

  for (let t = first + step; t <= now.getTime() - 30_000; t += step) {
    const at = new Date(t - Math.floor(random() * 4000));
    const scenario = activeScenario(monitor.scenarios, at, now);
    const size = Math.round(monitor.sizeBytes * (0.97 + random() * 0.06));
    let latency =
      monitor.latency.medianMs *
      Math.exp(monitor.latency.spread * gaussian(random)) *
      dailyLoad(at);
    if (scenario?.kind === 'slow') latency *= scenario.factor ?? 2;
    latency = Math.max(20, Math.round(latency));

    let result: ExecutionResult;
    const failing =
      scenario?.kind === 'outage' ||
      (scenario?.kind === 'flaky' && random() < (scenario.failRate ?? 0.5));
    // Rare one-off network blips, as any real history has.
    const blip = !scenario && random() < 0.0015;

    if ((failing && scenario?.statusCode === null) || blip) {
      result = execution(at, monitor.timeoutMs, null, {
        code: 'TIMEOUT',
        message: `No response within ${monitor.timeoutMs} ms`,
      });
    } else if (failing) {
      result = execution(at, Math.round(40 + random() * 60), {
        status: scenario?.statusCode ?? 503,
        body: '{"error":"Service Unavailable"}',
        sizeBytes: 31,
      });
    } else {
      result = execution(at, latency, {
        status: monitor.expectedStatus ?? 200,
        body: monitor.body ?? '{"ok":true}',
        sizeBytes: size,
      });
    }

    const outcome = evaluateCheck(result, settings);
    const run: GeneratedRun = {
      startedAt: at,
      success: outcome.success,
      statusCode: result.response?.status ?? null,
      durationMs: result.durationMs,
      sizeBytes: result.response?.sizeBytes ?? null,
      timedOut: result.error?.code === 'TIMEOUT',
      failureReason: outcome.failureReason,
      failureMessage: outcome.failureMessage,
    };
    runs.push(run);
    consecutiveFailures = run.success ? 0 : consecutiveFailures + 1;

    // The alert rule, evaluated after each check as the worker does.
    const { breached, value } = checkCondition(monitor.rule, {
      latestRun: { statusCode: run.statusCode, durationMs: run.durationMs },
      consecutiveFailures,
      window: null,
    });
    if (breached !== null) lastValue = value;
    const next = nextRuleState(monitor.rule, state, breached, at);
    state = { state: next.state, pendingSince: next.pendingSince };
    if (next.transition === 'fired') {
      open = {
        firedAt: at,
        resolvedAt: null,
        message: describeBreach(monitor.rule, value),
        value,
        scenario: scenario ?? null,
      };
      incidents.push(open);
    } else if (next.transition === 'resolved' && open) {
      open.resolvedAt = at;
      open = null;
    }
  }

  return {
    runs,
    incidents,
    rule: {
      ...state,
      lastValue,
      lastEvaluatedAt: runs.at(-1)?.startedAt ?? null,
    },
    consecutiveFailures,
  };
}
