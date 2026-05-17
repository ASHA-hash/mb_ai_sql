/**
 * schema-from-json.js
 *
 * Loads db_tables_views_columns.json (pre-built offline snapshot of all 28 views)
 * and provides instant schema lookup — NO DB round-trip, NO AI discovery call.
 *
 * Used by the LangGraph pipeline instead of the slow discover_views → get_schema path.
 */
"use strict";

const path = require("path");
const fs   = require("fs");

// Load once at startup
const JSON_PATH = path.join(__dirname, "../metadata/db_tables_views_columns.json");
let _schemaCache = null;

function loadSchema() {
  if (_schemaCache) return _schemaCache;
  const raw = fs.readFileSync(JSON_PATH, "utf8");
  _schemaCache = JSON.parse(raw);
  return _schemaCache;
}

/**
 * Return all view names (fully qualified, e.g. "dbo.VwAISalesData")
 */
function getAllViewNames() {
  const s = loadSchema();
  return Object.keys(s.views || {});
}

/**
 * Keyword → view relevance map.
 * Each view gets a base score; question keywords boost relevant views.
 */
const VIEW_BOOST = {
  "dbo.VW_MB_POWERBI_SLSXNS_REPORT": {
    keywords: ["sales","revenue","net","amount","invoice","branch","department","category","article","product","item","fabric","supplier","date","trend","monthly","daily","today","week","month","year","ytd","mtd","qtd"],
    base: 10,
  },
  "dbo.VwAISalesData": {
    keywords: ["sales","invoice","quantity","salesperson","transaction","invoicedt","saleNetAmount","branch","customer","item"],
    base: 8,
  },
  "dbo.VwMstItems": {
    keywords: ["product","item","article","sku","barcode","category","department","fabric","description","master"],
    base: 6,
  },
  "dbo.VwAIBranch": {
    keywords: ["branch","store","outlet","location","city","state","region","zero","active"],
    base: 5,
  },
  "dbo.VwAICustomerDetails": {
    keywords: ["customer","member","loyalty","birthday","anniversary","contact","mobile","email","group"],
    base: 5,
  },
  "dbo.VwAISalesPerson": {
    keywords: ["salesperson","rep","agent","staff","who","sold","performance"],
    base: 4,
  },
  "dbo.VwAIStockData": {
    keywords: ["stock","inventory","quantity","low","available","closing"],
    base: 4,
  },
  "dbo.VwAISupplier": {
    keywords: ["supplier","vendor","party","purchase"],
    base: 3,
  },
  "dbo.VW_MB_POWERBI_SLS_REPORT": {
    keywords: ["sales","revenue","net","amount","branch","department","category","supplier","article","monthly"],
    base: 7,
  },
  "dbo.VW_MB_POWERBI_PUR_REPORT": {
    keywords: ["purchase","vendor","supplier","buy","po","procurement","department","category"],
    base: 5,
  },
  "dbo.VW_MB_POWERBI_PURXNS_REPORT": {
    keywords: ["purchase","transaction","vendor","supplier","buy","department","category","branch"],
    base: 5,
  },
  "dbo.VW_MB_POWERBI_STOCK_REPORT": {
    keywords: ["stock","inventory","closing","available","balance","department","category","branch"],
    base: 4,
  },
  "dbo.VW_MB_POWERBI_PRODUCT_MASTER": {
    keywords: ["product","item","article","sku","barcode","fabric","category","department","master"],
    base: 4,
  },
  "dbo.VW_MB_POWERBI_BRANCH_LIST": {
    keywords: ["branch","store","outlet","list","location","city","state"],
    base: 3,
  },
  "dbo.VW_MB_POWERBI_CATEGORY_MASTER": {
    keywords: ["category","department","master","list"],
    base: 2,
  },
  "dbo.VW_MB_POWERBI_VENDOR_MASTER": {
    keywords: ["vendor","supplier","party","master"],
    base: 2,
  },
  "dbo.VW_MB_POWERBI_SLS_ARTICLE_REPORT": {
    keywords: ["article","product","category","sales","fabric"],
    base: 3,
  },
  "dbo.VW_MB_POWERBI_APP_REPORT": {
    keywords: ["approval","app","consignment","mrpvalue","appqty","xndt","supplier","salesperson","staff","rep","category","branch","article","sale","sales","revenue","mtd","turnover"],
    base: 5,
  },
  "dbo.VW_MB_POWERBI_SUPPLIER_PUR_REPORT": {
    keywords: ["supplier","vendor","purchase","pur","category","department","branch","article"],
    base: 5,
  },
  "dbo.VW_MB_POWERBI_APR_REPORT": {
    keywords: ["approval","apr","article","sales"],
    base: 2,
  },
};

// Views that are notoriously slow — penalise them unless explicitly needed
const SLOW_VIEWS = new Set([
  "dbo.VW_MB_POWERBI_MIS_SUPPLIER_SLS_DATA",
  "dbo.VW_MB_POWERBI_CBS_WITH_GIT",
  "dbo.VW_MB_POWERBI_STI_REPORT",
  "dbo.VW_MB_POWERBI_STO_REPORT",
  "dbo.VW_MB_POWERBI_SLS_BILLCOUNT",
  "dbo.VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID",
  "dbo.VW_MB_POWERBI_SUPPLIER_PUR_REPORT",
  "dbo.VW_MB_POWERBI_PRT_REPORT",
  "dbo.VW_MB_POWERBI_PUR_QTY_WITH_COST",
]);

