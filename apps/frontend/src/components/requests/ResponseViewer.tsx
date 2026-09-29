import { useState } from 'react';
import { Check, Copy, Info, ShieldAlert } from 'lucide-react';
import type { ExecutionResult } from '@tracelayer/shared';
import { StatusBadge } from '@/components/StatusBadge';
import { Tabs } from '@/components/Tabs';
import { formatLatency, formatTime } from '@/utils/format';
import { prettyJson } from '@/utils/json';
import { JsonViewer } from './JsonViewer';
import { ERROR_LABELS, formatBytes, statusLabel, statusTone } from './status';

function HeaderTable({ headers, label }: { headers: [string, string][]; label: string }) {
  if (headers.length === 0) return <p className="p-3 text-sm text-fg-subtle">No headers.</p>;
  return (
    <table className="w-full text-xs">
      <caption className="sr-only">{label}</caption>
      <tbody className="divide-y divide-line">
        {headers.map(([name, value], i) => (
          <tr key={`${name}-${i}`}>
            <th scope="row" className="w-1/3 px-3 py-1.5 text-left align-top font-mono font-medium">
              {name}
            </th>
            <td className="px-3 py-1.5 font-mono break-all text-fg-muted">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function Body({ result }: { result: ExecutionResult }) {
  const [raw, setRaw] = useState(false);
  const response = result.response;
  if (!response) return null;
  if (response.bodyKind === 'empty')
    return <p className="p-3 text-sm text-fg-subtle">Empty body.</p>;
  if (response.bodyKind === 'binary' || response.body === null) {
    return (
      <p className="p-3 text-sm text-fg-subtle">
        Binary response ({response.contentType ?? 'unknown type'}, {formatBytes(response.sizeBytes)}
        ) is not displayed.
      </p>
    );
  }
  const pretty = prettyJson(response.body);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1">
        <p className="px-1 text-xs text-fg-subtle">{response.contentType ?? 'No content type'}</p>
        <div className="flex items-center">
          {pretty && (
            <button
              type="button"
              aria-pressed={raw}
              onClick={() => setRaw((r) => !r)}
              className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              {raw ? 'Pretty' : 'Raw'}
            </button>
          )}
          <CopyButton text={response.body} />
        </div>
      </div>
      {response.truncated && (
        <p className="border-b border-line bg-warn-soft px-3 py-1.5 text-xs text-warn">
          Response truncated at {formatBytes(response.sizeBytes)}.
        </p>
      )}
      {pretty && !raw ? (
        <JsonViewer json={pretty} />
      ) : (
        <pre className="overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
          {response.body}
        </pre>
      )}
    </div>
  );
}

export function ResponseViewer({ result }: { result: ExecutionResult }) {
  const [tab, setTab] = useState('body');
  const response = result.response;

  return (
    <section
      aria-label="Response"
      className="overflow-hidden rounded-lg border border-line bg-surface"
      data-testid="response-viewer"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2.5 text-xs">
        {response ? (
          <StatusBadge tone={statusTone(response.status)} label={statusLabel(response.status)} />
        ) : (
          <StatusBadge tone="failing" label={ERROR_LABELS[result.error?.code ?? ''] ?? 'Failed'} />
        )}
        <span className="font-mono tabular-nums">
          <span className="text-fg-subtle">Time </span>
          {formatLatency(result.durationMs)}
        </span>
        {response && (
          <span className="font-mono tabular-nums">
            <span className="text-fg-subtle">Size </span>
            {formatBytes(response.sizeBytes)}
          </span>
        )}
        <span className="ml-auto font-mono text-fg-subtle">{formatTime(result.startedAt)}</span>
      </div>

      {result.error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-line bg-fail-soft px-3 py-2.5 text-sm text-fail"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            <span className="font-mono text-xs">{result.error.code}</span> · {result.error.message}
          </p>
        </div>
      )}
      {result.note && (
        <p className="flex items-start gap-2 border-b border-line px-3 py-2 text-xs text-fg-muted">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {result.note}
        </p>
      )}

      <div className="px-3 pb-3">
        <Tabs
          label="Response details"
          selected={tab}
          onSelect={setTab}
          tabs={[
            ...(response ? [{ id: 'body', label: 'Body' }] : []),
            ...(response
              ? [{ id: 'headers', label: 'Headers', badge: String(response.headers.length) }]
              : []),
            { id: 'request', label: 'Request' },
          ]}
        >
          <div className="overflow-hidden rounded-md border border-line">
            {response && tab === 'body' && <Body result={result} />}
            {response && tab === 'headers' && (
              <HeaderTable headers={response.headers} label="Response headers" />
            )}
            {(tab === 'request' || !response) && (
              <div>
                <p className="border-b border-line px-3 py-2 font-mono text-xs break-all">
                  <span className="font-semibold">{result.request.method}</span>{' '}
                  {result.request.url}
                </p>
                {result.redirects.length > 0 && (
                  <ol
                    aria-label="Redirects"
                    className="border-b border-line px-3 py-2 font-mono text-xs text-fg-muted"
                  >
                    {result.redirects.map((r, i) => (
                      <li key={i}>
                        {r.status} → {r.location}
                      </li>
                    ))}
                  </ol>
                )}
                <HeaderTable headers={result.request.headers} label="Request headers" />
              </div>
            )}
          </div>
        </Tabs>
      </div>
    </section>
  );
}
