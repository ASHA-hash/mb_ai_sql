/**
 * Core metadata translation engine — business dictionary + dynamic view ranking.
 * Consumes metadata/db_tables_views_columns.json and metadata/semantic-layer.json.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { loadSchema, formatSchemaForPrompt } = require("./schema-from-json");
const { resolveVendorPurchaseTopNSqlFast } = require("./canonical-purchase-sql");
const { buildSalespersonTopNSql } = require("./canonical-salesperson-sql");
const {
  detectQueryDomain,
  resolveViewForQuestion,
  buildContextAwareSemanticBlock,
  boostRankedViews,
  translateJargonInContext,
} = require("./dynamic-semantic-layer");
const runtimeConfig = require("./runtime-config");

const SEMANTIC_LAYER_PATH = path.join(__dirname, "..", "metadata", "semantic-layer.json");

let _semanticConfig = null;

function loadSemanticConfig() {
  if (_semanticConfig) return _semanticConfig;
  try {
    _semanticConfig = JSON.parse(fs.readFileSync(SEMANTIC_LAYER_PATH, "utf8"));
  } catch (e) {
    console.warn("[metadata-translation] semantic-layer.json:", e.message);
    _semanticConfig = {
      database: "zRetailHQ0",
      target_view: "dbo.VW_MB_POWERBI_APP_REPORT",
      semantic_mappings: { metrics: {}, dimensions: {} },
      forced_date_logic: { target_field: "XnDt", intervals: {} },
    };
  }
  return _semanticConfig;
}

/** @type {Record<string, string>} */
function buildMappingsFromSemanticLayer() {
  const cfg = loadSemanticConfig();
  const out = {};
  const metrics = cfg.semantic_mappings?.metrics || {};
  const dimensions = cfg.semantic_mappings?.dimensions || {};
  for (const [key, def] of Object.entries(metrics)) {
    if (def?.canonical_column) out[key] = def.canonical_column;
  }
  for (const [key, def] of Object.entries(dimensions)) {
    if (def?.canonical_column) out[key] = def.canonical_column;
  }
  return out;
}

const SEMANTIC_TERM_MAPPINGS = buildMappingsFromSemanticLayer();

/**
 * ABSOLUTE TRANSLATION ENVELOPE — dbo.VW_MB_POWERBI_APP_REPORT
 * These are hardcoded ground truths.  Any legacy or colloquial term that
 * touches revenue, quantity, salesperson, store, or date MUST resolve to
 * the canonical column below.  This block is checked FIRST and overrides
 * everything in semantic-layer.json for this view.
 */
