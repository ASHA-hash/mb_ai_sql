import { useEffect, useState, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";
import { ErpDonutChart, ErpHBarChart, ErpChartTooltip, buildPieSlices } from "../components/ErpCharts";
import { analytics } from "../lib/api";
import { formatINR, formatINRAuto, formatNum } from "../lib/utils";
import type { KpiData, KpiSlice, PeriodData, PeriodKpi, TrendData } from "../lib/api";
import { useAuth } from "../lib/auth";

// ── Constants ──────────────────────────────────────────────────────────────────

const PERIODS = [
  { key: "today",     label: "Today"    },
  { key: "mtd",       label: "MTD"      },
  { key: "qtd",       label: "QTD"      },
  { key: "ytd",       label: "YTD"      },
  { key: "6m",        label: "Last 6M"  },
  { key: "last_30d",  label: "30d"      },
  { key: "last_60d",  label: "60d"      },
  { key: "last_90d",  label: "90d"      },
  { key: "last_180d", label: "180d"     },
] as const;

const BREAKDOWN_OPTS = [
  { value: 10, label: "Top 10" },
  { value: 20, label: "Top 20" },
  { value: 30, label: "Top 30" },
  { value: 0,  label: "All"    },
];

// ── Small helpers ──────────────────────────────────────────────────────────────

function pillStyle(active: boolean): React.CSSProperties {
  return {
    padding: "5px 14px",
    borderRadius: 20,
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 700,
    transition: "all 0.15s",
    background: active ? "var(--brand,#6366f1)" : "var(--bg-muted,#f1f5f9)",
    color:      active ? "#fff" : "var(--text-muted,#64748b)",
    boxShadow:  active ? "0 2px 8px rgba(99,102,241,.3)" : "none",
  };
}

function Skel({ w = 80, h = 24 }: { w?: number; h?: number }) {
  return (
    <span
      className="skel-line"
      style={{ width: w, height: h, display: "inline-block", borderRadius: 6 }}
    />
  );
}

function periodRangeLabel(period: string, now: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  if (period === "today") return fmt(now);
  if (period === "mtd") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return `1 ${start.toLocaleDateString("en-IN", { month: "short" })} – ${now.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
  }
  return PERIODS.find((p) => p.key === period)?.label ?? period.toUpperCase();
}

// ── KpiTile ────────────────────────────────────────────────────────────────────

function KpiTile({
  icon, label, value, variant, loading,
}: {
  icon: string; label: string; value: string | null; variant: string; loading?: boolean;
}) {
  return (
    <div className={`kpi-tile kpi-tile-${variant}`}>
      <div className="tile-blob1" />
      <div className="tile-blob2" />
      <div style={{ position: "relative", zIndex: 1 }}>
        <span className="kpi-tile-icon">{icon}</span>
        <div className="kpi-tile-val">
          {loading ? <Skel w={90} h={26} /> : (value ?? "—")}
        </div>
        <div className="kpi-tile-lbl">{label}</div>
      </div>
    </div>
  );
}

// ── Chart type toggle ──────────────────────────────────────────────────────────

type ChartType = "line" | "bar";

function ChartToggle({ value, onChange }: { value: ChartType; onChange: (t: ChartType) => void }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {(["line", "bar"] as ChartType[]).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          style={{
            padding: "3px 10px",
            borderRadius: 8,
            border: "1px solid",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            borderColor: value === t ? "var(--brand)" : "var(--border)",
            background:  value === t ? "var(--brand)" : "transparent",
            color:       value === t ? "#fff" : "var(--text-muted)",
          }}
        >
          {t === "line" ? "📈 Line" : "📊 Bar"}
        </button>
      ))}
    </div>
  );
}

// ── TrendSection ───────────────────────────────────────────────────────────────

function TrendSection({
  trend, periodLabel, loading, visible, onToggle,
}: {
  trend: TrendData | null;
  periodLabel: string;
  loading: boolean;
  visible: boolean;
  onToggle: () => void;
}) {
  const [chartType, setChartType] = useState<ChartType>("line");

  if (!visible) {
    return (
      <button type="button" className="btn-ghost text-xs py-1.5 px-3 w-full" onClick={onToggle}>
        Show trend chart (hidden)
      </button>
    );
  }

  if (loading) {
    return (
      <div
        className="chart-wrapper rounded-xl border p-4"
        style={{ borderColor: "var(--border)", height: 240,
          display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading trend…</span>
      </div>
    );
  }

  const rows = trend?.data ?? [];
  if (!rows.length) return null;

  const fmtDay = (d: string) =>
    d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "";
  const fmtLakhs = (v: number) => `₹${(v / 1e5).toFixed(0)}L`;

  return (
    <div className="chart-wrapper rounded-xl border p-4 space-y-3" style={{ borderColor: "var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="text-sm font-bold" style={{ color: "var(--text-strong)" }}>
          {periodLabel} — Day-wise Sales
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <ChartToggle value={chartType} onChange={setChartType} />
          <button type="button" className="btn-ghost text-xs py-1 px-2.5" onClick={onToggle}>
            Hide
          </button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        {chartType === "line" ? (
          <LineChart data={rows}>
            <XAxis dataKey="day" tick={{ fontSize: 9, fill: "var(--text-muted)" }} tickFormatter={fmtDay} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickFormatter={fmtLakhs} />
            <Tooltip content={<ErpChartTooltip formatValue={(v) => formatINR(v)} valueLabel="Sales" />} />
            <Line type="monotone" dataKey="value" stroke="var(--brand)" strokeWidth={2} dot={false} name="Sales" />
          </LineChart>
        ) : (
          <BarChart data={rows}>
            <XAxis dataKey="day" tick={{ fontSize: 9, fill: "var(--text-muted)" }} tickFormatter={fmtDay} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickFormatter={fmtLakhs} />
            <Tooltip content={<ErpChartTooltip formatValue={(v) => formatINR(v)} valueLabel="Sales" />} />
            <Bar dataKey="value" fill="var(--brand)" radius={[3, 3, 0, 0]} name="Sales" />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

// ── HomeBreakdownBlock ─────────────────────────────────────────────────────────

function HomeBreakdownBlock({
  title, icon, data, loading, visible, onToggle, breakdownLimit,
}: {
  title: string;
  icon: string;
  data: PeriodData | null;
  loading: boolean;
  visible: boolean;
  onToggle: () => void;
  breakdownLimit: number;
}) {
  if (!visible) {
    const count = data?.data?.length ?? 0;
    return (
      <button type="button" className="btn-ghost text-xs py-1.5 px-3" onClick={onToggle}>
        Show {title}{count > 0 ? ` (${count} items, hidden)` : ""} ▸
      </button>
    );
  }

  const rows = data?.data ?? [];
  const limit = breakdownLimit === 0 ? rows.length : breakdownLimit;
  const shown = rows.slice(0, limit);

  if (loading && !shown.length) {
    return (
      <div
        className="rounded-xl border p-4"
        style={{ borderColor: "var(--border)", height: 180,
          display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <span className="text-sm" style={{ color: "var(--text-muted)" }}>Loading {title}…</span>
      </div>
    );
  }

  if (!shown.length) return null;

  const shownTotal = shown.reduce((s, r) => s + r.value, 0);
  const fmtLakhs = (v: number) => `₹${(v / 1e5).toFixed(0)}L`;
  const piePrepared = buildPieSlices(rows.map((r) => ({ name: r.label, value: r.value })));
  const barHeight = Math.max(200, Math.min(shown.length * 28, 440));

  return (
    <div className="rounded-xl border p-4 space-y-4" style={{ borderColor: "var(--border)" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <p className="text-sm font-bold m-0" style={{ color: "var(--text-strong)" }}>
          {icon} {title}
          <span className="text-[11px] font-normal ml-2" style={{ color: "var(--text-muted)" }}>
            ({rows.length} items · showing {shown.length})
          </span>
        </p>
        <button type="button" className="btn-ghost text-xs py-1 px-2.5" onClick={onToggle}>
          Hide section
        </button>
      </div>

      {/* Charts: donut (left) + horizontal bar (right) — Node-style layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.55fr", gap: 16 }}>
        <div className="chart-wrapper" style={{ padding: "12px 8px" }}>
          <ErpDonutChart
            title="Share (%)"
            slices={piePrepared.slices}
            total={piePrepared.total}
            formatValue={fmtLakhs}
            formatTooltipValue={(v) => formatINRAuto(v)}
            height={Math.min(barHeight, 340)}
            othersNote={piePrepared.othersNote}
            othersItems={piePrepared.rest}
          />
        </div>
        <div className="chart-wrapper" style={{ padding: "12px 8px" }}>
          <ErpHBarChart
            title="Sales Value"
            rows={shown.map((r) => ({ label: r.label, value: r.value }))}
            labelKey="label"
            valueKey="value"
            formatValue={fmtLakhs}
            formatAxis={fmtLakhs}
            height={barHeight}
          />
        </div>
      </div>

      {/* Data table */}
      <div style={{ maxHeight: 260, overflowY: "auto", borderRadius: 10, border: "1px solid var(--border)" }}>
        <table className="data-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>#</th>
              <th style={{ textAlign: "left" }}>{title.replace("Sales by ", "")}</th>
              <th style={{ textAlign: "right" }}>Sales</th>
              <th style={{ textAlign: "right" }}>Bills</th>
              <th style={{ textAlign: "right" }}>Share</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                <td style={{ color: "var(--text-muted)", width: 32 }}>{i + 1}</td>
                <td style={{ fontWeight: 600, color: "var(--text-strong)", maxWidth: 200 }}>
                  {r.label}
                </td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {formatINRAuto(r.value)}
                </td>
                <td style={{ textAlign: "right", color: "var(--text-muted)" }}>
                  {formatNum(r.bills)}
                </td>
                <td style={{ textAlign: "right", color: "var(--text-muted)" }}>
                  {(shownTotal > 0 ? ((r.value / shownTotal) * 100).toFixed(1) : "0") + "%"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > limit && (
        <p className="text-[11px] m-0" style={{ color: "var(--text-muted)" }}>
          Showing top {limit} of {rows.length} — choose "All" in the row-limit control to see every row.
        </p>
      )}
    </div>
  );
}

// ── RecentQueries ──────────────────────────────────────────────────────────────

function RecentQueries({ onNavigate }: { onNavigate: () => void }) {
  const history = useMemo<string[]>(() => {
    try {
      const raw = localStorage.getItem("erp_ai_history");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      // Support both string[] and { query: string; ts: string }[]
      if (Array.isArray(parsed)) {
        return parsed
          .map((x) => (typeof x === "string" ? x : (x as { query?: string }).query ?? ""))
          .filter(Boolean)
          .slice(0, 5);
      }
      return [];
    } catch {
      return [];
    }
  }, []);

  if (!history.length) return null;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div className="home-section-label" style={{ marginBottom: 0, flex: 1 }}>
          Recent AI Queries
        </div>
        <button
          type="button"
          onClick={onNavigate}
          style={{
            fontSize: 11,
            color: "var(--brand)",
            fontWeight: 700,
            background: "none",
            border: "none",
            cursor: "pointer",
            flexShrink: 0,
            marginLeft: 12,
          }}
        >
          Open AI Query →
        </button>
      </div>
      <div
        style={{
          background: "var(--bg-surface)",
          borderRadius: 16,
          border: "1px solid var(--border-soft)",
          overflow: "hidden",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        {history.map((q, i) => (
          <button
            key={i}
            type="button"
            onClick={onNavigate}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "10px 16px",
              background: "none",
              border: "none",
              borderBottom:
                i < history.length - 1 ? "1px solid var(--border-soft)" : "none",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span style={{ fontSize: 14, flexShrink: 0, opacity: 0.7 }}>✨</span>
            <span
              style={{
                fontSize: 13,
                color: "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {q}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>→</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { user } = useAuth();
  const [homeKpis,    setHomeKpis]    = useState<KpiData | null>(null);
  const [todayStatus, setTodayStatus] = useState<"loading"|"ok"|"error">("loading");
  const [mtdStatus,   setMtdStatus]   = useState<"loading"|"ok"|"error">("loading");

  const [period,        setPeriod]       = useState("mtd");
  const [periodKpi,     setPeriodKpi]    = useState<PeriodKpi | null>(null);
  const [periodLoading, setPeriodLoading]= useState(false);
  const [periodBranch,  setPeriodBranch] = useState<PeriodData | null>(null);
  const [periodDept,    setPeriodDept]   = useState<PeriodData | null>(null);
  const [periodCat,     setPeriodCat]    = useState<PeriodData | null>(null);
  const [trend,         setTrend]        = useState<TrendData | null>(null);
  const [chartsLoading, setChartsLoading]= useState(true);
  const [yoy, setYoy] = useState<{ cy: number; ly: number; change: number } | null>(null);

  const [breakdownLimit, setBreakdownLimit] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem("erp_home_breakdown_limit") ?? "20", 10);
      return [0, 10, 20, 30].includes(v) ? v : 20;
    } catch { return 20; }
  });

  const [sectionVisible, setSectionVisible] = useState(() => {
    try {
      const raw = localStorage.getItem("erp_home_section_visible");
      if (raw) return { trend: true, branch: true, dept: true, cat: true, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { trend: true, branch: true, dept: true, cat: true };
  });

  const [error, setError] = useState("");
  const [clock, setClock] = useState(new Date());

  const now = useMemo(() => new Date(), [clock]); // eslint-disable-line react-hooks/exhaustive-deps
  const hour = now.getHours();
  const greeting =
    hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const dateStr = now.toLocaleDateString("en-IN", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const persistBreakdownLimit = (v: number) => {
    setBreakdownLimit(v);
    try { localStorage.setItem("erp_home_breakdown_limit", String(v)); } catch { /* ignore */ }
  };

  const toggleSection = (key: keyof typeof sectionVisible) => {
    setSectionVisible((prev: typeof sectionVisible) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem("erp_home_section_visible", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // ── Data loaders ──────────────────────────────────────────────────────────

  const sliceFromPeriodKpi = (k: PeriodKpi): KpiSlice => ({
    sales: k.totalSales,
    bills: k.billCount,
    quantitySold: k.quantitySold,
    customerCount: k.customerCount,
  });

  const bundleTop = (limit: number) => (limit === 0 ? 30 : Math.min(limit, 30));

  const loadCharts = useCallback((p: string, top: number): Promise<void> => {
    setChartsLoading(true);
    return analytics
      .homeBundle({ period: p, trendDays: 30, top: bundleTop(top) })
      .then((b) => {
        if (b.branch) setPeriodBranch(b.branch);
        if (b.department) setPeriodDept(b.department);
        if (b.category) setPeriodCat(b.category);
        if (b.trend) setTrend(b.trend);
        const chartErrors = b.errors?.filter(Boolean);
        if (chartErrors?.length) {
          setError((prev) => `${prev ? `${prev} · ` : ""}Charts: ${chartErrors.join("; ")}`);
        }
      })
      .catch((e) => {
        setError((prev) =>
          `${prev ? `${prev} · ` : ""}Charts: ${e instanceof Error ? e.message : String(e)}`,
        );
      })
      .finally(() => setChartsLoading(false));
  }, []);

  const applyPeriodKpi = useCallback((k: PeriodKpi, p: string) => {
    if (k.error) return;
    setPeriodKpi(k);
    const slice = sliceFromPeriodKpi(k);
    setHomeKpis((prev) => ({
      ...prev,
      ...(p === "today" ? { today: slice } : {}),
      ...(p === "mtd" ? { mtd: slice } : {}),
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      setTodayStatus("loading");
      setMtdStatus("loading");
      setPeriodLoading(true);
      setError("");

      // Strict sequence: today → mtd → charts → yoy (no parallel KPI contention).
      try {
        const todayK = await analytics.kpi("today", 90_000);
        if (cancelled) return;
        if (todayK?.error) {
          setTodayStatus("error");
          setError(`Today: ${todayK.error}`);
        } else {
          applyPeriodKpi(todayK, "today");
          setTodayStatus("ok");
        }
      } catch (e) {
        if (cancelled) return;
        setTodayStatus("error");
        setError(`Today: ${e instanceof Error ? e.message : String(e)}`);
      }

      try {
        const mtdK = await analytics.kpi("mtd", 180_000);
        if (cancelled) return;
        if (mtdK?.error) {
          setMtdStatus("error");
          setError((prev) => `${prev ? `${prev} · ` : ""}MTD: ${mtdK.error}`);
        } else {
          applyPeriodKpi(mtdK, "mtd");
          setMtdStatus("ok");
          setPeriodKpi(mtdK);
        }
      } catch (e) {
        if (cancelled) return;
        setMtdStatus("error");
        setError((prev) => `${prev ? `${prev} · ` : ""}MTD: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (!cancelled) setPeriodLoading(false);
      }

      if (cancelled) return;
      await loadCharts("mtd", breakdownLimit);

      if (cancelled) return;
      try {
        const y = await analytics.yoy("mtd");
        if (!y.error) setYoy({ cy: y.cy, ly: y.ly, change: y.change });
      } catch {
        /* YoY optional */
      }
    }

    boot();
    return () => {
      cancelled = true;
    };
  }, [applyPeriodKpi, breakdownLimit, loadCharts]);

  const handlePeriod = (p: string) => {
    setPeriod(p);
    setPeriodLoading(true);
    analytics
      .kpi(p, p === "today" ? 35_000 : 180_000)
      .then((k) => {
        if (!k?.error) {
          applyPeriodKpi(k, p);
          if (p === "today") setTodayStatus("ok");
          if (p === "mtd") setMtdStatus("ok");
          setPeriodKpi(k);
        }
        setPeriodLoading(false);
      })
      .catch(() => setPeriodLoading(false));
    window.setTimeout(() => loadCharts(p, breakdownLimit), 400);
  };

  // ── Derived values ────────────────────────────────────────────────────────

  const todayKpi: KpiSlice | undefined = homeKpis?.today;
  const mtdKpi:   KpiSlice | undefined = homeKpis?.mtd;
  const todayLoading = todayStatus === "loading";
  const mtdLoading   = mtdStatus   === "loading";

  const kv = (
    status: string,
    data: KpiSlice | undefined,
    field: keyof KpiSlice,
    fmt: "currency"|"number"|"currencyAuto" = "currency",
  ): string | null => {
    if (status === "loading") return null;
    if (status === "error" || !data) return "—";
    const v = data[field] as number;
    if (fmt === "currency")     return formatINR(v);
    if (fmt === "currencyAuto") return formatINRAuto(v);
    return formatNum(v);
  };

  const todayABV = todayKpi && todayKpi.bills > 0 ? todayKpi.sales / todayKpi.bills : 0;
  const mtdABV   = mtdKpi   && mtdKpi.bills   > 0 ? mtdKpi.sales   / mtdKpi.bills   : 0;

  const periodLabel = PERIODS.find((x) => x.key === period)?.label ?? period.toUpperCase();
  const kpiTotal    = periodKpi?.totalSales ?? 0;
  const pyTotal     = yoy?.ly ?? null;

  const role        = user?.role ?? "viewer";
  const displayName = user?.name || user?.email?.split("@")[0] || "User";

  const quickActions = [
    { icon: "✨", label: "AI Query",   desc: "Plain-English SQL — ask anything, get charts instantly", to: "/ai-query",  color: "#6366f1", bg: "rgba(99,102,241,0.09)",  border: "rgba(99,102,241,0.20)"  },
    { icon: "📈", label: "Analytics", desc: "Period sales, branch, category & trend charts",           to: "/analytics", color: "#10b981", bg: "rgba(16,185,129,0.09)",  border: "rgba(16,185,129,0.20)"  },
    { icon: "📊", label: "Data",      desc: "Load registry datasets with row caps and filters",        to: "/data",      color: "#0ea5e9", bg: "rgba(14,165,233,0.09)", border: "rgba(14,165,233,0.20)"  },
    { icon: "🔎", label: "Explorer",  desc: "Browse tables, columns, and live previews",               to: "/explorer",  color: "#f59e0b", bg: "rgba(245,158,11,0.09)", border: "rgba(245,158,11,0.20)"  },
    { icon: "🧠", label: "RAG Memory",desc: "Verified examples and glossary for the AI agent",        to: "/rag",       color: "#8b5cf6", bg: "rgba(139,92,246,0.09)", border: "rgba(139,92,246,0.20)"  },
    { icon: "⏱", label: "Schedule",  desc: "Auto-refresh via Google Sheets add-on",                   to: "/schedule",  color: "#64748b", bg: "rgba(100,116,139,0.09)",border: "rgba(100,116,139,0.20)" },
    { icon: "⚙", label: "Settings",  desc: "API URL, session, and Drive export notes",                to: "/settings",  color: "#94a3b8", bg: "rgba(148,163,184,0.09)",border: "rgba(148,163,184,0.20)" },
    ...(user?.role === "admin"
      ? [{ icon: "🔑", label: "Admin", desc: "Models, caps, analytics columns, runtime config",        to: "/admin",     color: "#ef4444", bg: "rgba(239,68,68,0.09)",  border: "rgba(239,68,68,0.20)"   }]
      : []),
  ];

  // ── Render ────────────────────────────────────────────────────────────────
  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5 fade-in">

      {/* ══ WELCOME BANNER ════════════════════════════════════ */}
      <div className="welcome-banner-v2">
        <div className="wb-blob1" />
        <div className="wb-blob2" />
        <div style={{ position:"relative", zIndex:1, display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:12, flexWrap:"wrap" }}>
          <div>
            <div style={{ fontSize:11.5, fontWeight:600, color:"var(--text-muted)", marginBottom:5, letterSpacing:"0.03em" }}>
              {greeting} · {dateStr}
            </div>
            <h1 style={{ fontSize:30, fontWeight:800, color:"var(--text-strong)", lineHeight:1.1, letterSpacing:"-0.6px", margin:0 }}>
              {displayName}
      </h1>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:10, flexWrap:"wrap" }}>
              <span className={`role-badge role-${role}`}>
                {role === "admin" ? "👑" : role === "manager" ? "📋" : "👁"}&nbsp;{role.toUpperCase()}
              </span>
              <span style={{ fontSize:12, color:"var(--text-muted)" }}>{user?.email}</span>
            </div>
          </div>
          <div style={{ textAlign:"right", flexShrink:0, paddingTop:4 }}>
            <div style={{ fontSize:10, color:"var(--text-muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em" }}>Last refreshed</div>
            <div style={{ fontSize:20, fontWeight:800, color:"var(--text-strong)", lineHeight:1.1, marginTop:3, letterSpacing:"-0.3px" }}>{timeStr}</div>
            {todayStatus === "ok" && (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", gap:5, marginTop:4 }}>
                <span className="live-dot" />
                <span style={{ fontSize:10, color:"var(--accent-good)", fontWeight:700 }}>LIVE</span>
              </div>
            )}
          </div>
        </div>
        <div style={{ display:"flex", gap:32, marginTop:20, paddingTop:16, borderTop:"1px solid var(--border-soft)", flexWrap:"wrap" }}>
          {[
            { icon:"💰", lbl:"Today",       val: kv(todayStatus, todayKpi, "sales"),                  loading: todayLoading },
            { icon:"🧾", lbl:"Bills Today", val: kv(todayStatus, todayKpi, "bills", "number"),         loading: todayLoading },
            { icon:"📅", lbl:"MTD Sales",   val: kv(mtdStatus,   mtdKpi,   "sales"),                  loading: mtdLoading   },
            { icon:"📦", lbl:"MTD Qty",     val: kv(mtdStatus,   mtdKpi,   "quantitySold", "number"), loading: mtdLoading   },
          ].map((s, i) => (
            <div key={i}>
              <div style={{ fontSize:18, fontWeight:800, color:"var(--text-strong)", lineHeight:1 }}>
                {s.loading ? <Skel w={60} h={18} /> : <>{s.icon} {s.val}</>}
              </div>
              <div style={{ fontSize:10.5, color:"var(--text-muted)", marginTop:3 }}>{s.lbl}</div>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl px-4 py-3 text-sm font-medium"
          style={{ background:"rgba(245,158,11,0.15)", border:"1px solid rgba(245,158,11,0.4)", color:"var(--accent-warn)" }}>
          <strong>Some data could not load</strong> — {error}
        </div>
      )}

      {/* ══ TODAY AT A GLANCE ══════════════════════════════════ */}
      <div>
        <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", marginBottom:14 }}>
          <div className="home-section-label" style={{ flex:1 }}>
            Today at a Glance
            <span style={{ fontSize:10, fontWeight:500, textTransform:"none", letterSpacing:0, marginLeft:6, color:"var(--text-soft)" }}>
              {now.toLocaleDateString("en-IN", { day:"numeric", month:"short", year:"numeric" })}
            </span>
          </div>
        </div>
        <div className="kpi-row-4">
          <KpiTile icon="💰" label="Today's Sales"  variant="blue"   loading={todayLoading} value={kv(todayStatus, todayKpi, "sales")} />
          <KpiTile icon="🧾" label="Bills Today"     variant="indigo" loading={todayLoading} value={kv(todayStatus, todayKpi, "bills", "number")} />
          <KpiTile icon="📦" label="Qty Sold"        variant="teal"   loading={todayLoading} value={kv(todayStatus, todayKpi, "quantitySold", "number")} />
          <KpiTile icon="📈" label="Avg Bill Value"  variant="cyan"   loading={todayLoading}
            value={todayLoading ? null : todayStatus==="error"||!todayKpi ? "—" : formatINRAuto(todayABV)} />
        </div>
      </div>

      {/* ══ MONTH TO DATE ════════════════════════════════════════ */}
      <div>
        <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", marginBottom:14 }}>
          <div className="home-section-label" style={{ flex:1 }}>
            Month to Date
            <span style={{ fontSize:10, fontWeight:500, textTransform:"none", letterSpacing:0, marginLeft:6, color:"var(--text-soft)" }}>
              {periodRangeLabel("mtd", now)}
            </span>
          </div>
        </div>
        <div className="kpi-row-4">
          <KpiTile icon="💰" label="MTD Gross Sales" variant="purple" loading={mtdLoading} value={kv(mtdStatus, mtdKpi, "sales")} />
          <KpiTile icon="🧾" label="Bills (MTD)"      variant="violet" loading={mtdLoading} value={kv(mtdStatus, mtdKpi, "bills", "number")} />
          <KpiTile icon="📦" label="Qty Sold (MTD)"   variant="purple" loading={mtdLoading} value={kv(mtdStatus, mtdKpi, "quantitySold", "number")} />
          <KpiTile icon="📈" label="Avg Bill (MTD)"   variant="violet" loading={mtdLoading}
            value={mtdLoading ? null : mtdStatus==="error"||!mtdKpi ? "—" : formatINRAuto(mtdABV)} />
        </div>
      </div>

      {/* HOME — Key Metrics */}
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="font-bold text-base m-0" style={{ color: "var(--text-strong)" }}>
              Home — Key Metrics
            </h3>
            <p className="text-xs mt-0.5 m-0" style={{ color: "var(--text-muted)" }}>
              {periodRangeLabel(period, now)}
              {periodKpi?.billCount ? ` · ${formatNum(periodKpi.billCount)} transactions` : ""}
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="font-extrabold text-xl" style={{ color: "var(--brand)" }}>
              {periodLoading ? <Skel w={100} h={24} /> : formatINR(kpiTotal)}
            </div>
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>
              {periodLabel} — Net Sales
            </div>
            {pyTotal != null && pyTotal > 0 && yoy && (
              <div
                className="text-xs mt-0.5"
                style={{ color: kpiTotal >= pyTotal ? "#10b981" : "#ef4444", fontWeight: 600 }}
              >
                {kpiTotal >= pyTotal ? "▲" : "▼"} {formatINR(Math.abs(kpiTotal - pyTotal))} (
                {yoy.change >= 0 ? "+" : ""}
                {yoy.change.toFixed(1)}%) vs LY
                <span style={{ fontWeight: 500, color: "var(--text-muted)" }}>
                  {" "}
                  · LY {formatINR(pyTotal)}
                </span>
              </div>
            )}
          </div>
        </div>

        <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
          {PERIODS.map(({ key, label }) => (
            <button key={key} type="button" style={pillStyle(period===key)} onClick={() => handlePeriod(key)}>
              {label}
            </button>
          ))}
        </div>

        {periodLoading && (
          <div className="flex items-center gap-2 py-4" style={{ color:"var(--text-muted)" }}>
            <span className="spin w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full inline-block" />
            <span className="text-sm">Loading {periodLabel} analytics…</span>
          </div>
        )}
        {!periodLoading && periodKpi && (periodKpi.totalSales > 0 || periodKpi.billCount > 0) && (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:12 }}>
            {[
              { icon:"💰", val:formatINR(periodKpi.totalSales),    lbl:`${periodLabel} Sales`,  color:"#6366f1" },
              { icon:"📦", val:formatNum(periodKpi.quantitySold),  lbl:"Quantity Sold",          color:"#0ea5e9" },
              { icon:"🧾", val:formatNum(periodKpi.billCount),     lbl:"Bills Generated",        color:"#10b981" },
              { icon:"👥", val:formatNum(periodKpi.customerCount), lbl:"Customer Count",         color:"#8b5cf6" },
            ].map((t, i) => (
              <div key={i} style={{ background:"var(--surface2)", borderRadius:12, padding:"12px 14px", border:"1px solid var(--border)", textAlign:"center" }}>
                <div style={{ fontSize:20 }}>{t.icon}</div>
                <div style={{ fontSize:18, fontWeight:800, color:t.color, marginTop:4 }}>{t.val}</div>
                <div style={{ fontSize:11, color:"var(--text-muted)", marginTop:2 }}>{t.lbl}</div>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-xl border p-3 flex flex-wrap items-center gap-3"
          style={{ borderColor:"var(--border)", background:"var(--surface2)" }}>
          <span className="text-xs font-semibold" style={{ color:"var(--text-muted)" }}>Rows per breakdown:</span>
          {BREAKDOWN_OPTS.map((opt) => (
            <button key={opt.value} type="button" className="text-xs font-semibold px-3 py-1.5 rounded-lg border"
              style={{
                borderColor: breakdownLimit===opt.value ? "var(--brand)":"var(--border)",
                background:  breakdownLimit===opt.value ? "var(--brand)":"transparent",
                color:       breakdownLimit===opt.value ? "#fff":"var(--text)",
              }}
              onClick={() => { persistBreakdownLimit(opt.value); loadCharts(period, opt.value===0 ? 500 : opt.value); }}>
              {opt.label}
            </button>
          ))}
          <span className="text-xs" style={{ color:"var(--border)" }}>|</span>
          <span className="text-xs font-semibold" style={{ color:"var(--text-muted)" }}>Show:</span>
          {(["trend","branch","dept","cat"] as const).map((k) => (
            <label key={k} className="text-xs flex items-center gap-1.5 cursor-pointer" style={{ color:"var(--text)" }}>
              <input type="checkbox" checked={!!sectionVisible[k]} onChange={() => toggleSection(k)} />
              {k.charAt(0).toUpperCase()+k.slice(1)}
            </label>
          ))}
        </div>

        {chartsLoading && (
          <p className="text-sm py-2 m-0" style={{ color:"var(--text-muted)" }}>
            <span className="spin w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full inline-block mr-2 align-middle" />
            Loading charts…
          </p>
        )}

        <TrendSection
          trend={trend}
          periodLabel={periodLabel}
          loading={chartsLoading}
          visible={sectionVisible.trend}
          onToggle={() => toggleSection("trend")}
        />
        <HomeBreakdownBlock
          title="Sales by Branch"
          icon="🏬"
          data={periodBranch}
          loading={chartsLoading}
          visible={sectionVisible.branch}
          onToggle={() => toggleSection("branch")}
          breakdownLimit={breakdownLimit}
        />
        <HomeBreakdownBlock
          title="Sales by Department"
          icon="🏢"
          data={periodDept}
          loading={chartsLoading}
          visible={sectionVisible.dept}
          onToggle={() => toggleSection("dept")}
          breakdownLimit={breakdownLimit}
        />
        <HomeBreakdownBlock
          title="Sales by Category"
          icon="🏷️"
          data={periodCat}
          loading={chartsLoading}
          visible={sectionVisible.cat}
          onToggle={() => toggleSection("cat")}
          breakdownLimit={breakdownLimit}
        />
      </div>

      {/* QUICK ACTIONS */}
      <div>
        <div className="home-section-label">Navigate</div>
        <div style={{ display:"grid", gap:12, gridTemplateColumns:"repeat(auto-fill,minmax(185px,1fr))" }}>
          {quickActions.map((a) => (
            <Link key={a.to} to={a.to} className="qa-card-v2 no-underline" style={{ color:"inherit" }}>
              <div style={{ width:42, height:42, borderRadius:13, background:a.bg, border:`1px solid ${a.border}`,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, marginBottom:13, flexShrink:0 }}>
                {a.icon}
              </div>
              <div style={{ fontSize:14, fontWeight:700, color:"var(--text-strong)", marginBottom:4 }}>{a.label}</div>
              <div style={{ fontSize:11.5, color:"var(--text-muted)", lineHeight:1.5, flex:1 }}>{a.desc}</div>
              <div style={{ fontSize:11.5, fontWeight:700, color:a.color, marginTop:12, display:"flex", alignItems:"center", gap:4 }}>Open</div>
            </Link>
          ))}
        </div>
      </div>

      {/* RECENT AI QUERIES */}
      <RecentQueries onNavigate={() => { window.location.href = "/ai-query"; }} />
    </div>
  );
}
