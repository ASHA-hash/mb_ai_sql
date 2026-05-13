/**
 * Parameterized sales analytics: pre-aggregated SQL, quality checks, chart policy.
 */
"use strict";

const sql = require("mssql");
const { sanitizeColumnName, financialYearToIsoRange } = require("../filter-query");
const {
  resolvePeriodRange,
  daysBetweenInclusive,
  intersectPeriodWithFyBounds,
} = require("./analytics-periods");
const { getOrSet, getDataEpoch } = require("./analytics-cache");
const { chartForTrend, chartForBreakdown, progressiveHint } = require("./analytics-chart-policy");
const {
  anomalyScan,
  hashRows,
  sumSeries,
  consistencyCheck,
  preVisualizationAnomalyScan,
} = require("./analytics-quality");
const { notifyAnomalyAlerts } = require("./anomaly-alerts");
const { assertRangeSpan, parseDedupeKeyColumns } = require("./analytics-pipeline");
const { buildFilterContext, salesDimColumns } = require("./analytics-sql-context");
const {
  computeReconciliation,
  buildCompositeVerificationFingerprint,
  fetchLineSourceTotals,
  shouldRunSourceCompare,
  resolveDatasetTable,
} = require("./analytics-reconciliation");
const { planAnalyticsDashboard, resolveEffectiveTable } = require("./analytics-query-planner");
const { buildSalesForecast } = require("./analytics-forecast");
const { generateAnalyticsInsights } = require("./analytics-insights");

function sanitizeTableName(raw) {
  const s = String(raw || "").trim();
  if (!/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(s)) return null;
  return s;
}

/**
 * Returns " WITH (NOLOCK)" when ANALYTICS_NOLOCK=1 is set.
 * Reduces lock contention on large views; safe for analytics (read-only, dirty reads OK).
 * Set ANALYTICS_NOLOCK=1 in .env if queries are timing out due to lock waits.
 */
function nolock() {
  return String(process.env.ANALYTICS_NOLOCK || "").trim() === "1" ? " WITH (NOLOCK)" : "";
}

/** Pre-summarized daily grain (SaleDate × branch × dept × category); uses SUM(LineCount) instead of COUNT(*). */
function rollupLineGrainConfig() {
  const rollupDaily = sanitizeTableName(process.env.ANALYTICS_ROLLUP_DAILY_TABLE || "");
  if (!rollupDaily || String(process.env.ANALYTICS_USE_LINE_ROLLUP || "").trim() !== "1") {
    return null;
  }
  const lc = sanitizeColumnName(process.env.ANALYTICS_ROLLUP_LINECOUNT_COLUMN || "LineCount");
  return { table: rollupDaily, lineCountCol: lc || "LineCount" };
}

/** Only treat as rollup grain when the active FROM table is the rollup (smart planner may choose raw). */
function rollupGrainForEffectiveTable(effectiveTable) {
  const cfg = rollupLineGrainConfig();
  if (!cfg) return null;
  const a = sanitizeTableName(String(effectiveTable || ""));
  const b = sanitizeTableName(String(cfg.table || ""));
  if (!a || !b || a.toLowerCase() !== b.toLowerCase()) return null;
  return cfg;
}

function reconciliationSkipReason(dashboardTable, sourceTable, rollupActive) {
  const m = String(process.env.ANALYTICS_RECONCILE || "auto").trim().toLowerCase();
  if (m === "0" || m === "off" || m === "false") return "reconcile_disabled";
  if (sourceTable && dashboardTable === sourceTable && !rollupActive) return "same_line_source_as_dashboard";
  return "auto_skip_non_rolloup_path";
}

function downsampleTrendRows(rows, maxPoints) {
  const list = Array.isArray(rows) ? rows : [];
  const cap = Number(maxPoints);
  const maxPts =
    Number.isFinite(cap) && cap >= 1 ? Math.min(Math.floor(cap), 50_000) : 500;
  if (list.length <= maxPts) {
    return { rows: list, progressive: progressiveHint(list.length, maxPts) };
  }
  const step = Math.ceil(list.length / maxPts);
  const out = [];
  for (let i = 0; i < list.length; i += step) {
    out.push(list[i]);
  }
  if (out[out.length - 1] !== list[list.length - 1]) {
    out.push(list[list.length - 1]);
  }
  return { rows: out.slice(0, maxPts), progressive: progressiveHint(list.length, maxPts) };
}

