/**
 * In-process KPI collection for latency, errors, and data-freshness lag.
 * For production dashboards, forward samples to Prometheus / OpenTelemetry / your APM.
 */
"use strict";

const MAX_SAMPLES = parseInt(process.env.MONITORING_ROLLING_SIZE || "400", 10) || 400;
const startedAt = new Date().toISOString();

/** KPI definitions (names, units, how measured) — exposed in GET /api/monitoring/kpis */
const KPI_DEFINITIONS = [
  {
    id: "query_response_time_ms",
    name: "Query response time",
    description:
      "Server-side duration of NL→SQL endpoints: POST /api/query/ai, /api/query/adaptive, /api/query/agentic.",
    unit: "ms",
    howMeasured: "Express middleware: time to first byte of response (includes OpenAI + SQL execution).",
    targetHintEnv: "KPI_TARGET_QUERY_MS",
    improvement: "Cache schema prompts, reduce model rounds, add DB indexes, use deterministic path when possible.",
  },
  {
    id: "dashboard_load_time_ms",
    name: "Dashboard load time",
    description: "Server-side time to build the analytics dashboard payload (POST /api/analytics/dashboard).",
    unit: "ms",
    howMeasured: "Express middleware end-to-end for that route only.",
    targetHintEnv: "KPI_TARGET_DASHBOARD_MS",
    improvement:
      "LRU/Redis cache hits, rollup tables (ANALYTICS_USE_LINE_ROLLUP), narrow date span, read replica for heavy SELECTs.",
  },
  {
    id: "data_freshness_lag_ms",
    name: "Data freshness lag",
    description:
      "How far behind “now” the latest ETL/source watermark is when a dashboard response is served.",
    unit: "ms",
    howMeasured:
      "When quality.sourceSync.watermarkMax is present: Date.now() - watermark (parsed as SQL Server datetime string).",
    targetHintEnv: "KPI_TARGET_FRESHNESS_LAG_MS",
    improvement: "Shrink ETL batch interval, POST /api/analytics/invalidate-cache after loads, CDC-driven epoch bumps.",
  },
  {
    id: "error_rate",
    name: "Error rate",
    description: "Share of requests that end in HTTP 5xx (server errors).",
    unit: "ratio",
    howMeasured: "Per route group: count_5xx / total_requests in the rolling window.",
    targetHintEnv: "KPI_TARGET_ERROR_RATE",
    improvement: "Alert on spikes; tie releases to error logs; circuit-break slow dependencies.",
  },
];

/** @type {Record<string, { durations: number[], count5xx: number, count4xx: number, total: number }>} */
const routeStats = {};

/** @type {number[]} */
const freshnessLagSamples = [];

function bucketForPath(method, rawPath) {
  const p = String(rawPath || "").split("?")[0].replace(/\/$/, "") || "/";
  if (p === "/api/analytics/dashboard" && method === "POST") return "analytics_dashboard";
  if (p === "/api/query/ai" && method === "POST") return "query_ai";
  if (p === "/api/query/adaptive" && method === "POST") return "query_adaptive";
  if (p === "/api/query/agentic" && method === "POST") return "query_agentic";
  if (p.startsWith("/api/")) return "api_other";
  return null;
}

function ensureBucket(key) {
  if (!routeStats[key]) {
    routeStats[key] = { durations: [], count5xx: 0, count4xx: 0, total: 0 };
  }
  return routeStats[key];
}

function pushLimited(arr, val) {
  arr.push(val);
  while (arr.length > MAX_SAMPLES) arr.shift();
}

/**
 * @param {string | null} key
 * @param {number} durationMs
 * @param {number} statusCode
 */
function recordHttpRequest(key, durationMs, statusCode) {
  if (!key) return;
  const b = ensureBucket(key);
  b.total += 1;
  pushLimited(b.durations, durationMs);
  if (statusCode >= 500) b.count5xx += 1;
  else if (statusCode >= 400) b.count4xx += 1;

  if (String(process.env.MONITORING_REQUEST_LOG || "").trim() === "1") {
    console.log(`[metric] ${key} ${durationMs}ms status=${statusCode}`);
  }
}

function parseSqlServerLikeDate(s) {
  if (s == null) return null;
  const t = Date.parse(String(s).trim());
  return Number.isFinite(t) ? t : null;
}

/**
 * Call with analytics dashboard JSON payload after generation.
 * @param {object} payload
 */
