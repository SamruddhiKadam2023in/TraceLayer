import { z } from 'zod';
import { HTTP_METHODS, type HttpMethod } from './constants';
import { endpointRequestSchema } from './endpoint';

// ─── Execution results (produced by @tracelayer/executor, shown by the frontend) ─────

export type ExecutionErrorCode =
  | 'BLOCKED_TARGET'
  | 'TIMEOUT'
  | 'DNS_FAILURE'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_RESET'
  | 'TLS_ERROR'
  | 'INVALID_RESPONSE'
  | 'REQUEST_FAILED';

export interface ExecutionResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  contentType: string | null;
  /** Decoded text with secrets masked. Null for binary or empty bodies. */
  body: string | null;
  bodyKind: 'text' | 'binary' | 'empty';
  /** Decoded body size in bytes (counted up to the limit). */
  sizeBytes: number;
  truncated: boolean;
}

export interface ExecutionResult {
  startedAt: string;
  /** Total time including redirects and reading the body. */
  durationMs: number;
  /** Time until the final response's headers arrived. */
  timeToFirstByteMs: number | null;
  /** What was actually sent, with secrets masked. */
  request: { method: string; url: string; headers: [string, string][] };
  redirects: { status: number; location: string }[];
  /** Set when a redirect was deliberately not followed. */
  note: string | null;
  response: ExecutionResponse | null;
  error: { code: ExecutionErrorCode; message: string } | null;
}

// ─── Executing a request ─────────────────────────────────────────────────────

export const executeRequestSchema = z.object({
  projectId: z.uuid('Invalid project'),
  /** Variables and the base URL come from this environment. */
  environmentId: z.uuid('Invalid environment').nullable(),
  /** The saved endpoint this run belongs to, if any (for history). */
  endpointId: z.uuid('Invalid endpoint').nullable().default(null),
  /** The request to send: usually the endpoint's configuration, possibly with unsaved edits. */
  request: endpointRequestSchema,
  saveToHistory: z.boolean().default(true),
});
export type ExecuteRequestInput = z.input<typeof executeRequestSchema>;

export interface ExecuteRequestResponse {
  result: ExecutionResult;
  /** Id of the history entry, or null when not saved. */
  historyId: string | null;
}

// ─── Request history ─────────────────────────────────────────────────────────

export const HISTORY_STATUS_FILTERS = ['2xx', '3xx', '4xx', '5xx', 'error'] as const;
export type HistoryStatusFilter = (typeof HISTORY_STATUS_FILTERS)[number];

export const HISTORY_SORT_FIELDS = ['createdAt', 'durationMs', 'status'] as const;

const isoDate = z.iso.datetime({ offset: true, error: 'Use an ISO 8601 date-time' });

export const historyQuerySchema = z
  .object({
    projectId: z.uuid('Invalid project'),
    endpointId: z.uuid('Invalid endpoint').optional(),
    environmentId: z.uuid('Invalid environment').optional(),
    method: z.enum(HTTP_METHODS).optional(),
    status: z.enum(HISTORY_STATUS_FILTERS).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    /** Case-insensitive match on the URL. */
    search: z.string().trim().max(200).optional(),
    sort: z.enum(HISTORY_SORT_FIELDS).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    path: ['to'],
    message: '"to" must not be before "from"',
  });
export type HistoryQuery = z.input<typeof historyQuerySchema>;
/** A validated history query, with defaults applied. */
export type HistoryQueryParsed = z.output<typeof historyQuerySchema>;

export interface HistoryEntry {
  id: string;
  projectId: string;
  endpoint: { id: string; name: string } | null;
  environment: { id: string; name: string } | null;
  user: { id: string; name: string } | null;
  method: HttpMethod;
  /** Final URL, secrets masked. */
  url: string;
  status: number | null;
  errorCode: ExecutionErrorCode | null;
  errorMessage: string | null;
  durationMs: number;
  sizeBytes: number | null;
  createdAt: string;
}

export interface HistoryPage {
  items: HistoryEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** Older entries beyond this many per project are pruned. */
export const HISTORY_RETENTION_PER_PROJECT = 5000;
