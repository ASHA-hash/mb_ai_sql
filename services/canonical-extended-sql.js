/**
 * canonical-extended-sql.js
 *
 * Extended deterministic SQL builders for high-frequency retail queries.
 * Each builder uses the correct view + columns so zero LLM calls are needed.
 *
 * Patterns covered:
 *   - Top articles by quantity (MTD/today/period)
 *   - Zero-stock / low-stock articles
 *   - Customers with birthdays this month
 *   - Top customer spenders (MTD/period)
 *   - Department / category breakdown (MTD)
 *   - YTD branch ranking
 *   - Stock value by branch/category
 *   - Inter-branch transfers summary
 */
"use strict";

const { getCanonicalSalesContext } = require("./canonical-sales-sql");

/* ── helpers ──────────────────────────────────────────────────────────────── */
function parseTopN(question, def = 10) {
  const m = String(question || "").match(/\btop\s*(\d+)\b/i);
  return Math.min(Math.max(parseInt(m ? m[1] : def, 10) || def, 1), 100);
}

function mtdWhere(dateCol) {
  return `CAST([${dateCol}] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST([${dateCol}] AS date) <= CAST(GETDATE() AS date)`;
}

function ytdWhere(dateCol) {
  return `CAST([${dateCol}] AS date) >= DATEFROMPARTS(CASE WHEN MONTH(GETDATE())>=4 THEN YEAR(GETDATE()) ELSE YEAR(GETDATE())-1 END, 4, 1) AND CAST([${dateCol}] AS date) <= CAST(GETDATE() AS date)`;
}

