/**
 * Canonical sales fact for text-to-SQL (28 Power BI views).
 * Default: dbo.VW_MB_POWERBI_APP_REPORT — XnDt, MrpValue, BranchAlias, SupplierName, …
 */
"use strict";

const { resolveAnalyticsColumns, DEFAULT_ANALYTICS_TABLE } = require("./analytics-column-map");
const { getViewColumns } = require("./schema-from-json");
const { translateJargonToColumn, getForcedDatePredicate, loadSemanticConfig } = require("./metadata-translation-engine");
const { buildBillsTodaySqlAlignedWithHome } = require("./home-kpi-sql");
const runtimeConfig = require("./runtime-config");

function normalizeTable(t) {
  const s = String(t || "").trim();
  if (!s) return DEFAULT_ANALYTICS_TABLE;
  return s.startsWith("dbo.") ? s : `dbo.${s}`;
}

function getCanonicalSalesTable() {
  const layer = loadSemanticConfig();
  // Home dashboard + NLQ use ANALYTICS_BASE_TABLE (SLSXNS). SALES_AI_TABLE is legacy APP_REPORT.
  const raw =
    runtimeConfig.get("ANALYTICS_BASE_TABLE") ||
    runtimeConfig.get("SALES_AI_TABLE") ||
    layer.target_view ||
    runtimeConfig.get("SALES_VIEW") ||
    DEFAULT_ANALYTICS_TABLE;
  return normalizeTable(raw);
}

function getCanonicalSalesContext() {
  const table = getCanonicalSalesTable();
  const cols = resolveAnalyticsColumns(table);
  return {
    table,
    tableShort: table.replace(/^dbo\./i, ""),
    dateCol: cols.date,
    amountCol: cols.amount,
    qtyCol: cols.qty,
    branchCol: cols.branch,
    deptCol: cols.dept,
    catCol: cols.cat,
    invoiceCol: cols.invoice,
    customerCol: cols.customer,
    staffDimCol: resolveStaffDimensionColumn(table),
  };
}

function resolveStaffDimensionColumn(table) {
  const viewCols = getViewColumns(normalizeTable(table));
  const set = new Set(viewCols);
  if (set.has("SupplierName")) return "SupplierName";
  if (set.has("SupplierAlias")) return "SupplierAlias";
  if (set.has("BranchAlias")) return "BranchAlias";
  return "SupplierName";
}

function colRef(dateCol, alias) {
  return alias ? `${alias}.[${dateCol}]` : `[${dateCol}]`;
}

function buildMtdWhereClause(dateCol, alias) {
  const forced = getForcedDatePredicate("mtd", { qualify: false });
  if (forced && !alias && dateCol === "XnDt") return forced;
  const d = colRef(dateCol, alias);
  return `CAST(${d} AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST(${d} AS date) <= CAST(GETDATE() AS date)`;
}

function buildThisMonthWhereClause(dateCol, alias) {
  return buildMtdWhereClause(dateCol, alias);
}

function buildAiSalesFactPromptBlock() {
  const c = getCanonicalSalesContext();
  const mtd = buildMtdWhereClause(c.dateCol);
  return [
    "[CANONICAL SALES FACT — MANDATORY FOR SALES / REVENUE / MTD / YTD / SALESPERSON]",
    `- Use ONLY ${c.table} WITH (NOLOCK).`,
    "- Do NOT use dbo.VwAISalesData, dbo.VwAISalesPerson, or dbo.VwAIBranch — not allowlisted.",
    `- Revenue (incl. "SaleNetAmount", "net sales"): SUM([${c.amountCol}]) AS TotalSales.`,
    `- Date column: [${c.dateCol}]. MTD: ${mtd}.`,
    `- Branch: [${c.branchCol}] (text label — no branch master join).`,
    `- Department / category: [${c.deptCol}], [${c.catCol}].`,
    `- Salesperson / staff / rep: no SalesPerson column — GROUP BY [${c.staffDimCol}] AS StaffName.`,
    `- Bills / transactions: COUNT(DISTINCT [${c.invoiceCol}]).`,
    `- Units: SUM([${c.qtyCol}]).`,
  ].join("\n");
}

