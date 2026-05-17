/**
 * Levenshtein auto-correct against pre-built dimension value index.
 */
"use strict";

const { getDimensionValues, listDimensionKeys, loadDimensionIndex } = require("./dimension-index");

const DEFAULT_MAX_DISTANCE = 3;

function levenshteinDistance(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  const matrix = Array.from({ length: s.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= t.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      matrix[i][j] =
        s[i - 1] === t[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[s.length][t.length];
}

/**
 * @returns {{ match: string|null, distance: number, dimensionKey: string }}
 */
function findClosestDatabaseValue(userInputToken, dimensionKey, opts = {}) {
  const token = String(userInputToken || "").trim();
  const maxDist = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const validValues = getDimensionValues(dimensionKey);
  if (!token || !validValues.length) {
    return { match: null, distance: Infinity, dimensionKey };
  }

  const lower = token.toLowerCase();
  const exact = validValues.find((v) => v.toLowerCase() === lower);
  if (exact) return { match: exact, distance: 0, dimensionKey };

  let closestMatch = null;
  let minDistance = maxDist + 1;

  for (const trueValue of validValues) {
    const dist = levenshteinDistance(lower, trueValue.toLowerCase());
    if (dist < minDistance) {
      minDistance = dist;
      closestMatch = trueValue;
    }
  }

  if (minDistance <= maxDist) {
    return { match: closestMatch, distance: minDistance, dimensionKey };
  }
  return { match: null, distance: minDistance, dimensionKey };
}

/** Infer which dimension a token might refer to from question context. */
function inferDimensionForToken(question, token) {
  const q = String(question || "").toLowerCase();
  const t = String(token || "").toLowerCase();
  if (/\b(branch|store|location|shop|outlet)\b/.test(q) || /\bfor\s+\w+/.test(q)) {
    return "BranchAlias";
  }
  if (/\b(category|categories)\b/.test(q)) return "Category";
  if (/\b(department|dept)\b/.test(q)) return "Department";
  if (/\b(supplier|vendor)\b/.test(q)) return "SupplierName";
  if (t.length >= 4) return "BranchAlias";
  return null;
}

/**
 * Apply corrections to full question text; returns audit trail.
 */
function applyAutoCorrectionsToQuestion(question, opts = {}) {
  const original = String(question || "").trim();
  let corrected = original;
  const corrections = [];

  const idx = loadDimensionIndex();
  if (!idx.generatedAt) {
    return { question: original, correctedQuestion: original, corrections: [], indexLoaded: false };
  }

  const tokens = original.split(/\s+/).filter((w) => w.length >= 3);
  const dims = opts.dimensions || listDimensionKeys();

  for (const rawToken of tokens) {
    const clean = rawToken.replace(/[^\w]/g, "");
    if (clean.length < 3) continue;

    const preferredDim = inferDimensionForToken(original, clean);
    const tryDims = preferredDim ? [preferredDim, ...dims.filter((d) => d !== preferredDim)] : dims;

    for (const dim of tryDims) {
      const { match, distance } = findClosestDatabaseValue(clean, dim, opts);
      if (!match || distance === 0) break;
      if (distance > 0 && distance <= (opts.maxDistance ?? DEFAULT_MAX_DISTANCE)) {
        const re = new RegExp(`\\b${escapeRegex(clean)}\\b`, "gi");
        if (re.test(corrected)) {
          corrected = corrected.replace(re, match);
          corrections.push({ from: clean, to: match, dimension: dim, distance });
        }
        break;
      }
    }
  }

  return {
    question: original,
    correctedQuestion: corrected,
    corrections,
    indexLoaded: true,
  };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fuzzy search dimension values for UI dropdown (top N).
 */
function searchDimensionValues(query, dimensionKey, limit = 12) {
  const q = String(query || "").toLowerCase().trim();
  const vals = getDimensionValues(dimensionKey);
  if (!q) return vals.slice(0, limit);

  const scored = vals.map((v) => {
    const vl = v.toLowerCase();
    let score = 0;
    if (vl === q) score = 100;
    else if (vl.startsWith(q)) score = 80;
    else if (vl.includes(q)) score = 60;
    else {
      const d = levenshteinDistance(q, vl);
      score = Math.max(0, 40 - d * 10);
    }
    return { value: v, score };
  });

  return scored
    .filter((s) => s.score > 15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.value);
}

module.exports = {
  levenshteinDistance,
  findClosestDatabaseValue,
  applyAutoCorrectionsToQuestion,
  searchDimensionValues,
};
