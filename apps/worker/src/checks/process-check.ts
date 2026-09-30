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
  incidentsOpened: number;
  incidentsResolved: number;
}

/**
 * A monitor job, spec §19: run the check and store it (steps 1–12), then evaluate the alert
 * rules, open or resolve incidents and notify (steps 13–14). Real-time events (step 15) plug
 * in here in Phase 12.
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
  return result;
}
