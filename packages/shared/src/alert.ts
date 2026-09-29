import { z } from 'zod';
import { emailSchema } from './auth';

// ─── Rule definitions (spec §25) ─────────────────────────────────────────────

export const ALERT_METRICS = [
  'LATENCY_P95',
  'ERROR_RATE',
  'UPTIME',
  'STATUS_CODE',
  'RESPONSE_TIME',
  'CONSECUTIVE_FAILURES',
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ALERT_RULE_STATES = ['OK', 'PENDING', 'FIRING'] as const;
export type AlertRuleState = (typeof ALERT_RULE_STATES)[number];

/**
 * How each metric is measured:
 * - `window`: aggregated over the last N minutes (the duration is the window).
 * - `sustained`: checked on each run; must hold for N minutes before firing (0 = at once).
 * - `count`: a count of consecutive failed runs; no duration.
 */
export const ALERT_METRIC_INFO: Record<
  AlertMetric,
  {
    label: string;
    comparator: '>' | '<' | '=';
    unit: string;
    kind: 'window' | 'sustained' | 'count';
    min: number;
    max: number;
    integer: boolean;
  }
> = {
  LATENCY_P95: {
    label: 'P95 latency',
    comparator: '>',
    unit: 'ms',
    kind: 'window',
    min: 1,
    max: 60_000,
    integer: true,
  },
  ERROR_RATE: {
    label: 'Error rate',
    comparator: '>',
    unit: '%',
    kind: 'window',
    min: 0,
    max: 100,
    integer: false,
  },
  UPTIME: {
    label: 'Uptime',
    comparator: '<',
    unit: '%',
    kind: 'window',
    min: 0,
    max: 100,
    integer: false,
  },
  STATUS_CODE: {
    label: 'Status code',
    comparator: '=',
    unit: '',
    kind: 'sustained',
    min: 100,
    max: 599,
    integer: true,
  },
  RESPONSE_TIME: {
    label: 'Response time',
    comparator: '>',
    unit: 'ms',
    kind: 'sustained',
    min: 1,
    max: 60_000,
    integer: true,
  },
  CONSECUTIVE_FAILURES: {
    label: 'Consecutive failures',
    comparator: '>',
    unit: '',
    kind: 'count',
    min: 0,
    max: 100,
    integer: true,
  },
};

export const MAX_RULES_PER_MONITOR = 20;
export const MAX_DURATION_MINUTES = 1440;

const ruleFields = {
  monitorId: z.uuid('Choose a monitor'),
  name: z.string().trim().min(1, 'Rule name is required').max(100, 'Rule name is too long'),
  metric: z.enum(ALERT_METRICS, { error: 'Choose what to measure' }),
  threshold: z.number({ error: 'Enter a threshold' }),
  durationMinutes: z
    .number({ error: 'Enter a duration in minutes' })
    .int('Whole minutes only')
    .min(0)
    .max(MAX_DURATION_MINUTES, `At most ${MAX_DURATION_MINUTES} minutes (24 hours)`),
  severity: z.enum(SEVERITIES),
  enabled: z.boolean(),
  /** Notification channels of the workspace to notify when the rule fires or resolves. */
  channelIds: z
    .array(z.uuid())
    .max(10, 'At most 10 channels')
    .transform((ids) => [...new Set(ids)]),
};

type RuleShape = { metric: AlertMetric; threshold: number; durationMinutes: number };

/** Threshold range and duration rules that depend on the metric. */
export function alertRuleRules(rule: RuleShape, ctx: z.RefinementCtx): void {
  const info = ALERT_METRIC_INFO[rule.metric];
  if (rule.threshold < info.min || rule.threshold > info.max) {
    ctx.addIssue({
      code: 'custom',
      path: ['threshold'],
      message: `Between ${info.min} and ${info.max}${info.unit ? ` ${info.unit}` : ''}`,
    });
  } else if (info.integer && !Number.isInteger(rule.threshold)) {
    ctx.addIssue({ code: 'custom', path: ['threshold'], message: 'Use a whole number' });
  }
  if (info.kind === 'window' && rule.durationMinutes < 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['durationMinutes'],
      message: 'Measure over at least 1 minute',
    });
  }
}

