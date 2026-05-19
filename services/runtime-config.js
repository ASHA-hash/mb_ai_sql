/**
 * runtime-config.js
 *
 * Hot-reloadable settings store for Smart ERP Connector.
 *
 * Priority: PostgreSQL overrides > .env > built-in defaults
 *
 * Storage strategy (auto-selected at startup via initDb()):
 *   - DATABASE_URL / RBAC_DATABASE_URL is set  →  PostgreSQL table erp_runtime_config
 *   - Otherwise                                →  metadata/runtime-config.json (local dev)
 *
 * Admin saves a value → written to DB immediately, takes effect on next get() call.
 * Changes take effect immediately — NO server restart needed.
 *
 * Settings that still require restart (pool already open):
 *   DB_POOL_MAX, DB_SERVER, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const { Pool } = require("pg");

const STORE_PATH = path.join(__dirname, "../metadata/runtime-config.json");

/* ── Canonical settings manifest ─────────────────────────────────────────────
   Each entry: key, label, group, type, default, requiresRestart?, description
   ──────────────────────────────────────────────────────────────────────────── */
const SETTINGS_MANIFEST = [

  /* ── Dataset ────────────────────────────────────────────────────────────── */
  {
    key: "DATASET_HARD_CAP",
    label: "Dataset hard cap (rows)",
    group: "dataset",
    type: "number",
    min: 500,
    max: 500000,
    default: 20000,
    requiresRestart: false,
    description: "Maximum rows the server will ever return for a dataset export. Protects memory.",
  },
  {
    key: "DATASET_PAGE_MAX",
    label: "Default page size (rows)",
    group: "dataset",
    type: "number",
    min: 100,
    max: 10000,
    default: 1000,
    requiresRestart: false,
    description: "Default page size when no rowLimit is specified in a dataset query.",
  },

  /* ── AI / NLQ ────────────────────────────────────────────────────────────── */
  {
    key: "OPENAI_MODEL",
    label: "OpenAI model",
    group: "ai",
    type: "string",
    default: "gpt-4o-mini",
    requiresRestart: false,
    description: "OpenAI chat model used for SQL generation and answers.",
  },
  {
    key: "ANTHROPIC_MODEL",
    label: "Claude model",
    group: "ai",
    type: "string",
    default: "claude-sonnet-4-6",
    requiresRestart: false,
    description: "Anthropic model used when the Claude provider is selected.",
  },
  {
    key: "NLQ_FAST_PATH",
    label: "Fast-path canonical SQL",
    group: "ai",
    type: "toggle",
    default: "1",
    requiresRestart: false,
    description: "Resolve common queries (today's sales, top salesperson, etc.) deterministically before any LLM call.",
  },
  {
    key: "NLQ_INTENT_COMPILER",
    label: "Intent compiler",
    group: "ai",
    type: "toggle",
    default: "1",
    requiresRestart: false,
    description: "Run a two-step intent → SQL pipeline for higher accuracy on complex questions.",
  },
  {
    key: "ADAPTIVE_INTENT_STEP",
    label: "Adaptive intent step",
    group: "ai",
    type: "toggle",
    default: "1",
    requiresRestart: false,
    description: "Enable the LangGraph adaptive intent resolver node.",
  },
  {
    key: "COGNITIVE_COLUMN_DISCOVERY",
    label: "Cognitive column discovery",
    group: "ai",
    type: "toggle",
    default: "1",
    requiresRestart: false,
    description: "Probe DB for actual column values before SQL generation to ground filter clauses.",
  },
  {
    key: "AI_ADAPTIVE_SUMMARY",
    label: "Adaptive AI result summary",
    group: "ai",
    type: "toggle",
    default: "1",
    requiresRestart: false,
    description: "Generate a natural-language summary of AI query results alongside the data table.",
  },
  {
    key: "AI_SCHEMA_DISABLE",
    label: "Disable schema context injection",
    group: "ai",
    type: "toggle",
    default: "0",
    requiresRestart: false,
    description: "Skip sending view/table schema to the LLM. Reduces token usage but may lower SQL accuracy.",
  },
  {
    key: "AI_SCHEMA_MAX_TABLES",
    label: "Max tables in schema context",
    group: "ai",
    type: "number",
    min: 1,
    max: 50,
    default: 14,
    requiresRestart: false,
    description: "How many views/tables to include in the LLM schema prompt. Lower = faster, fewer tokens.",
  },
  {
    key: "RAG_AUTO_SAVE",
    label: "Auto-save successful queries to RAG",
    group: "ai",
    type: "toggle",
    default: "1",
    requiresRestart: false,
    description: "Automatically add verified query results to the RAG store for future few-shot retrieval.",
  },
  {
    key: "DEFAULT_AI_PROVIDER",
    label: "Default AI provider",
    group: "ai",
    type: "select",
    options: ["openai", "claude"],
    default: "openai",
    requiresRestart: false,
    description: "Default provider used by the AI Query panel on first load.",
  },

  /* ── Analytics ───────────────────────────────────────────────────────────── */
  {
    key: "ANALYTICS_NOLOCK",
    label: "Add WITH (NOLOCK) to analytics queries",
    group: "analytics",
    type: "toggle",
    default: "1",
    requiresRestart: false,
    description: "Prevents read-lock contention on heavy write workloads. Safe for BI reporting.",
  },
  {
    key: "ANALYTICS_RECOMPILE",
    label: "Force OPTION(RECOMPILE) on long ranges",
    group: "analytics",
    type: "toggle",
    default: "1",
    requiresRestart: false,
    description: "Rebuilds SQL Server execution plan per date range — fixes parameter sniffing on 180-day queries.",
  },
  {
    key: "ANALYTICS_RECOMPILE_THRESHOLD",
    label: "RECOMPILE threshold (days)",
    group: "analytics",
    type: "number",
    min: 1,
    max: 365,
    default: 30,
    requiresRestart: false,
    description: "Only add OPTION(RECOMPILE) when the date span exceeds this many days.",
  },
  {
    key: "ANALYTICS_CACHE_TTL_MS",
    label: "Analytics cache TTL (ms)",
    group: "analytics",
    type: "number",
    min: 30000,
    max: 3600000,
    default: 600000,
    requiresRestart: false,
    description: "How long a cached analytics result is 'fresh'. Default 600,000 ms (10 min).",
  },
  {
    key: "ANALYTICS_STALE_TTL_MULTIPLIER",
    label: "Stale cache multiplier",
    group: "analytics",
    type: "number",
    min: 0,
    max: 20,
    default: 4,
    requiresRestart: false,
    description: "Stale TTL = TTL × multiplier. Stale data is served instantly while refresh runs in background. Set 0 to disable SWR.",
  },
  {
    key: "ANALYTICS_WARMUP",
    label: "Cache warmup on startup",
    group: "analytics",
    type: "toggle",
    default: "1",
    requiresRestart: false,
    description: "Pre-run MTD/QTD/YTD/180d queries 30 seconds after startup so first user always hits warm cache.",
  },
  {
    key: "ANALYTICS_WARMUP_INTERVAL_MS",
    label: "Warmup interval (ms)",
    group: "analytics",
    type: "number",
    min: 60000,
    max: 3600000,
    default: 900000,
    requiresRestart: false,
    description: "How often the warmup re-runs. Default 900,000 ms (15 min).",
  },
  {
    key: "ANALYTICS_WARMUP_PAUSE_MS",
    label: "Warmup pause between periods (ms)",
    group: "analytics",
    type: "number",
    min: 0,
    max: 30000,
    default: 3000,
    requiresRestart: false,
    description: "Pause between warmup query periods so pool connections can fully release. Set 0 to disable.",
  },
  {
    key: "SALES_AI_TABLE",
    label: "AI sales fact table",
    group: "analytics",
    type: "string",
    default: "dbo.VW_MB_POWERBI_APP_REPORT",
    requiresRestart: false,
    description: "Default table for text-to-SQL sales queries. Usually the APP_REPORT view.",
  },
  {
    key: "ANALYTICS_BASE_TABLE",
    label: "Analytics base table",
    group: "analytics",
    type: "string",
    default: "dbo.VW_MB_POWERBI_SLSXNS_REPORT",
    requiresRestart: false,
    description: "Base view for Home KPI cards and the Analytics dashboard.",
  },
  {
    key: "SALES_ANALYTICS_AMOUNT_COLUMN",
    label: "Sales amount column",
    group: "analytics",
    type: "string",
    default: "NetSlsNetAmount",
    requiresRestart: false,
    description: "Column name for net sales amount in the analytics base table.",
  },
  {
    key: "SALES_ANALYTICS_BRANCH_DIM",
    label: "Branch dimension column",
    group: "analytics",
    type: "string",
    default: "BranchAlias",
    requiresRestart: false,
    description: "Column name for branch grouping in analytics queries.",
  },
  {
    key: "SALES_ANALYTICS_DEPARTMENT_DIM",
    label: "Department dimension column",
    group: "analytics",
    type: "string",
    default: "DepartmentShortName",
    requiresRestart: false,
    description: "Column name for department grouping in analytics queries.",
  },
  {
    key: "SALES_ANALYTICS_CATEGORY_DIM",
    label: "Category dimension column",
    group: "analytics",
    type: "string",
    default: "CategoryShortName",
    requiresRestart: false,
    description: "Column name for category grouping in analytics queries.",
  },
  {
    key: "SALES_ANALYTICS_QTY_COLUMN",
    label: "Sales quantity column",
    group: "analytics",
    type: "string",
    default: "AppQty",
    requiresRestart: false,
    description: "Column name for sales quantity in the analytics table.",
  },
  {
    key: "SALES_FILTER_DATE_COLUMN",
    label: "Sales date filter column",
    group: "analytics",
    type: "string",
    default: "XnDt",
    requiresRestart: false,
    description: "Date column used for period filtering in sales queries.",
  },
  {
    key: "CUSTOMERS_FILTER_DATE_COLUMN",
    label: "Customer date filter column",
    group: "analytics",
    type: "string",
    default: "CreatedDt",
    requiresRestart: false,
    description: "Date column on the customer view used for period filtering.",
  },
  {
    key: "STOCK_FILTER_DATE_COLUMN",
    label: "Stock date filter column",
    group: "analytics",
    type: "string",
    default: "EntryDt",
    requiresRestart: false,
    description: "Date column on the stock view used for period filtering.",
  },

  /* ── Domain views & tables ───────────────────────────────────────────────── */
  {
    key: "SALES_VIEW",
    label: "Sales AI view",
    group: "dataset",
    type: "string",
    default: "dbo.VwAISalesData",
    requiresRestart: false,
    description: "SQL view used by the AI query engine for sales domain questions.",
  },
  {
    key: "CUSTOMER_VIEW",
    label: "Customer AI view",
    group: "dataset",
    type: "string",
    default: "dbo.VwAICustomerDetails",
    requiresRestart: false,
    description: "SQL view used by the AI query engine for customer domain questions.",
  },
  {
    key: "STOCK_VIEW",
    label: "Stock AI view",
    group: "dataset",
    type: "string",
    default: "dbo.VwAIStockData",
    requiresRestart: false,
    description: "SQL view used by the AI query engine for stock/inventory domain questions.",
  },
  {
    key: "BRANCH_VIEW",
    label: "Branch lookup view",
    group: "dataset",
    type: "string",
    default: "dbo.VwAIBranch",
    requiresRestart: false,
    description: "SQL view that lists branches — used for branch name grounding.",
  },
  {
    key: "SALESPERSON_TABLE",
    label: "Salesperson table",
    group: "dataset",
    type: "string",
    default: "dbo.MstSalesPerson",
    requiresRestart: false,
    description: "Table that lists salespersons — used for salesperson name grounding.",
  },
  {
    key: "SALESPERSON_TOPN_VIEW",
    label: "Salesperson top-N view",
    group: "dataset",
    type: "string",
    default: "dbo.VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID",
    requiresRestart: false,
    description: "View for salesperson ranking queries (SalesPersonName, SalesQuantity, CashmemoDt).",
  },

  /* ── Security / login ────────────────────────────────────────────────────── */
  {
    key: "ADMIN_DEFAULT_PASSWORD",
    label: "Default login password (first-run)",
    group: "security",
    type: "password",
    default: "Admin@1234",
    requiresRestart: false,
    description:
      "Used only when a user has no password hash yet. Set per-user passwords in Admin → Users. Stored in PostgreSQL when DATABASE_URL is set.",
  },
  {
    key: "STOCK_TABLE",
    label: "Stock master table",
    group: "dataset",
    type: "string",
    default: "dbo.MstStockUnit",
    requiresRestart: false,
    description: "Stock master table used for item/SKU lookups.",
  },

  /* ── Performance ─────────────────────────────────────────────────────────── */
  {
    key: "DB_REQUEST_TIMEOUT_MS",
    label: "DB request timeout (ms)",
    group: "performance",
    type: "number",
    min: 30000,
    max: 1800000,
    default: 720000,
    requiresRestart: true,
    description: "Per-request SQL Server timeout. Restart required (pool is created at startup).",
  },
  {
    key: "DB_CONNECT_TIMEOUT_MS",
    label: "DB connect timeout (ms)",
    group: "performance",
    type: "number",
    min: 5000,
    max: 120000,
    default: 60000,
    requiresRestart: true,
    description: "Timeout for establishing the initial DB connection. Restart required.",
  },
  {
    key: "DB_POOL_MAX",
    label: "DB connection pool size",
    group: "performance",
    type: "number",
    min: 5,
    max: 100,
    default: 20,
    requiresRestart: true,
    description: "Max simultaneous DB connections. Restart required.",
  },
  {
    key: "HOME_KPI_REQUEST_TIMEOUT_MS",
    label: "Home KPI timeout (ms)",
    group: "performance",
    type: "number",
    min: 10000,
    max: 600000,
    default: 180000,
    requiresRestart: false,
    description: "Timeout for the Home page KPI card queries.",
  },
  {
    key: "DB_POOL_ACQUIRE_TIMEOUT_MS",
    label: "Pool acquire timeout (ms)",
    group: "performance",
    type: "number",
    min: 10000,
    max: 600000,
    default: 180000,
    requiresRestart: true,
    description: "How long to wait for a free pool connection before failing. Restart required.",
  },
];

