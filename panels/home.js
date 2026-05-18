/* Home breakdown block + sales period + home panel */
function HomeBreakdownBlock({ title, icon, chartRows, pyAiRows, groupKey, rowLimit, visible, onToggleVisible }) {
  if (!chartRows?.length) return null;
  const limit = homeBreakdownRowLimit(rowLimit, chartRows.length);
  const shown = chartRows.slice(0, limit);
  const yoyRows = pyAiRows?.length ? mergeBreakdownYoY(shown, pyAiRows, groupKey) : shown;
  const hasYoY = pyAiRows?.length > 0;
  const pieCap = homePieSliceCap(rowLimit, chartRows.length);
  const tableMaxH = limit >= chartRows.length ? 480 : limit >= 30 ? 380 : 280;
  return (
    <div className="rounded-xl border p-4 space-y-4" style={{ borderColor: "var(--border)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold m-0" style={{ color: "var(--text-strong)" }}>
          {icon} {title}
          <span className="text-[11px] font-normal ml-2" style={{ color: "var(--text-muted)" }}>
            ({chartRows.length} items{visible ? ` · showing ${shown.length}` : ""})
          </span>
        </p>
        <button type="button" className="btn-ghost text-xs py-1 px-2.5" onClick={onToggleVisible}>
          {visible ? "Hide section" : "Show section"}
        </button>
      </div>
      {!visible ? (
        <p className="text-xs m-0 py-1" style={{ color: "var(--text-muted)" }}>Section hidden — click Show section to expand.</p>
      ) : (
      <div className="space-y-4">
      <div className="chart-wrapper">
        <PieChart
          rows={shown}
          labelCol="label"
          valueCol="SaleNetAmount"
          title={`${title} — % contribution`}
          maxSlices={pieCap}
        />
      </div>
      <div className="chart-wrapper">
        <BarChart
          rows={yoyRows}
          labelCol="label"
          valueCols={hasYoY ? ["SaleNetAmount", "PY_SaleNetAmount"] : ["SaleNetAmount"]}
          title={hasYoY ? `${title} — current vs same period last year` : title}
          barOrientation="vertical"
        />
      </div>
      {chartRows.length > limit && (
        <p className="text-[11px] m-0" style={{ color: "var(--text-muted)" }}>
          Showing top {limit} of {chartRows.length} — choose &quot;All&quot; in the row limit control to list every row.
        </p>
      )}
      <div
        className="table-scroll rounded-xl border overflow-auto"
        style={{ maxHeight: tableMaxH, borderColor: "var(--border)" }}
      >
        <table className="data-table text-xs">
          <thead>
            <tr>
              <th>{icon} {title}</th>
              <th className="text-right">Sales</th>
              {hasYoY && <th className="text-right">LY sales</th>}
              <th className="text-right">% share</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const total = chartRows.reduce((s, x) => s + x.SaleNetAmount, 0);
              const pct = total > 0 ? ((r.SaleNetAmount / total) * 100).toFixed(1) : "0";
              const py = hasYoY ? yoyRows[i]?.PY_SaleNetAmount : null;
              return (
                <tr key={`${r.label}-${i}`}>
                  <td>{r.label}</td>
                  <td className="text-right font-mono">{fmtRupee(r.SaleNetAmount)}</td>
                  {hasYoY && (
                    <td className="text-right font-mono">{fmtRupee(py || 0)}</td>
                  )}
                  <td className="text-right">{pct}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </div>
      )}
    </div>
  );
}

function AnalyticsChartSkeleton({ tall }) {
  return (
    <div className={`card space-y-3 animate-pulse p-4`}>
      <div className="h-4 w-36 rounded" style={{ background: "rgba(148,163,184,0.3)" }} />
      <div className="rounded-lg" style={{ height: tall ? 260 : 220, background: "rgba(148,163,184,0.12)" }} />
    </div>
  );
}

function SalesPeriodPanel({ auth }) {
  const visiblePeriods = PERIODS;

  const [period,        setPeriod]      = useState('mtd');
  const [loading,       setLoading]     = useState(false);
  const [rows,          setRows]        = useState(null);     // flat dataset rows (kept for KPI stats)
  const [periodMeta,    setPeriodMeta]  = useState(null);     // server period window (source of truth)
  const [kpiTotal,      setKpiTotal]    = useState(0);
  const [kpiTxCount,    setKpiTxCount]  = useState(0);
  const [kpiQuantity,   setKpiQuantity] = useState(0);
  const [kpiBills,      setKpiBills]    = useState(0);
  const [kpiCustomers,  setKpiCustomers]= useState(0);
  const [trendAiRows,   setTrendAiRows]  = useState(null);   // AI trend rows (daily or monthly)
  const [pyTrendRows,   setPyTrendRows]  = useState(null);   // prior-year trend rows (YoY comparison)
  const [pyKpiTotal,    setPyKpiTotal]   = useState(null);   // prior-year total sales
  const [branchAiRows,  setBranchAiRows] = useState(null);   // AI branch rows (BranchAlias)
  const [deptAiRows,    setDeptAiRows]  = useState(null);    // AI dept rows
  const [catAiRows,     setCatAiRows]   = useState(null);    // AI cat rows
  const [pyBranchAiRows, setPyBranchAiRows] = useState(null);
  const [pyDeptAiRows,   setPyDeptAiRows]   = useState(null);
  const [pyCatAiRows,    setPyCatAiRows]    = useState(null);
  const [breakdownLimit, setBreakdownLimit] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem("erp_home_breakdown_limit") || "20", 10);
      return [0, 10, 20, 30].includes(v) ? v : 20;
    } catch { return 20; }
  });
  const [sectionVisible, setSectionVisible] = useState(() => {
    try {
      const raw = localStorage.getItem("erp_home_section_visible");
      if (raw) return { ...HOME_SECTION_DEFAULTS, ...JSON.parse(raw) };
    } catch (_) { /* ignore */ }
    return { ...HOME_SECTION_DEFAULTS };
  });
  const [error,         setError]       = useState('');
  const [config,      setConfig]      = useState(null);
  const [loadingWidgets, setLoadingWidgets] = useState(false);
  const [widgetsError,  setWidgetsError]   = useState('');
  const widgetsSeqRef = React.useRef(0);

  function applyFlatBreakdownFallback(flatRows) {
    const rev = flatRows?.length ? pickCanonicalRevenueKey(flatRows) : null;
    if (!flatRows?.length || !rev) return false;
    setBranchAiRows(syntheticWidgetRowsFromFlat(flatRows, 'branch', rev));
    setDeptAiRows(syntheticWidgetRowsFromFlat(flatRows, 'dept', rev));
    setCatAiRows(syntheticWidgetRowsFromFlat(flatRows, 'cat', rev));
    return true;
  }

  function setBreakdownLimitPersist(next) {
    setBreakdownLimit(next);
    try { localStorage.setItem("erp_home_breakdown_limit", String(next)); } catch (_) { /* ignore */ }
  }
  function toggleSection(key) {
    setSectionVisible((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem("erp_home_section_visible", JSON.stringify(next)); } catch (_) { /* ignore */ }
      return next;
    });
  }
  const apiTopN = breakdownLimit === 0 ? 500 : Math.max(100, breakdownLimit + 20);

  /* Detect which dataset is sales */
  useEffect(() => {
    apiFetch('/api/connector-config', { token: auth.token })
      .then(d => setConfig(d)).catch(() => {});
  }, [auth.token]);

  const salesDataset = useMemo(() => {
    if (!config?.datasets) return null;
    return config.datasets.find(d =>
      /sales|invoice|vwai/i.test(d.key) || /sales|invoice/i.test(d.objectName)
    ) || config.datasets[0];
  }, [config]);

  /* Best numeric column for flat-dataset aggregation */
  const valueCol = useMemo(() => pickCanonicalRevenueKey(rows), [rows]);

  /* Date column detection */
  const dateCol = useMemo(() => {
    if (!rows?.length) return null;
    const keys = Object.keys(rows[0]);
    return keys.find(k => /^xndt$/i.test(k))
      || keys.find(k => /invoicedt|xnmemo|cashmemo|date|dt|day|created/i.test(k))
      || null;
  }, [rows]);

  /* Prior-year window: calendar-safe (month lengths, leap years) vs naive string year +/-.
     Params must NOT be named `toDMY` — that would shadow the global `toDMY()` formatter. */
  function priorYearRange(startDMY, endDMY) {
    function parseDMY(dmy) {
      const p = String(dmy || '').split('.');
      if (p.length !== 3) return null;
      const dd = parseInt(p[0], 10);
      const mm = parseInt(p[1], 10);
      const yy = parseInt(p[2], 10);
      if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yy)) return null;
      const dt = new Date(yy, mm - 1, dd);
      return isNaN(dt.getTime()) ? null : dt;
    }
    const a = parseDMY(startDMY);
    const b = parseDMY(endDMY);
    if (a && b) {
      const pf = new Date(a);
      pf.setFullYear(pf.getFullYear() - 1);
      const pt = new Date(b);
      pt.setFullYear(pt.getFullYear() - 1);
      return { from: toDMY(pf), to: toDMY(pt) };
    }
    function shiftYear(dmy, delta) {
      const [d, m, y] = dmy.split('.');
      return `${d}.${m}.${parseInt(y, 10) + delta}`;
    }
    return { from: shiftYear(startDMY, -1), to: shiftYear(endDMY, -1) };
  }

  /* Home Sales panel should use deterministic analytics API, not AI-generated SQL. */
  async function loadAll(p) {
    if (!salesDataset) return;
    const loadSeq = ++widgetsSeqRef.current;
    const activePeriod = p || period;
    setLoading(true); setError('');
    setWidgetsError('');
    setLoadingWidgets(false);
    setKpiTotal(0); setKpiTxCount(0); setKpiQuantity(0); setKpiBills(0); setKpiCustomers(0);
    setPeriodMeta(null); setPyTrendRows(null); setPyKpiTotal(null);
    setRows(null); setTrendAiRows(null);
    setBranchAiRows(null); setDeptAiRows(null); setCatAiRows(null);
    setPyBranchAiRows(null); setPyDeptAiRows(null); setPyCatAiRows(null);
    const { from, to } = getPeriodRange(activePeriod);
    const trendGrain = salesPeriodTrendGranularity(activePeriod);

    /* Long periods (QTD / YTD / 6M) use the two-phase approach:
       phase 1 → critical (KPI + trend only, fast)
       phase 2 → widgets (branch / dept / category, background)
       This prevents a single massive query from timing out at 120 s and
       crashing the whole panel with "dashboard_unavailable". */
    /* Longer timeouts for widgets phase (heavy GROUP BY across full period vs critical KPI+trend only). */
    const dashboardTimeoutMs = ERP_ANALYTICS_TIMEOUT_MS;
    const widgetsTimeoutMs = Math.min(720000, dashboardTimeoutMs + 240000);

    async function postSalesDashboard(body, timeoutOverride) {
      const t = timeoutOverride != null ? timeoutOverride : dashboardTimeoutMs;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await apiFetch('/api/analytics/dashboard', {
            method: 'POST',
            token: auth.token,
            timeoutMs: t,
            body,
          });
          if (resp && resp.kpi) return resp;
        } catch (_) {
          /* retry once */
        }
        if (attempt === 0) await new Promise((r) => setTimeout(r, 900));
      }
      return null;
    }

    try {
      /* ── Phase 1: Critical (KPI + trend) ─────────────────────────── */
      const longPeriod = ["qtd", "ytd", "6m", "last_90d", "90d", "last_180d", "180d"].includes(activePeriod);
      const flatLimit = longPeriod ? "25000" : "5000";
      const params = new URLSearchParams({ limit: flatLimit, from, to });
      const flatPromise = apiFetch(
        `/api/dataset/${encodeURIComponent(salesDataset.key)}?${params}`,
        { token: auth.token }
      ).then(d => Array.isArray(d) ? d : []).catch(() => []);

      /* Prior-year comparison — uses period:'custom' + ISO dates so the backend
         doesn't silently fall back to MTD (which was the root cause of identical LY/CY). */
      const { from: pyFrom, to: pyTo } = priorYearRange(from, to);
      const pyBody =
        activePeriod !== 'today'
          ? {
              period: 'custom',
              custom: { from: dmyToISO(pyFrom), to: dmyToISO(pyTo) },
              dataset: 'sales',
              loadPhase: 'critical',
              compact: true,
              topN: apiTopN,
              forceTrendGranularity: trendGrain,
            }
          : null;
      const pyPromise =
        pyBody && dmyToISO(pyFrom) && dmyToISO(pyTo)
          ? postSalesDashboard(pyBody).catch(() => null)
          : Promise.resolve(null);

      /* Always send explicit ISO window (matches subtitle + aligns with server `6m` calendar rule). */
      const cyCustom =
        dmyToISO(from) && dmyToISO(to)
          ? { from: dmyToISO(from), to: dmyToISO(to) }
          : null;
      const criticalBody = cyCustom
        ? {
            period: 'custom',
            custom: cyCustom,
            dataset: 'sales',
            loadPhase: 'critical',
            compact: true,
            topN: apiTopN,
            forceTrendGranularity: trendGrain,
          }
        : {
            period: activePeriod,
            dataset: 'sales',
            loadPhase: 'critical',
            compact: true,
            topN: apiTopN,
            forceTrendGranularity: trendGrain,
          };
      const criticalPromise = postSalesDashboard(criticalBody);

      let [flatData, critical, pyDash] = await Promise.all([flatPromise, criticalPromise, pyPromise]);
      setRows(flatData);

      if (!critical || !critical.kpi) {
        /* Lighter retry: KPI + trend only (smaller payload, often succeeds after a full timeout). */
        critical = await postSalesDashboard({
          ...criticalBody,
          fields: "kpi,period,widgets.byTrend",
          compact: true,
        });
      }

      if (!critical || !critical.kpi) {
        const flatKpi = sumFlatKpis(flatData);
        setKpiTotal(flatKpi.total);
        setKpiTxCount(flatKpi.txCount);
        setKpiQuantity(flatKpi.quantity);
        setKpiBills(flatKpi.bills);
        setKpiCustomers(flatKpi.customers);
        if (Array.isArray(flatData) && flatData.length > 0) {
          const flatKeys = Object.keys(flatData[0]);
          const vc =
            ["SaleNetAmount", "NetAmount", "Amount", "SalesAmount", "Revenue", "Total", "Value"].find((p) =>
              flatKeys.some((k) => k.toLowerCase() === p.toLowerCase())
            ) || flatKeys.find((k) => /amount|net|sale|revenue|total|value/i.test(k));
          const dc = flatKeys.find((k) => /^xndt$/i.test(k))
            || flatKeys.find((k) => /invoicedt|xnmemo|date|dt|day|created/i.test(k));
          if (vc && dc) {
            setTrendAiRows(buildFlatTrendRows(flatData, activePeriod, dc, vc));
          }
        }
        setError("analytics_slow_using_flat_data");
        setLoading(false);
        /* KPI + trend from sample are shown; skip widgets phase (likely same timeout). */
        return;
      }

      const k = critical.kpi || {};
      const pMeta = critical.period || null;
      setPeriodMeta(pMeta);
      setKpiTotal(parseFloat(k.totalSales) || 0);
      setKpiTxCount(parseInt(String(k.txnCount), 10) || 0);
      setKpiQuantity(parseFloat(k.quantitySold) || 0);
      setKpiBills(parseInt(String(k.billCount ?? k.txnCount), 10) || 0);
      setKpiCustomers(parseInt(String(k.customerCount), 10) || 0);

      /* Trend from critical payload */
      const wCrit = critical.widgets || {};
      setTrendAiRows(wCrit.byTrend && Array.isArray(wCrit.byTrend.rows) ? wCrit.byTrend.rows : []);

      /* Prior year */
      let localPyTrendRows = [];
      if (pyDash && pyDash.kpi) {
        setPyKpiTotal(parseFloat(pyDash.kpi.totalSales) || 0);
        const pw = pyDash.widgets || {};
        localPyTrendRows = pw.byTrend && Array.isArray(pw.byTrend.rows) ? pw.byTrend.rows : [];
        setPyTrendRows(localPyTrendRows);
      }

      /* Widgets are now visible with placeholder, can clear loading spinner early */
      setLoading(false);

      /* ── Phase 2: Widgets (branch / dept / cat) — retry; fallback to flat sample if all fail ─ */
      setLoadingWidgets(true);
      try {
        const widgetsBody = cyCustom
          ? {
              period: 'custom',
              custom: cyCustom,
              dataset: 'sales',
              loadPhase: 'widgets',
              compact: true,
              topN: apiTopN,
              forceTrendGranularity: trendGrain,
            }
          : {
              period: activePeriod,
              dataset: 'sales',
              loadPhase: 'widgets',
              compact: true,
              topN: apiTopN,
              forceTrendGranularity: trendGrain,
            };
        const pyWidgetsBody =
          pyBody && dmyToISO(pyFrom) && dmyToISO(pyTo)
            ? { ...pyBody, loadPhase: 'widgets' }
            : null;

        let widgets = null;
        let pyWidgets = null;
        let lastErr = null;
        for (let wa = 0; wa < 3; wa++) {
          try {
            const pair = await Promise.all([
              apiFetch('/api/analytics/dashboard', {
                method: 'POST',
                token: auth.token,
                timeoutMs: widgetsTimeoutMs,
                body: widgetsBody,
              }),
              pyWidgetsBody
                ? postSalesDashboard({ ...pyWidgetsBody, compact: true }, widgetsTimeoutMs).catch(() => null)
                : Promise.resolve(null),
            ]);
            widgets = pair[0];
            pyWidgets = pair[1];
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 900 * (wa + 1)));
          }
        }

        if (widgetsSeqRef.current !== loadSeq) return;

        if (lastErr || !widgets) {
          throw lastErr || new Error('widgets_unavailable');
        }

        const hasRows = (wb) =>
          wb && Array.isArray(wb.rows) && wb.rows.length > 0;
        if (widgets.widgets) {
          const w = widgets.widgets;
          const b = w.byBranch;
          const d = w.byDepartment;
          const c = w.byCategory;
          const gotAny =
            hasRows(b) || hasRows(d) || hasRows(c);
          if (gotAny) {
            setBranchAiRows(b && Array.isArray(b.rows) ? b.rows : []);
            setDeptAiRows(d && Array.isArray(d.rows) ? d.rows : []);
            setCatAiRows(c && Array.isArray(c.rows) ? c.rows : []);
          } else {
            setBranchAiRows([]);
            setDeptAiRows([]);
            setCatAiRows([]);
          }
        }
        if (pyWidgets && pyWidgets.widgets && widgets.widgets) {
          const pw = pyWidgets.widgets;
          setPyBranchAiRows(pw.byBranch && Array.isArray(pw.byBranch.rows) ? pw.byBranch.rows : []);
          setPyDeptAiRows(pw.byDepartment && Array.isArray(pw.byDepartment.rows) ? pw.byDepartment.rows : []);
          setPyCatAiRows(pw.byCategory && Array.isArray(pw.byCategory.rows) ? pw.byCategory.rows : []);
        }

        /* Phase 1.5 — PY trend retry: if critical phase didn't return trend rows (sometimes
           the trend query returns empty on first cold hit), fetch them now in background.
           Uses cached result so it's fast on second call. */
        if (!localPyTrendRows.length && pyBody && dmyToISO(pyFrom) && dmyToISO(pyTo)) {
          postSalesDashboard({ ...pyBody, fields: 'kpi,widgets.byTrend' }, dashboardTimeoutMs)
            .then(pyTrendResp => {
              if (widgetsSeqRef.current !== loadSeq) return; // stale
              const rows = pyTrendResp?.widgets?.byTrend?.rows;
              if (Array.isArray(rows) && rows.length) {
                setPyTrendRows(rows);
              }
            })
            .catch(() => {}); // non-fatal
        }

        const bLen = widgets?.widgets?.byBranch?.rows?.length || 0;
        const dLen = widgets?.widgets?.byDepartment?.rows?.length || 0;
        const cLen = widgets?.widgets?.byCategory?.rows?.length || 0;
        if (bLen + dLen + cLen === 0 && Array.isArray(flatData) && flatData.length > 0) {
          applyFlatBreakdownFallback(flatData);
          setWidgetsError(
            "Full-period branch / department / category breakdown timed out or returned empty. " +
              "Showing estimates from sampled rows below — retry or widen timeout (localStorage erp_analytics_timeout_ms)."
          );
        }
      } catch (widgetErr) {
        if (widgetsSeqRef.current !== loadSeq) return;
        console.warn('[SalesPeriodPanel] widgets phase timed out or failed:', widgetErr.message);
        if (Array.isArray(flatData) && flatData.length > 0) {
          applyFlatBreakdownFallback(flatData);
        }
        setWidgetsError(
          'Branch / department / category charts did not finish loading (' +
            (widgetErr.message || 'timeout') +
            '). ' +
            (flatData?.length ? 'Estimated breakdown from sampled rows is shown.' : '')
        );
      } finally {
        if (widgetsSeqRef.current === loadSeq) setLoadingWidgets(false);
      }

    } catch(e) { setError(e.message); setLoading(false); setLoadingWidgets(false); }
  }

  useEffect(() => { if (salesDataset) loadAll(period); }, [salesDataset]);

  function handlePeriod(p) { setPeriod(p); loadAll(p); }

  /* Total from flat rows */
  const total = kpiTotal;

  const periodLabel = PERIODS.find(p => p.key === period)?.label || String(period || '').toUpperCase();
  const fallbackRange = getPeriodRange(period);
  const from = (periodMeta && periodMeta.from) || fallbackRange.from;
  const to = (periodMeta && periodMeta.to) || fallbackRange.to;
  const txCount = kpiTxCount ? kpiTxCount.toLocaleString() + ' transactions' : '';
  const displayValueCol = 'SaleNetAmount';

  /* Pill style helper */
  const pill = (active) => ({
    padding: '5px 14px', borderRadius: 20, border: 'none', cursor: 'pointer',
    fontSize: 12, fontWeight: 700, transition: 'all 0.15s',
    background: active ? 'var(--brand,#2563eb)' : 'var(--bg-muted,#f1f5f9)',
    color: active ? '#fff' : 'var(--text-muted,#64748b)',
    boxShadow: active ? '0 2px 8px rgba(99,102,241,.3)' : 'none',
  });

  /* Build chart rows for branch from analytics dashboard rows (full list; UI may preview top N). */
  const branchChartRows = useMemo(() => {
    if (branchAiRows?.length) return mapAnalyticsBreakdownRows(branchAiRows, 'branch');
    if (!rows?.length || !valueCol) return [];
    const branchOpt = GROUP_OPTIONS.find(o => o.key === 'branch');
    const col = resolveGroupCol(rows, branchOpt);
    if (!col) return [];
    return aggregateBy(rows, col, valueCol).map(r => ({ label: r.label, SaleNetAmount: r.value }));
  }, [branchAiRows, rows, valueCol]);

  /* Helper: extract metric_value from an analytics byTrend rows array */
  function extractTrendSeries(aiRows) {
    if (!aiRows?.length) return [];
    const keys = Object.keys(aiRows[0]);
    const labelCol = keys.find(k => /period_label|date|month|day/i.test(k)) || keys[0];
    const salesCol = keys.find(k => /^(mrpvalue|metric_value|totalsales|salenetamount|netslsnetamount|netamount)$/i.test(k))
                  || keys.find(k => /metric_value|mrpvalue|totalsales|saleamount|salenetamount|netsales/i.test(k))
                  || keys.find(k => /sales|amount|net|revenue/i.test(k) && !/count/i.test(k))
                  || keys[1];
    if (!labelCol || !salesCol) return [];
    return aiRows.filter(r => r[labelCol] != null).map(r => ({
      label: String(r[labelCol]),
      value: parseFloat(r[salesCol]) || 0,
    }));
  }

  /* Trend chart rows from analytics dashboard byTrend rows.
     Includes prior-year series for YoY comparison. */
  const trendChartRows = useMemo(() => {
    let currentRows = [];
    if (trendAiRows?.length) {
      const keys = Object.keys(trendAiRows[0]);
      const labelCol = keys.find(k => /period_label|date|month|day|saledate|salemonth/i.test(k)) || keys[0];
      const salesCol = keys.find(k => /^(mrpvalue|metric_value|totalsales|salenetamount|netslsnetamount|netamount)$/i.test(k))
                    || keys.find(k => /metric_value|mrpvalue|totalsales|saleamount|salenetamount|netsales/i.test(k))
                    || keys.find(k => /sales|amount|net|revenue/i.test(k) && !/count/i.test(k))
                    || keys[1];
      const invoiceCountCol = keys.find(k => /invoicecount|invoice.*count|txn_count|billcount/i.test(k));
      if (labelCol && salesCol) {
        currentRows = trendAiRows.filter(r => r[labelCol] != null).map(r => {
          const row = { label: String(r[labelCol]), TotalSales: parseFloat(r[salesCol]) || 0 };
          if (invoiceCountCol) row.InvoiceCount = parseFloat(r[invoiceCountCol]) || 0;
          return row;
        });
      }
    } else if (rows?.length && valueCol && dateCol) {
      const grain = salesPeriodTrendGranularity(period);
      const base =
        grain === "day"
          ? aggregateByDate(rows, dateCol, valueCol)
          : aggregateByMonth(rows, dateCol, valueCol);
      currentRows = base.map((r) => ({ label: r.label, TotalSales: parseFloat(r.value) || 0 }));
    }

    currentRows = aggregateTrendChartRows(currentRows);

    /* Gap-fill only for flat TOP-N sample fallback — analytics byTrend already has real buckets.
       Running gap-fill on XnDtMonth labels ("April 2026") used to wipe values to zero. */
    if (period !== "today" && currentRows.length && !trendAiRows?.length) {
      const grain = salesPeriodTrendGranularity(period);
      const { from: rangeFrom, to: rangeTo } = getPeriodRange(period);
      const filled = fillTrendSeriesGaps(
        currentRows.map((r) => ({ period_label: r.label, metric_value: r.TotalSales })),
        rangeFrom,
        rangeTo,
        grain
      );
      currentRows = filled.map((r) => ({
        label: r.period_label,
        TotalSales: r.metric_value,
        ...(r.InvoiceCount != null ? { InvoiceCount: r.InvoiceCount } : {}),
      }));
    }

    /* Merge prior-year sales as "PY_TotalSales" — match by calendar period key, not row index */
    if (pyTrendRows?.length && currentRows.length) {
      const pySeries = extractTrendSeries(pyTrendRows);
      const pyByKey = new Map();
      for (const p of pySeries) {
        const k = canonicalTrendLabelKey(p.label);
        if (!k) continue;
        pyByKey.set(k, (pyByKey.get(k) || 0) + p.value);
      }
      return currentRows.map((r) => {
        const ck = canonicalTrendLabelKey(r.label);
        const pyK = priorYearTrendKey(ck);
        let pyVal = null;
        if (pyK != null && pyByKey.has(pyK)) pyVal = pyByKey.get(pyK);
        return { ...r, PY_TotalSales: pyVal != null ? pyVal : null };
      }).map((r) => ({
        ...r,
        label: formatTrendChartBucketLabel(canonicalTrendLabelKey(r.label), r.PY_TotalSales != null),
      }));
    }
    return currentRows;
  }, [trendAiRows, pyTrendRows, rows, valueCol, dateCol, period]);

  const trendMonthExplain =
    period !== "today" ? monthTrendDisclaimer(period, trendChartRows.length, from, to) : "";

  const deptChartRows = useMemo(() => mapAnalyticsBreakdownRows(deptAiRows, 'dept'), [deptAiRows]);
  const catChartRows = useMemo(() => mapAnalyticsBreakdownRows(catAiRows, 'cat'), [catAiRows]);

  const hasAnyData = branchChartRows.length > 0 || deptChartRows.length > 0 || catChartRows.length > 0 || trendChartRows.length > 0;

  return (
    <div className="card p-5 space-y-4 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-bold text-base" style={{color:'var(--text-strong)'}}>📈 Home — Key Metrics</h3>
          <p className="text-xs mt-0.5" style={{color:'var(--text-muted)'}}>
            {from} → {to}{txCount ? ` · ${txCount}` : ''}
          </p>
        </div>
        <div style={{textAlign:'right'}}>
          <div className="font-extrabold text-xl" style={{color:'var(--brand)'}}>
            {fmtRupee(total)}
          </div>
          <div className="text-xs" style={{color:'var(--text-muted)'}}>{periodLabel} — ₹ Net Sales</div>
          {pyKpiTotal !== null && pyKpiTotal > 0 && (
            <div className="text-xs mt-0.5" style={{color: total >= pyKpiTotal ? '#10b981' : '#ef4444', fontWeight:600}}>
              {(() => {
                const delta = total - pyKpiTotal;
                const pct = pyKpiTotal > 0 ? ((delta / pyKpiTotal) * 100).toFixed(1) : '0';
                const up = delta >= 0;
                return (
                  <>
                    {up ? '▲' : '▼'} {fmtRupee(Math.abs(delta))} ({pct}%) vs LY
                    <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}> · LY total {fmtRupee(pyKpiTotal)}</span>
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Period tabs */}
      <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
        {visiblePeriods.map(({ key, label }) => (
          <button key={key} style={pill(period === key)} onClick={() => handlePeriod(key)}>
            {label}
          </button>
        ))}
      </div>

      {error && error === 'analytics_slow_using_flat_data' ? (
        /* Soft warning — analytics API timed out but flat data loaded; charts still work */
        <div style={{
          display:'flex', alignItems:'center', gap:8, padding:'8px 14px',
          background:'var(--bg-warning,#fffbeb)', border:'1px solid #f59e0b',
          borderRadius:8, fontSize:12, color:'#92400e', marginBottom:8,
        }}>
          <span>⚠️</span>
          <span style={{flex:1}}>
            <strong>Analytics engine is slow</strong> — showing totals from sample data ({(rows||[]).length.toLocaleString()} rows).
            Trend &amp; breakdown charts may be incomplete.
            {' '}<button onClick={() => { setError(''); loadAll(period); }} style={{
              background:'none', border:'none', color:'#92400e', textDecoration:'underline',
              cursor:'pointer', fontSize:12, padding:0, fontWeight:600,
            }}>Retry</button>
          </span>
          <button onClick={() => setError('')} style={{background:'none',border:'none',cursor:'pointer',color:'#92400e',fontSize:14}}>✕</button>
        </div>
      ) : error ? (
        <Alert type="error" msg={error} onClose={() => setError('')} />
      ) : null}

      {loading && (
        <div className="flex items-center gap-2 py-4" style={{color:'var(--text-muted)'}}>
          <Spinner size={16}/>
          <span className="text-sm">Loading {periodLabel} analytics (branch + dept ✨ + category ✨)…</span>
        </div>
      )}

      {/* Four summary KPI boxes */}
      {!loading && (kpiTotal > 0 || kpiBills > 0 || kpiQuantity > 0) && (
        <div style={{
          display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px,1fr))', gap:12, marginTop:4
        }}>
          {[
            { icon:'💰', val: fmtRupee(kpiTotal), lbl: `${periodLabel} Sales`, color:'#6366f1' },
            { icon:'📦', val: kpiQuantity.toLocaleString('en-IN', { maximumFractionDigits: 0 }), lbl: 'Quantity Sold', color:'#0ea5e9' },
            { icon:'🧾', val: kpiBills.toLocaleString('en-IN'), lbl: 'Bills Generated', color:'#10b981' },
            { icon:'👥', val: kpiCustomers.toLocaleString('en-IN'), lbl: 'Customer Count', color:'#8b5cf6' },
          ].map((t,i) => (
            <div key={i} style={{
              background:'var(--surface2)', borderRadius:12, padding:'12px 14px',
              border:'1px solid var(--border)', textAlign:'center',
            }}>
              <div style={{fontSize:20}}>{t.icon}</div>
              <div style={{fontSize:18, fontWeight:800, color:t.color, marginTop:4}}>{t.val}</div>
              <div style={{fontSize:11, color:'var(--text-muted)', marginTop:2}}>{t.lbl}</div>
            </div>
          ))}
        </div>
      )}

      {!loading && hasAnyData && (
        <div className="space-y-5">
          <div className="rounded-xl border p-3 flex flex-wrap items-center gap-3" style={{ borderColor: "var(--border)", background: "var(--surface2)" }}>
            <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Rows per breakdown:</span>
            {HOME_BREAKDOWN_LIMIT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className="text-xs font-semibold px-3 py-1.5 rounded-lg border"
                style={{
                  borderColor: breakdownLimit === opt.value ? "var(--brand,#6366f1)" : "var(--border)",
                  background: breakdownLimit === opt.value ? "var(--brand,#6366f1)" : "transparent",
                  color: breakdownLimit === opt.value ? "#fff" : "var(--text)",
                }}
                onClick={() => {
                  setBreakdownLimitPersist(opt.value);
                  if (salesDataset) loadAll(period);
                }}
              >
                {opt.label}
              </button>
            ))}
            <span className="text-xs" style={{ color: "var(--border)" }}>|</span>
            <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Show sections:</span>
            {[
              { key: "trend", label: "Trend" },
              { key: "branch", label: "Branch" },
              { key: "dept", label: "Department" },
              { key: "cat", label: "Category" },
            ].map(({ key, label }) => (
              <label key={key} className="text-xs flex items-center gap-1.5 cursor-pointer" style={{ color: "var(--text)" }}>
                <input
                  type="checkbox"
                  checked={!!sectionVisible[key]}
                  onChange={() => toggleSection(key)}
                />
                {label}
              </label>
            ))}
          </div>
          {(widgetsError || loadingWidgets) && (
            <div className="space-y-2">
              {widgetsError && (
                <div
                  className="rounded-xl border px-3 py-2 flex flex-wrap items-center gap-2"
                  style={{ borderColor: '#fbbf24', background: '#fffbeb' }}
                >
                  <span className="text-xs" style={{ color: '#92400e' }}>
                    <strong>Breakdowns:</strong> {widgetsError}
                  </span>
                  <button
                    type="button"
                    className="text-xs font-semibold px-3 py-1 rounded-lg"
                    style={{ border: '1px solid #d97706', background: '#fef3c7', color: '#92400e', cursor: 'pointer' }}
                    onClick={() => loadAll(period)}
                  >
                    Retry
                  </button>
                </div>
              )}
              {loadingWidgets && (
                <div className="grid gap-3 md:grid-cols-1">
                  <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <Spinner size={14} /> Loading branch · department · category breakdown…
                  </div>
                  {branchChartRows.length === 0 && <AnalyticsChartSkeleton />}
                  {deptChartRows.length === 0 && <AnalyticsChartSkeleton />}
                  {catChartRows.length === 0 && <AnalyticsChartSkeleton />}
                </div>
              )}
            </div>
          )}

          {/* Trend chart — all periods including Today */}
          {trendChartRows.length > 0 && sectionVisible.trend && (
            <div className="chart-wrapper rounded-xl border p-4" style={{ borderColor: "var(--border)" }}>
              <div className="flex justify-end mb-2">
                <button type="button" className="btn-ghost text-xs py-1 px-2.5" onClick={() => toggleSection("trend")}>
                  Hide trend chart
                </button>
              </div>
              <ChartWithToggle
                rows={trendChartRows}
                labelCol="label"
                valueCols={[
                  'TotalSales',
                  ...(trendChartRows[0]?.PY_TotalSales != null ? ['PY_TotalSales'] : []),
                ]}
                valueAxisMaxRaw={trendMoneyAxisMax(trendChartRows, ['TotalSales', 'PY_TotalSales'])}
                title={homeTrendChartTitle(period, trendChartRows.some(r => r.PY_TotalSales != null))}
                icon=""
                defaultChartType="line"
              />
              {trendMonthExplain ? (
                <p className="text-[11px] mt-2 px-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  {trendMonthExplain}
                </p>
              ) : null}
            </div>
          )}

          {trendChartRows.length > 0 && !sectionVisible.trend && (
            <button type="button" className="btn-ghost text-xs py-1.5 px-3 w-full" onClick={() => toggleSection("trend")}>
              Show trend chart (hidden)
            </button>
          )}

          {sectionVisible.branch && (
          <HomeBreakdownBlock
            title="Sales by Branch"
            icon="🏬"
            chartRows={branchChartRows}
            pyAiRows={pyBranchAiRows}
            groupKey="branch"
            rowLimit={breakdownLimit}
            visible={sectionVisible.branch}
            onToggleVisible={() => toggleSection("branch")}
          />
          )}
          {sectionVisible.dept && (
          <HomeBreakdownBlock
            title="Sales by Department"
            icon="🏢"
            chartRows={deptChartRows}
            pyAiRows={pyDeptAiRows}
            groupKey="dept"
            rowLimit={breakdownLimit}
            visible={sectionVisible.dept}
            onToggleVisible={() => toggleSection("dept")}
          />
          )}
          {sectionVisible.cat && (
          <HomeBreakdownBlock
            title="Sales by Category"
            icon="🏷️"
            chartRows={catChartRows}
            pyAiRows={pyCatAiRows}
            groupKey="cat"
            rowLimit={breakdownLimit}
            visible={sectionVisible.cat}
            onToggleVisible={() => toggleSection("cat")}
          />
          )}
          {!sectionVisible.branch && branchChartRows.length > 0 && (
            <button type="button" className="btn-ghost text-xs py-1.5 px-3" onClick={() => toggleSection("branch")}>Show Sales by Branch (hidden)</button>
          )}
          {!sectionVisible.dept && deptChartRows.length > 0 && (
            <button type="button" className="btn-ghost text-xs py-1.5 px-3" onClick={() => toggleSection("dept")}>Show Sales by Department (hidden)</button>
          )}
          {!sectionVisible.cat && catChartRows.length > 0 && (
            <button type="button" className="btn-ghost text-xs py-1.5 px-3" onClick={() => toggleSection("cat")}>Show Sales by Category (hidden)</button>
          )}
        </div>
      )}

      {!loading && !hasAnyData && (
        <p className="text-sm py-4 text-center" style={{color:'var(--text-muted)'}}>
          No sales data found for {periodLabel} ({from} → {to})
        </p>
      )}
    </div>
  );
}

