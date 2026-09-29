import {
  alertRuleSchema,
  checkCondition,
  describeBreach,
  describeRule,
  nextRuleState,
  type AlertMetric,
  type RuleObservation,
} from '@tracelayer/shared';

const rule = (metric: AlertMetric, threshold: number, durationMinutes = 5) => ({
  metric,
  threshold,
  durationMinutes,
});

const obs = (overrides: Partial<RuleObservation> = {}): RuleObservation => ({
  latestRun: { statusCode: 200, durationMs: 120 },
  consecutiveFailures: 0,
  window: { total: 10, p95: 400, errorRate: 10, uptime: 90 },
  ...overrides,
});

describe('checkCondition', () => {
  it.each([
    ['LATENCY_P95', 300, obs(), true, 400],
    ['LATENCY_P95', 500, obs(), false, 400],
    ['ERROR_RATE', 5, obs(), true, 10],
    ['ERROR_RATE', 10, obs(), false, 10], // strictly greater
    ['UPTIME', 95, obs(), true, 90],
    ['UPTIME', 90, obs(), false, 90], // strictly less
    ['STATUS_CODE', 503, obs({ latestRun: { statusCode: 503, durationMs: 50 } }), true, 503],
    ['STATUS_CODE', 503, obs(), false, 200],
    ['RESPONSE_TIME', 100, obs(), true, 120],
    ['RESPONSE_TIME', 200, obs(), false, 120],
    ['CONSECUTIVE_FAILURES', 2, obs({ consecutiveFailures: 3 }), true, 3],
    ['CONSECUTIVE_FAILURES', 3, obs({ consecutiveFailures: 3 }), false, 3],
  ] as const)(
    '%s with threshold %d → breached %s',
    (metric, threshold, observation, breached, value) => {
      expect(checkCondition(rule(metric, threshold), observation)).toEqual({ breached, value });
    },
  );

  it('cannot decide without data, and treats a missing response as too slow', () => {
    expect(checkCondition(rule('ERROR_RATE', 5), obs({ window: null }))).toEqual({
      breached: null,
      value: null,
    });
    expect(checkCondition(rule('STATUS_CODE', 500), obs({ latestRun: null })).breached).toBeNull();
    expect(
      checkCondition(
        rule('RESPONSE_TIME', 1000),
        obs({ latestRun: { statusCode: null, durationMs: 5000 } }),
      ),
    ).toEqual({ breached: true, value: null });
  });
});

describe('nextRuleState', () => {
  const t0 = new Date('2026-09-30T10:00:00Z');
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  const ok = { state: 'OK' as const, pendingSince: null };

  it('fires window rules as soon as they breach (the window is the duration)', () => {
    expect(nextRuleState(rule('ERROR_RATE', 5, 5), ok, true, t0)).toEqual({
      state: 'FIRING',
      pendingSince: null,
      transition: 'fired',
    });
  });

  it('holds sustained rules in PENDING until the duration has passed', () => {
    const r = rule('RESPONSE_TIME', 500, 3);
    const first = nextRuleState(r, ok, true, t0);
    expect(first).toEqual({ state: 'PENDING', pendingSince: t0, transition: null });
    expect(nextRuleState(r, first, true, at(2))).toEqual({
      state: 'PENDING',
      pendingSince: t0,
      transition: null,
    });
    expect(nextRuleState(r, first, true, at(3))).toEqual({
      state: 'FIRING',
      pendingSince: null,
      transition: 'fired',
    });
  });

  it('forgets a pending breach that clears before the duration (no flapping alerts)', () => {
    const r = rule('RESPONSE_TIME', 500, 3);
    const pending = nextRuleState(r, ok, true, t0);
    expect(nextRuleState(r, pending, false, at(1))).toEqual({
      state: 'OK',
      pendingSince: null,
      transition: null,
    });
  });

  it('fires sustained rules at once with a zero duration, and count rules always at once', () => {
    expect(nextRuleState(rule('STATUS_CODE', 503, 0), ok, true, t0).transition).toBe('fired');
    expect(nextRuleState(rule('CONSECUTIVE_FAILURES', 3, 0), ok, true, t0).transition).toBe(
      'fired',
    );
  });

  it('stays firing without re-firing, resolves when clear, and keeps state without data', () => {
    const firing = { state: 'FIRING' as const, pendingSince: null };
    const r = rule('ERROR_RATE', 5);
    expect(nextRuleState(r, firing, true, t0).transition).toBeNull();
    expect(nextRuleState(r, firing, false, t0)).toEqual({
      state: 'OK',
      pendingSince: null,
      transition: 'resolved',
    });
    expect(nextRuleState(r, firing, null, t0)).toEqual({ ...firing, transition: null });
  });
});

describe('rule descriptions and validation', () => {
  it('describes rules in words', () => {
    expect(describeRule(rule('ERROR_RATE', 5, 5))).toBe('Error rate > 5% over 5 min');
    expect(describeRule(rule('STATUS_CODE', 503, 2))).toBe('Status code = 503 for 2 min');
    expect(describeRule(rule('RESPONSE_TIME', 800, 0))).toBe('Response time > 800 ms');
    expect(describeRule(rule('CONSECUTIVE_FAILURES', 3, 0))).toBe('Consecutive failures > 3');
    expect(describeBreach(rule('ERROR_RATE', 5, 5), 8.666)).toBe(
      'Error rate 8.67% — rule: Error rate > 5% over 5 min',
    );
  });

  it('validates thresholds per metric', () => {
    const base = {
      monitorId: '00000000-0000-4000-8000-000000000000',
      name: 'r',
      durationMinutes: 5,
      severity: 'HIGH',
      enabled: true,
      channelIds: [],
    } as const;
    const issues = (metric: AlertMetric, threshold: number, durationMinutes = 5) => {
      const parsed = alertRuleSchema.safeParse({ ...base, metric, threshold, durationMinutes });
      return parsed.success
        ? []
        : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    expect(issues('ERROR_RATE', 150)).toEqual(['threshold: Between 0 and 100 %']);
    expect(issues('STATUS_CODE', 99)).toEqual(['threshold: Between 100 and 599']);
    expect(issues('LATENCY_P95', 10.5)).toEqual(['threshold: Use a whole number']);
    expect(issues('UPTIME', 99.9)).toEqual([]);
    expect(issues('ERROR_RATE', 5, 0)).toEqual(['durationMinutes: Measure over at least 1 minute']);
    expect(issues('STATUS_CODE', 503, 0)).toEqual([]);
  });
});
