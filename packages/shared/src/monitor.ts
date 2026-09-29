import { z } from 'zod';
import type { HttpMethod } from './constants';
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from './endpoint';
import type { ExecutionResult } from './request';
import type { HealthStatus } from './metrics';

// ─── Constants ───────────────────────────────────────────────────────────────

export const MONITOR_TYPES = [
  'AVAILABILITY',
  'STATUS',
  'PERFORMANCE',
  'RESPONSE_VALIDATION',
] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

export const MONITOR_TYPE_INFO: Record<MonitorType, { label: string; description: string }> = {
  AVAILABILITY: {
    label: 'Availability',
    description: 'Passes when the server responds with any status below 500.',
  },
  STATUS: {
    label: 'Status',
    description: 'Passes when the response has the expected status code.',
  },
  PERFORMANCE: {
    label: 'Performance',
    description: 'Passes when the status is right and the response is faster than a threshold.',
  },
  RESPONSE_VALIDATION: {
    label: 'Response validation',
    description: 'Passes when the status is right and fields of the JSON body match.',
  },
};

/** Allowed check intervals, in seconds (1 minute to 1 hour). */
export const MONITOR_INTERVALS = [60, 300, 600, 900, 1800, 3600] as const;
export const MAX_MONITORS_PER_PROJECT = 50;
export const MAX_ASSERTIONS = 10;
/** Monitor runs older than this are deleted by the worker's daily maintenance job. */
export const MONITOR_RUN_RETENTION_DAYS = 30;

// ─── Assertions (response validation) ────────────────────────────────────────

export const ASSERTION_OPERATORS = [
  'equals',
  'notEquals',
  'exists',
  'notExists',
  'contains',
] as const;
export type AssertionOperator = (typeof ASSERTION_OPERATORS)[number];

/** Dot path into the JSON body: `status`, `data.items.0.id`. */
export const assertionPathSchema = z
  .string()
  .trim()
  .min(1, 'Path is required')
  .max(200, 'Path is too long')
  .regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/, 'Use a dot path such as data.items.0.id');

export const assertionSchema = z
  .object({
    path: assertionPathSchema,
    operator: z.enum(ASSERTION_OPERATORS),
    /** JSON value to compare with; ignored by exists / notExists. */
    value: z.json().optional(),
  })
  .refine((a) => a.operator === 'exists' || a.operator === 'notExists' || a.value !== undefined, {
    path: ['value'],
    message: 'Enter a value to compare with',
  });
export type Assertion = z.infer<typeof assertionSchema>;

// ─── Monitor configuration ───────────────────────────────────────────────────

/** Individual field schemas, for forms that need a variant of the full schema. */
export const monitorFieldSchemas = {
  name: z.string().trim().min(1, 'Monitor name is required').max(100, 'Monitor name is too long'),
  endpointId: z.uuid('Choose an endpoint'),
  environmentId: z.uuid('Choose an environment'),
  type: z.enum(MONITOR_TYPES, { error: 'Choose a monitor type' }),
  intervalSeconds: z
    .number()
    .int()
    .refine((v) => (MONITOR_INTERVALS as readonly number[]).includes(v), 'Choose an interval'),
  timeoutMs: z
    .number({ error: 'Enter a timeout in milliseconds' })
    .int()
    .min(MIN_TIMEOUT_MS, `At least ${MIN_TIMEOUT_MS} ms`)
    .max(MAX_TIMEOUT_MS, `At most ${MAX_TIMEOUT_MS} ms`),
  /** Expected status; null uses the endpoint's expected status, or any 2xx. */
  expectedStatus: z
    .number({ error: 'Enter a status code' })
    .int()
    .min(100, 'Status codes range from 100 to 599')
    .max(599, 'Status codes range from 100 to 599')
    .nullable(),
  latencyThresholdMs: z
    .number({ error: 'Enter a threshold in milliseconds' })
    .int()
    .min(50, 'At least 50 ms')
    .max(MAX_TIMEOUT_MS, `At most ${MAX_TIMEOUT_MS} ms`)
    .nullable(),
  assertions: z.array(assertionSchema).max(MAX_ASSERTIONS, `At most ${MAX_ASSERTIONS} checks`),
  enabled: z.boolean(),
};

