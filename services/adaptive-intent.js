/**
 * Mandatory separation: resolve_intent (plan only) vs generate_sql (T-SQL only).
 */
"use strict";

const { detectJargonHints } = require("./business-terminology");
const {
  buildMappingDictionaryBlock,
  buildContextAwareSemanticBlock,
  resolveViewForQuestion,
} = require("./metadata-translation-engine");
const { buildAiSalesFactPromptBlock, getCanonicalSalesContext } = require("./canonical-sales-sql");
const { isClaudeProvider } = require("./ai-gateway-driver");

let _semanticLayer = null;
function loadSemanticLayer() {
  if (_semanticLayer) return _semanticLayer;
  try {
    _semanticLayer = require("../metadata/semantic-layer.json");
  } catch {
    _semanticLayer = { semantic_mappings: { metrics: {}, dimensions: {} }, target_view: "dbo.VW_MB_POWERBI_SLSXNS_REPORT" };
  }
  return _semanticLayer;
}

function flattenSamplesForPrompt(samples) {
  if (!samples || typeof samples !== "object") return {};
  const out = {};
  for (const [col, entry] of Object.entries(samples)) {
    if (Array.isArray(entry)) {
      out[col] = entry.slice(0, 12);
    } else if (entry && Array.isArray(entry.values)) {
      out[col] = entry.values.slice(0, 12);
    } else if (typeof entry === "string") {
      out[col] = [entry];
    }
  }
  return out;
}

/**
 * Claude-optimized system framing — strict column dictionary + live DB samples.
 * Used when UI toggles Claude (better long-context rule adherence than GPT).
 */
function buildClaudeDynamicPrompt(opts = {}) {
  const question = opts.question || opts.userQuestion || "";
  const targetView =
    opts.targetView ||
    (question ? resolveViewForQuestion(question) : null) ||
    loadSemanticLayer().target_view ||
    getCanonicalSalesContext().table;
  const activeDimension = opts.activeDimension || "None";
  const sampleMap = flattenSamplesForPrompt(opts.realDatabaseValueSamples);
  const viewMeta = String(opts.viewMetadata || "").trim();

  const dynamicBlock = question
    ? buildContextAwareSemanticBlock(question, targetView)
    : "";

  return `You are an expert T-SQL compiler for Microsoft SQL Server (zRetailHQ0).
Target data structure: [${targetView}]

${dynamicBlock}

REAL-TIME VERIFIED DATABASE SAMPLES:
- Active evaluated dimension field: [${activeDimension}]
- Literal values observed in the database for grounding filters: ${JSON.stringify(sampleMap)}

STRICT SYNTAX RULES:
1. Use ONLY column roles listed for this view — never global APP_REPORT defaults on other views.
2. Salesperson/staff → SalesPersonName on SLS_DATA_WITHOUT_ITEMID, NOT SupplierName on APP_REPORT.
3. Non-aggregated detail queries: TOP (1000) maximum.
4. Output raw executable T-SQL only — no markdown fences, no semicolon at end.

${viewMeta ? `AVAILABLE VIEW COLUMNS:\n${viewMeta.slice(0, 12000)}` : ""}`;
}

function buildClaudeIntentSystemPrompt(relevantViewContext, opts = {}) {
  return `${buildClaudeDynamicPrompt({
    viewMetadata: relevantViewContext,
    question: opts.question || opts.userQuestion,
    ...opts,
  })}

INTENT-ONLY MODE — output strict JSON (no SQL, no markdown):
{
  "metric_intent": "SUM MrpValue | SUM AppQty | COUNT DISTINCT XnNo",
  "target_columns": ["MrpValue"],
  "dimensions": ["BranchAlias"],
  "filters": [{"column": "XnDt", "operator": "=", "value": "today"}],
  "limit": 10
}

Rules: exact column names from dictionary; temporal values as today|yesterday|mtd|ytd|qtd; bills today → BillCount + today filter.`;
}

function buildIntentSystemPromptForProvider(provider, relevantViewContext, opts = {}) {
  return buildIntentSystemPrompt(relevantViewContext, opts);
}

function buildSqlGenerationSystemPromptForProvider(
  provider,
  resolvedIntentJson,
  dateContext,
  liveSamplesBlock = "",
  opts = {}
) {
  return buildSqlGenerationSystemPrompt(
    resolvedIntentJson,
    dateContext,
    liveSamplesBlock,
    opts
  );
}

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

