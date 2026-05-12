/**
 * rag-store.js
 *
 * Pure-JS semantic vector store for ERP RAG accuracy engine.
 * • No external vector DB required — embeddings stored in rag-store.json
 * • Uses OpenAI text-embedding-3-small (1536-d) via @langchain/openai
 * • Supports three document types: "example", "glossary", "schema"
 * • Cosine similarity retrieval
 *
 * Public API:
 *   addExample(question, sql, note)   → id
 *   addGlossary(term, definition)     → id
 *   addSchemaChunk(viewName, colText) → id
 *   search(query, k, filter)          → [{id, text, metadata, score}]
 *   remove(id)                        → bool
 *   listByType(type)                  → [{id, text, metadata, addedAt}]
 *   stats()                           → {total, byType}
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const { OpenAIEmbeddings } = require("@langchain/openai");

const STORE_PATH = path.join(__dirname, "../rag-store.json");

/* ── Embedder (lazy singleton) ─────────────────────────────────────────────── */
let _embedder = null;
function getEmbedder() {
  if (!_embedder) {
    _embedder = new OpenAIEmbeddings({
      model:      process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
      apiKey:     process.env.OPENAI_API_KEY,
      dimensions: 1536,
    });
  }
  return _embedder;
}

/* ── In-memory store ───────────────────────────────────────────────────────── */
/**
 * @type {Array<{id:string, text:string, embedding:number[], metadata:object, addedAt:string}>}
 */
let docs = [];

/* ── Cosine similarity ─────────────────────────────────────────────────────── */
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom < 1e-10 ? 0 : dot / denom;
}

/* ── Persistence ───────────────────────────────────────────────────────────── */
function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
      docs = Array.isArray(raw) ? raw : [];
      console.log(`[rag-store] loaded ${docs.length} docs`);
    }
  } catch (e) {
    console.error("[rag-store] load failed:", e.message);
    docs = [];
  }
}

function save() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(docs, null, 2));
  } catch (e) {
    console.error("[rag-store] save failed:", e.message);
  }
}

/* ── Core add / search ─────────────────────────────────────────────────────── */
function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function _embed(text) {
  return getEmbedder().embedQuery(String(text));
}

async function _add(text, metadata = {}) {
  const embedding = await _embed(text);
  const id = genId();
  docs.push({ id, text, embedding, metadata, addedAt: new Date().toISOString() });
  save();
  return id;
}

/**
 * Search by semantic similarity.
 * @param {string} query
 * @param {number} k
 * @param {object|null} filter  — exact-match on metadata keys, e.g. { type: "example" }
 * @returns {Promise<Array<{id,text,metadata,addedAt,score}>>}
 */
