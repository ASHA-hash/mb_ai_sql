import { useState, useMemo } from "react";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  Tooltip,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  LabelList,
  CartesianGrid,
  type PieLabelRenderProps,
} from "recharts";

export const PIE_CHART_COLORS = [
  "#7c3aed", "#6366f1", "#0ea5e9", "#10b981", "#f59e0b",
  "#ef4444", "#8b5cf6", "#14b8a6", "#f97316", "#84cc16",
  "#06b6d4", "#ec4899", "#64748b", "#a855f7", "#22d3ee",
];

export const PIE_MAX_SLICES = 9;

export type PieSlice = {
  name: string;
  value: number;
  pct: number;
  isOthers?: boolean;
};

/** Recharts ignores contentStyle.color on inner labels — use custom content + itemStyle */
export const chartTooltipProps = {
  contentStyle: {
    background: "#111827",
    border: "1px solid #475569",
    borderRadius: 10,
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.22)",
    padding: "8px 12px",
  },
  itemStyle: { color: "#f8fafc", fontWeight: 600, fontSize: 12 },
  labelStyle: { color: "#e2e8f0", fontWeight: 700, fontSize: 12, marginBottom: 4 },
};

type TipPayload = { name?: string; value?: number; color?: string };

export function ErpChartTooltip({
  active,
  payload,
  label,
  formatValue,
  valueLabel = "Value",
}: {
  active?: boolean;
  payload?: TipPayload[];
  label?: string;
  formatValue?: (v: number) => string;
  valueLabel?: string;
}) {
  if (!active || !payload?.length) return null;
  const head = label ?? payload[0]?.name ?? "";

  return (
    <div
      className="erp-chart-tooltip"
      style={{
        background: "#111827",
        border: "1px solid #475569",
        borderRadius: 10,
        padding: "8px 12px",
        boxShadow: "0 8px 24px rgba(15, 23, 42, 0.22)",
        fontSize: 12,
        lineHeight: 1.45,
        minWidth: 120,
      }}
    >
      {head ? (
        <div className="erp-chart-tooltip-head" style={{ color: "#e2e8f0", fontWeight: 700, marginBottom: 4 }}>
          {head}
        </div>
      ) : null}
      {payload.map((entry, i) => {
        const raw = Number(entry?.value ?? 0);
        const formatted = formatValue ? formatValue(raw) : String(raw);
        const series = entry?.name ? String(entry.name) : valueLabel;
        const showSeries = valueLabel !== "" && series && series !== head;
        return (
          <div key={i} className="erp-chart-tooltip-row" style={{ color: "#f8fafc", fontWeight: 600 }}>
            {showSeries ? `${series}: ` : valueLabel ? `${valueLabel}: ` : ""}
            {formatted}
          </div>
        );
      })}
    </div>
  );
}

