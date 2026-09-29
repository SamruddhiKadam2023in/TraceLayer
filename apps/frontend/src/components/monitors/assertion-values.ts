/**
 * Assertion values are typed as JSON: `200` is a number, `true` a boolean, `healthy` a string.
 * To compare with the string "200", write it quoted: `"200"`.
 */
export function parseAssertionValue(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Inverse of parseAssertionValue, so editing and saving never changes a value's type. */
export function formatAssertionValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    // A string that would parse as JSON (e.g. "200") must stay quoted to remain a string.
    try {
      JSON.parse(value);
      return JSON.stringify(value);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value);
}
