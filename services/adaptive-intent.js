/**
 * Mandatory separation: resolve_intent (plan only) vs generate_sql (T-SQL only).
 */
"use strict";

const { detectJargonHints } = require("./business-terminology");
const { buildMappingDictionaryBlock } = require("./metadata-translation-engine");
const { buildAiSalesFactPromptBlock } = require("./canonical-sales-sql");

function parseIntentJson(raw) {
  const text = String(raw || "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildIntentSystemPrompt(relevantViewContext) {
  return `You are a logical intent resolution engine.
Analyze the user's retail question and output a strict JSON plan. Do not generate SQL.

${buildMappingDictionaryBlock()}

AVAILABLE VIEW SCHEMAS:
${relevantViewContext || "(no views loaded)"}

OUTPUT JSON SCHEMA FORMAT:
{
  "metric_intent": "SUM or COUNT or AVG calculation",
  "target_columns": ["XnDt", "MrpValue"],
  "dimensions": ["BranchAlias"],
  "filters": [{"column": "XnDt", "operator": ">=", "value": "2026-05-01"}]
}

Rules:
- Map plain English using BUSINESS DICTIONARY MAPPINGS only.
- target_columns must exist in AVAILABLE VIEW SCHEMAS.
- For sales/revenue: prefer XnDt, MrpValue, BranchAlias, SupplierName on VW_MB_POWERBI_APP_REPORT.
- "Salesperson" / "staff" → dimension SupplierName (no SalesPerson column).
- Never output SQL, SELECT, or T-SQL.`;
}

function buildSqlGenerationSystemPrompt(resolvedIntentJson, dateContext, liveSamplesBlock = "") {
  const intentBlock =
    resolvedIntentJson != null
      ? JSON.stringify(resolvedIntentJson, null, 2)
      : "{}";

  const liveBlock = String(liveSamplesBlock || "").trim();

  return `You are a deterministic T-SQL compiler for Microsoft SQL Server. You have access to real-time column samples.

CRITICAL INSTRUCTIONS:
1. Use VERIFIED LIVE DATABASE COLUMN VALUES below for exact strings in WHERE / GROUP BY — never guess capitalization.
2. Salesperson / staff / rep → GROUP BY [SupplierName] (vendor/sales identity on this installation).
3. Every numeric field (MrpValue, AppQty, CostValue) must use SUM, COUNT, or AVG — never return unaggregated line scans.

DATE FILTER RULES (read carefully):
• If the user specifies a time period (today, MTD, this month, yesterday, etc.) → apply the correct WHERE date filter.
• If the user asks for "top N", "highest", "best", "lowest", "worst", "overall", "all time", or any ranking WITHOUT a date — DO NOT add any date WHERE clause. Return all historical records. Example: "top 10 highest sales" → no date filter, just SELECT TOP 10 … ORDER BY SUM(MrpValue) DESC.
• Never silently default to current month if the user is asking a ranking or all-time question. Only default to current month when the user asks for "sales" or "revenue" with no qualifier at all.

${liveBlock ? `${liveBlock}\n` : ""}
Target the resolved intent definitions exactly: ${intentBlock}

${buildAiSalesFactPromptBlock()}

PERFORMANCE RULES:
1. Always aggregate data server-side using SUM/COUNT grouped by required dimensions.
2. If non-aggregated scans are unavoidable, always force 'TOP (100)'.
3. Output clean SQL text only. Do not wrap code blocks in markdown fences.
4. Use only columns from the provided SCHEMA — never invent names like NetAmount unless listed.
${dateContext ? `\n${dateContext}` : ""}`;
}

function buildIntentUserPrompt(state) {
  const jargon = detectJargonHints(state.question);
  const jargonBlock = jargon.length
    ? "\nDetected mappings:\n" + jargon.map((j) => `• ${j.term}: ${j.def}`).join("\n")
    : "";

  return (
    `[QUESTION]\n${state.question}\n\n` +
    `[RAG EXAMPLES]\n${(state.ragContext || "").slice(0, 4000)}\n` +
    jargonBlock
  );
}

function formatIntentForSqlPrompt(intent) {
  if (!intent || typeof intent !== "object") return "";
  return (
    "### RESOLVED INTENT (SQL must match this plan exactly)\n" +
    JSON.stringify(intent, null, 2)
  );
}

module.exports = {
  parseIntentJson,
  buildIntentSystemPrompt,
  buildSqlGenerationSystemPrompt,
  buildIntentUserPrompt,
  formatIntentForSqlPrompt,
};
