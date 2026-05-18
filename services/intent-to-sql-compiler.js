/**
 * Deterministic T-SQL from resolve_intent JSON + schema roles (no LLM).
 * Used when the intent plan is unambiguous; falls back to generate_sql otherwise.
 */
"use strict";

const { enforceTopLimit } = require("../ai-sql");
const { resolveAnalyticsColumns } = require("./analytics-column-map");
const { getViewColumns } = require("./schema-from-json");
const { getCanonicalSalesContext, buildBillsTodaySql } = require("./canonical-sales-sql");
const {
  isTopInvoicesTodayQuestion,
  buildTopInvoicesTodaySql,
  isTopStoreYesterdayQuestion,
  buildTopStoreYesterdaySql,
  buildSalesTopNBreakdownSql,
} = require("./home-kpi-sql");
const { isIntentCompilerEnabled } = require("./nlq-pipeline-config");
const {
  isSalespersonTopNQuestion,
  buildSalespersonTopNSql,
} = require("./canonical-salesperson-sql");

const ANALYTICS_TOP = Math.min(
  parseInt(String(process.env.ANALYTICS_TOP_N_MAX || "1000"), 10) || 1000,
  1000
);

function normalizeTable(t) {
  const s = String(t || "").trim();
  if (!s) return getCanonicalSalesContext().table;
  return s.startsWith("dbo.") ? s : `dbo.${s}`;
}

function detectTemporalFromQuestion(q) {
  const ql = String(q || "").toLowerCase();
  if (/\btoday\b/.test(ql)) return "today";
  if (/\byesterday\b/.test(ql)) return "yesterday";
  if (/\b(mtd|month[\s-]*to[\s-]*date|this month)\b/.test(ql)) return "mtd";
  if (/\b(ytd|year[\s-]*to[\s-]*date|this year|financial year)\b/.test(ql)) return "ytd";
  if (/\b(qtd|quarter[\s-]*to[\s-]*date|this quarter)\b/.test(ql)) return "qtd";
  return null;
}

function buildTemporalWhere(dateCol, anchor) {
  const d = `[${dateCol}]`;
  const a = String(anchor || "").toLowerCase().replace(/\s+/g, "_");
  if (a === "today") return `CAST(${d} AS date) = CAST(GETDATE() AS date)`;
  if (a === "yesterday") return `CAST(${d} AS date) = DATEADD(day, -1, CAST(GETDATE() AS date))`;
  if (a === "mtd" || a === "this_month" || a === "month_to_date") {
    return `CAST(${d} AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST(${d} AS date) <= CAST(GETDATE() AS date)`;
  }
  if (a === "ytd" || a === "this_year") {
    return `CAST(${d} AS date) >= DATEFROMPARTS(CASE WHEN MONTH(GETDATE()) >= 4 THEN YEAR(GETDATE()) ELSE YEAR(GETDATE()) - 1 END, 4, 1) AND CAST(${d} AS date) <= CAST(GETDATE() AS date)`;
  }
  if (a === "qtd" || a === "this_quarter") {
    return `CAST(${d} AS date) >= CASE
      WHEN MONTH(GETDATE()) IN (4,5,6) THEN DATEFROMPARTS(YEAR(GETDATE()), 4, 1)
      WHEN MONTH(GETDATE()) IN (7,8,9) THEN DATEFROMPARTS(YEAR(GETDATE()), 7, 1)
      WHEN MONTH(GETDATE()) IN (10,11,12) THEN DATEFROMPARTS(YEAR(GETDATE()), 10, 1)
      ELSE DATEFROMPARTS(YEAR(GETDATE()), 1, 1)
    END AND CAST(${d} AS date) <= CAST(GETDATE() AS date)`;
  }
  return null;
}