type MonitorShape = {
  type: MonitorType;
  timeoutMs: number;
  latencyThresholdMs: number | null;
  assertions: unknown[];
};

/** Rules that depend on the monitor type (threshold for performance, checks for validation). */
export function monitorTypeRules(value: MonitorShape, ctx: z.RefinementCtx): void {
  if (value.type === 'PERFORMANCE') {
    if (value.latencyThresholdMs === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['latencyThresholdMs'],
        message: 'Enter a latency threshold',
      });
    } else if (value.latencyThresholdMs >= value.timeoutMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['latencyThresholdMs'],
        message: 'The threshold must be lower than the timeout',
      });
    }
  }
  if (value.type === 'RESPONSE_VALIDATION' && value.assertions.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['assertions'], message: 'Add at least one check' });
  }
}

/** A complete monitor configuration. */
export const monitorConfigSchema = z.object(monitorFieldSchemas).superRefine(monitorTypeRules);
export type MonitorConfig = z.output<typeof monitorConfigSchema>;
export type MonitorConfigInput = z.input<typeof monitorConfigSchema>;

export const createMonitorSchema = z.object({
  projectId: z.uuid('Invalid project'),
  ...monitorFieldSchemas,
  intervalSeconds: monitorFieldSchemas.intervalSeconds.default(300),
  /** Defaults to the endpoint's timeout. */
  timeoutMs: monitorFieldSchemas.timeoutMs.optional(),
  expectedStatus: monitorFieldSchemas.expectedStatus.default(null),
  latencyThresholdMs: monitorFieldSchemas.latencyThresholdMs.default(null),
  assertions: monitorFieldSchemas.assertions.default([]),
  enabled: monitorFieldSchemas.enabled.default(true),
});
export type CreateMonitorInput = z.input<typeof createMonitorSchema>;

/** Partial update; the server merges and re-validates with monitorConfigSchema. */
export const updateMonitorSchema = z
  .object(monitorFieldSchemas)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateMonitorInput = z.input<typeof updateMonitorSchema>;

export const listMonitorsQuerySchema = z.object({ projectId: z.uuid('Invalid project') });

export const monitorRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Cursor: return runs that started before this time. */
  before: z.iso.datetime({ offset: true }).optional(),
});

// ─── Views ───────────────────────────────────────────────────────────────────

