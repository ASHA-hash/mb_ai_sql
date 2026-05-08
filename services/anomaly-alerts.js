/**
 * Optional outbound alerts when pre-viz anomaly scan finds spikes/drops.
 * Set ANOMALY_WEBHOOK_URL to POST a JSON payload (Slack-compatible hook, etc.).
 */
"use strict";

const crypto = require("crypto");

/** @type {Map<string, number>} */
const lastSent = new Map();

function fingerprint(messages) {
  return crypto.createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 24);
}

/**
 * @param {{ warnings?: object[], anomalies?: object[] }} result
 * @param {Record<string, unknown>} context dataset, periodFrom, periodTo, dataVersion, etc.
 */
async function notifyAnomalyAlerts(result, context = {}) {
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const anomalies = Array.isArray(result?.anomalies) ? result.anomalies : [];
  const notable = [...warnings, ...anomalies].filter(
    (x) =>
      x &&
      (x.severity === "warn" || String(x.code || "").startsWith("anomaly_") || x.alert === true)
  );
  if (!notable.length) return;

  const minGap = parseInt(process.env.ANOMALY_WEBHOOK_MIN_MS || "300000", 10) || 300000;
  const key = fingerprint(notable.map((x) => x.code + (x.message || "")));
  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < minGap) return;
  lastSent.set(key, now);

  const url = String(process.env.ANOMALY_WEBHOOK_URL || "").trim();
  const body = {
    source: "erp-analytics-pre-viz",
    ts: new Date().toISOString(),
    context,
    count: notable.length,
    items: notable.slice(0, 20),
  };

  if (String(process.env.ANOMALY_LOG_ALERTS || "").trim() === "1") {
    console.warn("[anomaly-alerts]", JSON.stringify(body));
  }

  if (!url) return;

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(t);
  } catch (e) {
    console.warn("[anomaly-alerts] webhook failed:", e.message);
  }
}

module.exports = { notifyAnomalyAlerts };
