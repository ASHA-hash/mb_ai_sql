/**
 * Probe SELECT permission per registry dataset table (TOP 1).
 */
"use strict";

const { DATASET_REGISTRY } = require("../datasets-registry");
const { resolveDatasetTable } = require("./dataset-table-resolve");

function isPermissionDeniedError(err) {
  const msg = String((err && err.message) || err || "");
  const n = err && err.number != null ? parseInt(String(err.number), 10) : null;
  return n === 229 || /permission was denied/i.test(msg) || /SELECT permission/i.test(msg);
}

async function probeTableAccess(pool, qualifiedTable) {
  const table = String(qualifiedTable || "").trim();
  if (!table) {
    return { ok: false, denied: false, message: "invalid_table" };
  }
  try {
    await pool.request().query(`SELECT TOP (1) 1 AS ok FROM ${table} WITH (NOLOCK)`);
    return { ok: true, denied: false, table };
  } catch (err) {
    return {
      ok: false,
      denied: isPermissionDeniedError(err),
      table,
      message: String(err.message || err),
      code: err.number != null ? err.number : undefined,
    };
  }
}

async function probeAllRegistryDatasets(pool) {
  const results = [];
  for (const entry of DATASET_REGISTRY) {
    const table = resolveDatasetTable(entry.key);
    if (!table) {
      results.push({
        key: entry.key,
        label: entry.label,
        table: null,
        ok: false,
        denied: false,
        message: "table_not_configured",
      });
      continue;
    }
    const probe = await probeTableAccess(pool, table);
    results.push({
      key: entry.key,
      label: entry.label,
      table,
      ok: probe.ok,
      denied: probe.denied,
      message: probe.message || null,
      code: probe.code,
    });
  }
  return results;
}

module.exports = {
  isPermissionDeniedError,
  probeTableAccess,
  probeAllRegistryDatasets,
};
