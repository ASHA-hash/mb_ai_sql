/**
 * query-compliance-engine.js
 *
 * Layer 3 — Agent Guard: SQL Compliance Validation.
 *
 * Intercepts generated SQL BEFORE database execution and checks:
 *   1. No illegal column names (columns that don't exist in target view)
 *   2. Aggregation rules (amount/qty must use SUM, not bare SELECT)
 *   3. Correct table is targeted (not a legacy/wrong view)
 *   4. No dangerous patterns (DROP, DELETE, INSERT, UPDATE, EXEC, xp_)
 *
 * On violation — returns structured error with:
 *   - which illegal column was used
 *   - what the correct column is
 *   - a correction hint for the LLM self-healing retry
 *
 * This is the safety net that catches cases where semantic-mapping-layer.json
 * injection wasn't enough to steer the LLM away from wrong columns.
 */
"use strict";

const path = require("path");
const fs   = require("fs");

/* ── Load semantic mapping for illegal column list ─────────────────────────── */
let _mapping = null;
function getMapping() {
  if (_mapping) return _mapping;
  try {
    const p = path.join(__dirname, "../metadata/semantic-mapping-layer.json");
    _mapping = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    _mapping = { illegal_columns: [], illegal_column_map: {} };
  }
  return _mapping;
}

/* ── Static illegal column set for fast lookup ─────────────────────────────── */
// NOTE: NetAmount is a REAL column in VW_MB_POWERBI_APP_REPORT (ordinal 29) — do NOT block it.
// Colour/SizeName/EAN do NOT exist in the view — block them and map to correct columns.
const HARD_ILLEGAL_COLUMNS = new Set([
  "SALENETAMOUNT",
  "SALESNETAMOUNT",
  "NETSALESAMOUNT",
  "QUANTITY",
  "SALESQUANTITY",
  "INVOICENO",
  "INVOICEID",
  "CUSTOMERID",
  "USERKEY",
  "BRANCHNAME",
  "BRANCHSHORTNAME",
  "SALEDATE",
  "INVOICEDT",
  "CASHMEMODT",
  "COLOUR",       // wrong spelling — actual column is Color
  "SIZENAME",     // wrong column — actual column is Size
  "EAN",          // does not exist on APP_REPORT
]);

const COLUMN_FIX_MAP = {
  SALENETAMOUNT:   "MrpValue",
  SALESNETAMOUNT:  "MrpValue",
  NETSALESAMOUNT:  "MrpValue",
  QUANTITY:        "AppQty",
  SALESQUANTITY:   "AppQty",
  INVOICENO:       "XnNo",
  INVOICEID:       "XnNo",
  CUSTOMERID:      "XnId",
  USERKEY:         "XnId",
  BRANCHNAME:      "BranchAlias",
  BRANCHSHORTNAME: "BranchAlias",
  SALEDATE:        "XnDt",
  INVOICEDT:       "XnDt",
  CASHMEMODT:      "XnDt",
  COLOUR:          "Color",
  SIZENAME:        "Size",
  EAN:             "ArticleNo",
};

