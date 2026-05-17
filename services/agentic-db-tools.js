/**
 * Shared implementations for schema-discovery DB tools — used by:
 * - ai-agentic-query.js (OpenAI function calling)
 * - mcp/erp-database-server.js (Model Context Protocol)
 */
"use strict";

const sql = require("mssql");
const { enforceTopLimit } = require("../ai-sql");
const { queryTimeoutMs, maxRowsForChat, validatePerformanceShape } = require("./query-performance");
const { formatSystemObservation, isRecoverableDbError } = require("./metadata-translation-engine");
const {
  getCanonicalSalesTable,
  getCanonicalSalesContext,
  buildMtdWhereClause,
  isSalesDomainQuestion,
} = require("./canonical-sales-sql");

/** Columns safe for DISTINCT / TOP discovery (no PII beyond business dimensions). */
const DISCOVERABLE_COLUMNS = new Set([
  "BranchAlias",
  "SupplierName",
  "CategoryShortName",
  "DepartmentShortName",
  "ArticleNo",
  "Itemcode",
]);

function assertSafeIdentifier(name, label) {
  const c = String(name || "")
    .replace(/\[|\]/g, "")
    .trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(c)) {
    throw new Error(`Invalid ${label}: ${name}`);
  }
  return c;
}

function normalizeViewShort(viewName) {
  const raw = String(viewName || getCanonicalSalesTable())
    .replace(/^dbo\./i, "")
    .replace(/\[|\]/g, "")
    .trim();
  return assertSafeIdentifier(raw, "view");
}

/**
 * Keyword-based view scorer — returns top-N most relevant views.
 * @param {string} [preferViewRaw] optional dbo view name hint (from UI); normalized and boosted if present
 */
