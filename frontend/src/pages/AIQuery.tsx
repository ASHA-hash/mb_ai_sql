import { useState, useRef, useEffect, useMemo } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts";
import {
  ErpDonutChart,
  ErpHBarChart,
  ErpChartTooltip,
  ErpCyLyComparisonChart,
  isCyLyComparisonRows,
  buildPieSlices,
} from "../components/ErpCharts";
import { query as queryApi, templates as templatesApi } from "../lib/api";
import { formatNum, getConfidenceBadge } from "../lib/utils";
import type { QueryResponse, Template, Suggestion } from "../lib/api";
import {
  Bot, Database, ChevronDown, ChevronUp, Star, Send,
  BarChart2, LineChart as LineIcon, PieChart as PieIcon, Table2, Trash2,
} from "lucide-react";
import "./ai-query.css";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  sql?: string;
  data?: Record<string, unknown>[];
  rowCount?: number;
  confidence?: QueryResponse["confidence"];
  elapsedMs?: number;
  error?: string;
  ts?: number;
  status?: boolean;
}

type ChartKind = "bar" | "line" | "pie" | "table";

const KPI_VARIANTS = ["kpi-purple", "kpi-blue", "kpi-emerald", "kpi-amber"];
const STAT_ICONS = ["📈", "💰", "📦", "🏆"];

const COMPARISON_LABEL_COLS = /^(label|category|series|branch|department|supplier|vendor|name|alias)$/i;

function isTimeSeriesCol(name: string, data: Record<string, unknown>[]): boolean {
  if (/^(date|day|dt|time)\b/i.test(name)) return true;
  if (/^(month|week|yr|year)\b/i.test(name) && !/^period$/i.test(name)) return true;
  if (/^period$/i.test(name)) {
    const sample = data.slice(0, 5).map((r) => String(r[name] ?? ""));
    return sample.some((s) => /^\d{4}-\d{2}|^\d{1,2}[\/-]\d{1,2}/.test(s));
  }
  return false;
}

/** Wide single-row KPIs (YoY) → long rows so bar/pie charts render. */
function normalizeRowsForChart(data: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!data?.length || data.length > 1) return data;
  const row = data[0];
  const cols = Object.keys(row);
  const numCols = cols.filter((c) => typeof row[c] === "number");
  const labelCol = cols.find((c) => typeof row[c] !== "number");
  if (numCols.length >= 2 && !labelCol) {
    const labels: Record<string, string> = {
      ThisMonthSales: "This Month (MTD)",
      LastYearMonthSales: "Same Month Last Year",
      TodaySales: "Today",
      MTDSales: "MTD Sales",
    };
    return numCols.map((c) => ({
      Label: labels[c] ?? c.replace(/([a-z])([A-Z])/g, "$1 $2"),
      NetSales: row[c],
    }));
  }
  return data;
}

function detectChartKind(data: Record<string, unknown>[]): ChartKind {
  if (!data?.length) return "table";
  if (isCyLyComparisonRows(data)) return "bar";
  const cols = Object.keys(data[0]);
  const numCols = cols.filter((c) => typeof data[0][c] === "number");
  if (!numCols.length) return "table";
  const dateCol = cols.find((c) => isTimeSeriesCol(c, data));
  if (dateCol && numCols.length >= 1 && data.length >= 3) return "line";
  if (data.length <= 12 && numCols.length === 1) {
    const labelCol = cols.find((c) => !numCols.includes(c)) ?? "";
    if (data.length <= 6 || COMPARISON_LABEL_COLS.test(labelCol)) return "bar";
    return "pie";
  }
  return "bar";
}

function getChartColumns(data: Record<string, unknown>[]) {
  if (!data?.length) return { labelCol: "", numCols: [] as string[] };
  const cols = Object.keys(data[0]);
  const numCols = cols.filter((c) => typeof data[0][c] === "number");
  const dateCol = cols.find((c) => /^(date|day|month|week|period|dt|time|yr|year)\b/i.test(c));
  const labelCol = dateCol ?? cols.find((c) => !numCols.includes(c)) ?? cols[0];
  return { labelCol, numCols };
}

