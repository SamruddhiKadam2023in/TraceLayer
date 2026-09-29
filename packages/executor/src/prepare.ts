import type { EndpointRequest, HttpMethod, KeyValue } from '@tracelayer/shared';

/** The request part of an endpoint configuration (everything needed to send it). */
export type RequestSpec = EndpointRequest;

/** An environment with its variable values already decrypted (server side only). */
export interface ResolvedEnvironment {
  name: string;
  baseUrl: string | null;
  variables: { key: string; value: string; isSecret: boolean }[];
}

export interface PreparedRequest {
  method: HttpMethod;
  url: URL;
  headers: [string, string][];
  body: string | undefined;
  timeoutMs: number;
  /** True if any secret variable was substituted anywhere in the request. */
  usesSecrets: boolean;
  /** Header names that carry credentials and must not follow a cross-origin redirect. */
  credentialHeaders: string[];
  /** Every form in which a secret value may appear in output; masked before leaving the server. */
  secretValues: string[];
}

export type PreparationErrorCode =
  | 'MISSING_VARIABLE'
  | 'NO_BASE_URL'
  | 'INVALID_URL'
  | 'SECRET_ORIGIN_MISMATCH'
  | 'INVALID_HEADER_VALUE';

/** The request cannot be built from this configuration; nothing was sent. */
export class RequestPreparationError extends Error {
  constructor(
    readonly code: PreparationErrorCode,
    message: string,
    /** Field path in the endpoint configuration, for pointing the user at the problem. */
    readonly path?: string,
  ) {
    super(message);
    this.name = 'RequestPreparationError';
  }
}

export const DEFAULT_USER_AGENT = 'TraceLayer/0.1 (+https://github.com/tracelayer)';
const VARIABLE_REFERENCE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const LINE_BREAK = /[\r\n]/;

class Substituter {
  readonly missing = new Set<string>();
  readonly secrets = new Set<string>();
  usedSecret = false;
  private readonly variables: Map<string, { value: string; isSecret: boolean }>;

  constructor(environment: ResolvedEnvironment | null) {
    this.variables = new Map(environment?.variables.map((v) => [v.key, v]) ?? []);
  }

  apply(text: string): string {
    return text.replace(VARIABLE_REFERENCE, (_match, name: string) => {
      const variable = this.variables.get(name);
      if (!variable) {
        this.missing.add(name);
        return '';
      }
      if (variable.isSecret) {
        this.usedSecret = true;
        if (variable.value) this.secrets.add(variable.value);
      }
      return variable.value;
    });
  }
}

function enabled(rows: KeyValue[]): KeyValue[] {
  return rows.filter((row) => row.enabled !== false);
}

function hasHeader(headers: [string, string][], name: string): boolean {
  const lower = name.toLowerCase();
  return headers.some(([key]) => key.toLowerCase() === lower);
}

/**
 * Turns an endpoint configuration plus an environment into a concrete HTTP request.
 * Throws RequestPreparationError for anything that must be fixed before sending.
 */
