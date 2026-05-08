/**
 * Shared implementations for schema-discovery DB tools — used by:
 * - ai-agentic-query.js (OpenAI function calling)
 * - mcp/erp-database-server.js (Model Context Protocol)
 */
"use strict";

const sql = require("mssql");
const { enforceTopLimit } = require("../ai-sql");

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
    if (/\b(salesperson|sales rep|agent|staff)\b/.test(q) && vl.includes("salesperson")) score += 3;
    if (/\b(category|department|division|segment)\b/.test(q) && (vl.includes("category") || v.startsWith("VwMst") || v.startsWith("VwAIMst")))
      score += 2;
    if (/\b(average order value|aov|avg order)\b/.test(q)) {
      if (v === "VwAISalesData" || v === "VwAIBranch") score += 4;
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

  const recommended = top.length > 0 ? top : ["VwAISalesData", "VwAIBranch", "VwMstItems"];

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
        `from the fact table (e.g. FROM VwAISalesData s INNER JOIN ${viewName} m ON ...). ` +
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
  const r = await pool.request().query(`
    SELECT DISTINCT TOP ${lim} [${columnName}]
    FROM dbo.[${viewName}]
    WHERE [${columnName}] IS NOT NULL
    ORDER BY [${columnName}]
  `);
  return r.recordset.map((row) => row[columnName]);
}

const FORBIDDEN_SQL_RE =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|MERGE|EXEC(UTE)?|GRANT|REVOKE|DENY|OPENROWSET|OPENDATASOURCE|BULK|WAITFOR|XP_|SP_EXECUTESQL)\b/i;

async function toolRunSelect(pool, sqlStr) {
  const cleaned = String(sqlStr || "")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/;+\s*$/g, "")
    .trim();

  if (!cleaned.toUpperCase().startsWith("SELECT")) {
    return { error: "BLOCKED: Statement must start with SELECT. No other statements are allowed." };
  }
  if (FORBIDDEN_SQL_RE.test(cleaned)) {
    return {
      error: "BLOCKED: Contains a forbidden keyword (INSERT/UPDATE/DELETE/DROP/EXEC etc.). Only SELECT is permitted.",
    };
  }

  const safeSql = enforceTopLimit(cleaned, 1000);

  try {
    const req = pool.request();
    req.timeout = 30000;
    const result = await req.query(safeSql);
    const rows = result.recordset || [];
    return {
      row_count: rows.length,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      data: rows.slice(0, 500),
    };
  } catch (dbErr) {
    return {
      error: dbErr.message,
      failed_sql: safeSql,
      hint: "SQL execution failed. Call get_view_columns to verify column names and rewrite the query.",
    };
  }
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
    case "run_select":
      return toolRunSelect(pool, a.sql || "");
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

module.exports = {
  toolFindViewsForQuestion,
  toolGetViewColumns,
  toolGetSampleRows,
  toolGetDistinctValues,
  toolRunSelect,
  dispatchAgenticTool,
};
