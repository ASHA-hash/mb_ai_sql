/**
 * Query reliability: classify failures, retries (delegates to db-resilience), optional mirror fallback,
 * structured logs + optional webhook alerts for broken queries / missing paths.
 */
"use strict";

const crypto = require("crypto");
const { logger } = require("./logger");
const { withSqlRetry, isTransientSqlError } = require("./db-resilience");
const {
  getMirrorUrl,
  loadMirrorSnapshotRows,
  filterMirrorRows,
} = require("../mirror-read");

/** @type {Map<string, number>} */
const lastIncidentSent = new Map();

function webhookMinMs() {
  return parseInt(process.env.QUERY_RELIABILITY_WEBHOOK_MIN_MS || "120000", 10) || 120000;
}

function mirrorFallbackOnLiveFailureEnabled() {
  const v = String(process.env.QUERY_RELIABILITY_MIRROR_ON_LIVE_FAILURE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function alertOnEmptyFilteredEnabled() {
  const v = String(process.env.QUERY_RELIABILITY_ALERT_EMPTY_FILTERED || "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function classifySqlFailure(err) {
  if (!err) return "unknown";
  const st = /** @type {any} */ (err).status;
  if (st === 400) return "client_validation";
  const m = String((err && /** @type {any} */ (err).message) || err || "").toLowerCase();
  if (isTransientSqlError(err)) return "transient";
  if (/invalid object name|'[^']+' is not recognized|cannot find.*object/i.test(m)) return "broken_object_missing";
  if (/syntax|incorrect syntax/i.test(m)) return "syntax";
  if (/permission|denied|login failed/i.test(m)) return "permission";
  if (/conversion failed|operand type clash/i.test(m)) return "type_mismatch";
  return "unknown";
}

/**
 * @param {{ code: string, severity?: string, context?: string, datasetKey?: string, message?: string, detail?: Record<string, unknown>, fallbackUsed?: boolean }} payload
 */
async function notifyQueryIncident(payload) {
  const severity = payload.severity || "warn";
  const keySrc = `${payload.code}|${payload.context || ""}|${payload.message || ""}`;
  const key = crypto.createHash("sha256").update(keySrc).digest("hex").slice(0, 20);
  const now = Date.now();
  if (now - (lastIncidentSent.get(key) || 0) < webhookMinMs()) return;
  lastIncidentSent.set(key, now);

  const row = {
    ts: new Date().toISOString(),
    source: "erp-query-reliability",
    ...payload,
  };

  logger.warn("query_reliability_incident", row);

  const url = String(process.env.QUERY_RELIABILITY_WEBHOOK_URL || "").trim();
  if (!url || severity === "debug") return;

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
      signal: ac.signal,
    });
    clearTimeout(t);
  } catch (e) {
    logger.warn("query_reliability_webhook_failed", { err: String(e && e.message ? e.message : e) });
  }
}

/**
 * Run a parameterized dataset query with transient retries + optional PostgreSQL mirror fallback.
 * Does not swallow HTTP 400–style validation errors from appendDatasetFilterWhere.
 *
 * @param {() => Promise<{ recordset: object[] }>} executeQuery - typically runFilteredDatasetQuery result
 * @param {{ context: string, datasetKey: string, limit: number, query: object }} meta
 * @returns {Promise<{ recordset: object[], source: 'live'|'mirror_fallback', degraded?: boolean }>}
 */
async function executeDatasetQueryWithReliability(executeQuery, meta) {
  const { context, datasetKey, limit, query } = meta;

  /** @type {unknown} */
  let primaryErr = null;
  try {
    const result = await withSqlRetry(executeQuery, { context });
    const rs = Array.isArray(result.recordset) ? result.recordset : [];

    const hasActiveFilters =
      !!(query &&
        typeof query === "object" &&
        (query.from ||
          query.to ||
          query.branch ||
          query.branches ||
          query.department ||
          query.category ||
          query.status));

    if (
      alertOnEmptyFilteredEnabled() &&
      rs.length === 0 &&
      hasActiveFilters &&
      parseInt(String(limit), 10) >= 50
    ) {
      await notifyQueryIncident({
        code: "empty_filtered_result",
        severity: "info",
        context,
        datasetKey,
        message: "Query returned zero rows with active filters — may be valid or stale filters/data.",
        detail: {
          filterKeys: Object.keys(query || {}).filter((k) => String(query[k] || "").trim()),
        },
      });
    }

    return { recordset: rs, source: "live" };
  } catch (e) {
    primaryErr = e;
    const kind = classifySqlFailure(e);
    logger.warn("query_primary_failed", {
      context,
      datasetKey,
      classify: kind,
      message: String((/** @type {any} */ (e).message) || e),
    });

    /** Validation errors — never mirror-hide */
    const st = /** @type {any} */ (primaryErr).status;
    if (st === 400) throw primaryErr;

    const canMirror =
      mirrorFallbackOnLiveFailureEnabled() &&
      !!getMirrorUrl() &&
      String(datasetKey || "").trim().length > 0;

    if (canMirror) {
      try {
        const snap = await loadMirrorSnapshotRows(datasetKey);
        if (!snap || !Array.isArray(snap.rows)) {
          await notifyQueryIncident({
            code: "mirror_fallback_unavailable_snapshot",
            severity: "error",
            context,
            datasetKey,
            message: "Live failed and mirror snapshot missing or unreadable.",
            detail: { classify: classifySqlFailure(primaryErr) },
          });
          throw primaryErr;
        }
        const filtered = filterMirrorRows(snap.rows, datasetKey, limit, query);
        if (filtered.error) {
          await notifyQueryIncident({
            code: "mirror_fallback_filter_validation",
            severity: "warn",
            context,
            datasetKey,
            message: String(filtered.error.message || "mirror filter rejected"),
          });
          throw primaryErr;
        }
        await notifyQueryIncident({
          code: "mirror_fallback_succeeded",
          severity: "info",
          context,
          datasetKey,
          fallbackUsed: true,
          message: "Served mirror snapshot after live SQL Server failure.",
          detail: {
            mirrorSyncedAt: snap.syncedAt ? String(snap.syncedAt) : null,
            storedRowCount: snap.storedRowCount,
          },
        });
        return {
          recordset: filtered.rows,
          source: "mirror_fallback",
          degraded: true,
        };
      } catch (mirrorErr) {
        if (mirrorErr === primaryErr) throw primaryErr;
        await notifyQueryIncident({
          code: "mirror_fallback_failed",
          severity: "error",
          context,
          datasetKey,
          message: `Live: ${String(
            (primaryErr && /** @type {any} */ (primaryErr).message) || primaryErr
          )}; Mirror: ${String((mirrorErr && /** @type {any} */ (mirrorErr).message) || mirrorErr)}`,
        });
      }
    }

    await notifyQueryIncident({
      code: "query_failed_final",
      severity: kind === "permission" ? "warn" : "error",
      context,
      datasetKey,
      message: String((primaryErr && /** @type {any} */ (primaryErr).message) || primaryErr),
      detail: { classify: kind },
    });
    throw primaryErr;
  }
}

/**
 * One-shot transient retry wrapper for heavier handlers (analytics bundle).
 */
async function executeWithSqlRetryBundle(fn, context) {
  return withSqlRetry(fn, { context });
}

module.exports = {
  classifySqlFailure,
  notifyQueryIncident,
  executeDatasetQueryWithReliability,
  executeWithSqlRetryBundle,
  mirrorFallbackOnLiveFailureEnabled,
};
