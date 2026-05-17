/**
 * semantic-seeder.js
 *
 * Seeds the RAG store with rich business training data on startup.
 * Loads three metadata files:
 *   1. semantic-layer.json   — view/column business descriptions
 *   2. query-examples.json   — 60+ verified question→SQL pairs
 *   3. kpi-dictionary.json   — KPI business definitions
 *
 * Safe to call every deploy — checks embedding fingerprint and
 * only re-seeds if files changed (or force=true).
 *
 * Usage in index.js:
 *   const { seedOnStartup } = require('./services/semantic-seeder');
 *   seedOnStartup().catch(e => console.warn('[seeder] non-fatal:', e.message));
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const ragStore = require("./rag-store");

const META_DIR = path.join(__dirname, "../metadata");
const SEED_FINGERPRINT_PATH = path.join(__dirname, "../rag-seed-fingerprint.json");

function filePath(name) { return path.join(META_DIR, name); }

function fileHash(p) {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");
}

function loadFingerprint() {
  try {
    return JSON.parse(fs.readFileSync(SEED_FINGERPRINT_PATH, "utf8"));
  } catch (_) {
    return {};
  }
}

function saveFingerprint(fp) {
  try {
    fs.writeFileSync(SEED_FINGERPRINT_PATH, JSON.stringify(fp, null, 2), "utf8");
  } catch (_) {}
}

/* ─────────────────────────────────────────────────────────────────────────
   Seeding functions
────────────────────────────────────────────────────────────────────────── */

async function seedSemanticLayer() {
  const p = filePath("semantic-layer.json");
  if (!fs.existsSync(p)) return 0;
  const layer = JSON.parse(fs.readFileSync(p, "utf8"));
  let count = 0;

  for (const [viewName, def] of Object.entries(layer)) {
    if (viewName.startsWith("_")) continue; // skip _info etc.

    // Build a rich text chunk that includes business context
    const lines = [
      `View: ${viewName}`,
      `Purpose: ${def.purpose || ""}`,
      def.primaryUseCase ? `PrimaryUseCase: ${def.primaryUseCase}` : null,
      def.dateColumn   ? `DateColumn: ${def.dateColumn}`    : null,
      def.branchColumn ? `BranchColumn: ${def.branchColumn}` : null,
      def.revenueColumn? `RevenueColumn: ${def.revenueColumn}` : null,
    ].filter(Boolean);

    if (def.keyColumns && typeof def.keyColumns === "object") {
      lines.push("KeyColumns:");
      for (const [col, desc] of Object.entries(def.keyColumns)) {
        lines.push(`  ${col}: ${desc}`);
      }
    }

    if (Array.isArray(def.neverUse) && def.neverUse.length) {
      lines.push("NeverUse:");
      def.neverUse.forEach(n => lines.push(`  ❌ ${n}`));
    }

    if (Array.isArray(def.joinHints) && def.joinHints.length) {
      lines.push("JoinHints:");
      def.joinHints.forEach(h => lines.push(`  ${h}`));
    }

    const chunkText = lines.join("\n");
    try {
      await ragStore.addSchemaChunk(viewName, chunkText);
      count++;
    } catch (e) {
      console.warn(`[seeder] semantic layer chunk failed for ${viewName}:`, e.message);
    }
  }
  return count;
}

async function seedQueryExamples() {
  const p = filePath("query-examples.json");
  if (!fs.existsSync(p)) return 0;
  const examples = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(examples)) return 0;

  let count = 0;
  for (const ex of examples) {
    if (!ex.question || !ex.sql) continue;
    const note = [
      ex.explanation || "",
      ex.views_used ? `Views: ${ex.views_used.join(", ")}` : "",
      ex.chart_type  ? `Chart: ${ex.chart_type}` : "",
      ex.category    ? `Category: ${ex.category}` : "",
    ].filter(Boolean).join(" | ");

    try {
      await ragStore.addExample(ex.question, ex.sql, note);
      count++;
    } catch (e) {
      console.warn(`[seeder] example failed for ${ex.id}:`, e.message);
    }
  }
  return count;
}

async function seedKpiDictionary() {
  const p = filePath("kpi-dictionary.json");
  if (!fs.existsSync(p)) return 0;
  const kpis = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(kpis)) return 0;

  let count = 0;
  for (const kpi of kpis) {
    if (!kpi.term || !kpi.definition) continue;

    // Build a rich definition text
    const defText = [
      kpi.definition,
      kpi.sql_pattern ? `SQL: ${kpi.sql_pattern}` : null,
      kpi.view        ? `View: ${kpi.view}`        : null,
      kpi.category    ? `Category: ${kpi.category}` : null,
      Array.isArray(kpi.aliases) && kpi.aliases.length
        ? `Also called: ${kpi.aliases.join(", ")}`
        : null,
    ].filter(Boolean).join(". ");

    try {
      await ragStore.addGlossary(kpi.term, defText);
      count++;
    } catch (e) {
      console.warn(`[seeder] glossary failed for ${kpi.term}:`, e.message);
    }
  }
  return count;
}

/* ─────────────────────────────────────────────────────────────────────────
   Main entry point — call from index.js after server starts
────────────────────────────────────────────────────────────────────────── */
let _seeding = false;

async function seedOnStartup(force = false) {
  if (_seeding) return;
  _seeding = true;

  try {
    const files = ["semantic-layer.json", "query-examples.json", "kpi-dictionary.json"];
    const currentHashes = {};
    for (const f of files) {
      currentHashes[f] = fileHash(filePath(f));
    }

    const savedFP = loadFingerprint();
    const changed = force || files.some(f => savedFP[f] !== currentHashes[f]);

    if (!changed) {
      console.log("[seeder] metadata unchanged — skipping re-seed");
      return;
    }

    console.log("[seeder] seeding RAG store with business training data…");

    // Clear old seeded data if re-seeding (not on very first run)
    if (Object.keys(savedFP).length > 0) {
      // Remove stale schema and glossary chunks to avoid duplicates
      try {
        const stale = ragStore.listByType ? [
          ...(ragStore.listByType("schema") || []),
          ...(ragStore.listByType("glossary") || []),
          ...(ragStore.listByType("example") || []),
        ] : [];
        // Only remove if we have a fresh set to replace with
        for (const doc of stale) {
          if (doc && doc.id) ragStore.remove && ragStore.remove(doc.id);
        }
      } catch (_) {}
    }

    const [schemaCount, exCount, kpiCount] = await Promise.all([
      seedSemanticLayer(),
      seedQueryExamples(),
      seedKpiDictionary(),
    ]);

    saveFingerprint(currentHashes);
    console.log(
      `[seeder] ✓ seeded ${schemaCount} view descriptions + ` +
      `${exCount} query examples + ${kpiCount} KPI definitions`
    );
  } catch (err) {
    console.error("[seeder] seed failed:", err.message);
  } finally {
    _seeding = false;
  }
}

module.exports = { seedOnStartup };
