/**
 * Compare dashboard aggregates (rollup / base override) to line-level source totals;
 * composite fingerprints for drift detection + batch jobs.
 */
"use strict";

const crypto = require("crypto");
const { getDatasetEntry, sanitizeColumnName } = require("../filter-query");
const { buildFilterContext } = require("./analytics-sql-context");

function sanitizeTableName(raw) {
  const s = String(raw || "").trim();
  if (!/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(s)) return null;
  return s;
}

function resolveDatasetTable(datasetKey) {
  const e = getDatasetEntry(datasetKey);
  if (!e) return null;
  let full = e.defaultTable;
  if (e.envOverride && process.env[e.envOverride]) {
    full = process.env[e.envOverride];
  }
  return sanitizeTableName(full);
}

/**
 * Line-level truth: SUM(sales) + COUNT(*) on the canonical sales view.
 */
async function fetchLineSourceTotals(pool, sourceTable, datasetKey, q, crossFilter) {
  const { req, whereSql, dims } = buildFilterContext(pool, sourceTable, datasetKey, q, crossFilter);
  const sqlText = `
    SELECT
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS total_sales,
      CAST(COUNT(*) AS BIGINT) AS txn_count
    FROM ${sourceTable}${whereSql}`;
  const r = await req.query(sqlText);
  const row = r.recordset && r.recordset[0] ? r.recordset[0] : {};
  return {
    totalSales: parseFloat(row.total_sales) || 0,
    txnCount: parseInt(String(row.txn_count), 10) || 0,
  };
}

function pctDrift(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const den = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / den;
}

/**
 * @param {{
 *   enabled: boolean,
 *   reason?: string,
 *   sourceTable: string | null,
 *   dashboardTable: string,
 *   dashboard: { totalSales: number, txnCount: number },
 *   source?: { totalSales: number, txnCount: number },
 *   moneyTolPct: number,
 *   txnTolAbs: number,
 *   txnTolPct: number,
 * }} opts
 */
function computeReconciliation(opts) {
  const now = new Date().toISOString();
  const dashSnap =
    opts.dashboard != null
      ? {
          totalSales: opts.dashboard.totalSales,
          txnCount: opts.dashboard.txnCount,
        }
      : null;
  if (!opts.enabled) {
    return {
      ok: true,
      skipped: true,
      reason: opts.reason || "disabled",
      compared: "none",
      dashboardTable: opts.dashboardTable,
      sourceTable: opts.sourceTable,
      dashboard: dashSnap,
      at: now,
    };
  }
  if (!opts.sourceTable || !opts.source) {
    return {
      ok: true,
      skipped: true,
      reason: "no_source_table",
      compared: "none",
      dashboardTable: opts.dashboardTable,
      sourceTable: opts.sourceTable,
      dashboard: dashSnap,
      at: now,
    };
  }

  const src = opts.source;
  const dash = opts.dashboard;
  const moneyDrift = pctDrift(src.totalSales, dash.totalSales);
  const txnDriftPct = pctDrift(src.txnCount, dash.txnCount);
  const txnAbs = Math.abs(src.txnCount - dash.txnCount);

  const moneyBad = moneyDrift > opts.moneyTolPct;
  const txnBad = txnAbs > opts.txnTolAbs && txnDriftPct > opts.txnTolPct;
  const mismatch = moneyBad || txnBad;

  return {
    ok: !mismatch,
    skipped: false,
    reason: mismatch ? "source_dashboard_drift" : null,
    compared: "source_vs_dashboard",
    dashboardTable: opts.dashboardTable,
    sourceTable: opts.sourceTable,
    source: {
      totalSales: src.totalSales,
      txnCount: src.txnCount,
    },
    dashboard: dashSnap || {
      totalSales: dash.totalSales,
      txnCount: dash.txnCount,
    },
    drift: {
      moneyPct: moneyDrift,
      txnPct: txnDriftPct,
      txnAbs,
      moneyBad,
      txnBad,
    },
    tolerance: {
      moneyPct: opts.moneyTolPct,
      txnAbs: opts.txnTolAbs,
      txnPct: opts.txnTolPct,
    },
    mismatch,
    at: now,
  };
}

function buildCompositeVerificationFingerprint(parts) {
  const canonical = {
    kpiRounded: parts.totalSales != null ? Math.round(parts.totalSales * 1e4) / 1e4 : 0,
    txn: parts.txnCount ?? 0,
    trendSum:
      parts.trendSum != null ? Math.round(parts.trendSum * 1e4) / 1e4 : 0,
    chkBranch: parts.chkBranch || "",
    chkDept: parts.chkDept || "",
    chkCat: parts.chkCat || "",
    chkTrend: parts.chkTrend || "",
  };
  const h = crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return h.slice(0, 20);
}

function reconcileModeFromEnv() {
  const v = String(process.env.ANALYTICS_RECONCILE || "auto").trim().toLowerCase();
  return v;
}

/**
 * Whether to run an extra round-trip against the line-level view.
 */
function shouldRunSourceCompare(effectiveTable, sourceTable, rollupActive) {
  const mode = reconcileModeFromEnv();
  if (mode === "0" || mode === "off" || mode === "false") return false;
  if (mode === "1" || mode === "always" || mode === "on") return Boolean(sourceTable);
  if (mode === "auto") {
    return Boolean(sourceTable && (rollupActive || effectiveTable !== sourceTable));
  }
  return Boolean(sourceTable);
}

module.exports = {
  fetchLineSourceTotals,
  computeReconciliation,
  buildCompositeVerificationFingerprint,
  resolveDatasetTable,
  sanitizeTableName,
  reconcileModeFromEnv,
  shouldRunSourceCompare,
};
