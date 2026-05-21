/**
 * Canonical zRetailHQ0 / Power BI column roles for analytics SQL.
 * Resolves env overrides first, then metadata column presence — no generic ERP fallbacks
 * when the target view exposes canonical names (XnDt, MrpValue, AppQty, …).
 */
"use strict";

const { sanitizeColumnName } = require("../filter-query");
const { getViewColumns } = require("./schema-from-json");
const runtimeConfig = require("./runtime-config");

/** Preferred physical column per role (first match on view wins). */
const ROLE_COLUMN_CANDIDATES = {
  amount: ["MrpValue", "NetSlsNetAmount", "NetAmount", "SaleNetAmount", "SalesNetAmount", "SaleAmountBeforeTax"],
  qty: ["AppQty", "NetSlsQty", "SlsQty", "Quantity", "SalesQuantity"],
  invoice: ["XnNo", "InvoiceNo", "InvoiceId", "BillCount"],
  customer: ["XnId", "CustomerId", "UserKey"],
  branch: ["BranchAlias", "BranchName", "BranchShortName"],
  dept: ["DepartmentShortName", "DepartmentName", "Department", "InvDepartmentName"],
  cat: ["CategoryShortName", "CategoryName", "Category", "InvCategoryName"],
  date: ["XnDt", "InvoiceDt", "CashmemoDt", "XnMemoDate", "SaleDate"],
  trendMonth: ["XnDtMonth"],
};

const ENV_ROLE_KEYS = {
  amount: "SALES_ANALYTICS_AMOUNT_COLUMN",
  qty: "SALES_ANALYTICS_QTY_COLUMN",
  invoice: "SALES_ANALYTICS_INVOICE_COLUMN",
  customer: "SALES_ANALYTICS_CUSTOMER_COLUMN",
  branch: "SALES_ANALYTICS_BRANCH_DIM",
  dept: "SALES_ANALYTICS_DEPARTMENT_DIM",
  cat: "SALES_ANALYTICS_CATEGORY_DIM",
};

const DEFAULT_ANALYTICS_TABLE = "dbo.VW_MB_POWERBI_SLS_REPORT";

function normalizeTableKey(table) {
  const t = String(table || "").trim();
  if (!t) return "";
  return t.startsWith("dbo.") ? t : `dbo.${t}`;
}

function pickFromView(viewCols, candidates) {
  const set = new Set(viewCols);
  for (const name of candidates) {
    if (set.has(name)) return name;
  }
  return null;
}

function envColumn(role) {
  const key = ENV_ROLE_KEYS[role];
  if (!key) return null;
  return sanitizeColumnName(runtimeConfig.get(key) || "");
}

/**
 * @param {string} effectiveTable - e.g. dbo.VW_MB_POWERBI_APP_REPORT
 * @param {string} [datasetKey]
 * @returns {{ amount, branch, dept, cat, qty, invoice, customer, date, trendMonth }}
 */
