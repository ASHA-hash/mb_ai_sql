/* ═══════════════════════════════════════════════
   ANALYTICS ENGINE — cached aggregates, cross-filter, adaptive charts
═══════════════════════════════════════════════ */
const ANALYTICS_PERIOD_CHIPS = [
  { key: "mtd", label: "MTD" },
  { key: "qtd", label: "QTD" },
  { key: "ytd", label: "YTD" },
  { key: "last_30d", label: "30d" },
  { key: "last_90d", label: "90d" },
  { key: "6m", label: "Last 6M" },
  { key: "last_180d", label: "180d" },
  { key: "custom", label: "Custom" },
];

/** flex `order` values — personalize dashboard block sequence */
const ANALYTICS_LAYOUT_PRESETS = {
  default: { meta: 0, kpi: 10, trend: 20, split: 30, cat: 40, table: 50 },
  trend_first: { meta: 0, kpi: 20, trend: 10, split: 30, cat: 40, table: 50 },
  breakdown_first: { meta: 0, kpi: 10, split: 20, trend: 30, cat: 40, table: 50 },
};

/** Default MTD critical payload — warmed via idle prefetch + Analytics nav hover. */
const analyticsPrefetchStore = {
  criticalHit: null,
};

function mergeAnalyticsDashboard(critical, widgetsPatch) {
  if (!critical) return widgetsPatch;
  if (!widgetsPatch || widgetsPatch.loadPhase !== "widgets") return critical;
  const a = critical.vizHints || {};
  const b = widgetsPatch.vizHints || {};
  const yMax =
    a.yAxisMoneyMax != null && b.yAxisMoneyMax != null
      ? Math.max(a.yAxisMoneyMax, b.yAxisMoneyMax)
      : b.yAxisMoneyMax != null
        ? b.yAxisMoneyMax
        : a.yAxisMoneyMax;
  const next = {
    ...critical,
    widgets: {
      ...(critical.widgets || {}),
      ...(widgetsPatch.widgets || {}),
    },
    vizHints: {
      ...a,
      ...b,
      ...(yMax != null ? { yAxisMoneyMax: yMax } : {}),
    },
    insights: Array.isArray(widgetsPatch.insights) ? widgetsPatch.insights : critical.insights,
    insightsMeta: widgetsPatch.insightsMeta != null ? widgetsPatch.insightsMeta : critical.insightsMeta,
    computedAt: widgetsPatch.computedAt || critical.computedAt,
    cacheHit: Boolean(critical.cacheHit && widgetsPatch.cacheHit),
    cacheLayer: [critical.cacheLayer, widgetsPatch.cacheLayer].filter(Boolean).join("+") || critical.cacheLayer,
  };
  if (next.loadPhase === "critical") delete next.loadPhase;
  return next;
}

function prefetchAnalyticsCriticalDefault(token) {
  if (!token) return;
  const body = { period: "mtd", dataset: "sales", loadPhase: "critical", compact: true };
  const key = JSON.stringify(body);
  const prev = analyticsPrefetchStore.criticalHit;
  if (prev && prev.key === key && Date.now() - prev.ts < 60_000) return;
  apiFetch("/api/analytics/dashboard", { method: "POST", token, body, timeoutMs: ERP_ANALYTICS_TIMEOUT_MS })
    .then((data) => {
      analyticsPrefetchStore.criticalHit = { key, data, ts: Date.now() };
    })
    .catch(() => {});
}

function AnalyticsKpiSkeleton() {
  return (
    <div className="grid-stats animate-pulse">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="kpi-card" style={{ background: "rgba(148,163,184,0.15)" }}>
          <div className="h-8 w-24 rounded mx-auto mt-2" style={{ background: "rgba(148,163,184,0.35)" }} />
          <div className="h-3 w-20 rounded mx-auto mt-3" style={{ background: "rgba(148,163,184,0.25)" }} />
        </div>
      ))}
    </div>
  );
}

function AnalyticsChartSkeleton({ tall }) {
  return (
    <div className={`card space-y-3 animate-pulse ${tall ? "p-4" : "p-4"}`}>
      <div className="h-4 w-36 rounded" style={{ background: "rgba(148,163,184,0.3)" }} />
      <div className="rounded-lg" style={{ height: tall ? 260 : 220, background: "rgba(148,163,184,0.12)" }} />
    </div>
  );
}

