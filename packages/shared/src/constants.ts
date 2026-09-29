export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const QUEUE_NAMES = {
  MONITOR_CHECKS: 'monitor-checks',
} as const;

export const REDIS_KEYS = {
  /** Set by the worker with a TTL; its presence means a worker is alive. */
  WORKER_HEARTBEAT: 'tracelayer:worker:heartbeat',
} as const;

export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_HEARTBEAT_TTL_SECONDS = 30;
