/**
 * Resolve registry dataset key → qualified dbo table/view + known Mst* → view fallbacks.
 */
"use strict";

const { getDatasetEntry } = require("../filter-query");

function sanitizeTableName(raw) {
  const s = String(raw || "").trim();
  if (!/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(s)) return null;
  return s;
}

/** Master tables the app login often cannot SELECT — map to permitted views. */
const DATASET_TABLE_VIEW_FALLBACK = {
  "dbo.MstSalesPerson": "dbo.VwAISalesPerson",
};

function resolveDatasetTable(datasetKey) {
  const e = getDatasetEntry(datasetKey);
  if (!e) return null;
  let full = e.defaultTable;
  if (e.envOverride && process.env[e.envOverride]) {
    full = process.env[e.envOverride];
  }
  const sanitized = sanitizeTableName(full);
  if (!sanitized) return null;
  const fb = DATASET_TABLE_VIEW_FALLBACK[sanitized];
  if (fb) {
    const view = sanitizeTableName(fb);
    if (view) return view;
  }
  return sanitized;
}

module.exports = {
  sanitizeTableName,
  DATASET_TABLE_VIEW_FALLBACK,
  resolveDatasetTable,
};
