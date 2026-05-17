/**
 * Shared filter / WHERE context for analytics queries (dashboard + reconciliation).
 * Column names are resolved from metadata + canonical zRetailHQ0 roles (XnDt, MrpValue, …).
 */
"use strict";

const sql = require("mssql");
const { getFilterColumns, sanitizeColumnName } = require("../filter-query");
const { resolveAnalyticsColumns, buildTrendSql } = require("./analytics-column-map");

function salesDimColumns(effectiveTable, datasetKey) {
  return resolveAnalyticsColumns(effectiveTable, datasetKey);
}

/** Shared SELECT list for dashboard / home KPI aggregates. */
function buildKpiSelectSql(dims, dateCol, rowCntAgg, wmSelect) {
  const billExpr = dims.invoice ? `COUNT(DISTINCT [${dims.invoice}])` : rowCntAgg;
  const custExpr = dims.customer ? `COUNT(DISTINCT [${dims.customer}])` : "CAST(NULL AS BIGINT)";
  const qtyExpr = dims.qty
    ? `CAST(SUM(ISNULL([${dims.qty}], 0)) AS DECIMAL(38, 4))`
    : "CAST(NULL AS DECIMAL(38, 4))";
  return `
      CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS total_sales,
      ${rowCntAgg} AS txn_count,
      ${billExpr} AS bill_count,
      ${custExpr} AS customer_count,
      ${qtyExpr} AS quantity_sold,
      COUNT(DISTINCT CAST([${dateCol}] AS DATE)) AS active_days,
      CAST(MAX(CAST([${dateCol}] AS DATE)) AS varchar(10)) AS range_max_date
      ${wmSelect}`;
}

/**
 * Resolve the date column for the effective analytics table.
 * Env per-table → dataset filter prefix → metadata canonical (XnDt).
 */
function resolveAnalyticsDateCol(effectiveTable, datasetKey) {
  const tableBase = String(effectiveTable || "")
    .replace(/^dbo\./i, "")
    .toUpperCase()
    .replace(/[.\s-]+/g, "_");

  if (tableBase) {
    const tableEnvKey = tableBase + "_FILTER_DATE_COLUMN";
    const tableEnvVal = sanitizeColumnName(process.env[tableEnvKey] || "");
    if (tableEnvVal) return tableEnvVal;
  }

  const dateCfg = getFilterColumns(datasetKey);
  const fromPrefix = sanitizeColumnName(dateCfg.date);
  if (fromPrefix) return fromPrefix;

  const dims = resolveAnalyticsColumns(effectiveTable, datasetKey);
  return dims.date || "";
}

function appendCrossFilterParts(request, crossFilter, allowed) {
  var parts = [];
  var obj = (crossFilter && typeof crossFilter === "object") ? crossFilter : {};
  var i = 0;
  Object.entries(obj).forEach(function(entry) {
    var rawKey = entry[0];
    var rawVal = entry[1];
    var col = sanitizeColumnName(rawKey);
    if (!col || !allowed.includes(col)) return;
    var v = (rawVal == null) ? "" : String(rawVal).trim();
    if (!v) return;
    var pname = "cf_" + i++;
    request.input(pname, sql.NVarChar(4000), v);
    parts.push("CAST([" + col + "] AS NVARCHAR(4000)) = @" + pname);
  });
  return parts;
}

/**
 * Build a parameterized WHERE context for the effective analytics table.
 * Handles date, branch, dept, category, and cross-filter predicates.
 */
function buildFilterContext(pool, table, datasetKey, q, crossFilter) {
  var effectiveTable = table;
  var dims = salesDimColumns(effectiveTable, datasetKey);
  var dateCol = resolveAnalyticsDateCol(effectiveTable, datasetKey);
  if (!dateCol) {
    var e = new Error(datasetKey + "/" + effectiveTable + ": date column not configured for analytics filters");
    e.status = 400;
    e.code = "date_filter_not_configured";
    throw e;
  }

  var req = pool.request();
  var whereParts = [];

  var from = String((q && q.from) ? q.from : "").trim();
  var to   = String((q && q.to)   ? q.to   : "").trim();
  if (from && to) {
    req.input("a_from", sql.VarChar(10), from);
    req.input("a_to",   sql.VarChar(10), to);
    whereParts.push("CAST([" + dateCol + "] AS DATE) BETWEEN CAST(@a_from AS DATE) AND CAST(@a_to AS DATE)");
  }

  var branchVal = String((q && q.branch) ? q.branch : "").trim();
  if (branchVal && dims.branch) {
    req.input("a_branch", sql.NVarChar(500), "%" + branchVal + "%");
    whereParts.push("CAST([" + dims.branch + "] AS NVARCHAR(500)) LIKE @a_branch");
  }

  var deptVal = String((q && q.department) ? q.department : "").trim();
  if (deptVal && dims.dept) {
    req.input("a_dept", sql.NVarChar(500), "%" + deptVal + "%");
    whereParts.push("CAST([" + dims.dept + "] AS NVARCHAR(500)) LIKE @a_dept");
  }

  var catVal = String((q && q.category) ? q.category : "").trim();
  if (catVal && dims.cat) {
    req.input("a_cat", sql.NVarChar(500), "%" + catVal + "%");
    whereParts.push("CAST([" + dims.cat + "] AS NVARCHAR(500)) LIKE @a_cat");
  }

  var cfParts = appendCrossFilterParts(req, crossFilter, [dims.branch, dims.dept, dims.cat].filter(Boolean));
  var allWhere = whereParts.concat(cfParts);
  var whereSql = allWhere.length ? " WHERE " + allWhere.join(" AND ") : "";

  return { req: req, whereSql: whereSql, table: table, dateCol: dateCol, dims: dims };
}

function parseAnalyticsTopN(raw, fallback) {
  const fbSrc =
    fallback != null && String(fallback).trim() !== ""
      ? fallback
      : process.env.ANALYTICS_TOP_N || "20";
  const fb = parseInt(String(fbSrc), 10) || 20;
  const cap = parseInt(String(process.env.ANALYTICS_TOP_N_MAX || "200"), 10) || 200;
  const n = parseInt(String(raw != null ? raw : ""), 10);
  if (!Number.isFinite(n) || n < 1) return Math.min(cap, Math.max(5, fb));
  return Math.min(cap, Math.max(5, n));
}

module.exports = {
  salesDimColumns: salesDimColumns,
  buildKpiSelectSql: buildKpiSelectSql,
  buildTrendSql: buildTrendSql,
  parseAnalyticsTopN: parseAnalyticsTopN,
  appendCrossFilterParts: appendCrossFilterParts,
  buildFilterContext: buildFilterContext,
  resolveAnalyticsDateCol: resolveAnalyticsDateCol,
};
