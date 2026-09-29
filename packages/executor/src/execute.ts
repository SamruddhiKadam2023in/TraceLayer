import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Agent, request, type Dispatcher } from 'undici';
import type { ExecutionErrorCode, ExecutionResult } from '@tracelayer/shared';
import { maskSecrets, type PreparedRequest } from './prepare';
import { assertAllowedUrl, BlockedTargetError, createGuardedLookup } from './ssrf';

export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_REDIRECTS = 5;

export interface ExecuteOptions {
  allowPrivateNetwork?: boolean;
  maxResponseBytes?: number;
  maxRedirects?: number;
}

// One connection pool per SSRF mode. The guarded lookup runs for every new connection.
const agents = new Map<boolean, Agent>();
function agentFor(allowPrivateNetwork: boolean): Agent {
  let agent = agents.get(allowPrivateNetwork);
  if (!agent) {
    agent = new Agent({
      connect: { lookup: createGuardedLookup({ allowPrivateNetwork }) as never },
      keepAliveTimeout: 10_000,
    });
    agents.set(allowPrivateNetwork, agent);
  }
  return agent;
}

/** Closes pooled keep-alive connections; call on shutdown so the process can exit promptly. */
export async function closeConnectionPools(): Promise<void> {
  const pools = [...agents.values()];
  agents.clear();
  await Promise.all(pools.map((agent) => agent.close()));
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TEXTUAL =
  /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-ndjson))/i;

function headerList(headers: Dispatcher.ResponseData['headers']): [string, string][] {
  const list: [string, string][] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) list.push([name, v]);
  }
  return list;
}

function firstHeader(headers: Dispatcher.ResponseData['headers'], name: string): string | null {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/** Decompresses and reads the body, stopping (and marking truncated) at `limit` bytes. */
async function readBody(
  body: Readable,
  encoding: string | null,
  limit: number,
): Promise<{ bytes: Buffer; size: number; truncated: boolean }> {
  let stream: Readable = body;
  const enc = encoding?.trim().toLowerCase();
  const decoder =
    enc === 'gzip' || enc === 'x-gzip'
      ? createGunzip()
      : enc === 'deflate'
        ? createInflate()
        : enc === 'br'
          ? createBrotliDecompress()
          : null;
  if (decoder) {
    // pipeline destroys both sides on error, so a failure surfaces while iterating.
    stream = pipeline(body, decoder, () => undefined);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      // The limit applies to decoded bytes, which also defuses compression bombs.
      if (size + buffer.length > limit) {
        chunks.push(buffer.subarray(0, limit - size));
        size = limit;
        truncated = true;
        break;
      }
      chunks.push(buffer);
      size += buffer.length;
    }
  } finally {
    stream.destroy();
    body.destroy();
  }
  return { bytes: Buffer.concat(chunks), size, truncated };
}

function decodeText(bytes: Buffer, contentType: string | null): string | null {
  if (bytes.length === 0) return '';
  if (contentType && TEXTUAL.test(contentType)) return bytes.toString('utf8');
  if (contentType) return null; // declared as something non-textual
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof e.code === 'string') codes.push(e.code);
    if (typeof e.name === 'string') codes.push(e.name);
    current = e.cause;
  }
  return codes;
}

