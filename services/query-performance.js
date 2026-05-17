/**
 * Big-data query performance — AskYourDatabase-style rules.
 * Aggregate on the server; never pull millions of raw rows into the API/LLM.
 */
"use strict";

const LARGE_VIEW_PATTERNS =
  /VW_MB_POWERBI_|VwAISalesData|VwAIStockData/i;

const EXPORT_INTENT_RE =
  /\b(export|download|extract|dump|full dump|all rows|all data|raw data|to excel|to csv|spreadsheet|backup)\b/i;

const BROAD_LIST_RE =
  /\b(show all|list all|every transaction|all sales|all records|entire table|full table)\b/i;

/** Prompt block injected into SQL generation. */
const PERFORMANCE_MANDATE = `
══ CRITICAL PERFORMANCE MANDATE (large retail views — millions of rows) ══
1. NEVER run open-ended SELECT * or line-level scans without aggregation.
2. Broad questions ("show all sales", "list transactions") → MUST use GROUP BY dimensions
   (XnDtMonth, BranchAlias, CategoryShortName, SupplierName) with SUM(), COUNT(), or AVG().
3. Line-level detail ONLY when the user explicitly asks for articles/invoices/lines — then TOP (N) max.
4. ALWAYS filter by date on large views: CAST(XnDt AS date) or InvoiceDt with MTD/YTD/range predicates.
5. Prefer WITH (NOLOCK) on read-only PowerBI views when scanning.
6. Target < 500 rows returned to the application; the database must do the heavy lifting.
7. If the user wants a full raw export → say it requires async export (do not SELECT millions of rows).
`;

function isAggregatedSql(sql) {
  const s = String(sql || "");
  return (
    /\bGROUP\s+BY\b/i.test(s) ||
    /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(s) ||
    /\bCOUNT\s*\(\s*DISTINCT\b/i.test(s)
  );
}

function referencesLargeView(sql) {
  return LARGE_VIEW_PATTERNS.test(String(sql || ""));
}

function hasTopLimit(sql) {
  return /\bTOP\s*\(\s*\d+\s*\)|\bTOP\s+\d+\b/i.test(String(sql || ""));
}

function detectExportIntent(question) {
  return EXPORT_INTENT_RE.test(String(question || ""));
}

function isBroadListQuestion(question) {
  return BROAD_LIST_RE.test(String(question || ""));
}

function maxTopForChat() {
  const v = parseInt(String(process.env.AI_SQL_TOP_MAX || "200"), 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 2000) : 200;
}

function maxRowsForChat() {
  const v = parseInt(String(process.env.AI_SQL_MAX_RESULT_ROWS || "500"), 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 2000) : 500;
}

function queryTimeoutMs() {
  const v = parseInt(String(process.env.DB_QUERY_TIMEOUT_MS || process.env.DB_REQUEST_TIMEOUT_MS || "120000"), 10);
  return Number.isFinite(v) && v > 0 ? v : 120000;
}

function exportMaxRows() {
  const v = parseInt(String(process.env.EXPORT_ASYNC_MAX_ROWS || "100000"), 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 500000) : 100000;
}

/**
 * Defensive validation — destructive block + aggregation/TOP boundary (all queries).
 * @throws {Error} Security Violation | Performance Violation
 */
function validatePerformanceShape(sqlString, question, opts = {}) {
  if (opts.allowRawExport) return true;

  const cleanSql = String(sqlString || "")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .toUpperCase()
    .trim();

  const destructiveRegex = /\b(DROP|ALTER|TRUNCATE|DELETE|UPDATE|INSERT|CREATE|MERGE|EXEC)\b/;
  if (destructiveRegex.test(cleanSql)) {
    const err = new Error(
      "Security Violation: Read-only pipeline context. Mutation commands blocked."
    );
    err.code = "security_violation";
    throw err;
  }

  if (!cleanSql.startsWith("SELECT")) {
    const err = new Error("Security Violation: Only SELECT statements are permitted.");
    err.code = "security_violation";
    throw err;
  }

  const aggregateRequired = !/^(0|false|no)$/i.test(
    String(process.env.AI_AGGREGATE_REQUIRED || "1").trim()
  );

  if (aggregateRequired) {
    const hasGroupBy = cleanSql.includes("GROUP BY");
    const hasTop = /\bTOP\s*\(\s*\d+\s*\)|\bTOP\s+\d+\b/.test(cleanSql);
    const hasAggFn = /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/.test(cleanSql);

    if (!hasGroupBy && !hasTop && !hasAggFn) {
      const err = new Error(
        "Performance Violation: Open unbounded view queries are blocked. " +
          "Please rewrite the query using server-side aggregations or a 'TOP (100)' limit modifier."
      );
      err.code = "performance_violation";
      throw err;
    }
  }

  if (/^(0|false|no)$/i.test(String(process.env.AI_AGGREGATE_REQUIRED || "1").trim())) {
    return true;
  }
  if (!referencesLargeView(sqlString)) return true;
  if (isAggregatedSql(sqlString) || hasTopLimit(sqlString)) return true;

  const q = String(question || "").toLowerCase();
  const explicitLineDetail =
    /\b(line|lines|invoice|invoices|article|sku|transaction detail|row level|each bill)\b/.test(q);
  if (explicitLineDetail && hasTopLimit(sqlString)) return true;

  const err = new Error(
    "Performance Violation: Large view scan without GROUP BY or TOP. " +
      "Use SUM/COUNT/AVG + GROUP BY or TOP (100)."
  );
  err.code = "performance_violation";
  throw err;
}

module.exports = {
  PERFORMANCE_MANDATE,
  LARGE_VIEW_PATTERNS,
  isAggregatedSql,
  referencesLargeView,
  hasTopLimit,
  detectExportIntent,
  isBroadListQuestion,
  maxTopForChat,
  maxRowsForChat,
  queryTimeoutMs,
  exportMaxRows,
  validatePerformanceShape,
};