export function prepareRequest(
  spec: RequestSpec,
  environment: ResolvedEnvironment | null,
): PreparedRequest {
  const sub = new Substituter(environment);
  const envName = environment?.name ?? 'the selected environment';

  // ── URL
  const rawUrl = sub.apply(spec.url);
  let target: string;
  if (rawUrl.startsWith('/')) {
    if (!environment?.baseUrl) {
      throw new RequestPreparationError(
        'NO_BASE_URL',
        `${environment ? `${environment.name} has` : 'No environment is selected, so there is'} no base URL for the relative path ${spec.url}`,
        'url',
      );
    }
    target = environment.baseUrl + rawUrl;
  } else {
    target = rawUrl;
  }

  // ── Headers (values may not contain line breaks: that would be header injection)
  const headers: [string, string][] = [];
  for (const row of enabled(spec.headers)) {
    headers.push([sub.apply(row.key), sub.apply(row.value)]);
  }

  // ── Query parameters
  const query: [string, string][] = enabled(spec.queryParams).map((row) => [
    sub.apply(row.key),
    sub.apply(row.value),
  ]);

  // ── Authentication
  const credentialHeaders = ['authorization', 'proxy-authorization', 'cookie'];
  const derivedSecrets: string[] = [];
  const auth = spec.auth;
  if (auth.type === 'bearer') {
    if (!hasHeader(headers, 'authorization')) {
      headers.push(['Authorization', `Bearer ${sub.apply(auth.token)}`]);
    }
  } else if (auth.type === 'basic') {
    if (!hasHeader(headers, 'authorization')) {
      const encoded = Buffer.from(
        `${sub.apply(auth.username)}:${sub.apply(auth.password)}`,
      ).toString('base64');
      headers.push(['Authorization', `Basic ${encoded}`]);
      // The password only appears base64-encoded, so mask the encoded form too.
      derivedSecrets.push(encoded);
    }
  } else if (auth.type === 'apiKey') {
    const name = sub.apply(auth.name);
    const value = sub.apply(auth.value);
    if (auth.in === 'header') {
      if (!hasHeader(headers, name)) headers.push([name, value]);
      credentialHeaders.push(name.toLowerCase());
    } else {
      query.push([name, value]);
    }
  }

  // ── Body
  let body: string | undefined;
  if (spec.body.type === 'json') {
    body = sub.apply(spec.body.content);
    if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/json']);
  } else if (spec.body.type === 'text') {
    body = sub.apply(spec.body.content);
    if (!hasHeader(headers, 'content-type')) {
      headers.push(['Content-Type', 'text/plain; charset=utf-8']);
    }
  } else if (spec.body.type === 'form') {
    body = new URLSearchParams(
      enabled(spec.body.fields).map((f): [string, string] => [
        sub.apply(f.key),
        sub.apply(f.value),
      ]),
    ).toString();
    if (!hasHeader(headers, 'content-type')) {
      headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    }
  }
  if (!hasHeader(headers, 'user-agent')) headers.push(['User-Agent', DEFAULT_USER_AGENT]);

  // ── Everything referenced must exist
  if (sub.missing.size > 0) {
    const names = [...sub.missing].join(', ');
    throw new RequestPreparationError('MISSING_VARIABLE', `Not defined in ${envName}: ${names}`);
  }

  for (const [name, value] of headers) {
    if (LINE_BREAK.test(name) || LINE_BREAK.test(value)) {
      throw new RequestPreparationError(
        'INVALID_HEADER_VALUE',
        `Header ${name.split(/[\r\n]/)[0]} would contain a line break (check its variables)`,
        'headers',
      );
    }
  }

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new RequestPreparationError('INVALID_URL', `Not a valid URL: ${target}`, 'url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RequestPreparationError(
      'INVALID_URL',
      'Only http and https URLs can be requested',
      'url',
    );
  }
  for (const [key, value] of query) url.searchParams.append(key, value);

  // ── Secrets may only be sent to the environment's own origin. Base URLs can only be set by
  // owners and admins, so this stops anyone who can edit endpoints from redirecting a secret
  // to a server they control. The origin includes the scheme: no downgrade to plain http.
  if (sub.usedSecret) {
    const allowed = environment?.baseUrl ? new URL(environment.baseUrl).origin : null;
    if (!allowed) {
      throw new RequestPreparationError(
        'SECRET_ORIGIN_MISMATCH',
        `This request uses secret variables, which are only sent to the environment's base URL. Set a base URL for ${envName} first.`,
        'url',
      );
    }
    if (url.origin !== allowed) {
      throw new RequestPreparationError(
        'SECRET_ORIGIN_MISMATCH',
        `Secret variables can only be sent to ${allowed} (the base URL of ${envName}), not ${url.origin}`,
        'url',
      );
    }
  }

  // Secrets can show up raw, percent-encoded (in URLs) or form-encoded (in bodies and queries).
  const secretValues = new Set<string>(derivedSecrets);
  for (const secret of sub.secrets) {
    secretValues.add(secret);
    secretValues.add(encodeURIComponent(secret));
    secretValues.add(new URLSearchParams({ s: secret }).toString().slice(2));
  }

  return {
    method: spec.method,
    url,
    headers,
    body,
    timeoutMs: spec.timeoutMs,
    usesSecrets: sub.usedSecret,
    credentialHeaders,
    // Longest first, so a secret that contains another is masked whole.
    secretValues: [...secretValues].filter(Boolean).sort((a, b) => b.length - a.length),
  };
}

export const SECRET_MASK = '••••••';

/** Replaces every occurrence of every secret value. Applied to everything sent to a client. */
export function maskSecrets(text: string, secretValues: string[]): string {
  let masked = text;
  for (const secret of secretValues) masked = masked.split(secret).join(SECRET_MASK);
  return masked;
}
