/**
 * AskYourDatabase-style instant SQL resolution — before any LLM call.
 * Order: exact metadata cache → canonical domain templates → (optional) RAG exact.
 */
"use strict";

const { checkFastPath } = require("./metadata-translation-engine");
const {
  isVendorPurchaseTopNQuestion,
  buildVendorPurchaseTopNSql,
  resolveVendorPurchaseTopNSqlFast,
} = require("./canonical-purchase-sql");
const {
  isSalesDomainQuestion,
  getCanonicalSalesContext,
  buildBillsTodaySql,
  isDailyRevenueTrendQuestion,
  buildDailyRevenueTrendSql,
} = require("./canonical-sales-sql");
const {
  isSalespersonTopNQuestion,
  buildSalespersonTopNSql,
} = require("./canonical-salesperson-sql");
const {
  isTopInvoicesTodayQuestion,
  buildTopInvoicesTodaySql,
  isTopStoreYesterdayQuestion,
  buildTopStoreYesterdaySql,
  buildSalesTopNBreakdownSql,
  isSalesTopNBreakdownQuestion,
} = require("./home-kpi-sql");
const {
  isTopArticleQuestion,
  buildTopArticleSql,
  isZeroStockQuestion,
  buildZeroStockSql,
  isStockValueQuestion,
  buildStockValueSql,
  isBirthdayCustomerQuestion,
  buildBirthdayCustomerSql,
  isTopCustomerSpenderQuestion,
  buildTopCustomerSpenderSql,
  isYtdBranchRankingQuestion,
  buildYtdBranchRankingSql,
  isTransferQuestion,
  buildTransferSql,
  isSupplierRankingQuestion,
  buildSupplierRankingSql,
} = require("./canonical-extended-sql");

/**
 * @param {string} question — original user text (not jargon-mangled)
 * @param {{ fromDate?: string, toDate?: string }} [opts]
 * @returns {{ sql: string, source: string, matchType?: string, matchedKey?: string } | null}
 */