function buildIntentSystemPrompt(relevantViewContext, opts = {}) {
  const question = opts.question || opts.userQuestion || "";
  const targetView =
    opts.targetView ||
    (question ? resolveViewForQuestion(question) : null) ||
    loadSemanticLayer().target_view ||
    getCanonicalSalesContext().table;

  const mappingBlock = question
    ? buildMappingDictionaryBlock(question, targetView)
    : buildMappingDictionaryBlock();

  const isStaffView = /SLS_DATA_WITHOUT_ITEMID/i.test(targetView);
  const isSalesXns = /SLSXNS_REPORT/i.test(targetView);
  const staffLine = isStaffView
    ? "  Salesperson/Staff         → SalesPersonName  (NEVER SupplierName on this view)"
  : isSalesXns
    ? "  Salesperson (if present)  → check schema; prefer staff view for rep rankings"
    : "  Salesperson/Staff/Vendor  → SupplierName on APP_REPORT only; staff rankings → SalesPersonName on SLS_DATA_WITHOUT_ITEMID";

  return `You are a logical intent resolution engine for zRetailHQ0 (28 analytical views, 0 physical tables).
Analyze the user's retail question and output a strict JSON plan only. Do NOT generate SQL.

${mappingBlock}

ACTIVE TARGET VIEW: ${targetView}
Verified column roster for this request (use EXACT names — wrong names cause SQL Error 207):
  Revenue/Turnover/Sales    → ${isStaffView ? "SalesNetAmount" : isSalesXns ? "NetSlsNetAmount" : "MrpValue"}
  Qty/Pieces/Units          → ${isStaffView ? "SalesQuantity" : isSalesXns ? "NetSlsQty" : "AppQty"}
  Date                      → ${isStaffView ? "CashmemoDt" : "XnDt"}
  Branch/Store/Outlet       → BranchAlias
  Department                → DepartmentShortName
  Category                  → CategoryShortName
${staffLine}
  Invoice/Bill number       → XnNo or CashmemoNo per schema
  Bills count               → BillCount when on SLSXNS

AVAILABLE VIEW SCHEMAS:
${relevantViewContext || "(no views loaded)"}

OUTPUT JSON (no markdown, no SQL):
{
  "metric_intent": "SUM MrpValue | SUM AppQty | COUNT DISTINCT XnNo | SUM BillCount",
  "target_columns": ["MrpValue"],
  "dimensions": ["BranchAlias"],
  "filters": [{"column": "XnDt", "operator": "=", "value": "today"}],
  "limit": 10
}

CRITICAL RULES (violations cause SQL errors or wrong results):
1. Column names must be exact — use roster above, never guess aliases.
2. Temporal filter values: use "today", "yesterday", "mtd", "ytd", "qtd" (not raw dates unless user gave dd-mm-yyyy).
3. "How many bills today" → metric_intent SUM BillCount, filter today (compiler routes to SLSXNS view).
4. Salesperson/staff rankings → target view ${targetView}; use SalesPersonName on staff view, not SupplierName.
5. RANKING WITHOUT TIME: If user asks "top N", "highest", "best", "all time", "overall", "ever", "lifetime",
   or any ranking question WITHOUT mentioning a date period → filters array MUST be EMPTY (no date filter).
   Only add date filter if user explicitly said today/yesterday/mtd/ytd/this month/this year/etc.
6. Never output SQL, SELECT, T-SQL, or code blocks.`;
}

