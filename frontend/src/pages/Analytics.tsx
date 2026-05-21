import { useState, useEffect, useCallback, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid,
  Cell, LabelList,
} from "recharts";
import { analytics, type AnalyticsSnapshot, type AnalyticsSnapshotOpts } from "../lib/api";
import { formatINR, formatNum } from "../lib/utils";
import { ErpChartTooltip } from "../components/ErpCharts";

const PERIOD_CHIPS = [
  { key: "mtd", label: "MTD" },
  { key: "qtd", label: "QTD" },
  { key: "ytd", label: "YTD" },
  { key: "last_30d", label: "30d" },
  { key: "last_90d", label: "90d" },
  { key: "6m", label: "Last 6M" },
  { key: "last_180d", label: "180d" },
  { key: "custom", label: "Custom" },
] as const;

type PeriodKey = (typeof PERIOD_CHIPS)[number]["key"];

const LAYOUT_PRESETS = {
  default: { kpi: 10, trend: 20, breakdown: 30 },
  trend_first: { kpi: 20, trend: 10, breakdown: 30 },
  breakdown_first: { kpi: 10, breakdown: 20, trend: 30 },
} as const;

type LayoutKey = keyof typeof LAYOUT_PRESETS;

interface SavedView {
  name: string;
  period: string;
  fy: string;
  customFrom: string;
  customTo: string;
  crossFilter: Record<string, string>;
  trendMonth: string;
  trendGrain: string;
  layoutPreset: LayoutKey;
  barOrientation: "vertical" | "horizontal";
}

const BAR_COLORS = [
  "#7c3aed","#6366f1","#0ea5e9","#10b981","#f59e0b",
  "#ef4444","#8b5cf6","#14b8a6","#f97316","#84cc16",
];