function resolveAdaptiveFastPathSql(question, opts = {}) {
  const q = String(question || "").trim();
  if (!q) return null;
  const ql = q.toLowerCase();

  // Before exact cache — cache used COUNT(DISTINCT XnNo) on APP_REPORT (often 0 for today).
  if (/\bhow many\b/.test(ql) && /\b(bills?|invoices?)\b/.test(ql) && /\btoday\b/.test(ql)) {
    const sql = buildBillsTodaySql();
    if (sql) {
      return { sql, source: "bills_today_kpi", matchType: "canonical" };
    }
  }

  if (isDailyRevenueTrendQuestion(q)) {
    return {
      sql: buildDailyRevenueTrendSql(q),
      source: "daily_revenue_trend",
      matchType: "canonical",
    };
  }

  if (isTopInvoicesTodayQuestion(q)) {
    const sql = buildTopInvoicesTodaySql(q);
    if (sql) {
      return { sql, source: "top_invoices_today", matchType: "canonical" };
    }
  }

  if (isTopStoreYesterdayQuestion(q)) {
    const sql = buildTopStoreYesterdaySql(q);
    if (sql) {
      return { sql, source: "top_store_yesterday", matchType: "canonical" };
    }
  }

  if (isSalesTopNBreakdownQuestion(q)) {
    const sql = buildSalesTopNBreakdownSql(q);
    if (sql) {
      return { sql, source: "sales_by_dimension", matchType: "canonical" };
    }
  }

  if (isSalespersonTopNQuestion(q)) {
    const sql = buildSalespersonTopNSql(q, opts.fromDate, opts.toDate);
    if (sql) {
      return { sql, source: "salesperson_topn", matchType: "canonical" };
    }
  }

  const cached = checkFastPath(q);
  if (cached?.sql) {
    return {
      sql: cached.sql,
      source: "exact_match_cache",
      matchType: cached.matchType,
      matchedKey: cached.matchedKey,
    };
  }

  if (isVendorPurchaseTopNQuestion(q)) {
    const sql =
      resolveVendorPurchaseTopNSqlFast(q, opts.fromDate, opts.toDate) ||
      buildVendorPurchaseTopNSql({ objects: [] }, q, opts.fromDate, opts.toDate);
    if (sql) {
      return { sql, source: "vendor_purchase_topn", matchType: "canonical" };
    }
  }

  // High-confidence sales KPI anchors (same SQL as metadata cache, explicit patterns)
  if (isSalesDomainQuestion(q) && /\b(total|sum)\b/.test(ql) && /\b(sales|revenue|turnover)\b/.test(ql)) {
    if (/\btoday\b/.test(ql)) {
      const sales = getCanonicalSalesContext();
      return {
        sql: `SELECT SUM([${sales.amountCol}]) AS TotalSales, COUNT(DISTINCT [${sales.invoiceCol || "XnNo"}]) AS BillCount FROM ${sales.table} WITH (NOLOCK) WHERE CAST([${sales.dateCol}] AS date) = CAST(GETDATE() AS date)`,
        source: "sales_kpi_today",
        matchType: "canonical",
      };
    }
  }

  const mtdWhere = `CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)`;
  const branchTop = q.match(/\btop\s*(\d+)\b/i);
  if (/\b(article|sku|product)\b/.test(ql) && /\b(top|best|leading|highest)\b/.test(ql) && /\b(qty|quantity|units?|pieces)\b/.test(ql)) {
    const n = Math.min(Math.max(parseInt(branchTop ? branchTop[1] : 10, 10) || 10, 1), 100);
    const sales = getCanonicalSalesContext();
    return {
      sql: `SELECT TOP (${n}) [ArticleNo] AS Article, SUM([${sales.qtyCol}]) AS TotalQty, SUM([${sales.amountCol}]) AS TotalSales FROM ${sales.table} WITH (NOLOCK) WHERE ${mtdWhere} GROUP BY [ArticleNo] ORDER BY TotalQty DESC`,
      source: "article_qty_topn",
      matchType: "canonical",
    };
  }

  if (/\b(distinct|how many)\b/.test(ql) && /\binvoices?\b/.test(ql) && /\b(this month|mtd)\b/.test(ql)) {
    const sales = getCanonicalSalesContext();
    return {
      sql: `SELECT COUNT(DISTINCT [${sales.invoiceCol || "XnNo"}]) AS InvoiceCount FROM ${sales.table} WITH (NOLOCK) WHERE CAST([${sales.dateCol}] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST([${sales.dateCol}] AS date) <= CAST(GETDATE() AS date)`,
      source: "invoice_count_mtd",
      matchType: "canonical",
    };
  }

  // ── Extended canonical patterns ─────────────────────────────────────────────

  // Stock: zero-stock / out-of-stock (before article check so "zero stock items" doesn't hit article path)
  if (isZeroStockQuestion(q)) {
    const sql = buildZeroStockSql(q);
    if (sql) return { sql, source: "zero_stock", matchType: "canonical" };
  }

  // Stock: value by branch / category / supplier / department
  if (isStockValueQuestion(q)) {
    const sql = buildStockValueSql(q);
    if (sql) return { sql, source: "stock_value", matchType: "canonical" };
  }

  // Transfers: inter-branch STI / STO
  if (isTransferQuestion(q)) {
    const sql = buildTransferSql(q);
    if (sql) return { sql, source: "branch_transfer", matchType: "canonical" };
  }

  // Customers: birthdays this month
  if (isBirthdayCustomerQuestion(q)) {
    const sql = buildBirthdayCustomerSql(q);
    if (sql) return { sql, source: "birthday_customers", matchType: "canonical" };
  }

  // Customers: top spenders
  if (isTopCustomerSpenderQuestion(q)) {
    const sql = buildTopCustomerSpenderSql(q);
    if (sql) return { sql, source: "top_customer_spenders", matchType: "canonical" };
  }

  // Articles: top by qty or sales (after stock/article disambiguation)
  if (isTopArticleQuestion(q)) {
    const sql = buildTopArticleSql(q);
    if (sql) return { sql, source: "top_articles", matchType: "canonical" };
  }

  // Branches: YTD ranking
  if (isYtdBranchRankingQuestion(q)) {
    const sql = buildYtdBranchRankingSql(q);
    if (sql) return { sql, source: "ytd_branch_ranking", matchType: "canonical" };
  }

  // Suppliers / brands: sell-through ranking
  if (isSupplierRankingQuestion(q)) {
    const sql = buildSupplierRankingSql(q);
    if (sql) return { sql, source: "supplier_ranking", matchType: "canonical" };
  }

  return null;
}

module.exports = {
  resolveAdaptiveFastPathSql,
};
