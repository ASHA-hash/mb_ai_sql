/**
 * Smart query planner for analytics: cache vs live, rollup vs raw, join heuristics.
 * All decision rules are documented in PLANNER_RULES and mirrored in plan().trace.
 */
"use strict";

const sql = require("mssql");
const { resolveDatasetTable, sanitizeTableName } = require("./analytics-reconciliation");

/**
 * Human-readable spec for ops / docs. Keys mirror env vars and branch points in planAnalyticsDashboard.
 */
const PLANNER_RULES = {
  cache: {
    useCache_default:
      "Use the shared analytics cache (memory + optional Redis) unless bypassed by env or request.",
    ANALYTICS_CACHE_DISABLE:
      "When =1, planner sets useCache=false on every call (operations / debugging).",
    ANALYTICS_FORCE_LIVE:
      "When =1, same as cache disable — always run the query path (still may populate cache for others unless disabled).",
    request_bypass:
      "JSON body bypassCache=true | noCache=true | cache=no skips read-through cache for this request.",
    ttl_volatile_range:
      "MTD, short spans (≤7d): multiply ANALYTICS_CACHE_TTL_MS by ANALYTICS_CACHE_TTL_SHORT_RANGE_MULT (default 0.5) — data changes more often.",
    ttl_stable_range:
      "FY or spans >180d: multiply by ANALYTICS_CACHE_TTL_LONG_RANGE_MULT (default 1.5) — aggregates are more stable.",
  },
  physicalPath: {
    rollup_first_when_env:
      "If ANALYTICS_USE_LINE_ROLLUP=1 and ANALYTICS_ROLLUP_DAILY_TABLE is set, use the rollup table (pre-aggregated daily grain) unless smart mode overrides.",
    ANALYTICS_BASE_TABLE:
      "Overrides the dataset default table for the “raw/canonical” path when rollup is not chosen.",
    ANALYTICS_PLANNER_SMART_ROLLUP:
      "When =1, choose rollup only if date span ≥ ANALYTICS_ROLLUP_MIN_SPAN_DAYS (default 14) OR estimated canonical rows ≥ ANALYTICS_ROLLUP_MIN_RAW_ROWS (default 5e6). Otherwise scan raw/canonical for cheaper small-range queries.",
    estimates:
      "Row estimates come from sys.partitions (OBJECT_ID) — approximate; used only for planning.",
  },
  joins: {
    single_fact:
      "Current dashboard queries are single-table fact/rollup scans (WHERE + GROUP BY).",
    multi_table_future:
      "For star joins, prefer building from the smallest dimension first (hash-friendly); large fact → apply filters before join expansion.",
    large_scan:
      "If span or estimated rows exceed thresholds, mark joinPlan.largeScan and preferHashJoin for downstream SQL generators.",
  },
};

function parseEnvInt(key, defaultVal) {
  const n = parseInt(String(process.env[key] || ""), 10);
  return Number.isFinite(n) ? n : defaultVal;
}

function parseEnvFloat(key, defaultVal) {
  const n = parseFloat(String(process.env[key] || ""));
  return Number.isFinite(n) ? n : defaultVal;
}

/**
 * Approximate row count for a schema-qualified table or view (sys.partitions).
 * @param {import("mssql").ConnectionPool | null} pool
 * @param {string} qualifiedTable e.g. dbo.VwAISalesData
 * @returns {Promise<number | null>}
 */
