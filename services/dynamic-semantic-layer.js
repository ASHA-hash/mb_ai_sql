/**
 * Dynamic semantic layer — merges semantic-layer.json + db_tables_views_columns.json
 * + semantic-domain-rules.json for view-aware jargon and routing.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { loadSchema, getViewColumns } = require("./schema-from-json");
const { resolveAnalyticsColumns } = require("./analytics-column-map");
const runtimeConfig = require("./runtime-config");

const DOMAIN_RULES_PATH = path.join(__dirname, "..", "metadata", "semantic-domain-rules.json");
const SEMANTIC_LAYER_PATH = path.join(__dirname, "..", "metadata", "semantic-layer.json");

let _domainRules = null;
let _semanticConfig = null;
let _viewRoleCache = new Map();

function loadSemanticConfigLocal() {
  if (_semanticConfig) return _semanticConfig;
  try {
    _semanticConfig = JSON.parse(fs.readFileSync(SEMANTIC_LAYER_PATH, "utf8"));
  } catch {
    _semanticConfig = {
      target_view: "dbo.VW_MB_POWERBI_APP_REPORT",
      semantic_mappings: { metrics: {}, dimensions: {} },
    };
  }
  return _semanticConfig;
}

function loadDomainRules() {
  if (_domainRules) return _domainRules;
  try {
    _domainRules = JSON.parse(fs.readFileSync(DOMAIN_RULES_PATH, "utf8"));
  } catch {
    _domainRules = { domains: {} };
  }
  return _domainRules;
}

function normalizeDbo(view) {
  const s = String(view || "").trim();
  if (!s) return "";
  return s.startsWith("dbo.") ? s : `dbo.${s}`;
}

function normalizeTerm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @returns {string|null} domain key: sales | salesperson | purchase | approval | null
 */