export interface MonitorView extends MonitorConfig {
  id: string;
  projectId: string;
  endpoint: { id: string; name: string; method: HttpMethod; url: string };
  environment: { id: string; name: string } | null;
  lastRunAt: string | null;
  lastRunSuccess: boolean | null;
  consecutiveFailures: number;
  /** From the latest runs; see computeHealth. */
  health: HealthStatus;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export const FAILURE_REASONS = [
  'UNEXPECTED_STATUS',
  'SERVER_ERROR',
  'LATENCY_EXCEEDED',
  'ASSERTION_FAILED',
  'CONFIG_ERROR',
  'BLOCKED_TARGET',
  'TIMEOUT',
  'DNS_FAILURE',
  'CONNECTION_REFUSED',
  'CONNECTION_RESET',
  'TLS_ERROR',
  'INVALID_RESPONSE',
  'REQUEST_FAILED',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface MonitorRunView {
  id: string;
  monitorId: string;
  startedAt: string;
  success: boolean;
  statusCode: number | null;
  durationMs: number | null;
  sizeBytes: number | null;
  timedOut: boolean;
  failureReason: FailureReason | null;
  failureMessage: string | null;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

export interface CheckOutcome {
  success: boolean;
  failureReason: FailureReason | null;
  failureMessage: string | null;
}

const PASS: CheckOutcome = { success: true, failureReason: null, failureMessage: null };
const fail = (failureReason: FailureReason, failureMessage: string): CheckOutcome => ({
  success: false,
  failureReason,
  failureMessage,
});

/** Reads `data.items.0.id` from parsed JSON; `found: false` when any step is missing. */
export function readJsonPath(root: unknown, path: string): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const key of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(key) && Number(key) < current.length) {
      current = current[Number(key)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every((k) =>
      jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? 'nothing' : text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Null when the assertion holds, otherwise why it failed. */
export function checkAssertion(body: unknown, assertion: Assertion): string | null {
  const { found, value } = readJsonPath(body, assertion.path);
  switch (assertion.operator) {
    case 'exists':
      return found ? null : `${assertion.path} is missing`;
    case 'notExists':
      return found ? `${assertion.path} should be absent but is ${describe(value)}` : null;
    case 'equals':
      if (!found) return `${assertion.path} is missing`;
      return jsonEqual(value, assertion.value)
        ? null
        : `${assertion.path}: expected ${describe(assertion.value)}, got ${describe(value)}`;
    case 'notEquals':
      return found && jsonEqual(value, assertion.value)
        ? `${assertion.path} should not be ${describe(assertion.value)}`
        : null;
    case 'contains': {
      if (!found) return `${assertion.path} is missing`;
      const ok = Array.isArray(value)
        ? value.some((item) => jsonEqual(item, assertion.value))
        : typeof value === 'string' && typeof assertion.value === 'string'
          ? value.includes(assertion.value)
          : false;
      return ok ? null : `${assertion.path} does not contain ${describe(assertion.value)}`;
    }
  }
}

export interface EvaluationSettings {
  type: MonitorType;
  /** Monitor's expected status, falling back to the endpoint's; null means any 2xx. */
  expectedStatus: number | null;
  latencyThresholdMs: number | null;
  assertions: Assertion[];
}

function statusFailure(status: number, expected: number | null): CheckOutcome | null {
  if (expected !== null) {
    return status === expected
      ? null
      : fail('UNEXPECTED_STATUS', `Expected ${expected}, received ${status}`);
  }
  return status >= 200 && status < 300
    ? null
    : fail('UNEXPECTED_STATUS', `Expected a 2xx status, received ${status}`);
}

/**
 * Decides whether one check passed. Deterministic: the same result and settings always give
 * the same outcome.
 */
export function evaluateCheck(result: ExecutionResult, settings: EvaluationSettings): CheckOutcome {
  if (result.error || !result.response) {
    const code = (result.error?.code ?? 'REQUEST_FAILED') as FailureReason;
    return fail(code, result.error?.message ?? 'No response');
  }
  const { status } = result.response;

  if (settings.type === 'AVAILABILITY') {
    return status < 500 ? PASS : fail('SERVER_ERROR', `Server error: received ${status}`);
  }

  const statusProblem = statusFailure(status, settings.expectedStatus);
  if (statusProblem) return statusProblem;

  if (settings.type === 'PERFORMANCE' && settings.latencyThresholdMs !== null) {
    if (result.durationMs > settings.latencyThresholdMs) {
      return fail(
        'LATENCY_EXCEEDED',
        `Took ${result.durationMs} ms, threshold is ${settings.latencyThresholdMs} ms`,
      );
    }
  }

  if (settings.type === 'RESPONSE_VALIDATION') {
    const text = result.response.body;
    if (text === null || result.response.truncated) {
      return fail('ASSERTION_FAILED', 'The response body is not available as complete JSON');
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail('ASSERTION_FAILED', 'The response body is not valid JSON');
    }
    const problems = settings.assertions
      .map((a) => checkAssertion(body, a))
      .filter((p): p is string => p !== null);
    if (problems.length > 0) return fail('ASSERTION_FAILED', problems.join('; '));
  }

  return PASS;
}
