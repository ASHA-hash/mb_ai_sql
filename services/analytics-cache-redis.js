/**
 * Optional Redis L2 cache for analytics (install: npm install ioredis).
 * Uses ANALYTICS_REDIS_URL or REDIS_URL.
 */
"use strict";

let RedisCtor = null;
let triedLoad = false;

function loadRedisCtor() {
  if (triedLoad) return RedisCtor;
  triedLoad = true;
  try {
    RedisCtor = require("ioredis");
  } catch {
    RedisCtor = null;
  }
  return RedisCtor;
}

let client = null;
let clientFailed = false;

function getRedisUrl() {
  return String(process.env.ANALYTICS_REDIS_URL || process.env.REDIS_URL || "").trim();
}

function getClient() {
  if (clientFailed) return null;
  const url = getRedisUrl();
  if (!url) {
    return null;
  }
  const R = loadRedisCtor();
  if (!R) {
    clientFailed = true;
    return null;
  }
  if (!client) {
    try {
      client = new R(url, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      client.on("error", (err) => {
        console.warn("[analytics-redis]", err.message);
      });
    } catch (err) {
      console.warn("[analytics-redis] connect failed:", err.message);
      clientFailed = true;
      return null;
    }
  }
  return client;
}

function redisKey(fp) {
  return `erp:analytics:${fp}`;
}

/**
 * @returns {Promise<object|null>} parsed { v, ts } or null
 */
async function redisGet(fp) {
  const r = getClient();
  if (!r) return null;
  try {
    const raw = await r.get(redisKey(fp));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function redisSet(fp, value, ttlSec) {
  const r = getClient();
  if (!r) return;
  try {
    const payload = JSON.stringify({ v: value, ts: Date.now() });
    await r.setex(redisKey(fp), Math.max(1, ttlSec), payload);
  } catch (err) {
    console.warn("[analytics-redis] setex:", err.message);
  }
}

async function flushAnalyticsKeys() {
  const r = getClient();
  if (!r) return;
  try {
    const stream = r.scanStream({ match: "erp:analytics:*", count: 256 });
    const acc = [];
    await new Promise((resolve, reject) => {
      stream.on("data", (keys) => {
        if (keys && keys.length) acc.push(...keys);
      });
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    for (let i = 0; i < acc.length; i += 500) {
      const chunk = acc.slice(i, i + 500);
      if (chunk.length) await r.del(...chunk);
    }
  } catch (err) {
    console.warn("[analytics-redis] flush:", err.message);
  }
}

function isEnabled() {
  return Boolean(getRedisUrl()) && Boolean(loadRedisCtor());
}

module.exports = {
  redisGet,
  redisSet,
  flushAnalyticsKeys,
  isEnabled,
};