async function toolFindViewsForQuestion(pool, question, preferViewRaw) {
  const result = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
    ORDER BY TABLE_NAME
  `);
  const allViews = result.recordset.map((r) => r.TABLE_NAME);
  const q = String(question || "").toLowerCase();

  const preferNorm = String(preferViewRaw || "")
    .replace(/\[|\]/g, "")
    .replace(/^dbo\./i, "")
    .trim()
    .toLowerCase();
  const preferMatch = preferNorm
    ? allViews.find((v) => v.toLowerCase() === preferNorm)
    : null;

  const scored = allViews.map((v) => {
    const vl = v.toLowerCase();
    let score = 0;

    if (/\b(sale|sales|revenue|sold|invoice|turnover|receipt)\b/.test(q) && vl.includes("sls")) score += 3;
    if (/\b(purchase|procurement|buying|bought|inward|grn|payable)\b/.test(q) && vl.includes("pur")) score += 3;
    if (/\b(purchase return|credit note|prt)\b/.test(q) && vl.includes("prt")) score += 4;
    if (/\b(stock|inventory|on hand|available|balance)\b/.test(q) && (vl.includes("stock") || vl.includes("cbs")))
      score += 3;
    if (/\b(transfer|transferred|sti|sto|sent|received)\b/.test(q) && (vl.includes("sti") || vl.includes("sto"))) score += 3;
    if (/\b(approval|approved|app)\b/.test(q) && vl.includes("_app")) score += 3;
    if (/\b(approval return|apr)\b/.test(q) && vl.includes("_apr")) score += 4;
    if (/\b(customer|buyer|client|birthday|anniversary|credit limit)\b/.test(q) && vl.includes("customer")) score += 3;
    if (/\b(supplier|vendor|party|creditor)\b/.test(q) && (vl.includes("vendor") || vl.includes("supplier")))
      score += 3;
    if (/\b(branch|store|outlet|location|shop)\b/.test(q) && (vl.includes("branch") || v === "VwAIBranch")) score += 3;
    if (/\b(product|item|article|sku|style|color|size|fabric)\b/.test(q) && (vl.includes("product") || v.startsWith("VwMst") || v.startsWith("VwAIMst")))
      score += 2;
    if (/\b(bill count|footfall|transaction count|billcount)\b/.test(q) && vl.includes("billcount")) score += 4;
    if (/\b(salesperson|sales rep|agent|staff)\b/.test(q) && (vl.includes("app_report") || vl.includes("supplier")))
      score += 4;
    if (/\b(category|department|division|segment)\b/.test(q) && (vl.includes("category") || v.startsWith("VwMst") || v.startsWith("VwAIMst")))
      score += 2;
    if (/\b(average order value|aov|avg order)\b/.test(q)) {
      if (vl.includes("slsxns") || vl.includes("app_report") || vl.includes("sls_report")) score += 4;
    }
    if (/\b(mis|supplier.*sales|monthly.*sales)\b/.test(q) && vl.includes("mis")) score += 3;
    if (/\b(article|concept|silhouette|fabric|neckline)\b/.test(q) && vl.includes("article")) score += 3;
    if (/\b(git|in.transit|goods in transit)\b/.test(q) && vl.includes("cbs")) score += 4;

    return { view: v, score };
  });

  let top = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => s.view);

  if (preferMatch && !top.includes(preferMatch)) {
    top = [preferMatch, ...top].slice(0, 5);
  } else if (preferMatch && top.includes(preferMatch)) {
    top = [preferMatch, ...top.filter((v) => v !== preferMatch)].slice(0, 5);
  }

  const recommended =
    top.length > 0 ? top : ["VW_MB_POWERBI_APP_REPORT", "VW_MB_POWERBI_SLSXNS_REPORT", "VW_MB_POWERBI_BRANCH_LIST"];

  return {
    recommended_views: recommended,
    total_views_in_db: allViews.length,
    tip:
      "Call get_view_columns on recommended_views before writing any SQL. Pass multiple views at once to also get safe join columns." +
      (preferMatch ? ` Preferred view from context: ${preferMatch}.` : ""),
  };
}

/**
 * Returns approximate row count for a view/table using partition metadata
 * (sys.dm_db_partition_stats) — instant, no table scan.
 * Returns null for views (they have no partitions); falls back gracefully.
 */
async function getApproxRowCount(pool, viewName) {
  try {
    const r = await pool
      .request()
      .input("vname", sql.NVarChar(256), `dbo.${viewName}`)
      .query(`
        SELECT SUM(row_count) AS approx_rows
        FROM   sys.dm_db_partition_stats
        WHERE  object_id = OBJECT_ID(@vname) AND index_id < 2
      `);
    const n = r.recordset[0]?.approx_rows;
    return n != null ? Number(n) : null;
  } catch {
    return null; // non-fatal — some editions restrict this DMV
  }
}


async function toolGetViewColumns(pool, viewNames) {
  const results = {};

  for (const viewName of viewNames) {
    const [colResult, approxRows] = await Promise.all([
      pool
        .request()
        .input("vname", sql.NVarChar(128), String(viewName))
        .query(`
          SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
          FROM   INFORMATION_SCHEMA.COLUMNS
          WHERE  TABLE_NAME = @vname AND TABLE_SCHEMA = 'dbo'
          ORDER BY ORDINAL_POSITION
        `),
      getApproxRowCount(pool, viewName),
    ]);

    if (colResult.recordset.length === 0) {
      results[viewName] = `NOT FOUND — view '${viewName}' does not exist in dbo schema`;
    } else {
      const cols = colResult.recordset.map((c) => ({
        column:   c.COLUMN_NAME,
        type:     c.DATA_TYPE,
        nullable: c.IS_NULLABLE === "YES",
      }));
      // Attach row-count hint so formatSchemaForPrompt can include it
      cols._approxRows = approxRows;
      results[viewName] = cols;
    }
  }

  const validEntries = Object.entries(results).filter(([, v]) => Array.isArray(v));
  if (validEntries.length > 1) {
    const colSets = validEntries.map(([, cols]) => new Set(cols.map((c) => c.column)));
    const common = [...colSets[0]].filter((c) => colSets.slice(1).every((s) => s.has(c)));
    if (common.length > 0) {
      results["__safe_join_columns__"] =
        "Columns present in ALL of the above views (safe to use in JOIN ON): " + common.join(", ");
    }
  }

  // Build a join-direction advisory based on row counts
  const sizedViews = validEntries
    .filter(([, cols]) => cols._approxRows != null)
    .sort(([, a], [, b]) => (b._approxRows ?? 0) - (a._approxRows ?? 0));
  if (sizedViews.length >= 2) {
    const [largest] = sizedViews;
    const smallest = sizedViews[sizedViews.length - 1];
    if ((largest[1]._approxRows ?? 0) > (smallest[1]._approxRows ?? 0) * 10) {
      results["__join_direction_advisory__"] =
        `JOIN ORDER RULE (auto-derived from row counts): ` +
        `Start FROM dbo.${largest[0]} (${largest[1]._approxRows?.toLocaleString()} rows) ` +
        `and JOIN to dbo.${smallest[0]} (${smallest[1]._approxRows?.toLocaleString()} rows). ` +
        `NEVER reverse this — starting from the smaller table would cap results at ${smallest[1]._approxRows} rows regardless of TOP N.`;
    }
  }

  return results;
}

async function toolGetSampleRows(pool, viewName, limit) {
  const lim = Math.min(limit || 5, 20);
  // Fetch slightly more than requested to detect if the table is small
  const fetchN = Math.max(lim, 21);
  const r = await pool.request().query(`SELECT TOP ${fetchN} * FROM dbo.[${viewName}]`);
  const rows = r.recordset;

  // Warn the AI if this view/table has very few rows (master/lookup table)
  let warning = null;
  if (rows.length < 20) {
    const approxRows = await getApproxRowCount(pool, viewName);
    const totalRows = approxRows ?? rows.length;
    if (totalRows < 50) {
      warning =
        `⚠️ WARNING: ${viewName} has only ${totalRows} row(s) total. ` +
        `This is a master/lookup table. In ranking/TOP-N queries ALWAYS JOIN to it ` +
        `from the fact table (e.g. FROM VW_MB_POWERBI_APP_REPORT WITH (NOLOCK) or allowlisted view). ` +
        `NEVER use it as the primary FROM table or you will get at most ${totalRows} results.`;
    }
  }

  return {
    view: viewName,
    row_count: rows.length,
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    data: rows.slice(0, lim),
    ...(warning ? { warning } : {}),
  };
}

async function toolGetDistinctValues(pool, viewName, columnName, limit) {
  const lim = Math.min(limit || 50, 200);
  const view = assertSafeIdentifier(String(viewName).replace(/^dbo\./i, ""), "view");
  const col = assertSafeIdentifier(columnName, "column");
  const r = await pool.request().query(`
    SELECT DISTINCT TOP ${lim} [${col}]
    FROM dbo.[${view}] WITH (NOLOCK)
    WHERE [${col}] IS NOT NULL
    ORDER BY [${col}]
  `);
  return r.recordset.map((row) => row[col]);
}

/**
 * High-speed sampling — returns actual distinct strings from a column (no LLM guessing).
 * @param {import("mssql").ConnectionPool} pool
 * @param {string} columnName allowlisted dimension column
 * @param {string} [searchTerm] optional LIKE filter
 * @param {{ viewName?: string, limit?: number }} [opts]
 */
async function discoverColumnValues(pool, columnName, searchTerm = "", opts = {}) {
  const col = assertSafeIdentifier(columnName, "column");
  if (!DISCOVERABLE_COLUMNS.has(col)) {
    return { column: col, values: [], error: "column_not_allowlisted_for_discovery" };
  }

  const view = normalizeViewShort(opts.viewName);
  const limit = Math.min(Math.max(parseInt(String(opts.limit || 10), 10) || 10, 1), 50);
  const term = String(searchTerm || "").trim().toLowerCase();

  let query =
    `SELECT DISTINCT TOP (${limit}) CAST([${col}] AS nvarchar(400)) AS v ` +
    `FROM dbo.[${view}] WITH (NOLOCK) WHERE [${col}] IS NOT NULL`;
  const req = pool.request();
  if (term) {
    query += ` AND LOWER(CAST([${col}] AS nvarchar(400))) LIKE @search`;
    req.input("search", sql.NVarChar(400), `%${term}%`);
  }
  query += ` ORDER BY [${col}]`;

  try {
    req.timeout = Math.min(queryTimeoutMs(), 45000);
    const result = await req.query(query);
    const values = (result.recordset || [])
      .map((row) => row.v)
      .filter((v) => v != null && String(v).trim() !== "");
    return { column: col, view: `dbo.${view}`, values };
  } catch (error) {
    return { column: col, view: `dbo.${view}`, values: [], error: error.message };
  }
}

/**
 * Top-N dimension labels by revenue (MTD window) — grounds "highest salesperson" style queries.
 */
async function discoverTopDimensionByRevenue(pool, dimensionCol, opts = {}) {
  const col = assertSafeIdentifier(dimensionCol, "column");
  if (!DISCOVERABLE_COLUMNS.has(col)) {
    return { column: col, rows: [], error: "column_not_allowlisted_for_discovery" };
  }

  const view = normalizeViewShort(opts.viewName);
  const limit = Math.min(Math.max(parseInt(String(opts.limit || 10), 10) || 10, 1), 30);
  const ctx = getCanonicalSalesContext();
  const dateCol = assertSafeIdentifier(ctx.dateCol, "dateCol");
  const amountCol = assertSafeIdentifier(ctx.amountCol, "amountCol");
  const whereClause =
    String(opts.whereClause || "").trim() || buildMtdWhereClause(dateCol);

  const query =
    `SELECT TOP (${limit}) CAST([${col}] AS nvarchar(400)) AS label, ` +
    `SUM(CAST([${amountCol}] AS float)) AS metric_value ` +
    `FROM dbo.[${view}] WITH (NOLOCK) ` +
    `WHERE [${col}] IS NOT NULL AND ${whereClause} ` +
    `GROUP BY [${col}] ORDER BY metric_value DESC`;

  try {
    const req = pool.request();
    req.timeout = Math.min(queryTimeoutMs(), 60000);
    const result = await req.query(query);
    const rows = (result.recordset || []).map((r) => ({
      label: String(r.label ?? "").trim(),
      metric_value: parseFloat(r.metric_value) || 0,
    }));
    return {
      column: col,
      view: `dbo.${view}`,
      rows,
      values: rows.map((r) => r.label).filter(Boolean),
    };
  } catch (error) {
    return { column: col, view: `dbo.${view}`, rows: [], values: [], error: error.message };
  }
}

function formatLiveColumnSamplesBlock(samplesByKey) {
  if (!samplesByKey || typeof samplesByKey !== "object") return "";
  const lines = [
    "================================================================================",
    "VERIFIED LIVE DATABASE COLUMN VALUES (use exact strings in WHERE / GROUP BY)",
    "================================================================================",
    "CRITICAL:",
    "1. Use ONLY the exact strings below — do not guess spelling or capitalization.",
    "2. Salesperson / staff / rep → column SupplierName on VW_MB_POWERBI_APP_REPORT.",
    "3. Wrap MrpValue, AppQty, CostValue in SUM / COUNT / AVG — never return raw line scans.",
  ];

  const order = [
    ["BranchAlias", "Available Branches (BranchAlias)"],
    ["SupplierName", "Available Salespeople (SupplierName)"],
    ["CategoryShortName", "Available Categories (CategoryShortName)"],
    ["DepartmentShortName", "Available Departments (DepartmentShortName)"],
  ];

  for (const [key, title] of order) {
    const entry = samplesByKey[key];
    if (!entry) continue;
    const vals = Array.isArray(entry.values) ? entry.values : [];
    if (!vals.length) continue;
    const preview = vals.slice(0, 12).map((v) => JSON.stringify(String(v))).join(", ");
    lines.push(`- ${title}: ${preview}`);
    if (entry.topByRevenue) {
      lines.push(`  (ranked MTD by ${entry.amountCol || "MrpValue"} — highest first)`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Cognitive loop: sample live column values before SQL generation.
 */
async function discoverLiveSamplesForQuestion(pool, question, viewName) {
  const q = String(question || "").toLowerCase();
  const view = normalizeViewShort(viewName);
  const ctx = getCanonicalSalesContext();
  const samples = {};
  const tasks = [];

  const wantsRank =
    /\b(highest|lowest|best|worst|top|rank|leading|maximum|minimum)\b/.test(q);
  const useTopByRevenue = wantsRank && isSalesDomainQuestion(question);

  function addDiscover(col, { topByRevenue = false, searchTerm = "" } = {}) {
    tasks.push(
      (async () => {
        const out = topByRevenue
          ? await discoverTopDimensionByRevenue(pool, col, { viewName: view })
          : await discoverColumnValues(pool, col, searchTerm, { viewName: view, limit: 12 });
        samples[col] = {
          values: out.values || [],
          topByRevenue: Boolean(topByRevenue && out.rows?.length),
          amountCol: ctx.amountCol,
          error: out.error || null,
        };
      })()
    );
  }

  if (/\b(branch|branches|store|outlet)\b/.test(q)) {
    addDiscover(ctx.branchCol, { topByRevenue: useTopByRevenue });
  }
  if (/\b(salesperson|sales\s*person|salesman|sales\s*rep|staff|rep|employee)\b/.test(q)) {
    addDiscover(ctx.staffDimCol, { topByRevenue: true });
  }
  if (/\b(supplier|vendor)\b/.test(q) && !samples[ctx.staffDimCol]) {
    addDiscover(ctx.staffDimCol, { topByRevenue: useTopByRevenue });
  }
  if (/\b(categor|category)\b/.test(q)) {
    addDiscover(ctx.catCol, { topByRevenue: useTopByRevenue });
  }
  if (/\b(department|dept)\b/.test(q)) {
    addDiscover(ctx.deptCol, { topByRevenue: useTopByRevenue });
  }

  if (!tasks.length && isSalesDomainQuestion(question)) {
    addDiscover(ctx.branchCol, { topByRevenue: false });
    if (/\b(revenue|sales|amount)\b/.test(q)) {
      addDiscover(ctx.staffDimCol, { topByRevenue: true });
    }
  }

  await Promise.all(tasks);
  const text = formatLiveColumnSamplesBlock(samples);
  return { samples, text };
}

const FORBIDDEN_SQL_RE =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|MERGE|EXEC(UTE)?|GRANT|REVOKE|DENY|OPENROWSET|OPENDATASOURCE|BULK|WAITFOR|XP_|SP_EXECUTESQL)\b/i;

const MAX_SELF_HEAL_ATTEMPTS = 3;

/**
 * Execute SELECT with validation + driver try/catch; returns rows or self-heal payload.
 */
async function executeSqlWithSelfHealing(pool, sqlString, opts = {}) {
  const attemptCount = opts.attemptCount || 1;
  const cleaned = String(sqlString || "")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/;+\s*$/g, "")
    .trim();

  if (!cleaned.toUpperCase().startsWith("SELECT")) {
    throw new Error("BLOCKED: Statement must start with SELECT.");
  }
  if (FORBIDDEN_SQL_RE.test(cleaned)) {
    throw new Error("BLOCKED: Forbidden keyword in read-only pipeline.");
  }

  const safeSql = enforceTopLimit(cleaned, maxRowsForChat());

  try {
    if (!opts.skipPerformanceValidation) {
      validatePerformanceShape(safeSql, opts.question || "");
    }
    const req = pool.request();
    req.timeout = queryTimeoutMs();
    const result = await req.query(safeSql);
    const rows = result.recordset || [];
    const cap = maxRowsForChat();
    return {
      ok: true,
      row_count: rows.length,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      data: rows.slice(0, cap),
      sql: safeSql,
    };
  } catch (error) {
    const errMsg = error.message || String(error);
    const observation = formatSystemObservation(
      { message: errMsg, failed_sql: safeSql },
      safeSql,
      attemptCount
    );

    if (attemptCount >= MAX_SELF_HEAL_ATTEMPTS) {
      const fatal = new Error(
        `Execution failed after maximum self-healing limit. Final Database Driver Error: ${errMsg}`
      );
      fatal.system_observation = observation;
      fatal.failed_sql = safeSql;
      throw fatal;
    }

    return {
      ok: false,
      error: errMsg,
      failed_sql: safeSql,
      system_observation: observation,
      recoverable: isRecoverableDbError(errMsg),
      attemptCount,
      needsRetry: true,
    };
  }
}

async function toolRunSelect(pool, sqlStr, opts = {}) {
  const outcome = await executeSqlWithSelfHealing(pool, sqlStr, opts);
  if (outcome.ok) {
    return {
      row_count: outcome.row_count,
      columns: outcome.columns,
      data: outcome.data,
    };
  }
  return {
    error: outcome.error,
    failed_sql: outcome.failed_sql,
    system_observation: outcome.system_observation,
    recoverable: outcome.recoverable,
    hint: outcome.system_observation,
    attemptCount: outcome.attemptCount,
  };
}

async function dispatchAgenticTool(pool, toolName, args, fallbackQuestion, preferViewHint) {
  const a = args || {};
  switch (toolName) {
    case "find_views_for_question":
      return toolFindViewsForQuestion(
        pool,
        a.question || fallbackQuestion || "",
        a.prefer_view || preferViewHint || ""
      );
    case "get_view_columns":
      return toolGetViewColumns(pool, Array.isArray(a.view_names) ? a.view_names : []);
    case "get_sample_rows":
      return toolGetSampleRows(pool, a.view_name, a.limit);
    case "get_distinct_values":
      return toolGetDistinctValues(pool, a.view_name, a.column_name, a.limit);
    case "discover_column_values":
      return discoverColumnValues(pool, a.column_name, a.search_term || "", {
        viewName: a.view_name,
        limit: a.limit,
      });
    case "discover_live_samples":
      return discoverLiveSamplesForQuestion(
        pool,
        a.question || fallbackQuestion || "",
        a.view_name || preferViewHint || ""
      );
    case "run_select":
      return toolRunSelect(pool, a.sql || "", { question: fallbackQuestion || "" });
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

module.exports = {
  toolFindViewsForQuestion,
  toolGetViewColumns,
  toolGetSampleRows,
  toolGetDistinctValues,
  discoverColumnValues,
  discoverTopDimensionByRevenue,
  discoverLiveSamplesForQuestion,
  formatLiveColumnSamplesBlock,
  DISCOVERABLE_COLUMNS,
  toolRunSelect,
  executeSqlWithSelfHealing,
  dispatchAgenticTool,
  MAX_SELF_HEAL_ATTEMPTS,
};