/** Top N slices + "Others (k)" — matches Node shared-core PieChart */
export function buildPieSlices(
  items: { name: string; value: number }[],
  maxSlices = PIE_MAX_SLICES,
): {
  slices: PieSlice[];
  rest: { name: string; value: number }[];
  total: number;
  othersNote: string | null;
} {
  const sorted = items
    .map((d) => ({ name: d.name.trim() || "—", value: Math.abs(d.value) || 0 }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = sorted.reduce((s, d) => s + d.value, 0);
  if (!sorted.length) {
    return { slices: [], rest: [], total: 0, othersNote: null };
  }

  const cap = Math.max(1, maxSlices);
  if (sorted.length <= cap) {
    return {
      slices: sorted.map((d) => ({
        name: d.name.length > 22 ? `${d.name.slice(0, 21)}…` : d.name,
        value: d.value,
        pct: total > 0 ? (d.value / total) * 100 : 0,
      })),
      rest: [],
      total,
      othersNote: null,
    };
  }

  const top = sorted.slice(0, cap);
  const rest = sorted.slice(cap);
  const othersVal = rest.reduce((s, d) => s + d.value, 0);
  const slices: PieSlice[] = [
    ...top.map((d) => ({
      name: d.name.length > 22 ? `${d.name.slice(0, 21)}…` : d.name,
      value: d.value,
      pct: total > 0 ? (d.value / total) * 100 : 0,
    })),
    {
      name: `Others (${rest.length})`,
      value: othersVal,
      pct: total > 0 ? (othersVal / total) * 100 : 0,
      isOthers: true,
    },
  ];

  return {
    slices,
    rest,
    total,
    othersNote: `Top ${cap} of ${sorted.length} items shown — click "Others" slice to see the rest`,
  };
}

function externalPieLabel(minPct: number) {
  return (props: PieLabelRenderProps) => {
    const p = props as unknown as {
      cx: number;
      cy: number;
      midAngle: number;
      outerRadius: number;
      percent: number;
      name: string;
    };
    const pct = (p.percent ?? 0) * 100;
    if (pct < minPct) return null;
    const RADIAN = Math.PI / 180;
    const r = Number(p.outerRadius) + 14;
    const x = p.cx + r * Math.cos(-p.midAngle * RADIAN);
    const y = p.cy + r * Math.sin(-p.midAngle * RADIAN);
    const anchor = x > p.cx ? "start" : "end";
    const dx = anchor === "start" ? 4 : -4;
    return (
      <text
        x={x + dx}
        y={y}
        textAnchor={anchor}
        dominantBaseline="central"
        fill="var(--text-strong,#1e293b)"
        style={{ fontSize: 10, fontWeight: 600, pointerEvents: "none" }}
      >
        <tspan x={x + dx} dy={-5}>
          {p.name}
        </tspan>
        <tspan x={x + dx} dy={13} fill="var(--text-muted,#64748b)" style={{ fontSize: 10, fontWeight: 700 }}>
          {pct.toFixed(1)}%
        </tspan>
      </text>
    );
  };
}

export function ErpDonutChart({
  slices,
  total,
  formatValue,
  formatTooltipValue,
  height = 300,
  othersNote,
  othersItems = [],
  title,
}: {
  slices: PieSlice[];
  total: number;
  formatValue: (v: number) => string;
  formatTooltipValue?: (v: number) => string;
  height?: number;
  othersNote?: string | null;
  othersItems?: { name: string; value: number }[];
  title?: string;
}) {
  const [othersOpen, setOthersOpen] = useState(false);
  const fmtTip = formatTooltipValue ?? formatValue;

  if (!slices.length) return null;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      {title && (
        <p className="text-xs font-semibold mb-2 m-0" style={{ color: "var(--text-muted)" }}>
          {title}
        </p>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="name"
            cx="38%"
            cy="50%"
            innerRadius="52%"
            outerRadius="74%"
            paddingAngle={2}
            stroke="var(--bg-surface,#fff)"
            strokeWidth={3}
            labelLine={{
              stroke: "var(--text-muted,#94a3b8)",
              strokeWidth: 1,
            }}
            label={externalPieLabel(2.5)}
            onClick={(_, index) => {
              if (slices[index]?.isOthers && othersItems.length) setOthersOpen(true);
            }}
          >
            {slices.map((s, i) => (
              <Cell
                key={s.name}
                fill={s.isOthers ? "#94a3b8" : PIE_CHART_COLORS[i % PIE_CHART_COLORS.length]}
                style={{ cursor: s.isOthers ? "pointer" : "default" }}
              />
            ))}
          </Pie>
          <Tooltip content={<ErpChartTooltip formatValue={(v) => fmtTip(v)} valueLabel="Value" />} />
          <Legend
            layout="vertical"
            align="right"
            verticalAlign="middle"
            iconType="circle"
            iconSize={8}
            wrapperStyle={{
              fontSize: 11,
              fontWeight: 600,
              lineHeight: "20px",
              color: "var(--text-muted)",
              paddingLeft: 8,
              maxHeight: height - 24,
              overflowY: "auto",
            }}
            formatter={(value) => (
              <span style={{ color: "var(--text-muted)" }}>
                {String(value).length > 20 ? `${String(value).slice(0, 19)}…` : value}
              </span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
      <div
        style={{
          position: "absolute",
          top: title ? "42%" : "50%",
          left: "38%",
          transform: "translate(-50%, -50%)",
          textAlign: "center",
          pointerEvents: "none",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 900, color: "var(--text-strong)", lineHeight: 1.1 }}>
          {formatValue(total)}
        </div>
        <div
          style={{
            fontSize: 8,
            fontWeight: 700,
            color: "var(--text-muted)",
            marginTop: 2,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Total
        </div>
      </div>
      {othersNote && (
        <p className="text-[11px] m-0 mt-1" style={{ color: "var(--text-muted)" }}>
          ℹ️ {othersNote}
        </p>
      )}
      {othersOpen && othersItems.length > 0 && (
        <OthersModal
          items={othersItems}
          total={othersItems.reduce((s, d) => s + d.value, 0)}
          formatValue={formatValue}
          onClose={() => setOthersOpen(false)}
        />
      )}
    </div>
  );
}

function OthersModal({
  items,
  total,
  formatValue,
  onClose,
}: {
  items: { name: string; value: number }[];
  total: number;
  formatValue: (v: number) => string;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((it) => it.name.toLowerCase().includes(s));
  }, [items, q]);

  return (
    <div
      role="dialog"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="card p-4"
        style={{ maxWidth: 420, width: "100%", maxHeight: "70vh", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-bold m-0 text-sm">Others — {items.length} items</h4>
          <button type="button" className="btn-ghost text-xs" onClick={onClose}>
            Close
          </button>
        </div>
        <input
          className="input w-full mb-2 text-sm"
          placeholder="Search…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <p className="text-xs m-0 mb-2" style={{ color: "var(--text-muted)" }}>
          Combined: {formatValue(total)}
        </p>
        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          <table className="data-table w-full text-xs">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ textAlign: "right" }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it, i) => (
                <tr key={i}>
                  <td>{it.name}</td>
                  <td style={{ textAlign: "right" }}>{formatValue(it.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function ErpHBarChart({
  rows,
  labelKey,
  valueKey,
  formatValue,
  formatAxis,
  height,
  title,
}: {
  rows: Record<string, unknown>[];
  labelKey: string;
  valueKey: string;
  formatValue: (v: number) => string;
  formatAxis?: (v: number) => string;
  height?: number;
  title?: string;
}) {
  const sorted = useMemo(
    () =>
      [...rows]
        .map((r) => ({
          label: String(r[labelKey] ?? "").slice(0, 24),
          value: Number(r[valueKey] ?? 0),
        }))
        .filter((r) => r.value > 0)
        .sort((a, b) => b.value - a.value),
    [rows, labelKey, valueKey],
  );

  if (!sorted.length) return null;

  const chartH = height ?? Math.max(200, Math.min(sorted.length * 28, 440));
  const labelW = Math.min(120, Math.max(64, sorted.reduce((m, r) => Math.max(m, r.label.length), 0) * 6));
  const fmtAxis = formatAxis ?? formatValue;

  return (
    <div style={{ width: "100%" }}>
      {title && (
        <p className="text-xs font-semibold mb-2 m-0" style={{ color: "var(--text-muted)" }}>
          {title}
        </p>
      )}
      <ResponsiveContainer width="100%" height={chartH}>
        <BarChart
          data={sorted}
          layout="vertical"
          margin={{ right: 56, left: 0, top: 4, bottom: 4 }}
          barCategoryGap="22%"
        >
          <XAxis
            type="number"
            tickFormatter={fmtAxis}
            tick={{ fontSize: 9, fill: "var(--text-muted)" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={labelW}
            tick={{ fontSize: 9, fill: "var(--text-muted)" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            content={<ErpChartTooltip formatValue={formatValue} valueLabel="Value" />}
            cursor={{ fill: "rgba(148,163,184,0.06)", rx: 4 }}
          />
          <Bar
            dataKey="value"
            radius={[0, 6, 6, 0]}
            isAnimationActive={false}
            background={{ fill: "rgba(148,163,184,0.08)", radius: 6 }}
          >
            {sorted.map((_, i) => (
              <Cell key={i} fill={PIE_CHART_COLORS[i % PIE_CHART_COLORS.length]} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v: number) => formatValue(v)}
              style={{ fontSize: 9, fill: "var(--text-muted)", fontWeight: 700 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const CY_SERIES = "#6366f1";
const LY_SERIES = "#10b981";

export type CyLyRow = {
  label: string;
  TotalSales: number;
  PY_TotalSales: number;
};

export function isCyLyComparisonRows(data: Record<string, unknown>[]): boolean {
  if (!data?.length) return false;
  const keys = new Set(Object.keys(data[0]).map((k) => k.toLowerCase()));
  const hasLabel = ["label", "period", "month"].some((k) => keys.has(k));
  const hasCy = ["totalsales", "netsales", "thismonthsales"].some((k) => keys.has(k));
  const hasLy = ["py_totalsales", "py_netsales", "lastyearmonthsales"].some((k) => keys.has(k));
  return hasLabel && hasCy && hasLy;
}

function normalizeCyLyRows(rows: Record<string, unknown>[]): CyLyRow[] {
  return rows.map((r) => {
    const label = String(r.label ?? r.Label ?? r.Period ?? r.period ?? "");
    const cy =
      Number(r.TotalSales ?? r.totalsales ?? r.NetSales ?? r.netsales ?? r.ThisMonthSales ?? 0) || 0;
    const ly =
      Number(r.PY_TotalSales ?? r.py_totalsales ?? r.LastYearMonthSales ?? r.lastyearmonthsales ?? 0) || 0;
    return { label, TotalSales: cy, PY_TotalSales: ly };
  });
}

function fmtLakhsAxis(v: number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return `${n.toFixed(2)} L`;
}

/** Grouped bar / line — Current period vs Same period last year (Analytics Home style). */
export function ErpCyLyComparisonChart({
  rows,
  kind = "bar",
  height = 360,
  title,
}: {
  rows: Record<string, unknown>[];
  kind?: "bar" | "line";
  height?: number;
  title?: string;
}) {
  const data = useMemo(() => {
    const norm = normalizeCyLyRows(rows);
    return norm.map((r) => ({
      label: r.label,
      cyL: r.TotalSales / 1e5,
      lyL: r.PY_TotalSales / 1e5,
      TotalSales: r.TotalSales,
      PY_TotalSales: r.PY_TotalSales,
    }));
  }, [rows]);

  if (!data.length) return null;

  const chartBody =
    kind === "line" ? (
      <AreaChart data={data} margin={{ top: 28, right: 16, left: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.45} />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickLine={false} />
        <YAxis
          tick={{ fontSize: 10, fill: "var(--text-muted)" }}
          tickFormatter={fmtLakhsAxis}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          content={
            <ErpChartTooltip
              formatValue={(v) => fmtLakhsAxis(v)}
              valueLabel=""
            />
          }
        />
        <Legend
          verticalAlign="top"
          align="right"
          iconType="square"
          iconSize={10}
          wrapperStyle={{ fontSize: 11, fontWeight: 600, paddingBottom: 8 }}
          formatter={(v) => (
            <span style={{ color: "var(--text-muted)" }}>
              {v === "cyL" ? "Current period" : v === "lyL" ? "Same period last year" : v}
            </span>
          )}
        />
        <Area
          type="monotone"
          dataKey="cyL"
          name="cyL"
          stroke={CY_SERIES}
          fill={CY_SERIES}
          fillOpacity={0.2}
          strokeWidth={2}
          dot={{ r: 4, fill: CY_SERIES }}
        >
          <LabelList dataKey="cyL" position="top" formatter={(v: number) => fmtLakhsAxis(v)} style={{ fontSize: 9, fontWeight: 700, fill: "var(--text-strong)" }} />
        </Area>
        <Area
          type="monotone"
          dataKey="lyL"
          name="lyL"
          stroke={LY_SERIES}
          fill={LY_SERIES}
          fillOpacity={0.15}
          strokeWidth={2}
          dot={{ r: 4, fill: LY_SERIES }}
        >
          <LabelList dataKey="lyL" position="top" formatter={(v: number) => fmtLakhsAxis(v)} style={{ fontSize: 9, fontWeight: 700, fill: "var(--text-strong)" }} />
        </Area>
      </AreaChart>
    ) : (
      <BarChart data={data} margin={{ top: 28, right: 16, left: 8, bottom: 8 }} barCategoryGap="28%" barGap={0}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.45} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickLine={false} />
        <YAxis
          tick={{ fontSize: 10, fill: "var(--text-muted)" }}
          tickFormatter={fmtLakhsAxis}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          content={
            <ErpChartTooltip
              formatValue={(v) => fmtLakhsAxis(v)}
              valueLabel=""
            />
          }
        />
        <Legend
          verticalAlign="top"
          align="right"
          iconType="square"
          iconSize={10}
          wrapperStyle={{ fontSize: 11, fontWeight: 600, paddingBottom: 8 }}
          formatter={(v) => (
            <span style={{ color: "var(--text-muted)" }}>
              {v === "cyL" ? "Current period" : v === "lyL" ? "Same period last year" : v}
            </span>
          )}
        />
        <Bar dataKey="cyL" name="cyL" fill={CY_SERIES} radius={[6, 6, 0, 0]} maxBarSize={48}>
          <LabelList dataKey="cyL" position="top" formatter={(v: number) => fmtLakhsAxis(v)} style={{ fontSize: 9, fontWeight: 700, fill: "var(--text-strong)" }} />
        </Bar>
        <Bar dataKey="lyL" name="lyL" fill={LY_SERIES} radius={[6, 6, 0, 0]} maxBarSize={48}>
          <LabelList dataKey="lyL" position="top" formatter={(v: number) => fmtLakhsAxis(v)} style={{ fontSize: 9, fontWeight: 700, fill: "var(--text-strong)" }} />
        </Bar>
      </BarChart>
    );

  return (
    <div style={{ width: "100%" }}>
      {title && (
        <p className="text-sm font-bold mb-1 m-0 uppercase tracking-wide" style={{ color: "var(--text-strong)" }}>
          {title}
        </p>
      )}
      <p className="text-[11px] m-0 mb-2" style={{ color: "var(--text-muted)" }}>
        ₹ Lakhs · 2 series
      </p>
      <ResponsiveContainer width="100%" height={height}>
        {chartBody}
      </ResponsiveContainer>
    </div>
  );
}
