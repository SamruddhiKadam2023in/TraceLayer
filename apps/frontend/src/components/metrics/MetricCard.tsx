import type { ReactNode } from 'react';

interface MetricCardProps {
  label: string;
  value: ReactNode;
  /** Secondary line, e.g. what the number is based on. */
  detail?: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}

const TONE: Record<NonNullable<MetricCardProps['tone']>, string> = {
  default: 'text-fg',
  good: 'text-ok',
  warn: 'text-warn',
  bad: 'text-fail',
};

export function MetricCard({ label, value, detail, tone = 'default' }: MetricCardProps) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={`mt-1 font-mono text-xl font-semibold tabular-nums ${TONE[tone]}`}>{value}</dd>
      {detail && <dd className="mt-0.5 text-xs text-fg-subtle">{detail}</dd>}
    </div>
  );
}
