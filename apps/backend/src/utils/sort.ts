/**
 * Human alphabetical order ("alpha" before "Zeta"). Database ORDER BY depends on the server's
 * collation (the Alpine Postgres image sorts by byte, putting every capital first), so small
 * lists are sorted here instead.
 */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }) || a.localeCompare(b);
}
