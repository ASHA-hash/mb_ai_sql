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

/** Views that may be missing on a given SQL Server tenant — try in order, skip blocked. */
const SALES_FACT_VIEW_ALIASES = [
  "dbo.VW_MB_POWERBI_SLS_REPORT",
  "dbo.VW_MB_POWERBI_SLSXNS_REPORT",
  "dbo.VW_MB_POWERBI_APP_REPORT",
];

const _blockedSalesViews = new Set();

function normalizeTable(t) {
  const s = String(t || "").trim();
  if (!s) return DEFAULT_ANALYTICS_TABLE;
  return s.startsWith("dbo.") ? s : `dbo.${s}`;
}

function getSalesFactTableCandidates() {
  const layer = loadSemanticConfig();
  const raw = [
    runtimeConfig.get("ANALYTICS_BASE_TABLE"),
    ...SALES_FACT_VIEW_ALIASES,
    runtimeConfig.get("SALES_AI_TABLE"),
    layer.target_view,
    runtimeConfig.get("SALES_VIEW"),
    DEFAULT_ANALYTICS_TABLE,
  ];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const t = normalizeTable(item);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function markSalesFactTableUnavailable(table) {
  const key = normalizeTable(table).toLowerCase();
  if (!key) return;
  _blockedSalesViews.add(key);
  console.warn("[canonical-sales] marking view unavailable:", table);
}

function getCanonicalSalesTable() {
  for (const t of getSalesFactTableCandidates()) {
    if (!_blockedSalesViews.has(t.toLowerCase())) return t;
  }
  return normalizeTable(DEFAULT_ANALYTICS_TABLE);
}

/** After "Invalid object name", swap to the next working sales fact view. */
function rewriteSqlToAvailableSalesFact(sql) {
  const target = getCanonicalSalesTable();
  let s = String(sql || "");
  if (!s.trim()) return s;
  for (const v of getSalesFactTableCandidates()) {
    if (v.toLowerCase() === target.toLowerCase()) continue;
    const esc = v.replace(/\./g, "\\.");
    s = s.replace(new RegExp(esc, "gi"), target);
  }
  return remapLegacyColumnNames(s);
}

function pickMrpAmountColumn(table) {
  const viewCols = getViewColumns(normalizeTable(table));
  const set = new Set(viewCols);
  if (set.has("MrpValue")) return "MrpValue";
  if (set.has("NetSlsMrpValue")) return "NetSlsMrpValue";
  if (set.has("NetAmount")) return "NetAmount";
  if (set.has("NetSlsNetAmount")) return "NetSlsNetAmount";
  return resolveAnalyticsColumns(table).amountCol;
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

  // APP_REPORT is not deployed on all tenants — route legacy/RAG SQL to ANALYTICS_BASE_TABLE.
  if (!/APP_REPORT/i.test(c.table) && !isSalespersonView) {
    s = s.replace(/\bdbo\.VW_MB_POWERBI_APP_REPORT\b/gi, c.table);
    s = s.replace(/\bVW_MB_POWERBI_APP_REPORT\b/gi, c.tableShort);
    if (!/SLSXNS/i.test(c.table)) {
      s = s.replace(/\bdbo\.VW_MB_POWERBI_SLSXNS_REPORT\b/gi, c.table);
      s = s.replace(/\bVW_MB_POWERBI_SLSXNS_REPORT\b/gi, c.tableShort);
    }
    if (/SLSXNS/i.test(c.table)) {
      s = s.replace(/\b\[MrpValue\]/gi, `[${c.amountCol}]`);
      s = s.replace(/\bMrpValue\b/gi, c.amountCol);
      s = s.replace(/\b\[AppQty\]/gi, `[${c.qtyCol}]`);
      s = s.replace(/\bAppQty\b/gi, c.qtyCol);
    }
  }

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

/** "Last 30 days gross revenue by day", "daily sales trend", etc. */
function isDailyRevenueTrendQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!/\b(revenue|sales|turnover|gross)\b/.test(q)) return false;
  return (
    /\b(by\s+day|daily|per\s+day|each\s+day|day\s*wise|day-wise)\b/.test(q) ||
    /\blast\s+(\d+)\s*days?\b/.test(q) ||
    /\b(\d+)\s*days?\b/.test(q) && /\b(trend|over time)\b/.test(q)
  );
}

