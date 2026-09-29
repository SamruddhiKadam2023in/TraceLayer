import type { Prisma, PrismaClient } from '@tracelayer/db';
import {
  executeRequest,
  prepareRequest,
  RequestPreparationError,
  type ResolvedEnvironment,
  type SecretBox,
} from '@tracelayer/executor';
import {
  assertionSchema,
  endpointRequestSchema,
  evaluateCheck,
  type CheckOutcome,
  type ExecutionResult,
} from '@tracelayer/shared';

export interface CheckDependencies {
  prisma: PrismaClient;
  secrets: Pick<SecretBox, 'decrypt'>;
  allowPrivateNetwork: boolean;
}

export type CheckResult =
  | { status: 'skipped'; reason: 'monitor-deleted' | 'monitor-paused' }
  | { status: 'completed'; runId: string; success: boolean };

const monitorInclude = {
  endpoint: true,
  environment: { include: { variables: true } },
} as const satisfies Prisma.MonitorInclude;

type MonitorWithTarget = Prisma.MonitorGetPayload<{ include: typeof monitorInclude }>;

interface RunRecord {
  startedAt: Date;
  outcome: CheckOutcome;
  result: ExecutionResult | null;
}

function resolveEnvironment(
  monitor: MonitorWithTarget,
  secrets: CheckDependencies['secrets'],
): ResolvedEnvironment | null {
  const environment = monitor.environment;
  if (!environment) return null;
  return {
    name: environment.name,
    baseUrl: environment.baseUrl,
    variables: environment.variables.map((v) => ({
      key: v.key,
      isSecret: v.isSecret,
      value: v.isSecret ? secrets.decrypt(v.encryptedValue ?? '') : (v.value ?? ''),
    })),
  };
}

function configError(message: string): CheckOutcome {
  return { success: false, failureReason: 'CONFIG_ERROR', failureMessage: message };
}

/** Steps 2–11: load the configuration, build the request, execute it and judge the result. */
async function performCheck(
  monitor: MonitorWithTarget,
  deps: CheckDependencies,
): Promise<RunRecord> {
  const startedAt = new Date();
  if (!monitor.environment) {
    return {
      startedAt,
      outcome: configError('The monitor has no environment (it may have been deleted)'),
      result: null,
    };
  }

  // Validate the stored configuration again: the endpoint may have changed since the monitor
  // was saved. The monitor's own timeout replaces the endpoint's.
  const request = endpointRequestSchema.safeParse({
    method: monitor.endpoint.method,
    url: monitor.endpoint.url,
    headers: monitor.endpoint.headers,
    queryParams: monitor.endpoint.queryParams,
    body: monitor.endpoint.body,
    auth: monitor.endpoint.auth,
    timeoutMs: monitor.timeoutMs,
  });
  if (!request.success) {
    return {
      startedAt,
      outcome: configError('The endpoint configuration is invalid'),
      result: null,
    };
  }

  let prepared;
  try {
    prepared = prepareRequest(request.data, resolveEnvironment(monitor, deps.secrets));
  } catch (err) {
    if (err instanceof RequestPreparationError) {
      return { startedAt, outcome: configError(err.message), result: null };
    }
    throw err;
  }

  // Steps 3–11: SSRF validation, the request, timing, status, size, timeout and connection
  // failures are all handled by the executor (the same code as manual requests).
  const result = await executeRequest(prepared, { allowPrivateNetwork: deps.allowPrivateNetwork });
  const outcome = evaluateCheck(result, {
    type: monitor.type,
    expectedStatus: monitor.expectedStatus ?? monitor.endpoint.expectedStatus,
    latencyThresholdMs: monitor.latencyThresholdMs,
    assertions: assertionSchema.array().catch([]).parse(monitor.assertions),
  });
  return { startedAt: new Date(result.startedAt), outcome, result };
}

/**
 * Runs one monitor check end to end and stores the result (spec §19, steps 1–12).
 * Steps 13–15 (alert rules, incidents, real-time updates) plug in after `persist` in later
 * phases; step 16 (next execution) is the BullMQ scheduler's job.
 */
export async function runMonitorCheck(
  monitorId: string,
  deps: CheckDependencies,
  options: { manual?: boolean } = {},
): Promise<CheckResult> {
  const monitor = await deps.prisma.monitor.findUnique({
    where: { id: monitorId },
    include: monitorInclude,
  });
  if (!monitor) return { status: 'skipped', reason: 'monitor-deleted' };
  // A scheduled job can still fire just after the monitor was paused; manual runs always go.
  if (!monitor.enabled && !options.manual) return { status: 'skipped', reason: 'monitor-paused' };

  const { startedAt, outcome, result } = await performCheck(monitor, deps);

  // Step 12: persist the run and refresh the monitor's cached state atomically.
  const run = await deps.prisma.$transaction(async (tx) => {
    const created = await tx.monitorRun.create({
      data: {
        monitorId: monitor.id,
        projectId: monitor.projectId,
        endpointId: monitor.endpointId,
        environmentId: monitor.environmentId,
        startedAt,
        success: outcome.success,
        statusCode: result?.response?.status ?? null,
        durationMs: result ? result.durationMs : null,
        sizeBytes: result?.response?.sizeBytes ?? null,
        timedOut: result?.error?.code === 'TIMEOUT',
        failureReason: outcome.failureReason,
        failureMessage: outcome.failureMessage?.slice(0, 500) ?? null,
      },
      select: { id: true },
    });
    await tx.monitor.update({
      where: { id: monitor.id },
      data: {
        lastRunAt: startedAt,
        lastRunSuccess: outcome.success,
        // Atomic increment: concurrent runs of one monitor cannot lose a failure.
        consecutiveFailures: outcome.success ? 0 : { increment: 1 },
      },
    });
    return created;
  });

  return { status: 'completed', runId: run.id, success: outcome.success };
}