function detectQueryDomain(question) {
  const q = normalizeTerm(question);
  const rules = loadDomainRules().domains || {};
  const scores = [];

  for (const [domain, def] of Object.entries(rules)) {
    let score = 0;
    for (const pat of def.match || []) {
      try {
        if (new RegExp(`\\b(${pat})\\b`, "i").test(q)) score += 2;
      } catch {
        /* skip bad pattern */
      }
    }
    for (const ex of def.exclude || []) {
      if (q.includes(String(ex).toLowerCase())) score -= 3;
    }
    if (score > 0) scores.push({ domain, score });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores[0]?.domain || null;
}

function envView(domainDef) {
  if (!domainDef?.viewEnv) return null;
  const v = String(process.env[domainDef.viewEnv] || "").trim();
  return v ? normalizeDbo(v) : null;
}

/**
 * Best view for a question (domain rules + env + catalog existence).
 */
function resolveViewForQuestion(question, opts = {}) {
  const schema = opts.schemaJson || loadSchema();
  const views = schema.views || {};
  const domain = opts.domain || detectQueryDomain(question);
  const rules = loadDomainRules().domains || {};

  if (opts.tableHint) {
    const hint = normalizeDbo(opts.tableHint);
    if (views[hint]) return hint;
  }

  if (domain && rules[domain]) {
    const def = rules[domain];
    const fromEnv = envView(def);
    if (fromEnv && views[fromEnv]) return fromEnv;
    const dv = normalizeDbo(def.defaultView);
    if (views[dv]) return dv;
  }

  const analytics = normalizeDbo(runtimeConfig.get("ANALYTICS_BASE_TABLE") || "");
  if (analytics && views[analytics] && domain !== "salesperson" && domain !== "purchase") {
    return analytics;
  }

  const cfg = loadSemanticConfigLocal();
  const fallback = normalizeDbo(cfg.target_view || "dbo.VW_MB_POWERBI_APP_REPORT");
  return views[fallback] ? fallback : Object.keys(views)[0] || fallback;
}

/**
 * Per-view roles inferred from catalog + semantic-layer view block overrides.
 */
function getViewRoleProfile(viewName) {
  const vn = normalizeDbo(viewName);
  if (_viewRoleCache.has(vn)) return _viewRoleCache.get(vn);

  const cols = getViewColumns(vn);
  const roles = resolveAnalyticsColumns(vn);
  const layer = loadSemanticConfigLocal();
  const block = layer[vn] || {};

  const profile = {
    viewName: vn,
    columns: cols,
    date: block.dateColumn || roles.date,
    amount: block.revenueColumn || roles.amount,
    qty: roles.qty,
    branch: block.branchColumn || roles.branch,
    dept: roles.dept,
    cat: roles.cat,
    invoice: roles.invoice,
    staff: cols.includes("SalesPersonName") ? "SalesPersonName" : null,
    purpose: block.purpose || "",
    primaryUseCase: block.primaryUseCase || "",
    neverUse: Array.isArray(block.neverUse) ? block.neverUse : [],
    keyColumns: block.keyColumns || {},
  };

  _viewRoleCache.set(vn, profile);
  return profile;
}

/**
 * Context-aware jargon → column (domain + target view).
 */
function translateJargonInContext(term, question, viewName) {
  const raw = String(term || "").trim();
  if (!raw) return null;

  const domain = detectQueryDomain(question);
  const rules = loadDomainRules().domains || {};
  const norm = normalizeTerm(raw);
  const normKey = norm.replace(/\s+/g, " ");

  if (domain && rules[domain]) {
    const d = rules[domain];
    for (const [k, col] of Object.entries(d.metrics || {})) {
      if (normalizeTerm(k) === norm || normKey.includes(normalizeTerm(k))) return col;
    }
    for (const [k, col] of Object.entries(d.dimensions || {})) {
      if (normalizeTerm(k) === norm || normKey.includes(normalizeTerm(k))) return col;
    }
  }

  const profile = getViewRoleProfile(viewName || resolveViewForQuestion(question));
  const colSet = new Set(profile.columns);

  if (/salesperson|staff|sales\s*rep/.test(norm) && profile.staff && colSet.has(profile.staff)) {
    return profile.staff;
  }
  if (/revenue|sales|turnover|amount|mrp|gross/.test(norm) && profile.amount && colSet.has(profile.amount)) {
    return profile.amount;
  }
  if (/units?|qty|quantity|pcs|pieces/.test(norm) && profile.qty && colSet.has(profile.qty)) {
    return profile.qty;
  }
  if (/branch|store|outlet/.test(norm) && profile.branch && colSet.has(profile.branch)) {
    return profile.branch;
  }
  if (/department|dept/.test(norm) && profile.dept && colSet.has(profile.dept)) {
    return profile.dept;
  }
  if (/categor/.test(norm) && profile.cat && colSet.has(profile.cat)) {
    return profile.cat;
  }
  if (/date|today|yesterday|mtd/.test(norm) && profile.date && colSet.has(profile.date)) {
    return profile.date;
  }

  const cfg = loadSemanticConfigLocal();
  const metrics = cfg.semantic_mappings?.metrics || {};
  const dimensions = cfg.semantic_mappings?.dimensions || {};
  for (const bucket of [metrics, dimensions]) {
    for (const [key, def] of Object.entries(bucket)) {
      if (normalizeTerm(key) === norm && def?.canonical_column) {
        const c = def.canonical_column;
        if (colSet.has(c)) return c;
      }
    }
  }

  return null;
}

/**
 * Prompt block: view-specific dictionary (not global MrpValue / SupplierName for everything).
 */
function buildContextAwareSemanticBlock(question, viewName) {
  const view = normalizeDbo(viewName || resolveViewForQuestion(question));
  const profile = getViewRoleProfile(view);
  const domain = detectQueryDomain(question) || "sales";
  const domainDef = loadDomainRules().domains?.[domain] || {};

  const lines = [
    "### DYNAMIC SEMANTIC LAYER (catalog + domain rules)",
    `Detected domain: ${domain} — ${domainDef.label || domain}`,
    `Target view: ${view}`,
    profile.purpose ? `Purpose: ${profile.purpose}` : "",
    profile.primaryUseCase ? `Use for: ${profile.primaryUseCase}` : "",
    "",
    "Column roles on THIS view only:",
    profile.date ? `- Date filter: [${profile.date}]` : "",
    profile.amount ? `- Revenue / sales amount: SUM([${profile.amount}])` : "",
    profile.qty ? `- Quantity / units: SUM([${profile.qty}])` : "",
    profile.branch ? `- Branch / store: [${profile.branch}]` : "",
    profile.dept ? `- Department: [${profile.dept}]` : "",
    profile.cat ? `- Category: [${profile.cat}]` : "",
    profile.staff ? `- Salesperson / staff: [${profile.staff}] (NOT SupplierName on this view)` : "",
    profile.invoice ? `- Invoice / bill id: [${profile.invoice}]` : "",
  ].filter(Boolean);

  if (profile.neverUse.length) {
    lines.push("", "Never use on this view:", ...profile.neverUse.map((n) => `- ${n}`));
  }
  if (domainDef.neverUseOnThisDomain?.length) {
    lines.push(
      "",
      `Forbidden on ${domain} questions:`,
      ...domainDef.neverUseOnThisDomain.map((c) => `- ${c}`)
    );
  }

  const keyEntries = Object.entries(profile.keyColumns || {}).slice(0, 24);
  if (keyEntries.length) {
    lines.push("", "Documented columns:");
    for (const [col, desc] of keyEntries) {
      lines.push(`- ${col}: ${desc}`);
    }
  }

  return lines.join("\n");
}

/**
 * Boost view ranking using domain + env (for pre-flight).
 */
function boostRankedViews(userQuestion, rankedViews, schemaJson) {
  const schema = schemaJson || loadSchema();
  const views = schema.views || {};
  const domain = detectQueryDomain(userQuestion);
  const preferred = resolveViewForQuestion(userQuestion, { domain, schemaJson });
  if (!preferred || !views[preferred]) return rankedViews;

  const rest = (rankedViews || []).filter((r) => r.viewName !== preferred);
  const hit = rankedViews.find((r) => r.viewName === preferred) || {
    viewName: preferred,
    matchCount: 99,
    columns: Object.keys(views[preferred].columns || {}),
  };
  return [{ ...hit, domainBoost: domain }, ...rest];
}

function invalidateCache() {
  _viewRoleCache.clear();
}

module.exports = {
  loadDomainRules,
  detectQueryDomain,
  resolveViewForQuestion,
  getViewRoleProfile,
  translateJargonInContext,
  buildContextAwareSemanticBlock,
  boostRankedViews,
  invalidateCache,
};
