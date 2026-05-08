/**
 * Deterministic analytics insights: numbers come from SQL aggregates only.
 * Optional phrasing is template-based — no free-form LLM in the default path (avoids hallucinated %).
 *
 * Pipeline: prior-window aggregates → compare totals → rank branches vs median → guardrails → insight objects.
 */
"use strict";

const { buildFilterContext } = require("./analytics-sql-context");
const { daysBetweenInclusive } = require("./analytics-periods");

function addDaysIso(iso, deltaDays) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Immediately preceding window of the same length (ends the day before current `from`).
 */
function priorComparableRange(range) {
  const from = String(range.from).slice(0, 10);
  const days =
    range.days != null && Number.isFinite(Number(range.days))
      ? Math.max(1, parseInt(String(range.days), 10))
      : daysBetweenInclusive(from, String(range.to).slice(0, 10));
  if (days < 1) return null;
  const priorTo = addDaysIso(from, -1);
  const priorFrom = addDaysIso(priorTo, -(days - 1));
  return { from: priorFrom, to: priorTo, days };
}

function parseEnvNum(key, def) {
  const n = parseFloat(String(process.env[key] || ""));
  return Number.isFinite(n) ? n : def;
}

function parseEnvInt(key, def) {
  const n = parseInt(String(process.env[key] || ""), 10);
  return Number.isFinite(n) ? n : def;
}

/** @param {number} x */
function compactInr(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  if (Math.abs(n) >= 1e3) return `₹${(n / 1e3).toFixed(1)} k`;
  return `₹${n.toFixed(0)}`;
}

