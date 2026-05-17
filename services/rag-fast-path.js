/**
 * Run approved RAG examples directly — skip LLM SQL generation when we already have verified SQL.
 */
"use strict";

const ragStore = require("./rag-store");

function normalizeQuestion(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exact match on normalized question text (verified examples only). */
function findVerifiedExampleExact(question) {
  const nq = normalizeQuestion(question);
  if (!nq) return null;

  for (const ex of ragStore.listByType("example")) {
    const meta = ex.metadata || {};
    if (!meta.verified || !meta.sql) continue;
    if (normalizeQuestion(meta.question) === nq) {
      return {
        id: ex.id,
        question: meta.question,
        sql: String(meta.sql).trim(),
        match: "exact",
      };
    }
  }
  return null;
}

/** High-similarity verified example (embedding search). */
async function findVerifiedExampleSemantic(question) {
  if (/^(0|false|no)$/i.test(String(process.env.RAG_FAST_PATH_SEMANTIC || "1").trim())) {
    return null;
  }
  const minScore = parseFloat(process.env.RAG_FAST_PATH_MIN_SCORE || "0.92");
  const hits = await ragStore.search(question, 5, { type: "example" });
  for (const h of hits) {
    const meta = h.metadata || {};
    if (!meta.verified || !meta.sql) continue;
    if (h.score >= minScore) {
      return {
        id: h.id,
        question: meta.question,
        sql: String(meta.sql).trim(),
        match: "semantic",
        score: h.score,
      };
    }
  }
  return null;
}

async function resolveVerifiedExample(question) {
  return findVerifiedExampleExact(question) || (await findVerifiedExampleSemantic(question));
}

function prepareExecSql(sql, rowLimit = 500) {
  const trimmed = String(sql || "").trim();
  const stripped = trimmed
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .trim();
  const sqlUpper = stripped.toUpperCase();
  if (!sqlUpper.startsWith("SELECT") && !sqlUpper.startsWith("WITH")) {
    const err = new Error("Only SELECT/WITH statements allowed");
    err.code = "invalid_sql";
    throw err;
  }
  if (sqlUpper.startsWith("SELECT") && !/^\s*SELECT\s+TOP\s+\d+/i.test(trimmed)) {
    return trimmed.replace(/^\s*SELECT\s+/i, `SELECT TOP ${rowLimit} `);
  }
  return trimmed;
}

async function executeVerifiedSql(pool, sql, rowLimit = 500) {
  const execSql = prepareExecSql(sql, rowLimit);
  const request = pool.request();
  const timeoutMs = parseInt(process.env.RAG_FAST_PATH_DB_TIMEOUT_MS || "120000", 10);
  request.timeout = Math.max(15000, timeoutMs);
  const result = await request.query(execSql);
  return { execSql, rows: result.recordset || [] };
}

function isFastPathEnabled() {
  return !/^(0|false|no)$/i.test(String(process.env.RAG_FAST_PATH_ENABLED || "1").trim());
}

/** Skip fast path when user picked custom dates (stored SQL may not match). */
function shouldSkipForDatePicker(fromDate, toDate) {
  const from = String(fromDate || "").trim();
  const to = String(toDate || "").trim();
  return !!(from && to);
}

module.exports = {
  normalizeQuestion,
  findVerifiedExampleExact,
  findVerifiedExampleSemantic,
  resolveVerifiedExample,
  prepareExecSql,
  executeVerifiedSql,
  isFastPathEnabled,
  shouldSkipForDatePicker,
};
