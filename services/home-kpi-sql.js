/**
 * SQL aligned with GET /api/home/kpi — so AI Query returns the same numbers as Home.
 */
"use strict";

const { DEFAULT_ANALYTICS_TABLE } = require("./analytics-column-map");
const { salesDimColumns, resolveAnalyticsDateCol } = require("./analytics-sql-context");
const {
  isSalespersonTopNQuestion,
  buildSalespersonTopNSql,
} = require("./canonical-salesperson-sql");
const runtimeConfig = require("./runtime-config");

function getHomeAnalyticsTable() {
  return String(runtimeConfig.get("ANALYTICS_BASE_TABLE") || DEFAULT_ANALYTICS_TABLE).trim();
}

function nolockClause() {
  return runtimeConfig.getBool("ANALYTICS_NOLOCK") ? " WITH (NOLOCK)" : "";
}

/** Same bill_count expression as Home KPI cards. */
function buildBillsTodaySqlAlignedWithHome() {
  const table = getHomeAnalyticsTable();
  const datCol = resolveAnalyticsDateCol(table, "sales");
  if (!datCol) return null;

  const dims = salesDimColumns(table, "sales");
  const billExpr = dims.invoice
    ? `COUNT(DISTINCT [${dims.invoice}])`
    : `CAST(SUM(ISNULL([BillCount], 0)) AS BIGINT)`;

  return (
    `SELECT ${billExpr} AS BillCount` +
    ` FROM ${table}${nolockClause()}` +
    ` WHERE CAST([${datCol}] AS DATE) = CAST(GETDATE() AS DATE)`
  );
}

function isBillsTodayQuestion(question) {
  const q = String(question || "").toLowerCase();
  return (
    /\b(how many|count|number of)\b/.test(q) &&
    /\b(bills?|invoices?|footfall|transactions?)\b/.test(q) &&
    /\b(today|today'?s)\b/.test(q)
  );
}

/** Today's gross revenue — same fact table + amount column as Home "Today's Sales". */
function buildTodaySalesSqlAlignedWithHome() {
  const table = getHomeAnalyticsTable();
  const datCol = resolveAnalyticsDateCol(table, "sales");
  if (!datCol) return null;

  const dims = salesDimColumns(table, "sales");
  const amtCol = dims.amount || "MrpValue";

  return (
    `SELECT CAST(SUM(ISNULL([${amtCol}], 0)) AS DECIMAL(38, 4)) AS TotalSales` +
    ` FROM ${table}${nolockClause()}` +
    ` WHERE CAST([${datCol}] AS DATE) = CAST(GETDATE() AS DATE)`
  );
}

/** Top-N invoices/bills by sales amount today (tabular, not scalar KPI). */
function isTopInvoicesTodayQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!/\b(today|today'?s)\b/.test(q)) return false;
  if (!/\b(top|highest|largest|biggest|best|leading)\b/.test(q)) return false;
  if (!/\b(invoices?|bills?)\b/.test(q)) return false;
  if (/\b(branch|branches|departments?|dept|categor|product|article|item|sku|staff|salesperson|supplier|vendor)\b/.test(q)) {
    return false;
  }
  return true;
}

function pickColumnFromView(table, candidates, preferred) {
  const { getViewColumns } = require("./schema-from-json");
  const cols = new Set(getViewColumns(normalizeDboTable(table)));
  if (preferred && cols.has(preferred)) return preferred;
  for (const c of candidates) {
    if (cols.has(c)) return c;
  }
  return preferred || candidates[0] || null;
}

function buildTopInvoicesTodaySql(question) {
  const table = normalizeDboTable(getHomeAnalyticsTable());
  const datCol = resolveAnalyticsDateCol(table, "sales");
  if (!datCol) return null;

  const dims = salesDimColumns(table, "sales");
  const amtCol = pickColumnFromView(
    table,
    ["NetSlsNetAmount", "MrpValue", "NetAmount", "SaleNetAmount"],
    dims.amount
  );
  const invCol = pickColumnFromView(
    table,
    ["XnNo", "CashmemoNo", "InvoiceNo", "InvoiceId"],
    dims.invoice
  );
  if (!amtCol || !invCol) return null;

  const m = String(question || "").match(/\btop\s*(\d+)\b/i);
  const n = Math.min(100, Math.max(1, parseInt(m ? m[1] : 10, 10) || 10));

  const todayWhere =
    /SLSXNS/i.test(table) && String(datCol).toLowerCase() === "xndt"
      ? `[${datCol}] = CAST(GETDATE() AS date)`
      : `CAST([${datCol}] AS date) = CAST(GETDATE() AS date)`;

  const branchSel = dims.branch ? `, MAX([${dims.branch}]) AS Branch` : "";

  return (
    `SELECT TOP (${n}) [${invCol}] AS InvoiceNo` +
    `${branchSel}` +
    `, CAST(SUM(ISNULL([${amtCol}], 0)) AS DECIMAL(38, 4)) AS TotalSales` +
    ` FROM ${table}${nolockClause()}` +
    ` WHERE ${todayWhere}` +
    ` AND [${invCol}] IS NOT NULL` +
    ` AND LTRIM(RTRIM(CAST([${invCol}] AS NVARCHAR(100)))) <> N''` +
    ` GROUP BY [${invCol}]` +
    ` ORDER BY TotalSales DESC`
  );
}

/** "Which store/branch had the highest sales yesterday?" — same fact table as Home. */
function isTopStoreYesterdayQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!/\byesterday\b/.test(q)) return false;
  if (!/\b(store|stores|branch|branches|outlet|location|shop)\b/.test(q)) return false;
  if (!/\b(highest|best|most|top|leading|maximum|largest|which)\b/.test(q)) return false;
  if (/\b(salesperson|sales\s*person|staff|employee|rep)\b/.test(q) && !/\b(store|branch|outlet|shop)\b/.test(q)) {
    return false;
  }
  return (
    /\b(mrp|revenue|sales|amount|turnover|value|gross|net)\b/.test(q) ||
    /\bmrpvalue\b/.test(q)
  );
}