async function maybeFetchDuplicateRatio(req, table, whereSql, dedupeCols) {
  if (rollupLineGrainConfig()) return null;
  if (!dedupeCols || !dedupeCols.length) return null;
  if (String(process.env.SALES_ANALYTICS_DEDUPE_CHECK || "1").trim() === "0") return null;
  const parts = dedupeCols.map((c) => `ISNULL(CAST([${c}] AS NVARCHAR(200)), N'')`);
  const catExpr = parts.join(" + N'|' + ");
  const sqlText = `
    SELECT
      COUNT(*) AS total_rows,
      COUNT(DISTINCT (${catExpr})) AS distinct_keys
    FROM ${table}${whereSql}`;
  try {
    const r = await req.query(sqlText);
    const row = r.recordset && r.recordset[0];
    if (!row) return null;
    return {
      totalRows: parseInt(String(row.total_rows), 10) || 0,
      distinctKeys: parseInt(String(row.distinct_keys), 10) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Dimension breakdown widgets + deterministic insights only (runs after `/dashboard` critical phase).
 * Does not replicate trend/KPI-quality/reconciliation paths — those stay on the cached critical payload.
 */
async function loadDashboardWidgetsPayload(pool, params) {
  const { table, datasetKey, q, crossFilter, range, topN } = params;

  assertRangeSpan(range);

  const { req, whereSql, dateCol, dims } = buildFilterContext(pool, table, datasetKey, q, crossFilter);

  const spanMs =
    new Date(`${range.to}T12:00:00Z`).getTime() - new Date(`${range.from}T12:00:00Z`).getTime();
  const spanDays = Math.max(1, Math.floor(spanMs / 86400000) + 1);

  const rollupGrain = rollupGrainForEffectiveTable(table);
  const rowCntAgg = rollupGrain
    ? `CAST(SUM(ISNULL([${rollupGrain.lineCountCol}], 0)) AS BIGINT)`
    : "COUNT(*)";

  const nl = nolock();

  const kpiSql = `
    SELECT
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS total_sales,
      ${rowCntAgg} AS txn_count,
      COUNT(DISTINCT CAST([${dateCol}] AS DATE)) AS active_days,
      CAST(MAX(CAST([${dateCol}] AS DATE)) AS varchar(10)) AS range_max_date
    FROM ${table}${nl}${whereSql}`;

  const branchSql = `
    SELECT TOP (${topN})
      CAST([${dims.branch}] AS NVARCHAR(500)) AS label,
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
      ${rowCntAgg} AS row_cnt
    FROM ${table}${nl}${whereSql}
    GROUP BY CAST([${dims.branch}] AS NVARCHAR(500))
    ORDER BY metric_value DESC`;

  const deptSql = `
    SELECT TOP (${topN})
      CAST([${dims.dept}] AS NVARCHAR(500)) AS label,
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
      ${rowCntAgg} AS row_cnt
    FROM ${table}${nl}${whereSql}
    GROUP BY CAST([${dims.dept}] AS NVARCHAR(500))
    ORDER BY metric_value DESC`;

  const catSql = `
    SELECT TOP (${topN})
      CAST([${dims.cat}] AS NVARCHAR(500)) AS label,
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
      ${rowCntAgg} AS row_cnt
    FROM ${table}${nl}${whereSql}
    GROUP BY CAST([${dims.cat}] AS NVARCHAR(500))
    ORDER BY metric_value DESC`;

  const [kpiR, branchR, deptR, catR] = await Promise.all([
    req.query(kpiSql),
    req.query(branchSql),
    req.query(deptSql),
    req.query(catSql),
  ]);

  const kpiRow = kpiR.recordset && kpiR.recordset[0] ? kpiR.recordset[0] : {};
  const totalSales = parseFloat(kpiRow.total_sales) || 0;

  const branchRows = (branchR.recordset || []).map((r) => ({
    label: String(r.label || "").trim() || "(blank)",
    metric_value: parseFloat(r.metric_value) || 0,
    row_cnt: r.row_cnt,
  }));
  const deptRows = (deptR.recordset || []).map((r) => ({
    label: String(r.label || "").trim() || "(blank)",
    metric_value: parseFloat(r.metric_value) || 0,
    row_cnt: r.row_cnt,
  }));
  const catRows = (catR.recordset || []).map((r) => ({
    label: String(r.label || "").trim() || "(blank)",
    metric_value: parseFloat(r.metric_value) || 0,
    row_cnt: r.row_cnt,
  }));

  const chkBranch = hashRows(branchRows, ["label", "metric_value"]);
  const chkDept = hashRows(deptRows, ["label", "metric_value"]);
  const chkCat = hashRows(catRows, ["label", "metric_value"]);

  let insightsBlock = { insights: [], meta: null };
  if (String(process.env.ANALYTICS_INSIGHTS_ENABLE || "").trim() === "1") {
    try {
      insightsBlock = await generateAnalyticsInsights(pool, {
        table,
        datasetKey,
        q,
        crossFilter,
        range,
        topN,
        totalSales,
        branchRows,
        spanDays,
        rollupGrain,
      });
    } catch (insErr) {
      console.error("[analytics-insights]", insErr);
      insightsBlock = { insights: [], meta: { skipped: "error", message: String(insErr.message) } };
    }
  }

  const moneyMax = Math.max(
    0,
    ...branchRows.map((r) => r.metric_value),
    ...deptRows.map((r) => r.metric_value),
    ...catRows.map((r) => r.metric_value)
  );

  const epoch = getDataEpoch();

  return {
    loadPhase: "widgets",
    schemaVersion: 2,
    dataVersion: epoch,
    computedAt: new Date().toISOString(),
    widgets: {
      byBranch: {
        chartPolicy: chartForBreakdown(
          branchRows.length,
          branchRows.map((r) => r.label),
          branchRows.map((r) => r.metric_value)
        ),
        rows: branchRows,
        progressive: progressiveHint(branchRows.length, 30),
        checksum: chkBranch,
      },
      byDepartment: {
        chartPolicy: chartForBreakdown(
          deptRows.length,
          deptRows.map((r) => r.label),
          deptRows.map((r) => r.metric_value)
        ),
        rows: deptRows,
        progressive: progressiveHint(deptRows.length, 30),
        checksum: chkDept,
      },
      byCategory: {
        chartPolicy: chartForBreakdown(
          catRows.length,
          catRows.map((r) => r.label),
          catRows.map((r) => r.metric_value)
        ),
        rows: catRows,
        progressive: progressiveHint(catRows.length, 30),
        checksum: chkCat,
      },
    },
    vizHints: {
      yAxisMoneyMax: moneyMax > 0 ? moneyMax * 1.08 : null,
      scaleMoney: "INR",
    },
    insights: insightsBlock.insights || [],
    insightsMeta: insightsBlock.meta || null,
  };
}

async function loadDashboardPayload(pool, params, tier = "full") {
  const {
    table,
    datasetKey,
    q,
    crossFilter,
    range,
    topN,
    maxTrendPoints,
    trendMonth,
    forceTrendGranularity,
  } = params;

  assertRangeSpan(range);

  const { req, whereSql, dateCol, dims } = buildFilterContext(pool, table, datasetKey, q, crossFilter);

  const spanMs =
    new Date(`${range.to}T12:00:00Z`).getTime() - new Date(`${range.from}T12:00:00Z`).getTime();
  const spanDays = Math.max(1, Math.floor(spanMs / 86400000) + 1);
  let trendMode = spanDays <= 62 ? "day" : "month";
  if (forceTrendGranularity === "day") {
    trendMode = "day";
  } else if (forceTrendGranularity === "month") {
    trendMode = "month";
  }

  let trendReq = req;
  let trendWhereSql = whereSql;
  if (trendMonth && /^\d{4}-\d{2}$/.test(String(trendMonth).trim())) {
    const [Y, Mo] = String(trendMonth).trim().split("-");
    const y = parseInt(Y, 10);
    const mo = parseInt(Mo, 10);
    const last = new Date(y, mo, 0).getDate();
    const fromM = `${Y}-${Mo}-01`;
    const toM = `${Y}-${Mo}-${String(last).padStart(2, "0")}`;
    const qT = { ...q, from: fromM, to: toM };
    const tCtx = buildFilterContext(pool, table, datasetKey, qT, crossFilter);
    trendReq = tCtx.req;
    trendWhereSql = tCtx.whereSql;
    trendMode = "day";
  }

  const rollupGrain = rollupGrainForEffectiveTable(table);
  const rowCntAgg = rollupGrain
    ? `CAST(SUM(ISNULL([${rollupGrain.lineCountCol}], 0)) AS BIGINT)`
    : "COUNT(*)";

  const nl = nolock();

  const wmCol = sanitizeColumnName(process.env.SALES_ANALYTICS_WATERMARK_COLUMN || "");
  const wmSelect = wmCol
    ? `, CAST(MAX(CAST([${wmCol}] AS DATETIME2)) AS varchar(40)) AS source_watermark`
    : "";

  const kpiSql = `
    SELECT
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS total_sales,
      ${rowCntAgg} AS txn_count,
      COUNT(DISTINCT CAST([${dateCol}] AS DATE)) AS active_days,
      CAST(MAX(CAST([${dateCol}] AS DATE)) AS varchar(10)) AS range_max_date
      ${wmSelect}
    FROM ${table}${nl}${whereSql}`;

  const branchSql = `
    SELECT TOP (${topN})
      CAST([${dims.branch}] AS NVARCHAR(500)) AS label,
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
      ${rowCntAgg} AS row_cnt
    FROM ${table}${nl}${whereSql}
    GROUP BY CAST([${dims.branch}] AS NVARCHAR(500))
    ORDER BY metric_value DESC`;

  const deptSql = `
    SELECT TOP (${topN})
      CAST([${dims.dept}] AS NVARCHAR(500)) AS label,
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
      ${rowCntAgg} AS row_cnt
    FROM ${table}${nl}${whereSql}
    GROUP BY CAST([${dims.dept}] AS NVARCHAR(500))
    ORDER BY metric_value DESC`;

  const catSql = `
    SELECT TOP (${topN})
      CAST([${dims.cat}] AS NVARCHAR(500)) AS label,
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
      ${rowCntAgg} AS row_cnt
    FROM ${table}${nl}${whereSql}
    GROUP BY CAST([${dims.cat}] AS NVARCHAR(500))
    ORDER BY metric_value DESC`;

  let trendSql;
  if (trendMode === "day") {
    trendSql = `
      SELECT
        CONVERT(varchar(10), CAST([${dateCol}] AS DATE), 23) AS period_label,
        CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
        ${rowCntAgg} AS txn_count
      FROM ${table}${nl}${trendWhereSql}
      GROUP BY CAST([${dateCol}] AS DATE)
      ORDER BY period_label`;
  } else {
    trendSql = `
      SELECT
        CONCAT(YEAR(CAST([${dateCol}] AS DATE)), '-', RIGHT('0' + CAST(MONTH(CAST([${dateCol}] AS DATE)) AS varchar(2)), 2)) AS period_label,
        CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
        ${rowCntAgg} AS txn_count
      FROM ${table}${nl}${trendWhereSql}
      GROUP BY YEAR(CAST([${dateCol}] AS DATE)), MONTH(CAST([${dateCol}] AS DATE))
      ORDER BY YEAR(CAST([${dateCol}] AS DATE)), MONTH(CAST([${dateCol}] AS DATE))`;
  }

  const dupLazy = () => maybeFetchDuplicateRatio(req, table, whereSql, parseDedupeKeyColumns());

  let kpiR;
  let dupR;
  let branchR;
  let deptR;
  let catR;
  let trendR;

  if (tier === "critical") {
    [kpiR, dupR, trendR] = await Promise.all([req.query(kpiSql), dupLazy(), trendReq.query(trendSql)]);
    branchR = { recordset: [] };
    deptR = { recordset: [] };
    catR = { recordset: [] };
  } else {
    [kpiR, dupR, branchR, deptR, catR, trendR] = await Promise.all([
      req.query(kpiSql),
      dupLazy(),
      req.query(branchSql),
      req.query(deptSql),
      req.query(catSql),
      trendReq.query(trendSql),
    ]);
  }

  const kpiRow = kpiR.recordset && kpiR.recordset[0] ? kpiR.recordset[0] : {};
  const totalSales = parseFloat(kpiRow.total_sales) || 0;
  const txnCount = parseInt(String(kpiRow.txn_count), 10) || 0;

  const branchRows = (branchR.recordset || []).map((r) => ({
    label: String(r.label || "").trim() || "(blank)",
    metric_value: parseFloat(r.metric_value) || 0,
    row_cnt: r.row_cnt,
  }));
  const deptRows = (deptR.recordset || []).map((r) => ({
    label: String(r.label || "").trim() || "(blank)",
    metric_value: parseFloat(r.metric_value) || 0,
    row_cnt: r.row_cnt,
  }));
  const catRows = (catR.recordset || []).map((r) => ({
    label: String(r.label || "").trim() || "(blank)",
    metric_value: parseFloat(r.metric_value) || 0,
    row_cnt: r.row_cnt,
  }));

  const trendRec = trendR && trendR.recordset;
  const trendList = Array.isArray(trendRec) ? trendRec : Array.from(trendRec || []);
  let trendRows = trendList.map((r) => ({
    period_label: String(r.period_label || ""),
    metric_value: parseFloat(r.metric_value) || 0,
    txn_count: parseInt(String(r.txn_count), 10) || 0,
  }));

  const trendRawForQuality = trendRows.slice();

  const trendSample = downsampleTrendRows(trendRows, maxTrendPoints);
  trendRows = Array.isArray(trendSample.rows) ? trendSample.rows : [];
  const trendProgressive = trendSample.progressive;

  const anBranch = anomalyScan(branchRows, totalSales);
  const qualityWarnings = [...anBranch.warnings];

  if (dupR && dupR.totalRows > 0 && dupR.distinctKeys > 0) {
    const ratio = dupR.totalRows / dupR.distinctKeys;
    if (ratio > 1.02) {
      qualityWarnings.push({
        code: "duplicate_rows",
        severity: "warn",
        message: `Possible duplicate line items: ${dupR.totalRows.toLocaleString()} rows vs ${dupR.distinctKeys.toLocaleString()} distinct keys (set SALES_ANALYTICS_DEDUPE_KEYS).`,
      });
    }
  }

  const preVizAnomaly = preVisualizationAnomalyScan({
    trendRows: trendRawForQuality,
    branchRows,
    deptRows,
    catRows,
    totalSales,
  });
  qualityWarnings.push(...preVizAnomaly.warnings);

  const trendWindowMatchesKpi =
    !(trendMonth && /^\d{4}-\d{2}$/.test(String(trendMonth).trim()));
  const trendSum = sumSeries(trendRawForQuality, "metric_value");
  const trendTol = parseFloat(process.env.ANALYTICS_KPI_TREND_TOLERANCE || "0.015") || 0.015;
  let kpiTrend = { ok: true, drift: 0 };
  if (trendWindowMatchesKpi) {
    kpiTrend = consistencyCheck([trendSum], totalSales, trendTol);
    if (!kpiTrend.ok) {
      qualityWarnings.push({
        code: "kpi_trend_drift",
        severity: "warn",
        message: kpiTrend.message,
      });
    }
  }

  const chkBranch = hashRows(branchRows, ["label", "metric_value"]);
  const chkDept = hashRows(deptRows, ["label", "metric_value"]);
  const chkCat = hashRows(catRows, ["label", "metric_value"]);
  const chkTrend = hashRows(trendRawForQuality, ["period_label", "metric_value"]);

  const moneyTol = parseFloat(process.env.ANALYTICS_RECONCILE_MONEY_PCT || "0.005") || 0.005;
  const txnAbsTol = parseInt(process.env.ANALYTICS_RECONCILE_TXN_ABS || "50", 10) || 50;
  const txnPctTol = parseFloat(process.env.ANALYTICS_RECONCILE_TXN_PCT || "0.005") || 0.005;
  const srcTbl = resolveDatasetTable(datasetKey);
  const rollupActive = Boolean(rollupGrain);
  const runSrc = Boolean(srcTbl) && shouldRunSourceCompare(table, srcTbl, rollupActive);

  let reco;
  if (tier === "critical") {
    reco = computeReconciliation({
      enabled: false,
      reason: "critical_phase",
      dashboardTable: table,
      sourceTable: srcTbl || null,
      dashboard: { totalSales, txnCount },
      moneyTolPct: moneyTol,
      txnTolAbs: txnAbsTol,
      txnTolPct: txnPctTol,
    });
  } else if (!srcTbl) {
    reco = computeReconciliation({
      enabled: false,
      reason: "no_source",
      dashboardTable: table,
      sourceTable: null,
      dashboard: { totalSales, txnCount },
      moneyTolPct: moneyTol,
      txnTolAbs: txnAbsTol,
      txnTolPct: txnPctTol,
    });
  } else if (!runSrc) {
    reco = computeReconciliation({
      enabled: false,
      reason: reconciliationSkipReason(table, srcTbl, rollupActive),
      dashboardTable: table,
      sourceTable: srcTbl,
      dashboard: { totalSales, txnCount },
      moneyTolPct: moneyTol,
      txnTolAbs: txnAbsTol,
      txnTolPct: txnPctTol,
    });
  } else {
    try {
      const srcTotals = await fetchLineSourceTotals(pool, srcTbl, datasetKey, q, crossFilter);
      reco = computeReconciliation({
        enabled: true,
        sourceTable: srcTbl,
        dashboardTable: table,
        dashboard: { totalSales, txnCount },
        source: srcTotals,
        moneyTolPct: moneyTol,
        txnTolAbs: txnAbsTol,
        txnTolPct: txnPctTol,
      });
    } catch (e) {
      reco = {
        ok: false,
        skipped: false,
        error: true,
        message: String(e.message),
        compared: "source_error",
        dashboardTable: table,
        sourceTable: srcTbl,
        dashboard: { totalSales, txnCount },
        at: new Date().toISOString(),
      };
    }
  }

  const compositeFingerprint = buildCompositeVerificationFingerprint({
    totalSales,
    txnCount,
    trendSum,
    chkBranch,
    chkDept,
    chkCat,
    chkTrend,
  });

  if (reco.mismatch) {
    const d = reco.drift || {};
    qualityWarnings.push({
      code: "reconciliation_drift",
      severity: "warn",
      message: `Totals diverge from line source ${srcTbl}: money Δ ${((d.moneyPct || 0) * 100).toFixed(3)}%, txn Δ ${d.txnAbs ?? "?"}`,
    });
  }
  if (reco.error) {
    qualityWarnings.push({
      code: "reconciliation_error",
      severity: "warn",
      message: `Reconciliation failed: ${reco.message}`,
    });
  }

  let trendForecast = null;
  if (
    tier !== "critical" &&
    String(process.env.ANALYTICS_FORECAST_ENABLE || "").trim() === "1"
  ) {
    trendForecast = buildSalesForecast({
      series: trendRawForQuality,
      granularity: trendMode === "month" ? "month" : "day",
    });
    if (!trendForecast.enabled) {
      trendForecast = null;
    }
  }

  const fcVals = [];
  if (trendForecast && trendForecast.enabled) {
    if (Array.isArray(trendForecast.values)) fcVals.push(...trendForecast.values);
    if (Array.isArray(trendForecast.upper)) fcVals.push(...trendForecast.upper);
  }

  const moneyMax = Math.max(
    0,
    ...branchRows.map((r) => r.metric_value),
    ...deptRows.map((r) => r.metric_value),
    ...catRows.map((r) => r.metric_value),
    ...trendRawForQuality.map((r) => r.metric_value),
    ...fcVals
  );

  const epoch = getDataEpoch();

  if (tier !== "critical") {
    await notifyAnomalyAlerts(
      { warnings: qualityWarnings, anomalies: preVizAnomaly.anomalies },
      {
        dataset: datasetKey,
        table,
        periodFrom: range.from,
        periodTo: range.to,
        dataVersion: epoch,
      }
    );
  }

  let insightsBlock = { insights: [], meta: null };
  if (tier !== "critical" && String(process.env.ANALYTICS_INSIGHTS_ENABLE || "").trim() === "1") {
    try {
      insightsBlock = await generateAnalyticsInsights(pool, {
        table,
        datasetKey,
        q,
        crossFilter,
        range,
        topN,
        totalSales,
        branchRows,
        spanDays,
        rollupGrain,
      });
    } catch (insErr) {
      console.error("[analytics-insights]", insErr);
      insightsBlock = { insights: [], meta: { skipped: "error", message: String(insErr.message) } };
    }
  }

  return {
    schemaVersion: 2,
    ...(tier === "critical" ? { loadPhase: "critical" } : {}),
    dataVersion: epoch,
    computedAt: new Date().toISOString(),
    dataset: datasetKey,
    table,
    rollupHint: rollupGrain
      ? `LINE_ROLLUP table=${rollupGrain.table} (txn KPI = Σ LineCount)`
      : process.env.ANALYTICS_BASE_TABLE
        ? `Using ANALYTICS_BASE_TABLE=${process.env.ANALYTICS_BASE_TABLE}`
        : null,
    dimensions: {
      amountColumn: dims.amount,
      dateColumn: dateCol,
      branchColumn: dims.branch,
      departmentColumn: dims.dept,
      categoryColumn: dims.cat,
    },
    period: {
      preset: range.preset,
      from: range.from,
      to: range.to,
      spanDays,
      fyLabel: range.fyLabel || null,
      fyContextNote: range.fyContextNote || null,
    },
    trendContext: {
      granularity: trendMode,
      drillMonth: trendMonth && /^\d{4}-\d{2}$/.test(String(trendMonth).trim()) ? String(trendMonth).trim() : null,
      forcedGranularity: forceTrendGranularity || null,
    },
    kpi: {
      totalSales,
      txnCount,
      activeDays: parseInt(String(kpiRow.active_days), 10) || 0,
    },
    widgets: {
      byBranch: {
        chartPolicy: chartForBreakdown(
          branchRows.length,
          branchRows.map((r) => r.label),
          branchRows.map((r) => r.metric_value)
        ),
        rows: branchRows,
        progressive: progressiveHint(branchRows.length, 30),
        checksum: chkBranch,
      },
      byDepartment: {
        chartPolicy: chartForBreakdown(
          deptRows.length,
          deptRows.map((r) => r.label),
          deptRows.map((r) => r.metric_value)
        ),
        rows: deptRows,
        progressive: progressiveHint(deptRows.length, 30),
        checksum: chkDept,
      },
      byCategory: {
        chartPolicy: chartForBreakdown(
          catRows.length,
          catRows.map((r) => r.label),
          catRows.map((r) => r.metric_value)
        ),
        rows: catRows,
        progressive: progressiveHint(catRows.length, 30),
        checksum: chkCat,
      },
      byTrend: {
        chartPolicy: chartForTrend(trendMode, trendRawForQuality.length),
        rows: Array.isArray(trendRows) ? trendRows : [],
        granularity: trendMode,
        forecast: trendForecast || null,
        progressive: trendProgressive || progressiveHint(trendRawForQuality.length, 90),
        checksum: chkTrend,
      },
    },
    vizHints: {
      yAxisMoneyMax: moneyMax > 0 ? moneyMax * 1.08 : null,
      scaleMoney: "INR",
    },
    quality: {
      warnings: qualityWarnings,
      kpiTrendDrift: kpiTrend.ok ? null : kpiTrend,
      anomalies: preVizAnomaly.anomalies || [],
    },
    reconciliation: reco,
    compositeFingerprint,
    insights: insightsBlock.insights || [],
    insightsMeta: insightsBlock.meta || null,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   PUBLIC ENTRY POINT — called by /api/analytics/dashboard
   ───────────────────────────────────────────────────────────────────────────── */
async function runAnalyticsDashboard(pool, body) {
  /* 1. Resolve the date range: always apply period/custom first, then clip to
        India FY if `fy` is set (FY26 …). Using FY alone used to replace the whole
        window and made MTD/QTD/30d/90d identical — now FY narrows the preset. */
  let range = resolvePeriodRange(
    body.period || "mtd",
    body.custom || null
  );
  if (body.fy && String(body.fy).trim()) {
    const fyRange = financialYearToIsoRange(String(body.fy).trim());
    if (fyRange) {
      const clipped = intersectPeriodWithFyBounds(range, fyRange);
      if (clipped && clipped.fyIntersectEmpty) {
        range = {
          ...range,
          fyLabel: null,
          fyContextNote:
            "India FY does not overlap this period (e.g. FY already ended or today is in the next FY). Data uses the chip range only — Clear FY or enter the FY that contains today.",
        };
      } else {
        const rawFy = String(body.fy).trim();
        const lbl = /^fy/i.test(rawFy) ? rawFy.replace(/\s+/g, "") : `FY${rawFy.replace(/^fy/i, "").trim()}`;
        range = { ...clipped, fyLabel: lbl, fyContextNote: null };
      }
    }
  }

  /* 2. Run the query planner (decides table, cache TTL, rollup strategy). */
  const plan = await planAnalyticsDashboard(pool, {
    datasetKey: body.dataset || "sales",
    range,      // pass resolved range so planner knows spanDays
    body,
  });

  /* 3. The planner returns effectiveTable, not table — normalise here. */
  const table      = plan.effectiveTable || null;
  const tier       = String(body.loadPhase || "full").toLowerCase();
  const topN       = 20;
  const maxTrend   = 180;

  /* Helper: call getOrSet with the correct 4-argument signature and merge
     the cache metadata (cacheHit, cacheLayer) into the returned payload so
     that index.js can read out.cacheHit / out.dataVersion from one object. */
  async function cached(namespace, keyPayload, factory, ttlSec) {
    const result = await getOrSet(
      namespace,
      keyPayload,
      factory,
      { ttlMs: ttlSec * 1000 }
    );
    // Merge cache wrapper props into the payload value so callers get a flat object
    return { ...result.value, cacheHit: result.cacheHit, cacheLayer: result.cacheLayer };
  }

  if (tier === "widgets") {
    return cached(
      "analytics_widgets",
      { table, dataset: plan.datasetKey, period: body.period, from: range.from, to: range.to, cf: body.crossFilter },
      () => loadDashboardWidgetsPayload(pool, {
        table,
        datasetKey:  plan.datasetKey,
        q:           { from: range.from, to: range.to, branch: body.branch, department: body.department, category: body.category },
        crossFilter: body.crossFilter || null,
        range,
        topN,
      }),
      120
    );
  }

  return cached(
    `analytics_dashboard_${tier}`,
    {
      table,
      dataset: plan.datasetKey,
      period: String(body.period || "mtd").toLowerCase().trim(),
      from: range.from,
      to: range.to,
      cf: body.crossFilter,
      fy: body.fy,
      tm: body.trendMonth,
      fg: body.forceTrendGranularity,
    },
    () => loadDashboardPayload(pool, {
      table,
      datasetKey:            plan.datasetKey,
      q:                     { from: range.from, to: range.to, branch: body.branch, department: body.department, category: body.category },
      crossFilter:           body.crossFilter || null,
      range,
      topN,
      maxTrendPoints:        maxTrend,
      trendMonth:            body.trendMonth || null,
      forceTrendGranularity: body.forceTrendGranularity || null,
    }, tier),
    tier === "critical" ? 90 : 180
  );
}

module.exports = {
  runAnalyticsDashboard,
  bumpDataEpoch: require("./analytics-cache").bumpDataEpoch,
  getDataEpoch:  require("./analytics-cache").getDataEpoch,
  recordDataFreshnessFromPayload: require("./observability-kpis").recordDataFreshnessFromPayload,
};