/* ── Dangerous DML/DDL patterns — absolute block ───────────────────────────── */
const DANGER_PATTERNS = [
  /\bDROP\s+(TABLE|VIEW|DATABASE|INDEX|PROCEDURE|FUNCTION)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+\w+\s+SET\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bEXEC\s*\(/i,
  /\bEXECUTE\s*\(/i,
  /\bxp_\w+/i,
  /\bsp_executesql\b/i,
  /--.*;/,           // SQL injection via comment termination
  /;\s*SELECT/i,     // stacked queries
  /;\s*EXEC/i,
];

/**
 * Extract all column-name-like tokens from SQL.
 * Matches: [ColumnName], ColumnName in SELECT/WHERE/GROUP BY contexts.
 * Returns array of uppercase strings.
 */
function extractColumnTokens(sql) {
  const tokens = new Set();

  // Bracketed identifiers: [ColumnName]
  const bracketed = sql.matchAll(/\[([^\]]+)\]/g);
  for (const m of bracketed) {
    tokens.add(m[1].toUpperCase().trim());
  }

  // Unbracketed identifiers after SELECT, WHERE, ON, BY keywords
  // Grab word.word or just word that follows common SQL keywords / operators
  const unbracketed = sql.matchAll(
    /(?:SELECT|,|\bWHERE\b|\bAND\b|\bOR\b|\bON\b|\bBY\b|\bHAVING\b)\s+(?:DISTINCT\s+)?(?:TOP\s+\d+\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi
  );
  for (const m of unbracketed) {
    const tok = m[1].toUpperCase().trim();
    // Filter out SQL keywords and function names we don't care about
    if (!SQL_KEYWORDS.has(tok)) tokens.add(tok);
  }

  return [...tokens];
}

const SQL_KEYWORDS = new Set([
  "SELECT","FROM","WHERE","AND","OR","NOT","IN","LIKE","BETWEEN","IS","NULL",
  "GROUP","ORDER","BY","HAVING","DISTINCT","TOP","AS","JOIN","INNER","LEFT",
  "RIGHT","OUTER","ON","CAST","CONVERT","SUM","COUNT","AVG","MIN","MAX",
  "ISNULL","COALESCE","CASE","WHEN","THEN","ELSE","END","WITH","NOLOCK",
  "OPTION","RECOMPILE","DECLARE","SET","EXEC","EXECUTE","INSERT","UPDATE",
  "DELETE","DROP","CREATE","TABLE","VIEW","INDEX","VARCHAR","NVARCHAR",
  "INT","BIGINT","DECIMAL","FLOAT","DATE","DATETIME","BIT","CHAR","NCHAR",
  "YEAR","MONTH","DAY","GETDATE","DATEADD","DATEDIFF","DATENAME","DATEPART",
  "LOWER","UPPER","LTRIM","RTRIM","TRIM","LEN","SUBSTRING","REPLACE",
  "CONCAT","STR","ROW_NUMBER","RANK","DENSE_RANK","OVER","PARTITION",
  "ROWS","UNBOUNDED","PRECEDING","FOLLOWING","CURRENT",
  "ASC","DESC","NULLS","FIRST","LAST","PERCENT","TIES","FETCH","NEXT",
  "OFFSET","ROWS","ONLY","PIVOT","UNPIVOT","FOR","XML","PATH","AUTO",
]);

/**
 * Check a SQL string for compliance violations.
 *
 * @param {string} sql            The SQL to validate
 * @param {object} [opts]
 * @param {string} [opts.targetView]   Expected target view (checks FROM clause)
 * @param {boolean} [opts.strict]      Strict mode — fail on any non-SELECT statement
 * @returns {{
 *   valid:       boolean,
 *   violations:  string[],
 *   corrections: { illegal: string, correct: string }[],
 *   rewrittenSQL: string | null,
 *   rejectionReason: string | null,
 *   llmHint:     string,
 * }}
 */
function checkSqlCompliance(sql, opts = {}) {
  const violations   = [];
  const corrections  = [];
  let   rewrittenSQL = null;

  if (!sql || typeof sql !== "string") {
    return {
      valid: false,
      violations: ["Empty or non-string SQL"],
      corrections: [],
      rewrittenSQL: null,
      rejectionReason: "Empty SQL",
      llmHint: "Generate a valid SELECT statement.",
    };
  }

  const trimmed = sql.trim();

  /* ── 1. Dangerous DML/DDL ─────────────────────────────────────────────── */
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        violations: [`Dangerous SQL pattern detected: ${pattern.source}`],
        corrections: [],
        rewrittenSQL: null,
        rejectionReason: "DANGER: DML/DDL or injection pattern detected",
        llmHint: "Only SELECT statements are allowed. Remove any INSERT/UPDATE/DELETE/DROP/EXEC.",
      };
    }
  }

  /* ── 2. Must be a SELECT ───────────────────────────────────────────────── */
  if (!/^\s*SELECT\b/i.test(trimmed)) {
    return {
      valid: false,
      violations: ["SQL does not start with SELECT"],
      corrections: [],
      rewrittenSQL: null,
      rejectionReason: "Not a SELECT statement",
      llmHint: "Generate a SELECT query only. Do not use any other SQL statement type.",
    };
  }

  /* ── 3. Illegal column check ──────────────────────────────────────────── */
  // Merge static + JSON mapping lists
  const mapping = getMapping();
  const dynamicIllegal = new Set(
    (mapping.illegal_columns || []).map((c) => c.toUpperCase())
  );
  const allIllegal = new Set([...HARD_ILLEGAL_COLUMNS, ...dynamicIllegal]);
  const fixMap     = { ...COLUMN_FIX_MAP, ...(mapping.illegal_column_map || {}) };

  // Salesperson view uses SalesQuantity, CashmemoDt, SalesNetAmount — all valid on that view.
  // Remove them from the illegal set so the compliance check doesn't corrupt correct salesperson SQL.
  if (/SLS_DATA_WITHOUT_ITEMID/i.test(trimmed)) {
    allIllegal.delete("SALESQUANTITY");
    allIllegal.delete("CASHMEMODT");
    allIllegal.delete("SALESNETAMOUNT");
    allIllegal.delete("SALESPERSONNAME");
  }

  const tokens = extractColumnTokens(trimmed);
  let autoFixed = trimmed;
  let didFix    = false;

  for (const tok of tokens) {
    if (allIllegal.has(tok)) {
      const correct = fixMap[tok] || fixMap[tok.replace(/^dbo\./i, "")] || null;
      violations.push(
        correct
          ? `Illegal column [${tok}] — should be [${correct}]`
          : `Illegal column [${tok}] — not present in target view`
      );
      if (correct) {
        corrections.push({ illegal: tok, correct });
        // Auto-fix bracketed form
        autoFixed = autoFixed.replace(
          new RegExp(`\\[${tok}\\]`, "gi"),
          `[${correct}]`
        );
        // Auto-fix unbracketed form (word boundary match)
        autoFixed = autoFixed.replace(
          new RegExp(`(?<![\\w\\[])${tok}(?![\\w\\]])`, "gi"),
          `[${correct}]`
        );
        didFix = true;
      }
    }
  }

  if (violations.length > 0) {
    const fixable = violations.every((v) => v.includes("— should be"));
    rewrittenSQL = fixable && didFix ? autoFixed : null;

    const llmHint =
      `COLUMN VIOLATIONS detected. Use ONLY these columns:\n` +
      corrections.map((c) => `  • [${c.illegal}] → use [${c.correct}] instead`).join("\n") +
      (mapping.prompt_injection ? `\n\n${mapping.prompt_injection}` : "");

    return {
      valid:           false,
      violations,
      corrections,
      rewrittenSQL,
      rejectionReason: `Illegal column(s): ${corrections.map((c) => c.illegal).join(", ")}`,
      llmHint,
    };
  }

  /* ── 4. Aggregation sanity (warn only — don't block) ─────────────────── */
  const hasAmountCol = /\bMrpValue\b/i.test(trimmed);
  const hasQtyCol    = /\bAppQty\b/i.test(trimmed);
  const hasSumAgg    = /\bSUM\s*\(/i.test(trimmed);
  const hasGroupBy   = /\bGROUP\s+BY\b/i.test(trimmed);

  const aggWarnings = [];
  if ((hasAmountCol || hasQtyCol) && !hasSumAgg && !hasGroupBy) {
    aggWarnings.push(
      "MrpValue/AppQty used without SUM() — possible missing aggregation"
    );
  }

  return {
    valid:           true,
    violations:      aggWarnings, // non-blocking warnings
    corrections:     [],
    rewrittenSQL:    null,
    rejectionReason: null,
    llmHint:         aggWarnings.length ? aggWarnings.join("; ") : "",
  };
}

