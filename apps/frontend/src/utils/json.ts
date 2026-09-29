/** Pretty-printed JSON if `text` parses, otherwise null. */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}
