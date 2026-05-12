/**
 * rag-schema-indexer.js
 *
 * Reads schema-registry-columns.json (the live source of truth) and indexes
 * every view/table as a searchable RAG chunk. Called once on server start
 * (idempotent — skips if already done this session).
 *
 * Supports two JSON formats:
 *   A) schema-registry-columns.json  — { objectsMeta: [ { qualifiedName, datasetLabel,
 *        aiDomains, columns: [ { column_name, data_type, is_nullable } ] } ] }
 *   B) db_tables_views_columns.json  — { views: { "dbo.Name": { columns: { ColName: {...} } } } }
 *
 * Each RAG chunk text produced (format A example):
 *   View: dbo.VwAISalesData
 *   Label: Sales
 *   Domains: sales, customer, stock
 *   Columns:
 *     SaleNetAmount (numeric(12,2))
 *     BranchId      (char(3))  ← NOTE: use JOIN VwAIBranch for branch name/alias
 *     …
 *
 * This lets retrieve_context surface the exact view and columns for any
 * natural-language question, preventing column-name hallucination.
 */
"use strict";

const fs       = require("fs");
const path     = require("path");
const ragStore = require("./rag-store");

// Primary: the live schema-registry file generated from the DB
const SCHEMA_REGISTRY_PATH = path.join(__dirname, "../metadata/schema-registry-columns.json");
// Legacy fallback
const SCHEMA_LEGACY_PATH   = path.join(__dirname, "../metadata/db_tables_views_columns.json");

let _indexed = false;

/* ─────────────────────────────────────────────────────────────────────────
   Format A parser — schema-registry-columns.json
   objectsMeta is an array of objects with a columns[] array.
───────────────────────────────────────────────────────────────────────── */
function parseRegistryFormat(raw) {
  const entries = [];
  const objects = raw.objectsMeta || [];
  for (const obj of objects) {
    const fullName = obj.qualifiedName;
    if (!fullName) continue;

    const cols = Array.isArray(obj.columns) ? obj.columns : [];
    if (!cols.length) continue; // skip tables with no columns listed

    const colLines = cols.map(c => {
      const nullable = (String(c.is_nullable || "").toUpperCase() === "YES") ? ", nullable" : "";
      return `  ${c.column_name} (${c.data_type}${nullable})`;
    });

    // Build a JOIN hint for views that use BranchId instead of BranchAlias
    const hasBranchId    = cols.some(c => c.column_name === "BranchId");
    const hasBranchAlias = cols.some(c => c.column_name === "BranchAlias");
    const joinHints = [];
    if (hasBranchId && !hasBranchAlias) {
      joinHints.push("JOIN dbo.VwAIBranch ON BranchId to get BranchShortName / BranchName");
    }

    const domains   = (obj.aiDomains || []).join(", ");
    const label     = obj.datasetLabel || fullName;
    const datasetKey = obj.datasetKey  || "";

    let chunkText =
      `View: ${fullName}\n` +
      `Label: ${label}\n` +
      (datasetKey ? `DatasetKey: ${datasetKey}\n` : "") +
      (domains    ? `Domains: ${domains}\n`       : "") +
      `Columns:\n${colLines.join("\n")}`;

    if (joinHints.length) {
      chunkText += `\nJoin hints:\n${joinHints.map(h => `  ${h}`).join("\n")}`;
    }

    entries.push({ fullName, chunkText });
  }
  return entries;
}

/* ─────────────────────────────────────────────────────────────────────────
   Format B parser — legacy db_tables_views_columns.json
   views is a map: { "dbo.Name": { columns: { ColName: { data_type, ... } } } }
───────────────────────────────────────────────────────────────────────── */
function parseLegacyFormat(raw) {
  const entries  = [];
  const viewsMap = raw.views || {};
  for (const [fullName, viewDef] of Object.entries(viewsMap)) {
    if (!viewDef || typeof viewDef !== "object") continue;
    const cols = viewDef.columns || {};
    const colEntries = Object.entries(cols);
    if (!colEntries.length) continue;

    const colLines = colEntries.map(([colName, meta]) => {
      const dtype    = meta.data_type || "unknown";
      const nullable = meta.is_nullable ? ", nullable" : "";
      return `  ${colName} (${dtype}${nullable})`;
    });

    const chunkText =
      `View: ${fullName}\n` +
      `Type: ${viewDef.type || "view"}\n` +
      `Columns:\n${colLines.join("\n")}`;

    entries.push({ fullName, chunkText });
  }
  return entries;
}

/* ─────────────────────────────────────────────────────────────────────────
   Main indexSchema function
───────────────────────────────────────────────────────────────────────── */
async function indexSchema(force = false) {
  if (_indexed && !force) return;

  // Determine which file to use
  let schemaPath, formatHint;
  if (fs.existsSync(SCHEMA_REGISTRY_PATH)) {
    schemaPath = SCHEMA_REGISTRY_PATH;
    formatHint = "registry";
  } else if (fs.existsSync(SCHEMA_LEGACY_PATH)) {
    schemaPath = SCHEMA_LEGACY_PATH;
    formatHint = "legacy";
  } else {
    console.error(
      "[rag-schema-indexer] no schema JSON found — tried:\n" +
      `  ${SCHEMA_REGISTRY_PATH}\n  ${SCHEMA_LEGACY_PATH}`
    );
    return;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch (e) {
    console.error("[rag-schema-indexer] cannot parse schema JSON:", e.message);
    return;
  }

  // Parse into { fullName, chunkText }[] entries
  const entries = formatHint === "registry"
    ? parseRegistryFormat(raw)
    : parseLegacyFormat(raw);

  if (!entries.length) {
    console.warn(`[rag-schema-indexer] no columns found in ${schemaPath}`);
    return;
  }

  console.log(`[rag-schema-indexer] indexing ${entries.length} objects from ${path.basename(schemaPath)}…`);
  let done = 0;

  for (const { fullName, chunkText } of entries) {
    try {
      await ragStore.addSchemaChunk(fullName, chunkText);
      done++;
    } catch (e) {
      console.error(`[rag-schema-indexer] failed to index ${fullName}:`, e.message);
    }
  }

  console.log(`[rag-schema-indexer] ✓ indexed ${done}/${entries.length} views/tables`);
  _indexed = true;
}

/** Returns true if schema has been indexed this session. */
function isIndexed() { return _indexed; }

module.exports = { indexSchema, isIndexed };
