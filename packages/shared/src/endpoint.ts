import { z } from 'zod';
import { HTTP_METHODS, type HttpMethod } from './constants';

// ─── Limits ──────────────────────────────────────────────────────────────────

export const MAX_ENDPOINTS_PER_PROJECT = 200;
export const MAX_KEY_VALUE_ROWS = 50;
export const MAX_TAGS = 10;
export const MAX_BODY_LENGTH = 100_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Methods that cannot carry a request body. */
export const BODYLESS_METHODS: readonly HttpMethod[] = ['GET', 'HEAD'];

// ─── Variable templates ──────────────────────────────────────────────────────
// Endpoint fields may reference environment variables as {{NAME}}. Values are substituted when
// a request runs (Phase 6), using the environment chosen at that moment.

const VARIABLE_REFERENCE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const SINGLE_REFERENCE = /^\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/;

/** Names of the variables referenced in `text`, in order of first use. */
export function extractVariableNames(text: string): string[] {
  return [...new Set([...text.matchAll(VARIABLE_REFERENCE)].map((m) => m[1] ?? ''))];
}

function hasVariableReference(text: string): boolean {
  return extractVariableNames(text).length > 0;
}

/**
 * A field that holds a credential must be exactly one variable reference, so credentials always
 * live in (encrypted) environment variables and never in endpoint configuration, which every
 * workspace member can read.
 */
const credentialReferenceSchema = z
  .string()
  .trim()
  .regex(SINGLE_REFERENCE, 'Reference a variable, e.g. {{API_TOKEN}}');

// ─── Building blocks ─────────────────────────────────────────────────────────

/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Headers that carry credentials; their values must come from a variable. */
export const SENSITIVE_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
] as const;

export function isSensitiveHeader(name: string): boolean {
  return (SENSITIVE_HEADERS as readonly string[]).includes(name.trim().toLowerCase());
}

const keyValueBase = {
  value: z.string().max(4096, 'Value is too long'),
  enabled: z.boolean().default(true),
};

export const queryParamSchema = z.object({
  key: z.string().trim().min(1, 'Name is required').max(200, 'Name is too long'),
  ...keyValueBase,
});

export const headerSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(200, 'Name is too long')
      .regex(HEADER_NAME, 'Not a valid header name'),
    ...keyValueBase,
  })
  .refine((h) => !isSensitiveHeader(h.key) || hasVariableReference(h.value), {
    path: ['value'],
    message: 'This header carries credentials: use a variable, e.g. Bearer {{API_TOKEN}}',
  });

export type KeyValue = z.infer<typeof queryParamSchema>;

/** Replaces {{VAR}} with a JSON-safe placeholder so templated JSON can still be syntax-checked. */
function isJsonWithTemplates(text: string): boolean {
  try {
    JSON.parse(text.replace(VARIABLE_REFERENCE, '0'));
    return true;
  } catch {
    return false;
  }
}

export const endpointBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('json'),
    content: z
      .string()
      .max(MAX_BODY_LENGTH, 'Body is too large')
      .refine(isJsonWithTemplates, 'Body is not valid JSON'),
  }),
  z.object({
    type: z.literal('text'),
    content: z.string().max(MAX_BODY_LENGTH, 'Body is too large'),
  }),
  z.object({
    type: z.literal('form'),
    fields: z.array(queryParamSchema).max(MAX_KEY_VALUE_ROWS, 'Too many fields'),
  }),
]);
export type EndpointBody = z.infer<typeof endpointBodySchema>;
export type EndpointBodyType = EndpointBody['type'];

export const endpointAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: credentialReferenceSchema }),
  z.object({
    type: z.literal('basic'),
    username: z.string().trim().min(1, 'Username is required').max(200, 'Username is too long'),
    password: credentialReferenceSchema,
  }),
  z.object({
    type: z.literal('apiKey'),
    in: z.enum(['header', 'query']),
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(200, 'Name is too long')
      .regex(HEADER_NAME, 'Not a valid name'),
    value: credentialReferenceSchema,
  }),
]);
export type EndpointAuth = z.infer<typeof endpointAuthSchema>;
export type EndpointAuthType = EndpointAuth['type'];

/**
 * Either a path relative to the environment's base URL (`/orders/{{ORDER_ID}}`), a URL that
 * starts with a variable (`{{GATEWAY}}/orders`), or an absolute http(s) URL. Query parameters
 * belong in `queryParams`, so `?` and `#` are rejected here.
 */
export const endpointUrlSchema = z
  .string()
  .trim()
  .min(1, 'URL is required')
  .max(2048, 'URL is too long')
  .superRefine((value, ctx) => {
    if (value.includes('?') || value.includes('#')) {
      ctx.addIssue({ code: 'custom', message: 'Put query parameters in the Params tab' });
      return;
    }
    if (value.startsWith('/') || value.startsWith('{{')) return;
    if (!/^https?:\/\//i.test(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Use a path like /orders, or a full http(s) URL',
      });
    }
  });

export const endpointNameSchema = z
  .string()
  .trim()
  .min(1, 'Endpoint name is required')
  .max(100, 'Endpoint name is too long');

export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Tag is empty')
  .max(30, 'Tag is too long')
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Tags use letters, digits and dashes');

// ─── Endpoint configuration ──────────────────────────────────────────────────