const COLUMN_ENVELOPE = {
  // ── Revenue / Sales ──────────────────────────────────────────────────────
  "SaleNetAmount":         "MrpValue",
  "NetSlsNetAmount":       "MrpValue",
  "NetAmount":             "MrpValue",
  "Net Amount":            "MrpValue",
  "Net Sales":             "MrpValue",
  "Net sales":             "MrpValue",
  "Gross revenue":         "MrpValue",
  "Gross Revenue":         "MrpValue",
  "Revenue":               "MrpValue",
  "revenue":               "MrpValue",
  "Sales value":           "MrpValue",
  "Sales Value":           "MrpValue",
  "SalesValue":            "MrpValue",
  "Turnover":              "MrpValue",
  "turnover":              "MrpValue",
  "Total Sales":           "MrpValue",
  "total sales":           "MrpValue",
  "TotalSales":            "MrpValue",
  "Sales":                 "MrpValue",
  "sales":                 "MrpValue",
  "Amount":                "MrpValue",

  // ── Quantity ─────────────────────────────────────────────────────────────
  "Quantity":              "AppQty",
  "quantity":              "AppQty",
  "Qty":                   "AppQty",
  "qty":                   "AppQty",
  "Pcs":                   "AppQty",
  "pcs":                   "AppQty",
  "Pieces":                "AppQty",
  "pieces":                "AppQty",
  "Units":                 "AppQty",
  "units":                 "AppQty",
  "Sales volume":          "AppQty",
  "Quantity sold":         "AppQty",
  "AppQty":                "AppQty",

  // ── Salesperson / Staff ───────────────────────────────────────────────────
  "Salesperson":           "SupplierName",
  "salesperson":           "SupplierName",
  "Sales person":          "SupplierName",
  "Sales rep":             "SupplierName",
  "Staff":                 "SupplierName",
  "staff":                 "SupplierName",
  "Staff member":          "SupplierName",
  "Employee":              "SupplierName",
  "employee":              "SupplierName",
  "StaffName":             "SupplierName",
  "Supplier":              "SupplierName",

  // ── Store / Location ─────────────────────────────────────────────────────
  "Store":                 "BranchAlias",
  "store":                 "BranchAlias",
  "Location":              "BranchAlias",
  "location":              "BranchAlias",
  "Branch":                "BranchAlias",
  "branch":                "BranchAlias",
  "Shop":                  "BranchAlias",
  "shop":                  "BranchAlias",
  "Shop name":             "BranchAlias",
  "BranchId":              "BranchAlias",
  "BranchName":            "BranchAlias",

  // ── Date ─────────────────────────────────────────────────────────────────
  "Date":                  "XnDt",
  "date":                  "XnDt",
  "Sale Date":             "XnDt",
  "Transaction date":      "XnDt",
  "InvoiceDt":             "XnDt",
  "Month":                 "XnDtMonth",  // month label column, not the date column
  "month":                 "XnDtMonth",
  "Month label":           "XnDtMonth",

  // ── Invoice / Bill ───────────────────────────────────────────────────────
  "InvoiceNo":             "XnNo",
  "Invoice":               "XnNo",
  "Bill":                  "XnNo",
  "BillNo":                "XnNo",

  // ── Article / Product ─────────────────────────────────────────────────────
  "Article":               "ArticleNo",
  "article":               "ArticleNo",
  "Articles":              "ArticleNo",
  "SKU":                   "ArticleNo",
  "sku":                   "ArticleNo",
  "Product code":          "ArticleNo",
  "Item code":             "ArticleNo",
  "Style code":            "ArticleNo",
  "Itemcode":              "ArticleNo",

  // ── Garment attributes ─────────────────────────────────────────────────
  "Color":                 "Color",
  "colour":                "Color",
  "Colour":                "Color",
  "Size":                  "Size",
  "Fabric":                "Fabric",
  "fabric":                "Fabric",
  "Material":              "Fabric",
  "SubFabric":             "SubFabric",

  // ── Cost ─────────────────────────────────────────────────────────────────
  "Cost":                  "CostValue",
  "COGS":                  "CostValue",
  "Product cost":          "CostValue",
  "Cost value":            "CostValue",
};

const BUSINESS_TERM_MAPPINGS = {
  ...COLUMN_ENVELOPE,
  // Additional aliases not in COLUMN_ENVELOPE
  "Total investment": "CostValue",
  ...SEMANTIC_TERM_MAPPINGS,
};

const CANONICAL_COLUMNS = [...new Set(Object.values(BUSINESS_TERM_MAPPINGS))];

/**
 * Resolve colloquial metric/dimension jargon to a canonical column name.
 * @param {string} inputTerm
 * @returns {string|null}
 */
function translateJargonToColumn(inputTerm, question, viewName) {
  const raw = String(inputTerm || "").trim();
  if (!raw) return null;

  if (question) {
    const ctxCol = translateJargonInContext(
      raw,
      question,
      viewName || resolveViewForQuestion(question)
    );
    if (ctxCol) return ctxCol;
    const domain = detectQueryDomain(question);
    if (domain === "salesperson" && /salesperson|staff|sales\s*rep|employee/i.test(raw)) {
      return "SalesPersonName";
    }
  }

  const cfg = loadSemanticConfig();
  const metrics = cfg.semantic_mappings?.metrics || {};
  const dimensions = cfg.semantic_mappings?.dimensions || {};

  if (metrics[raw]?.canonical_column) return metrics[raw].canonical_column;
  if (dimensions[raw]?.canonical_column) return dimensions[raw].canonical_column;

  const norm = raw.toLowerCase().replace(/\s+/g, "_");
  const normSpace = raw.toLowerCase().replace(/_/g, " ").trim();

  for (const bucket of [metrics, dimensions]) {
    for (const [key, def] of Object.entries(bucket)) {
      const k = key.toLowerCase();
      if (k === norm || k === normSpace || k.replace(/_/g, " ") === normSpace) {
        return def.canonical_column;
      }
    }
  }

  for (const [alias, col] of Object.entries(BUSINESS_TERM_MAPPINGS)) {
    if (normalizeTerm(alias) === normalizeTerm(raw)) return col;
  }

  return null;
}