function buildSqlGenerationSystemPrompt(
  resolvedIntentJson,
  dateContext,
  liveSamplesBlock = "",
  opts = {}
) {
  const intentBlock =
    resolvedIntentJson != null
      ? JSON.stringify(resolvedIntentJson, null, 2)
      : "{}";

  const liveBlock = String(liveSamplesBlock || "").trim();
  const question = opts.question || opts.userQuestion || "";
  const targetView =
    opts.targetView ||
    (question ? resolveViewForQuestion(question) : null) ||
    loadSemanticLayer().target_view ||
    getCanonicalSalesContext().table;

  const dynamicBlock =
    question && buildContextAwareSemanticBlock
      ? `${buildContextAwareSemanticBlock(question, targetView)}\n\n`
      : "";

  const isSlsData = /SLS_DATA_WITHOUT_ITEMID/i.test(targetView);
  const isSlsxns = /SLSXNS/i.test(targetView);
  const salesCtx = getCanonicalSalesContext();

  const columnBlock = isSlsData ? `
MANDATORY COLUMN CORRECTNESS for SALESPERSON VIEW (${targetView}):
• Revenue/Sales/Turnover   → [SalesNetAmount]      NEVER MrpValue, SaleNetAmount
• Qty/Units/Pieces         → [SalesQuantity]       NEVER AppQty, Quantity
• Date column              → [CashmemoDt]          NEVER XnDt, InvoiceDt, SaleDate
• Branch/Store             → [BranchAlias]
• Salesperson/Staff/Rep    → [SalesPersonName]     NEVER SupplierName (SupplierName = brand, not person)
• Employee ID              → [SalespersonEmpId]
• Department               → [DepartmentShortName]
• Category                 → [CategoryShortName]
• Customer                 → [CustomerName]
• Bills/Invoices           → COUNT(DISTINCT [CashmemoNo])

[CANONICAL SALESPERSON FACT — MANDATORY]
- Use ONLY ${targetView} WITH (NOLOCK).
- Do NOT use APP_REPORT, SupplierName, MrpValue, AppQty, or XnDt here — they do not exist on this view.
- MTD: CAST([CashmemoDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST([CashmemoDt] AS date) <= CAST(GETDATE() AS date).
` : isSlsxns ? `
MANDATORY COLUMN CORRECTNESS for ${targetView} (home/analytics rollup):
• Revenue/Sales/Turnover   → [${salesCtx.amountCol}]   NEVER MrpValue, SaleNetAmount
• Qty/Units                → [${salesCtx.qtyCol}]       NEVER AppQty
• Date column              → [${salesCtx.dateCol}]
• Branch/Store             → [${salesCtx.branchCol}]
• Department / Category    → [${salesCtx.deptCol}], [${salesCtx.catCol}]
• Bill count               → SUM(ISNULL([BillCount],0))

[CANONICAL SALES FACT — MANDATORY]
- Use ONLY ${targetView} WITH (NOLOCK). Do NOT use dbo.VW_MB_POWERBI_APP_REPORT (not deployed).
${buildAiSalesFactPromptBlock()}
` : `
MANDATORY COLUMN CORRECTNESS (SQL Error 207 prevention):
• Revenue/Sales/Turnover   → [${salesCtx.amountCol}]
• Qty/Pieces/Units         → [${salesCtx.qtyCol}]
• Date column              → [${salesCtx.dateCol}]
• Branch/Store             → [${salesCtx.branchCol}]
• Bill count               → SUM(ISNULL([BillCount],0))  or  COUNT(DISTINCT [${salesCtx.invoiceCol}])

${buildAiSalesFactPromptBlock()}`;

  const dateCol = isSlsData ? "CashmemoDt" : salesCtx.dateCol;

  return `${dynamicBlock}You are a deterministic T-SQL compiler for Microsoft SQL Server. You have access to real-time column samples.

FROM clause: use [${targetView}] unless SCHEMA specifies otherwise.
${columnBlock}
DATE FILTER RULES (read carefully — wrong date handling returns 0 rows):
• User specifies a time period (today, MTD, this month, yesterday, YTD, QTD, last N days) → apply correct WHERE on [${dateCol}].
• User asks for "top N", "highest", "best", "lowest", "worst", "overall", "all time", "all-time", "overall", "ever", "lifetime", "since beginning", or ANY RANKING without mentioning a date → DO NOT add any date WHERE clause. Return full history.
• NEVER silently default to current month for ranking/all-time questions. Only default to current month if user says "sales" or "revenue" alone with no time or ranking qualifier.

${liveBlock ? `${liveBlock}\n` : ""}
RESOLVED INTENT (follow this plan exactly): ${intentBlock}


PERFORMANCE & CORRECTNESS RULES:
1. Always aggregate server-side using SUM(ISNULL([col],0)) or COUNT(DISTINCT [col]).
2. Non-aggregated detail queries MUST use TOP (1000) maximum.
3. ${isSlsData
  ? "MTD: CAST([CashmemoDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST([CashmemoDt] AS date) <= CAST(GETDATE() AS date)."
  : "MTD: CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)."}
4. String filters: always LOWER([col]) LIKE '%term%' — never case-sensitive equality for dimension names.
5. Output clean T-SQL only — no markdown fences, no trailing semicolons.
6. Use only columns from SCHEMA block — never invent columns not listed.
${dateContext ? `\n${dateContext}` : ""}`;
}

function buildIntentUserPrompt(state) {
  const rootQ = state.originalQuestion || state.question;
  const jargon = detectJargonHints(rootQ);
  const jargonBlock = jargon.length
    ? "\nDetected mappings:\n" + jargon.map((j) => `• ${j.term}: ${j.def}`).join("\n")
    : "";

  // Multi-turn context: last N completed Q→SQL pairs from the chat session
  const history = Array.isArray(state.conversationHistory)
    ? state.conversationHistory.filter((h) => h.question && h.sql)
    : [];
  const historyBlock =
    history.length > 0
      ? "\n[CONVERSATION HISTORY — previous questions in this session]\n" +
        history
          .map(
            (h, i) =>
              `Turn ${i + 1}:\n  Q: ${h.question}\n  SQL: ${String(h.sql).split("\n")[0].slice(0, 120)}...\n  Summary: ${h.summary || "(no summary)"}`
          )
          .join("\n") +
        "\n[Use history to resolve pronouns like 'same branch', 'those products', 'compare to last']"
      : "";

  return (
    `[ORIGINAL USER QUESTION]\n${rootQ}\n\n` +
    `[NORMALIZED QUESTION]\n${state.question}\n\n` +
    `[RAG EXAMPLES]\n${(state.ragContext || "").slice(0, 4000)}\n` +
    jargonBlock +
    historyBlock
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
  buildIntentSystemPromptForProvider,
  buildSqlGenerationSystemPromptForProvider,
  buildClaudeDynamicPrompt,
  buildClaudeIntentSystemPrompt,
  flattenSamplesForPrompt,
  buildIntentUserPrompt,
  formatIntentForSqlPrompt,
};
