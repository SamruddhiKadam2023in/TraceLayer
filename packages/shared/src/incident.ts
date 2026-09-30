import { z } from 'zod';
import { SEVERITIES, type Severity } from './alert';

// ─── Incidents (spec §26–27) ─────────────────────────────────────────────────

/** Lifecycle order; RESOLVED is terminal until someone reopens the incident. */
export const INCIDENT_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'IDENTIFIED',
  'RESOLVED',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  OPEN: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  INVESTIGATING: 'Investigating',
  IDENTIFIED: 'Identified',
  RESOLVED: 'Resolved',
};

export const INCIDENT_EVENT_TYPES = [
  'DETECTED',
  'ALERT_FIRED',
  'ALERT_RESOLVED',
  'STATUS_CHANGED',
  'SEVERITY_CHANGED',
  'ASSIGNED',
  'COMMENT',
] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];

export const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export const MAX_COMMENT_LENGTH = 2000;

/** `ACTIVE` means every status except RESOLVED. */
export const INCIDENT_STATUS_FILTERS = ['ACTIVE', ...INCIDENT_STATUSES] as const;
export type IncidentStatusFilter = (typeof INCIDENT_STATUS_FILTERS)[number];

export const incidentListQuerySchema = z
  .object({
    projectId: z.uuid('Invalid project').optional(),
    workspaceId: z.uuid('Invalid workspace').optional(),
    status: z.enum(INCIDENT_STATUS_FILTERS).optional(),
    severity: z.enum(SEVERITIES).optional(),
    assigneeId: z.uuid('Invalid assignee').optional(),
    monitorId: z.uuid('Invalid monitor').optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((q) => Boolean(q.projectId) !== Boolean(q.workspaceId), {
    message: 'Give exactly one of projectId or workspaceId',
  });
export type IncidentListQuery = z.input<typeof incidentListQuerySchema>;
export type IncidentListQueryParsed = z.output<typeof incidentListQuerySchema>;

export const updateIncidentSchema = z
  .object({
    status: z.enum(INCIDENT_STATUSES, { error: 'Choose a status' }).optional(),
    severity: z.enum(SEVERITIES, { error: 'Choose a severity' }).optional(),
    /** null unassigns. */
    assigneeId: z.uuid('Invalid assignee').nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateIncidentInput = z.input<typeof updateIncidentSchema>;

export const incidentCommentSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'Write a comment')
    .max(MAX_COMMENT_LENGTH, `At most ${MAX_COMMENT_LENGTH} characters`),
});
export type IncidentCommentInput = z.input<typeof incidentCommentSchema>;

export interface IncidentSummary {
  id: string;
  projectId: string;
  /** Per-project sequence, shown as "#12". */
  number: number;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  project: { id: string; name: string };
  /** null if the monitor was deleted after the incident. */
  monitor: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  /** Alerts of this incident still firing. */
  firingAlerts: number;
  detectedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  /** null when resolved automatically (the monitor recovered) or still open. */
  resolvedBy: { id: string; name: string } | null;
}

export interface IncidentEventView {
  id: string;
  type: IncidentEventType;
  /** null for events recorded by TraceLayer itself. */
  actor: { id: string; name: string } | null;
  message: string | null;
  /** Previous and new status/severity, or the assignee's name for ASSIGNED. */
  fromValue: string | null;
  toValue: string | null;
  createdAt: string;
}

export interface IncidentAlertView {
  id: string;
  rule: { id: string; name: string } | null;
  severity: Severity;
  status: 'FIRING' | 'RESOLVED';
  message: string;
  firedAt: string;
  resolvedAt: string | null;
}

export interface IncidentDetail extends IncidentSummary {
  alerts: IncidentAlertView[];
  events: IncidentEventView[];
}

export interface IncidentPage {
  items: IncidentSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/** One line for a timeline entry, e.g. "Status changed from Open to Investigating". */
export function describeIncidentEvent(event: IncidentEventView): string {
  const label = (v: string | null) =>
    v && v in INCIDENT_STATUS_LABELS ? INCIDENT_STATUS_LABELS[v as IncidentStatus] : (v ?? '');
  switch (event.type) {
    case 'DETECTED':
      return 'Incident detected';
    case 'ALERT_FIRED':
      return `Alert triggered${event.message ? `: ${event.message}` : ''}`;
    case 'ALERT_RESOLVED':
      return `Alert resolved${event.message ? `: ${event.message}` : ''}`;
    case 'STATUS_CHANGED':
      if (event.toValue === 'RESOLVED' && !event.actor) {
        return 'Resolved automatically: the monitor recovered';
      }
      if (event.fromValue === 'RESOLVED') return `Reopened as ${label(event.toValue)}`;
      return `Status changed from ${label(event.fromValue)} to ${label(event.toValue)}`;
    case 'SEVERITY_CHANGED':
      return `Severity changed from ${event.fromValue} to ${event.toValue}${
        event.actor ? '' : ' (a more severe alert fired)'
      }`;
    case 'ASSIGNED':
      return event.toValue ? `Assigned to ${event.toValue}` : 'Unassigned';
    case 'COMMENT':
      return event.message ?? '';
  }
}