function buildTopStoreYesterdaySql(question) {
  const table = getHomeAnalyticsTable();
  const datCol = resolveAnalyticsDateCol(table, "sales");
  if (!datCol) return null;

  const dims = salesDimColumns(table, "sales");
  const branchCol = dims.branch;
  const amtCol = dims.amount;
  if (!branchCol || !amtCol) return null;

  const m = String(question || "").match(/\btop\s*(\d+)\b/i);
  const n = m ? Math.min(100, Math.max(1, parseInt(m[1], 10) || 1)) : 1;

  const yesterdayWhere =
    /SLSXNS/i.test(table) && String(datCol).toLowerCase() === "xndt"
      ? `[${datCol}] = DATEADD(day, -1, CAST(GETDATE() AS date))`
      : `CAST([${datCol}] AS date) = DATEADD(day, -1, CAST(GETDATE() AS date))`;

  return (
    `SELECT TOP (${n}) [${branchCol}] AS Store` +
    `, CAST(SUM(ISNULL([${amtCol}], 0)) AS DECIMAL(38, 4)) AS TotalMrpValue` +
    ` FROM ${table}${nolockClause()}` +
    ` WHERE ${yesterdayWhere}` +
    ` AND NULLIF(LTRIM(RTRIM(CAST([${branchCol}] AS NVARCHAR(200)))), N'') IS NOT NULL` +
    ` GROUP BY [${branchCol}]` +
    ` ORDER BY TotalMrpValue DESC`
  );
}

function normalizeDboTable(table) {
  const t = String(table || "").trim();
  if (!t) return DEFAULT_ANALYTICS_TABLE;
  return t.startsWith("dbo.") ? t : `dbo.${t}`;
}

function buildPeriodWhereForTable(table, question) {
  const datCol = resolveAnalyticsDateCol(table, "sales");
  if (!datCol) return null;
  const ql = String(question || "").toLowerCase();
  const d = `[${datCol}]`;
  const slsxns = /SLSXNS/i.test(table) && String(datCol).toLowerCase() === "xndt";

  if (/\btoday\b/.test(ql)) {
    return slsxns ? `${d} = CAST(GETDATE() AS date)` : `CAST(${d} AS date) = CAST(GETDATE() AS date)`;
  }
  if (/\byesterday\b/.test(ql)) {
    return slsxns
      ? `${d} = DATEADD(day, -1, CAST(GETDATE() AS date))`
      : `CAST(${d} AS date) = DATEADD(day, -1, CAST(GETDATE() AS date))`;
  }
  return slsxns
    ? `${d} >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND ${d} <= CAST(GETDATE() AS date)`
    : `CAST(${d} AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST(${d} AS date) <= CAST(GETDATE() AS date)`;
}

