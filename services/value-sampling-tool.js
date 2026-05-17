/**
 * value-sampling-tool.js
 *
 * Layer 2 — Dynamic Value Sampling.
 *
 * Before the LLM generates SQL it needs to know REAL values in the DB
 * (branch names, category names, dept names etc.) so WHERE clauses are
 * built against actual data — not hallucinated strings.
 *
 * Strategy:
 *   1. Detect which filter dimensions are mentioned in the question.
 *   2. Query TOP 100 DISTINCT values for each detected column.
 *   3. Return a compact text block injected into the LLM system prompt.
 *
 * Uses WITH (NOLOCK) to avoid locking the fact table during sampling.
 */
"use strict";

const sql = require("mssql");

const DEFAULT_SAMPLE_TABLE = "dbo.VW_MB_POWERBI_APP_REPORT";

/**
 * Columns to sample per question keyword pattern.
 * Pattern → { column, label }
 */
const SAMPLE_TRIGGERS = [
  {
    pattern: /\b(branch|store|outlet|location|shop|showroom|city)\b/i,
    column:  "BranchAlias",
    label:   "Branches / Stores",
  },
  {
    pattern: /\b(department|dept|division|section|menswear|womenswear|kidswear)\b/i,
    column:  "DepartmentShortName",
    label:   "Departments",
  },
  {
    pattern: /\b(category|cat|segment|formal|casual|ethnic|western)\b/i,
    column:  "CategoryShortName",
    label:   "Categories",
  },
  {
    pattern: /\b(salesperson|sales person|staff|employee|rep|agent|consignment|consignee)\b/i,
    column:  "SupplierName",
    label:   "Salespersons / Consignees",
  },
  {
    pattern: /\b(article|style|sku|product code|barcode)\b/i,
    column:  "ArticleNo",
    label:   "Article Codes",
    topN:    50,
  },
];

/**
 * Sample up to topN distinct non-null values for a column from the table.
 * Returns array of strings. Returns [] on any error.
 *
 * @param {import("mssql").ConnectionPool} pool
 * @param {string} table  Fully-qualified table/view
 * @param {string} column Exact column name
 * @param {number} topN   Max distinct values to fetch
 * @returns {Promise<string[]>}
 */
async function sampleColumnValues(pool, table, column, topN = 100) {
  if (!pool || !table || !column) return [];
  try {
    const req = pool.request();
    // Use string interpolation safely — table/column are already sanitized by caller
    const q = `
      SELECT DISTINCT TOP (${Math.min(topN, 200)}) CAST([${column}] AS NVARCHAR(500)) AS val
      FROM   ${table} WITH (NOLOCK)
      WHERE  [${column}] IS NOT NULL
         AND LTRIM(RTRIM(CAST([${column}] AS NVARCHAR(500)))) <> ''
      ORDER  BY val`;
    const r = await req.query(q);
    return (r.recordset || []).map((row) => String(row.val || "")).filter(Boolean);
  } catch (e) {
    console.warn(`[value-sampling] failed to sample ${column} from ${table}:`, e.message);
    return [];
  }
}

/**
 * Given a natural-language question, detect which dimension columns
 * should be sampled and fetch their live values.
 *
 * @param {import("mssql").ConnectionPool} pool
 * @param {string} question
 * @param {string} [table]  Override target table (default: VW_MB_POWERBI_APP_REPORT)
 * @returns {Promise<{ samples: Record<string, string[]>, text: string }>}
 */
