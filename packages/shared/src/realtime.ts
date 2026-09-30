import type { Severity } from './alert';
import type { IncidentStatus } from './incident';
import type { HealthStatus } from './metrics';
import type { FailureReason } from './monitor';

// ─── Real-time updates (spec §29) ────────────────────────────────────────────

/** Socket.IO path, served by the API and proxied by nginx and Vite. */
export const REALTIME_PATH = '/socket.io';

/**
 * Redis key prefix of the Socket.IO adapter. The worker publishes with the matching emitter,
 * so events reach browsers connected to any API instance. Namespaced with QUEUE_PREFIX.
 */
export const realtimeRedisKey = (queuePrefix: string) => `${queuePrefix}:socket.io`;

/** Everyone subscribed to a workspace receives its events. */
export const workspaceRoom = (workspaceId: string) => `workspace:${workspaceId}`;
/** Every socket of one user, so access changes can reach all their tabs. */
export const userRoom = (userId: string) => `user:${userId}`;

export interface MonitorRealtimePayload {
  workspaceId: string;
  projectId: string;
  monitor: { id: string; name: string };
  run: {
    id: string;
    startedAt: string;
    success: boolean;
    statusCode: number | null;
    durationMs: number | null;
    failureReason: FailureReason | null;
  };
  health: HealthStatus;
  previousHealth: HealthStatus;
}

export interface IncidentRealtimePayload {
  workspaceId: string;
  projectId: string;
  incident: {
    id: string;
    number: number;
    title: string;
    severity: Severity;
    status: IncidentStatus;
  };
  /** What happened, so clients can word a notification. */
  change:
    | 'opened'
    | 'alert_added'
    | 'resolved_automatically'
    | 'status'
    | 'severity'
    | 'assignee'
    | 'comment'
    | 'alert_closed';
  /** The person who made the change; null for TraceLayer itself. */
  actor: { id: string; name: string } | null;
}

/** Server → client events. */
export interface RealtimeEvents {
  /** After every completed check. */
  'monitor.checked': MonitorRealtimePayload;
  /** The latest check failed after one that passed (or the first check failed). */
  'monitor.failed': MonitorRealtimePayload;
  /** The latest check passed after one that failed. */
  'monitor.recovered': MonitorRealtimePayload;
  /** The monitor's health (spec §24) changed. */
  'monitor.status_changed': MonitorRealtimePayload;
  'incident.created': IncidentRealtimePayload;
  'incident.updated': IncidentRealtimePayload;
}
export type RealtimeEventName = keyof RealtimeEvents;

export const REALTIME_EVENT_NAMES = [
  'monitor.checked',
  'monitor.failed',
  'monitor.recovered',
  'monitor.status_changed',
  'incident.created',
  'incident.updated',
] as const satisfies readonly RealtimeEventName[];

/** Acknowledgement of a client → server `subscribe`. */
export type SubscribeAck = { ok: true } | { ok: false; error: string };

/** Client → server events. */
export interface RealtimeClientEvents {
  /** Receive a workspace's events (replaces any previous workspace subscription). */
  subscribe: (workspaceId: string, ack: (result: SubscribeAck) => void) => void;
}
