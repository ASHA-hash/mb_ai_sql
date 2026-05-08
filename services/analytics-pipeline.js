/**
 * Validation, span guardrails, and schema-style checks for analytics payloads.
 */
"use strict";

const { getFilterColumns, sanitizeColumnName } = require("../filter-query");

const DEFAULT_MAX_SPAN_DAYS = parseInt(process.env.ANALYTICS_MAX_SPAN_DAYS || "800", 10);

function assertRangeSpan(range) {
  const maxD = Number.isFinite(DEFAULT_MAX_SPAN_DAYS) ? DEFAULT_MAX_SPAN_DAYS : 800;
  const days = range && Number.isFinite(range.days) ? range.days : 0;
  if (days > maxD) {
    const e = new Error(
      `Date range too wide (${days} days). Max ${maxD} — narrow filters or raise ANALYTICS_MAX_SPAN_DAYS.`
    );
    e.status = 400;
    e.code = "range_too_wide";
    throw e;
  }
}

/**
 * Map crossFilter (SQL column → value) onto dataset URL-style filters.
 */
function crossFilterToQueryParams(datasetKey, base, crossFilter) {
  const cfg = getFilterColumns(datasetKey);
  const cf = crossFilter && typeof crossFilter === "object" ? crossFilter : {};
  const out = { ...base };
  const bCol = sanitizeColumnName(cfg.branch);
  const dCol = sanitizeColumnName(cfg.department);
  const cCol = sanitizeColumnName(cfg.category);
  if (bCol && cf[bCol] != null && String(cf[bCol]).trim()) {
    out.branch = String(cf[bCol]).trim();
  }
  if (dCol && cf[dCol] != null && String(cf[dCol]).trim()) {
    out.department = String(cf[dCol]).trim();
  }
  if (cCol && cf[cCol] != null && String(cf[cCol]).trim()) {
    out.category = String(cf[cCol]).trim();
  }
  return out;
}

/**
 * Parse SALES_ANALYTICS_DEDUPE_KEYS=InvoiceId,LineNo style env into sanitized identifiers.
 */
function parseDedupeKeyColumns() {
  const raw = String(process.env.SALES_ANALYTICS_DEDUPE_KEYS || "").trim();
  if (!raw) return [];
  const parts = raw.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const c = sanitizeColumnName(p);
    if (c) out.push(c);
  }
  return out;
}

module.exports = {
  assertRangeSpan,
  crossFilterToQueryParams,
  parseDedupeKeyColumns,
};
