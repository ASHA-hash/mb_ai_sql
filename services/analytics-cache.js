/**
 * Two-tier cache: in-process LRU + optional Redis-style stub hook.
 * Keys are fingerprinted; entries carry TTL and dataVersion for invalidation.
 */
"use strict";

const crypto = require("crypto");
const redisLayer = require("./analytics-cache-redis");

const DEFAULT_TTL_MS = parseInt(process.env.ANALYTICS_CACHE_TTL_MS || "120000", 10);
const MAX_KEYS = parseInt(process.env.ANALYTICS_CACHE_MAX_KEYS || "400", 10);

/** Monotonic epoch bumped when source data is considered refreshed */
let dataEpoch = Date.now();

/** @type {Set<import("http").ServerResponse>} */
const sseClients = new Set();

function registerAnalyticsSse(res) {
  sseClients.add(res);
}

function unregisterAnalyticsSse(res) {
  sseClients.delete(res);
}

function broadcastAnalyticsEvent(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const r of sseClients) {
    try {
      r.write(line);
    } catch {
      sseClients.delete(r);
    }
  }
}

function bumpDataEpoch() {
  dataEpoch = Date.now();
  store.clear();
  redisLayer.flushAnalyticsKeys().catch(() => {});
  broadcastAnalyticsEvent({ type: "invalidate", dataVersion: dataEpoch, ts: new Date().toISOString() });
  return dataEpoch;
}

function getDataEpoch() {
  return dataEpoch;
}

const store = new Map();

function fingerprint(obj) {
  const s = JSON.stringify(obj);
  return crypto.createHash("sha256").update(s).digest("hex");
}

function evictIfNeeded() {
  if (store.size <= MAX_KEYS) return;
  const first = store.keys().next().value;
  if (first != null) store.delete(first);
}

/**
 * @template T
 * @param {string} namespace
 * @param {object} keyPayload
 * @param {() => Promise<T>} factory
 * @param {{ ttlMs?: number }} [opt]
 */
async function getOrSet(namespace, keyPayload, factory, opt) {
  const ttlMs = Number.isFinite(opt && opt.ttlMs) ? opt.ttlMs : DEFAULT_TTL_MS;
  const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
  const fp = fingerprint({ ns: namespace, ...keyPayload, epoch: dataEpoch });
  const now = Date.now();

  const memHit = store.get(fp);
  if (memHit && now - memHit.ts < ttlMs) {
    return { value: memHit.value, cacheHit: true, cacheLayer: "memory", key: fp };
  }

  if (redisLayer.isEnabled()) {
    const rHit = await redisLayer.redisGet(fp);
    if (rHit && rHit.v !== undefined && now - rHit.ts < ttlMs) {
      store.set(fp, { ts: now, value: rHit.v });
      evictIfNeeded();
      return { value: rHit.v, cacheHit: true, cacheLayer: "redis", key: fp };
    }
  }

  const value = await factory();
  try {
    validateDashboardPayloadLocal(value);
  } catch (e) {
    console.error("[analytics-cache] payload validation failed:", e.message);
    throw e;
  }
  evictIfNeeded();
  store.set(fp, { ts: now, value });
  if (redisLayer.isEnabled()) {
    redisLayer.redisSet(fp, value, ttlSec).catch(() => {});
  }
  return { value, cacheHit: false, cacheLayer: "miss", key: fp };
}

/** Lazy require avoids circular deps with analytics-dashboard. */
function validateDashboardPayloadLocal(v) {
  const { validateDashboardPayload, validateWidgetsPhasePayload } = require("./analytics-schema-validate");
  if (v && v.loadPhase === "widgets") validateWidgetsPhasePayload(v);
  else validateDashboardPayload(v);
}

function invalidateAll() {
  store.clear();
  dataEpoch = Date.now();
  redisLayer.flushAnalyticsKeys().catch(() => {});
  broadcastAnalyticsEvent({ type: "invalidate", dataVersion: dataEpoch, ts: new Date().toISOString() });
  return dataEpoch;
}

module.exports = {
  getOrSet,
  invalidateAll,
  bumpDataEpoch,
  getDataEpoch,
  fingerprint,
  registerAnalyticsSse,
  unregisterAnalyticsSse,
  broadcastAnalyticsEvent,
};
