/**
 * Drill-through: parameterized row-level fetch for analytics context (no raw SQL from client).
 */
"use strict";

const { getDatasetEntry } = require("../filter-query");
const { crossFilterToQueryParams } = require("./analytics-pipeline");

function sanitizeTableName(raw) {
  const s = String(raw || "").trim();
  if (!/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(s)) return null;
  return s;
}

function resolveDatasetTable(datasetKey) {
  const e = getDatasetEntry(datasetKey);
  if (!e) return null;
  let full = e.defaultTable;
  if (e.envOverride && process.env[e.envOverride]) {
    full = process.env[e.envOverride];
  }
  return sanitizeTableName(full);
}

function buildDrillQueryObject(body) {
  const from = body.from != null ? String(body.from).trim() : "";
  const to = body.to != null ? String(body.to).trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const e = new Error("from and to are required as yyyy-mm-dd");
    e.status = 400;
    e.code = "invalid_drill_range";
    throw e;
  }
  const base = { from, to };
  if (body.branch != null && String(body.branch).trim()) base.branch = String(body.branch).trim();
  if (body.department != null && String(body.department).trim()) {
    base.department = String(body.department).trim();
  }
  if (body.category != null && String(body.category).trim()) base.category = String(body.category).trim();
  if (body.status != null && String(body.status).trim()) base.status = String(body.status).trim();
  const datasetKey = String(body.dataset || "sales").toLowerCase().trim();
  return crossFilterToQueryParams(datasetKey, base, body.crossFilter);
}

module.exports = {
  resolveDatasetTable,
  buildDrillQueryObject,
};