/** Top-N or "sales/turnover by store|dept|category" — same fact table as Home analytics. */
function isSalesTopNBreakdownQuestion(question) {
  const ql = String(question || "").toLowerCase();
  if (isTopStoreYesterdayQuestion(question)) return false;
  const hasDim =
    /\b(branches?|stores?|outlets?|departments?|dept|categor(?:y|ies)|categories)\b/.test(ql) ||
    /\b(by|per|each)\s+(the\s+)?(store|stores|branch|branches|outlet|departments?|dept|categor)/.test(
      ql
    );
  if (!hasDim) return false;
  const hasRank = /\b(top|best|leading|highest|lowest|worst)\b/.test(ql);
  const hasByPhrase = /\b(by|per|each)\s+(the\s+)?(store|stores|branch|branches|outlet|departments?|dept|categor)/.test(
    ql
  );
  if (!hasRank && !hasByPhrase) return false;
  if (!/\b(revenue|sales|mrp|turnover|gross|amount|value)\b/.test(ql)) return false;
  if (/\b(salesperson|sales\s*person|staff|employee|vendor|supplier|purchase|article|sku|product)\b/.test(ql)) {
    return false;
  }
  return true;
}

function buildSalesTopNBreakdownSql(question) {
  if (!isSalesTopNBreakdownQuestion(question)) return null;

  const ql = String(question || "").toLowerCase();
  const table = normalizeDboTable(getHomeAnalyticsTable());
  const dims = salesDimColumns(table, "sales");
  const amtCol = pickColumnFromView(
    table,
    [
      runtimeConfig.get("SALES_ANALYTICS_AMOUNT_COLUMN"),
      "NetSlsNetAmount",
      "MrpValue",
      "NetAmount",
      "SaleNetAmount",
    ].filter(Boolean),
    dims.amount
  );
  const dateWhere = buildPeriodWhereForTable(table, question);
  if (!amtCol || !dateWhere) return null;

  let groupCol = null;
  let alias = null;
  if (/\b(departments?|dept)\b/.test(ql)) {
    groupCol = dims.dept || "DepartmentShortName";
    alias = "Department";
  } else if (/\b(categor(?:y|ies)|categories)\b/.test(ql)) {
    groupCol = dims.cat || "CategoryShortName";
    alias = "Category";
  } else if (/\b(branches?|stores?|outlets?)\b/.test(ql)) {
    groupCol = dims.branch || "BranchAlias";
    alias = "Branch";
  } else {
    return null;
  }

  const m = String(question || "").match(/\btop\s*(\d+)\b/i);
  const defaultN = /\b(by|per|each)\s+(the\s+)?(store|stores|branch|branches|outlet)/i.test(
    String(question || "")
  )
    ? 200
    : 10;
  const n = Math.min(500, Math.max(1, parseInt(m ? m[1] : defaultN, 10) || defaultN));

  return (
    `SELECT TOP (${n}) [${groupCol}] AS ${alias}` +
    `, CAST(SUM(ISNULL([${amtCol}], 0)) AS DECIMAL(38, 4)) AS TotalRevenue` +
    ` FROM ${table}${nolockClause()}` +
    ` WHERE ${dateWhere}` +
    ` AND NULLIF(LTRIM(RTRIM(CAST([${groupCol}] AS NVARCHAR(200)))), N'') IS NOT NULL` +
    ` GROUP BY [${groupCol}]` +
    ` HAVING SUM(ISNULL([${amtCol}], 0)) <> 0` +
    ` ORDER BY TotalRevenue DESC`
  );
}

/**
 * Single entry: home-aligned SQL for KPI / top-N patterns (uses ANALYTICS_BASE_TABLE).
 * @returns {{ sql: string, label: string, chartAsTopN: boolean } | null}
 */
