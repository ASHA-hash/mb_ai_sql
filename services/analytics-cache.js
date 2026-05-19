/**
 * Two-tier cache: in-process LRU + optional Redis-style stub hook.
 * Keys are fingerprinted; entries carry TTL and dataVersion for invalidation.
 *
 * Stale-while-revalidate (SWR):
 *   Each entry has a primary TTL and a stale TTL (default 4× primary).
 *   While stale but within stale TTL, the old value is returned immediately
 *   and a background refresh is triggered. This means the UI always gets data
 *   instantly — even for 180d/YTD queries that take minutes to run fresh.
 *
 *   Set ANALYTICS_STALE_TTL_MULTIPLIER=0 to disable SWR (strict TTL, old behaviour).
 */
"use strict";

const crypto = require("crypto");
const redisLayer = require("./analytics-cache-redis");
const runtimeConfig = require("./runtime-config");

const MAX_KEYS = parseInt(process.env.ANALYTICS_CACHE_MAX_KEYS || "400", 10);

// Hot-reloadable: read from runtimeConfig each call (no module-level const)
function getDefaultTtlMs() {
  return runtimeConfig.getInt("ANALYTICS_CACHE_TTL_MS", 600000);
}
function getStaleMult() {
  return Math.max(0, parseFloat(runtimeConfig.get("ANALYTICS_STALE_TTL_MULTIPLIER") ?? "4"));
}

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

/** Keys currently being refreshed in the background — prevents thundering herd */
const _revalidating = new Set();

/**
 * @template T
 * @param {string} namespace
 * @param {object} keyPayload
 * @param {() => Promise<T>} factory
 * @param {{ ttlMs?: number }} [opt]
 */
async function getOrSet(namespace, keyPayload, factory, opt) {
  const ttlMs = Number.isFinite(opt && opt.ttlMs) ? opt.ttlMs : getDefaultTtlMs();
  const staleMult = getStaleMult();
  const staleTtlMs = staleMult > 0 ? ttlMs * staleMult : 0;
  const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
  const fp = fingerprint({ ns: namespace, ...keyPayload, epoch: dataEpoch });
  const now = Date.now();

  // ── Fresh hit (within primary TTL) ──────────────────────────────────────
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

  // ── Stale-while-revalidate: return old data, refresh in background ───────
  if (staleTtlMs > 0 && memHit && now - memHit.ts < staleTtlMs) {
    if (!_revalidating.has(fp)) {
      _revalidating.add(fp);
      _backgroundRefresh(fp, namespace, factory, ttlMs, ttlSec).finally(() =>
        _revalidating.delete(fp)
      );
    }
    return { value: memHit.value, cacheHit: true, cacheLayer: "memory-stale", key: fp };
  }

  // ── Cache miss: run factory synchronously ────────────────────────────────
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

/** Silently refresh a key in the background without blocking the caller. */
async function _backgroundRefresh(fp, namespace, factory, ttlMs, ttlSec) {
  try {
    const fresh = await factory();
    validateDashboardPayloadLocal(fresh);
    evictIfNeeded();
    store.set(fp, { ts: Date.now(), value: fresh });
    if (redisLayer.isEnabled()) {
      redisLayer.redisSet(fp, fresh, ttlSec).catch(() => {});
    }
  } catch (e) {
    // Keep stale data; log quietly — don't crash the process
    console.warn("[analytics-cache] background refresh failed, keeping stale:", e.message);
  }
}

/**
 * Populate a cache entry directly (used by warmup).
 * Skips TTL check — forces the value in regardless of current state.
 */
function primeCache(namespace, keyPayload, value, ttlMs) {
  const ttlSec = Math.max(1, Math.ceil((ttlMs || getDefaultTtlMs()) / 1000));
  const fp = fingerprint({ ns: namespace, ...keyPayload, epoch: dataEpoch });
  evictIfNeeded();
  store.set(fp, { ts: Date.now(), value });
  if (redisLayer.isEnabled()) {
    redisLayer.redisSet(fp, value, ttlSec).catch(() => {});
  }
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
  primeCache,
  invalidateAll,
  bumpDataEpoch,
  getDataEpoch,
  fingerprint,
  registerAnalyticsSse,
  unregisterAnalyticsSse,
  broadcastAnalyticsEvent,
};