function recordDataFreshnessFromPayload(payload) {
  const ss = payload && payload.quality && payload.quality.sourceSync;
  const wm = ss && ss.watermarkMax != null ? parseSqlServerLikeDate(ss.watermarkMax) : null;
  if (wm == null) return;
  const lagMs = Math.max(0, Date.now() - wm);
  pushLimited(freshnessLagSamples, lagMs);
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function summarizeDurations(arr) {
  if (!arr || !arr.length) {
    return { n: 0, mean_ms: null, p50_ms: null, p95_ms: null, min_ms: null, max_ms: null };
  }
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n,
    mean_ms: Math.round((sum / n) * 100) / 100,
    p50_ms: Math.round(percentile(s, 50)),
    p95_ms: Math.round(percentile(s, 95)),
    min_ms: Math.round(s[0]),
    max_ms: Math.round(s[n - 1]),
  };
}

function errorRate(b) {
  if (!b.total) return null;
  return {
    rate_5xx: Math.round((b.count5xx / b.total) * 10000) / 10000,
    rate_4xx: Math.round((b.count4xx / b.total) * 10000) / 10000,
    pct_5xx: Math.round((100 * b.count5xx) / b.total * 100) / 100,
    count_5xx: b.count5xx,
    count_4xx: b.count4xx,
    total: b.total,
  };
}

function readEnvTarget(name, fallback) {
  const v = parseInt(String(process.env[name] || ""), 10);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Express middleware: record duration + status for API routes.
 */
function httpMetricsMiddleware() {
  return (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    const pathOnly = String(req.path || req.url || "").split("?")[0];
    if (pathOnly === "/api/health" || pathOnly === "/api/monitoring/kpis") {
      return next();
    }
    const key = bucketForPath(req.method, pathOnly);
    if (!key) return next();

    const t0 = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - t0;
      recordHttpRequest(key, ms, res.statusCode || 0);
    });
    next();
  };
}

function getSnapshot() {
  const targets = {
    query_response_ms: readEnvTarget("KPI_TARGET_QUERY_MS", 8000),
    dashboard_response_ms: readEnvTarget("KPI_TARGET_DASHBOARD_MS", 3000),
    freshness_lag_ms: readEnvTarget("KPI_TARGET_FRESHNESS_LAG_MS", 3 * 60 * 60 * 1000),
    error_rate_5xx: parseFloat(process.env.KPI_TARGET_ERROR_RATE || "0.01") || 0.01,
  };

  const routes = {};
  for (const [k, v] of Object.entries(routeStats)) {
    routes[k] = {
      http: summarizeDurations(v.durations),
      errors: errorRate(v),
    };
  }

  const fresh = summarizeDurations(freshnessLagSamples);
  const combinedQuery = ["query_ai", "query_adaptive", "query_agentic"]
    .map((k) => routeStats[k])
    .filter(Boolean);
  const qDur = combinedQuery.flatMap((b) => b.durations);
  const querySummary = summarizeDurations(qDur);

  return {
    service: "erp-api",
    processStartedAt: startedAt,
    collectedAt: new Date().toISOString(),
    window: {
      samplesPerRoute: MAX_SAMPLES,
      note: "In-memory rolling window for this process only. Restart clears history.",
    },
    definitions: KPI_DEFINITIONS,
    targets,
    kpis: {
      query_response_time_ms: {
        ...querySummary,
        routeBreakdown: {
          query_ai: summarizeDurations(routeStats.query_ai?.durations || []),
          query_adaptive: summarizeDurations(routeStats.query_adaptive?.durations || []),
          query_agentic: summarizeDurations(routeStats.query_agentic?.durations || []),
        },
      },
      dashboard_load_time_ms: summarizeDurations(routeStats.analytics_dashboard?.durations || []),
      data_freshness_lag_ms: {
        ...fresh,
        samplesOnlyWhenWatermark: true,
      },
      error_rate: {
        analytics_dashboard: errorRate(routeStats.analytics_dashboard || { total: 0, count5xx: 0, count4xx: 0 }),
        query_ai: errorRate(routeStats.query_ai || { total: 0, count5xx: 0, count4xx: 0 }),
        query_adaptive: errorRate(routeStats.query_adaptive || { total: 0, count5xx: 0, count4xx: 0 }),
        api_other: errorRate(routeStats.api_other || { total: 0, count5xx: 0, count4xx: 0 }),
      },
    },
    routes,
    continuousImprovement: {
      exportTo: "Forward logs with [metric] prefix, or scrape this JSON via cron and store in a time-series DB.",
      alerts: "Compare kpis.* to targets; alert when p95 > target or error_rate_5xx > KPI_TARGET_ERROR_RATE for 5+ minutes.",
      reviewCadence: "Weekly: review p95 trends, freshness lag, top 5xx routes from application logs.",
    },
  };
}

module.exports = {
  KPI_DEFINITIONS,
  httpMetricsMiddleware,
  recordDataFreshnessFromPayload,
  recordHttpRequest,
  getSnapshot,
  bucketForPath,
};