async function estimateObjectRowCount(pool, qualifiedTable) {
  if (!pool || !qualifiedTable) return null;
  const q = String(qualifiedTable).trim();
  if (!sanitizeTableName(q)) return null;
  try {
    const req = pool.request();
    req.input("qt", sql.NVarChar(512), q);
    const r = await req.query(`
      DECLARE @oid INT = OBJECT_ID(@qt);
      SELECT CASE WHEN @oid IS NULL THEN NULL ELSE (
        SELECT SUM(CAST(p.rows AS BIGINT))
        FROM sys.partitions p
        WHERE p.object_id = @oid AND p.index_id IN (0, 1)
      ) END AS row_count;
    `);
    const row = r.recordset && r.recordset[0];
    const n = row && row.row_count != null ? parseInt(String(row.row_count), 10) : null;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Same behavior as the historical resolveEffectiveTable in analytics-dashboard (sync).
 * @param {string} datasetKey
 * @returns {string | null}
 */
function resolveEffectiveTable(datasetKey) {
  const rollupDaily = sanitizeTableName(process.env.ANALYTICS_ROLLUP_DAILY_TABLE || "");
  if (rollupDaily && String(process.env.ANALYTICS_USE_LINE_ROLLUP || "").trim() === "1") {
    return rollupDaily;
  }
  const base = resolveDatasetTable(datasetKey);
  const override = sanitizeTableName(process.env.ANALYTICS_BASE_TABLE || "");
  return override || base;
}

/**
 * @param {import("mssql").ConnectionPool | null} pool
 * @param {{
 *   datasetKey: string,
 *   range: { preset?: string, from: string, to: string, days?: number },
 *   body?: Record<string, unknown>,
 * }} ctx
 */
async function planAnalyticsDashboard(pool, ctx) {
  const datasetKey = String(ctx.datasetKey || "sales").toLowerCase().trim();
  const range = ctx.range || { from: "", to: "", days: 1 };
  const body = ctx.body && typeof ctx.body === "object" ? ctx.body : {};

  const spanDays = Math.max(1, Number.isFinite(range.days) ? range.days : 1);
  const preset = String(range.preset || "").toLowerCase();

  const trace = [];

  /** Cache vs live */
  let useCache = true;
  let cacheReason = "cache_default";

  if (String(process.env.ANALYTICS_CACHE_DISABLE || "").trim() === "1") {
    useCache = false;
    cacheReason = "ANALYTICS_CACHE_DISABLE";
    trace.push({ rule: cacheReason, outcome: "live" });
  } else if (String(process.env.ANALYTICS_FORCE_LIVE || "").trim() === "1") {
    useCache = false;
    cacheReason = "ANALYTICS_FORCE_LIVE";
    trace.push({ rule: cacheReason, outcome: "live" });
  } else if (
    body.bypassCache === true ||
    body.noCache === true ||
    String(body.cache || "").toLowerCase() === "no"
  ) {
    useCache = false;
    cacheReason = "request_bypass";
    trace.push({ rule: "body_bypass", outcome: "live" });
  }

  const baseTtl = parseEnvInt("ANALYTICS_CACHE_TTL_MS", 120000);
  let ttlMult = 1;
  if (preset === "mtd" || spanDays <= 7) {
    ttlMult = parseEnvFloat("ANALYTICS_CACHE_TTL_SHORT_RANGE_MULT", 0.5);
    trace.push({ rule: "ttl_short_range", mult: ttlMult });
  }
  if (preset === "fy" || spanDays > 180) {
    const longM = parseEnvFloat("ANALYTICS_CACHE_TTL_LONG_RANGE_MULT", 1.5);
    ttlMult = Math.max(ttlMult, longM);
    trace.push({ rule: "ttl_long_range", mult: ttlMult });
  }
  const cacheTtlMs = Math.max(5000, Math.floor(baseTtl * ttlMult));

  /** Raw / canonical table */
  const rawFromRegistry = resolveDatasetTable(datasetKey);
  const baseOverride = sanitizeTableName(process.env.ANALYTICS_BASE_TABLE || "");
  const canonicalRaw = baseOverride || rawFromRegistry;

  const rollupDaily = sanitizeTableName(process.env.ANALYTICS_ROLLUP_DAILY_TABLE || "");
  const useLineRollupEnv = String(process.env.ANALYTICS_USE_LINE_ROLLUP || "").trim() === "1";
  const smartRollup = String(process.env.ANALYTICS_PLANNER_SMART_ROLLUP || "").trim() === "1";

  let effectiveTable = canonicalRaw;
  let tablePath = "canonical_raw";

  let estimatedRowsCanonical = null;
  let estimatedRowsRollup = null;

  if (rollupDaily && useLineRollupEnv) {
    if (!smartRollup) {
      effectiveTable = rollupDaily;
      tablePath = "rollup_daily";
      trace.push({ rule: "rollup_env", outcome: rollupDaily });
    } else {
      const minSpan = parseEnvInt("ANALYTICS_ROLLUP_MIN_SPAN_DAYS", 14);
      const minRawRows = parseEnvInt("ANALYTICS_ROLLUP_MIN_RAW_ROWS", 5000000);

      if (pool && canonicalRaw) {
        estimatedRowsCanonical = await estimateObjectRowCount(pool, canonicalRaw);
      }
      if (pool && rollupDaily) {
        estimatedRowsRollup = await estimateObjectRowCount(pool, rollupDaily);
      }

      const preferRollup =
        spanDays >= minSpan ||
        (estimatedRowsCanonical != null && estimatedRowsCanonical >= minRawRows);

      if (preferRollup) {
        effectiveTable = rollupDaily;
        tablePath = "rollup_daily_smart";
        trace.push({
          rule: "smart_rollup_pick",
          spanDays,
          minSpan,
          estimatedRowsCanonical,
          minRawRows,
        });
      } else {
        effectiveTable = canonicalRaw;
        tablePath = "raw_preferred_small_range";
        trace.push({
          rule: "smart_rollup_skip",
          spanDays,
          estimatedRowsCanonical,
        });
      }
    }
  } else {
    effectiveTable = canonicalRaw;
    if (baseOverride) {
      tablePath = "base_table_override";
      trace.push({ rule: "ANALYTICS_BASE_TABLE", table: baseOverride });
    } else {
      trace.push({ rule: "dataset_registry", table: canonicalRaw });
    }
  }

  const thresholdLargeRows = parseEnvInt("ANALYTICS_PLANNER_LARGE_SCAN_ROWS", 5000000);
  const thresholdSpan = parseEnvInt("ANALYTICS_PLANNER_LARGE_SCAN_DAYS", 400);

  const largeScan =
    spanDays > thresholdSpan ||
    (estimatedRowsCanonical != null && estimatedRowsCanonical > thresholdLargeRows) ||
    (estimatedRowsRollup != null && estimatedRowsRollup > thresholdLargeRows);

  const joinPlan = {
    strategy: "single_fact",
    buildOrder: ["apply_fact_filters_first", "then_group_aggregate"],
    preferHashJoin: largeScan,
    largeScan,
    hint:
      "Dashboard path is single table. For NL/AI joins to dimensions, prefer filtering the fact early; order joins smallest-dimension build when estimating cardinality.",
  };

  return {
    datasetKey,
    useCache,
    cacheReason,
    cacheTtlMs,
    effectiveTable: effectiveTable || null,
    tablePath,
    spanDays,
    estimatedRowsCanonical,
    estimatedRowsRollup,
    joinPlan,
    trace,
    rulesReference: "PLANNER_RULES",
  };
}

/**
 * Execution flow (for logs / UI): ordered stages the worker follows.
 */
const EXECUTION_FLOW = [
  "1. planAnalyticsDashboard — decide cache, TTL, physical table, join heuristics.",
  "2. If useCache — getOrSet(namespace, keyPayload, factory); else run factory only (live).",
  "3. loadDashboardPayload — buildFilterContext → KPI / breakdown / trend SQL on effectiveTable.",
  "4. Optional reconciliation and quality — unchanged; uses resolveDatasetTable line source.",
  "5. Return payload + cacheHit; attach queryPlan when ANALYTICS_RETURN_PLAN=1.",
];

module.exports = {
  PLANNER_RULES,
  EXECUTION_FLOW,
  planAnalyticsDashboard,
  resolveEffectiveTable,
  estimateObjectRowCount,
};
