/**
 * Hybrid schema retrieval: keyword scoring + RAG vector search on schema chunks.
 * AskYourDatabase-style — only inject top-N relevant views, not the full catalog.
 */
"use strict";

const ragStore = require("./rag-store");
const {
  findRelevantViews,
  formatSchemaForPrompt,
  getAllViewNames,
  loadSchema,
} = require("./schema-from-json");
const { loadSemanticLayer } = require("./business-terminology");

/**
 * Enrich column list with semantic-layer descriptions.
 */
function formatSchemaWithSemantics(viewNames) {
  const base = formatSchemaForPrompt(viewNames);
  const layer = loadSemanticLayer();
  const extra = [];

  for (const vn of viewNames || []) {
    const def = layer[vn];
    if (!def) continue;
    extra.push(`\n── ${vn} (business context) ──`);
    if (def.primaryUseCase) extra.push(`Use for: ${def.primaryUseCase}`);
    if (def.revenueColumn) extra.push(`Revenue: ${def.revenueColumn}`);
    if (def.dateColumn) extra.push(`Date: ${def.dateColumn}`);
    if (Array.isArray(def.joinHints)) {
      extra.push("Join hints:");
      def.joinHints.forEach((j) => extra.push(`  ${j}`));
    }
  }

  return base + (extra.length ? "\n" + extra.join("\n") : "");
}

/**
 * Merge keyword-ranked views with RAG schema chunk hits.
 * @param {string} question
 * @param {object} [opts]
 * @param {number} [opts.topN=5]
 * @param {string} [opts.tableHint]
 */
async function findRelevantViewsHybrid(question, opts = {}) {
  const { topN = 5, tableHint } = opts;
  const allViews = new Set(getAllViewNames());
  const merged = [];

  function add(view) {
    const v = String(view || "").trim();
    if (!v) return;
    const full = v.startsWith("dbo.") ? v : `dbo.${v}`;
    if (!allViews.has(full) && !allViews.has(v)) return;
    const name = allViews.has(full) ? full : v;
    if (!merged.includes(name)) merged.push(name);
  }

  const keywordViews = findRelevantViews(question, { topN, tableHint });
  keywordViews.forEach(add);

  const semanticOn = !/^(0|false|no)$/i.test(String(process.env.SCHEMA_RAG_SEMANTIC || "1").trim());
  if (semanticOn) {
    try {
      const hits = await ragStore.search(question, 6, { type: "schema" });
      const minScore = parseFloat(process.env.SCHEMA_RAG_MIN_SCORE || "0.52");
      for (const h of hits) {
        if (h.score < minScore) continue;
        const v = h.metadata?.view;
        if (v) add(v);
      }
    } catch (e) {
      console.warn("[schema-rag] vector search skipped:", e.message);
    }
  }

  if (merged.length < 2) {
    const fallback = "dbo.VW_MB_POWERBI_SLSXNS_REPORT";
    if (allViews.has(fallback)) add(fallback);
  }

  return merged.slice(0, topN + 1);
}

module.exports = {
  formatSchemaWithSemantics,
  findRelevantViewsHybrid,
  loadSchema,
};
