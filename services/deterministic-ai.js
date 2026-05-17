"use strict";

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { getFilterColumns, sanitizeColumnName } = require("../filter-query");
const { decideChart } = require("./chart-decision-engine");

const DICT_PATH = path.join(__dirname, "..", "metadata", "semantic_dictionary.json");
const SEMANTIC_GRAPH_PATH = path.join(__dirname, "..", "metadata", "semantic_graph.json");
const QUERY_CACHE = new Map();
const QUERY_CACHE_TTL_MS = 5 * 60 * 1000;
const PREAGG_TTL_MS = 10 * 60 * 1000;
let preAggDaily = { ts: 0, rows: [] };

function loadSemanticDictionary() {
  try {
    const raw = fs.readFileSync(DICT_PATH, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function loadSemanticGraph() {
  try {
    const raw = fs.readFileSync(SEMANTIC_GRAPH_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch (_) {
    return null;
  }
}

function safeTopN(n) {
  const x = parseInt(String(n || "10"), 10);
  if (!Number.isFinite(x)) return 10;
  return Math.min(Math.max(x, 1), 100);
}

function dmyToIso(s) {
  const m = String(s || "").match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function extractIsoDatesFromQuestion(question) {
  const q = String(question || "");
  const out = [];
  const reDmy = /(\d{2}[./-]\d{2}[./-]\d{4})/g;
  let m;
  while ((m = reDmy.exec(q))) {
    const iso = dmyToIso(m[1]);
    if (iso) out.push(iso);
  }
  const reIso = /\b(\d{4}-\d{2}-\d{2})\b/g;
  while ((m = reIso.exec(q))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function hasComparisonOperator(question) {
  const q = String(question || "").toLowerCase();
  return /\b(vs|versus|compare|against)\b/.test(q);
}

function extractPointSetValues(question) {
  const q = String(question || "");
  const values = [];
  if (/\btoday\b/i.test(q)) values.push("CURRENT_DATE");
  if (/\byesterday\b/i.test(q)) values.push("YESTERDAY");
  const explicit = extractIsoDatesFromQuestion(q);
  for (const d of explicit) values.push(d);
  return [...new Set(values)];
}

function inferGroupByColumns(question) {
  const q = String(question || "").toLowerCase();
  const groupBy = [];
  if (/\bby\s+branch|branch-wise|branch wise/.test(q)) groupBy.push("branch");
  if (/\bby\s+department|dept-wise|department wise/.test(q)) groupBy.push("department");
  if (/\bby\s+category|category-wise|category wise/.test(q)) groupBy.push("category");
  if (/\bby\s+product|item-wise|product wise/.test(q)) groupBy.push("product");
  if (/\bdaily|day-wise|by day/.test(q)) groupBy.push("date_day");
  if (/\bmonthly|month-wise|by month/.test(q)) groupBy.push("date_month");
  return [...new Set(groupBy)];
}

function buildStructuredPlan(question) {
  const pointSetValues = extractPointSetValues(question);
  const metric = inferMetricFromQuestion(question);
  const group_by = inferGroupByColumns(question);
  const filters = inferFiltersFromQuestion(question);
  /* Multi-date / multi-point questions: preserve every explicit date — no "vs" required (Zoho-style). */
  const mode = pointSetValues.length >= 2 ? "point_set" : "none";
  return {
    operation: metric === "invoice_count" ? "count" : "aggregate",
    metric,
    group_by,
    filters,
    time_comparison: {
      mode,
      values: mode === "point_set" ? pointSetValues : [],
    },
  };
}

function buildPointSetCompareSql(metricDef, dateColExpr, values) {
  const aggExpr =
    metricDef.aggregation === "COUNT_DISTINCT"
      ? `COUNT(DISTINCT s.[${metricDef.column}])`
      : `${metricDef.aggregation}(ISNULL(s.[${metricDef.column}],0))`;
  const parts = [];
  let sortOrder = 1;
  for (const val of values) {
    let label;
    let where;
    if (val === "CURRENT_DATE") {
      label = "today";
      where = `${dateColExpr} = CAST(GETDATE() AS date)`;
    } else if (val === "YESTERDAY") {
      label = "yesterday";
      where = `${dateColExpr} = DATEADD(day, -1, CAST(GETDATE() AS date))`;
    } else {
      label = String(val);
      where = `${dateColExpr} = '${escapeSqlLiteral(label)}'`;
    }
    parts.push(
      `SELECT N'${escapeSqlLiteral(label)}' AS Period, ${sortOrder++} AS SortOrder, ${aggExpr} AS Value FROM dbo.VwAISalesData s WHERE ${where}`
    );
  }
  return `${parts.join("\nUNION ALL\n")}\nORDER BY SortOrder`;
}

function isPeriodCompareQuestion(question) {
  const q = String(question || "").toLowerCase();
  return /\bvs\b/.test(q) && /\b(today|sales|revenue|amount|last monday|last month)\b/.test(q);
}

function isSalesPurchaseCompareQuestion(question) {
  const q = String(question || "").toLowerCase();
  return /\b(purchase|purchases)\b/.test(q) && /\b(sales|revenue)\b/.test(q);
}

function buildPeriodCompareSql(question) {
  const q = String(question || "").toLowerCase();
  const explicitDates = extractIsoDatesFromQuestion(question);
  const selects = [];
  let order = 1;
  const pushSlice = (label, filterSql) => {
    selects.push(`SELECT '${label}' AS Period, ${order++} AS SortOrder, SUM(ISNULL(s.SaleNetAmount,0)) AS NetSales FROM dbo.VwAISalesData s WHERE ${filterSql}`);
  };
  // Always include today when user asks compare.
  pushSlice("Today",
    "CAST(s.InvoiceDt AS date) = CAST(GETDATE() AS date)");
  if (/\blast monday\b/.test(q)) {
    pushSlice(
      "Last Monday",
      "CAST(s.InvoiceDt AS date) = DATEADD(day, 2 - DATEPART(WEEKDAY, GETDATE()), DATEADD(day,-7,CAST(GETDATE() AS date)))"
    );
  }
  if (/\blast month\b/.test(q)) {
    pushSlice(
      "Last Month (same day)",
      "CAST(s.InvoiceDt AS date) = DATEADD(month,-1,CAST(GETDATE() AS date))"
    );
  }
  for (const iso of explicitDates) {
    pushSlice(iso, `CAST(s.InvoiceDt AS date) = '${iso}'`);
  }
  if (selects.length <= 1) return null;
  return `${selects.join("\nUNION ALL\n")}\nORDER BY SortOrder`;
}

function pickFirstAvailable(cols, candidates) {
  const map = new Map((cols || []).map((c) => [String(c || "").toLowerCase(), c]));
  for (const c of candidates || []) {
    const hit = map.get(String(c || "").toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function buildSalesPurchaseCompareSql(question, schemaMeta) {
  const q = String(question || "").toLowerCase();
  const useMonthly = /\b(month|monthly|qtd|ytd|last 6|last six)\b/.test(q);
  const thisYearOnly = /\b(this year|current year|ytd)\b/.test(q);

  const purchaseTableCandidates = [
    "dbo.VW_MB_POWERBI_PUR_QTY_WITH_COST",
    "dbo.VW_MB_POWERBI_PURXNS_REPORT",
    "dbo.VW_MB_POWERBI_PUR_REPORT",
    "dbo.VW_MB_POWERBI_SUPPLIER_PUR_REPORT",
  ];
  const dateCandidates = ["PurchaseDt", "PurDate", "PurInvoiceDt", "XnDt"];
  const amountCandidates = ["PurCost", "PurNetAmount", "PurCostValue", "PurchasePrice", "NetPurCost", "NetPurNetAmount", "PurAmount", "Amount", "Value"];
  let purchaseTable = "dbo.VW_MB_POWERBI_PUR_QTY_WITH_COST";
  let purchaseDateCol = "PurchaseDt";
  let purchaseAmountCol = "PurCost";
  for (const t of purchaseTableCandidates) {
    const cols = getObjectColumns(schemaMeta, t);
    if (!cols.length) continue;
    const dt = pickFirstAvailable(cols, dateCandidates);
    const amt = pickFirstAvailable(cols, amountCandidates);
    if (dt && amt) {
      purchaseTable = t;
      purchaseDateCol = dt;
      purchaseAmountCol = amt;
      break;
    }
  }
  const salesWhere = thisYearOnly ? "WHERE YEAR(s.InvoiceDt) = YEAR(GETDATE())" : "";
  const purchaseWhere = thisYearOnly ? `WHERE YEAR(p.${purchaseDateCol}) = YEAR(GETDATE())` : "";

  const periodExpr = useMonthly ? "FORMAT(s.InvoiceDt, 'MMM yyyy')" : "CAST(s.InvoiceDt AS date)";
  const periodExprPur = useMonthly ? `FORMAT(p.${purchaseDateCol}, 'MMM yyyy')` : `CAST(p.${purchaseDateCol} AS date)`;
  return [
    "WITH sales AS (",
    `  SELECT ${periodExpr} AS Period, SUM(ISNULL(s.SaleNetAmount,0)) AS NetSales, MIN(s.InvoiceDt) AS SortDate`,
    "  FROM dbo.VwAISalesData s",
    `  ${salesWhere}`,
    "  GROUP BY " + periodExpr,
    "), pur AS (",
    `  SELECT ${periodExprPur} AS Period, SUM(ISNULL(p.${purchaseAmountCol},0)) AS TotalPurchases, MIN(p.${purchaseDateCol}) AS SortDate`,
    `  FROM ${purchaseTable} p`,
    `  ${purchaseWhere}`,
    "  GROUP BY " + periodExprPur,
    ")",
    "SELECT COALESCE(sales.Period, pur.Period) AS Period,",
    "  ISNULL(sales.NetSales,0) AS NetSales,",
    "  ISNULL(pur.TotalPurchases,0) AS TotalPurchases,",
    "  COALESCE(sales.SortDate, pur.SortDate) AS SortDate",
    "FROM sales",
    "FULL OUTER JOIN pur ON sales.Period = pur.Period",
    "ORDER BY SortDate",
  ].join("\n");
}

const {
  isVendorPurchaseTopNQuestion,
  buildVendorPurchaseTopNSql: buildVendorPurchaseTopNSqlCanonical,
  VENDOR_PUR_TOPN_SQL,
} = require("./canonical-purchase-sql");

function getObjectColumns(schemaMeta, tableName) {
  const target = String(tableName || "").toLowerCase();
  const obj = (schemaMeta?.objects || []).find((o) => String(o.name || "").toLowerCase() === target);
  return (obj?.columns || []).map((c) => String(c.name || ""));
}

function pickFirstColumn(cols, preferred) {
  const set = new Set((cols || []).map((c) => String(c).toLowerCase()));
  for (const p of preferred) {
    if (set.has(String(p).toLowerCase())) return p;
  }
  return null;
}

function buildVendorPurchaseTopNSql(schemaMeta, question, fromDate, toDate) {
  return (
    buildVendorPurchaseTopNSqlCanonical(schemaMeta, question, fromDate, toDate) ||
    VENDOR_PUR_TOPN_SQL
  );
}

function getCachedRows(cacheKey) {
  const hit = QUERY_CACHE.get(cacheKey);
  if (!hit) return null;
  if (Date.now() - hit.ts > QUERY_CACHE_TTL_MS) {
    QUERY_CACHE.delete(cacheKey);
    return null;
  }
  return hit.rows;
}

function setCachedRows(cacheKey, rows) {
  QUERY_CACHE.set(cacheKey, { ts: Date.now(), rows: Array.isArray(rows) ? rows : [] });
}

async function buildRuntimeSchemaMetadata(pool, maxObjects = 300) {
  const namesRes = await pool.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo'
    ORDER BY TABLE_NAME
  `);
  const all = namesRes.recordset || [];
  const selected = all.slice(0, Math.max(1, maxObjects));
  const byName = new Map();
  for (const r of selected) {
    byName.set(String(r.TABLE_NAME).toLowerCase(), {
      name: `dbo.${r.TABLE_NAME}`,
      type: r.TABLE_TYPE,
      columns: [],
    });
  }

  if (!selected.length) return { objects: [], relationships: [] };

  const colsRes = await pool.request().query(`
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='dbo'
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `);
  for (const c of colsRes.recordset || []) {
    const entry = byName.get(String(c.TABLE_NAME).toLowerCase());
    if (!entry) continue;
    entry.columns.push({ name: c.COLUMN_NAME, type: c.DATA_TYPE });
  }

  const fkRes = await pool.request().query(`
    SELECT
      KCU1.TABLE_NAME AS FK_TABLE,
      KCU1.COLUMN_NAME AS FK_COLUMN,
      KCU2.TABLE_NAME AS PK_TABLE,
      KCU2.COLUMN_NAME AS PK_COLUMN
    FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS RC
    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE KCU1
      ON KCU1.CONSTRAINT_CATALOG = RC.CONSTRAINT_CATALOG
      AND KCU1.CONSTRAINT_SCHEMA = RC.CONSTRAINT_SCHEMA
      AND KCU1.CONSTRAINT_NAME = RC.CONSTRAINT_NAME
    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE KCU2
      ON KCU2.CONSTRAINT_CATALOG = RC.UNIQUE_CONSTRAINT_CATALOG
      AND KCU2.CONSTRAINT_SCHEMA = RC.UNIQUE_CONSTRAINT_SCHEMA
      AND KCU2.CONSTRAINT_NAME = RC.UNIQUE_CONSTRAINT_NAME
      AND KCU2.ORDINAL_POSITION = KCU1.ORDINAL_POSITION
    WHERE KCU1.TABLE_SCHEMA='dbo' AND KCU2.TABLE_SCHEMA='dbo'
  `);
  const relationships = (fkRes.recordset || [])
    .filter((r) => byName.has(String(r.FK_TABLE).toLowerCase()) && byName.has(String(r.PK_TABLE).toLowerCase()))
    .map((r) => ({
      from: `dbo.${r.FK_TABLE}.${r.FK_COLUMN}`,
      to: `dbo.${r.PK_TABLE}.${r.PK_COLUMN}`,
    }));

  return {
    objects: [...byName.values()],
    relationships,
  };
}

function buildRelationshipGraph(schemaMeta) {
  const graph = new Map();
  const addEdge = (a, b, on) => {
    if (!graph.has(a)) graph.set(a, []);
    graph.get(a).push({ to: b, on });
  };
  for (const rel of (schemaMeta?.relationships || [])) {
    const [fromTable, fromCol] = String(rel.from || "").split(".").slice(0, 3).reduce((acc, cur, idx) => {
      if (idx < 2) acc[0].push(cur); else acc[1] = cur;
      return acc;
    }, [[], ""]);
    const [toTable, toCol] = String(rel.to || "").split(".").slice(0, 3).reduce((acc, cur, idx) => {
      if (idx < 2) acc[0].push(cur); else acc[1] = cur;
      return acc;
    }, [[], ""]);
    const fTable = fromTable.join(".");
    const tTable = toTable.join(".");
    if (fTable && tTable && fromCol && toCol) {
      addEdge(fTable, tTable, `${fTable}.[${fromCol}] = ${tTable}.[${toCol}]`);
      addEdge(tTable, fTable, `${tTable}.[${toCol}] = ${fTable}.[${fromCol}]`);
    }
  }
  return graph;
}

function findJoinPath(schemaMeta, fromTable, toTable) {
  const start = String(fromTable || "").trim();
  const goal = String(toTable || "").trim();
  if (!start || !goal || start === goal) return [];
  const g = buildRelationshipGraph(schemaMeta);
  const q = [{ table: start, path: [] }];
  const seen = new Set([start]);
  while (q.length) {
    const cur = q.shift();
    if (cur.table === goal) return cur.path;
    for (const e of (g.get(cur.table) || [])) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      q.push({ table: e.to, path: [...cur.path, { table: e.to, on: e.on }] });
    }
  }
  return [];
}

function extractSqlIdentifiers(sqlText) {
  const sql = String(sqlText || "");
  const tableMatches = [...sql.matchAll(/\b(?:from|join)\s+([a-zA-Z0-9_.\[\]]+)/gi)].map((m) =>
    String(m[1] || "").replace(/\[|\]/g, "")
  );
  const colMatches = [...sql.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\.\[?([a-zA-Z_][a-zA-Z0-9_]*)\]?/g)].map((m) => ({
    alias: m[1],
    col: m[2],
  }));
  return { tables: tableMatches, columns: colMatches };
}

function chartPolicyFromResultShape(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "table";
  const keys = Object.keys(rows[0] || {});
  if (keys.length > 12) return "table";
  try {
    const d = decideChart(rows, {});
    const ct = d.chartType;
    return ct && ct !== null ? ct : "table";
  } catch {
    return "table";
  }
}

function chooseDeterministicChart(intent, rows) {
  const fromShape = chartPolicyFromResultShape(rows);
  if (fromShape !== "table" || (Array.isArray(rows) && rows.length <= 1)) return fromShape;
  const first = Array.isArray(rows) && rows.length ? rows[0] : null;
  const cols = first ? Object.keys(first) : [];
  if (!cols.length) return "table";
  if (intent === "top_n") return "bar";
  if (intent === "breakdown") return rows.length <= 8 ? "pie" : "bar";
  if (intent === "kpi") return "kpi_card";
  return fromShape;
}

function inferMetricFromQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (
    /\b(customer|customers)\b/.test(q) &&
    /\b(count|counts|counting|unique|distinct|how many|number of)\b/.test(q)
  ) {
    return "customer_count";
  }
  if (/\bunique\b/.test(q) && /\b(customer|customers)\b/.test(q)) return "customer_count";
  if (/\b(invoice|transaction|order|bill|bills)\b/.test(q) && /\bcount|how many|number of\b/.test(q)) {
    return "invoice_count";
  }
  if (/\b(qty|quantity|units?)\b/.test(q)) return "quantity";
  return "revenue";
}

function inferDimensionFromQuestion(question, fallback = "product") {
  const q = String(question || "").toLowerCase();
  if (/\b(branches|branch|stores?|outlets?|locations?)\b/.test(q)) return "branch";
  if (/\b(departments|department|depts?)\b/.test(q)) return "department";
  if (/\b(categories|category|segments?|division)\b/.test(q)) return "category";
  if (/\bday|daily|date\b/.test(q)) return "date_day";
  if (/\bmonth|monthly\b/.test(q)) return "date_month";
  if (/\b(products?|items?|articles?|skus?)\b/.test(q)) return "product";
  return fallback;
}

function escapeSqlLiteral(v) {
  return String(v || "").replace(/'/g, "''");
}

function normalizeToken(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function textSimilarity(a, b) {
  const x = normalizeToken(a);
  const y = normalizeToken(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const xs = new Set(x.split(" ").filter(Boolean));
  const ys = new Set(y.split(" ").filter(Boolean));
  const inter = [...xs].filter((t) => ys.has(t)).length;
  const union = new Set([...xs, ...ys]).size || 1;
  return inter / union;
}

function parseQuotedFilterValues(question) {
  const q = String(question || "");
  const values = [];
  const re = /"([^"]+)"|'([^']+)'/g;
  let m;
  while ((m = re.exec(q))) {
    const txt = String(m[1] || m[2] || "").trim();
    if (txt) values.push(txt);
  }
  return values;
}

function inferFiltersFromQuestion(question) {
  const q = String(question || "").toLowerCase();
  const rawQ = String(question || "");
  const quoted = parseQuotedFilterValues(question);
  const filters = [];
  for (const v of quoted) {
    if (/\b(branches|branch|stores?|outlets?|locations?)\b/.test(q)) {
      filters.push({ type: "branch", value: v });
    } else if (/\b(departments|department|depts?)\b/.test(q)) {
      filters.push({ type: "department", value: v });
    } else if (/\b(categories|category|segments?|division)\b/.test(q)) {
      filters.push({ type: "category", value: v });
    } else if (/\bin\s+["']/i.test(rawQ) && /\b(products?|items?|articles?|skus?|sales|revenue|amount)\b/.test(q)) {
      filters.push({ type: "branch", value: v });
    }
  }
  return filters;
}

const DISTINCT_CACHE = new Map();

async function fetchDistinctValues(pool, tableName, columnName, limit = 200) {
  const key = `${String(tableName).toLowerCase()}::${String(columnName).toLowerCase()}::${limit}`;
  if (DISTINCT_CACHE.has(key)) return DISTINCT_CACHE.get(key);
  const t = String(tableName || "").replace(/^dbo\./i, "");
  const c = String(columnName || "");
  const q = `
    SELECT TOP (${Math.min(Math.max(parseInt(String(limit), 10) || 200, 10), 500)})
      CAST([${c}] AS NVARCHAR(4000)) AS v
    FROM dbo.[${t}]
    WHERE [${c}] IS NOT NULL
    GROUP BY [${c}]
    ORDER BY COUNT(1) DESC
  `;
  const r = await pool.request().query(q);
  const vals = (r.recordset || []).map((row) => String(row.v || "").trim()).filter(Boolean);
  DISTINCT_CACHE.set(key, vals);
  return vals;
}

async function normalizeFilterValue(pool, tableName, columnName, inputValue) {
  const raw = String(inputValue || "").trim();
  if (!raw) return raw;
  try {
    const candidates = await fetchDistinctValues(pool, tableName, columnName, 250);
    if (!candidates.length) return raw;
    let best = raw;
    let bestScore = 0;
    for (const c of candidates) {
      const s = textSimilarity(raw, c);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return bestScore >= 0.45 ? best : raw;
  } catch (_) {
    return raw;
  }
}

function heuristicIntent(question) {
  const q = String(question || "").toLowerCase();
  const has = (re) => re.test(q);
  const metric = inferMetricFromQuestion(q);
  const inferredFilters = inferFiltersFromQuestion(q);
  const topNMatch = q.match(/\btop\s+(\d+)\b/i);
  if (
    topNMatch &&
    /\b(product|products|item|items|article|articles|sku|skus|branch|branches|department|departments|category|categories)\b/.test(q)
  ) {
    return {
      intent: "top_n",
      metric,
      dimension: inferDimensionFromQuestion(q, "product"),
      source_table: "dbo.VwAISalesData",
      joins: [],
      date_column: "InvoiceDt",
      date_range: has(/\bmtd|this month\b/) ? "mtd" : has(/\bytd|this year\b/) ? "ytd" : has(/\bqtd|this quarter\b/) ? "qtd" : "all_time",
      top_n: safeTopN(topNMatch[1]),
      filters: inferredFilters,
      confidence: "medium",
      clarification_question: null,
    };
  }
  if (/\b(trend|daily|day.?wise|monthly|month.?wise|over time|last 30)\b/.test(q)) {
    return {
      intent: "trend",
      metric,
      dimension: inferDimensionFromQuestion(q, /\bmonth|monthly\b/.test(q) ? "date_month" : "date_day"),
      source_table: "dbo.VwAISalesData",
      joins: [],
      date_column: "InvoiceDt",
      date_range: has(/\blast 30\b/) ? "last_30_days" : has(/\bmtd|this month\b/) ? "mtd" : has(/\bytd|this year\b/) ? "ytd" : "all_time",
      top_n: null,
      filters: inferredFilters,
      confidence: "medium",
      clarification_question: null,
    };
  }
  if (/\b(total|overall|sum)\b/.test(q) && /\b(sales|revenue|amount|invoice)\b/.test(q)) {
    return {
      intent: "kpi",
      metric,
      dimension: null,
      source_table: "dbo.VwAISalesData",
      joins: [],
      date_column: "InvoiceDt",
      date_range: has(/\bmtd|this month\b/) ? "mtd" : has(/\bytd|this year\b/) ? "ytd" : has(/\bqtd|this quarter\b/) ? "qtd" : "all_time",
      top_n: null,
      filters: inferredFilters,
      confidence: "medium",
      clarification_question: null,
    };
  }
  if (/\bby\s+(branch|department|product)\b/.test(q) || /\bbreakdown|distribution\b/.test(q)) {
    return {
      intent: "breakdown",
      metric,
      dimension: inferDimensionFromQuestion(q, "product"),
      source_table: "dbo.VwAISalesData",
      joins: [],
      date_column: "InvoiceDt",
      date_range: has(/\bmtd|this month\b/) ? "mtd" : has(/\bytd|this year\b/) ? "ytd" : has(/\bqtd|this quarter\b/) ? "qtd" : "all_time",
      top_n: null,
      filters: inferredFilters,
      confidence: "medium",
      clarification_question: null,
    };
  }
  return {
    intent: "generic",
    metric: "revenue",
    dimension: null,
    source_table: "dbo.VwAISalesData",
    joins: [],
    date_column: "InvoiceDt",
    date_range: "all_time",
    top_n: null,
    filters: inferredFilters,
    confidence: "low",
    clarification_question: "Do you want total sales, trend, top-N, or breakdown by branch/product/department?",
  };
}

function mapRangeToken(input) {
  const x = String(input || "").toLowerCase().trim();
  if (!x) return "all_time";
  if (["today", "mtd", "qtd", "ytd", "last_30_days", "all_time", "custom"].includes(x)) return x;
  if (["last_month", "previous_month"].includes(x)) return "mtd";
  if (["this_month"].includes(x)) return "mtd";
  if (["this_year", "current_year"].includes(x)) return "ytd";
  return "all_time";
}

function intentFromLogicalPlan(plan, question, dictionary) {
  const q = String(question || "").toLowerCase();
  const metricKeyRaw = Array.isArray(plan?.metrics) ? String(plan.metrics[0] || "revenue") : "revenue";
  const metricKey = dictionary?.metrics?.[metricKeyRaw] ? metricKeyRaw : "revenue";
  const dimRaw = Array.isArray(plan?.dimensions) ? String(plan.dimensions[0] || "") : "";
  let dimKey = dictionary?.dimensions?.[dimRaw] ? dimRaw : null;
  const topMatch = q.match(/\btop\s+(\d+)\b/i);
  const explicitTopN = topMatch ? safeTopN(topMatch[1]) : null;
  if (explicitTopN && !dimKey) {
    const guess = inferDimensionFromQuestion(question, "");
    if (guess && dictionary?.dimensions?.[guess]) dimKey = guess;
  }
  const op = String(plan?.operation || "").toLowerCase();
  const comparisonType = String(plan?.comparison?.type || "").toLowerCase();

  let intent = "generic";
  if (explicitTopN && dimKey) intent = "top_n";
  else if (op === "distribution" || (dimKey && op !== "compare")) intent = "breakdown";
  else if (op === "compare" && comparisonType === "time") intent = "trend";
  else if (op === "aggregate" && !dimKey) intent = "kpi";
  else if (dimKey) intent = "breakdown";

  const rangeToken = plan?.time?.type === "range"
    ? mapRangeToken(Array.isArray(plan?.time?.values) ? plan.time.values[0] : "all_time")
    : "all_time";

  return {
    intent,
    metric: metricKey,
    dimension: intent === "kpi" ? null : dimKey,
    source_table: "dbo.VwAISalesData",
    joins: [],
    date_column: "InvoiceDt",
    date_range: rangeToken,
    top_n: intent === "top_n" ? (explicitTopN || 10) : null,
    filters: Array.isArray(plan?.filters)
      ? plan.filters
          .filter((f) => f && typeof f === "object" && f.type && f.value != null)
          .map((f) => ({ type: String(f.type), value: String(f.value) }))
      : [],
    confidence: ["high", "medium", "low"].includes(String(plan?.confidence || "")) ? String(plan.confidence) : "medium",
    clarification_question: plan?.clarification_question || null,
  };
}

function inferOperationFromQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (/\b(vs|versus|compare|against)\b/.test(q)) return "compare";
  if (/\b(by|breakdown|distribution|split|group)\b/.test(q)) return "distribution";
  return "aggregate";
}

function inferTimeBlock(question) {
  const q = String(question || "").toLowerCase();
  const points = [];
  if (/\btoday\b/.test(q)) points.push("today");
  if (/\byesterday\b/.test(q)) points.push("yesterday");
  for (const iso of extractIsoDatesFromQuestion(question)) points.push(iso);
  const uniquePoints = [...new Set(points)];
  if ((hasComparisonOperator(question) || uniquePoints.length > 1) && uniquePoints.length >= 2) {
    return { type: "points", values: uniquePoints };
  }
  if (/\blast month\b/.test(q)) return { type: "range", values: ["last_month"] };
  if (/\bmonth\s+to\s+date\b/.test(q)) return { type: "range", values: ["mtd"] };
  if (/\bthis month|mtd\b/.test(q)) return { type: "range", values: ["mtd"] };
  if (/\byear\s+to\s+date\b/.test(q)) return { type: "range", values: ["ytd"] };
  if (/\bthis year|current year|ytd\b/.test(q)) return { type: "range", values: ["ytd"] };
  if (/\bquarter\s+to\s+date\b/.test(q)) return { type: "range", values: ["qtd"] };
  if (/\bthis quarter|qtd\b/.test(q)) return { type: "range", values: ["qtd"] };
  if (/\blast 30\b/.test(q)) return { type: "range", values: ["last_30_days"] };
  return { type: "none", values: [] };
}

function inferComparisonBlock(question, timeBlock, dims) {
  const q = String(question || "").toLowerCase();
  const compareWords = /\b(vs|versus|compare|against|and)\b/.test(q);
  if (timeBlock?.type === "points" && timeBlock.values.length >= 2) {
    return { type: "time", values: [...timeBlock.values] };
  }
  if (compareWords && Array.isArray(dims) && dims.length > 0) {
    return { type: "category", values: [...dims] };
  }
  return { type: "none", values: [] };
}

function buildDeterministicLogicalPlan(question, dictionary) {
  const q = String(question || "");
  const qLower = q.toLowerCase();
  const metric = inferMetricFromQuestion(q);
  const dim = inferDimensionFromQuestion(q, "");
  const hasTop = /\b(top|highest|best|leading)\b/.test(qLower);
  const explicitTopN = /\btop\s+\d+\b/.test(qLower);
  const operation = inferOperationFromQuestion(q);
  const dimensions = dim ? [dim] : [];
  const time = inferTimeBlock(q);
  const comparison = inferComparisonBlock(q, time, dimensions);
  const filters = inferFiltersFromQuestion(q);

  let confidence = "high";
  let clarification = null;
  if (metric === "revenue" && !/\b(sale|sales|revenue|amount|value|purchase|qty|quantity|invoice|order|transaction)\b/.test(qLower)) {
    confidence = "medium";
  }
  if (hasTop && !explicitTopN) confidence = "medium";
  if (!dimensions.length && /\bby\b/.test(qLower)) confidence = "medium";
  if (comparison.type !== "none" && comparison.values.length < 2) {
    confidence = "low";
    clarification = "Which values should I compare?";
  }

  // Keep all explicit comparison values; never collapse.
  return {
    operation: operation === "distribution" && !dimensions.length ? "aggregate" : operation,
    metrics: [metric],
    dimensions,
    filters,
    time,
    comparison,
    confidence,
    clarification_question: clarification,
  };
}

function buildLogicalPlanFromIntent(intent, structuredPlan, question) {
  const q = String(question || "").toLowerCase();
  const op = intent?.intent === "trend"
    ? "compare"
    : intent?.intent === "breakdown" || intent?.intent === "top_n"
      ? "distribution"
      : "aggregate";
  const pointValues = structuredPlan?.time_comparison?.mode === "point_set"
    ? (structuredPlan?.time_comparison?.values || []).map((v) => (v === "CURRENT_DATE" ? "today" : v))
    : [];
  const time = pointValues.length >= 2
    ? { type: "points", values: pointValues }
    : { type: "range", values: [String(intent?.date_range || "all_time")] };
  const comparison = time.type === "points"
    ? { type: "time", values: [...time.values] }
    : /\b(vs|versus|compare|against)\b/.test(q)
      ? { type: "category", values: intent?.dimension ? [String(intent.dimension)] : [] }
      : { type: "none", values: [] };
  return {
    operation: op,
    metrics: [String(intent?.metric || "revenue")],
    dimensions: intent?.dimension ? [String(intent.dimension)] : (structuredPlan?.group_by || []),
    time,
    comparison,
    filters: Array.isArray(intent?.filters) ? intent.filters : [],
    confidence: String(intent?.confidence || "medium"),
    clarification_question: intent?.clarification_question || null,
  };
}

function resolveSemanticPlan(logicalPlan, dictionary, semanticGraph) {
  const metricKey = logicalPlan?.metrics?.[0] || "revenue";
  const metricDef = dictionary?.metrics?.[metricKey];
  if (!metricDef) return null;
  const dimensionKey = logicalPlan?.dimensions?.[0] || null;
  const dimDef = dimensionKey ? dictionary?.dimensions?.[dimensionKey] : null;
  const metricGraph = semanticGraph?.metrics?.[metricKey] || null;
  const dimGraph = dimensionKey ? semanticGraph?.dimensions?.[dimensionKey] : null;
  return {
    metricKey,
    metricDef,
    metricGraph,
    dimensionKey,
    dimDef,
    dimGraph,
    intent: logicalPlan?.intent || "generic",
    dateRange: logicalPlan?.time?.type === "range"
      ? String(logicalPlan?.time?.values?.[0] || "all_time")
      : "all_time",
    topN: logicalPlan?.top_n || 10,
    filters: Array.isArray(logicalPlan?.filters) ? logicalPlan.filters : [],
  };
}

/** Indian FY quarter start for QTD (matches dashboard Home logic). Q4 = Jan–Mar → 1 Jan of current calendar year. */
function getIndianFyQtdStart(now = new Date()) {
  const yr = now.getFullYear();
  const mo = now.getMonth(); // 0=Jan … 11=Dec
  if (mo >= 9) return new Date(yr, 9, 1);
  if (mo >= 6) return new Date(yr, 6, 1);
  if (mo >= 3) return new Date(yr, 3, 1);
  return new Date(yr, 0, 1);
}

function dateFilterSql(dateRange, fromDate, toDate) {
  const baseCol = "CAST(s.InvoiceDt AS date)";
  if (fromDate && toDate) {
    return `${baseCol} BETWEEN '${fromDate}' AND '${toDate}'`;
  }
  switch (String(dateRange || "all_time")) {
    case "today":
      return `${baseCol} = CAST(GETDATE() AS date)`;
    case "mtd":
      return `YEAR(s.InvoiceDt)=YEAR(GETDATE()) AND MONTH(s.InvoiceDt)=MONTH(GETDATE())`;
    case "qtd":
      return `${baseCol} >= DATEFROMPARTS(
        CASE
          WHEN MONTH(GETDATE()) BETWEEN 4 AND 6 THEN YEAR(GETDATE())
          WHEN MONTH(GETDATE()) BETWEEN 7 AND 9 THEN YEAR(GETDATE())
          WHEN MONTH(GETDATE()) BETWEEN 10 AND 12 THEN YEAR(GETDATE())
          ELSE YEAR(GETDATE())
        END,
        CASE
          WHEN MONTH(GETDATE()) BETWEEN 4 AND 6 THEN 4
          WHEN MONTH(GETDATE()) BETWEEN 7 AND 9 THEN 7
          WHEN MONTH(GETDATE()) BETWEEN 10 AND 12 THEN 10
          ELSE 1
        END,
        1
      ) AND ${baseCol} <= CAST(GETDATE() AS date)`;
    case "ytd":
      return `${baseCol} >= DATEFROMPARTS(CASE WHEN MONTH(GETDATE())>=4 THEN YEAR(GETDATE()) ELSE YEAR(GETDATE())-1 END, 4, 1) AND ${baseCol} <= CAST(GETDATE() AS date)`;
    case "last_30_days":
      return `${baseCol} >= DATEADD(day, -30, CAST(GETDATE() AS date))`;
    case "last_month":
      return `${baseCol} >= DATEADD(month, DATEDIFF(month, 0, GETDATE()) - 1, 0)
        AND ${baseCol} < DATEADD(month, DATEDIFF(month, 0, GETDATE()), 0)`;
    default:
      return "1=1";
  }
}

/**
 * One-row KPI with multiple aggregates (MTD net sales + distinct customers + distinct invoices).
 * Uses the same date window as single-metric KPIs (fromDate/toDate or inferTimeBlock).
 */
function buildCompoundSalesKpiSql(question, fromDate, toDate) {
  const q = String(question || "").toLowerCase();
  const wantsNet = /\b(sale|sales|revenue|net\s*sale|amount|turnover)\b/.test(q);
  const wantsCust =
    (/\b(customer|customers)\b/.test(q) &&
      /\b(count|counts|counting|unique|distinct|how many|number of)\b/.test(q)) ||
    (/\bunique\b/.test(q) && /\b(customer|customers)\b/.test(q));
  const wantsInv =
    (/\b(invoice|invoices|bill|bills)\b/.test(q) && /\b(count|counts|how many|number of)\b/.test(q)) ||
    (/\b(transaction|transactions)\b/.test(q) && /\b(count|how many|number of)\b/.test(q));

  const parts = [];
  if (wantsNet) parts.push("CAST(SUM(ISNULL(s.SaleNetAmount,0)) AS DECIMAL(38,4)) AS NetSales");
  if (wantsCust) parts.push("COUNT(DISTINCT s.CustomerId) AS UniqueCustomerCount");
  if (wantsInv) parts.push("COUNT(DISTINCT s.InvoiceNo) AS InvoiceCount");
  /* Single-metric KPIs (e.g. "MTD Sales", "Unique Customer count") must still hit this fast path. */
  if (parts.length < 1) return null;

  const qTrim = String(question || "");
  let dateRange = /\b(all\s*time|lifetime|since\s+beginning|ever|full\s+history)\b/i.test(qTrim)
    ? "all_time"
    : "mtd";
  const tb = inferTimeBlock(qTrim);
  if (tb.type === "range" && tb.values && tb.values[0]) dateRange = String(tb.values[0]);
  const where = dateFilterSql(dateRange, fromDate, toDate);
  return `SELECT ${parts.join(", ")} FROM dbo.VwAISalesData s WHERE ${where}`;
}

async function parseIntentStrict({ apiKey, model, question, dictionary, schemaMeta }) {
  const openai = new OpenAI({ apiKey });
  const intents = dictionary?.intents || [];
  const allowedIntents = intents.join(", ");
  const allowedMetrics = Object.keys(dictionary?.metrics || {}).join(", ");
  const allowedDims = Object.keys(dictionary?.dimensions || {}).join(", ");
  const allowedRanges = (dictionary?.dateRanges || []).join(", ");

  const system = [
    "You are a BI query planner.",
    "Return ONLY JSON logical plan. Never generate SQL.",
    "Never output execution logic or fixed table/column assumptions.",
    "Preserve all user-specified comparison values. Do not collapse them.",
    "If multiple dates are provided with vs/compare/against, use time.type='points' and keep each point.",
    "If ambiguous, set confidence='low' and ask clarification_question.",
    `Allowed metrics hints: ${allowedMetrics}`,
    `Allowed dimensions hints: ${allowedDims}`,
    `Allowed date ranges hints: ${allowedRanges}`,
  ].join("\n");

  const objectLines = (schemaMeta?.objects || []).map((o) => {
    const cols = (o.columns || []).slice(0, 18).map((c) => `${c.name}:${c.type}`).join(", ");
    return `- ${o.name} (${o.type}) => ${cols}`;
  }).join("\n");
  const relLines = (schemaMeta?.relationships || []).slice(0, 30).map((r) => `- ${r.from} -> ${r.to}`).join("\n");

  const user = [
    `Schema metadata (dynamic):`,
    objectLines || "(none)",
    `Relationships:`,
    relLines || "(none)",
    `Semantic dictionary metrics: ${allowedMetrics}`,
    `Semantic dictionary dimensions: ${allowedDims}`,
    `User query: ${String(question || "").slice(0, 1200)}`,
  ].join("\n");

  const { openAiOmitsTemperature } = require("./llm-params");
  const modelId = model || "gpt-4o-mini";
  const completion = await openai.chat.completions.create({
    model: modelId,
    ...(openAiOmitsTemperature(modelId) ? {} : { temperature: 0 }),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "intent_payload",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            operation: { type: "string" },
            metrics: { type: "array", items: { type: "string" } },
            dimensions: { type: "array", items: { type: "string" } },
            filters: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { type: "string" },
                  value: { type: "string" },
                },
                required: ["type", "value"],
              },
            },
            time: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string" },
                values: { type: "array", items: { type: "string" } },
              },
              required: ["type", "values"],
            },
            comparison: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string" },
                values: { type: "array", items: { type: "string" } },
              },
              required: ["type", "values"],
            },
            confidence: { type: "string" },
            clarification_question: { type: ["string", "null"] },
          },
          required: [
            "operation",
            "metrics",
            "dimensions",
            "filters",
            "time",
            "comparison",
            "confidence",
            "clarification_question",
          ],
        },
      },
    },
  });
  const raw = completion.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);
  return parsed;
}

function validateIntent(parsed, dictionary) {
  const allowedOps = new Set(["aggregate", "compare", "distribution"]);
  const allowedTimeTypes = new Set(["none", "range", "points"]);
  const allowedComparisonTypes = new Set(["none", "time", "category"]);
  const allowedMetrics = new Set(Object.keys(dictionary?.metrics || {}));
  const allowedDims = new Set(Object.keys(dictionary?.dimensions || {}));
  if (!allowedOps.has(String(parsed?.operation || ""))) return false;
  if (!Array.isArray(parsed?.metrics) || parsed.metrics.length < 1) return false;
  if (!parsed.metrics.every((m) => allowedMetrics.has(String(m)))) return false;
  if (!Array.isArray(parsed?.dimensions)) return false;
  if (!parsed.dimensions.every((d) => allowedDims.has(String(d)))) return false;
  if (!Array.isArray(parsed.filters)) return false;
  if (!parsed.filters.every((f) => f && typeof f === "object" && typeof f.type === "string" && typeof f.value === "string")) return false;
  if (!parsed.time || !allowedTimeTypes.has(String(parsed.time.type || "")) || !Array.isArray(parsed.time.values)) return false;
  if (!parsed.comparison || !allowedComparisonTypes.has(String(parsed.comparison.type || "")) || !Array.isArray(parsed.comparison.values)) return false;
  if (!["high", "medium", "low"].includes(String(parsed.confidence || ""))) return false;
  if (!(parsed.clarification_question == null || typeof parsed.clarification_question === "string")) return false;
  return true;
}

async function scoreDimensionCandidate(pool, dimDef, candidateCol, whereSql) {
  const fromJoin = dimDef?.join || "dbo.VwAISalesData s";
  const alias = /\s+d\b/i.test(fromJoin) ? "d" : "s";
  const expr = `${alias}.[${candidateCol}]`;
  const q = [
    `SELECT`,
    `  COUNT(1) AS TotalRows,`,
    `  SUM(CASE WHEN ${expr} IS NULL OR LTRIM(RTRIM(CAST(${expr} AS NVARCHAR(4000)))) = '' THEN 1 ELSE 0 END) AS NullRows,`,
    `  COUNT(DISTINCT ${expr}) AS DistinctRows`,
    `FROM ${fromJoin}`,
    `WHERE ${whereSql || "1=1"}`,
  ].join("\n");
  const r = await pool.request().query(q);
  const row = r.recordset?.[0] || {};
  const total = Number(row.TotalRows || 0);
  const nullRows = Number(row.NullRows || 0);
  const distinctRows = Number(row.DistinctRows || 0);
  if (total <= 0) return -1;
  const nonNullRatio = Math.max(0, (total - nullRows) / total);
  const distinctRatio = Math.max(0, Math.min(1, distinctRows / Math.max(total, 1)));
  return nonNullRatio * 0.75 + distinctRatio * 0.25;
}

async function resolveDimensionColumn(pool, dimDef, whereSql) {
  if (!dimDef?.columnCandidates?.length) return null;
  const tableName = String(dimDef.table || "").replace(/^dbo\./i, "");
  const r = await pool.request().input("t", tableName).query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@t
  `);
  const cols = new Set((r.recordset || []).map((x) => String(x.COLUMN_NAME).toLowerCase()));
  const available = dimDef.columnCandidates.filter((c) => cols.has(String(c).toLowerCase()));
  if (!available.length) return null;
  let best = available[0];
  let bestScore = -1;
  for (const c of available) {
    try {
      const s = await scoreDimensionCandidate(pool, dimDef, c, whereSql);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    } catch (_) {
      // fall through to default ordering
    }
  }
  return best;
}

function joinCandidatesForDimension(dimKey, dimDef) {
  const out = [];
  if (dimDef?.join) out.push(dimDef.join);
  if (dimKey === "product" || dimKey === "category") {
    out.push("dbo.VwAISalesData s INNER JOIN dbo.VwMstItems d ON s.ItemId = d.ItemId");
  }
  if (dimKey === "branch") {
    out.push("dbo.VwAISalesData s LEFT JOIN dbo.VwAIBranch d ON s.BranchId = d.BranchId");
    out.push("dbo.VwAISalesData s");
  }
  if (dimKey === "department") {
    out.push("dbo.VwAISalesData s INNER JOIN dbo.VwMstItems d ON s.ItemId = d.ItemId");
  }
  // Deduplicate while preserving order.
  return [...new Set(out.filter(Boolean))];
}

function joinCandidatesWithGraph(dimKey, dimDef, schemaMeta) {
  const base = joinCandidatesForDimension(dimKey, dimDef);
  if (base.length > 0) return base;
  const target = String(dimDef?.table || "").trim();
  if (!target) return ["dbo.VwAISalesData s"];
  const path = findJoinPath(schemaMeta, "dbo.VwAISalesData", target);
  if (!path.length) return ["dbo.VwAISalesData s"];
  const joins = ["dbo.VwAISalesData s"];
  for (const hop of path) {
    joins.push(`LEFT JOIN ${hop.table} ON ${hop.on}`);
  }
  return [joins.join(" ")];
}

async function scoreJoinCandidate(pool, joinSql, labelCol, whereSql) {
  const hasDAlias = /\s+d\b/i.test(joinSql);
  const labelExpr = hasDAlias ? `d.[${labelCol}]` : `s.[${labelCol}]`;
  const q = [
    `SELECT`,
    `  COUNT(1) AS TotalRows,`,
    `  SUM(CASE WHEN ${labelExpr} IS NULL OR LTRIM(RTRIM(CAST(${labelExpr} AS NVARCHAR(4000)))) = '' THEN 1 ELSE 0 END) AS NullRows,`,
    `  COUNT(DISTINCT ${labelExpr}) AS DistinctRows`,
    `FROM ${joinSql}`,
    `WHERE ${whereSql || "1=1"}`,
  ].join("\n");
  const r = await pool.request().query(q);
  const row = r.recordset?.[0] || {};
  const total = Number(row.TotalRows || 0);
  const nullRows = Number(row.NullRows || 0);
  const distinctRows = Number(row.DistinctRows || 0);
  if (total <= 0) return -1;
  const nonNullRatio = Math.max(0, (total - nullRows) / total);
  const distinctRatio = Math.max(0, Math.min(1, distinctRows / Math.max(total, 1)));
  return nonNullRatio * 0.8 + distinctRatio * 0.2;
}

async function pickBestJoinAndLabel(pool, dimKey, dimDef, whereSql, schemaMeta) {
  const candidates = joinCandidatesWithGraph(dimKey, dimDef, schemaMeta);
  if (!candidates.length) return { joinSql: dimDef?.join || "dbo.VwAISalesData s", labelCol: null };

  let best = { joinSql: candidates[0], labelCol: null, score: -1 };
  for (const joinSql of candidates) {
    const localDim = { ...dimDef, join: joinSql };
    const col = await resolveDimensionColumn(pool, localDim, whereSql);
    if (!col) continue;
    let score = -1;
    try {
      score = await scoreJoinCandidate(pool, joinSql, col, whereSql);
    } catch (_) {
      score = 0;
    }
    if (score > best.score) {
      best = { joinSql, labelCol: col, score };
    }
  }
  return { joinSql: best.joinSql, labelCol: best.labelCol };
}

async function getDailyPreAggregate(pool) {
  if (Date.now() - preAggDaily.ts < PREAGG_TTL_MS && Array.isArray(preAggDaily.rows) && preAggDaily.rows.length) {
    return preAggDaily.rows;
  }
  const horizon = Math.min(
    Math.max(parseInt(String(process.env.PREAGG_DAILY_HISTORY_DAYS || "800"), 10) || 800, 14),
    4000
  );
  const q = `
    SELECT
      CAST(InvoiceDt AS date) AS SaleDate,
      SUM(ISNULL(SaleNetAmount, 0)) AS Revenue,
      SUM(ISNULL(Quantity, 0)) AS Quantity,
      COUNT(DISTINCT InvoiceNo) AS InvoiceCount
    FROM dbo.VwAISalesData
    WHERE CAST(InvoiceDt AS date) >= DATEADD(day, -${horizon}, CAST(GETDATE() AS date))
    GROUP BY CAST(InvoiceDt AS date)
    ORDER BY CAST(InvoiceDt AS date)
  `;
  const r = await pool.request().query(q);
  preAggDaily = { ts: Date.now(), rows: r.recordset || [] };
  return preAggDaily.rows;
}

function buildKpiSql(metricDef, whereSql) {
  if (metricDef.aggregation === "COUNT_DISTINCT") {
    return `SELECT COUNT(DISTINCT s.[${metricDef.column}]) AS ${metricDef.label.replace(/\s+/g, "")} FROM dbo.VwAISalesData s WHERE ${whereSql}`;
  }
  return `SELECT ${metricDef.aggregation}(ISNULL(s.[${metricDef.column}],0)) AS ${metricDef.label.replace(/\s+/g, "")} FROM dbo.VwAISalesData s WHERE ${whereSql}`;
}

function buildTrendSql(metricDef, dimDef, whereSql) {
  const expr = dimDef?.expression || "CAST(s.InvoiceDt AS date)";
  const orderBy = dimDef?.orderBy || expr;
  const aggExpr =
    metricDef.aggregation === "COUNT_DISTINCT"
      ? `CAST(COUNT(DISTINCT s.[${metricDef.column}]) AS DECIMAL(38,4))`
      : `${metricDef.aggregation}(ISNULL(s.[${metricDef.column}],0))`;
  return [
    `SELECT ${expr} AS Period,`,
    `  ${aggExpr} AS Value`,
    `FROM dbo.VwAISalesData s`,
    `WHERE ${whereSql}`,
    `GROUP BY ${expr}`,
    `ORDER BY ${orderBy}`,
  ].join("\n");
}

function buildTopNSql(metricDef, labelCol, whereSql, topN) {
  const labelExpr = `ISNULL(NULLIF(LTRIM(RTRIM(d.[${labelCol}])),''),'Unknown')`;
  return [
    `SELECT TOP ${safeTopN(topN)}`,
    `  ${labelExpr} AS Label,`,
    `  ${metricDef.aggregation}(ISNULL(s.[${metricDef.column}],0)) AS Value`,
    `FROM dbo.VwAISalesData s`,
    `INNER JOIN dbo.VwMstItems d ON s.ItemId = d.ItemId`,
    `WHERE ${whereSql}`,
    `GROUP BY ${labelExpr}`,
    `HAVING ${metricDef.aggregation}(ISNULL(s.[${metricDef.column}],0)) > 0`,
    `ORDER BY Value DESC`,
  ].join("\n");
}

function buildTopNSqlByDimension(metricDef, dimDef, labelCol, whereSql, topN) {
  const fromJoin = dimDef?.join || "dbo.VwAISalesData s";
  const hasDAlias = /\s+d\b/i.test(fromJoin);
  const srcAlias = hasDAlias ? "d" : "s";
  const labelExpr = `ISNULL(NULLIF(LTRIM(RTRIM(${srcAlias}.[${labelCol}])),''),'Unknown')`;
  return [
    `SELECT TOP ${safeTopN(topN)}`,
    `  ${labelExpr} AS Label,`,
    `  ${metricDef.aggregation}(ISNULL(s.[${metricDef.column}],0)) AS Value`,
    `FROM ${fromJoin}`,
    `WHERE ${whereSql}`,
    `GROUP BY ${labelExpr}`,
    `HAVING ${metricDef.aggregation}(ISNULL(s.[${metricDef.column}],0)) > 0`,
    `ORDER BY Value DESC`,
  ].join("\n");
}

async function buildFilterClause(pool, dimDef, filters) {
  const out = [];
  const fromJoin = dimDef?.join || "dbo.VwAISalesData s";
  const hasDAlias = /\s+d\b/i.test(fromJoin);
  const dimTable = String(dimDef?.table || "").toLowerCase();
  for (const f of (filters || [])) {
    const val = String(f?.value || "").trim();
    if (!val) continue;
    let resolved = val;
    if (f.type === "branch") {
      const branchIsDimTable = dimTable.includes("branch");
      // Prefer d alias columns (BranchName, BranchShortName) when join provides them.
      if (hasDAlias && branchIsDimTable) {
        const branchLookupTable = String(dimDef?.table || "dbo.VwAIBranch").replace(/^dbo\./i, "");
        resolved = await normalizeFilterValue(pool, branchLookupTable, "BranchName", val);
        const esc = escapeSqlLiteral(resolved);
        out.push(`(CAST(d.[BranchName] AS NVARCHAR(200)) LIKE '%${esc}%' OR CAST(d.[BranchShortName] AS NVARCHAR(200)) LIKE '%${esc}%')`);
      } else {
        // Fallback: correlated lookup in VwAIBranch
        const esc = escapeSqlLiteral(val);
        out.push(`EXISTS (SELECT 1 FROM dbo.VwAIBranch b WHERE b.BranchId=s.BranchId AND (CAST(b.[BranchName] AS NVARCHAR(200)) LIKE '%${esc}%' OR CAST(b.[BranchShortName] AS NVARCHAR(200)) LIKE '%${esc}%'))`);
      }
    } else if (f.type === "department") {
      // Department column lives in VwMstItems (joined as d), not VwAISalesData.
      if (hasDAlias) {
        const deptCol = dimDef?.columnCandidates?.[0] || "InvDepartmentShortName";
        const deptTable = String(dimDef?.table || "dbo.VwMstItems").replace(/^dbo\./i, "");
        resolved = await normalizeFilterValue(pool, deptTable, deptCol, val);
        const esc = escapeSqlLiteral(resolved);
        out.push(`CAST(d.[${deptCol}] AS NVARCHAR(200)) LIKE '%${esc}%'`);
      } else {
        // Fallback: filter by InvDepartmentShortName on the items join when no d alias
        const esc = escapeSqlLiteral(val);
        out.push(`EXISTS (SELECT 1 FROM dbo.VwMstItems m WHERE m.ItemId=s.ItemId AND CAST(m.[InvDepartmentShortName] AS NVARCHAR(200)) LIKE '%${esc}%')`);
      }
    } else if (f.type === "category") {
      // Category column lives in VwMstItems (joined as d).
      if (hasDAlias) {
        const categoryCol = dimDef?.columnCandidates?.[0] || "InvCategoryName";
        const categoryTable = String(dimDef?.table || "dbo.VwMstItems").replace(/^dbo\./i, "");
        resolved = await normalizeFilterValue(pool, categoryTable, categoryCol, val);
        const esc = escapeSqlLiteral(resolved);
        out.push(`CAST(d.[${categoryCol}] AS NVARCHAR(200)) LIKE '%${esc}%'`);
      } else {
        // Fallback: correlated subquery against VwMstItems
        const esc = escapeSqlLiteral(val);
        out.push(`EXISTS (SELECT 1 FROM dbo.VwMstItems m WHERE m.ItemId=s.ItemId AND CAST(m.[InvCategoryName] AS NVARCHAR(200)) LIKE '%${esc}%')`);
      }
    }
  }
  return out;
}

function combineWhere(baseWhere, extraClauses) {
  const extras = (extraClauses || []).filter(Boolean);
  if (!extras.length) return baseWhere || "1=1";
  return `(${baseWhere || "1=1"}) AND (${extras.join(" AND ")})`;
}

function buildBreakdownSql(metricDef, dimDef, labelCol, whereSql) {
  const fromJoin = dimDef.join || "dbo.VwAISalesData s";
  const hasDAlias = /\s+d\b/i.test(fromJoin);
  const labelExpr = labelCol
    ? `ISNULL(NULLIF(LTRIM(RTRIM(${hasDAlias ? "d" : "s"}.[${labelCol}])),''),'Unknown')`
    : "ISNULL(NULLIF(LTRIM(RTRIM(d.InvDepartmentShortName)),''),'Unknown')";
  return [
    `SELECT ${labelExpr} AS Label,`,
    `  ${metricDef.aggregation}(ISNULL(s.[${metricDef.column}],0)) AS Value`,
    `FROM ${fromJoin}`,
    `WHERE ${whereSql}`,
    `GROUP BY ${labelExpr}`,
    `ORDER BY Value DESC`,
  ].join("\n");
}

function validateCompiledSql(sqlText, schemaMeta) {
  const blocked = /\b(insert|update|delete|drop|alter|truncate|merge|exec(?:ute)?)\b/i;
  if (blocked.test(String(sqlText || ""))) {
    throw new Error("unsafe_sql_blocked_keyword");
  }
  if (String(sqlText || "").startsWith("[preaggregate_")) {
    return String(sqlText || "").trim();
  }
  const objects = new Set((schemaMeta?.objects || []).map((o) => String(o.name || "").toLowerCase()));
  const objectCols = new Map();
  for (const o of (schemaMeta?.objects || [])) {
    objectCols.set(
      String(o.name || "").toLowerCase(),
      new Set((o.columns || []).map((c) => String(c.name || "").toLowerCase()))
    );
  }
  const ids = extractSqlIdentifiers(sqlText);
  for (const t of ids.tables) {
    const normalized = String(t || "").toLowerCase().replace(/^\[dbo\]\./, "dbo.").replace(/^dbo\./, "dbo.");
    if (!objects.has(normalized)) {
      throw new Error(`unknown_table_in_sql:${t}`);
    }
  }
  // Light column guard for known aliases s/d against core tables used by templates
  for (const c of ids.columns) {
    const col = String(c.col || "").toLowerCase();
    if (c.alias === "s") {
      const salesCols = objectCols.get("dbo.vwaisalesdata");
      if (salesCols && !salesCols.has(col) && !["invoicedt"].includes(col)) {
        throw new Error(`unknown_sales_column_in_sql:${c.col}`);
      }
    }
    if (c.alias === "d") {
      const dimCols =
        objectCols.get("dbo.vwmstitems") ||
        objectCols.get("dbo.vwmstbranchentry") ||
        objectCols.get("dbo.vwaisalesdata");
      if (dimCols && !dimCols.has(col)) {
        throw new Error(`unknown_dimension_column_in_sql:${c.col}`);
      }
    }
  }
  return String(sqlText || "").trim();
}

function reliabilityCheck(intent, rows, topN) {
  const out = { ok: true, reason: "" };
  if (!Array.isArray(rows)) return { ok: false, reason: "non_array_result" };
  if (rows.length === 0 && intent !== "kpi") return { ok: false, reason: "empty_result" };
  if (rows.length > 0 && (intent === "top_n" || intent === "breakdown")) {
    const firstKey = Object.keys(rows[0] || {})[0];
    if (firstKey) {
      const labels = rows.map((r) => String(r[firstKey] == null ? "" : r[firstKey]).trim().toLowerCase());
      const nullLike = labels.filter((s) => !s || s === "unknown" || s === "null" || s === "undefined").length;
      if (nullLike / rows.length > 0.3) {
        return { ok: false, reason: "null_heavy_dimension" };
      }
      if (labels.length > 3) {
        const unique = new Set(labels.filter(Boolean));
        if (unique.size <= Math.max(1, Math.floor(labels.length * 0.25))) {
          return { ok: false, reason: "low_entropy_labels" };
        }
      }
      const dupMap = new Map();
      for (const s of labels.filter(Boolean)) dupMap.set(s, (dupMap.get(s) || 0) + 1);
      const maxDup = Math.max(0, ...dupMap.values());
      if (maxDup > Math.max(2, Math.ceil(rows.length * 0.55))) {
        return { ok: false, reason: "duplicate_label_dominance" };
      }
    }
    const valueKey = Object.keys(rows[0] || {}).find((k) => typeof rows[0][k] === "number") || Object.keys(rows[0] || {})[1];
    if (valueKey) {
      const vals = rows
        .map((r) => Number(r[valueKey]))
        .filter((v) => Number.isFinite(v) && v >= 0)
        .sort((a, b) => a - b);
      if (vals.length >= 4) {
        const p50 = vals[Math.floor(vals.length * 0.5)];
        const p90 = vals[Math.floor(vals.length * 0.9)];
        if (p50 > 0 && p90 / p50 > 60) {
          return { ok: false, reason: "extreme_outlier_distribution" };
        }
      }
    }
  }
  if (intent === "top_n") {
    if (!rows.length) return { ok: false, reason: "empty_top_n" };
    if (rows.length < Math.max(3, Math.min(safeTopN(topN), 10) / 2)) {
      return { ok: false, reason: "too_few_rows_for_top_n" };
    }
  }
  if (intent === "trend" && rows.length < 2) {
    return { ok: false, reason: "too_few_points_for_trend" };
  }
  if (intent === "breakdown" && rows.length === 0) {
    return { ok: false, reason: "empty_breakdown" };
  }
  return out;
}

function retryPlan(plan, reason) {
  const next = { ...plan, filters: Array.isArray(plan.filters) ? [...plan.filters] : [] };
  if (reason === "too_few_rows_for_top_n" && next.dimension !== "product") {
    next.dimension = "product";
    next.metric = "revenue";
    next.confidence = "medium";
    return next;
  }
  if ((reason === "empty_breakdown" || reason === "empty_top_n" || reason === "empty_result") && next.date_range === "last_30_days") {
    next.date_range = "ytd";
    next.confidence = "medium";
    return next;
  }
  if (reason === "null_heavy_dimension" && next.dimension !== "product") {
    next.dimension = "product";
    next.confidence = "medium";
    return next;
  }
  if (reason === "too_few_rows_for_top_n" && next.date_range === "mtd") {
    next.date_range = "ytd";
    next.confidence = "medium";
    return next;
  }
  if ((reason === "too_few_points_for_trend") && next.date_range === "mtd") {
    next.date_range = "last_30_days";
    next.confidence = "medium";
    return next;
  }
  if ((reason === "empty_breakdown" || reason === "empty_top_n") && Array.isArray(next.filters) && next.filters.length) {
    next.filters = [];
    next.confidence = "medium";
    return next;
  }
  if (reason === "duplicate_label_dominance" && next.dimension !== "category") {
    next.dimension = "category";
    next.confidence = "medium";
    return next;
  }
  if (reason === "low_entropy_labels" && next.dimension !== "branch") {
    next.dimension = "branch";
    next.confidence = "medium";
    return next;
  }
  if (reason === "extreme_outlier_distribution" && next.date_range === "all_time") {
    next.date_range = "ytd";
    next.confidence = "medium";
    return next;
  }
  return null;
}

function buildDeterministicSummary(intent, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "No matching records were found. Try a wider date range or fewer filters.";
  }
  if (intent === "kpi") {
    const first = rows[0] || {};
    const parts = Object.keys(first).map((k) => `${k}: ${first[k]}`);
    return parts.length ? parts.join(" · ") : "KPI computed successfully.";
  }
  const first = rows[0] || {};
  const keys = Object.keys(first);
  const isSortCol = (k) => /^(sortorder|sort_order|rownum|rn)$/i.test(String(k));
  const metricKeys = keys.filter((k) => typeof first[k] === "number" && !isSortCol(k));
  const labelKey =
    keys.find((k) => /period|label|name|month|date|category|branch|product|department/i.test(k) && !metricKeys.includes(k)) ||
    keys.find((k) => !metricKeys.includes(k) && !isSortCol(k)) ||
    keys[0];
  const valueKey = metricKeys[0] || keys.find((k) => typeof first[k] === "number") || keys[1] || keys[0];
  if (intent === "top_n" || intent === "breakdown") {
    return `Top result is ${first[labelKey]} with ${first[valueKey]}. Returned ${rows.length} row(s).`;
  }
  if (intent === "trend") {
    const last = rows[rows.length - 1] || {};
    const lk = metricKeys.length ? labelKey : keys[0];
    const vk = metricKeys.length ? valueKey : keys.find((k) => typeof first[k] === "number") || keys[1];
    return `Trend has ${rows.length} points from ${rows[0][lk]} to ${last[lk]}. Latest value is ${last[vk]}.`;
  }
  return `Returned ${rows.length} row(s).`;
}

function normalizeRowsForIntent(intent, rows, topN) {
  if (!Array.isArray(rows) || !rows.length) return [];
  if (!(intent === "top_n" || intent === "breakdown")) return rows;
  const first = rows[0] || {};
  const keys = Object.keys(first);
  if (keys.some((k) => /^period$/i.test(k)) && keys.some((k) => /^sortorder$/i.test(k))) {
    return rows;
  }
  const isSortCol = (k) => /^(sortorder|sort_order|rownum|rn)$/i.test(String(k));
  const metricKeys = keys.filter((k) => typeof first[k] === "number" && !isSortCol(k));
  const labelKey =
    keys.find((k) => /period|label|name|month|date|category|branch|product|department/i.test(k) && !metricKeys.includes(k)) ||
    keys.find((k) => !metricKeys.includes(k) && !isSortCol(k)) ||
    keys[0];
  const valueKey = metricKeys[0] || keys.find((k) => typeof first[k] === "number") || keys[1];
  if (!labelKey || !valueKey) return rows;

  const byLabel = new Map();
  for (const r of rows) {
    const rawLabel = String(r[labelKey] == null ? "" : r[labelKey]).trim();
    const label = rawLabel || "Unknown";
    const val = Number(r[valueKey]);
    const n = Number.isFinite(val) ? val : 0;
    byLabel.set(label, (byLabel.get(label) || 0) + n);
  }
  const merged = [...byLabel.entries()]
    .map(([label, value]) => ({ [labelKey]: label, [valueKey]: value }))
    .sort((a, b) => Number(b[valueKey] || 0) - Number(a[valueKey] || 0));
  if (intent === "top_n") {
    return merged.slice(0, safeTopN(topN || 10));
  }
  return merged;
}

function buildConfidence(intent, reliability, retriesUsed, rowCount) {
  const reason = String(reliability?.reason || "");
  const benignReason =
    !reason ||
    reason === "fallback_applied" ||
    /_template|_fastpath|_compare|preaggregate|compound_sales/i.test(reason);
  if (reason && !benignReason) return { level: "low", note: reason };
  if (!rowCount) return { level: "low", note: "empty_result" };
  if (retriesUsed >= 2) return { level: "medium", note: "multiple_retries_used" };
  if (intent === "trend" && rowCount < 3) return { level: "medium", note: "limited_trend_points" };
  return { level: "high", note: "" };
}

function humanizeDateRangeToken(dr) {
  const x = String(dr || "").toLowerCase();
  if (x === "mtd") return "Month to date";
  if (x === "ytd") return "Year to date";
  if (x === "qtd") return "Quarter to date";
  if (x === "today") return "Today";
  if (x === "last_30_days") return "Last 30 days";
  if (x === "custom") return "Custom range";
  return String(dr || "");
}

function buildInterpretationForResult({ dictionary, question, structuredPlan, intent, reliability }) {
  const reason = String(reliability?.reason || "");
  const chips = [];
  const qLower = String(question || "").toLowerCase();

  if (reason === "structured_point_set_compare") {
    chips.push("Period comparison");
    const mKey = structuredPlan?.metric || "revenue";
    chips.push(dictionary?.metrics?.[mKey]?.label || mKey);
    for (const v of structuredPlan?.time_comparison?.values || []) {
      if (v === "CURRENT_DATE") chips.push("today");
      else if (v === "YESTERDAY") chips.push("yesterday");
      else chips.push(String(v));
    }
    return { chips: [...new Set(chips)], fastPath: reason };
  }

  if (reason === "period_compare_template_fastpath" || reason === "period_compare_template") {
    chips.push("Today vs other periods");
    return { chips, fastPath: reason };
  }

  if (reason === "sales_purchase_compare_template_fastpath" || reason === "sales_purchase_compare_template") {
    chips.push("Sales vs purchases");
    if (/\bmonthly\b/.test(qLower)) chips.push("Monthly");
    else chips.push("By day");
    if (/\b(this year|current year|ytd)\b/.test(qLower)) chips.push("This year");
    return { chips, fastPath: reason };
  }

  if (reason === "vendor_purchase_topn_template") {
    chips.push("Purchase spend");
    chips.push("Top vendors");
    return { chips, fastPath: reason };
  }

  const mKey = intent?.metric || structuredPlan?.metric || "revenue";
  chips.push(dictionary?.metrics?.[mKey]?.label || mKey);

  const dimKey = intent?.dimension;
  if (dimKey && dictionary?.dimensions?.[dimKey]?.label) {
    chips.push(`By ${dictionary.dimensions[dimKey].label}`);
  }

  const dr = intent?.date_range;
  if (dr && dr !== "all_time") chips.push(humanizeDateRangeToken(dr));

  if (intent?.top_n) chips.push(`Top ${intent.top_n}`);

  for (const f of intent?.filters || []) {
    const t = String(f?.type || "").trim();
    const v = String(f?.value || "").trim();
    if (t && v) chips.push(`${t}: ${v}`);
  }

  const it = String(intent?.intent || "").replace(/_/g, " ").trim();
  if (it && it !== "generic") chips.push(it);

  if (reason === "preaggregate_applied") chips.push("Daily rollup cache");

  const uniq = [];
  const seen = new Set();
  for (const c of chips) {
    const s = String(c).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }
  return { chips: uniq, fastPath: reason || null };
}

async function runDeterministicQuery({ apiKey, model, question, pool, fromDate, toDate }) {
  const dictionaryEarly = loadSemanticDictionary();
  const semanticGraphEarly = loadSemanticGraph();
  const structuredPlanEarly = buildStructuredPlan(question);

  /* Always-on fast patterns (not gated by DETERMINISTIC_LEGACY_TEMPLATES). */
  if (isVendorPurchaseTopNQuestion(question)) {
    const sql = buildVendorPurchaseTopNSql({ objects: [] }, question, fromDate, toDate);
    if (sql) {
      const cacheKey = `sql:${sql}`;
      const rows = getCachedRows(cacheKey) || (await pool.request().query(sql)).recordset || [];
      if (!getCachedRows(cacheKey)) setCachedRows(cacheKey, rows);
      const pintent = { intent: "top_n", confidence: "high", clarification_question: null };
      const prel = { ok: true, reason: "vendor_purchase_topn_template" };
      return {
        handled: true,
        sql,
        data: rows,
        intent: pintent,
        reliability: prel,
        chartPolicy: chartPolicyFromResultShape(rows),
        summary: buildDeterministicSummary("top_n", rows),
        confidence: { level: rows.length ? "high" : "medium", note: rows.length ? "" : "No rows in range — widen dates or check PURXNS data." },
        retriesUsed: 0,
        interpretation: buildInterpretationForResult({
          dictionary: dictionaryEarly,
          question,
          structuredPlan: structuredPlanEarly,
          intent: pintent,
          reliability: prel,
        }),
      };
    }
  }

  // Legacy rigid SQL templates disabled — metadata-driven LangGraph/agentic pipeline handles queries.
  if (!/^(1|true|yes)$/i.test(String(process.env.DETERMINISTIC_LEGACY_TEMPLATES || "0").trim())) {
    return { handled: false, reason: "metadata_driven_pipeline" };
  }

  const dictionary = loadSemanticDictionary();
  if (!dictionary) return { handled: false, reason: "missing_dictionary" };
  const semanticGraph = loadSemanticGraph();

  const structuredPlan = buildStructuredPlan(question);

  /* Compound MTD-style KPIs in one SQL (avoids picking only invoice_count). */
  try {
    const compoundSql = buildCompoundSalesKpiSql(question, fromDate, toDate);
    if (compoundSql) {
      const rows = (await pool.request().query(compoundSql)).recordset || [];
      const pintent = {
        intent: "kpi",
        metric: "compound_sales",
        confidence: "high",
        clarification_question: null,
      };
      const prel = { ok: true, reason: "compound_sales_kpi_template" };
      return {
        handled: true,
        sql: compoundSql,
        data: rows,
        intent: pintent,
        reliability: prel,
        chartPolicy: "kpi_card",
        summary: buildDeterministicSummary("kpi", rows),
        confidence: { level: "high", note: "" },
        retriesUsed: 0,
        interpretation: buildInterpretationForResult({
          dictionary,
          question,
          structuredPlan,
          intent: pintent,
          reliability: prel,
        }),
      };
    }
  } catch (e) {
    console.warn("[deterministic] compound KPI template failed:", e.message);
  }

  /* Multi-date / multi-point comparisons: deterministic UNION ALL, metric from question, all dates kept. */
  if (structuredPlan.time_comparison.mode === "point_set" && structuredPlan.time_comparison.values.length >= 2) {
    const metricDef = dictionary.metrics?.[structuredPlan.metric || "revenue"] || dictionary.metrics?.revenue;
    if (metricDef) {
      const sql = buildPointSetCompareSql(metricDef, "CAST(s.InvoiceDt AS date)", structuredPlan.time_comparison.values);
      const cacheKey = `sql:${sql}`;
      const rows = getCachedRows(cacheKey) || (await pool.request().query(sql)).recordset || [];
      if (!getCachedRows(cacheKey)) setCachedRows(cacheKey, rows);
      const pintent = { intent: "breakdown", confidence: "high", clarification_question: null };
      return {
        handled: true,
        sql,
        data: rows,
        intent: pintent,
        reliability: { ok: true, reason: "structured_point_set_compare" },
        chartPolicy: chartPolicyFromResultShape(rows),
        summary: buildDeterministicSummary("breakdown", rows),
        confidence: { level: "high", note: "" },
        retriesUsed: 0,
        interpretation: buildInterpretationForResult({
          dictionary,
          question,
          structuredPlan,
          intent: pintent,
          reliability: { ok: true, reason: "structured_point_set_compare" },
        }),
      };
    }
  }

  // Template: today + optional last Monday / last month slices (when not expressible as pure point set).
  if (isPeriodCompareQuestion(question)) {
    const sql = buildPeriodCompareSql(question);
    if (sql) {
      const rows = getCachedRows(`sql:${sql}`) || (await pool.request().query(sql)).recordset || [];
      if (!getCachedRows(`sql:${sql}`)) setCachedRows(`sql:${sql}`, rows);
      const pintent = { intent: "breakdown", confidence: "high", clarification_question: null };
      const prel = { ok: true, reason: "period_compare_template_fastpath" };
      return {
        handled: true,
        sql,
        data: rows,
        intent: pintent,
        reliability: prel,
        chartPolicy: chartPolicyFromResultShape(rows),
        summary: buildDeterministicSummary("breakdown", rows),
        confidence: { level: "high", note: "" },
        retriesUsed: 0,
        interpretation: buildInterpretationForResult({ dictionary, question, structuredPlan, intent: pintent, reliability: prel }),
      };
    }
  }
  if (isSalesPurchaseCompareQuestion(question)) {
    try {
      const sql = buildSalesPurchaseCompareSql(question, { objects: [] });
      const rows = getCachedRows(`sql:${sql}`) || (await pool.request().query(sql)).recordset || [];
      if (!getCachedRows(`sql:${sql}`)) setCachedRows(`sql:${sql}`, rows);
      const pintent = { intent: "trend", confidence: "high", clarification_question: null };
      const prel = { ok: true, reason: "sales_purchase_compare_template_fastpath" };
      return {
        handled: true,
        sql,
        data: rows,
        intent: pintent,
        reliability: prel,
        chartPolicy: chartPolicyFromResultShape(rows),
        summary: buildDeterministicSummary("trend", rows),
        confidence: { level: "high", note: "" },
        retriesUsed: 0,
        interpretation: buildInterpretationForResult({ dictionary, question, structuredPlan, intent: pintent, reliability: prel }),
      };
    } catch (e) {
      console.warn("[deterministic] sales-purchase fastpath failed, continuing:", e.message);
    }
  }

  let schemaMeta = { objects: [], relationships: [] };
  try {
    schemaMeta = await buildRuntimeSchemaMetadata(pool, 300);
  } catch (e) {
    // Keep deterministic high-priority templates available even when schema introspection fails.
    console.warn("[deterministic] schema introspection failed, continuing with template-first execution:", e.message);
  }

  if (isPeriodCompareQuestion(question)) {
    const sql = buildPeriodCompareSql(question);
    if (sql) {
      const rows = getCachedRows(`sql:${sql}`) || (await pool.request().query(sql)).recordset || [];
      if (!getCachedRows(`sql:${sql}`)) setCachedRows(`sql:${sql}`, rows);
      const pintent = { intent: "breakdown", confidence: "high", clarification_question: null };
      const prel = { ok: true, reason: "period_compare_template" };
      return {
        handled: true,
        sql,
        data: rows,
        intent: pintent,
        reliability: prel,
        chartPolicy: chartPolicyFromResultShape(rows),
        summary: buildDeterministicSummary("breakdown", rows),
        confidence: { level: "high", note: "" },
        retriesUsed: 0,
        interpretation: buildInterpretationForResult({ dictionary, question, structuredPlan, intent: pintent, reliability: prel }),
      };
    }
  }

  if (isSalesPurchaseCompareQuestion(question)) {
    const sql = buildSalesPurchaseCompareSql(question, schemaMeta);
    const rows = getCachedRows(`sql:${sql}`) || (await pool.request().query(sql)).recordset || [];
    if (!getCachedRows(`sql:${sql}`)) setCachedRows(`sql:${sql}`, rows);
    const pintent = { intent: "trend", confidence: "high", clarification_question: null };
    const prel = { ok: true, reason: "sales_purchase_compare_template" };
    return {
      handled: true,
      sql,
      data: rows,
      intent: pintent,
      reliability: prel,
      chartPolicy: chartPolicyFromResultShape(rows),
      summary: buildDeterministicSummary("trend", rows),
      confidence: { level: "high", note: "" },
      retriesUsed: 0,
      interpretation: buildInterpretationForResult({ dictionary, question, structuredPlan, intent: pintent, reliability: prel }),
    };
  }

  let intent;
  let llmLogicalPlan = null;
  let logicalPlan = buildDeterministicLogicalPlan(question, dictionary);
  if (String(logicalPlan?.confidence || "").toLowerCase() === "low") {
    try {
      llmLogicalPlan = await parseIntentStrict({ apiKey, model, question, dictionary, schemaMeta });
      if (validateIntent(llmLogicalPlan, dictionary)) {
        logicalPlan = llmLogicalPlan;
      }
    } catch (_) {
      // keep deterministic planner output
    }
  }
  try {
    intent = intentFromLogicalPlan(logicalPlan, question, dictionary);
  } catch (_) {
    intent = heuristicIntent(question);
    logicalPlan = buildLogicalPlanFromIntent(intent, structuredPlan, question);
  }

  // Query planner stage: logical plan -> semantic resolution -> SQL templates.
  const semanticPlan = resolveSemanticPlan(logicalPlan, dictionary, semanticGraph);
  if (!semanticPlan) return { handled: false, reason: "unsupported_metric" };

  const metricDef = semanticPlan.metricDef;

  const whereSql = dateFilterSql(semanticPlan.dateRange, fromDate, toDate);
  let workingIntent = {
    ...intent,
    metric: semanticPlan.metricKey,
    dimension: semanticPlan.dimensionKey || intent.dimension,
    date_range: semanticPlan.dateRange,
    filters: semanticPlan.filters,
    top_n: semanticPlan.topN,
    planner: {
      logicalPlan,
      semanticMetric: semanticPlan.metricGraph?.expression || null,
      semanticBaseTable: semanticPlan.metricGraph?.base_table || null,
      semanticDimension: semanticPlan.dimGraph?.column || null,
    },
  };
  let lastReliability = { ok: true, reason: "" };
  let finalSql = null;
  let finalRows = [];
  let retriesUsed = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    let sql = null;
    const where = dateFilterSql(workingIntent.date_range, fromDate, toDate);
    const currentMetric = dictionary.metrics?.[workingIntent.metric || "revenue"] || metricDef;
    if (!currentMetric) return { handled: false, reason: "unsupported_metric_retry" };

    if (workingIntent.intent === "kpi") {
      const kpiWhere = combineWhere(where, []);
      const canUsePreAgg = !workingIntent.filters?.length && !fromDate && !toDate;
      if (canUsePreAgg && ["revenue", "quantity", "invoice_count"].includes(String(workingIntent.metric || ""))) {
        const daily = await getDailyPreAggregate(pool);
        const inRange = (d) => {
          const dt = new Date(d);
          const now = new Date();
          if (workingIntent.date_range === "today") return dt.toDateString() === now.toDateString();
          if (workingIntent.date_range === "last_30_days") {
            const from = new Date(now); from.setDate(from.getDate() - 30);
            return dt >= new Date(from.toDateString()) && dt <= now;
          }
          if (workingIntent.date_range === "mtd") return dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth();
          if (workingIntent.date_range === "qtd") {
            const qStart = getIndianFyQtdStart(now);
            return dt >= qStart && dt <= now;
          }
          if (workingIntent.date_range === "ytd") {
            const fyStart = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1);
            return dt >= fyStart && dt <= now;
          }
          return true;
        };
        const scoped = daily.filter((r) => inRange(r.SaleDate));
        if (workingIntent.metric === "revenue") {
          finalRows = [{ NetSales: scoped.reduce((s, r) => s + Number(r.Revenue || 0), 0) }];
        } else if (workingIntent.metric === "quantity") {
          finalRows = [{ Quantity: scoped.reduce((s, r) => s + Number(r.Quantity || 0), 0) }];
        } else {
          finalRows = [{ InvoiceCount: scoped.reduce((s, r) => s + Number(r.InvoiceCount || 0), 0) }];
        }
        finalSql = "[preaggregate_daily_cache]";
        lastReliability = { ok: true, reason: "preaggregate_applied" };
        break;
      }
      sql = buildKpiSql(currentMetric, kpiWhere);
    } else if (workingIntent.intent === "trend") {
      const dimDef = dictionary.dimensions?.[workingIntent.dimension || "date_day"] || dictionary.dimensions?.date_day;
      const extra = await buildFilterClause(pool, dimDef, workingIntent.filters);
      const fullWhere = combineWhere(where, extra);
      sql = buildTrendSql(currentMetric, dimDef, fullWhere);
    } else if (workingIntent.intent === "top_n") {
      const dimKey = workingIntent.dimension || "product";
      const targetDim = dictionary.dimensions?.[dimKey] || dictionary.dimensions.product;
      const extra = await buildFilterClause(pool, targetDim, workingIntent.filters);
      const fullWhere = combineWhere(where, extra);
      const chosen = await pickBestJoinAndLabel(pool, dimKey, targetDim, fullWhere, schemaMeta);
      const labelCol = chosen.labelCol;
      if (!labelCol) return { handled: false, reason: "missing_topn_label_col" };
      sql = buildTopNSqlByDimension(currentMetric, { ...targetDim, join: chosen.joinSql }, labelCol, fullWhere, workingIntent.top_n || 10);
    } else if (workingIntent.intent === "breakdown") {
      const dimDef = dictionary.dimensions?.[workingIntent.dimension || "department"] || dictionary.dimensions.department;
      const extra = await buildFilterClause(pool, dimDef, workingIntent.filters);
      const fullWhere = combineWhere(where, extra);
      const dimKey = workingIntent.dimension || "department";
      const chosen = await pickBestJoinAndLabel(pool, dimKey, dimDef, fullWhere, schemaMeta);
      sql = buildBreakdownSql(currentMetric, { ...dimDef, join: chosen.joinSql }, chosen.labelCol, fullWhere);
    } else {
      return { handled: false, reason: "intent_not_templated" };
    }

    finalSql = validateCompiledSql(sql, schemaMeta);
    const cacheKey = `sql:${finalSql}`;
    const cached = getCachedRows(cacheKey);
    if (cached) {
      finalRows = cached;
    } else {
      const r = await pool.request().query(finalSql);
      finalRows = r.recordset || [];
      setCachedRows(cacheKey, finalRows);
    }
    lastReliability = reliabilityCheck(workingIntent.intent, finalRows, workingIntent.top_n || 10);
    if (lastReliability.ok) break;
    const retry = retryPlan(workingIntent, lastReliability.reason);
    if (!retry) break;
    workingIntent = retry;
    retriesUsed += 1;
  }

  finalRows = normalizeRowsForIntent(workingIntent.intent, finalRows, workingIntent.top_n || 10);
  const confidence = buildConfidence(workingIntent.intent, lastReliability, retriesUsed, finalRows.length);

  return {
    handled: true,
    sql: finalSql,
    data: finalRows,
    intent: workingIntent,
    reliability: lastReliability,
    chartPolicy: chooseDeterministicChart(workingIntent.intent, finalRows),
    summary: buildDeterministicSummary(workingIntent.intent, finalRows),
    confidence,
    retriesUsed,
    interpretation: buildInterpretationForResult({
      dictionary,
      question,
      structuredPlan,
      intent: workingIntent,
      reliability: lastReliability,
    }),
  };
}

module.exports = { runDeterministicQuery, chartPolicyFromResultShape };