function parseTopN(question, intent) {
  const m = String(question || "").match(/\btop\s*(\d+)\b/i);
  if (m) return Math.min(ANALYTICS_TOP, Math.max(1, parseInt(m[1], 10) || 10));
  const il = intent?.limit ?? intent?.top_n ?? intent?.topN;
  if (il != null) return Math.min(ANALYTICS_TOP, Math.max(1, parseInt(il, 10) || 10));
  const q = String(question || "").toLowerCase();
  if (
    /\b(highest|best|most|leading|lowest|worst|which)\b/.test(q) &&
    /\b(store|stores|branch|branches|outlet|location|shop)\b/.test(q)
  ) {
    return 1;
  }
  return null;
}

function isBillCountQuestion(q) {
  return (
    (/\bhow many\b/i.test(q) || /\bcount\b/i.test(q)) &&
    /\b(bills?|invoices?|footfall|transactions?)\b/i.test(q)
  );
}

function pickMetricColumn(intent, viewCols, amountCol) {
  const targets = []
    .concat(intent?.target_columns || [])
    .concat(intent?.metrics || [])
    .map((c) => String(c || "").replace(/[\[\]]/g, ""));
  for (const c of targets) {
    if (viewCols.has(c)) return c;
  }
  const mi = String(intent?.metric_intent || "").toLowerCase();
  if (/billcount|footfall|bills/.test(mi) && viewCols.has("BillCount")) return "BillCount";
  if (/appqty|qty|quantity|units|pieces/.test(mi) && viewCols.has("AppQty")) return "AppQty";
  if (/mrp|revenue|sales|amount|turnover/.test(mi) && viewCols.has("MrpValue")) return "MrpValue";
  if (viewCols.has(amountCol)) return amountCol;
  if (viewCols.has("MrpValue")) return "MrpValue";
  if (viewCols.has("NetSlsNetAmount")) return "NetSlsNetAmount";
  return null;
}

function resolveAggregation(intent, metricCol, question) {
  const mi = String(intent?.metric_intent || "").toLowerCase();
  const q = String(question || "").toLowerCase();
  if (metricCol === "BillCount" || isBillCountQuestion(question)) {
    if (/\bhow many\b/.test(q) && /\btoday\b/.test(q)) return { expr: null, useBillsToday: true };
    return { expr: `CAST(SUM(ISNULL([BillCount], 0)) AS BIGINT)`, alias: "BillCount" };
  }
  if (/count\s+distinct|distinct\s+count/i.test(mi) || /\bdistinct\b/.test(q)) {
    const inv = metricCol === "XnNo" ? "XnNo" : "XnNo";
    return { expr: `COUNT(DISTINCT [${inv}])`, alias: "BillCount" };
  }
  if (/^count\b|\bcount\b/i.test(mi) || /\bhow many\b/.test(q)) {
    return { expr: `COUNT(*)`, alias: "RowCount" };
  }
  if (/^avg\b|\baverage\b/i.test(mi) || /\baverage\b/.test(q)) {
    return { expr: `AVG(ISNULL([${metricCol}], 0))`, alias: `Avg${metricCol}` };
  }
  return { expr: `SUM(ISNULL([${metricCol}], 0))`, alias: metricCol === "MrpValue" ? "TotalSales" : `Total${metricCol}` };
}