async function search(query, k = 5, filter = null) {
  if (!docs.length) return [];
  const qEmb = await _embed(query);
  let pool = docs;
  if (filter && typeof filter === "object") {
    pool = docs.filter(d => {
      for (const [fk, fv] of Object.entries(filter)) {
        if (d.metadata[fk] !== fv) return false;
      }
      return true;
    });
  }
  return pool
    .map(d => ({
      id:      d.id,
      text:    d.text,
      metadata: d.metadata,
      addedAt: d.addedAt,
      score:   cosineSim(qEmb, d.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/* ── Typed helpers ─────────────────────────────────────────────────────────── */

/**
 * Store a successful NL→SQL query pair for few-shot retrieval.
 * Deduplicates on question text.
 */
async function addExample(question, sql, note = "", autoSaved = false) {
  const qLow = String(question).toLowerCase().trim();
  // Deduplicate — remove any existing exact-match
  const idx = docs.findIndex(
    d => d.metadata.type === "example" &&
         String(d.metadata.question || "").toLowerCase().trim() === qLow
  );
  if (idx >= 0) docs.splice(idx, 1);

  const text =
    `QUERY EXAMPLE\nQuestion: ${question}\nSQL: ${sql}` +
    (note ? `\nNote: ${note}` : "");
  return _add(text, { type: "example", question, sql, note, autoSaved });
}

/**
 * Store a business glossary term for domain grounding.
 * Deduplicates on term.
 */
async function addGlossary(term, definition) {
  const tLow = String(term).toLowerCase().trim();
  const idx = docs.findIndex(
    d => d.metadata.type === "glossary" &&
         String(d.metadata.term || "").toLowerCase().trim() === tLow
  );
  if (idx >= 0) docs.splice(idx, 1);

  const text = `BUSINESS TERM: ${term}\nDefinition: ${definition}`;
  return _add(text, { type: "glossary", term, definition });
}

/**
 * Index one view's schema as a searchable chunk.
 * Replaces any existing chunk for the same view.
 */
async function addSchemaChunk(viewName, colText) {
  docs = docs.filter(
    d => !(d.metadata.type === "schema" && d.metadata.view === viewName)
  );
  const embedding = await _embed(colText);
  const id = `schema:${viewName}`;
  docs.push({
    id, text: colText, embedding,
    metadata:  { type: "schema", view: viewName },
    addedAt:   new Date().toISOString(),
  });
  save();
  return id;
}

/** Remove a document by id. Returns true if removed. */
function remove(id) {
  const before = docs.length;
  docs = docs.filter(d => d.id !== id);
  if (docs.length !== before) { save(); return true; }
  return false;
}

/**
 * Update an existing example by id (re-embeds with new text).
 * Returns the updated doc (without embedding) or null if not found.
 */
async function updateExample(id, question, sql, note = "") {
  const idx = docs.findIndex(d => d.id === id && d.metadata.type === "example");
  if (idx < 0) return null;
  const existing = docs[idx];
  const text =
    `QUERY EXAMPLE\nQuestion: ${question}\nSQL: ${sql}` +
    (note ? `\nNote: ${note}` : "");
  const embedding = await _embed(text);
  docs[idx] = {
    ...existing,
    text,
    embedding,
    metadata: { ...existing.metadata, question, sql, note },
    updatedAt: new Date().toISOString(),
  };
  save();
  const { embedding: _emb, ...safe } = docs[idx];
  return safe;
}

/**
 * Thumbs-up an example — marks it verified=true.
 * Returns true if found and updated.
 */
function thumbsUp(id) {
  const idx = docs.findIndex(d => d.id === id && d.metadata.type === "example");
  if (idx < 0) return false;
  docs[idx].metadata.verified  = true;
  docs[idx].metadata.thumbsUp  = (docs[idx].metadata.thumbsUp || 0) + 1;
  docs[idx].metadata.thumbsDown = 0;
  save();
  return true;
}

/**
 * Thumbs-down an example — removes it from the store.
 * Returns true if removed.
 */
function thumbsDown(id) {
  return remove(id);
}

/** List all docs of a given type (without embeddings). */
function listByType(type) {
  return docs
    .filter(d => d.metadata.type === type)
    .map(({ id, text, metadata, addedAt, updatedAt }) => ({ id, text, metadata, addedAt, updatedAt }))
    .sort((a, b) => {
      // Verified first, then newest first
      if (a.metadata.verified && !b.metadata.verified) return -1;
      if (!a.metadata.verified && b.metadata.verified) return 1;
      return new Date(b.addedAt) - new Date(a.addedAt);
    });
}

/** Summary counts. */
function stats() {
  const byType = {};
  for (const d of docs) {
    const t = d.metadata.type || "unknown";
    byType[t] = (byType[t] || 0) + 1;
  }
  return { total: docs.length, byType };
}

// ── Boot ────────────────────────────────────────────────────────────────────
load();

module.exports = {
  search,
  addExample,
  addGlossary,
  addSchemaChunk,
  remove,
  updateExample,
  thumbsUp,
  thumbsDown,
  listByType,
  stats,
  load,
  save,
};