/* ── In-memory override store ─────────────────────────────────────────────── */
let _overrides = {};

/* ── PostgreSQL persistence layer ─────────────────────────────────────────── */
let _pgPool    = null;
let _pgEnabled = false;

function _pgConnStr() {
  return String(process.env.RBAC_DATABASE_URL || process.env.DATABASE_URL || "").trim();
}

function _sslOption(url) {
  if (String(process.env.RBAC_PG_SSL || "").trim() === "0") return false;
  try {
    const u = new URL(url.replace(/^postgresql:/i, "http:"));
    const h = (u.hostname || "").toLowerCase();
    if (h === "localhost" || h === "127.0.0.1") return false;
  } catch (_) {}
  return { rejectUnauthorized: false };
}

/**
 * Initialize PostgreSQL persistence for runtime config.
 * Must be called (and awaited) from startServer() before server.listen().
 * Falls back gracefully to JSON file if DB is unavailable.
 */
async function initDb() {
  const conn = _pgConnStr();
  if (!conn) {
    const envPath = path.join(__dirname, "..", ".env");
    const hint = fs.existsSync(envPath)
      ? " (.env is present — set DATABASE_URL=postgresql://... and restart npm start)"
      : "";
    console.warn("[runtime-config] No DATABASE_URL / RBAC_DATABASE_URL" + hint + " — using JSON file store.");
    return;
  }

  _pgPool = new Pool({ connectionString: conn, ssl: _sslOption(conn), max: 2 });

  try {
    await _pgPool.query(`
      CREATE TABLE IF NOT EXISTS erp_runtime_config (
        key        TEXT PRIMARY KEY,
        value      TEXT        NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Load DB overrides (highest priority — override whatever was in file)
    const { rows } = await _pgPool.query(
      "SELECT key, value FROM erp_runtime_config ORDER BY key"
    );
    for (const row of rows) {
      _overrides[row.key] = row.value;
    }
    if (rows.length === 0) {
      const seeded = seedFromProcessEnv({ onlyMissing: true, persist: true });
      if (seeded.length) {
        console.log(
          `[runtime-config] First deploy: copied ${seeded.length} setting(s) from environment into PostgreSQL.`
        );
      }
    }
    _pgEnabled = true;
    console.log(`[runtime-config] PostgreSQL store active (${Object.keys(_overrides).length} override(s) in DB).`);
  } catch (e) {
    console.warn("[runtime-config] PostgreSQL init failed — using JSON file:", e.message);
    _pgPool = null;
    _pgEnabled = false;
  }
}

/* Async fire-and-forget write to PG */
function _persistToPg(key, value) {
  if (!_pgEnabled || !_pgPool) return;
  const sql = `
    INSERT INTO erp_runtime_config (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
  _pgPool.query(sql, [String(key), String(value)]).catch((e) =>
    console.warn("[runtime-config] PG write failed:", e.message)
  );
}

/* Async fire-and-forget delete from PG */
function _deletePg(key) {
  if (!_pgEnabled || !_pgPool) return;
  _pgPool
    .query("DELETE FROM erp_runtime_config WHERE key = $1", [String(key)])
    .catch((e) => console.warn("[runtime-config] PG delete failed:", e.message));
}

/* ── File store (fallback for local dev) ─────────────────────────────────── */

function loadFromFile() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, "utf8");
      _overrides = JSON.parse(raw) || {};
    }
  } catch (e) {
    console.warn("[runtime-config] could not load overrides from file:", e.message);
    _overrides = {};
  }
}

