/**
 * rag-schema-indexer.js
 *
 * Reads db_tables_views_columns.json and indexes every view as a searchable
 * RAG chunk. Called once on server start (idempotent — skips if already done).
 *
 * Each chunk text:
 *   View: dbo.VwAISalesData
 *   Columns: SaleNetAmount (decimal), InvoiceDt (datetime), BranchId (int) …
 *
 * This lets retrieve_context surface the right views for a query even when
 * keyword scoring misses the intent.
 */
"use strict";

const fs       = require("fs");
const path     = require("path");
const ragStore = require("./rag-store");

const SCHEMA_PATH = path.join(__dirname, "../metadata/db_tables_views_columns.json");

let _indexed = false;

/**
 * Index all views from the schema JSON.
 * @param {boolean} force  Re-index even if already done this session.
 */
async function indexSchema(force = false) {
  if (_indexed && !force) return;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  } catch (e) {
    console.error("[rag-schema-indexer] cannot read schema JSON:", e.message);
    return;
  }

  // Schema JSON structure: { database, views: { "dbo.ViewName": { columns: { ColName: { data_type, ... } } } } }
  const viewsMap = raw.views || {};
  const entries  = Object.entries(viewsMap);

  if (!entries.length) {
    console.warn("[rag-schema-indexer] no views found in schema JSON");
    return;
  }

  console.log(`[rag-schema-indexer] indexing ${entries.length} views…`);
  let done = 0;

  for (const [fullName, viewDef] of entries) {
    if (!viewDef || typeof viewDef !== "object") continue;

    const cols = viewDef.columns || {};
    const colLines = Object.entries(cols).map(([colName, meta]) => {
      const dtype    = meta.data_type || "unknown";
      const nullable = meta.is_nullable ? ", nullable" : "";
      const len      = meta.character_maximum_length
        ? ` (max ${meta.character_maximum_length})`
        : "";
      return `  ${colName} (${dtype}${len}${nullable})`;
    });

    const chunkText =
      `View: ${fullName}\n` +
      `Type: ${viewDef.type || "view"}\n` +
      `Columns:\n${colLines.join("\n")}`;

    try {
      await ragStore.addSchemaChunk(fullName, chunkText);
      done++;
    } catch (e) {
      console.error(`[rag-schema-indexer] failed to index ${fullName}:`, e.message);
    }
  }

  console.log(`[rag-schema-indexer] ✓ indexed ${done}/${entries.length} views`);
  _indexed = true;
}

/** Returns true if schema has been indexed this session. */
function isIndexed() { return _indexed; }

module.exports = { indexSchema, isIndexed };
