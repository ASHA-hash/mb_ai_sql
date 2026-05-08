/**
 * SQL Server connection retry, pool reset, and transient query retries.
 */
"use strict";

const { logger } = require("./logger");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} err
 */
function isTransientSqlError(err) {
  const m = String((err && err.message) || err || "").toLowerCase();
  return (
    /timeout|timed out|econnreset|ecanceled|connection.*(closed|lost|broken)|socket|broken pipe|read econnreset|failed to connect|communication link|deadline|acquire connection/i.test(
      m
    ) || /timeout/i.test(m)
  );
}

/**
 * Connect with exponential backoff (cold start / network blips).
 * @param {() => object} getDbConfig
 * @param {{ connect: (c:object) => Promise<import('mssql').ConnectionPool> }} mssql
 */
async function connectWithRetries(getDbConfig, mssql) {
  const max = Math.min(12, Math.max(1, parseInt(process.env.DB_CONNECT_RETRIES || "5", 10) || 5));
  let lastErr;
  const cfg = getDbConfig();
  for (let i = 0; i < max; i++) {
    try {
      const pool = await mssql.connect(cfg);
      if (i > 0) {
        logger.info("db_connected_after_retry", { attempt: i + 1 });
      }
      return pool;
    } catch (e) {
      lastErr = e;
      const delay = Math.min(10_000, 250 * Math.pow(2, i));
      logger.warn("db_connect_attempt_failed", {
        attempt: i + 1,
        max,
        retry_in_ms: delay,
        err: String(e && e.message ? e.message : e),
      });
      if (i < max - 1) await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Run an async DB operation; retry once on transient errors if SQL_QUERY_RETRIES>1.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ context?: string }} [opts]
 * @returns {Promise<T>}
 */
async function withSqlRetry(fn, opts = {}) {
  const max = Math.min(5, Math.max(1, parseInt(process.env.SQL_QUERY_RETRIES || "2", 10) || 2));
  let lastErr;
  const ctx = opts.context || "query";
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientSqlError(e) || i === max - 1) throw e;
      const delay = Math.min(1500, 80 * Math.pow(2, i));
      logger.warn("sql_transient_retry", {
        context: ctx,
        attempt: i + 1,
        retry_in_ms: delay,
        err: String(e && e.message ? e.message : e),
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = {
  connectWithRetries,
  isTransientSqlError,
  withSqlRetry,
  sleep,
};