function resolveHomeAlignedSql(question, originalQuestion) {
  const tries = [];
  const add = (s) => {
    const t = String(s || "").trim();
    if (t && !tries.includes(t)) tries.push(t);
  };
  add(question);
  add(originalQuestion);

  for (const q of tries) {
    if (isSalespersonTopNQuestion(q)) {
      const sql = buildSalespersonTopNSql(q);
      if (sql) return { sql, label: "Salesperson top-N", chartAsTopN: true };
    }
    if (isBillsTodayQuestion(q)) {
      const sql = buildBillsTodaySqlAlignedWithHome();
      if (sql) return { sql, label: "Bills Today", chartAsTopN: false };
    }
    if (isTodaySalesKpiQuestion(q)) {
      const sql = buildTodaySalesSqlAlignedWithHome();
      if (sql) return { sql, label: "Today's Sales", chartAsTopN: false };
    }
    if (isTopInvoicesTodayQuestion(q)) {
      const sql = buildTopInvoicesTodaySql(q);
      if (sql) return { sql, label: "Top invoices today", chartAsTopN: true };
    }
    if (isTopStoreYesterdayQuestion(q)) {
      const sql = buildTopStoreYesterdaySql(q);
      if (sql) return { sql, label: "Top store yesterday", chartAsTopN: true };
    }
    if (isSalesTopNBreakdownQuestion(q)) {
      const sql = buildSalesTopNBreakdownSql(q);
      if (sql) return { sql, label: "Sales top-N breakdown", chartAsTopN: true };
    }
  }
  return null;
}

function isTodaySalesKpiQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (/\b(by\s+|breakdown|per\s+|each\s+|split\s+by|compare|versus|vs\b|top\s+\d+)\b/.test(q)) {
    return false;
  }
  if (/\b(how many|bill|invoice|footfall)\b/.test(q) && !/\b(revenue|sales|turnover|gross)\b/.test(q)) {
    return false;
  }
  const hasToday = /\b(today|today'?s)\b/.test(q);
  const hasRevenue = /\b(revenue|sales|turnover|gross|net\s+sales|mrp)\b/.test(q);
  const wantsScalar =
    /\b(total|sum|amount|value|how much|what is|what'?s)\b/.test(q) ||
    /today'?s\s+(total\s+)?(gross\s+)?(revenue|sales)/.test(q);
  return hasToday && hasRevenue && wantsScalar;
}

/**
 * If LLM emitted APP_REPORT for a store/turnover question, rewrite to Home fact table.
 */
function rewriteSalesSqlToHomeFact(sql, question) {
  const q = String(question || "").toLowerCase();
  if (!/\b(turnover|sales|revenue|gross)\b/.test(q)) return sql;
  if (
    !/\b(store|stores|branch|branches|outlet|outlets|shop|shops)\b/.test(q) &&
    !/\bby\s+(store|stores|branch|branches|outlet)\b/.test(q)
  ) {
    return sql;
  }
  const raw = String(sql || "");
  if (!/APP_REPORT/i.test(raw)) return sql;

  const home = normalizeDboTable(
    runtimeConfig.get("ANALYTICS_BASE_TABLE") || getHomeAnalyticsTable()
  );
  if (!home || !/SLSXNS/i.test(home)) return sql;

  let s = raw;
  s = s.replace(/dbo\.VW_MB_POWERBI_APP_REPORT/gi, home);
  s = s.replace(/\bMrpValue\b/gi, "NetSlsNetAmount");
  s = s.replace(
    /CAST\(\[XnDt\]\s+AS\s+date\)\s*=\s*DATEADD\s*\(\s*day\s*,\s*-1\s*,\s*CAST\s*\(\s*GETDATE\s*\(\s*\)\s+AS\s+date\s*\)\s*\)/gi,
    "[XnDt] = DATEADD(day, -1, CAST(GETDATE() AS date))"
  );
  s = s.replace(
    /CAST\(\[XnDt\]\s+AS\s+date\)\s*=\s*CAST\s*\(\s*GETDATE\s*\(\s*\)\s+AS\s+date\s*\)/gi,
    "[XnDt] = CAST(GETDATE() AS date)"
  );
  return s;
}

module.exports = {
  getHomeAnalyticsTable,
  rewriteSalesSqlToHomeFact,
  resolveHomeAlignedSql,
  buildBillsTodaySqlAlignedWithHome,
  buildTodaySalesSqlAlignedWithHome,
  buildTopInvoicesTodaySql,
  buildTopStoreYesterdaySql,
  buildSalesTopNBreakdownSql,
  isBillsTodayQuestion,
  isTodaySalesKpiQuestion,
  isTopInvoicesTodayQuestion,
  isTopStoreYesterdayQuestion,
  isSalesTopNBreakdownQuestion,
};