function findBlocked(err: unknown): BlockedTargetError | null {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof BlockedTargetError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function classify(err: unknown, timeoutMs: number): { code: ExecutionErrorCode; message: string } {
  const blocked = findBlocked(err);
  if (blocked) return { code: 'BLOCKED_TARGET', message: blocked.message };
  const codes = errorCodes(err);
  const has = (...names: string[]) => names.some((n) => codes.includes(n));
  if (
    has(
      'TimeoutError',
      'AbortError',
      'UND_ERR_ABORTED',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_CONNECT_TIMEOUT',
    )
  ) {
    return { code: 'TIMEOUT', message: `No complete response within ${timeoutMs} ms` };
  }
  if (has('ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME')) {
    return { code: 'DNS_FAILURE', message: 'The host name could not be resolved' };
  }
  if (has('ECONNREFUSED'))
    return { code: 'CONNECTION_REFUSED', message: 'The server refused the connection' };
  if (has('ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE')) {
    return { code: 'CONNECTION_RESET', message: 'The connection was closed unexpectedly' };
  }
  if (
    codes.some(
      (c) =>
        c.startsWith('ERR_TLS') ||
        c.startsWith('CERT_') ||
        c.includes('SELF_SIGNED') ||
        c.includes('UNABLE_TO_VERIFY'),
    )
  ) {
    return { code: 'TLS_ERROR', message: 'The TLS certificate could not be verified' };
  }
  if (has('Z_DATA_ERROR', 'Z_BUF_ERROR', 'ERR_PADDING_1', 'ERR__ERROR_FORMAT_PADDING_1')) {
    return { code: 'INVALID_RESPONSE', message: 'The response body could not be decoded' };
  }
  // Duck-typed: errors from other realms (VM contexts, workers) fail `instanceof Error`.
  const message = (err as { message?: unknown } | null)?.message;
  return {
    code: 'REQUEST_FAILED',
    message: typeof message === 'string' ? message : 'Request failed',
  };
}

/**
 * Sends a prepared request with SSRF protection, one overall deadline, manual redirect
 * handling and a response-size cap. Never throws for network outcomes: failures are returned
 * in `error`, so callers can record them like any other result.
 */
export async function executeRequest(
  prepared: PreparedRequest,
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const allowPrivateNetwork = options.allowPrivateNetwork ?? false;
  const limit = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const mask = (text: string) => maskSecrets(text, prepared.secretValues);

  const startedAt = new Date();
  const start = performance.now();
  const deadline = start + prepared.timeoutMs;
  let method: string = prepared.method;
  let url = prepared.url;
  let headers = prepared.headers;
  let body = prepared.body;
  const redirects: ExecutionResult['redirects'] = [];
  let note: string | null = null;
  let timeToFirstByteMs: number | null = null;

  const result = (partial: Pick<ExecutionResult, 'response' | 'error'>): ExecutionResult => ({
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - start),
    timeToFirstByteMs,
    request: {
      method,
      url: mask(url.href),
      headers: headers.map(([k, v]) => [k, mask(v)]),
    },
    redirects,
    note,
    ...partial,
  });

  try {
    for (;;) {
      assertAllowedUrl(url, { allowPrivateNetwork });
      // Timer APIs require whole milliseconds.
      const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
      const res = await request(url, {
        method: method as Dispatcher.HttpMethod,
        headers: headers.flat(),
        body,
        dispatcher: agentFor(allowPrivateNetwork),
        signal: AbortSignal.timeout(remaining),
        headersTimeout: remaining,
        bodyTimeout: remaining,
        maxRedirections: 0,
      });
      timeToFirstByteMs = Math.round(performance.now() - start);

      const location = firstHeader(res.headers, 'location');
      if (REDIRECT_STATUSES.has(res.statusCode) && location && redirects.length < maxRedirects) {
        await res.body.dump();
        const next = new URL(location, url);
        const crossOrigin = next.origin !== url.origin;
        if (crossOrigin && prepared.usesSecrets) {
          note = `Redirect to ${next.origin} was not followed: this request uses secret variables, which are only sent to their own origin.`;
          return result({
            response: {
              status: res.statusCode,
              statusText: '',
              headers: headerList(res.headers).map(([k, v]) => [k, mask(v)]),
              contentType: firstHeader(res.headers, 'content-type'),
              body: null,
              bodyKind: 'empty',
              sizeBytes: 0,
              truncated: false,
            },
            error: null,
          });
        }
        redirects.push({ status: res.statusCode, location: mask(next.href) });
        if (crossOrigin) {
          // Like browsers: credentials never follow a redirect to another origin.
          headers = headers.filter(([k]) => !prepared.credentialHeaders.includes(k.toLowerCase()));
        }
        const toGet =
          res.statusCode === 303
            ? method !== 'HEAD'
            : (res.statusCode === 301 || res.statusCode === 302) && method === 'POST';
        if (toGet) {
          method = 'GET';
          body = undefined;
          headers = headers.filter(
            ([k]) => !['content-type', 'content-length'].includes(k.toLowerCase()),
          );
        }
        url = next;
        continue;
      }

      const contentType = firstHeader(res.headers, 'content-type');
      const { bytes, size, truncated } = await readBody(
        res.body,
        firstHeader(res.headers, 'content-encoding'),
        limit,
      );
      const text = decodeText(bytes, contentType);
      return result({
        response: {
          status: res.statusCode,
          statusText: '',
          headers: headerList(res.headers).map(([k, v]) => [k, mask(v)]),
          contentType,
          body: text === null ? null : mask(text),
          bodyKind: size === 0 ? 'empty' : text === null ? 'binary' : 'text',
          sizeBytes: size,
          truncated,
        },
        error: null,
      });
    }
  } catch (err) {
    const error = classify(err, prepared.timeoutMs);
    return result({ response: null, error: { ...error, message: mask(error.message) } });
  }
}