/**
 * T-SQL date predicate for mtd|qtd|ytd|30d|90d|180d|today|yesterday (Indian FY for ytd/qtd).
 * @param {string} intervalKey
 * @param {{ qualify?: string }} [opts] — qualify=true → CAST([XnDt] AS date)
 */
function getForcedDatePredicate(intervalKey, opts = {}) {
  const cfg = loadSemanticConfig();
  const field = cfg.forced_date_logic?.target_field || "XnDt";
  const intervals = cfg.forced_date_logic?.intervals || {};
  const key = String(intervalKey || "").toLowerCase().trim();
  let pred = intervals[key];
  if (!pred) return null;

  if (opts.qualify === true && !/\bCAST\s*\(/i.test(pred)) {
    pred = pred.replace(/\bXnDt\b/g, `CAST([${field}] AS date)`);
  }
  return pred;
}

function buildSemanticMappingsPromptBlock(question, viewName) {
  if (question) {
    const dynamic = buildContextAwareSemanticBlock(question, viewName);
    const cfg = loadSemanticConfig();
    return [
      dynamic,
      "",
      "### GLOBAL ALIASES (fallback only — prefer view-specific roles above)",
      `Default target_view in JSON: ${cfg.target_view || "dbo.VW_MB_POWERBI_APP_REPORT"}`,
      `Database: ${cfg.database || "zRetailHQ0"}`,
    ].join("\n");
  }

  const cfg = loadSemanticConfig();
  const lines = [
    "### SEMANTIC GROUND TRUTH (metadata/semantic-layer.json)",
    `Target view: ${cfg.target_view || "dbo.VW_MB_POWERBI_APP_REPORT"}`,
    `Database: ${cfg.database || "zRetailHQ0"}`,
    "",
    "Metrics (plain English → column):",
  ];

  for (const [k, def] of Object.entries(cfg.semantic_mappings?.metrics || {})) {
    lines.push(`- ${k} → ${def.canonical_column}: ${def.description || ""}`);
  }
  lines.push("", "Dimensions:");
  for (const [k, def] of Object.entries(cfg.semantic_mappings?.dimensions || {})) {
    lines.push(`- ${k} → ${def.canonical_column}: ${def.description || ""}`);
  }

  const intervals = cfg.forced_date_logic?.intervals || {};
  if (Object.keys(intervals).length) {
    lines.push("", "Forced date filters (use on XnDt):");
    for (const [k, sql] of Object.entries(intervals)) {
      lines.push(`- ${k}: ${sql}`);
    }
  }

  return lines.join("\n");
}

const LOGICAL_GROUP_DIMENSIONS = [
  "BranchAlias",
  "XnDtMonth",
  "DepartmentShortName",
  "CategoryShortName",
  "SupplierName",
  "SupplierAlias",
  "ArticleNo",
  "Color",
  "Size",
  "Fabric",
];

const RAW_SCAN_TOP = 100;
const AGGREGATE_RESULT_TOP = 1000;
const DEFAULT_SCHEMA_TOP_VIEWS = 1;

/** Pre-validated SQL — bypasses LLM intent/SQL nodes when matched (exact or fuzzy). */
const EXACT_MATCH_CACHE = {
  "total sales today":
    "SELECT SUM(MrpValue) AS TotalSales FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK) WHERE CAST(XnDt AS date) = CAST(GETDATE() AS date)",
  "sales today":
    "SELECT SUM(MrpValue) AS TotalSales FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK) WHERE CAST(XnDt AS date) = CAST(GETDATE() AS date)",
  "sales by store yesterday": null,
  "turnover by store yesterday": null,
  "total sales yesterday":
    "SELECT SUM(MrpValue) AS TotalSales FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK) WHERE CAST(XnDt AS date) = DATEADD(day, -1, CAST(GETDATE() AS date))",
  "sales volume today":
    "SELECT SUM(AppQty) AS TotalVolume FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK) WHERE CAST(XnDt AS date) = CAST(GETDATE() AS date)",
  "top 10 salespersons by gross revenue this month": buildSalespersonTopNSql(
    "top 10 salespersons by gross revenue this month"
  ),
  "top salespersons by gross revenue this month": buildSalespersonTopNSql(
    "top 20 salespersons by gross revenue this month"
  ),
  "highest revenue salesperson this month": buildSalespersonTopNSql(
    "top 10 highest revenue salesperson this month"
  ),
  "highest revenue salesperson this month by salenetamount": buildSalespersonTopNSql(
    "top 10 highest revenue salesperson this month"
  ),
  "top 5 branches by net sales this month":
    "SELECT TOP 5 BranchAlias AS Branch, SUM(MrpValue) AS TotalSales FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK) WHERE CAST(XnDt AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST(XnDt AS date) <= CAST(GETDATE() AS date) GROUP BY BranchAlias ORDER BY TotalSales DESC",
  "top 10 vendors by purchase amount this month": resolveVendorPurchaseTopNSqlFast(
    "top 10 vendors by purchase amount this month"
  ),
  "top vendors by purchase amount this month": resolveVendorPurchaseTopNSqlFast(
    "top 20 vendors by purchase amount this month"
  ).replace(/TOP\s+10/i, "TOP 20"),
  "what is mtd gross revenue":
    "SELECT SUM(MrpValue) AS MTDSales, COUNT(DISTINCT XnNo) AS BillCount FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK) WHERE CAST(XnDt AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST(XnDt AS date) <= CAST(GETDATE() AS date)",
  "what is ytd gross revenue":
    "SELECT SUM(MrpValue) AS YTDSales, COUNT(DISTINCT XnNo) AS BillCount FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK) WHERE CAST(XnDt AS date) >= DATEFROMPARTS(CASE WHEN MONTH(GETDATE()) >= 4 THEN YEAR(GETDATE()) ELSE YEAR(GETDATE()) - 1 END, 4, 1) AND CAST(XnDt AS date) <= CAST(GETDATE() AS date)",
  "ytd gross revenue":
    "SELECT SUM(MrpValue) AS YTDSales FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK) WHERE CAST(XnDt AS date) >= DATEFROMPARTS(CASE WHEN MONTH(GETDATE()) >= 4 THEN YEAR(GETDATE()) ELSE YEAR(GETDATE()) - 1 END, 4, 1) AND CAST(XnDt AS date) <= CAST(GETDATE() AS date)",
  "how many bills today": null, // resolved dynamically via home-kpi-sql (same as Home page)
};

const FUZZY_FAST_PATH_MAX_DISTANCE = 2;

function levenshteinDistance(a, b) {
  const s = a.length;
  const t = b.length;
  if (s === 0) return t;
  if (t === 0) return s;
  const row = Array.from({ length: t + 1 }, (_, i) => i);
  for (let i = 1; i <= s; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= t; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[t];
}

function resolveExactMatchSql(cacheKey) {
  if (!Object.prototype.hasOwnProperty.call(EXACT_MATCH_CACHE, cacheKey)) return null;
  const entry = EXACT_MATCH_CACHE[cacheKey];
  if (entry === null) {
    const { buildBillsTodaySqlAlignedWithHome, buildSalesTopNBreakdownSql } = require("./home-kpi-sql");
    if (cacheKey === "how many bills today") {
      return buildBillsTodaySqlAlignedWithHome();
    }
    if (cacheKey === "sales by store yesterday" || cacheKey === "turnover by store yesterday") {
      return buildSalesTopNBreakdownSql(cacheKey);
    }
    return null;
  }
  return entry;
}

/**
 * Exact hash lookup, then fuzzy match against cache keys (≤2 edits).
 * @returns {{ sql: string, matchType: 'exact'|'fuzzy', matchedKey: string }|null}
 */
function checkFastPath(userQuestion) {
  const { isFastPathEnabled } = require("./nlq-pipeline-config");
  if (!isFastPathEnabled()) return null;

  const cleanQuestion = normalizeTerm(userQuestion);
  if (!cleanQuestion) return null;

  const exactSql = resolveExactMatchSql(cleanQuestion);
  if (exactSql) {
    return {
      sql: exactSql,
      matchType: "exact",
      matchedKey: cleanQuestion,
    };
  }

  let best = null;
  for (const key of Object.keys(EXACT_MATCH_CACHE)) {
    const sql = resolveExactMatchSql(key);
    if (!sql) continue;
    const dist = levenshteinDistance(cleanQuestion, key);
    if (dist <= FUZZY_FAST_PATH_MAX_DISTANCE && (!best || dist < best.dist)) {
      best = { sql, matchType: "fuzzy", matchedKey: key, dist };
    }
  }
  if (best) {
    return { sql: best.sql, matchType: best.matchType, matchedKey: best.matchedKey };
  }
  return null;
}

function buildMappingDictionaryBlock(question, viewName) {
  const head = buildSemanticMappingsPromptBlock(question, viewName);
  if (question) {
    const view =
      viewName || resolveViewForQuestion(question);
    return `${head}

Use column roles for [${view}] above. Global MrpValue / SupplierName / XnDt aliases apply only on dbo.VW_MB_POWERBI_APP_REPORT — not on salesperson or SLSXNS views.`;
  }
  return `${head}

### BUSINESS DICTIONARY MAPPINGS (Plain English -> Canonical Column):
${Object.entries(BUSINESS_TERM_MAPPINGS)
  .map(([k, v]) => `- "${k}" maps to column: ${v}`)
  .join("\n")}
Use these mappings to translate user intents into precise database fields.`;
}

/**
 * Rank every view by structural overlap with canonical mapped columns.
 * @param {string} userQuestion
 * @param {object} schemaJson — parsed db_tables_views_columns.json
 * @returns {{ viewName: string, matchCount: number, columns: string[] }[]}
 */
function rankViewsByMappingCoverage(userQuestion, schemaJson) {
  const views = schemaJson?.views || {};
  const ranked = [];

  for (const [viewName, viewDef] of Object.entries(views)) {
    let matchCount = 0;
    const columns = Object.keys(viewDef.columns || {});

    for (const col of CANONICAL_COLUMNS) {
      if (columns.some((c) => c.toLowerCase() === col.toLowerCase())) {
        matchCount++;
      }
    }

    ranked.push({ viewName, matchCount, columns });
  }

  ranked.sort((a, b) => b.matchCount - a.matchCount);

  const q = String(userQuestion || "").toLowerCase();
  if (/\b(approval|app)\b/.test(q)) {
    const app = ranked.find((r) => /_APP_REPORT$/i.test(r.viewName));
    if (app) {
      return [app, ...ranked.filter((r) => r.viewName !== app.viewName)];
    }
  }

  if (
    /\b(salesperson|salespersons|sales\s*person|sales\s*rep|staff)\b/.test(q) &&
    /\b(revenue|sales|amount|top|highest|performance|gross)\b/.test(q) &&
    !/\b(purchase|procurement)\b/.test(q)
  ) {
    const slsStaff = ranked.find((r) => /SLS_DATA_WITHOUT_ITEMID/i.test(r.viewName));
    if (slsStaff) {
      return [slsStaff, ...ranked.filter((r) => r.viewName !== slsStaff.viewName)];
    }
  }

  if (/\b(purchase|vendor|vendors|supplier|suppliers|procurement)\b/.test(q) && /\b(amount|value|cost|qty|quantity)\b/.test(q)) {
    const purxns = ranked.find((r) => /PURXNS_REPORT$/i.test(r.viewName));
    const supplierPur = ranked.find((r) => /SUPPLIER_PUR_REPORT$/i.test(r.viewName));
    const pick = purxns || supplierPur;
    if (pick) {
      return boostRankedViews(userQuestion, [pick, ...ranked.filter((r) => r.viewName !== pick.viewName)], schemaJson);
    }
  }

  const analytics = String(runtimeConfig.get("ANALYTICS_BASE_TABLE") || "").trim();
  if (analytics && !/\b(salesperson|sales\s*person|purchase|approval)\b/.test(q)) {
    const full = analytics.startsWith("dbo.") ? analytics : `dbo.${analytics}`;
    const hit = ranked.find((r) => r.viewName === full);
    if (hit) {
      return boostRankedViews(userQuestion, [hit, ...ranked.filter((r) => r.viewName !== full)], schemaJson);
    }
  }

  return boostRankedViews(userQuestion, ranked, schemaJson);
}

/**
 * Pipeline helper: load schema JSON, rank, return top-N view names for LangGraph state.
 */
function selectTopViewsForPipeline(userQuestion, opts = {}) {
  const schemaJson = opts.schemaJson || loadSchema();
  const topN = opts.topN ?? DEFAULT_SCHEMA_TOP_VIEWS;
  const ranked = rankViewsByMappingCoverage(userQuestion, schemaJson);
  const withHits = ranked.filter((r) => r.matchCount > 0);
  const ordered = (withHits.length ? withHits : ranked).slice(0, topN).map((r) => r.viewName);

  if (opts.tableHint) {
    const hint = String(opts.tableHint).startsWith("dbo.")
      ? String(opts.tableHint)
      : `dbo.${opts.tableHint}`;
    if (schemaJson.views?.[hint] && !ordered.includes(hint)) {
      return [hint, ...ordered].slice(0, topN);
    }
  }

  const preferred = resolveViewForQuestion(userQuestion, { schemaJson, tableHint: opts.tableHint });
  if (preferred && !ordered.includes(preferred)) {
    return [preferred, ...ordered].slice(0, topN);
  }
  return ordered.length ? ordered : [preferred || "dbo.VW_MB_POWERBI_APP_REPORT"];
}

function formatRankedSchemaForPrompt(userQuestion, opts = {}) {
  const topN = opts.topN ?? DEFAULT_SCHEMA_TOP_VIEWS;
  const viewNames = selectTopViewsForPipeline(userQuestion, { ...opts, topN });
  return {
    viewNames,
    schemaText: formatSchemaForPrompt(viewNames),
    ranked: rankViewsByMappingCoverage(userQuestion, opts.schemaJson || loadSchema()).slice(0, 5),
  };
}

function normalizeTerm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectTermsInQuestion(question) {
  const q = normalizeTerm(question);
  const hits = [];
  const cfg = loadSemanticConfig();

  for (const [alias, schemaColumn] of Object.entries(BUSINESS_TERM_MAPPINGS)) {
    if (q.includes(normalizeTerm(alias))) {
      hits.push({ alias, schemaColumn });
    }
  }

  for (const [key, def] of Object.entries(cfg.semantic_mappings?.metrics || {})) {
    const nk = normalizeTerm(key.replace(/_/g, " "));
    if (nk.length > 2 && q.includes(nk)) {
      hits.push({ alias: key, schemaColumn: def.canonical_column, description: def.description });
    }
  }
  for (const [key, def] of Object.entries(cfg.semantic_mappings?.dimensions || {})) {
    const nk = normalizeTerm(key);
    if (nk.length > 2 && q.includes(nk)) {
      hits.push({ alias: key, schemaColumn: def.canonical_column, description: def.description });
    }
  }

  return hits;
}

function resolveColumnsForView(viewName, schemaJson) {
  const schema = schemaJson || loadSchema();
  const viewDef = schema.views?.[viewName];
  const columns = viewDef ? Object.keys(viewDef.columns || {}) : [];
  const resolved = {};

  for (const col of CANONICAL_COLUMNS) {
    if (columns.some((c) => c.toLowerCase() === col.toLowerCase())) {
      resolved[col] = col;
    }
  }

  return { viewName, columns, resolved };
}

function buildViewResolutionBlock(viewNames, schemaJson) {
  const schema = schemaJson || loadSchema();
  const lines = ["### VIEW-SPECIFIC COLUMN RESOLUTION (metadata)"];

  for (const vn of viewNames || []) {
    const { resolved, columns } = resolveColumnsForView(vn, schema);
    if (!columns.length) continue;
    lines.push(`\n[${vn}]`);
    const keys = Object.keys(resolved);
    if (keys.length) {
      keys.forEach((col) => lines.push(`  canonical ${col}: present`));
    } else {
      lines.push("  (no canonical mapped columns — use SCHEMA list only)");
    }
  }

  return lines.join("\n");
}

function buildAggregationMandateBlock() {
  return `### SERVER-SIDE AGGREGATION MANDATE
1. INTENT PARSING and SQL FORMULATION are separate steps.
2. Default: SUM/COUNT/AVG with GROUP BY on ${LOGICAL_GROUP_DIMENSIONS.join(", ")}.
3. Non-aggregated scans MUST use TOP (${RAW_SCAN_TOP}) or less.
4. Aggregated outputs: TOP (${AGGREGATE_RESULT_TOP}) on outer query when many groups.
5. Always filter by XnDt (or view date column) for period questions.

### FORCED DATE INTERVALS (sub-100ms SQL Server — use verbatim)
- MTD / this month: [XnDt] >= DATEADD(month, DATEDIFF(month, 0, GETDATE()), 0) AND [XnDt] < DATEADD(month, DATEDIFF(month, 0, GETDATE()) + 1, 0)
- Today:           CAST([XnDt] AS date) = CAST(GETDATE() AS date)
- Yesterday:       CAST([XnDt] AS date) = DATEADD(day, -1, CAST(GETDATE() AS date))
- YTD (Indian FY): [XnDt] >= DATEFROMPARTS(CASE WHEN MONTH(GETDATE()) >= 4 THEN YEAR(GETDATE()) ELSE YEAR(GETDATE())-1 END, 4, 1) AND [XnDt] <= GETDATE()
- Last 30d:        [XnDt] >= DATEADD(day, -30, GETDATE())
- Last 90d:        [XnDt] >= DATEADD(day, -90, GETDATE())
- Last 180d:       [XnDt] >= DATEADD(day, -180, GETDATE())
- All time:        (no date filter — omit the WHERE clause date predicate entirely)

### CANONICAL VIEW MANDATE
Always query: dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK)
Revenue/Turnover = MrpValue | Qty/Pieces = AppQty | Cost = CostValue | Net discount = NetAmount
Date = XnDt | Month label = XnDtMonth | Invoice = XnNo | TxnID = XnId | Bills = BillCount
Branch/Store = BranchAlias | Staff/Consignee = SupplierName | Brand alias = SupplierAlias
Category = CategoryShortName | Dept = DepartmentShortName | Article/SKU = ArticleNo
Color = Color (NEVER Colour) | Size = Size (NEVER SizeName) | Fabric = Fabric
RANKING/ALL-TIME queries → OMIT date WHERE clause entirely`;
}

/**
 * Build a structured [System Observation] block for the error-recovery LLM prompt.
 * Explicitly calls out Error 207 (invalid column) with exact replacement directives
 * so the LLM repairs the column on the very next attempt.
 */
function formatSystemObservation(err, sql, attemptCount) {
  const msg = err?.message || err?.error || String(err || "unknown error");
  const failed = err?.failed_sql || sql || "";
  const attempt = attemptCount != null ? attemptCount : 1;

  // ── Error 207 / "Invalid column name" → inject specific replacement hint ──
  const invalidColMatch = msg.match(/Invalid column name ['"]?(\w+)['"]?/i);
  let columnHint = "";
  if (invalidColMatch) {
    const badCol = invalidColMatch[1];
    // Map the bad column to the correct one using COLUMN_ENVELOPE
    const fix = COLUMN_ENVELOPE[badCol] || COLUMN_ENVELOPE[badCol.toLowerCase()] || null;
    if (fix) {
      columnHint = `\n[Execution Hint] Invalid column '${badCol}' detected (SQL Error 207). Replace ALL references to '${badCol}' with '${fix}' from dbo.VW_MB_POWERBI_APP_REPORT. Do not use any other column name for this concept.`;
    } else {
      columnHint = `\n[Execution Hint] Invalid column '${badCol}' detected (SQL Error 207). Check the SCHEMA — this column does not exist. Use only columns listed under dbo.VW_MB_POWERBI_APP_REPORT.`;
    }
  }

  // ── Inject canonical column reminder on every retry ───────────────────────
  const canonicalHint = `\n[Canonical Column Rules — mandatory on retry]\n` +
    `• Revenue/Sales/Turnover        → SUM([MrpValue])        (NEVER SaleNetAmount, SalesNetAmount)\n` +
    `• Quantity/Qty/Pcs/Units        → SUM([AppQty])          (NEVER Quantity, SalesQuantity)\n` +
    `• Cost of goods                 → SUM([CostValue])\n` +
    `• Net discount amount           → SUM([NetAmount])       (real column — valid)\n` +
    `• Invoice/Bill number           → [XnNo]                 (NEVER InvoiceNo, InvoiceId)\n` +
    `• Date column                   → [XnDt]                 (NEVER SaleDate, InvoiceDt)\n` +
    `• Month string label            → [XnDtMonth]\n` +
    `• Bills/Footfall count          → SUM(ISNULL([BillCount],0))\n` +
    `• Salesperson/Staff             → [SupplierName]\n` +
    `• Store/Branch/Location         → [BranchAlias]          (NEVER BranchName)\n` +
    `• Article/SKU/Product code      → [ArticleNo]\n` +
    `• Color dimension               → [Color]                (NEVER Colour, NEVER SizeName)\n` +
    `• Size dimension                → [Size]                 (NEVER SizeName)\n` +
    `• Fabric dimension              → [Fabric]\n` +
    `• View: dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK)\n` +
    `• MTD: [XnDt] >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND [XnDt] <= CAST(GETDATE() AS date)`;

  return (
    `[System Observation]\n` +
    `Database execution FAILED on attempt ${attempt}.\n` +
    `Error: ${msg}\n` +
    columnHint +
    (failed ? `\nFailed SQL:\n${failed}` : "") +
    canonicalHint +
    `\n\nInstructions: Apply ALL column rules above. Fix the query. Output ONLY corrected SQL — no explanation.`
  );
}

function isRecoverableDbError(errorMessage) {
  const m = String(errorMessage || "").toLowerCase();
  return (
    m.includes("invalid column name") ||
    m.includes("incorrect syntax") ||
    m.includes("ambiguous column") ||
    m.includes("performance violation") ||
    m.includes("security violation") ||
    m.includes("could not be bound") ||
    m.includes("conversion failed") ||
    m.includes("group by")
  );
}

function verifySchemaMetadata(schemaJson) {
  const schema = schemaJson || loadSchema();
  const tableCount = Object.keys(schema.tables || {}).length;
  const viewCount = Object.keys(schema.views || {}).length;
  return {
    ok: tableCount === 0 && viewCount === 28,
    tables: tableCount,
    views: viewCount,
    database: schema.database || null,
    message:
      tableCount === 0 && viewCount === 28
        ? "Schema metadata OK (0 tables, 28 views)."
        : `Schema mismatch: expected 0 tables and 28 views, got ${tableCount} tables and ${viewCount} views.`,
  };
}

module.exports = {
  loadSemanticConfig,
  semanticConfig: loadSemanticConfig,
  detectQueryDomain,
  resolveViewForQuestion,
  buildContextAwareSemanticBlock,
  translateJargonInContext,
  translateJargonToColumn,
  getForcedDatePredicate,
  buildSemanticMappingsPromptBlock,
  BUSINESS_TERM_MAPPINGS,
  CANONICAL_COLUMNS,
  EXACT_MATCH_CACHE,
  LOGICAL_GROUP_DIMENSIONS,
  RAW_SCAN_TOP,
  AGGREGATE_RESULT_TOP,
  DEFAULT_SCHEMA_TOP_VIEWS,
  buildMappingDictionaryBlock,
  checkFastPath,
  levenshteinDistance,
  rankViewsByMappingCoverage,
  selectTopViewsForPipeline,
  formatRankedSchemaForPrompt,
  detectTermsInQuestion,
  resolveColumnsForView,
  buildViewResolutionBlock,
  buildAggregationMandateBlock,
  formatSystemObservation,
  isRecoverableDbError,
  verifySchemaMetadata,
};
