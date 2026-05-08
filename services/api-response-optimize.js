/**
 * Smaller API payloads: field projection, compact diagnostics, optional MessagePack.
 */
"use strict";

function getDeep(obj, path) {
  if (!path || obj == null) return undefined;
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function setDeep(root, path, value) {
  const parts = String(path).split(".");
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

function validatePathSegment(path) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){0,12}$/.test(path)) {
    return false;
  }
  return path.length <= 200;
}

/**
 * Whitelist projection: only paths starting with known dashboard roots (anti-injection).
 */
const DASHBOARD_ROOTS = new Set([
  "schemaVersion",
  "loadPhase",
  "dataVersion",
  "computedAt",
  "dataset",
  "table",
  "rollupHint",
  "dimensions",
  "period",
  "trendContext",
  "kpi",
  "widgets",
  "vizHints",
  "quality",
  "crossFilter",
  "insights",
  "insightsMeta",
  "cacheHit",
  "cacheLayer",
  "queryPlan",
]);

function isAllowedPath(path) {
  const root = path.split(".")[0];
  return DASHBOARD_ROOTS.has(root);
}

/**
 * @param {object} payload
 * @param {string[]} paths - e.g. ["kpi","widgets.trend","period"]
 * @returns {object}
 */
function filterByFieldPaths(payload, paths) {
  if (!payload || typeof payload !== "object") return payload;
  if (!paths || !paths.length) return payload;

  const out = {};
  for (let raw of paths) {
    const p = String(raw).trim();
    if (!p || !validatePathSegment(p) || !isAllowedPath(p)) continue;
    const v = getDeep(payload, p);
    if (v !== undefined) {
      setDeep(out, p, v);
    }
  }
  return Object.keys(out).length ? out : payload;
}

/**
 * Drop heavy / debug-heavy nodes for bandwidth-constrained clients.
 */
function compactDashboardPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const q = payload.quality;
  if (!q || typeof q !== "object") return payload;

  const quality = { ...q };
  delete quality.duplicateProbe;
  if (quality.reconciliation && typeof quality.reconciliation === "object") {
    const r = quality.reconciliation;
    quality.reconciliation = {
      ok: r.ok,
      skipped: r.skipped,
      mismatch: r.mismatch,
      compared: r.compared,
      reason: r.reason,
    };
  }
  if (quality.sourceSync && typeof quality.sourceSync === "object") {
    const s = quality.sourceSync;
    quality.sourceSync = {
      rangeMaxDate: s.rangeMaxDate,
      trendSeriesSum: s.trendSeriesSum,
      kpiTrendAligned: s.kpiTrendAligned,
      trendVsKpiSkipped: s.trendVsKpiSkipped,
    };
  }

  const next = { ...payload, quality };
  if (next.widgets && typeof next.widgets === "object") {
    const W = { ...next.widgets };
    for (const w of ["byBranch", "byDepartment", "byCategory", "byTrend"]) {
      const wd = W[w];
      if (wd && typeof wd === "object" && wd.progressive != null) {
        W[w] = { ...wd, progressive: { mode: wd.progressive.mode || "full" } };
      }
    }
    next.widgets = W;
  }
  return next;
}

/**
 * Parse fields from body.query: array or comma-separated string.
 */
function parseFieldsList(body) {
  const b = body && typeof body === "object" ? body : {};
  const raw = b.fields != null ? b.fields : b.include;
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return null;
}

/**
 * @param {object} dashboardPayload - runAnalyticsDashboard result
 * @param {object} [reqBody] - original request body (fields, compact, format)
 */
function shapeAnalyticsResponse(dashboardPayload, reqBody) {
  const body = reqBody && typeof reqBody === "object" ? reqBody : {};
  let out =
    String(process.env.API_ANALYTICS_COMPACT_DEFAULT || "").trim() === "1" || body.compact === true
      ? compactDashboardPayload(dashboardPayload)
      : dashboardPayload;

  const paths = parseFieldsList(body);
  if (paths && paths.length) {
    out = filterByFieldPaths(out, paths);
  }

  return out;
}

/**
 * Client requests binary JSON-like payload (smaller wire size vs UTF-8 JSON for numeric-heavy data).
 */
function clientWantsMsgpack(req, body) {
  if (String(process.env.API_MSGPACK_DISABLE || "").trim() === "1") return false;
  const acc = String(req.get("Accept") || "");
  if (/application\/x-msgpack|application\/vnd\.msgpack/i.test(acc)) return true;
  if (String(req.query && req.query.format) === "msgpack") return true;
  if (body && typeof body === "object" && String(body.format || "").toLowerCase() === "msgpack") {
    return true;
  }
  return false;
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {object} payload
 */
function sendJsonOrMsgpack(req, res, payload) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (clientWantsMsgpack(req, body)) {
    try {
      const { encode } = require("@msgpack/msgpack");
      const buf = encode(payload);
      res.setHeader("Content-Type", "application/x-msgpack");
      res.send(Buffer.from(buf));
      return;
    } catch (e) {
      console.warn("[api-response-optimize] msgpack encode failed, falling back to JSON:", e.message);
    }
  }
  res.json(payload);
}

module.exports = {
  filterByFieldPaths,
  compactDashboardPayload,
  shapeAnalyticsResponse,
  clientWantsMsgpack,
  sendJsonOrMsgpack,
};
