import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ErrorPoint, LatencyPoint, MetricRange, StatusDistribution } from '@tracelayer/shared';
import { useChartColors, type ChartColors } from '@/hooks/useChartColors';
import { formatMs, formatTick, formatTooltipTime } from './chart-format';

function axes(colors: ChartColors, range: MetricRange, yFormat: (v: number) => string) {
  const tick = { fill: colors.subtle, fontSize: 11 };
  return [
    <CartesianGrid key="grid" stroke={colors.grid} strokeDasharray="3 3" vertical={false} />,
    <XAxis
      key="x"
      dataKey="t"
      tickFormatter={(t: string) => formatTick(t, range)}
      tick={tick}
      stroke={colors.grid}
      minTickGap={32}
    />,
    <YAxis key="y" tickFormatter={yFormat} tick={tick} stroke={colors.grid} width={56} />,
  ];
}

function tooltipStyle(colors: ChartColors) {
  return {
    contentStyle: {
      background: colors.surface,
      border: `1px solid ${colors.grid}`,
      borderRadius: 6,
      fontSize: 12,
    },
    labelStyle: { color: colors.text },
    labelFormatter: (t: unknown) => formatTooltipTime(String(t)),
  };
}

/** Latency percentiles over time. Gaps (no responses) stay gaps. */
export function LatencyChart({ points, range }: { points: LatencyPoint[]; range: MetricRange }) {
  const colors = useChartColors();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        {axes(colors, range, (v) => formatMs(v))}
        <Tooltip {...tooltipStyle(colors)} formatter={(v) => formatMs(v as number)} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey="avg"
          name="Average"
          stroke={colors.accent}
          dot={false}
          strokeWidth={2}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="p95"
          name="P95"
          stroke={colors.warn}
          dot={false}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="p99"
          name="P99"
          stroke={colors.fail}
          dot={false}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Error rate (%) per bucket. */
export function ErrorRateChart({ points, range }: { points: ErrorPoint[]; range: MetricRange }) {
  const colors = useChartColors();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        {axes(colors, range, (v) => `${v}%`)}
        <Tooltip
          {...tooltipStyle(colors)}
          formatter={(v) =>
            v === null || v === undefined ? 'no checks' : `${Number(v).toFixed(2)}%`
          }
        />
        <Area
          type="monotone"
          dataKey="errorRate"
          name="Error rate"
          stroke={colors.fail}
          fill={colors.fail}
          fillOpacity={0.15}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Checks per bucket, split into passed and failed. */
export function VolumeChart({ points, range }: { points: ErrorPoint[]; range: MetricRange }) {
  const colors = useChartColors();
  const data = points.map((p) => ({ t: p.t, passed: p.total - p.failed, failed: p.failed }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        {axes(colors, range, (v) => String(v))}
        <Tooltip {...tooltipStyle(colors)} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar
          dataKey="passed"
          name="Passed"
          stackId="v"
          fill={colors.ok}
          isAnimationActive={false}
        />
        <Bar
          dataKey="failed"
          name="Failed"
          stackId="v"
          fill={colors.fail}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Share of checks per status class, as a donut with the counts in its legend. */
export function StatusCodesChart({ distribution }: { distribution: StatusDistribution }) {
  const colors = useChartColors();
  const data = [
    { name: '2xx', value: distribution['2xx'], color: colors.ok },
    { name: '3xx', value: distribution['3xx'], color: colors.accent },
    { name: '4xx', value: distribution['4xx'], color: colors.warn },
    { name: '5xx', value: distribution['5xx'], color: colors.fail },
    { name: 'No response', value: distribution.noResponse, color: colors.subtle },
  ].filter((d) => d.value > 0);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="55%"
          outerRadius="85%"
          paddingAngle={1}
          isAnimationActive={false}
        >
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} stroke={colors.surface} />
          ))}
        </Pie>
        <Tooltip contentStyle={tooltipStyle(colors).contentStyle} />
        <Legend
          layout="vertical"
          align="right"
          verticalAlign="middle"
          wrapperStyle={{ fontSize: 12 }}
          formatter={(name: string, entry) =>
            `${name}: ${(entry.payload as { value?: number } | undefined)?.value ?? 0}`
          }
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