function parseTrendDaySpan(question, fallback = 30) {
  const m = String(question || "").match(/\blast\s+(\d+)\s*days?\b/i);
  if (m) return Math.min(Math.max(parseInt(m[1], 10) || fallback, 1), 366);
  const m2 = String(question || "").match(/\b(\d+)\s*days?\b/i);
  if (m2 && /\b(trend|revenue|sales)\b/i.test(question)) {
    return Math.min(Math.max(parseInt(m2[1], 10) || fallback, 1), 366);
  }
  return fallback;
}

/** Top suppliers/brands by MrpValue on the sales fact (not purchase inward). */
function isTopVendorsByMrpValueQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!/\b(vendors?|suppliers?)\b/.test(q)) return false;
  if (!/\b(top|highest|best|leading|rank)\b/.test(q)) return false;
  if (/\b(purchase|procurement|inward|grn|buying)\b/.test(q) && !/\bMrpValue\b/i.test(question)) {
    return false;
  }
  return /\bMrpValue\b/i.test(question) || /\b(revenue|sales|turnover)\b/.test(q);
}

function buildTopVendorsByMrpValueSql(question) {
  const c = getCanonicalSalesContext();
  const amountCol = pickMrpAmountColumn(c.table);
  const vendorCol = resolveStaffDimensionColumn(c.table);
  const nMatch = String(question || "").match(/\btop\s*(\d+)\b/i);
  const topN = Math.min(Math.max(parseInt(nMatch ? nMatch[1] : 10, 10) || 10, 1), 100);
  const mtd = buildMtdWhereClause(c.dateCol);
  return (
    `SELECT TOP (${topN}) [${vendorCol}] AS Vendor, ` +
    `SUM(ISNULL([${amountCol}], 0)) AS TotalMrpValue ` +
    `FROM ${c.table} WITH (NOLOCK) ` +
    `WHERE ${mtd} ` +
    `GROUP BY [${vendorCol}] ` +
    `HAVING SUM(ISNULL([${amountCol}], 0)) > 0 ` +
    `ORDER BY TotalMrpValue DESC`
  );
}

function buildDailyRevenueTrendSql(question) {
  const c = getCanonicalSalesContext();
  const days = parseTrendDaySpan(question, 30);
  const viewCols = getViewColumns(c.table);
  const set = new Set(viewCols);
  const billExpr = set.has("BillCount")
    ? `CAST(SUM(ISNULL([BillCount], 0)) AS BIGINT)`
    : `COUNT(DISTINCT [${c.invoiceCol}])`;
  return (
    `SELECT CAST([${c.dateCol}] AS date) AS SaleDate, ` +
    `SUM(ISNULL([${c.amountCol}], 0)) AS TotalSales, ` +
    `SUM(ISNULL([${c.qtyCol}], 0)) AS TotalQty, ` +
    `${billExpr} AS BillCount ` +
    `FROM ${c.table} WITH (NOLOCK) ` +
    `WHERE CAST([${c.dateCol}] AS date) >= DATEADD(day, -${days - 1}, CAST(GETDATE() AS date)) ` +
    `AND CAST([${c.dateCol}] AS date) <= CAST(GETDATE() AS date) ` +
    `GROUP BY CAST([${c.dateCol}] AS date) ` +
    `ORDER BY SaleDate`
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
  getSalesFactTableCandidates,
  markSalesFactTableUnavailable,
  rewriteSqlToAvailableSalesFact,
  getCanonicalSalesContext,
  resolveStaffDimensionColumn,
  buildMtdWhereClause,
  buildThisMonthWhereClause,
  buildAiSalesFactPromptBlock,
  remapLegacyColumnNames,
  isSalesDomainQuestion,
  isDailyRevenueTrendQuestion,
  buildDailyRevenueTrendSql,
  isTopVendorsByMrpValueQuestion,
  buildTopVendorsByMrpValueSql,
  getBillsKpiTable,
  buildBillsTodaySql,
  translateJargonToColumn,
  getForcedDatePredicate,
};