export const alertRuleSchema = z.object(ruleFields).superRefine(alertRuleRules);
export type AlertRuleConfig = z.output<typeof alertRuleSchema>;
export type AlertRuleConfigInput = z.input<typeof alertRuleSchema>;

export const createAlertRuleSchema = z
  .object({
    ...ruleFields,
    durationMinutes: ruleFields.durationMinutes.default(5),
    severity: ruleFields.severity.default('HIGH'),
    enabled: ruleFields.enabled.default(true),
    channelIds: ruleFields.channelIds.default([]),
  })
  .superRefine(alertRuleRules);
export type CreateAlertRuleInput = z.input<typeof createAlertRuleSchema>;

export const updateAlertRuleSchema = z
  .object(ruleFields)
  .omit({ monitorId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateAlertRuleInput = z.input<typeof updateAlertRuleSchema>;

export const listAlertRulesQuerySchema = z
  .object({ projectId: z.uuid().optional(), monitorId: z.uuid().optional() })
  .refine((q) => q.projectId || q.monitorId, 'Give projectId or monitorId');

export const firedAlertsQuerySchema = z.object({
  projectId: z.uuid('Invalid project'),
  status: z.enum(['FIRING', 'RESOLVED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** "Error rate > 5% over 5 min", "Status code = 503 for 2 min", "Consecutive failures > 3". */
export function describeRule(rule: RuleShape): string {
  const info = ALERT_METRIC_INFO[rule.metric];
  const threshold = `${rule.threshold}${info.unit === '%' ? '%' : info.unit ? ` ${info.unit}` : ''}`;
  const base = `${info.label} ${info.comparator} ${threshold}`;
  if (info.kind === 'window') return `${base} over ${rule.durationMinutes} min`;
  if (info.kind === 'sustained' && rule.durationMinutes > 0)
    return `${base} for ${rule.durationMinutes} min`;
  return base;
}

// ─── Evaluation (pure, deterministic) ────────────────────────────────────────

export interface RuleObservation {
  /** The monitor's most recent run. */
  latestRun: { statusCode: number | null; durationMs: number | null } | null;
  consecutiveFailures: number;
  /** Aggregates over the rule's window; null when there were no runs in it. */
  window: {
    total: number;
    p95: number | null;
    errorRate: number | null;
    uptime: number | null;
  } | null;
}

/**
 * Whether the rule's condition holds right now, and the observed value.
 * `breached: null` means there is not enough data to decide (the rule keeps its state).
 */
export function checkCondition(
  rule: RuleShape,
  obs: RuleObservation,
): { breached: boolean | null; value: number | null } {
  switch (rule.metric) {
    case 'LATENCY_P95': {
      const value = obs.window?.p95 ?? null;
      return { breached: value === null ? null : value > rule.threshold, value };
    }
    case 'ERROR_RATE': {
      const value = obs.window?.errorRate ?? null;
      return { breached: value === null ? null : value > rule.threshold, value };
    }
    case 'UPTIME': {
      const value = obs.window?.uptime ?? null;
      return { breached: value === null ? null : value < rule.threshold, value };
    }
    case 'STATUS_CODE': {
      if (!obs.latestRun) return { breached: null, value: null };
      const value = obs.latestRun.statusCode;
      return { breached: value === rule.threshold, value };
    }
    case 'RESPONSE_TIME': {
      if (!obs.latestRun) return { breached: null, value: null };
      // A check without a response (timeout, refused) is slower than any threshold.
      const value = obs.latestRun.statusCode === null ? null : obs.latestRun.durationMs;
      return { breached: value === null ? true : value > rule.threshold, value };
    }
    case 'CONSECUTIVE_FAILURES': {
      const value = obs.consecutiveFailures;
      return { breached: value > rule.threshold, value };
    }
  }
}

export interface RuleStateSnapshot {
  state: AlertRuleState;
  pendingSince: Date | null;
}

export type RuleTransition = 'fired' | 'resolved' | null;

/**
 * The rule's next state (spec §25 "IF … FOR … THEN"). Sustained metrics must stay breached for
 * `durationMinutes` before firing; window metrics already cover their duration and fire at once.
 * A rule resolves as soon as its condition clears.
 */
export function nextRuleState(
  rule: RuleShape,
  current: RuleStateSnapshot,
  breached: boolean | null,
  now: Date,
): RuleStateSnapshot & { transition: RuleTransition } {
  if (breached === null) return { ...current, transition: null };
  if (!breached) {
    return {
      state: 'OK',
      pendingSince: null,
      transition: current.state === 'FIRING' ? 'resolved' : null,
    };
  }
  if (current.state === 'FIRING') return { ...current, transition: null };

  const holdMs =
    ALERT_METRIC_INFO[rule.metric].kind === 'sustained' ? rule.durationMinutes * 60_000 : 0;
  const since = current.state === 'PENDING' && current.pendingSince ? current.pendingSince : now;
  if (now.getTime() - since.getTime() >= holdMs) {
    return { state: 'FIRING', pendingSince: null, transition: 'fired' };
  }
  return { state: 'PENDING', pendingSince: since, transition: null };
}

/** "Error rate 8.7% > 5% over 5 min" — used in alert records and notifications. */
export function describeBreach(rule: RuleShape, value: number | null): string {
  const info = ALERT_METRIC_INFO[rule.metric];
  const shown =
    value === null
      ? 'no response'
      : `${Math.round(value * 100) / 100}${info.unit === '%' ? '%' : info.unit ? ` ${info.unit}` : ''}`;
  return `${info.label} ${shown} — rule: ${describeRule(rule)}`;
}

// ─── Views ───────────────────────────────────────────────────────────────────

export interface AlertRuleView extends AlertRuleConfig {
  id: string;
  projectId: string;
  monitor: { id: string; name: string };
  state: AlertRuleState;
  pendingSince: string | null;
  lastValue: number | null;
  lastEvaluatedAt: string | null;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface FiredAlertView {
  id: string;
  rule: { id: string; name: string } | null;
  monitor: { id: string; name: string };
  severity: Severity;
  status: 'FIRING' | 'RESOLVED';
  value: number | null;
  threshold: number;
  message: string;
  firedAt: string;
  resolvedAt: string | null;
}

// ─── Notification channels (spec §28) ────────────────────────────────────────

/** Only email for the MVP; the delivery layer is built so more types slot in. */
export const CHANNEL_TYPES = ['EMAIL'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const MAX_CHANNELS_PER_WORKSPACE = 20;

export const emailChannelConfigSchema = z.object({
  recipients: z
    .array(emailSchema)
    .min(1, 'Add at least one recipient')
    .max(20, 'At most 20 recipients')
    .transform((list) => [...new Set(list)]),
});
export type EmailChannelConfig = z.output<typeof emailChannelConfigSchema>;

export const createChannelSchema = z.object({
  workspaceId: z.uuid(),
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long'),
  type: z.enum(CHANNEL_TYPES),
  config: emailChannelConfigSchema,
  enabled: z.boolean().default(true),
});
export type CreateChannelInput = z.input<typeof createChannelSchema>;

export const updateChannelSchema = z
  .object({
    name: createChannelSchema.shape.name,
    config: emailChannelConfigSchema,
    enabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateChannelInput = z.input<typeof updateChannelSchema>;

export interface NotificationChannelView {
  id: string;
  workspaceId: string;
  name: string;
  type: ChannelType;
  config: EmailChannelConfig;
  enabled: boolean;
  lastDelivery: { status: 'PENDING' | 'SENT' | 'FAILED'; at: string; error: string | null } | null;
  createdAt: string;
}

export const NOTIFICATIONS_QUEUE = 'notifications';

export interface NotificationJobData {
  notificationId: string;
}

/** Email servers fail transiently; retry with backoff (30 s, 1 min, 2 min, 4 min). */
export const NOTIFICATION_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 1000 },
};