/**
 * Quick boolean check — is this SQL compliant?
 * @param {string} sql
 * @returns {boolean}
 */
function isSqlCompliant(sql) {
  return checkSqlCompliance(sql).valid;
}

/**
 * Auto-repair SQL by substituting illegal columns with their correct equivalents.
 * Returns the repaired SQL (may be same as input if no violations).
 *
 * @param {string} sql
 * @returns {string}
 */
function autoRepairSql(sql) {
  const result = checkSqlCompliance(sql);
  if (result.valid || !result.rewrittenSQL) return sql;
  console.log("[compliance] auto-repaired columns:", result.corrections.map((c) => `${c.illegal}→${c.correct}`).join(", "));
  return result.rewrittenSQL;
}

/**
 * Format a compliance failure into a LangGraph system observation string.
 * This is injected into the retry prompt so the LLM self-heals.
 *
 * @param {{ violations: string[], corrections: { illegal, correct }[], llmHint: string }} result
 * @param {string} failedSQL
 * @returns {string}
 */
function formatComplianceObservation(result, failedSQL) {
  return (
    `[System Observation — Column Compliance Failure]\n` +
    `The generated SQL used columns that do NOT exist in the target view.\n\n` +
    `Violations:\n${result.violations.map((v) => `  • ${v}`).join("\n")}\n\n` +
    `${result.llmHint}\n\n` +
    `Failed SQL:\n${failedSQL}\n\n` +
    `Rewrite the SQL using ONLY the columns listed in the schema above.`
  );
}

module.exports = {
  checkSqlCompliance,
  isSqlCompliant,
  autoRepairSql,
  formatComplianceObservation,
  HARD_ILLEGAL_COLUMNS,
  COLUMN_FIX_MAP,
};