function pctChange(current, prior) {
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

/**
 * @param {import("mssql").ConnectionPool} pool
 * @param {{
 *   table: string,
 *   datasetKey: string,
 *   q: object,
 *   crossFilter: object,
 *   range: { from: string, to: string },
 *   topN: number,
 *   rollupGrain: { lineCountCol: string } | null,
 * }} opts
 */
async function fetchPeriodSnapshot(pool, opts) {
  const { table, datasetKey, q, crossFilter, range, topN, rollupGrain } = opts;
  const qP = { ...q, from: range.from, to: range.to };
  const { req, whereSql, dims } = buildFilterContext(pool, table, datasetKey, qP, crossFilter);
  const rowCntAgg = rollupGrain
    ? `CAST(SUM(ISNULL([${rollupGrain.lineCountCol}], 0)) AS BIGINT)`
    : "COUNT(*)";
  const kpiSql = `
    SELECT
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS total_sales,
      ${rowCntAgg} AS txn_count
    FROM ${table}${whereSql}`;
  const branchSql = `
    SELECT TOP (${topN})
      CAST([${dims.branch}] AS NVARCHAR(500)) AS label,
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
      ${rowCntAgg} AS row_cnt
    FROM ${table}${whereSql}
    GROUP BY CAST([${dims.branch}] AS NVARCHAR(500))
    ORDER BY metric_value DESC`;
  const kpiR = await req.query(kpiSql);
  const brR = await req.query(branchSql);
  const kr = kpiR.recordset && kpiR.recordset[0];
  const totalSales = parseFloat(kr && kr.total_sales) || 0;
  const txnCount = parseInt(String(kr && kr.txn_count), 10) || 0;
  const branchRows = (brR.recordset || []).map((r) => ({
    label: String(r.label || "").trim() || "(blank)",
    metric_value: parseFloat(r.metric_value) || 0,
    row_cnt: r.row_cnt,
  }));
  return { totalSales, txnCount, branchRows };
}

/**
 * Median of positive values only.
 */
function medianPositive(values) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Concentration: share of largest branch in total of branch rows.
 */
function topBranchConcentration(branchRows) {
  const vals = branchRows.map((r) => Math.max(0, r.metric_value || 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;
  const mx = Math.max(...vals);
  return mx / sum;
}

/**
 * @param {{
 *   currentTotal: number,
 *   priorTotal: number,
 *   branchRows: { label: string, metric_value: number }[],
 *   currentRange: { from: string, to: string, preset?: string },
 *   priorRange: { from: string, to: string, days: number },
 *   spanDays: number,
 * }} ctx
 */
function buildDeterministicInsights(ctx) {
  const minSpan = parseEnvInt("ANALYTICS_INSIGHTS_MIN_SPAN_DAYS", 3);
  const minPriorForPct = parseEnvNum("ANALYTICS_INSIGHTS_MIN_PRIOR_FOR_PCT", 1000);
  const noiseFloor = parseEnvNum("ANALYTICS_INSIGHTS_PCT_NOISE_FLOOR", 3);
  const minBranches = parseEnvInt("ANALYTICS_INSIGHTS_MIN_BRANCHES", 4);
  const underRatio = parseEnvNum("ANALYTICS_INSIGHTS_BRANCH_UNDERPERFORM_RATIO", 0.55);
  const concCaveat = parseEnvNum("ANALYTICS_INSIGHTS_CONCENTRATION_WARN", 0.72);
  const minBranchAbs = parseEnvNum("ANALYTICS_INSIGHTS_MIN_BRANCH_REVENUE", 25000);

  const insights = [];
  const {
    currentTotal,
    priorTotal,
    branchRows,
    currentRange,
    priorRange,
    spanDays,
  } = ctx;

  if (spanDays < minSpan) {
    return {
      insights: [],
      meta: {
        skipped: "span_too_short",
        minSpanDays: minSpan,
        spanDays,
      },
    };
  }

  const meta = {
    comparison: "prior_window_same_length",
    currentFrom: currentRange.from,
    currentTo: currentRange.to,
    priorFrom: priorRange.from,
    priorTo: priorRange.to,
    spanDays,
    priorTotal,
    currentTotal,
  };

  const pct = pctChange(currentTotal, priorTotal);
  const rounded =
    pct != null && Number.isFinite(pct) ? Math.round(pct * 10) / 10 : null;

  if (priorTotal >= minPriorForPct && rounded != null && Math.abs(rounded) >= noiseFloor) {
    const up = rounded > 0;
    insights.push({
      id: "net_sales_vs_prior_window",
      severity: Math.abs(rounded) >= 25 ? "warn" : "info",
      title: `Net sales ${up ? "increased" : "decreased"} ${Math.abs(rounded)}% vs the prior ${spanDays}-day period`,
      detail: `Current window ${currentRange.from} → ${currentRange.to}: ${compactInr(
        currentTotal
      )}. Immediately preceding ${spanDays}-day window ${priorRange.from} → ${priorRange.to}: ${compactInr(
        priorTotal
      )}.`,
      metrics: {
        currentTotal,
        priorTotal,
        pctChange: rounded,
        basis: "revenue_same_filters",
      },
      confidence: priorTotal >= minPriorForPct * 10 ? "high" : "medium",
      caveats: [],
      source: "aggregate_compare",
    });
  } else if (priorTotal > 0 && priorTotal < minPriorForPct && currentTotal > minPriorForPct) {
    const delta = currentTotal - priorTotal;
    insights.push({
      id: "net_sales_vs_prior_small_base",
      severity: "info",
      title: `Net sales ${delta >= 0 ? "higher" : "lower"} than the tiny prior-period baseline`,
      detail: `Current: ${compactInr(currentTotal)}. Prior ${spanDays}-day window: ${compactInr(
        priorTotal
      )}. Percentage change is not emphasized because the prior total is below the reliability floor (${compactInr(
        minPriorForPct
      )}).`,
      metrics: { currentTotal, priorTotal, absoluteDelta: delta },
      confidence: "low",
      caveats: [
        "Very small denominators inflate %; we show absolute comparison instead of a percent headline.",
      ],
      source: "aggregate_compare_guarded",
    });
  }

  const branchesWithSales = branchRows.filter((b) => b.metric_value >= minBranchAbs);
  const med = medianPositive(branchesWithSales.map((b) => b.metric_value));
  const concentration = topBranchConcentration(branchRows.filter((b) => b.metric_value > 0));

  const effectiveUnderThreshold = med * underRatio;
  if (
    branchesWithSales.length >= minBranches &&
    med > 0 &&
    effectiveUnderThreshold > minBranchAbs
  ) {
    const caveats =
      concentration >= concCaveat
        ? [
            `One branch represents about ${(concentration * 100).toFixed(
              0
            )}% of branch-attributed sales in this view — peer ranking may be misleading.`,
          ]
        : [];

    const maxBranchInsights = parseEnvInt("ANALYTICS_INSIGHTS_MAX_BRANCH_FLAGS", 3);
    const candidates = branchRows
      .filter((b) => b.metric_value >= minBranchAbs && b.label && b.label !== "(blank)")
      .filter((b) => b.metric_value < effectiveUnderThreshold)
      .sort((a, b) => a.metric_value - b.metric_value)
      .slice(0, Math.max(1, maxBranchInsights));

    for (const b of candidates) {
      const v = b.metric_value;
      const gapPct = Math.round((1 - v / med) * 100);
      const slug = String(b.label)
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .slice(0, 48);
      insights.push({
        id: `branch_underperform_${slug}`,
        severity: "warn",
        title: `Branch “${b.label}” is underperforming vs typical branches this period`,
        detail: `${compactInr(v)} in this window vs median branch (among those above ${compactInr(
          minBranchAbs
        )}) of about ${compactInr(med)} — about ${gapPct}% below that benchmark.`,
        metrics: {
          branch: b.label,
          branchRevenue: v,
          medianPeerRevenue: med,
          ratioToMedian: med > 0 ? v / med : null,
        },
        confidence: concentration >= concCaveat ? "low" : "medium",
        caveats: [...caveats],
        source: "branch_vs_median",
      });
    }
  }

  return { insights, meta: { ...meta, medianBranchRevenue: med || null, concentration } };
}

/**
 * @param {import("mssql").ConnectionPool} pool
 * @param {{
 *   table: string,
 *   datasetKey: string,
 *   q: object,
 *   crossFilter: object,
 *   range: object,
 *   topN: number,
 *   totalSales: number,
 *   branchRows: object[],
 *   spanDays: number,
 *   rollupGrain: object | null,
 * }} ctx
 */
async function generateAnalyticsInsights(pool, ctx) {
  const priorRange = priorComparableRange(ctx.range);
  if (!priorRange) {
    return { insights: [], meta: { skipped: "no_prior_range" } };
  }

  let priorSnap;
  try {
    priorSnap = await fetchPeriodSnapshot(pool, {
      table: ctx.table,
      datasetKey: ctx.datasetKey,
      q: ctx.q,
      crossFilter: ctx.crossFilter,
      range: priorRange,
      topN: ctx.topN,
      rollupGrain: ctx.rollupGrain,
    });
  } catch (e) {
    return {
      insights: [],
      meta: { skipped: "prior_fetch_failed", error: String(e.message) },
    };
  }

  return buildDeterministicInsights({
    currentTotal: ctx.totalSales,
    priorTotal: priorSnap.totalSales,
    branchRows: ctx.branchRows || [],
    currentRange: ctx.range,
    priorRange,
    spanDays: ctx.spanDays,
  });
}

module.exports = {
  generateAnalyticsInsights,
  priorComparableRange,
  fetchPeriodSnapshot,
  buildDeterministicInsights,
  __internal: { addDaysIso, pctChange, medianPositive },
};