function BreakdownChart({
  title,
  rows,
  loading,
  horizontal,
  activeLabel,
  onBarClick,
}: {
  title: string;
  rows: { label: string; value: number; bills: number }[];
  loading: boolean;
  horizontal: boolean;
  activeLabel?: string;
  onBarClick?: (label: string) => void;
}) {
  const top = rows.slice(0, 8);
  if (loading) {
    return (
      <div className="chart-wrapper">
        <p className="text-sm py-12 text-center" style={{ color: "var(--text-muted)" }}>Loading…</p>
      </div>
    );
  }
  if (top.length === 0) {
    return (
      <div className="chart-wrapper">
        <p className="text-sm py-12 text-center" style={{ color: "var(--text-muted)" }}>No data</p>
      </div>
    );
  }
  const maxVal = top.reduce((m, r) => Math.max(m, r.value), 0);
  const fmtL = (v: number) => `₹${(v / 1e5).toFixed(0)}L`;
  const labelW = Math.min(80, Math.max(44, top.reduce((m, r) => Math.max(m, r.label.length), 0) * 5.5));

  return (
    <div className="chart-wrapper" style={{
      background: "var(--bg-surface)",
      borderRadius: 14,
      border: "1px solid var(--border)",
      padding: "14px 12px",
      boxShadow: "0 2px 12px rgba(0,0,0,0.05)",
    }}>
      <div className="text-sm font-bold mb-3" style={{ color: "var(--text-strong)", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          display: "inline-block", width: 8, height: 8, borderRadius: 2,
          background: `linear-gradient(135deg, ${BAR_COLORS[0]}, ${BAR_COLORS[2]})`,
        }} />
        {title}
        <span className="font-normal text-xs ml-1" style={{ color: "var(--text-muted)" }}>
          · click to filter
        </span>
      </div>
      <ResponsiveContainer width="100%" height={horizontal ? Math.max(180, top.length * 30) : 220}>
        <BarChart
          data={top}
          layout={horizontal ? "vertical" : "horizontal"}
          margin={horizontal ? { left: 0, right: 54, top: 2, bottom: 2 } : { left: 4, right: 8, top: 4 }}
          barCategoryGap="24%"
          onClick={(state) => {
            const label = state?.activeLabel;
            if (label && onBarClick) onBarClick(String(label));
          }}
        >
          <defs>
            {BAR_COLORS.map((c, i) => (
              horizontal ? (
                <linearGradient key={i} id={`aBarH${i}`} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor={c} stopOpacity={0.65} />
                  <stop offset="100%" stopColor={c} stopOpacity={1} />
                </linearGradient>
              ) : (
                <linearGradient key={i} id={`aBarV${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={c} stopOpacity={1} />
                  <stop offset="100%" stopColor={c} stopOpacity={0.7} />
                </linearGradient>
              )
            ))}
          </defs>
          {horizontal ? (
            <>
              <XAxis type="number" tick={{ fontSize: 9, fill: "var(--text-muted)" }}
                tickFormatter={fmtL} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="label" width={labelW}
                tick={{ fontSize: 9, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} />
            </>
          ) : (
            <>
              <XAxis type="category" dataKey="label"
                tick={{ fontSize: 9, fill: "var(--text-muted)" }} angle={-25} textAnchor="end" height={50}
                axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: "var(--text-muted)" }} tickFormatter={fmtL}
                axisLine={false} tickLine={false} />
            </>
          )}
          <Tooltip
            content={<ErpChartTooltip formatValue={(v) => formatINR(v)} valueLabel="Sales" />}
            cursor={{ fill: "rgba(255,255,255,0.04)", rx: 4 }}
          />
          <Bar
            dataKey="value"
            radius={horizontal ? [0, 7, 7, 0] : [6, 6, 0, 0]}
            cursor="pointer"
            isAnimationActive
            background={horizontal
              ? { fill: "rgba(148,163,184,0.07)", radius: [0, 7, 7, 0] }
              : { fill: "rgba(148,163,184,0.07)", radius: [6, 6, 0, 0] }}
          >
            {top.map((row, i) => (
              <Cell
                key={i}
                fill={`url(#${horizontal ? "aBarH" : "aBarV"}${i % BAR_COLORS.length})`}
                opacity={activeLabel && activeLabel !== row.label ? 0.45 : 1}
              />
            ))}
            {horizontal && maxVal > 0 && (
              <LabelList dataKey="value" position="right"
                formatter={(v: number) => fmtL(v)}
                style={{ fontSize: 9, fill: "var(--text-muted)", fontWeight: 700 }} />
            )}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function Analytics() {
  const [period, setPeriod] = useState<PeriodKey>("mtd");
  const [fy, setFy] = useState("");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [crossFilter, setCrossFilter] = useState<Record<string, string>>({});
  const [trendMonth, setTrendMonth] = useState("");
  const [trendGrain, setTrendGrain] = useState<"auto" | "day" | "month">("auto");
  const [snap, setSnap] = useState<AnalyticsSnapshot | null>(null);
  const [loadingCritical, setLoadingCritical] = useState(false);
  const [loadingWidgets, setLoadingWidgets] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const [layoutPreset, setLayoutPreset] = useState<LayoutKey>(() => {
    try {
      return (localStorage.getItem("erp_analytics_layout_preset") as LayoutKey) || "default";
    } catch {
      return "default";
    }
  });
  const [barOrientation, setBarOrientation] = useState<"vertical" | "horizontal">(() => {
    try {
      const v = localStorage.getItem("erp_analytics_bar_orientation");
      return v === "horizontal" ? "horizontal" : "vertical";
    } catch {
      return "vertical";
    }
  });
  const [viewName, setViewName] = useState("");
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("erp_analytics_views") || "[]");
    } catch {
      return [];
    }
  });
  const [drillOpen, setDrillOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem("erp_analytics_layout_preset", layoutPreset);
    } catch { /* ignore */ }
  }, [layoutPreset]);
  useEffect(() => {
    try {
      localStorage.setItem("erp_analytics_bar_orientation", barOrientation);
    } catch { /* ignore */ }
  }, [barOrientation]);

  const periodLabel = PERIOD_CHIPS.find((c) => c.key === period)?.label ?? period.toUpperCase();
  const layoutOrd = LAYOUT_PRESETS[layoutPreset];

  const baseOpts = useCallback(
    (): AnalyticsSnapshotOpts => ({
      period,
      top: 8,
      fy: fy.trim() || undefined,
      customFrom: period === "custom" ? customFrom : undefined,
      customTo: period === "custom" ? customTo : undefined,
      crossFilter: Object.keys(crossFilter).length ? crossFilter : undefined,
      trendMonth: trendMonth.trim() || undefined,
      trendGrain,
    }),
    [period, fy, customFrom, customTo, crossFilter, trendMonth, trendGrain],
  );

  const load = useCallback(async () => {
    if (period === "custom" && (!customFrom || !customTo)) return;
    setError("");
    setSnap(null);
    setLoadingCritical(true);
    setLoadingWidgets(true);
    setStatus(`Fetching ${periodLabel} KPIs and trend…`);

    const opts = baseOpts();
    try {
      const critical = await analytics.snapshot({ ...opts, loadPhase: "critical" });
      setSnap(critical);
      setLoadingCritical(false);
      setStatus(`Fetching ${periodLabel} breakdowns…`);
      const widgets = await analytics.snapshot({ ...opts, loadPhase: "widgets" });
      setSnap((prev) => ({
        ...critical,
        ...widgets,
        kpi: critical.kpi ?? widgets.kpi,
        trend: critical.trend ?? widgets.trend,
      }));
      const errs = [...(critical.errors ?? []), ...(widgets.errors ?? [])];
      if (errs.length) setError(errs.join(" · "));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingCritical(false);
      setLoadingWidgets(false);
      setStatus("");
    }
  }, [baseOpts, period, periodLabel, customFrom, customTo]);

  useEffect(() => {
    load();
  }, [load]);

  const dimCols = snap?.dimensions ?? { branch: "BranchAlias", department: "DepartmentShortName", category: "CategoryShortName" };

  const toggleCross = (col: string, label: string) => {
    const v = label.trim();
    if (!v) return;
    setCrossFilter((prev) => {
      const next = { ...prev };
      if (next[col] === v) delete next[col];
      else next[col] = v;
      return next;
    });
  };

  const flushCache = async () => {
    try {
      await analytics.flushCache();
    } catch { /* ignore */ }
    load();
  };

  const saveView = () => {
    const entry: SavedView = {
      name: (viewName || "Saved view").trim(),
      period,
      fy,
      customFrom,
      customTo,
      crossFilter: { ...crossFilter },
      trendMonth,
      trendGrain,
      layoutPreset,
      barOrientation,
    };
    const next = [entry, ...savedViews.filter((x) => x.name !== entry.name)].slice(0, 12);
    setSavedViews(next);
    localStorage.setItem("erp_analytics_views", JSON.stringify(next));
  };

  const applySaved = (v: SavedView) => {
    setPeriod(v.period as PeriodKey);
    setFy(v.fy);
    setCustomFrom(v.customFrom);
    setCustomTo(v.customTo);
    setCrossFilter(v.crossFilter ?? {});
    setTrendMonth(v.trendMonth);
    setTrendGrain((v.trendGrain as "auto" | "day" | "month") || "auto");
    setLayoutPreset(v.layoutPreset || "default");
    setBarOrientation(v.barOrientation === "horizontal" ? "horizontal" : "vertical");
    setViewName(v.name);
  };

  const crossEntries = useMemo(() => Object.entries(crossFilter), [crossFilter]);
  const busy = loadingCritical || loadingWidgets;
  const trend = snap?.trend?.data ?? [];
  const kpi = snap?.kpi;

  return (
    <div className="section-enter space-y-5 text-slate-800 flex flex-col">
      <div>
        <h2 className="text-xl font-bold" style={{ color: "var(--text-strong)" }}>
          Analytics Engine
        </h2>
        <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>
          Server-side rollups with cache, checksums, and cross-filtering (same column names as your SQL view).
        </p>
        {snap?.table && (
          <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
            Base: {snap.table}
            {snap.periodRange ? ` · ${snap.periodRange.from} → ${snap.periodRange.to}` : ""}
            {snap.fyLabel ? ` · ${snap.fyLabel}` : ""}
          </p>
        )}
      </div>

      {/* Period chips */}
      <div className="card p-4 flex flex-wrap gap-2 items-center">
        {PERIOD_CHIPS.map((p) => (
          <button
            key={p.key}
            type="button"
            disabled={busy}
            onClick={() => setPeriod(p.key)}
            className={period === p.key ? "chip font-bold active-glow" : "chip"}
            style={
              period === p.key
                ? { borderColor: "var(--brand)", color: "var(--brand)", background: "var(--brand-soft)" }
                : undefined
            }
          >
            {p.label}
          </button>
        ))}
        {period === "custom" && (
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <input type="date" className="input-base" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <span style={{ color: "var(--text-muted)" }}>to</span>
            <input type="date" className="input-base" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            <button type="button" className="chip" onClick={() => load()} disabled={busy}>
              Apply range
            </button>
          </div>
        )}
        <button type="button" className="chip ml-auto" disabled={busy} onClick={() => load()}>
          {busy ? `⏳ Loading ${periodLabel}…` : `↻ Load ${periodLabel}`}
        </button>
        <button type="button" className="chip" disabled={busy} onClick={flushCache} title="Clear analytics cache and reload">
          Flush cache
        </button>
      </div>

      {busy && (
        <div className="card p-3 space-y-2">
          <div className="text-xs flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
            <span className="spin w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full inline-block" />
            {status || "Loading analytics…"}
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
            <div
              className="h-full rounded-full transition-all"
            style={{
                width: loadingCritical ? "45%" : "90%",
                background: "linear-gradient(90deg, #6366f1, #8b5cf6)",
              }}
            />
          </div>
          <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            {loadingCritical
              ? "Step 1/2: Critical payload (KPIs + trend)"
              : "Step 2/2: Widgets (branch / department / category + YoY)"}
          </p>
        </div>
      )}

      {snap?.fyNote && (
        <p className="text-xs px-3 py-2 rounded-lg" style={{ background: "rgba(245,158,11,0.12)", color: "#b45309" }}>
          {snap.fyNote}
        </p>
      )}

      {error && (
        <div className="rounded-xl px-3 py-2 text-sm" style={{ background: "rgba(239,68,68,0.1)", color: "var(--accent-bad)" }}>
          {error}
        </div>
      )}

      {/* FY + trend controls */}
      <div className="card p-4 flex flex-wrap gap-4 items-end text-xs">
        <div className="flex flex-col gap-1">
          <span className="font-semibold" style={{ color: "var(--text-strong)" }}>India FY (Apr–Mar)</span>
          <div className="flex gap-2">
            <input className="input-base w-28" placeholder="FY26" value={fy} onChange={(e) => setFy(e.target.value)} />
            <button type="button" className="chip" onClick={() => setFy("")}>
              Clear
            </button>
          </div>
          <span className="text-[10px] max-w-[220px]" style={{ color: "var(--text-muted)" }}>
            Narrows MTD / QTD / 30d / … to this Apr–Mar window. Leave blank for chip range only.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-semibold" style={{ color: "var(--text-strong)" }}>Trend grain</span>
          <select
            className="input-base min-w-[140px]"
            value={trendGrain}
            onChange={(e) => setTrendGrain(e.target.value as "auto" | "day" | "month")}
          >
            <option value="auto">Auto (range-based)</option>
            <option value="day">Force daily</option>
            <option value="month">Force monthly</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-semibold" style={{ color: "var(--text-strong)" }}>Drill trend → month</span>
          <div className="flex gap-2">
            <input
              className="input-base w-32"
              placeholder="2026-05"
              value={trendMonth}
              onChange={(e) => setTrendMonth(e.target.value)}
            />
            <button type="button" className="chip" onClick={() => setTrendMonth("")}>
              Clear
            </button>
          </div>
        </div>
      </div>

      {crossEntries.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center text-xs">
          <span className="font-semibold" style={{ color: "var(--text-muted)" }}>Cross-filter:</span>
          {crossEntries.map(([col, val]) => (
            <button key={col} type="button" className="chip" onClick={() => toggleCross(col, val)}>
              {col}: {val} ×
            </button>
          ))}
          <button type="button" className="chip" onClick={() => setCrossFilter({})}>
            Clear all
          </button>
        </div>
      )}

      {/* Layout + saved views */}
      <div className="card p-4 grid gap-4 md:grid-cols-2 text-xs">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <span className="font-semibold block mb-1" style={{ color: "var(--text-strong)" }}>Layout</span>
            <select className="input-base" value={layoutPreset} onChange={(e) => setLayoutPreset(e.target.value as LayoutKey)}>
              <option value="default">Default</option>
              <option value="trend_first">Trend first</option>
              <option value="breakdown_first">Breakdown first</option>
            </select>
          </div>
          <div>
            <span className="font-semibold block mb-1" style={{ color: "var(--text-strong)" }}>Breakdown bars</span>
            <select
              className="input-base"
              value={barOrientation}
              onChange={(e) => setBarOrientation(e.target.value as "vertical" | "horizontal")}
            >
              <option value="vertical">Cat on X</option>
              <option value="horizontal">Cat on Y</option>
            </select>
          </div>
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>Saved in this browser</span>
        </div>
        <div>
          <span className="font-semibold block mb-1" style={{ color: "var(--text-strong)" }}>Saved views (browser)</span>
          <div className="flex gap-2 flex-wrap">
            <input className="input-base flex-1 min-w-[120px]" placeholder="View name" value={viewName} onChange={(e) => setViewName(e.target.value)} />
            <button type="button" className="chip" onClick={saveView}>
              Save
            </button>
          </div>
          {savedViews.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {savedViews.map((v, i) => (
                <button key={v.name + i} type="button" className="chip text-[10px]" onClick={() => applySaved(v)}>
                  {v.name}
          </button>
        ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center text-xs">
        <button type="button" className="chip" onClick={() => setDrillOpen(!drillOpen)}>
          🔎 Drill-through (rows)
        </button>
        {drillOpen && (
          <span style={{ color: "var(--text-muted)" }}>
            Showing top breakdown rows — full line drill uses Node dashboard until wired here.
          </span>
        )}
      </div>

      {/* KPI */}
      <div style={{ order: layoutOrd.kpi }} className="grid-stats">
        {kpi && !kpi.error && (
          <>
            {[
              { label: `${periodLabel} sales`, val: kpi.totalSales, fmt: "inr" as const },
              { label: "Bills / rows", val: kpi.billCount, fmt: "num" as const },
              { label: "Quantity", val: kpi.quantitySold, fmt: "num" as const },
            ].map((item) => (
              <div key={item.label} className="stat-card-enhanced relative">
                <div className="text-[10px] font-extrabold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                {item.label}
                </div>
                <div className="text-xl font-extrabold mt-2" style={{ color: "var(--text-strong)" }}>
                  {item.fmt === "inr" ? formatINR(item.val) : formatNum(item.val)}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {snap?.yoy && snap.yoySupported && !snap.yoy.error && (
        <div className="grid-stats" style={{ order: layoutOrd.kpi }}>
          {[
            { label: "Current period", val: snap.yoy.cy },
            { label: "Prior year (same window)", val: snap.yoy.ly },
            { label: "YoY %", val: null, change: snap.yoy.change },
          ].map((item) => (
            <div key={item.label} className="stat-card-enhanced">
              <div className="text-[10px] font-extrabold uppercase" style={{ color: "var(--text-muted)" }}>{item.label}</div>
              <div className="text-lg font-bold mt-1">
                {item.val != null ? formatINR(item.val) : `${item.change! >= 0 ? "+" : ""}${item.change!.toFixed(1)}%`}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Trend */}
      <div className="chart-wrapper" style={{ order: layoutOrd.trend }}>
        <div className="text-sm font-bold mb-2" style={{ color: "var(--text-strong)" }}>
          Sales trend
          {snap?.trend?.granularity === "month" ? " (monthly)" : " (daily)"}
        </div>
        {loadingCritical ? (
          <p className="text-sm py-8 text-center" style={{ color: "var(--text-muted)" }}>Loading trend…</p>
        ) : trend.length === 0 ? (
          <p className="text-sm py-8 text-center" style={{ color: "var(--text-muted)" }}>No trend data</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart
              data={trend}
              onClick={(state) => {
                const idx = state?.activeTooltipIndex;
                if (idx == null || !trend[idx]) return;
                const pl = String(trend[idx].day || "");
                if (/^\d{4}-\d{2}/.test(pl)) setTrendMonth(pl.slice(0, 7));
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
              <XAxis dataKey="day" tick={{ fontSize: 9, fill: "var(--text-muted)" }} />
              <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickFormatter={(v) => `₹${(v / 1e5).toFixed(0)}L`} />
              <Tooltip content={<ErpChartTooltip formatValue={(v) => formatINR(v)} valueLabel="Sales" />} />
              <Line type="monotone" dataKey="value" stroke="var(--brand)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
        </div>

      {/* Breakdowns */}
      <div className="grid gap-4 lg:grid-cols-3" style={{ order: layoutOrd.breakdown }}>
        <BreakdownChart
          title="Branch"
          rows={snap?.branch?.data ?? []}
          loading={loadingWidgets}
          horizontal={barOrientation === "horizontal"}
          activeLabel={crossFilter[dimCols.branch]}
          onBarClick={(label) => toggleCross(dimCols.branch, label)}
        />
        <BreakdownChart
          title="Department"
          rows={snap?.department?.data ?? []}
          loading={loadingWidgets}
          horizontal={barOrientation === "horizontal"}
          activeLabel={crossFilter[dimCols.department]}
          onBarClick={(label) => toggleCross(dimCols.department, label)}
        />
        <BreakdownChart
          title="Category"
          rows={snap?.category?.data ?? []}
          loading={loadingWidgets}
          horizontal={barOrientation === "horizontal"}
          activeLabel={crossFilter[dimCols.category]}
          onBarClick={(label) => toggleCross(dimCols.category, label)}
        />
      </div>

      {drillOpen && (
        <div className="card p-4 overflow-x-auto text-xs" style={{ order: 99 }}>
          <table className="w-full border-collapse">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th className="text-left py-1">Branch</th>
                <th className="text-right py-1">Sales</th>
                <th className="text-right py-1">Dept</th>
                <th className="text-right py-1">Cat</th>
              </tr>
            </thead>
            <tbody>
              {(snap?.branch?.data ?? []).slice(0, 20).map((r) => (
                <tr key={r.label} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="py-1">{r.label}</td>
                  <td className="text-right py-1">{formatINR(r.value)}</td>
                  <td className="text-right py-1 text-slate-500">-</td>
                  <td className="text-right py-1 text-slate-500">-</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