function resolveAnalyticsColumns(effectiveTable, datasetKey) {
  const table = normalizeTableKey(effectiveTable);
  const viewCols = table ? getViewColumns(table) : [];

  const resolved = {};
  for (const role of Object.keys(ROLE_COLUMN_CANDIDATES)) {
    const fromEnv = envColumn(role);
    if (fromEnv && (!viewCols.length || viewCols.includes(fromEnv))) {
      resolved[role] = fromEnv;
      continue;
    }
    resolved[role] = pickFromView(viewCols, ROLE_COLUMN_CANDIDATES[role]);
  }

  /* Last resort only when metadata snapshot missing (dev / tests). */
  if (!resolved.amount) resolved.amount = sanitizeColumnName(runtimeConfig.get("SALES_ANALYTICS_AMOUNT_COLUMN") || "MrpValue");
  if (!resolved.qty) resolved.qty = sanitizeColumnName(runtimeConfig.get("SALES_ANALYTICS_QTY_COLUMN") || "AppQty");
  if (!resolved.invoice) resolved.invoice = sanitizeColumnName(runtimeConfig.get("SALES_ANALYTICS_INVOICE_COLUMN") || "XnNo");
  if (!resolved.customer) resolved.customer = sanitizeColumnName(runtimeConfig.get("SALES_ANALYTICS_CUSTOMER_COLUMN") || "XnId");
  if (!resolved.branch) resolved.branch = sanitizeColumnName(runtimeConfig.get("SALES_ANALYTICS_BRANCH_DIM") || "BranchAlias");
  if (!resolved.dept) resolved.dept = sanitizeColumnName(runtimeConfig.get("SALES_ANALYTICS_DEPARTMENT_DIM") || "DepartmentShortName");
  if (!resolved.cat) resolved.cat = sanitizeColumnName(runtimeConfig.get("SALES_ANALYTICS_CATEGORY_DIM") || "CategoryShortName");
  if (!resolved.date) resolved.date = sanitizeColumnName(runtimeConfig.get("SALES_FILTER_DATE_COLUMN") || "XnDt");

  return {
    amount: resolved.amount || "MrpValue",
    branch: resolved.branch || "BranchAlias",
    dept: resolved.dept || "DepartmentShortName",
    cat: resolved.cat || "CategoryShortName",
    qty: resolved.qty || "AppQty",
    invoice: resolved.invoice || "XnNo",
    customer: resolved.customer || "XnId",
    date: resolved.date || "XnDt",
    trendMonth: resolved.trendMonth || null,
  };
}

/**
 * Trend SELECT for dashboard line charts (day grain on XnDt, month on XnDtMonth when present).
 */
function buildTrendSql(opts) {
  const {
    table,
    trendMode,
    dateCol,
    dims,
    trendWhereSql,
    rowCntAgg,
    nl = "",
    qh = "",
  } = opts;

  if (trendMode === "day") {
    return `
      SELECT
        CONVERT(varchar(10), CAST([${dateCol}] AS DATE), 23) AS period_label,
        CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
        ${rowCntAgg} AS txn_count
      FROM ${table}${nl}${trendWhereSql}
      GROUP BY CAST([${dateCol}] AS DATE)
      ORDER BY period_label${qh}`;
  }

  if (dims.trendMonth) {
    /* ISO yyyy-mm labels for charts (XnDtMonth may be "April 2026" text). */
    return `
      SELECT
        CONCAT(YEAR(CAST([${dateCol}] AS DATE)), '-', RIGHT('0' + CAST(MONTH(CAST([${dateCol}] AS DATE)) AS varchar(2)), 2)) AS period_label,
        CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
        ${rowCntAgg} AS txn_count
      FROM ${table}${nl}${trendWhereSql}
      GROUP BY YEAR(CAST([${dateCol}] AS DATE)), MONTH(CAST([${dateCol}] AS DATE))
      ORDER BY YEAR(CAST([${dateCol}] AS DATE)), MONTH(CAST([${dateCol}] AS DATE))${qh}`;
  }

  return `
      SELECT
        CONCAT(YEAR(CAST([${dateCol}] AS DATE)), '-', RIGHT('0' + CAST(MONTH(CAST([${dateCol}] AS DATE)) AS varchar(2)), 2)) AS period_label,
        CAST(SUM(ISNULL([${dims.amount}], 0)) AS DECIMAL(38, 4)) AS metric_value,
        ${rowCntAgg} AS txn_count
      FROM ${table}${nl}${trendWhereSql}
      GROUP BY YEAR(CAST([${dateCol}] AS DATE)), MONTH(CAST([${dateCol}] AS DATE))
      ORDER BY YEAR(CAST([${dateCol}] AS DATE)), MONTH(CAST([${dateCol}] AS DATE))${qh}`;
}

module.exports = {
  DEFAULT_ANALYTICS_TABLE,
  ROLE_COLUMN_CANDIDATES,
  resolveAnalyticsColumns,
  buildTrendSql,
};