function compileFilterClauses(intent, dateCol, question) {
  const parts = [];
  const filters = Array.isArray(intent?.filters) ? intent.filters : [];

  for (const f of filters) {
    const col = String(f?.column || "").replace(/[\[\]]/g, "");
    const op = String(f?.operator || "=").trim();
    let val = f?.value;
    if (!col) continue;
    if (col.toLowerCase() === dateCol.toLowerCase() && /today|yesterday|mtd|ytd|qtd|this_month/i.test(String(val))) {
      const tw = buildTemporalWhere(dateCol, String(val).toLowerCase());
      if (tw) {
        parts.push(tw);
        continue;
      }
    }
    if (val == null || val === "") continue;
    const lit = String(val).replace(/'/g, "''");
    if (op === "like" || op === "LIKE") parts.push(`CAST([${col}] AS NVARCHAR(500)) LIKE N'%${lit}%'`);
    else if (op === ">=" || op === "<=" || op === ">" || op === "<" || op === "=")
      parts.push(`[${col}] ${op} '${lit}'`);
    else parts.push(`CAST([${col}] AS NVARCHAR(500)) = N'${lit}'`);
  }

  if (!parts.some((p) => p.includes(`[${dateCol}]`))) {
    const anchor = detectTemporalFromQuestion(question);
    if (anchor) {
      const tw = buildTemporalWhere(dateCol, anchor);
      if (tw) parts.push(tw);
    }
  }

  return parts;
}

/**
 * @returns {string|null} T-SQL or null if intent is too ambiguous for deterministic compile
 */
function compileIntentToSql(intent, opts = {}) {
  if (!isIntentCompilerEnabled()) return null;

  const originalQuestion = String(opts.originalQuestion || opts.question || "").trim();
  if (!originalQuestion && !intent) return null;

  if (isSalespersonTopNQuestion(originalQuestion)) {
    const staffSql = buildSalespersonTopNSql(
      originalQuestion,
      opts.fromDate,
      opts.toDate
    );
    if (staffSql) return staffSql;
  }

  if (isBillCountQuestion(originalQuestion) && /\btoday\b/i.test(originalQuestion)) {
    const billsSql = buildBillsTodaySql();
    if (billsSql) return billsSql;
  }

  if (isTopInvoicesTodayQuestion(originalQuestion)) {
    const topSql = buildTopInvoicesTodaySql(originalQuestion);
    if (topSql) return topSql;
  }

  if (isTopStoreYesterdayQuestion(originalQuestion)) {
    const storeSql = buildTopStoreYesterdaySql(originalQuestion);
    if (storeSql) return storeSql;
  }

  const topBreakdownSql = buildSalesTopNBreakdownSql(originalQuestion);
  if (topBreakdownSql) return topBreakdownSql;

  if (!intent || typeof intent !== "object") return null;

  const table = normalizeTable(opts.targetView || getCanonicalSalesContext().table);
  const cols = resolveAnalyticsColumns(table);
  const viewCols = new Set(getViewColumns(table));
  const dateCol = cols.date || "XnDt";
  const amountCol = cols.amount || "MrpValue";

  const metricCol = pickMetricColumn(intent, viewCols, amountCol);
  if (!metricCol && !intent.metric_intent) return null;

  const agg = resolveAggregation(intent, metricCol || amountCol, originalQuestion);
  if (agg.useBillsToday) return buildBillsTodaySql();

  const dimensions = (intent.dimensions || [])
    .map((d) => String(d || "").replace(/[\[\]]/g, ""))
    .filter((d) => viewCols.has(d));

  const whereParts = compileFilterClauses(intent, dateCol, originalQuestion);
  const whereSql = whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "";

  const topN = parseTopN(originalQuestion, intent);
  const selectList =
    dimensions.length > 0
      ? dimensions.map((d) => `[${d}] AS [${d}]`).join(", ") + ", " + `${agg.expr} AS ${agg.alias}`
      : `${agg.expr} AS ${agg.alias}`;

  const groupSql = dimensions.length ? ` GROUP BY ${dimensions.map((d) => `[${d}]`).join(", ")}` : "";
  const orderCol = agg.alias || metricCol;
  const orderSql =
    dimensions.length && /top|highest|best|most|leading|lowest|worst|least/i.test(originalQuestion)
      ? ` ORDER BY ${agg.alias} DESC`
      : dimensions.length
        ? ` ORDER BY ${agg.alias} DESC`
        : "";

  const topPrefix = topN ? `TOP (${topN}) ` : dimensions.length === 0 ? "" : `TOP (${ANALYTICS_TOP}) `;

  let sql =
    `SELECT ${topPrefix}${selectList} FROM ${table} WITH (NOLOCK)${whereSql}${groupSql}${orderSql}`;

  return enforceTopLimit(sql, ANALYTICS_TOP);
}

module.exports = {
  compileIntentToSql,
  buildTemporalWhere,
  detectTemporalFromQuestion,
  ANALYTICS_TOP,
};
