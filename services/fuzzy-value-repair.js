/**
 * Fuzzy repair of filter literals (branch / category / dept typos) before LLM SQL generation.
 * Uses dimension-values.json index + Levenshtein (string-auto-correct).
 */
"use strict";

const { applyAutoCorrectionsToQuestion, findClosestDatabaseValue } = require("./string-auto-correct");
const { getDimensionValues, listDimensionKeys, loadDimensionIndex } = require("./dimension-index");

const DIMENSION_SCAN_ORDER = [
  "BranchAlias",
  "Category",
  "CategoryShortName",
  "Department",
  "DepartmentShortName",
  "SupplierName",
  "SupplierAlias",
];

/**
 * If user typed a substring of a real branch (e.g. "chenai" → 11-RP area), suggest exact value.
 */
function repairSubstringDimensionTokens(question, corrections) {
  let text = String(question || "");
  const idx = loadDimensionIndex();
  if (!idx.generatedAt) return { text, corrections };

  const qLower = text.toLowerCase();
  const dims = DIMENSION_SCAN_ORDER.filter((d) => getDimensionValues(d).length > 0);

  for (const dim of dims) {
    const values = getDimensionValues(dim);
    for (const real of values) {
      const realLower = String(real).toLowerCase();
      if (realLower.length < 4) continue;
      if (qLower.includes(realLower)) continue;

      const parts = realLower.split(/[\s\-_/]+/).filter((p) => p.length >= 4);
      for (const part of parts) {
        if (part.length < 4 || qLower.includes(part)) continue;
        const re = new RegExp(`\\b${part.slice(0, Math.min(part.length, 12))}\\w*`, "i");
        const m = text.match(re);
        if (!m || m[0].length < 4) continue;
        const { match, distance } = findClosestDatabaseValue(m[0], dim, { maxDistance: 2 });
        if (match && distance > 0 && distance <= 2) {
          const tokenRe = new RegExp(`\\b${escapeRegex(m[0])}\\b`, "gi");
          if (tokenRe.test(text)) {
            text = text.replace(tokenRe, `'${match}'`);
            corrections.push({ from: m[0], to: match, dimension: dim, distance, kind: "substring" });
          }
        }
      }
    }
  }
  return { text, corrections };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} processedQuestion — often output of normalizeUserLanguage
 * @param {{ question?: string, maxDistance?: number }} [opts]
 */
function repairFilterValues(processedQuestion, opts = {}) {
  const original = String(opts.question || processedQuestion || "").trim();
  let text = String(processedQuestion || original).trim();
  const corrections = [];

  const auto = applyAutoCorrectionsToQuestion(text, {
    maxDistance: opts.maxDistance ?? 3,
    dimensions: opts.dimensions || listDimensionKeys(),
  });
  if (auto.correctedQuestion) text = auto.correctedQuestion;
  for (const c of auto.corrections || []) {
    corrections.push({ ...c, kind: "levenshtein" });
  }

  const sub = repairSubstringDimensionTokens(text, corrections);
  text = sub.text;

  return {
    text,
    corrections,
    indexLoaded: Boolean(auto.indexLoaded),
  };
}

function buildValueRepairEnrichmentBlock(corrections) {
  if (!corrections?.length) return "";
  const lines = corrections.map((c) => {
    const via = c.kind === "substring" ? "substring" : `edit distance ${c.distance ?? "?"}`;
    return `- "${c.from}" → exact filter \`${c.to}\` (${c.dimension || "dimension"}, ${via})`;
  });
  return [
    "### FUZZY VALUE REPAIR (deterministic)",
    "Use these exact strings in WHERE / GROUP BY (case-sensitive):",
    ...lines,
  ].join("\n");
}

module.exports = {
  repairFilterValues,
  buildValueRepairEnrichmentBlock,
};
