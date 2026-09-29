import { ALERT_METRIC_INFO, type AlertMetric, type Severity } from '@tracelayer/shared';

export interface MessageContext {
  event: 'ALERT_FIRED' | 'ALERT_RESOLVED' | 'TEST';
  workspaceName: string;
  channelName: string;
  appUrl: string;
  alert?: {
    message: string;
    severity: Severity;
    metric: AlertMetric | null;
    value: number | null;
    threshold: number;
    firedAt: Date;
    resolvedAt: Date | null;
    ruleName: string | null;
    monitor: { id: string; name: string };
    endpoint: { method: string; url: string };
    project: { id: string; name: string };
  };
}

export interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
}

/** Everything interpolated into HTML comes from users (names, URLs), so it is escaped. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatValue(metric: AlertMetric | null, value: number | null): string {
  if (value === null) return 'no response';
  const unit = metric ? ALERT_METRIC_INFO[metric].unit : '';
  const rounded = Math.round(value * 100) / 100;
  return unit === '%' ? `${rounded}%` : unit ? `${rounded} ${unit}` : String(rounded);
}

function formatTime(date: Date): string {
  return `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/** Plain text and HTML versions of a notification (spec §28 example layout). */
export function renderMessage(ctx: MessageContext): RenderedMessage {
  if (ctx.event === 'TEST' || !ctx.alert) {
    const text = [
      'TraceLayer test notification',
      '',
      `This is a test of the "${ctx.channelName}" channel in ${ctx.workspaceName}.`,
      'If you can read this, alerts will reach you here.',
    ].join('\n');
    return {
      subject: `[TraceLayer] Test notification: ${ctx.channelName}`,
      text,
      html: `<p><strong>TraceLayer test notification</strong></p><p>This is a test of the "${escapeHtml(ctx.channelName)}" channel in ${escapeHtml(ctx.workspaceName)}.</p><p>If you can read this, alerts will reach you here.</p>`,
    };
  }

  const a = ctx.alert;
  const resolved = ctx.event === 'ALERT_RESOLVED';
  const link = `${ctx.appUrl.replace(/\/$/, '')}/projects/${a.project.id}/monitors/${a.monitor.id}`;
  const headline = resolved ? 'API RECOVERED' : 'API ALERT';
  const request = `${a.endpoint.method} ${a.endpoint.url}`;
  const rows: [string, string][] = [
    ['Severity', a.severity],
    ['Monitor', `${a.monitor.name} (${a.project.name})`],
    ['Rule', a.ruleName ?? '(deleted rule)'],
    ['Threshold', formatValue(a.metric, a.threshold)],
    [resolved ? 'Value when fired' : 'Current', formatValue(a.metric, a.value)],
    ['Detected', formatTime(a.firedAt)],
    ...(a.resolvedAt ? ([['Resolved', formatTime(a.resolvedAt)]] as [string, string][]) : []),
  ];

  const text = [
    headline,
    '',
    request,
    '',
    resolved ? 'The alert condition has cleared.' : a.message,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `Open in TraceLayer: ${link}`,
  ].join('\n');

  const html = `
<div style="font-family:system-ui,sans-serif;max-width:560px">
  <p style="font-weight:700;color:${resolved ? '#0f7a4a' : '#c0262d'};margin:0 0 8px">${headline}</p>
  <p style="font-family:monospace;font-size:14px;margin:0 0 12px">${escapeHtml(request)}</p>
  <p style="margin:0 0 12px">${escapeHtml(resolved ? 'The alert condition has cleared.' : a.message)}</p>
  <table style="border-collapse:collapse;font-size:14px">
    ${rows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`).join('')}
  </table>
  <p style="margin:16px 0 0"><a href="${escapeHtml(link)}">Open in TraceLayer</a></p>
</div>`.trim();

  const subjectPrefix = resolved ? '[Resolved]' : `[${a.severity}]`;
  return {
    subject: `${subjectPrefix} ${a.monitor.name}: ${resolved ? 'recovered' : a.message}`.slice(
      0,
      200,
    ),
    text,
    html,
  };
}