function nl(table) {
  return String(process.env.ANALYTICS_NOLOCK || "1").trim() === "1"
    ? ` ${table} WITH (NOLOCK)`
    : ` ${table}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. TOP ARTICLES BY QUANTITY / SALES
   ═══════════════════════════════════════════════════════════════════════════ */
function isTopArticleQuestion(question) {
  const q = String(question || "").toLowerCase();
  const hasArticle = /\b(article|articles|sku|skus|product|products|style|item|items)\b/.test(q);
  const hasRank = /\b(top|best|leading|highest|most)\b/.test(q);
  const hasMetric =
    /\b(qty|quantity|units?|pieces|pcs|sold|selling|revenue|sales)\b/.test(q) ||
    /\bsold\b/.test(q);
  const isPurchase = /\b(purchase|procurement|inward|grn)\b/.test(q);
  return hasArticle && hasRank && hasMetric && !isPurchase;
}

function buildTopArticleSql(question) {
  const c = getCanonicalSalesContext();
  const n = parseTopN(question, 10);
  const byUnits = /\b(qty|quantity|units?|pieces|pcs)\b/i.test(question);
  const byYtd = /\b(ytd|year to date|this year|financial year)\b/i.test(question);
  const byMtd = !byYtd;
  const dateWhere = byYtd ? ytdWhere(c.dateCol) : mtdWhere(c.dateCol);
  const orderCol = byUnits ? "TotalQty" : "TotalSales";
  return [
    `SELECT TOP (${n})`,
    `  [ArticleNo] AS Article,`,
    `  MAX([SupplierName]) AS Supplier,`,
    `  MAX([CategoryShortName]) AS Category,`,
    `  SUM(ISNULL([${c.qtyCol}], 0)) AS TotalQty,`,
    `  CAST(SUM(ISNULL([${c.amountCol}], 0)) AS DECIMAL(38,2)) AS TotalSales`,
    `FROM${nl(c.table)}`,
    `WHERE ${dateWhere}`,
    `  AND NULLIF(LTRIM(RTRIM([ArticleNo])), '') IS NOT NULL`,
    `GROUP BY [ArticleNo]`,
    `HAVING SUM(ISNULL([${byUnits ? c.qtyCol : c.amountCol}], 0)) > 0`,
    `ORDER BY ${orderCol} DESC`,
  ].join("\n");
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. ZERO-STOCK / LOW-STOCK ARTICLES
   ═══════════════════════════════════════════════════════════════════════════ */
function isZeroStockQuestion(question) {
  const q = String(question || "").toLowerCase();
  return (
    (/\b(zero|nil|no|out of|empty|depleted)\b/.test(q) &&
      /\b(stock|inventory|items?|articles?)\b/.test(q)) ||
    /\b(out of stock|oos|stock ?out)\b/.test(q) ||
    (/\b(low|below|minimum|min)\b/.test(q) && /\b(stock|inventory)\b/.test(q))
  );
}

function buildZeroStockSql(question) {
  const q = String(question || "").toLowerCase();
  const branchMatch = q.match(/\b(branch|store|outlet)\b.*?['""]([^'"")]+)['""]|at\s+([A-Z0-9\-]+)\b/i);
  const lowThresh = q.match(/\bbelow\s+(\d+)\b/i) || q.match(/\bless than\s+(\d+)\b/i);
  const threshold = lowThresh ? parseInt(lowThresh[1], 10) : 0;
  const stockTable = "dbo.VW_MB_POWERBI_STOCK_REPORT";
  const branchFilter = branchMatch
    ? `  AND LOWER([BranchAlias]) LIKE N'%${branchMatch[2] || branchMatch[3] || ""}%'\n`
    : "";
  const operator = threshold > 0 ? `<= ${threshold}` : `= 0`;
  return [
    `SELECT TOP (500)`,
    `  [BranchAlias] AS Branch,`,
    `  [ArticleNo] AS Article,`,
    `  MAX([CategoryShortName]) AS Category,`,
    `  MAX([SupplierName]) AS Supplier,`,
    `  MAX([ItemMRP]) AS MRP,`,
    `  SUM(ISNULL([StockQty], 0)) AS StockQty`,
    `FROM${nl(stockTable)}`,
    `WHERE 1=1`,
    branchFilter ? branchFilter.trim() : null,
    `GROUP BY [BranchAlias], [ArticleNo]`,
    `HAVING SUM(ISNULL([StockQty], 0)) ${operator}`,
    `ORDER BY Branch, Article`,
  ]
    .filter(Boolean)
    .join("\n");
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. BIRTHDAY CUSTOMERS THIS MONTH
   ═══════════════════════════════════════════════════════════════════════════ */
function isBirthdayCustomerQuestion(question) {
  const q = String(question || "").toLowerCase();
  return (
    /\b(birthday|born|bday)\b/.test(q) &&
    /\b(customer|customers|members?|client)\b/.test(q)
  );
}

function buildBirthdayCustomerSql(question) {
  const q = String(question || "").toLowerCase();
  const isToday = /\btoday\b/.test(q);
  const isNext = /\bnext\b/.test(q);
  const n = parseTopN(question, 200);
  const custTable = "dbo.VwAICustomerDetails";

  let dateFilter;
  if (isToday) {
    dateFilter = "MONTH([BirthdayDt]) = MONTH(GETDATE()) AND DAY([BirthdayDt]) = DAY(GETDATE())";
  } else if (isNext) {
    dateFilter =
      "MONTH([BirthdayDt]) = MONTH(DATEADD(month, 1, GETDATE()))";
  } else {
    dateFilter = "MONTH([BirthdayDt]) = MONTH(GETDATE())";
  }

  return [
    `SELECT TOP (${n})`,
    `  LTRIM(RTRIM(ISNULL([CustomerFirstName],'')+' '+ISNULL([CustomerLastName],''))) AS CustomerName,`,
    `  [ContactMobile] AS Mobile,`,
    `  [BranchName] AS HomeBranch,`,
    `  [CustomerGroupName] AS LoyaltyGroup,`,
    `  MONTH([BirthdayDt]) AS BirthdayMonth,`,
    `  DAY([BirthdayDt]) AS BirthdayDay`,
    `FROM${nl(custTable)}`,
    `WHERE ${dateFilter}`,
    `  AND [BirthdayDt] IS NOT NULL`,
    `  AND [ActiveStatus] = 1`,
    `ORDER BY DAY([BirthdayDt])`,
  ].join("\n");
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. TOP CUSTOMER SPENDERS
   ═══════════════════════════════════════════════════════════════════════════ */
function isTopCustomerSpenderQuestion(question) {
  const q = String(question || "").toLowerCase();
  const hasCust =
    /\b(customers?|clients?|members?|buyers?|shoppers?)\b/.test(q) ||
    /\bwho (spent|bought|purchased|shopped)\b/.test(q);
  const hasRank = /\b(top|highest|best|most|biggest|largest|heavy)\b/.test(q);
  const hasMetric =
    /\b(spent|spend|spending|purchase|bought|sales|revenue|amount|value)\b/.test(q);
  return hasCust && hasRank && hasMetric;
}

function buildTopCustomerSpenderSql(question) {
  const q = String(question || "").toLowerCase();
  const n = parseTopN(question, 10);
  const byYtd = /\b(ytd|year to date|this year)\b/i.test(q);
  const aiTable = "dbo.VwAISalesData";
  const custTable = "dbo.VwAICustomerDetails";
  const dateCol = "InvoiceDt";
  const dateWhere = byYtd
    ? `CAST(s.[${dateCol}] AS date) >= DATEFROMPARTS(CASE WHEN MONTH(GETDATE())>=4 THEN YEAR(GETDATE()) ELSE YEAR(GETDATE())-1 END, 4, 1) AND CAST(s.[${dateCol}] AS date) <= CAST(GETDATE() AS date)`
    : `CAST(s.[${dateCol}] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST(s.[${dateCol}] AS date) <= CAST(GETDATE() AS date)`;
  return [
    `SELECT TOP (${n})`,
    `  LTRIM(RTRIM(ISNULL(c.[CustomerFirstName],'')+' '+ISNULL(c.[CustomerLastName],''))) AS CustomerName,`,
    `  c.[ContactMobile] AS Mobile,`,
    `  c.[CustomerGroupName] AS LoyaltyGroup,`,
    `  COUNT(DISTINCT s.[InvoiceNo]) AS Bills,`,
    `  CAST(SUM(ISNULL(s.[SaleNetAmount], 0)) AS DECIMAL(38,2)) AS TotalSpend`,
    `FROM${nl(aiTable)} s`,
    `JOIN dbo.VwAICustomerDetails c ON s.[CustomerId] = c.[CustomerId]`,
    `WHERE ${dateWhere}`,
    `  AND s.[CustomerId] IS NOT NULL`,
    `GROUP BY s.[CustomerId], c.[CustomerFirstName], c.[CustomerLastName], c.[ContactMobile], c.[CustomerGroupName]`,
    `HAVING SUM(ISNULL(s.[SaleNetAmount], 0)) > 0`,
    `ORDER BY TotalSpend DESC`,
  ].join("\n");
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. YTD BRANCH RANKING
   ═══════════════════════════════════════════════════════════════════════════ */
function isYtdBranchRankingQuestion(question) {
  const q = String(question || "").toLowerCase();
  const hasYtd = /\b(ytd|year to date|this year|financial year|yearly|annual)\b/.test(q);
  const hasBranch = /\b(branch|branches|store|stores|outlet|location)\b/.test(q);
  const hasRank = /\b(top|best|rank|leading|highest|performance|ranking)\b/.test(q);
  return hasYtd && hasBranch && hasRank;
}

function buildYtdBranchRankingSql(question) {
  const c = getCanonicalSalesContext();
  const n = parseTopN(question, 10);
  return [
    `SELECT TOP (${n})`,
    `  [${c.branchCol}] AS Branch,`,
    `  SUM(ISNULL([${c.amountCol}], 0)) AS YTDSales,`,
    `  SUM(ISNULL([${c.qtyCol}], 0)) AS YTDQty,`,
    `  COUNT(DISTINCT [${c.invoiceCol || "XnNo"}]) AS Bills`,
    `FROM${nl(c.table)}`,
    `WHERE ${ytdWhere(c.dateCol)}`,
    `  AND NULLIF(LTRIM(RTRIM(CAST([${c.branchCol}] AS NVARCHAR(100)))), '') IS NOT NULL`,
    `GROUP BY [${c.branchCol}]`,
    `ORDER BY YTDSales DESC`,
  ].join("\n");
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. STOCK VALUE BY BRANCH OR CATEGORY
   ═══════════════════════════════════════════════════════════════════════════ */
function isStockValueQuestion(question) {
  const q = String(question || "").toLowerCase();
  const hasStock = /\b(stock|inventory|closing stock|stock on hand|on hand)\b/.test(q);
  const hasValue = /\b(value|worth|amount|cost|mrp|at cost|at mrp)\b/.test(q);
  const hasBreak = /\b(by|per|branch|store|outlet|category|department|supplier)\b/.test(q);
  return hasStock && hasValue && hasBreak;
}

function buildStockValueSql(question) {
  const q = String(question || "").toLowerCase();
  const stockTable = "dbo.VW_MB_POWERBI_STOCK_REPORT";
  const byCat = /\b(category|categories)\b/.test(q);
  const byDept = /\b(department|departments|dept)\b/.test(q);
  const bySupp = /\b(supplier|brand|vendor)\b/.test(q);
  const groupCol = byCat
    ? "[CategoryShortName]"
    : byDept
    ? "[DepartmentShortName]"
    : bySupp
    ? "[SupplierName]"
    : "[BranchAlias]";
  const groupLabel = byCat ? "Category" : byDept ? "Department" : bySupp ? "Supplier" : "Branch";
  return [
    `SELECT`,
    `  ${groupCol} AS ${groupLabel},`,
    `  SUM(ISNULL([StockQty], 0)) AS StockQty,`,
    `  CAST(SUM(ISNULL([StockQty], 0) * ISNULL([ItemMRP], 0)) AS DECIMAL(38,2)) AS StockValueAtMRP`,
    `FROM${nl(stockTable)}`,
    `WHERE NULLIF(LTRIM(RTRIM(CAST(${groupCol} AS NVARCHAR(200)))), '') IS NOT NULL`,
    `GROUP BY ${groupCol}`,
    `HAVING SUM(ISNULL([StockQty], 0)) > 0`,
    `ORDER BY StockValueAtMRP DESC`,
  ].join("\n");
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. INTER-BRANCH TRANSFER SUMMARY
   ═══════════════════════════════════════════════════════════════════════════ */
function isTransferQuestion(question) {
  const q = String(question || "").toLowerCase();
  return (
    /\b(transfer|transfers|stock transfer|sto|sti|transferred|moved|sent|received)\b/.test(q) &&
    /\b(branch|store|outlet|from|to)\b/.test(q)
  );
}

function buildTransferSql(question) {
  const q = String(question || "").toLowerCase();
  const n = parseTopN(question, 50);
  const isSti = /\b(received|sti|stock transfer in|in)\b/.test(q);
  const table = isSti
    ? "dbo.VW_MB_POWERBI_STI_REPORT"
    : "dbo.VW_MB_POWERBI_STO_REPORT";
  const byMtd = !(/\b(ytd|this year|financial year)\b/.test(q));
  const dateCol = "XnDt";
  const dateWhere = byMtd ? mtdWhere(dateCol) : ytdWhere(dateCol);
  const fromCol = isSti ? "SourceBranchAlias" : "SourceBranchAlias";
  const toCol = isSti ? "TargetBranchAlias" : "TargetBranchAlias";
  const qtyCol = isSti ? "StiQty" : "StoQty";
  return [
    `SELECT TOP (${n})`,
    `  [${fromCol}] AS FromBranch,`,
    `  [${toCol}] AS ToBranch,`,
    `  SUM(ISNULL([${qtyCol}], 0)) AS TransferQty,`,
    `  CAST(SUM(ISNULL([MrpValue], 0)) AS DECIMAL(38,2)) AS TransferMRPValue`,
    `FROM${nl(table)}`,
    `WHERE ${dateWhere}`,
    `GROUP BY [${fromCol}], [${toCol}]`,
    `HAVING SUM(ISNULL([${qtyCol}], 0)) > 0`,
    `ORDER BY TransferQty DESC`,
  ].join("\n");
}

/* ═══════════════════════════════════════════════════════════════════════════
   8. SUPPLIER / BRAND SELL-THROUGH RANKING
   ═══════════════════════════════════════════════════════════════════════════ */
function isSupplierRankingQuestion(question) {
  const q = String(question || "").toLowerCase();
  const hasSupp = /\b(supplier|suppliers|brand|brands|vendor|vendors)\b/.test(q);
  const hasRank = /\b(top|best|highest|leading|rank|most|lowest)\b/.test(q);
  const hasMetric = /\b(sales|revenue|amount|sold|turnover|qty|quantity|units?)\b/.test(q);
  const isPurchase = /\b(purchase|procurement|inward|grn)\b/.test(q);
  return hasSupp && hasRank && hasMetric && !isPurchase;
}

function buildSupplierRankingSql(question) {
  const c = getCanonicalSalesContext();
  const n = parseTopN(question, 10);
  const byUnits = /\b(qty|quantity|units?|pieces|pcs)\b/i.test(question);
  const byYtd = /\b(ytd|year to date|this year)\b/i.test(question);
  const dateWhere = byYtd ? ytdWhere(c.dateCol) : mtdWhere(c.dateCol);
  const orderCol = byUnits ? "TotalQty" : "TotalSales";
  return [
    `SELECT TOP (${n})`,
    `  [SupplierName] AS Supplier,`,
    `  SUM(ISNULL([${c.qtyCol}], 0)) AS TotalQty,`,
    `  CAST(SUM(ISNULL([${c.amountCol}], 0)) AS DECIMAL(38,2)) AS TotalSales`,
    `FROM${nl(c.table)}`,
    `WHERE ${dateWhere}`,
    `  AND NULLIF(LTRIM(RTRIM([SupplierName])), '') IS NOT NULL`,
    `GROUP BY [SupplierName]`,
    `HAVING SUM(ISNULL([${byUnits ? c.qtyCol : c.amountCol}], 0)) > 0`,
    `ORDER BY ${orderCol} DESC`,
  ].join("\n");
}

module.exports = {
  // article
  isTopArticleQuestion,
  buildTopArticleSql,
  // stock
  isZeroStockQuestion,
  buildZeroStockSql,
  isStockValueQuestion,
  buildStockValueSql,
  // customers
  isBirthdayCustomerQuestion,
  buildBirthdayCustomerSql,
  isTopCustomerSpenderQuestion,
  buildTopCustomerSpenderSql,
  // branch/YTD
  isYtdBranchRankingQuestion,
  buildYtdBranchRankingSql,
  // transfers
  isTransferQuestion,
  buildTransferSql,
  // supplier
  isSupplierRankingQuestion,
  buildSupplierRankingSql,
};
