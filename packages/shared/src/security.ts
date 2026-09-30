// ─── Secrets and log hygiene (spec §40, §42) ─────────────────────────────────

/**
 * Development placeholders shipped in .env.example and docker-compose.yml. They are public, so a
 * production deployment that still uses one is effectively unauthenticated (anyone could sign
 * tokens or decrypt stored secrets).
 */
export const DEV_PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  'change-me-dev-access-secret-at-least-32-chars',
  'change-me-dev-refresh-secret-at-least-32-chars',
  'ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE=',
]);

/**
 * Names of the given secrets that are unsafe for production: a known placeholder, anything
 * still starting with "change-me", or two JWT secrets that are the same value.
 */
export function findInsecureSecrets(secrets: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue;
    if (DEV_PLACEHOLDER_SECRETS.has(value) || /^change-?me/i.test(value)) problems.push(name);
  }
  const { JWT_SECRET, JWT_REFRESH_SECRET } = secrets;
  if (JWT_SECRET && JWT_SECRET === JWT_REFRESH_SECRET) {
    problems.push('JWT_SECRET and JWT_REFRESH_SECRET must differ');
  }
  return problems;
}

export const REDACTED = '[REDACTED]';

/** Keys whose values never belong in logs: credentials, tokens, cookies, keys, passwords. */
const SENSITIVE_KEY =
  /authorization|cookie|passw(or)?d|secret|token|api[-_]?key|credential|signature/i;

/** Credentials that can appear inside free text, e.g. an error message quoting a header. */
const SENSITIVE_TEXT: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${REDACTED}`],
  [/\b(password|secret|token|api[-_]?key)=([^&\s"']+)/gi, `$1=${REDACTED}`],
];

const MAX_DEPTH = 8;

function redactText(text: string): string {
  return SENSITIVE_TEXT.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

/**
 * A copy of `value` safe to log: values under sensitive keys are replaced at any depth, and
 * credentials inside strings are masked. Errors become plain objects (name, message, stack and
 * their own fields) so nothing attached to them, such as request headers, escapes redaction.
 */
export function redactSensitive(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1, seen));

  const isError = value instanceof Error;
  // Plain data only; class instances such as Dates, Buffers and Maps are left as they are.
  const proto: unknown = Object.getPrototypeOf(value);
  if (!isError && proto !== Object.prototype && proto !== null) return value;

  const source: Record<string, unknown> = isError
    ? {
        type: value.name,
        message: value.message,
        stack: value.stack,
        ...(value.cause !== undefined ? { cause: value.cause } : {}),
        ...(value as unknown as Record<string, unknown>),
      }
    : (value as Record<string, unknown>);

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(item, depth + 1, seen);
  }
  return out;
}