/**
 * Score a view against the question.
 * Returns integer score (higher = more relevant).
 */
function scoreView(viewName, qWords) {
  const cfg = VIEW_BOOST[viewName];
  if (!cfg) return SLOW_VIEWS.has(viewName) ? -1 : 0;

  let score = cfg.base;
  for (const kw of cfg.keywords) {
    if (qWords.some((w) => w.includes(kw) || kw.includes(w))) {
      score += 2;
    }
  }

  const vShort = viewName.replace(/^dbo\./i, "").toLowerCase();
  if (qWords.some((w) => vShort.includes(w) && w.length > 4)) score += 5;

  if (SLOW_VIEWS.has(viewName)) {
    return score >= 8 ? score : -1;
  }

  return score;
}

/**
 * Find the top N most relevant views for a given question.
 * Returns array of fully-qualified view names.
 *
 * @param {string} question
 * @param {object} [opts]
 * @param {number} [opts.topN=4]          Max views to return
 * @param {string} [opts.tableHint]       Force include this view
 * @param {boolean} [opts.includeItems]   Always include VwMstItems if product/item keywords found
 * @returns {string[]}
 */
function findRelevantViews(question, opts = {}) {
  const { topN = 4, tableHint } = opts;
  const q = String(question || "").toLowerCase();
  const qWords = q.split(/\W+/).filter(w => w.length > 2);

  const allViews = getAllViewNames();
  const scored = allViews
    .map(v => ({ view: v, score: scoreView(v, qWords) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const result = [];

  // Force-include tableHint if provided
  if (tableHint) {
    const th = String(tableHint).trim();
    const full = th.startsWith("dbo.") ? th : `dbo.${th}`;
    if (allViews.includes(full) && !result.includes(full)) result.push(full);
    else if (allViews.includes(th) && !result.includes(th)) result.push(th);
  }

  // Add top scored views
  for (const { view } of scored) {
    if (result.length >= topN) break;
    if (!result.includes(view)) result.push(view);
  }

  // Always include VwMstItems for product/item/article/category/department questions
  const needsItems = /\b(product|item|article|sku|category|department|fabric|description|style)\b/.test(q);
  const ITEMS = "dbo.VwMstItems";
  if (needsItems && !result.includes(ITEMS) && allViews.includes(ITEMS)) result.push(ITEMS);

  // Always include VwAIBranch for branch/store questions
  const needsBranch = /\b(branch|store|outlet|location)\b/.test(q);
  const BRANCH = "dbo.VwAIBranch";
  if (needsBranch && !result.includes(BRANCH) && allViews.includes(BRANCH)) result.push(BRANCH);

  // Branches with no / zero sales need both catalog and fact to express anti-join
  const needsZeroSalesBranch =
    needsBranch &&
    /\b(zero sales|no sales|without sales|0\s+sales|didn'?t sell|haven'?t\s+sold|not selling)\b/.test(q);
  const SALES = "dbo.VwAISalesData";
  if (needsZeroSalesBranch && !result.includes(SALES) && allViews.includes(SALES)) result.push(SALES);

  // Always include VwAICustomerDetails for customer questions
  const needsCustomer = /\b(customer|member|loyalty|buyer)\b/.test(q);
  const CUST = "dbo.VwAICustomerDetails";
  if (needsCustomer && !result.includes(CUST) && allViews.includes(CUST)) result.push(CUST);

  return result;
}

/**
 * Format selected views into a compact schema string for the AI prompt.
 * Format:
 *   dbo.VW_MB_POWERBI_SLSXNS_REPORT (41 cols):
 *     BranchAlias varchar | XnDt date | NetSlsNetAmount numeric | ...
 *
 * @param {string[]} viewNames  Fully-qualified view names
 * @returns {string}
 */
function formatSchemaForPrompt(viewNames) {
  const s = loadSchema();
  const views = s.views || {};
  const lines = [];

  for (const vn of viewNames) {
    const viewDef = views[vn];
    if (!viewDef) continue;
    const cols = viewDef.columns || {};
    const colCount = Object.keys(cols).length;
    lines.push(`\n${vn} (${colCount} columns):`);

    for (const [colName, meta] of Object.entries(cols)) {
      const type = meta.data_type || "unknown";
      const nullable = meta.is_nullable ? ", nullable" : "";
      lines.push(`  ${colName} (${type}${nullable})`);
    }
  }

  return lines.length ? lines.join("\n") : "(no schema available)";
}

/**
 * Get just the column names for a specific view.
 * @param {string} viewName  Fully-qualified
 * @returns {string[]}
 */
function getViewColumns(viewName) {
  const s = loadSchema();
  const viewDef = (s.views || {})[viewName];
  if (!viewDef) return [];
  return Object.keys(viewDef.columns || {});
}

module.exports = {
  getAllViewNames,
  findRelevantViews,
  formatSchemaForPrompt,
  getViewColumns,
  loadSchema,
};
