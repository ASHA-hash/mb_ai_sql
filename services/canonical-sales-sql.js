/**
 * Canonical sales fact for text-to-SQL (28 Power BI views).
 * Default: dbo.VW_MB_POWERBI_APP_REPORT — XnDt, MrpValue, BranchAlias, SupplierName, …
 */
"use strict";

const { resolveAnalyticsColumns, DEFAULT_ANALYTICS_TABLE } = require("./analytics-column-map");
const { getViewColumns } = require("./schema-from-json");
const { translateJargonToColumn, getForcedDatePredicate, loadSemanticConfig } = require("./metadata-translation-engine");

function normalizeTable(t) {
  const s = String(t || "").trim();
  if (!s) return DEFAULT_ANALYTICS_TABLE;
  return s.startsWith("dbo.") ? s : `dbo.${s}`;
}

function getCanonicalSalesTable() {
  const layer = loadSemanticConfig();
  const raw =
    process.env.SALES_AI_TABLE ||
    layer.target_view ||
    process.env.ANALYTICS_BASE_TABLE ||
    process.env.SALES_VIEW ||
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

  s = s.replace(/\bdbo\.VwAISalesData\b/gi, c.table);
  s = s.replace(/\bdbo\.VwAISalesPerson\b/gi, c.table);
  s = s.replace(/\b(?:INNER|LEFT)\s+JOIN\s+dbo\.VwAIBranch\b[^;]*/gi, "");
  s = s.replace(/\bVwAISalesData\b/gi, c.tableShort);

  if (isPowerBi) {
    s = s.replace(/\bSaleNetAmount\b/gi, translateJargonToColumn("SaleNetAmount") || c.amountCol);
    s = s.replace(/\bInvoiceDt\b/gi, c.dateCol);
    s = s.replace(/\bInvoiceNo\b/gi, c.invoiceCol);
    s = s.replace(/\bInvoiceId\b/gi, c.invoiceCol);
    s = s.replace(/\bCustomerId\b/gi, c.customerCol);
    s = s.replace(/\bQuantity\b/gi, c.qtyCol);
    s = s.replace(/\bSalesPersonName\b/gi, c.staffDimCol);
    s = s.replace(/\bSalesPersonShortName\b/gi, c.staffDimCol);
    s = s.replace(/\bBranchShortName\b/gi, c.branchCol);
    s = s.replace(/\bBranchName\b/gi, c.branchCol);
  }

  return s.replace(/\s{2,}/g, " ").trim();
}

function isSalesDomainQuestion(question) {
  return /\b(sale|sales|invoice|revenue|turnover|mtd|ytd|qtd|salesperson|sales\s*rep|staff|branch\s*performance)\b/i.test(
    String(question || "")
  );
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
  translateJargonToColumn,
  getForcedDatePredicate,
};
