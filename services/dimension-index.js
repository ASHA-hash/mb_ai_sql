/**
 * In-memory loader for metadata/dimension-values.json (built by build-dimension-index.js).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const INDEX_PATH = path.join(__dirname, "../metadata/dimension-values.json");
let _cache = null;
let _mtime = 0;

function loadDimensionIndex(forceReload = false) {
  try {
    const st = fs.statSync(INDEX_PATH);
    if (!forceReload && _cache && st.mtimeMs === _mtime) return _cache;
    _cache = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
    _mtime = st.mtimeMs;
    return _cache;
  } catch {
    return {
      generatedAt: null,
      dimensions: {},
      views: {},
    };
  }
}

function getDimensionValues(dimensionKey) {
  const idx = loadDimensionIndex();
  const key = String(dimensionKey || "");
  if (idx.dimensions?.[key]) return idx.dimensions[key];
  return [];
}

function listDimensionKeys() {
  const idx = loadDimensionIndex();
  return Object.keys(idx.dimensions || {});
}

function indexIsStale(maxAgeHours = 24) {
  const idx = loadDimensionIndex();
  if (!idx.generatedAt) return true;
  const ageMs = Date.now() - new Date(idx.generatedAt).getTime();
  return ageMs > maxAgeHours * 3600 * 1000;
}

module.exports = {
  INDEX_PATH,
  loadDimensionIndex,
  getDimensionValues,
  listDimensionKeys,
  indexIsStale,
};