function HomePanel({ auth, onNavigate }) {
  const [connectorConfig, setConnectorConfig] = useState(null);
  const [todayKpi,  setTodayKpi]  = useState(null);
  const [mtdKpi,    setMtdKpi]    = useState(null);
  const [todayStatus, setTodayStatus] = useState('loading');
  const [mtdStatus,   setMtdStatus]   = useState('loading');
  const history = useMemo(() => { try { return JSON.parse(localStorage.getItem("erp_ai_history") || "[]"); } catch { return []; } }, []);
  const { mobile } = useBreakpoint();

  useEffect(() => {
    apiFetch("/api/connector-config", { token: auth.token })
      .then(d => setConnectorConfig(d))
      .catch(() => {});
  }, [auth.token]);

  const features = auth.features || [];
  const featuresKey = features.slice().sort().join(",");

  /* Fetch Today + MTD in PARALLEL — today is a 1-day query (fast), MTD is heavier.
     Both fire simultaneously so Today appears almost instantly, MTD fills in seconds. */
  useEffect(() => {
    if (!features.includes("data")) return;
    let cancelled = false;

    async function fetchKpi(period, setKpi, setStatus) {
      setStatus("loading");
      // Try fast lightweight endpoint first (30s timeout — today should be <2s)
      try {
        const d = await apiFetch(`/api/home/kpi?period=${period}`, {
          token: auth.token,
          timeoutMs: period === "today" ? 30000 : 60000,
        });
        if (!cancelled && d && d.ok) {
          setKpi({
            totalSales:    parseFloat(d.totalSales)    || 0,
            txnCount:      parseInt(d.txnCount,  10)   || 0,
            billCount:     parseInt(d.billCount  ?? d.txnCount, 10) || 0,
            customerCount: parseInt(d.customerCount,10)|| 0,
            quantitySold:  parseFloat(d.quantitySold)  || 0,
          });
          setStatus("ok");
          return;
        }
      } catch (_) {}
      // Fallback — analytics/dashboard critical phase
      try {
        const dash = await apiFetch("/api/analytics/dashboard", {
          method: "POST", token: auth.token,
          timeoutMs: ERP_ANALYTICS_TIMEOUT_MS,
          body: { period, dataset: "sales", compact: true, loadPhase: "critical" },
        });
        if (!cancelled && dash?.kpi) {
          setKpi({
            totalSales:    parseFloat(dash.kpi.totalSales)    || 0,
            txnCount:      parseInt(dash.kpi.txnCount,  10)   || 0,
            billCount:     parseInt(dash.kpi.billCount ?? dash.kpi.txnCount, 10) || 0,
            customerCount: parseInt(dash.kpi.customerCount,10)|| 0,
            quantitySold:  parseFloat(dash.kpi.quantitySold)  || 0,
          });
          setStatus("ok");
          return;
        }
      } catch (_) {}
      if (!cancelled) { setKpi(null); setStatus("error"); }
    }

    // Fire both simultaneously — don't await each other
    fetchKpi("today", setTodayKpi, setTodayStatus);
    fetchKpi("mtd",   setMtdKpi,   setMtdStatus);

    return () => { cancelled = true; };
  }, [auth.token, featuresKey]);

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const dateStr = now.toLocaleDateString("en-IN", { weekday:"long", month:"long", day:"numeric", year:"numeric" });
  const timeStr = now.toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit" });

  const hasData = features.includes('data');

  const quickActions = [
    features.includes("ai")       && { icon:"✨", label:"AI Query",    desc:"Plain-English SQL — ask anything, get charts instantly", key:"ai",        color:"#6366f1", bg:"rgba(99,102,241,0.09)",  border:"rgba(99,102,241,0.20)"  },
    features.includes("data")     && { icon:"📊", label:"Analytics",   desc:"Period sales, branch, category & trend charts",           key:"analytics",  color:"#10b981", bg:"rgba(16,185,129,0.09)",  border:"rgba(16,185,129,0.20)"  },
    features.includes("explorer") && { icon:"🔍", label:"DB Explorer", desc:"Browse tables, preview data, explore schema",             key:"explorer",   color:"#f59e0b", bg:"rgba(245,158,11,0.09)",  border:"rgba(245,158,11,0.20)"  },
    features.includes("admin")    && { icon:"🔑", label:"User Admin",  desc:"Accounts, roles and access permissions",                  key:"admin",      color:"#ef4444", bg:"rgba(239,68,68,0.09)",   border:"rgba(239,68,68,0.20)"   },
  ].filter(Boolean);

  // Skeleton inline component (white ghost on dark tile)
  const Skel = ({ w = 80, h = 24 }) => (
    <span className="skel-line" style={{ width: w, height: h, display:"inline-block", borderRadius: 6 }} />
  );

  // Reusable KPI tile
  function KpiTile({ icon, label, value, sub, variant, loading }) {
    return (
      <div className={`kpi-tile kpi-tile-${variant}`}>
        <div className="tile-blob1" /><div className="tile-blob2" />
        <div style={{position:"relative", zIndex:1}}>
          <span className="kpi-tile-icon">{icon}</span>
          <div className="kpi-tile-val">
            {loading ? <Skel w={90} h={26} /> : (value ?? "—")}
          </div>
          <div className="kpi-tile-lbl">{label}</div>
          {sub && <div className="kpi-tile-sub">{sub}</div>}
        </div>
      </div>
    );
  }

  const todayLoading = todayStatus === 'loading';
  const mtdLoading   = mtdStatus   === 'loading';

  function kv(status, data, field, fmt="currency") {
    if (status === 'loading') return null;
    if (status === 'error' || !data) return '—';
    const v = data[field] || 0;
    if (fmt === 'currency') return fmtRupee(v);
    if (fmt === 'currencyAuto') return fmtRupeeAuto(v);
    return v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }

  const todayABV = (todayKpi?.billCount > 0) ? todayKpi.totalSales / todayKpi.billCount : 0;
  const mtdABV   = (mtdKpi?.billCount   > 0) ? mtdKpi.totalSales   / mtdKpi.billCount   : 0;

  return (
    <div className="space-y-5 fade-in">

      {/* ══ WELCOME BANNER ══════════════════════════════════ */}
      <div className="welcome-banner-v2">
        <div className="wb-blob1" /><div className="wb-blob2" />
        <div style={{position:"relative", zIndex:1, display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:12, flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:11.5, fontWeight:600, color:"var(--text-muted)", marginBottom:5, letterSpacing:"0.03em"}}>
              {greeting} · {dateStr}
            </div>
            <h1 style={{fontSize: mobile ? 22 : 30, fontWeight:800, color:"var(--text-strong)", lineHeight:1.1, letterSpacing:"-0.6px", margin:0}}>
              {auth.name || auth.email?.split("@")[0]}
            </h1>
            <div style={{display:"flex", alignItems:"center", gap:8, marginTop:10, flexWrap:"wrap"}}>
              <span className={`role-badge role-${auth.role}`}>
                {auth.role === "admin" ? "👑" : auth.role === "manager" ? "📋" : "👁"}&nbsp;{auth.role?.toUpperCase()}
              </span>
              <span style={{fontSize:12, color:"var(--text-muted)"}}>{auth.email}</span>
            </div>
          </div>
          {/* Live clock */}
          <div style={{textAlign:"right", flexShrink:0, paddingTop:4}}>
            <div style={{fontSize:10, color:"var(--text-muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em"}}>Last refreshed</div>
            <div style={{fontSize:20, fontWeight:800, color:"var(--text-strong)", lineHeight:1.1, marginTop:3, letterSpacing:"-0.3px"}}>{timeStr}</div>
            {todayStatus === 'ok' && (
              <div style={{display:"flex", alignItems:"center", justifyContent:"flex-end", gap:5, marginTop:4}}>
                <span className="live-dot" /><span style={{fontSize:10, color:"var(--accent-good)", fontWeight:700}}>LIVE</span>
              </div>
            )}
          </div>
        </div>

        {/* Inline summary row inside banner — quick glance when scrolled */}
        {hasData && !mobile && (
          <div style={{display:"flex", gap:32, marginTop:20, paddingTop:16, borderTop:"1px solid var(--border-soft)", flexWrap:"wrap"}}>
            {[
              { icon:"💰", lbl:"Today", val: kv(todayStatus, todayKpi, 'totalSales'), loading: todayLoading },
              { icon:"🧾", lbl:"Bills Today", val: kv(todayStatus, todayKpi, 'billCount','number'), loading: todayLoading },
              { icon:"📅", lbl:"MTD Sales", val: kv(mtdStatus, mtdKpi, 'totalSales'), loading: mtdLoading },
              { icon:"📦", lbl:"MTD Qty", val: kv(mtdStatus, mtdKpi, 'quantitySold','number'), loading: mtdLoading },
            ].map((s,i) => (
              <div key={i}>
                <div style={{fontSize:18, fontWeight:800, color:"var(--text-strong)", lineHeight:1}}>
                  {s.loading ? <Skel w={60} h={18} /> : <>{s.icon} {s.val}</>}
                </div>
                <div style={{fontSize:10.5, color:"var(--text-muted)", marginTop:3}}>{s.lbl}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ══ TODAY AT A GLANCE ═══════════════════════════════ */}
      {hasData && (
        <div>
          <div style={{display:"flex", alignItems:"baseline", justifyContent:"space-between", marginBottom:14}}>
            <div className="home-section-label" style={{flex:1}}>
              Today at a Glance
              <span style={{fontSize:10, fontWeight:500, textTransform:"none", letterSpacing:0, marginLeft:6, color:"var(--text-soft)"}}>
                {now.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
              </span>
            </div>
          </div>
          <div className="kpi-row-4">
            <KpiTile icon="💰" label="Today's Sales"   variant="blue"   loading={todayLoading} value={kv(todayStatus,todayKpi,'totalSales')} />
            <KpiTile icon="🧾" label="Bills Today"      variant="indigo" loading={todayLoading} value={kv(todayStatus,todayKpi,'billCount','number')} />
            <KpiTile icon="📦" label="Qty Sold"         variant="teal"   loading={todayLoading} value={kv(todayStatus,todayKpi,'quantitySold','number')} />
            <KpiTile icon="📈" label="Avg Bill Value"   variant="cyan"   loading={todayLoading} value={todayLoading ? null : (todayStatus==='error'||!todayKpi ? '—' : fmtRupeeAuto(todayABV))} />
          </div>
        </div>
      )}

      {/* ══ MONTH TO DATE ════════════════════════════════════ */}
      {hasData && (
        <div>
          <div style={{display:"flex", alignItems:"baseline", justifyContent:"space-between", marginBottom:14}}>
            <div className="home-section-label" style={{flex:1}}>
              Month to Date
              <span style={{fontSize:10, fontWeight:500, textTransform:"none", letterSpacing:0, marginLeft:6, color:"var(--text-soft)"}}>
                1 {now.toLocaleDateString('en-IN',{month:'short'})} – {now.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}
              </span>
            </div>
          </div>
          <div className="kpi-row-4">
            <KpiTile icon="💰" label="MTD Gross Sales"  variant="purple" loading={mtdLoading} value={kv(mtdStatus,mtdKpi,'totalSales')} />
            <KpiTile icon="🧾" label="Bills (MTD)"       variant="violet" loading={mtdLoading} value={kv(mtdStatus,mtdKpi,'billCount','number')} />
            <KpiTile icon="📦" label="Qty Sold (MTD)"    variant="purple" loading={mtdLoading} value={kv(mtdStatus,mtdKpi,'quantitySold','number')} />
            <KpiTile icon="📈" label="Avg Bill (MTD)"    variant="violet" loading={mtdLoading} value={mtdLoading ? null : (mtdStatus==='error'||!mtdKpi ? '—' : fmtRupeeAuto(mtdABV))} />
          </div>
        </div>
      )}

      {/* ══ SALES PERIOD ANALYTICS ══════════════════════════ */}
      {hasData && <SalesPeriodPanel auth={auth} />}

      {/* ══ QUICK ACTIONS ═══════════════════════════════════ */}
      {quickActions.length > 0 && (
        <div>
          <div className="home-section-label">Navigate</div>
          <div style={{display:"grid", gap:12, gridTemplateColumns:`repeat(auto-fill,minmax(${mobile?148:185}px,1fr))`}}>
            {quickActions.map(a => (
              <button key={a.key} className="qa-card-v2" onClick={() => onNavigate(a.key)}>
                <div style={{width:42, height:42, borderRadius:13, background:a.bg, border:`1.5px solid ${a.border}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, marginBottom:13, flexShrink:0}}>{a.icon}</div>
                <div style={{fontSize:14, fontWeight:700, color:"var(--text-strong)", marginBottom:4}}>{a.label}</div>
                <div style={{fontSize:11.5, color:"var(--text-muted)", lineHeight:1.5, flex:1}}>{a.desc}</div>
                <div style={{fontSize:11.5, fontWeight:700, color:a.color, marginTop:12, display:"flex", alignItems:"center", gap:4}}>Open →</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ══ RECENT AI QUERIES ═══════════════════════════════ */}
      {history.length > 0 && (
        <div>
          <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12}}>
            <div className="home-section-label" style={{marginBottom:0, flex:1}}>Recent AI Queries</div>
            <button onClick={() => onNavigate("ai")} style={{fontSize:11, color:"var(--brand)", fontWeight:700, background:"none", border:"none", cursor:"pointer", flexShrink:0, marginLeft:12}}>
              Open AI Query →
            </button>
          </div>
          <div style={{background:"var(--bg-surface)", borderRadius:16, border:"1px solid var(--border-soft)", overflow:"hidden", boxShadow:"var(--shadow-sm)"}}>
            {history.slice(0, 5).map((h, i) => (
              <button key={i} type="button" className="recent-query-row"
                onClick={() => onNavigate("ai")}
                style={{borderBottom: i < Math.min(history.length,5)-1 ? "1px solid var(--border-soft)" : "none"}}>
                <span style={{fontSize:14, flexShrink:0, opacity:0.7}}>✨</span>
                <span style={{fontSize:13, color:"var(--text)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1}}>{h}</span>
                <span style={{fontSize:11, color:"var(--text-muted)", flexShrink:0}}>→</span>
              </button>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}