async function sampleValuesForQuestion(pool, question, table) {
  const targetTable = table || DEFAULT_SAMPLE_TABLE;
  const q = String(question || "").toLowerCase();

  const triggered = SAMPLE_TRIGGERS.filter(({ pattern }) => pattern.test(q));
  if (triggered.length === 0) {
    return { samples: {}, text: "" };
  }

  // De-dupe columns
  const seen = new Set();
  const toSample = triggered.filter(({ column }) => {
    if (seen.has(column)) return false;
    seen.add(column);
    return true;
  });

  // Run all column samples in parallel
  const results = await Promise.all(
    toSample.map(async ({ column, label, topN }) => {
      const values = await sampleColumnValues(pool, targetTable, column, topN || 100);
      return { column, label, values };
    })
  );

  const samples = {};
  const textParts = [];

  for (const { column, label, values } of results) {
    if (values.length === 0) continue;
    samples[column] = values;
    textParts.push(
      `${label} — actual DB values for [${column}]:\n  ${values.slice(0, 60).join(", ")}`
    );
  }

  const text =
    textParts.length > 0
      ? `═══ LIVE DB VALUES (use these exact strings in WHERE clauses) ═══\n${textParts.join("\n\n")}\n\nWhen filtering by text, use: LOWER([col]) LIKE '%partial%'`
      : "";

  return { samples, text };
}

/**
 * Fuzzy-match a user-supplied string to the closest DB value.
 * Used BEFORE SQL generation to correct "chenai" → "CHENNAI MAIN BRANCH" etc.
 *
 * @param {string} userTerm   What the user typed
 * @param {string[]} dbValues Actual DB values for the column
 * @param {number} [threshold=0.4]  Minimum Dice coefficient to match
 * @returns {string | null}  Best match or null
 */
function fuzzyMatch(userTerm, dbValues, threshold = 0.4) {
  if (!userTerm || !dbValues || dbValues.length === 0) return null;
  const lower = userTerm.toLowerCase().trim();

  // Exact (case-insensitive) match first
  const exact = dbValues.find((v) => v.toLowerCase() === lower);
  if (exact) return exact;

  // Substring match
  const sub = dbValues.find((v) => v.toLowerCase().includes(lower) || lower.includes(v.toLowerCase().slice(0, 5)));
  if (sub) return sub;

  // Dice-coefficient similarity
  function dice(a, b) {
    const setA = new Set();
    const setB = new Set();
    for (let i = 0; i < a.length - 1; i++) setA.add(a.slice(i, i + 2));
    for (let i = 0; i < b.length - 1; i++) setB.add(b.slice(i, i + 2));
    let common = 0;
    setA.forEach((bg) => { if (setB.has(bg)) common++; });
    return (2 * common) / (setA.size + setB.size) || 0;
  }

  let bestScore = threshold;
  let bestMatch = null;
  for (const v of dbValues) {
    const score = dice(lower, v.toLowerCase());
    if (score > bestScore) { bestScore = score; bestMatch = v; }
  }
  return bestMatch;
}

/**
 * Build a compact "value correction" block for the LLM prompt.
 * If user typed "chenai", samples show "CHENNAI MAIN BRANCH", emit correction hint.
 *
 * @param {string} question
 * @param {Record<string, string[]>} samples   column → values[]
 * @returns {string}
 */
function buildValueCorrectionBlock(question, samples) {
  if (!samples || Object.keys(samples).length === 0) return "";
  const lines = [];
  const q = String(question || "");

  // Extract words that look like potential filter values (> 3 chars, not common stop words)
  const STOP = new Set(["what", "show", "give", "list", "find", "total", "which", "where", "from", "sales", "revenue", "data", "report", "this", "that", "with", "have", "been"]);
  const words = q
    .replace(/[^a-z0-9 ]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w.toLowerCase()));

  for (const [column, values] of Object.entries(samples)) {
    for (const word of words) {
      const matched = fuzzyMatch(word, values);
      if (matched && matched.toLowerCase() !== word.toLowerCase()) {
        lines.push(`  • User said "${word}" → DB value is "${matched}" for [${column}]`);
      }
    }
  }

  return lines.length > 0
    ? `\n[VALUE CORRECTIONS — apply these in WHERE clauses]\n${lines.join("\n")}`
    : "";
}

module.exports = {
  sampleValuesForQuestion,
  sampleColumnValues,
  fuzzyMatch,
  buildValueCorrectionBlock,
  SAMPLE_TRIGGERS,
};