function saveToFile() {
  // Skip file writes when PostgreSQL is active — file is ephemeral on Render anyway
  if (_pgEnabled) return;
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(_overrides, null, 2), "utf8");
  } catch (e) {
    console.error("[runtime-config] could not save overrides to file:", e.message);
    throw e;
  }
}

// Bootstrap: load from file on module init (initDb() will overlay PG values at startup)
loadFromFile();

/* ── Public API ───────────────────────────────────────────────────────────── */

/** Get a setting value. DB/file override > .env > manifest default. */
function get(key) {
  if (key in _overrides) return String(_overrides[key]);
  if (key in process.env)  return String(process.env[key]);
  const entry = SETTINGS_MANIFEST.find((s) => s.key === key);
  return entry ? String(entry.default) : undefined;
}

/** Get a setting value as an integer. */
function getInt(key, fallback = 0) {
  const v = parseInt(get(key), 10);
  return Number.isFinite(v) ? v : fallback;
}

/** Get a setting value as a boolean (1 / "true" / "yes" = true). */
function getBool(key) {
  const v = String(get(key) || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Set a runtime override (persisted to PostgreSQL or JSON file). */
function set(key, value) {
  _overrides[key] = String(value ?? "");
  _persistToPg(key, _overrides[key]);
  saveToFile();
}

/** Set multiple keys at once. */
function setMany(pairs) {
  for (const [k, v] of Object.entries(pairs)) {
    _overrides[k] = String(v ?? "");
    _persistToPg(k, _overrides[k]);
  }
  saveToFile();
}

/** Remove a runtime override (falls back to .env / default). */
function reset(key) {
  delete _overrides[key];
  _deletePg(key);
  saveToFile();
}

/**
 * Copy manifest keys from process.env into runtime overrides (PostgreSQL or file).
 * @param {{ onlyMissing?: boolean, persist?: boolean }} opts
 * @returns {string[]} keys written
 */
function seedFromProcessEnv({ onlyMissing = true, persist = true } = {}) {
  const written = [];
  for (const entry of SETTINGS_MANIFEST) {
    const key = entry.key;
    if (onlyMissing && key in _overrides) continue;
    const raw = process.env[key];
    if (raw == null || String(raw).trim() === "") continue;
    const val = String(raw).trim();
    _overrides[key] = val;
    if (persist) {
      _persistToPg(key, val);
    }
    written.push(key);
  }
  if (written.length && persist) saveToFile();
  return written;
}

/** Return all settings with their current effective value + source. */
function getAll() {
  return SETTINGS_MANIFEST.map((entry) => {
    let value, source;
    if (entry.key in _overrides) {
      value  = _overrides[entry.key];
      source = "override";
    } else if (entry.key in process.env) {
      value  = process.env[entry.key];
      source = "env";
    } else {
      value  = String(entry.default);
      source = "default";
    }
    return { ...entry, value, source };
  });
}

/** Return all current overrides (for persistence inspection). */
function getOverrides() {
  return { ..._overrides };
}

/** Whether PostgreSQL persistence is active. */
function isDbEnabled() {
  return _pgEnabled;
}

module.exports = {
  SETTINGS_MANIFEST,
  initDb,
  get,
  getInt,
  getBool,
  set,
  setMany,
  reset,
  getAll,
  getOverrides,
  isDbEnabled,
  seedFromProcessEnv,
};