function fmtV(v: unknown): string {
  if (typeof v === "number") {
    if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
    if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)}L`;
    if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(v % 1 === 0 ? v : v.toFixed(2));
  }
  return String(v ?? "");
}

function isMoneyCol(name: string): boolean {
  return /sales|amount|value|mrp|revenue|net|pur|cost/i.test(name);
}

function buildCyLyStatCards(data: Record<string, unknown>[]) {
  let cy = 0;
  let ly = 0;
  for (const r of data) {
    cy += Number(r.TotalSales ?? r.totalsales ?? 0) || 0;
    ly += Number(r.PY_TotalSales ?? r.py_totalsales ?? 0) || 0;
  }
  const pct = ly ? ((cy - ly) / ly) * 100 : 0;
  return [
    {
      icon: "📈",
      val: fmtV(cy),
      lbl: "Current period",
      sub: `YTD · ${data.length} month${data.length === 1 ? "" : "s"}`,
      variant: KPI_VARIANTS[0],
    },
    {
      icon: "💰",
      val: fmtV(ly),
      lbl: "Same period last year",
      sub: "Comparable months",
      variant: KPI_VARIANTS[1],
    },
    {
      icon: "🏆",
      val: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
      lbl: "Overall change",
      sub: "CY vs LY total",
      variant: KPI_VARIANTS[2],
    },
  ];
}

function buildStatCards(data: Record<string, unknown>[]) {
  if (!data.length) return [];
  const cols = Object.keys(data[0]);
  const numCols = cols
    .filter((c) => typeof data[0][c] === "number")
    .sort((a, b) => {
      const am = isMoneyCol(a) ? 0 : 1;
      const bm = isMoneyCol(b) ? 0 : 1;
      return am - bm;
    });
  return numCols.slice(0, 4).map((col, i) => {
    const vals = data.map((r) => Number(r[col]) || 0);
    const sum = vals.reduce((a, b) => a + b, 0);
    const avg = vals.length ? sum / vals.length : 0;
    return {
      icon: STAT_ICONS[i % STAT_ICONS.length],
      val: isMoneyCol(col) ? fmtV(sum) : formatNum(sum),
      lbl: col,
      sub: `avg ${isMoneyCol(col) ? fmtV(avg) : formatNum(avg)} · ${data.length} rows`,
      variant: KPI_VARIANTS[i % KPI_VARIANTS.length],
    };
  });
}

function SmartChart({ data, kind }: { data: Record<string, unknown>[]; kind: ChartKind }) {
  if (!data?.length) return null;
  if (isCyLyComparisonRows(data)) {
    if (kind === "pie") {
      const piePrepared = buildPieSlices(
        data.map((r) => ({
          name: String(r.label ?? r.Label ?? ""),
          value: Number(r.TotalSales ?? r.totalsales ?? 0),
        })),
      );
      return (
        <ErpDonutChart
          slices={piePrepared.slices}
          total={piePrepared.total}
          formatValue={fmtV}
          height={360}
          title="YTD — Month-wise sales (current year)"
          othersNote={piePrepared.othersNote}
          othersItems={piePrepared.rest}
        />
      );
    }
    return (
      <ErpCyLyComparisonChart
        rows={data}
        kind={kind === "line" ? "line" : "bar"}
        height={360}
        title="Month-wise sales (current vs last year)"
      />
    );
  }
  const { labelCol, numCols } = getChartColumns(data);
  const primaryNum = numCols[0] ?? "";
  const chartH = Math.max(320, Math.min(data.length * 32, 640));

  const seriesColors = ["#6366f1", "#10b981", "#f59e0b", "#0ea5e9", "#ef4444", "#8b5cf6"];

  if (kind === "line") {
    const rows = data.map((r) => ({ ...r, _label: String(r[labelCol] ?? "") }));
    return (
      <div style={{ width: "100%", minHeight: 280 }}>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={rows} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
            <XAxis dataKey="_label" tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickFormatter={(v) => fmtV(v)} axisLine={false} tickLine={false} />
            <Tooltip content={<ErpChartTooltip formatValue={(v) => fmtV(v)} valueLabel="" />} />
            {numCols.slice(0, 4).map((col, i) => (
              <Line
                key={col}
                type="monotone"
                dataKey={col}
                stroke={seriesColors[i % seriesColors.length]}
                strokeWidth={2}
                dot={data.length < 60}
                name={col}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (kind === "pie" && primaryNum) {
    const piePrepared = buildPieSlices(
      data.map((r) => ({ name: String(r[labelCol] ?? ""), value: Number(r[primaryNum] ?? 0) })),
    );
    return (
      <ErpDonutChart
        slices={piePrepared.slices}
        total={piePrepared.total}
        formatValue={fmtV}
        height={360}
        othersNote={piePrepared.othersNote}
        othersItems={piePrepared.rest}
      />
    );
  }

  const barRows = data.map((r) => ({
    label: String(r[labelCol] ?? ""),
    value: Number(r[primaryNum] ?? 0),
  }));

  return (
    <ErpHBarChart
      rows={barRows}
      labelKey="label"
      valueKey="value"
      formatValue={fmtV}
      height={chartH}
    />
  );
}

function StatsBar({
  data,
  customCards,
}: {
  data: Record<string, unknown>[];
  customCards?: ReturnType<typeof buildStatCards>;
}) {
  const cards = useMemo(() => customCards ?? buildStatCards(data), [data, customCards]);
  if (!cards.length) return null;
  return (
    <div className="grid-stats">
      {cards.map((c) => (
        <div key={c.lbl} className={`kpi-card ${c.variant} fade-in`}>
          <span className="kpi-icon">{c.icon}</span>
          <div className="kpi-val" style={{ position: "relative", zIndex: 1 }}>{c.val}</div>
          <div className="kpi-lbl" style={{ position: "relative", zIndex: 1 }}>{c.lbl}</div>
          {c.sub ? (
            <div style={{ position: "relative", zIndex: 1, marginTop: 8, fontSize: 11, opacity: 0.85 }}>{c.sub}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function FullDataTable({ data }: { data: Record<string, unknown>[] }) {
  if (!data.length) return null;
  const cols = Object.keys(data[0]);
  return (
    <div className="ai-data-table-wrap data-table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>
                  {row[c] == null
                    ? "—"
                    : typeof row[c] === "number"
                      ? formatNum(row[c] as number)
                      : String(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserTurn({ text, ts }: { text: string; ts?: number }) {
  return (
    <div className="ai-user-turn">
      <div className="ai-user-pill">
        <p className="ai-user-pill-text">{text}</p>
        {ts ? (
          <span className="ai-user-pill-time">
            {new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AssistantTurn({ msg }: { msg: Message }) {
  const [showSql, setShowSql] = useState(false);
  const badge = msg.confidence ? getConfidenceBadge(msg.confidence) : null;
  const chartData = useMemo(
    () => normalizeRowsForChart(msg.data ?? []),
    [msg.data],
  );
  const cyLyChart = useMemo(() => isCyLyComparisonRows(chartData), [chartData]);
  const hasData = Boolean(msg.data?.length);
  const canChart = chartData.length >= 2 || (cyLyChart && chartData.length >= 1);
  const autoKind: ChartKind = canChart ? detectChartKind(chartData) : "table";
  const [viewMode, setViewMode] = useState<ChartKind>(() => autoKind);

  useEffect(() => {
    if (canChart) setViewMode(detectChartKind(chartData));
  }, [msg.id, canChart, chartData]);

  if (msg.status) {
    return (
      <div className="ai-assistant-turn">
        <div className="card p-4 ai-loading-card fade-in">
          <div className="flex items-center gap-3">
            <Bot size={18} color="var(--brand)" />
            <p className="text-sm font-semibold m-0" style={{ color: "var(--text-strong)" }}>
          {msg.text}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const confClass =
    msg.confidence === "low" ? "low" : msg.confidence === "medium" ? "medium" : "";

  const viewOpts: { kind: ChartKind; icon: React.ReactNode; label: string }[] = [
    { kind: "bar", icon: <BarChart2 size={12} />, label: "Bar" },
    { kind: "line", icon: <LineIcon size={12} />, label: "Line" },
    { kind: "pie", icon: <PieIcon size={12} />, label: "Pie" },
    { kind: "table", icon: <Table2 size={12} />, label: "Table" },
  ];

  return (
    <div className="ai-assistant-turn fade-in">
      {/* Plain-English answer — full width */}
      <div className={`card p-4 ai-plain-answer ${confClass}`}>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <p className="text-xs font-bold m-0 uppercase tracking-wide" style={{ color: "var(--accent-good)" }}>
            Plain-English Answer
          </p>
            {badge && (
            <span style={{ color: badge.color, fontWeight: 700, fontSize: 11 }}>● {badge.label}</span>
            )}
            {msg.rowCount !== undefined && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {formatNum(msg.rowCount)} rows
            </span>
            )}
            {msg.elapsedMs !== undefined && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>{msg.elapsedMs}ms</span>
          )}
        </div>
        <div className="ai-plain-answer-body">{msg.text}</div>
        {hasData && (
          <p className="text-[11px] mt-2 m-0" style={{ color: "var(--text-muted)" }}>
            Monetary fields shown in Lakhs/Cr where applicable (÷ 10⁵ / 10⁷).
          </p>
        )}
      </div>

      {/* KPI stat cards */}
      {hasData && (
        <StatsBar data={cyLyChart ? chartData : msg.data!} customCards={cyLyChart ? buildCyLyStatCards(chartData) : undefined} />
      )}

      {/* Chart — full width (needs 2+ points; YoY wide row is normalized to 2 rows) */}
      {hasData && viewMode !== "table" && canChart && (
        <div className="ai-result-chart-card">
          <div className="ai-result-chart-head">
            <div>
              <span className="text-sm font-bold" style={{ color: "var(--text-strong)" }}>
                {cyLyChart ? "📊 Month-wise sales (CY vs LY)" : "📊 AI Result Chart"}
              </span>
              <span
                className="text-[10px] font-bold ml-2 px-2 py-0.5 rounded-full"
                style={{ background: "rgba(99,102,241,0.15)", color: "var(--brand)" }}
              >
                {viewMode} (user)
              </span>
            </div>
            <div className="ai-view-toggle">
              {viewOpts.map((opt) => (
                <button
                  key={opt.kind}
                  type="button"
                  onClick={() => setViewMode(opt.kind)}
                  className={viewMode === opt.kind ? "btn-primary text-xs py-1 px-2.5" : "btn-ghost text-xs py-1 px-2.5"}
                  style={{ display: "flex", alignItems: "center", gap: 4 }}
                >
                  {opt.icon} {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="ai-result-chart-body">
            <SmartChart data={chartData} kind={viewMode} />
          </div>
        </div>
      )}

      {/* Meta + SQL */}
      <div className="ai-meta-row">
            {msg.sql && (
          <button
            type="button"
            onClick={() => setShowSql(!showSql)}
            className="btn-ghost text-xs py-1 px-2.5"
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            <Database size={12} /> {showSql ? "Hide" : "Show"} SQL {showSql ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        )}
        {hasData && viewMode === "table" && (
          <div className="ai-view-toggle" style={{ marginLeft: "auto" }}>
            {viewOpts.map((opt) => (
              <button
                key={opt.kind}
                type="button"
                onClick={() => setViewMode(opt.kind)}
                className={viewMode === opt.kind ? "btn-primary text-xs py-1 px-2.5" : "btn-ghost text-xs py-1 px-2.5"}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

        {showSql && msg.sql && (
        <pre
          style={{
            background: "#0f172a",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "12px 16px",
            fontSize: 12,
            color: "#a5b4fc",
            overflowX: "auto",
            margin: 0,
            width: "100%",
          }}
        >
            {msg.sql}
          </pre>
        )}

      {/* Full data table — all rows, page scroll only */}
      {hasData && (viewMode === "table" || !canChart) && (
        <div className="space-y-2" style={{ width: "100%" }}>
          <p className="text-xs font-semibold m-0" style={{ color: "var(--text-muted)" }}>
            {msg.rowCount ?? msg.data!.length} row(s) — full result
          </p>
          <FullDataTable data={msg.data!} />
        </div>
      )}

      {/* Table below chart when chart mode (Node shows both) */}
      {hasData && viewMode !== "table" && canChart && (
        <div className="space-y-2" style={{ width: "100%" }}>
          <p className="text-xs font-semibold m-0" style={{ color: "var(--text-muted)" }}>
            {msg.rowCount ?? chartData.length} row(s) returned
          </p>
          <FullDataTable data={chartData} />
      </div>
      )}
    </div>
  );
}

export default function AIQuery() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [tableHint, setTableHint] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  const [queryFrom, setQueryFrom] = useState("");
  const [queryTo, setQueryTo] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("erp_ai_context");
      if (!raw) return;
      sessionStorage.removeItem("erp_ai_context");
      const ctx = JSON.parse(raw) as { table?: string; label?: string };
      if (ctx.table) {
        setTableHint(ctx.table);
        setInput(`Tell me about ${ctx.label || ctx.table} — columns, sample metrics, and useful filters.`);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    queryApi.suggestions().then((r) => setSuggestions(r.suggestions)).catch(() => {});
    templatesApi.list().then((r) => setTemplates(r.templates)).catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const historyForApi = messages
    .filter((m) => m.role === "user" || (m.role === "assistant" && m.sql))
    .slice(-6)
    .reduce<{ question: string; sql: string }[]>((acc, m, i, arr) => {
      if (m.role === "user") {
        const next = arr[i + 1];
        if (next?.role === "assistant" && next.sql) {
          acc.push({ question: m.text, sql: next.sql });
        }
      }
      return acc;
    }, []);

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;
    const trimmed = text.trim();
    const ts = Date.now();
    setMessages((prev) => [...prev, { id: String(ts), role: "user", text: trimmed, ts }]);
    setInput("");

    try {
      const raw = localStorage.getItem("erp_ai_history");
      const hist: string[] = raw ? JSON.parse(raw) : [];
      localStorage.setItem(
        "erp_ai_history",
        JSON.stringify([trimmed, ...hist.filter((q) => q !== trimmed)].slice(0, 20)),
      );
    } catch {
      /* ignore */
    }

    setLoading(true);
    const purchaseLike = /\b(purchase|supplier|vendor|pur\b|returns? to supplier)\b/i.test(text);
    const statusId = `${Date.now()}-wait`;
    setMessages((prev) => [
      ...prev,
      {
        id: statusId,
        role: "assistant",
        text: purchaseLike
          ? "Running verified purchase SQL (up to 3 min on first run, then cached)…"
          : "Matching verified SQL or generating query…",
        status: true,
      },
    ]);

    try {
      const res = await queryApi.adaptive({
        question: trimmed,
        aiProvider: provider,
        conversationHistory: historyForApi,
        ...(tableHint ? { tableHint } : {}),
        ...(queryFrom || queryTo
          ? { userDateRange: { from: queryFrom || undefined, to: queryTo || undefined } }
          : {}),
      });
      if (tableHint) setTableHint(undefined);

      setMessages((prev) =>
        prev
          .filter((m) => m.id !== statusId)
          .concat({
            id: `${Date.now()}-ai`,
            role: "assistant",
            text: res.answer,
            sql: res.sql,
            data: res.data,
            rowCount: res.rowCount,
        confidence: res.confidence,
            elapsedMs: res.elapsedMs,
            ts: Date.now(),
          }),
      );
    } catch (e: unknown) {
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== statusId)
          .concat({
            id: `${Date.now()}-err`,
            role: "assistant",
            text: `Error: ${(e as Error).message}`,
        error: (e as Error).message,
            ts: Date.now(),
          }),
      );
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const clearChat = () => {
    setMessages([]);
    setInput("");
    setTableHint(undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div className="ai-query-page">
      <div className="ai-query-topbar">
        <p className="text-xs m-0" style={{ color: "var(--text-muted)" }}>
          Questions on the right · results use full width below
        </p>
        {messages.length > 0 && (
          <button type="button" className="btn-ghost text-xs py-1.5 px-3" onClick={clearChat}>
            <Trash2 size={14} style={{ marginRight: 4, verticalAlign: "middle" }} />
            Clear chat
          </button>
        )}
      </div>

      <div className="ai-query-messages">
        {messages.length === 0 && (
          <div className="text-center py-12" style={{ color: "var(--text-muted)" }}>
            <Bot size={48} style={{ opacity: 0.25, margin: "0 auto 12px" }} />
            <p className="text-sm m-0">Ask anything about your ERP data</p>
            <p className="text-xs mt-2 m-0">Type at the bottom — charts and tables span the full panel.</p>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <UserTurn key={m.id} text={m.text} ts={m.ts} />
          ) : (
            <AssistantTurn key={m.id} msg={m} />
          ),
        )}
        <div ref={bottomRef} />
      </div>

      <div className="ai-query-composer">
        {messages.length === 0 && suggestions.length > 0 && (
          <div className="ai-suggestions-row">
            {suggestions.slice(0, 6).map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => sendMessage(s.text)}
                className="btn-ghost text-xs py-1.5 px-3"
              >
                {s.source === "rag" && <span style={{ color: "var(--brand)", marginRight: 4 }}>✦</span>}
                {s.text}
              </button>
            ))}
          </div>
        )}

        {showTemplates && templates.length > 0 && (
          <div className="card p-2 mb-2 max-h-36 overflow-y-auto">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setInput(t.sql);
                  setShowTemplates(false);
                  inputRef.current?.focus();
                }}
                className="block w-full text-left py-2 px-2 rounded-lg btn-ghost text-sm"
              >
                <strong>{t.name}</strong>
              </button>
            ))}
          </div>
        )}

        <div className="ai-composer-toolbar">
          <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>AI</span>
          {(["openai", "anthropic"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setProvider(p)}
              className={provider === p ? "btn-primary text-xs py-1 px-2.5" : "btn-ghost text-xs py-1 px-2.5"}
            >
              {p === "openai" ? "GPT" : "Claude"}
            </button>
          ))}
          <input
            type="date"
            value={queryFrom}
            onChange={(e) => setQueryFrom(e.target.value)}
            className="input-base text-xs"
            title="From date"
          />
          <input
            type="date"
            value={queryTo}
            onChange={(e) => setQueryTo(e.target.value)}
            className="input-base text-xs"
            title="To date"
          />
          <button
            type="button"
            className="btn-ghost text-xs py-1 px-2.5"
            onClick={() => setShowTemplates(!showTemplates)}
          >
            <Star size={12} /> Templates
          </button>
      </div>

        <div className="ai-composer-input-row">
        <textarea
          ref={inputRef}
          value={input}
            onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
            rows={1}
            placeholder="Ask anything about your ERP data… (Enter to send, Shift+Enter for new line)"
            className="ai-composer-textarea"
        />
        <button
            type="button"
            className="ai-composer-send"
          onClick={() => sendMessage(input)}
          disabled={loading || !input.trim()}
            title="Send"
            aria-label="Send message"
          >
            <Send size={20} />
        </button>
        </div>
      </div>
    </div>
  );
}
