/**
 * Shared filter / WHERE context for analytics queries (dashboard + reconciliation).
 * Uses ANALYTICS_BASE_TABLE + SALES_ANALYTICS_* env vars to resolve the correct
 * table and dimension columns (which may differ from the raw sales view).
 */
"use strict";

const sql = require("mssql");
const { getFilterColumns, sanitizeColumnName } = require("../filter-query");

function salesDimColumns() {
  const amt    = sanitizeColumnName(process.env.SALES_ANALYTICS_AMOUNT_COLUMN     || "SaleNetAmount") || "SaleNetAmount";
  const branch = sanitizeColumnName(process.env.SALES_ANALYTICS_BRANCH_DIM        || "BranchName")    || "BranchName";
  const dept   = sanitizeColumnName(process.env.SALES_ANALYTICS_DEPARTMENT_DIM    || "DepartmentName")|| "DepartmentName";
  const cat    = sanitizeColumnName(process.env.SALES_ANALYTICS_CATEGORY_DIM      || "CategoryName")  || "CategoryName";
  return { amount: amt, branch, dept, cat };
}

/**
 * Resolve the date column for the effective analytics table.
 * Checks for a per-table env var first, e.g.
 *   VW_MB_POWERBI_SLSXNS_REPORT_FILTER_DATE_COLUMN=XnDt
 * then falls back to the dataset-keyed var (SALES_FILTER_DATE_COLUMN).
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
  return sanitizeColumnName(dateCfg.date) || "";
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
  var dims = salesDimColumns();
  var effectiveTable = table;
  var dateCol = resolveAnalyticsDateCol(effectiveTable, datasetKey);
  if (!dateCol) {
    var e = new Error(datasetKey + "/" + effectiveTable + ": date column not configured for analytics filters");
    e.status = 400;
    e.code = "date_filter_not_configured";
    throw e;
  }

  var req = pool.request();
  var whereParts = [];

  // Date range
  var from = String((q && q.from) ? q.from : "").trim();
  var to   = String((q && q.to)   ? q.to   : "").trim();
  if (from && to) {
    req.input("a_from", sql.VarChar(10), from);
    req.input("a_to",   sql.VarChar(10), to);
    whereParts.push("CAST([" + dateCol + "] AS DATE) BETWEEN CAST(@a_from AS DATE) AND CAST(@a_to AS DATE)");
  }

  // Branch filter
  var branchVal = String((q && q.branch) ? q.branch : "").trim();
  if (branchVal) {
    req.input("a_branch", sql.NVarChar(500), "%" + branchVal + "%");
    whereParts.push("CAST([" + dims.branch + "] AS NVARCHAR(500)) LIKE @a_branch");
  }

  // Department filter
  var deptVal = String((q && q.department) ? q.department : "").trim();
  if (deptVal) {
    req.input("a_dept", sql.NVarChar(500), "%" + deptVal + "%");
    whereParts.push("CAST([" + dims.dept + "] AS NVARCHAR(500)) LIKE @a_dept");
  }

  // Category filter
  var catVal = String((q && q.category) ? q.category : "").trim();
  if (catVal) {
    req.input("a_cat", sql.NVarChar(500), "%" + catVal + "%");
    whereParts.push("CAST([" + dims.cat + "] AS NVARCHAR(500)) LIKE @a_cat");
  }

  // Cross-filter (drill from chart click)
  var cfParts = appendCrossFilterParts(req, crossFilter, [dims.branch, dims.dept, dims.cat]);
  var allWhere = whereParts.concat(cfParts);
  var whereSql = allWhere.length ? " WHERE " + allWhere.join(" AND ") : "";

  return { req: req, whereSql: whereSql, table: table, dateCol: dateCol, dims: dims };
}

module.exports = {
  salesDimColumns: salesDimColumns,
  appendCrossFilterParts: appendCrossFilterParts,
  buildFilterContext: buildFilterContext,
};
