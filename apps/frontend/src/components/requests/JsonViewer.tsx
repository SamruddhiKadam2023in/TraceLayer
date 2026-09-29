import { useMemo } from 'react';

/** Highlighting large bodies costs more than it helps; beyond this, show plain text. */
const HIGHLIGHT_LIMIT = 200_000;

const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/g;

type Kind = 'key' | 'string' | 'literal' | 'number' | 'punct' | 'plain';

const CLASS: Record<Kind, string> = {
  key: 'text-accent',
  string: 'text-ok',
  literal: 'text-warn',
  number: 'text-warn',
  punct: 'text-fg-subtle',
  plain: '',
};

function tokenize(text: string): { kind: Kind; text: string }[] {
  const out: { kind: Kind; text: string }[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: 'plain', text: text.slice(last, index) });
    if (match[1] !== undefined) {
      out.push({ kind: match[2] ? 'key' : 'string', text: match[1] });
      if (match[2]) out.push({ kind: 'punct', text: match[2] });
    } else if (match[3] !== undefined) {
      out.push({ kind: 'literal', text: match[3] });
    } else if (match[4] !== undefined) {
      out.push({ kind: 'number', text: match[4] });
    } else {
      out.push({ kind: 'punct', text: match[0] });
    }
    last = index + match[0].length;
  }
  if (last < text.length) out.push({ kind: 'plain', text: text.slice(last) });
  return out;
}

/** Read-only, syntax-highlighted JSON. Colour is decoration; the text is always complete. */
export function JsonViewer({ json }: { json: string }) {
  const tokens = useMemo(() => (json.length <= HIGHLIGHT_LIMIT ? tokenize(json) : null), [json]);
  return (
    <pre className="overflow-auto p-3 font-mono text-xs leading-relaxed" data-testid="json-viewer">
      <code>
        {tokens
          ? tokens.map((t, i) =>
              t.kind === 'plain' ? (
                t.text
              ) : (
                <span key={i} className={CLASS[t.kind]}>
                  {t.text}
                </span>
              ),
            )
          : json}
      </code>
    </pre>
  );
}
