import { createAlertNotifications, evaluateMonitorRules } from '../alerts/evaluate-rules';
import { publishCheckEvents } from '../realtime/check-events';
import type { RealtimePublish } from '../realtime/publisher';
import { runMonitorCheck, type CheckDependencies, type CheckResult } from './run-check';

export interface ProcessDependencies extends CheckDependencies {
  /** Queues delivery of a logged notification (BullMQ in production). */
  enqueueNotification: (notificationId: string) => Promise<void>;
  /** Sends real-time events to the monitor's workspace; omitted in tests that do not need it. */
  publish?: RealtimePublish;
  /** Reports a failure to publish (never fails the check). */
  onPublishError?: (err: unknown) => void;
}

export interface ProcessResult {
  check: CheckResult;
  fired: number;
  resolved: number;
  notificationsQueued: number;
  incidentsOpened: number;
  incidentsResolved: number;
}

/**
 * A monitor job, spec §19: run the check and store it (steps 1–12), then evaluate the alert
 * rules, open or resolve incidents and notify (steps 13–14), then publish real-time events
 * (step 15).
 */
export async function processMonitorCheck(
  monitorId: string,
  deps: ProcessDependencies,
  options: { manual?: boolean } = {},
): Promise<ProcessResult> {
  const check = await runMonitorCheck(monitorId, deps, options);
  const result: ProcessResult = {
    check,
    fired: 0,
    resolved: 0,
    notificationsQueued: 0,
    incidentsOpened: 0,
    incidentsResolved: 0,
  };
  if (check.status !== 'completed') return result;

  const evaluations = await evaluateMonitorRules(deps.prisma, monitorId);
  for (const evaluation of evaluations) {
    if (evaluation.transition === 'fired') result.fired++;
    if (evaluation.transition === 'resolved') result.resolved++;
    if (evaluation.incident?.created) result.incidentsOpened++;
    if (evaluation.incident?.resolved) result.incidentsResolved++;
    for (const notificationId of await createAlertNotifications(deps.prisma, evaluation)) {
      await deps.enqueueNotification(notificationId);
      result.notificationsQueued++;
    }
  }
  if (deps.publish) {
    try {
      await publishCheckEvents(deps.prisma, deps.publish, monitorId, check.runId, evaluations);
    } catch (err) {
      deps.onPublishError?.(err);
    }
  }
  return result;
}