/** Rewrite legacy training-data SQL to allowlisted view + columns before validation. */
function remapLegacyColumnNames(sql) {
  let s = String(sql || "");
  if (!s.trim()) return s;

  const c = getCanonicalSalesContext();
  const isPowerBi = /POWERBI|VW_MB/i.test(c.table);

  // CRITICAL: Do NOT remap columns when SQL already targets the salesperson view.
  // SLS_DATA_WITHOUT_ITEMID uses SalesPersonName, SalesQuantity, SalesNetAmount, CashmemoDt
  // — these are correct on that view; remapping them to APP_REPORT columns causes SQL Error 207.
  const isSalespersonView = /SLS_DATA_WITHOUT_ITEMID/i.test(s);

  s = s.replace(/\bdbo\.VwAISalesData\b/gi, c.table);
  s = s.replace(/\bdbo\.VwAISalesPerson\b/gi, c.table);
  s = s.replace(/\b(?:INNER|LEFT)\s+JOIN\s+dbo\.VwAIBranch\b[^;]*/gi, "");
  s = s.replace(/\bVwAISalesData\b/gi, c.tableShort);

  if (isPowerBi && !isSalespersonView) {
    // Only remap legacy column aliases when targeting APP_REPORT-family views.
    s = s.replace(/\bSaleNetAmount\b/gi, translateJargonToColumn("SaleNetAmount") || c.amountCol);
    s = s.replace(/\bSalesNetAmount\b/gi, c.amountCol);
    s = s.replace(/\bNetSalesAmount\b/gi, c.amountCol);
    s = s.replace(/\bInvoiceDt\b/gi, c.dateCol);
    s = s.replace(/\bCashmemoDt\b/gi, c.dateCol);
    s = s.replace(/\bSaleDate\b/gi, c.dateCol);
    s = s.replace(/\bInvoiceNo\b/gi, c.invoiceCol);
    s = s.replace(/\bInvoiceId\b/gi, c.invoiceCol);
    s = s.replace(/\bCustomerId\b/gi, c.customerCol);
    s = s.replace(/\bQuantity\b/gi, c.qtyCol);
    s = s.replace(/\bSalesQuantity\b/gi, c.qtyCol);
    s = s.replace(/\bSalesPersonName\b/gi, c.staffDimCol);
    s = s.replace(/\bSalesPersonShortName\b/gi, c.staffDimCol);
    s = s.replace(/\bBranchShortName\b/gi, c.branchCol);
    s = s.replace(/\bBranchName\b/gi, c.branchCol);
    // Fix wrong spellings of Color and Size that LLM sometimes generates
    s = s.replace(/\bColou?r\b/g, "Color");   // Colour → Color
    s = s.replace(/\bSizeName\b/gi, "Size");   // SizeName → Size
    s = s.replace(/\bEAN\b/g, "ArticleNo");    // EAN does not exist → ArticleNo
  } else if (isPowerBi) {
    // Still fix cosmetic issues on any PowerBI view (safe on all views)
    s = s.replace(/\bColou?r\b/g, "Color");
    s = s.replace(/\bSizeName\b/gi, "Size");
    s = s.replace(/\bEAN\b/g, "ArticleNo");
  }

  return s.replace(/\s{2,}/g, " ").trim();
}

function isSalesDomainQuestion(question) {
  return /\b(sale|sales|invoice|revenue|turnover|mtd|ytd|qtd|salesperson|sales\s*rep|staff|branch\s*performance)\b/i.test(
    String(question || "")
  );
}

/** Footfall / bill-count KPIs — SLSXNS (SUM BillCount) or SLS_BILLCOUNT, not APP_REPORT XnNo. */
function getBillsKpiTable() {
  const raw =
    process.env.BILLS_KPI_VIEW ||
    process.env.BILLS_TODAY_VIEW ||
    "dbo.VW_MB_POWERBI_SLSXNS_REPORT";
  return normalizeTable(raw);
}

/**
 * Today's bill / invoice count (scalar KPI).
 * APP_REPORT often has NULL XnNo on today's lines — use transaction rollup view instead.
 */
function buildBillsTodaySql() {
  const homeSql = buildBillsTodaySqlAlignedWithHome();
  if (homeSql) return homeSql;

  const table = getBillsKpiTable();
  const cols = resolveAnalyticsColumns(table);
  const dateCol = cols.date || "XnDt";
  const todayWhere = `CAST([${dateCol}] AS date) = CAST(GETDATE() AS date)`;
  const viewCols = getViewColumns(table);
  const set = new Set(viewCols);

  if (/SLS_BILLCOUNT/i.test(table) && set.has("BillCount")) {
    return `SELECT CAST(SUM(ISNULL([BillCount], 0)) AS BIGINT) AS BillCount FROM ${table} WITH (NOLOCK) WHERE ${todayWhere}`;
  }

  if (set.has("BillCount") && /SLSXNS/i.test(table)) {
    return `SELECT CAST(SUM(ISNULL([BillCount], 0)) AS BIGINT) AS BillCount FROM ${table} WITH (NOLOCK) WHERE ${todayWhere}`;
  }

  const c = getCanonicalSalesContext();
  const inv = c.invoiceCol || "XnNo";
  if (set.has(inv)) {
    return `SELECT COUNT(DISTINCT [${inv}]) AS BillCount FROM ${table} WITH (NOLOCK) WHERE ${todayWhere} AND [${inv}] IS NOT NULL`;
  }

  if (set.has("BillCount")) {
    return `SELECT CAST(SUM(ISNULL([BillCount], 0)) AS BIGINT) AS BillCount FROM ${table} WITH (NOLOCK) WHERE ${todayWhere}`;
  }

  return `SELECT COUNT(DISTINCT [${inv}]) AS BillCount FROM ${c.table} WITH (NOLOCK) WHERE CAST([${c.dateCol}] AS date) = CAST(GETDATE() AS date) AND [${inv}] IS NOT NULL`;
}

module.exports = {
  getCanonicalSalesTable,
  getCanonicalSalesContext,
  resolveStaffDimensionColumn,
  buildMtdWhereClause,
  buildThisMonthWhereClause,
  buildAiSalesFactPromptBlock,
  remapLegacyColumnNames,
  isSalesDomainQuestion,
  getBillsKpiTable,
  buildBillsTodaySql,
  translateJargonToColumn,
  getForcedDatePredicate,
};