function AnalyticsPanel({ auth }) {
  const [period, setPeriod] = useState("mtd");
  const [fy, setFy] = useState("");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [crossFilter, setCrossFilter] = useState({});
  const [trendMonth, setTrendMonth] = useState("");
  const [forceGranularity, setForceGranularity] = useState("auto");
  const [data, setData] = useState(null);
  const [loadingCritical, setLoadingCritical] = useState(false);
  const [loadingWidgets, setLoadingWidgets] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const loadSeqRef = React.useRef(0);
  const [err, setErr] = useState("");
  const [viewName, setViewName] = useState("");
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillRows, setDrillRows] = useState([]);
  const [virtScroll, setVirtScroll] = useState(0);
  const [branchVirt, setBranchVirt] = useState(0);
  const versionRef = React.useRef(0);
  const pollBootRef = React.useRef(false);

  const [layoutPreset, setLayoutPreset] = useState(() => {
    try {
      return localStorage.getItem("erp_analytics_layout_preset") || "default";
    } catch {
      return "default";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("erp_analytics_layout_preset", layoutPreset);
    } catch {}
  }, [layoutPreset]);
  const ROW_H = 28;

  const [analyticsBarOrientation, setAnalyticsBarOrientation] = useState(() => {
    try {
      const v = localStorage.getItem("erp_analytics_bar_orientation");
      if (v === "horizontal" || v === "vertical") return v;
      return "vertical";
    } catch {
      return "vertical";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("erp_analytics_bar_orientation", analyticsBarOrientation);
    } catch {}
  }, [analyticsBarOrientation]);

  const layoutOrd = ANALYTICS_LAYOUT_PRESETS[layoutPreset] || ANALYTICS_LAYOUT_PRESETS.default;

  const [savedViews, setSavedViews] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("erp_analytics_views") || "[]");
    } catch {
      return [];
    }
  });

  const dims = data && data.dimensions;
  const branchCol = dims && dims.branchColumn;
  const deptCol = dims && dims.departmentColumn;
  const catCol = dims && dims.categoryColumn;
  const selectedPeriodLabel =
    (ANALYTICS_PERIOD_CHIPS.find((p) => p.key === period) || {}).label || String(period || "").toUpperCase();
  const isLoadingAny = loadingCritical || loadingWidgets;

  const load = React.useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoadingCritical(true);
    setLoadingWidgets(true);
    setLoadingMessage(`Fetching ${selectedPeriodLabel} KPIs and trend…`);
    setErr("");
    const bodyBase = { period, crossFilter, dataset: "sales", compact: true };
    if (fy.trim()) bodyBase.fy = fy.trim();
    if (period === "custom") bodyBase.custom = { from: customFrom, to: customTo };
    if (trendMonth && /^\d{4}-\d{2}$/.test(trendMonth.trim())) bodyBase.trendMonth = trendMonth.trim();
    if (forceGranularity === "day") bodyBase.forceTrendGranularity = "day";
    if (forceGranularity === "month") bodyBase.forceTrendGranularity = "month";

    // Heavy periods (90d / 6M / 180d) need a longer client timeout — server query spans months of data
    const analyticsTimeout = ANALYTICS_HEAVY_PERIODS.has(period)
      ? ERP_ANALYTICS_HEAVY_TIMEOUT_MS
      : ERP_ANALYTICS_TIMEOUT_MS;
    try {
      const prefetchKey = JSON.stringify({ ...bodyBase, loadPhase: "critical" });
      let critical;
      const hit = analyticsPrefetchStore.criticalHit;
      if (hit && hit.key === prefetchKey && Date.now() - hit.ts < 90_000) {
        critical = hit.data;
        analyticsPrefetchStore.criticalHit = null;
      } else {
        critical = await apiFetch("/api/analytics/dashboard", {
          method: "POST",
          token: auth.token,
          timeoutMs: analyticsTimeout,
          body: { ...bodyBase, loadPhase: "critical" },
        });
      }
      if (seq !== loadSeqRef.current) return;
      setData(critical);
      setLoadingCritical(false);
      setLoadingMessage(`Fetching ${selectedPeriodLabel} breakdowns and insights…`);

      const mergedDvBase = critical && critical.dataVersion;
      if (mergedDvBase != null) {
        versionRef.current = mergedDvBase;
        pollBootRef.current = true;
      }

      try {
        const widgetsPatch = await apiFetch("/api/analytics/dashboard", {
          method: "POST",
          token: auth.token,
          timeoutMs: analyticsTimeout,
          body: { ...bodyBase, loadPhase: "widgets" },
        });
        if (seq !== loadSeqRef.current) return;
        setData((prev) => mergeAnalyticsDashboard(prev, widgetsPatch));
        const mergedDv = widgetsPatch && widgetsPatch.dataVersion;
        if (mergedDv != null) {
          versionRef.current = mergedDv;
        }
      } catch (wErr) {
        if (seq !== loadSeqRef.current) return;
        setErr((wErr && wErr.message) || String(wErr));
      } finally {
        if (seq === loadSeqRef.current) {
          setLoadingWidgets(false);
          setLoadingMessage("");
        }
      }
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setErr(e.message || String(e));
      setData(null);
      setLoadingCritical(false);
      setLoadingWidgets(false);
      setLoadingMessage("");
    }
  }, [auth.token, period, fy, customFrom, customTo, crossFilter, trendMonth, forceGranularity, selectedPeriodLabel]);

  useEffect(() => {
    if (period === "custom" && (!customFrom || !customTo)) return;
    load();
  }, [load, period, customFrom, customTo, crossFilter, fy, trendMonth, forceGranularity]);

  useEffect(() => {
    const base = getApiBase();
    const k = getApiKey();
    const tok = auth && auth.token;
    const params = new URLSearchParams();
    if (tok) params.set("access_token", tok);
    if (k) params.set("api_key", k);
    const qs = params.toString();
    const url = `${base}/api/analytics/events${qs ? `?${qs}` : ""}`;
    let es;
    try {
      es = new EventSource(url);
      es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          const dv = d.dataVersion;
          if (dv == null || !pollBootRef.current) return;
          if (dv !== versionRef.current) {
            versionRef.current = dv;
            load();
          }
        } catch (_) {}
      };
    } catch (_) {}

    const id = setInterval(async () => {
      try {
        if (!pollBootRef.current) return;
        const v = await apiFetch("/api/analytics/version", { token: auth.token });
        const dv = v && v.dataVersion;
        if (dv != null && dv !== versionRef.current) {
          versionRef.current = dv;
          load();
        }
      } catch {}
    }, 60000);
    return () => {
      clearInterval(id);
      try {
        if (es) es.close();
      } catch (_) {}
    };
  }, [auth.token, load]);

  function toggleCross(dimSqlCol, label) {
    if (!dimSqlCol) return;
    const v = String(label || "").trim();
    if (!v) return;
    setCrossFilter((prev) => {
      const next = { ...prev };
      if (next[dimSqlCol] === v) delete next[dimSqlCol];
      else next[dimSqlCol] = v;
      return next;
    });
  }

  function saveView() {
    const name = (viewName || "Saved view").trim();
    const entry = {
      name,
      period,
      fy: fy || "",
      customFrom,
      customTo,
      crossFilter,
      trendMonth: trendMonth || "",
      forceGranularity: forceGranularity || "auto",
      layoutPreset: layoutPreset || "default",
      analyticsBarOrientation: analyticsBarOrientation || "vertical",
      at: Date.now(),
    };
    const next = [entry, ...savedViews.filter((x) => x.name !== name)].slice(0, 12);
    setSavedViews(next);
    try {
      localStorage.setItem("erp_analytics_views", JSON.stringify(next));
    } catch {}
  }

  function applySaved(i) {
    const v = savedViews[i];
    if (!v) return;
    setPeriod(v.period || "mtd");
    setFy(v.fy || "");
    setCustomFrom(v.customFrom || "");
    setCustomTo(v.customTo || "");
    setTrendMonth(v.trendMonth || "");
    setForceGranularity(v.forceGranularity || "auto");
    setLayoutPreset(v.layoutPreset || "default");
    setAnalyticsBarOrientation(
      v.analyticsBarOrientation === "horizontal" || v.analyticsBarOrientation === "vertical"
        ? v.analyticsBarOrientation
        : "vertical"
    );
    setCrossFilter(v.crossFilter && typeof v.crossFilter === "object" ? { ...v.crossFilter } : {});
    setViewName(v.name || "");
  }

  async function openDrillthrough() {
    if (!data || !data.period) return;
    setDrillLoading(true);
    setErr("");
    try {
      const body = {
        dataset: "sales",
        from: data.period.from,
        to: data.period.to,
        crossFilter,
        limit: 400,
      };
      const r = await apiFetch("/api/analytics/drillthrough", {
        method: "POST",
        token: auth.token,
        body,
      });
      setDrillRows(Array.isArray(r.data) ? r.data : []);
      setVirtScroll(0);
      setDrillOpen(true);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setDrillLoading(false);
    }
  }

  const kpi = data && data.kpi;
  const wB = data && data.widgets && data.widgets.byBranch;
  const wD = data && data.widgets && data.widgets.byDepartment;
  const wC = data && data.widgets && data.widgets.byCategory;
  const wT = data && data.widgets && data.widgets.byTrend;

  const branchChartRows = normalizeAnalyticsChartRows(wB && wB.rows ? wB.rows : [], 'branch')
    .filter((r) => r.SaleNetAmount > 0)
    .sort((a, b) => b.SaleNetAmount - a.SaleNetAmount);
  const deptChartRows = normalizeAnalyticsChartRows(wD && wD.rows ? wD.rows : [], 'dept')
    .filter((r) => r.SaleNetAmount > 0)
    .sort((a, b) => b.SaleNetAmount - a.SaleNetAmount);
  const catChartRows = normalizeAnalyticsChartRows(wC && wC.rows ? wC.rows : [], 'cat')
    .filter((r) => r.SaleNetAmount > 0)
    .sort((a, b) => b.SaleNetAmount - a.SaleNetAmount);
  const trendRows = (wT && wT.rows ? wT.rows : []).map((r) => {
    const rev = readRevenueFromRow(r, pickCanonicalRevenueKey([r]));
    return {
      period_label: r.period_label != null ? r.period_label : r.label,
      SaleNetAmount: rev,
      MrpValue: rev,
      metric_value: rev,
      txn_count: r.txn_count != null ? parseFloat(r.txn_count) : undefined,
    };
  });

  function barClickFactory(rows, dimKey) {
    return (params) => {
      const idx = params && params.dataIndex;
      if (idx == null || !rows[idx]) return;
      toggleCross(dimKey, rows[idx].label);
    };
  }

  function onTrendPointClick(params) {
    const idx = params && params.dataIndex;
    if (idx == null || !wT || !wT.rows || !wT.rows[idx]) return;
    const pl = String(wT.rows[idx].period_label || "");
    if (wT.granularity === "month" && /^\d{4}-\d{2}/.test(pl)) {
      setTrendMonth(pl.slice(0, 7));
    }
  }

  const qual = data && data.quality;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-800">📈 Analytics Engine</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Server-side rollups with cache, checksums, and cross-filtering (same column names as your SQL view).
        </p>
      </div>

      {data && Array.isArray(data.insights) && data.insights.length > 0 && (
        <div
          className="card p-4 border-l-4"
          style={{
            borderLeftColor: "var(--chart-axis-active, #7c3aed)",
            background: "var(--bg-muted, rgba(124,58,237,.06))",
          }}
        >
          <h3 className="text-sm font-bold text-slate-700 mb-2 flex items-center gap-2">
            <span aria-hidden>💡</span> Automatic insights
            <span className="text-[10px] font-normal uppercase tracking-wide text-slate-500">
              data-derived · not generative
            </span>
          </h3>
          <ul className="space-y-3 text-sm text-slate-700">
            {data.insights.map((ins) => (
              <li key={ins.id} className="leading-snug">
                <span className="font-semibold text-slate-800">{ins.title}</span>
                {ins.detail && (
                  <p className="text-xs text-slate-600 mt-0.5">{ins.detail}</p>
                )}
                {(ins.caveats && ins.caveats.length > 0) || ins.confidence === "low" ? (
                  <p className="text-[11px] text-amber-800/90 mt-1 italic">
                    {ins.confidence === "low" ? "Low confidence — " : ""}
                    {(ins.caveats || []).join(" ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {data.insightsMeta && data.insightsMeta.priorFrom && (
            <p className="text-[10px] text-slate-500 mt-3 font-mono">
              Compare basis: current {data.period && data.period.from}→{data.period && data.period.to} vs prior{" "}
              {data.insightsMeta.priorFrom}→{data.insightsMeta.priorTo} (same length, same filters).
            </p>
          )}
        </div>
      )}

      <div className="card p-4 flex flex-wrap gap-2 items-center">
        {ANALYTICS_PERIOD_CHIPS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPeriod(p.key)}
            className={`chip ${period === p.key ? "ring-2 ring-indigo-400 bg-indigo-50" : ""}`}
          >
            {p.label}
          </button>
        ))}
        {period === "custom" && (
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="input-base text-xs w-auto"
            />
            <span className="text-xs text-slate-500">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="input-base text-xs w-auto"
            />
            <button type="button" onClick={() => load()} className="btn-primary text-xs py-1.5 px-3">
              Apply range
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => load()}
          disabled={isLoadingAny}
          className="btn-ghost text-xs py-1.5 ml-auto"
        >
          {isLoadingAny ? `⏳ Loading ${selectedPeriodLabel}…` : `↻ Load ${selectedPeriodLabel}`}
        </button>
        <button
          type="button"
          className="btn-ghost text-xs py-1.5"
          title="Clear analytics cache and reload"
          disabled={isLoadingAny}
          onClick={async () => {
            try {
              await apiFetch("/api/analytics/invalidate-cache", { method: "POST", token: auth.token });
            } catch (e) {
              console.warn("[analytics] cache invalidate:", e.message);
            }
            load();
          }}
        >
          Flush cache
        </button>
      </div>

      {isLoadingAny && (
        <div className="card p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Spinner size={14} />
            <span>{loadingMessage || "Loading analytics…"}</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-200/70 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: loadingCritical ? "45%" : "90%",
                background: "linear-gradient(90deg, #6366f1, #8b5cf6)",
              }}
            />
          </div>
          <div className="text-[10px] text-slate-500">
            {loadingCritical
              ? "Step 1/2: Critical payload (KPIs + trend)"
              : "Step 2/2: Widgets payload (branch/department/category + insights)"}
          </div>
        </div>
      )}

      <div className="card p-4 flex flex-wrap gap-3 items-end text-xs">
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-slate-600">India FY (Apr–Mar)</span>
          <div className="flex items-center gap-2">
            <input
              className="input-base text-xs w-28"
              placeholder="FY26"
              value={fy}
              onChange={(e) => setFy(e.target.value)}
            />
            <button type="button" className="btn-ghost text-xs py-1 px-2" onClick={() => setFy("")}>
              Clear
            </button>
          </div>
          <span className="text-[10px] text-slate-500 max-w-[220px] leading-tight">
            Narrows MTD / QTD / 30d / … to this Apr–Mar window. Leave blank to use the full chip range only.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-slate-600">Trend grain</span>
          <select
            className="input-base text-xs min-w-[140px]"
            value={forceGranularity}
            onChange={(e) => setForceGranularity(e.target.value)}
          >
            <option value="auto">Auto (range-based)</option>
            <option value="day">Force daily</option>
            <option value="month">Force monthly</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-slate-600">Drill trend → month</span>
          <div className="flex items-center gap-2">
            <input
              type="month"
              className="input-base text-xs"
              value={trendMonth}
              onChange={(e) => setTrendMonth(e.target.value)}
            />
            {trendMonth && (
              <button type="button" className="btn-ghost text-xs py-1 px-2" onClick={() => setTrendMonth("")}>
                Clear
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1 min-w-[160px]">
          <span className="font-semibold text-slate-600">Layout</span>
          <select
            className="input-base text-xs"
            value={layoutPreset}
            onChange={(e) => setLayoutPreset(e.target.value)}
          >
            <option value="default">Default</option>
            <option value="trend_first">Trend first</option>
            <option value="breakdown_first">Breakdowns first</option>
          </select>
        </div>
        <div className="flex flex-col gap-1 min-w-[168px]">
          <span className="font-semibold text-slate-600" title="Branch, department, and category bar charts">
            Breakdown bars
          </span>
          <div
            className="flex rounded-lg overflow-hidden border text-xs font-bold"
            style={{ borderColor: "var(--border, #e2e8f0)" }}
          >
            <button
              type="button"
              className="flex-1 py-1.5 px-2 transition-colors"
              style={{
                background: analyticsBarOrientation === "vertical" ? "var(--brand,#6366f1)" : "var(--surface2,#f8fafc)",
                color: analyticsBarOrientation === "vertical" ? "#fff" : "var(--text-muted,#64748b)",
              }}
              onClick={() => setAnalyticsBarOrientation("vertical")}
              title="Categories on the X axis (vertical columns)"
            >
              Cat on X
            </button>
            <button
              type="button"
              className="flex-1 py-1.5 px-2 transition-colors border-l"
              style={{
                borderColor: "var(--border, #e2e8f0)",
                background: analyticsBarOrientation === "horizontal" ? "var(--brand,#6366f1)" : "var(--surface2,#f8fafc)",
                color: analyticsBarOrientation === "horizontal" ? "#fff" : "var(--text-muted,#64748b)",
              }}
              onClick={() => setAnalyticsBarOrientation("horizontal")}
              title="Categories on the Y axis (horizontal bars)"
            >
              Cat on Y
            </button>
          </div>
          <span className="text-[10px] text-slate-500 leading-tight">Saved in this browser</span>
        </div>
        <button
          type="button"
          className="btn-primary text-xs py-2 px-4 ml-auto"
          disabled={drillLoading || !data}
          onClick={openDrillthrough}
        >
          {drillLoading ? "…" : "🔎 Drill-through (rows)"}
        </button>
      </div>

      {Object.keys(crossFilter).length > 0 && (
        <div className="flex flex-wrap gap-2 items-center text-xs">
          <span className="font-semibold text-slate-600">Cross-filter:</span>
          {Object.entries(crossFilter).map(([k, v]) => (
            <button
              key={k}
              type="button"
              className="badge bg-indigo-100 text-indigo-800 cursor-pointer"
              onClick={() => toggleCross(k, v)}
            >
              {k}={String(v)} ✕
            </button>
          ))}
          <button type="button" className="text-slate-500 hover:text-slate-800 underline" onClick={() => setCrossFilter({})}>
            Clear all
          </button>
        </div>
      )}

      <div className="card p-4 space-y-2">
        <p className="text-xs font-semibold text-slate-600">Saved views (browser)</p>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            placeholder="View name"
            className="input-base text-xs max-w-[200px]"
          />
          <button type="button" onClick={saveView} className="btn-primary text-xs py-1.5 px-3">
            Save
          </button>
          {savedViews.length > 0 && (
            <select
              className="input-base text-xs max-w-[240px]"
              onChange={(e) => {
                const i = parseInt(e.target.value, 10);
                if (!Number.isNaN(i)) applySaved(i);
                e.target.value = "";
              }}
              defaultValue=""
            >
              <option value="" disabled>
                Load saved…
              </option>
              {savedViews.map((v, i) => (
                <option key={i} value={i}>
                  {v.name} · {v.period}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {loadingCritical && !data && (
        <div className="space-y-4 fade-in">
          <AnalyticsKpiSkeleton />
          <AnalyticsChartSkeleton tall />
          <div className="grid-2col gap-4">
            <AnalyticsChartSkeleton />
            <AnalyticsChartSkeleton />
          </div>
          <AnalyticsChartSkeleton />
          <div className="card p-3 flex items-center gap-2 text-xs text-slate-500">
            <Spinner size={14} />
            <span>
              Loading KPIs and trend…
              {ANALYTICS_HEAVY_PERIODS.has(period) && (
                <span className="ml-1 text-amber-600 font-medium">
                  ⏳ {period === "last_180d" || period === "6m" ? "6-month" : "90-day"} queries can take 2–4 min on first load — please wait
                </span>
              )}
            </span>
          </div>
        </div>
      )}
      {err && (
        <div>
          <Alert type="error" msg={err} onClose={() => setErr("")} />
          {(err.includes("360000") || err.includes("timeout") || err.toLowerCase().includes("timed out") || err.includes("600000") || err.includes("660000")) && ANALYTICS_HEAVY_PERIODS.has(period) && (
            <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex flex-col gap-2">
              <p className="font-semibold">⏳ The {period === "6m" || period === "last_180d" ? "6-month" : "90-day"} query timed out on the first cold run.</p>
              <p className="text-xs text-amber-700">The server is still computing in the background — it will be cached for the next request. Click <strong>↻ Reload</strong> in 1–2 minutes and it should load instantly from cache.</p>
              <button
                type="button"
                onClick={() => { setErr(""); load(); }}
                className="self-start text-xs font-bold px-4 py-2 rounded-lg border-0 cursor-pointer"
                style={{ background: "#d97706", color: "#fff" }}
              >
                ↻ Retry now
              </button>
            </div>
          )}
        </div>
      )}

      {loadingWidgets && data && (
        <div className="card p-3 flex items-center gap-2 text-xs text-slate-500">
          <Spinner size={14} />
          <span>
            Loading breakdowns and insights…
            {ANALYTICS_HEAVY_PERIODS.has(period) && <span className="ml-1 text-amber-600">⏳ may take a moment</span>}
          </span>
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-3 fade-in">
          <div style={{ order: layoutOrd.meta }} className="space-y-2">
          <div className="flex flex-wrap gap-2 text-[11px] text-slate-500">
            <span>
              v{data.dataVersion} {data.cacheHit ? "· cached" : "· fresh"}
              {data.cacheLayer && (
                <span>
                  {" "}
                  · {String(data.cacheLayer)}
                </span>
              )}
            </span>
            <span>
              ·{" "}
              {loadingCritical
                ? `${String(period || "").toUpperCase()} · updating…`
                : data.period && data.period.preset
                  ? String(data.period.preset).toUpperCase()
                  : String(period || "").toUpperCase()}
            </span>
            {data.period && data.period.fyLabel && <span>· {data.period.fyLabel}</span>}
            <span>
              ·{" "}
              {loadingCritical
                ? "… → …"
                : `${data.period && data.period.from ? data.period.from : ""} → ${data.period && data.period.to ? data.period.to : ""}`}
            </span>
            <span>· computed {data.computedAt && new Date(data.computedAt).toLocaleString()}</span>
            <span>
              · SSE + 60s backup · Σ {data && data.compositeFingerprint ? data.compositeFingerprint.slice(0, 10) : "—"}
            </span>
          </div>
          {data.period && data.period.fyContextNote && (
            <p className="text-[11px] text-amber-900/90 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 leading-snug max-w-3xl">
              {data.period.fyContextNote}
            </p>
          )}
          {qual && qual.sourceSync && (
            <p className="text-[11px] text-slate-500">
              Source window: latest txn date {qual.sourceSync.rangeMaxDate || "—"}
              {qual.sourceSync.watermarkMax && (
                <>
                  {" "}
                  · ETL watermark ({qual.sourceSync.watermarkColumn || "?"}): {qual.sourceSync.watermarkMax}
                </>
              )}
              {qual.sourceSync.trendVsKpiSkipped
                ? " · trend vs KPI check skipped (month drill)"
                : qual.sourceSync.kpiTrendAligned === false
                  ? " · trend sum vs KPI mismatch (see warnings)"
                  : " · trend Σ vs KPI OK"}
            </p>
          )}
          {data.vizHints && data.vizHints.yAxisMoneyMax != null && (
            <p className="text-[11px] text-slate-500">
              Shared scale cap (₹ raw): {formatCompactNumber(data.vizHints.yAxisMoneyMax)} — branch {wB && wB.checksum ? wB.checksum.slice(0, 8) : "—"} · trend{" "}
              {wT && wT.checksum ? wT.checksum.slice(0, 8) : "—"}
            </p>
          )}

          {qual && qual.reconciliation && (qual.reconciliation.mismatch || qual.reconciliation.error) && (
            <div
              className={
                qual.reconciliation.error
                  ? "rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900"
                  : "rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900"
              }
            >
              <span className="font-semibold">
                {qual.reconciliation.error ? "Reconciliation error" : "Data reconciliation mismatch"}
              </span>
              <p className="mt-1">
                {qual.reconciliation.error
                  ? qual.reconciliation.message || "Source verification query failed."
                  : qual.reconciliation.sourceTable &&
                      qual.reconciliation.dashboardTable &&
                      qual.reconciliation.source &&
                      qual.reconciliation.dashboard
                    ? `Line-level ${qual.reconciliation.sourceTable} vs dashboard ${qual.reconciliation.dashboardTable}: ` +
                      `Σ sales source ₹${Number(qual.reconciliation.source.totalSales || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })} vs ` +
                      `dashboard ₹${Number(qual.reconciliation.dashboard.totalSales || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })} · ` +
                      `rows ${qual.reconciliation.source.txnCount} vs ${qual.reconciliation.dashboard.txnCount}.`
                    : `Reported in quality.reconciliation — inspect API payload.`}
              </p>
              {qual.reconciliation.drift && (
                <p className="mt-1 text-[11px] opacity-90">
                  Drift (money % / txn): {(qual.reconciliation.drift.moneyPct * 100).toFixed(4)}% · txn Δ{" "}
                  {qual.reconciliation.drift.txnAbs}
                </p>
              )}
            </div>
          )}

          {qual && qual.warnings && qual.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <span className="font-semibold">Quality checks</span>
              <ul className="list-disc ml-4 mt-1 space-y-0.5">
                {qual.warnings.map((w, i) => (
                  <li key={i}>{typeof w === "string" ? w : w.message || JSON.stringify(w)}</li>
                ))}
              </ul>
            </div>
          )}
          </div>

          <div style={{ order: layoutOrd.kpi }}>
          <div className="grid-stats">
            <div className="kpi-card kpi-purple">
              <span className="kpi-icon">💰</span>
              <div className="kpi-val">{formatCompactNumber((kpi && kpi.totalSales) || 0)}</div>
              <div className="kpi-lbl">Total sales</div>
            </div>
            <div className="kpi-card kpi-purple">
              <span className="kpi-icon">🧾</span>
              <div className="kpi-val">{(kpi && kpi.txnCount) || 0}</div>
              <div className="kpi-lbl">Transactions</div>
            </div>
            <div className="kpi-card kpi-purple">
              <span className="kpi-icon">📅</span>
              <div className="kpi-val">{(kpi && kpi.activeDays) || 0}</div>
              <div className="kpi-lbl">Active days</div>
            </div>
            <div className="kpi-card kpi-purple">
              <span className="kpi-icon">✓</span>
              <div className="kpi-val" style={{ fontSize: "13px", marginTop: 8, letterSpacing: "-0.5px", wordBreak: "break-all" }}>
                {data && data.compositeFingerprint
                  ? data.compositeFingerprint.slice(0, 10)
                  : (qual && qual.checksumKpi) || "—"}
              </div>
              <div className="kpi-lbl">Checksum (Σ)</div>
            </div>
          </div>
          </div>

          <div style={{ order: layoutOrd.trend }}>
          {wT && trendRows.length > 0 && (
            <div className="card p-4">
              {wT.granularity === "month" && (
                <p className="text-[11px] mb-2" style={{ color: "var(--text-muted)" }}>
                  Click a month to drill daily for that month (sets "Drill trend → month").
                </p>
              )}
              <MemoLineChart
                rows={trendRows}
                labelCol="period_label"
                valueCols={["SaleNetAmount"]}
                valueAxisMaxRaw={data.vizHints && data.vizHints.yAxisMoneyMax}
                forecast={wT.forecast && wT.forecast.enabled ? wT.forecast : null}
                title={
                  data.trendContext && data.trendContext.drillMonth
                    ? `Sales trend — ${data.trendContext.drillMonth} (daily)`
                    : wT.granularity === "month"
                      ? "Sales trend (monthly buckets)"
                      : "Sales trend (daily buckets)"
                }
                onPointClick={wT.granularity === "month" ? onTrendPointClick : undefined}
              />
              {wT.progressive && wT.progressive.mode === "sampled" && (
                <p className="text-[11px] mt-2" style={{ color: "var(--text-muted)" }}>
                  Progressive rendering: {wT.progressive.sampleSize} points shown (stride {wT.progressive.stride || 1}).
                </p>
              )}
            </div>
          )}
          </div>

          <div style={{ order: layoutOrd.split }} className="grid-2col gap-4">
            {loadingWidgets && branchChartRows.length === 0 && <AnalyticsChartSkeleton />}
            {loadingWidgets && deptChartRows.length === 0 && <AnalyticsChartSkeleton />}
            {branchChartRows.length > 0 &&
              (wB && wB.chartPolicy === "pie" ? (
                <div className="card p-4">
                  <MemoPieChart rows={branchChartRows} labelCol="label" valueCol="SaleNetAmount" title="By branch" />
                </div>
              ) : (
                <div className="card p-4">
                  <MemoBarChart
                    rows={branchChartRows}
                    labelCol="label"
                    valueCols={["SaleNetAmount"]}
                    title="By branch — click to filter"
                    barOrientation={analyticsBarOrientation}
                    onPointClick={barClickFactory(branchChartRows, branchCol)}
                    valueAxisMaxRaw={data.vizHints && data.vizHints.yAxisMoneyMax}
                  />
                </div>
              ))}
            {deptChartRows.length > 0 &&
              (wD && wD.chartPolicy === "pie" ? (
                <div className="card p-4">
                  <MemoPieChart rows={deptChartRows} labelCol="label" valueCol="SaleNetAmount" title="By department" />
                </div>
              ) : (
                <div className="card p-4">
                  <MemoBarChart
                    rows={deptChartRows}
                    labelCol="label"
                    valueCols={["SaleNetAmount"]}
                    title="By department — click to filter"
                    barOrientation={analyticsBarOrientation}
                    onPointClick={barClickFactory(deptChartRows, deptCol)}
                    valueAxisMaxRaw={data.vizHints && data.vizHints.yAxisMoneyMax}
                  />
                </div>
              ))}
          </div>

          <div style={{ order: layoutOrd.cat }}>
          {loadingWidgets && catChartRows.length === 0 && <AnalyticsChartSkeleton />}
          {catChartRows.length > 0 && (
            <div className="card p-4">
              {wC && wC.chartPolicy === "pie" ? (
                <MemoPieChart rows={catChartRows} labelCol="label" valueCol="SaleNetAmount" title="By category" />
              ) : (
                <MemoBarChart
                  rows={catChartRows}
                  labelCol="label"
                  valueCols={["SaleNetAmount"]}
                  title="By category — click to filter"
                  barOrientation={analyticsBarOrientation}
                  onPointClick={barClickFactory(catChartRows, catCol)}
                  valueAxisMaxRaw={data.vizHints && data.vizHints.yAxisMoneyMax}
                />
              )}
            </div>
          )}
          </div>

          <div style={{ order: layoutOrd.table }}>
          {wB && wB.rows && wB.rows.length > 24 && (() => {
            const br = wB.rows;
            const st = Math.max(0, Math.floor(branchVirt / ROW_H) - 2);
            const SL = 24;
            const sl = br.slice(st, st + SL);
            const topPad = st * ROW_H;
            const botPad = Math.max(0, br.length - st - sl.length) * ROW_H;
            return (
              <div className="card p-3">
                <p className="text-xs font-semibold text-slate-600 mb-2">Branch breakdown (virtualized)</p>
                <div
                  className="table-scroll max-h-52 overflow-y-auto border border-slate-100 rounded-lg"
                  onScroll={(e) => setBranchVirt(e.target.scrollTop)}
                >
                  <table className="data-table text-xs">
                    <thead>
                      <tr>
                        <th>Branch</th>
                        <th className="text-right">Amount</th>
                        <th className="text-right">Rows</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topPad > 0 && (
                        <tr style={{ height: topPad }}>
                          <td colSpan={3} style={{ padding: 0, border: "none" }} />
                        </tr>
                      )}
                      {sl.map((r, i) => (
                        <tr key={st + i} style={{ height: ROW_H }}>
                          <td>{r.label}</td>
                          <td className="text-right font-mono">{formatCompactNumber(r.metric_value)}</td>
                          <td className="text-right">{r.row_cnt}</td>
                        </tr>
                      ))}
                      {botPad > 0 && (
                        <tr style={{ height: botPad }}>
                          <td colSpan={3} style={{ padding: 0, border: "none" }} />
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] mt-2 text-slate-500">
                  {br.length} rows — scroll to browse
                </p>
              </div>
            );
          })()}
          </div>
        </div>
      )}

      {drillOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: "rgba(15,23,42,0.55)" }}
          onClick={() => setDrillOpen(false)}
        >
          <div
            className="card w-full max-w-6xl max-h-[88vh] flex flex-col overflow-hidden shadow-2xl bg-white"
            style={{ borderRadius: 16 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <div>
                <p className="text-sm font-bold text-slate-800">Drill-through (source rows)</p>
                <p className="text-[11px] text-slate-500">
                  {drillRows.length} rows · virtualized table
                </p>
              </div>
              <button type="button" className="btn-ghost text-xs py-1.5 px-3" onClick={() => setDrillOpen(false)}>
                Close
              </button>
            </div>
            <div
              className="flex-1 overflow-auto table-scroll min-h-0"
              style={{ maxHeight: "72vh" }}
              onScroll={(e) => setVirtScroll(e.target.scrollTop)}
            >
              {drillRows[0] && (
                <table className="data-table text-xs" style={{ minWidth: 520 }}>
                  <thead className="sticky top-0 z-[1] bg-white">
                    <tr>
                      {Object.keys(drillRows[0]).map((k) => (
                        <th key={k}>{k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const cols = Object.keys(drillRows[0]);
                      const start = Math.max(0, Math.floor(virtScroll / ROW_H) - 4);
                      const SL = 32;
                      const slice = drillRows.slice(start, start + SL);
                      const topPad = start * ROW_H;
                      const botPad = Math.max(0, drillRows.length - start - slice.length) * ROW_H;
                      return (
                        <>
                          {topPad > 0 && (
                            <tr key="vtop">
                              <td colSpan={cols.length} style={{ height: topPad, padding: 0, border: "none" }} />
                            </tr>
                          )}
                          {slice.map((row, i) => (
                            <tr key={start + i} style={{ height: ROW_H }}>
                              {cols.map((k) => (
                                <td key={k}>{String(row[k] != null ? row[k] : "")}</td>
                              ))}
                            </tr>
                          ))}
                          {botPad > 0 && (
                            <tr key="vbot">
                              <td colSpan={cols.length} style={{ height: botPad, padding: 0, border: "none" }} />
                            </tr>
                          )}
                        </>
                      );
                    })()}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