const endpointFields = {
  name: endpointNameSchema,
  description: z
    .string()
    .trim()
    .max(500, 'Description is too long')
    .transform((v) => (v === '' ? null : v))
    .nullable(),
  method: z.enum(HTTP_METHODS, { error: 'Choose an HTTP method' }),
  url: endpointUrlSchema,
  /** The environment used by default when running this endpoint. */
  environmentId: z.uuid('Invalid environment').nullable(),
  headers: z.array(headerSchema).max(MAX_KEY_VALUE_ROWS, 'Too many headers'),
  queryParams: z.array(queryParamSchema).max(MAX_KEY_VALUE_ROWS, 'Too many parameters'),
  body: endpointBodySchema,
  auth: endpointAuthSchema,
  timeoutMs: z
    .number({ error: 'Enter a timeout in milliseconds' })
    .int()
    .min(MIN_TIMEOUT_MS, `At least ${MIN_TIMEOUT_MS} ms`)
    .max(MAX_TIMEOUT_MS, `At most ${MAX_TIMEOUT_MS} ms`),
  /** Status code that counts as success. null means "any 2xx". */
  expectedStatus: z
    .number({ error: 'Enter a status code' })
    .int()
    .min(100, 'Status codes range from 100 to 599')
    .max(599, 'Status codes range from 100 to 599')
    .nullable(),
  tags: z
    .array(tagSchema)
    .max(MAX_TAGS, `At most ${MAX_TAGS} tags`)
    .transform((tags) => [...new Set(tags)]),
};

function rejectBodyOnBodylessMethod(
  value: { method: HttpMethod; body: EndpointBody },
  ctx: z.RefinementCtx,
): void {
  if (BODYLESS_METHODS.includes(value.method) && value.body.type !== 'none') {
    ctx.addIssue({
      code: 'custom',
      path: ['body'],
      message: `${value.method} requests cannot have a body`,
    });
  }
}

/** A complete, valid endpoint configuration. */
export const endpointConfigSchema = z
  .object(endpointFields)
  .superRefine(rejectBodyOnBodylessMethod);
export type EndpointConfig = z.output<typeof endpointConfigSchema>;
export type EndpointConfigInput = z.input<typeof endpointConfigSchema>;

/** Just what is needed to send a request (no name, tags or metadata). */
export const endpointRequestSchema = z
  .object({
    method: endpointFields.method,
    url: endpointFields.url,
    headers: endpointFields.headers,
    queryParams: endpointFields.queryParams,
    body: endpointFields.body,
    auth: endpointFields.auth,
    timeoutMs: endpointFields.timeoutMs,
  })
  .superRefine(rejectBodyOnBodylessMethod);
export type EndpointRequest = z.output<typeof endpointRequestSchema>;

/** Create: sensible defaults for everything except name, method and URL. */
export const createEndpointSchema = z
  .object({
    projectId: z.uuid('Invalid project'),
    ...endpointFields,
    description: endpointFields.description.default(null),
    environmentId: endpointFields.environmentId.default(null),
    headers: endpointFields.headers.default([]),
    queryParams: endpointFields.queryParams.default([]),
    body: endpointFields.body.default({ type: 'none' }),
    auth: endpointFields.auth.default({ type: 'none' }),
    timeoutMs: endpointFields.timeoutMs.default(DEFAULT_TIMEOUT_MS),
    expectedStatus: endpointFields.expectedStatus.default(null),
    tags: endpointFields.tags.default([]),
  })
  .superRefine(rejectBodyOnBodylessMethod);
export type CreateEndpointInput = z.input<typeof createEndpointSchema>;

/**
 * Update: any subset of fields. The server merges it into the stored configuration and
 * validates the result with `endpointConfigSchema`, so cross-field rules still apply.
 */
export const updateEndpointSchema = z
  .object(endpointFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateEndpointInput = z.input<typeof updateEndpointSchema>;

export const listEndpointsQuerySchema = z.object({
  projectId: z.uuid('Invalid project'),
  search: z.string().trim().max(100).optional(),
  method: z.enum(HTTP_METHODS).optional(),
  tag: tagSchema.optional(),
});

// ─── Response types ──────────────────────────────────────────────────────────

export interface EndpointView extends EndpointConfig {
  id: string;
  projectId: string;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface LooseRow {
  key?: string;
  value?: string;
  enabled?: boolean;
}

/**
 * Everything an endpoint configuration can reference, loosely typed so it also works on a form
 * that is still being filled in (missing or invalid fields are simply skipped).
 */
export interface EndpointVariableSource {
  url?: string;
  headers?: LooseRow[];
  queryParams?: LooseRow[];
  body?: { type?: string; content?: string; fields?: LooseRow[] };
  auth?: { type?: string; [field: string]: string | undefined };
}

/** Every variable the configuration references, for "missing variable" warnings. */
export function endpointVariableNames(config: EndpointVariableSource): string[] {
  const texts: string[] = [config.url ?? ''];
  const rows = [
    ...(config.headers ?? []),
    ...(config.queryParams ?? []),
    ...(config.body?.fields ?? []),
  ];
  for (const row of rows) {
    if (row.enabled !== false) texts.push(row.key ?? '', row.value ?? '');
  }
  if (config.body?.content) texts.push(config.body.content);
  for (const [field, value] of Object.entries(config.auth ?? {})) {
    if (field !== 'type' && field !== 'in' && typeof value === 'string') texts.push(value);
  }
  return [...new Set(texts.flatMap(extractVariableNames))];
}
