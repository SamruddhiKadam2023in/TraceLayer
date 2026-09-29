import { createAlertNotifications, evaluateMonitorRules } from '../alerts/evaluate-rules';
import { runMonitorCheck, type CheckDependencies, type CheckResult } from './run-check';

export interface ProcessDependencies extends CheckDependencies {
  /** Queues delivery of a logged notification (BullMQ in production). */
  enqueueNotification: (notificationId: string) => Promise<void>;
}

export interface ProcessResult {
  check: CheckResult;
  fired: number;
  resolved: number;
  notificationsQueued: number;
}

/**
 * A monitor job, spec §19: run the check and store it (steps 1–12), then evaluate the alert
 * rules and notify (step 13). Incidents (step 14) and real-time events (step 15) plug in
 * after rule evaluation in Phases 11–12.
 */
export async function processMonitorCheck(
  monitorId: string,
  deps: ProcessDependencies,
  options: { manual?: boolean } = {},
): Promise<ProcessResult> {
  const check = await runMonitorCheck(monitorId, deps, options);
  const result: ProcessResult = { check, fired: 0, resolved: 0, notificationsQueued: 0 };
  if (check.status !== 'completed') return result;

  const evaluations = await evaluateMonitorRules(deps.prisma, monitorId);
  for (const evaluation of evaluations) {
    if (evaluation.transition === 'fired') result.fired++;
    if (evaluation.transition === 'resolved') result.resolved++;
    for (const notificationId of await createAlertNotifications(deps.prisma, evaluation)) {
      await deps.enqueueNotification(notificationId);
      result.notificationsQueued++;
    }
  }
  return result;
}
