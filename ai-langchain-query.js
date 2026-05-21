/**
 * ai-langchain-query.js
 *
 * LangGraph-powered SQL query engine — 7-node StateGraph.
 *
 * Workflow:
 *   pre_flight_gate → retrieve_context → resolve_intent → discover_column_values
 *       → generate_sql → check_sql (structural guard + compliance + optional LLM review)
 *       → execute_sql → [error_recovery (×3)] → generate_answer → verify_answer
 *
 * Key accuracy improvements:
 *   • load_schema        — instant JSON lookup from db_tables_views_columns.json (no DB round-trip)
 *                          passes EXACT column names to AI — no guessing, no hallucination
 *   • semantic_mapping   — Layer 1: business-term → exact column injection into every prompt
 *   • value_sampling     — Layer 2: live DB DISTINCT values sampled before SQL generation
 *                          prevents hallucinated WHERE clauses (e.g. "chenai" → "CHENNAI MAIN")
 *   • compliance_guard   — Layer 3: SQL blocked/auto-repaired if illegal column detected
 *                          (e.g. Quantity→AppQty, InvoiceNo→XnNo) before DB execution
 *   • temperature=0      — deterministic, no invented column names
 *   • check_sql          — LLM pre-validates T-SQL rules before DB execution
 *   • verify_answer      — LLM cross-checks numbers against actual rows
 *   • zero_rows_recovery — widens filters and retries once
 *   • 3 retry attempts   — with cumulative error memory
 */
"use strict";

const path = require("path");
const fs   = require("fs");
const { ChatOpenAI } = require("@langchain/openai");
let _ChatAnthropic = null;
function getChatAnthropic() {
  if (_ChatAnthropic) return _ChatAnthropic;
  try {
    _ChatAnthropic = require("@langchain/anthropic").ChatAnthropic;
  } catch {
    console.warn("[langchain] @langchain/anthropic not installed — Claude provider unavailable");
  }
  return _ChatAnthropic;
}
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");
const { StateGraph, Annotation, END, START } = require("@langchain/langgraph");
const {
  dispatchAgenticTool,
  discoverLiveSamplesForQuestion,
} = require("./services/agentic-db-tools");
const { validateSqlAccuracy } = require("./services/sql-validator");
const {
  getCanonicalSalesContext,
  remapLegacyColumnNames,
  markSalesFactTableUnavailable,
  rewriteSqlToAvailableSalesFact,
  isTopVendorsByMrpValueQuestion,
  buildTopVendorsByMrpValueSql,
} = require("./services/canonical-sales-sql");
const { getCanonicalPurchaseContext } = require("./services/canonical-purchase-sql");
const {
  isSalespersonTopNQuestion,
  getCanonicalSalespersonContext,
} = require("./services/canonical-salesperson-sql");
const { inferAiDomain } = require("./ai-sql");
const { formatSchemaWithSemantics } = require("./services/schema-rag");
const {
  buildBusinessDictionaryPrompt,
  verifySchemaMetadata,
} = require("./services/business-terminology");
const {
  parseIntentJson,
  buildIntentSystemPrompt,
  buildSqlGenerationSystemPrompt,
  buildIntentSystemPromptForProvider,
  buildSqlGenerationSystemPromptForProvider,
  buildClaudeDynamicPrompt,
  flattenSamplesForPrompt,
  buildIntentUserPrompt,
  formatIntentForSqlPrompt,
} = require("./services/adaptive-intent");
const {
  createLangChainPair,
  invokeUnifiedGateway,
  normalizeProvider,
} = require("./services/ai-gateway-driver");
const ragStore = require("./services/rag-store");
const { detectExportIntent } = require("./services/query-performance");
const {
  buildAggregationMandateBlock,
  formatSystemObservation,
} = require("./services/metadata-translation-engine");
const { runPreFlightGate } = require("./services/pre-flight-gate");
const { compileIntentToSql } = require("./services/intent-to-sql-compiler");
const { isIntentStepEnabled, isColumnDiscoveryEnabled } = require("./services/nlq-pipeline-config");
const { enforceTopLimit } = require("./ai-sql");
const {
  isTopStoreYesterdayQuestion,
  buildTopStoreYesterdaySql,
  isTopInvoicesTodayQuestion,
  buildTopInvoicesTodaySql,
  buildSalesTopNBreakdownSql,
  isSalesTopNBreakdownQuestion,
  resolveHomeAlignedSql,
  rewriteSalesSqlToHomeFact,
} = require("./services/home-kpi-sql");
const { buildSalespersonTopNSql } = require("./services/canonical-salesperson-sql");
const { buildTemporalWhere, detectTemporalFromQuestion } = require("./services/intent-to-sql-compiler");

function sqlValidationContextForQuestion(question) {
  if (isSalespersonTopNQuestion(question)) {
    const s = getCanonicalSalespersonContext();
    return { domain: "sales", amountCol: s.amountCol, staffTable: s.table };
  }
  const domain = inferAiDomain(question);
  if (domain === "purchase") {
    const p = getCanonicalPurchaseContext();
    return {
      domain: "purchase",
      amountCol: p.amountCol || "NetPurNetAmount",
      purchaseTable: p.table,
    };
  }
  const salesCtx = getCanonicalSalesContext();
  return {
    domain: domain === "generic" ? "sales" : domain,
    amountCol: salesCtx.amountCol,
  };
}

/* ── Layer 1: Semantic Mapping (business term → exact column) ─────────────── */
let _semanticMapping = null;
function getSemanticMapping() {
  if (_semanticMapping) return _semanticMapping;
  try {
    const p = path.join(__dirname, "metadata/semantic-mapping-layer.json");
    _semanticMapping = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    _semanticMapping = { prompt_injection: "" };
  }
  return _semanticMapping;
}
function getSemanticMappingPrompt() {
  const m = getSemanticMapping();
  return m.prompt_injection || "";
}

/* ── Layer 2: Dynamic Value Sampling ─────────────────────────────────────── */
const {
  sampleValuesForQuestion,
  buildValueCorrectionBlock,
  sampleValuesList,
} = require("./services/value-sampling-tool");

/* ── Layer 3: Query Compliance Guard ─────────────────────────────────────── */
const {
  checkSqlCompliance,
  autoRepairSql,
  formatComplianceObservation,
} = require("./services/query-compliance-engine");

/* ─────────────────────────────────────────────────────────────────────────────
   STATE SCHEMA
   ───────────────────────────────────────────────────────────────────────────── */
const last = (a, b) => (b !== undefined ? b : a);

const AgentState = Annotation.Root({
  // Inputs
  aiProvider:           Annotation({ reducer: last }),
  question:             Annotation({ reducer: last }),
  originalQuestion:     Annotation({ reducer: last }),
  adaptiveEnrichment:   Annotation({ reducer: last }),
  dateContext:          Annotation({ reducer: last }),
  tableHint:            Annotation({ reducer: last }),
  userDateRange:        Annotation({ reducer: last }),
  conversationHistory:  Annotation({ default: () => [], reducer: last }), // multi-turn context

  // Schema discovery
  viewScores:      Annotation({ reducer: last }),
  topViews:        Annotation({ reducer: last }),
  schema:          Annotation({ reducer: last }),
  schemaText:      Annotation({ reducer: last }),

  // Sample data (new — helps LLM understand actual formats)
  sampleData:      Annotation({ reducer: last }),
  sampleText:      Annotation({ reducer: last }),

  // SQL lifecycle
  generatedSQL:    Annotation({ reducer: last }),
  checkedSQL:      Annotation({ reducer: last }),
  executionResult: Annotation({ reducer: last }),
  retryCount:      Annotation({ default: () => 0, reducer: last }),
  retryErrors:     Annotation({ default: () => [], reducer: (a, b) => [...(a || []), ...(b || [])] }),
  systemObservations: Annotation({ default: () => [], reducer: (a, b) => [...(a || []), ...(b || [])] }),
  zeroRowsRetried: Annotation({ default: () => false, reducer: last }),

  // RAG — retrieved context injected before SQL generation
  ragContext:      Annotation({ reducer: last }),
  businessDictionary: Annotation({ reducer: last }),
  queryIntent:     Annotation({ reducer: last }),

  // Column value discovery (cognitive loop)
  liveColumnSamples:     Annotation({ reducer: last }),
  columnDiscoveryText:   Annotation({ reducer: last }),
  sqlValidationFailed:   Annotation({ reducer: last }),

  // Pre-flight guard
  nextStep:              Annotation({ reducer: last }),
  rankedViews:           Annotation({ reducer: last }),
  targetView:            Annotation({ reducer: last }),
  clarityScore:          Annotation({ reducer: last }),
  preFlightMs:           Annotation({ reducer: last }),
  fastPathSql:           Annotation({ reducer: last }),
  clarificationMessage:  Annotation({ reducer: last }),
  clarificationOptions:  Annotation({ reducer: last }),

  // Output
  finalAnswer:     Annotation({ reducer: last }),
  finalData:       Annotation({ reducer: last }),
  finalSQL:        Annotation({ reducer: last }),
  confidence:      Annotation({ reducer: last }),   // "high" | "medium" | "low"
  confidenceNote:  Annotation({ reducer: last }),

  // Trace
  nodeLog:         Annotation({ default: () => [], reducer: (a, b) => [...(a || []), ...(b || [])] }),
});

/* ─────────────────────────────────────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────────────────────────────────────── */
function extractTopViews(viewScores, n) {
  if (!viewScores || typeof viewScores !== "object") return [];
  const entries = Object.entries(viewScores)
    .filter(([k]) => k !== "recommended_approach" && !k.startsWith("_"))
    .flatMap(([, arr]) => (Array.isArray(arr) ? arr : []))
    .filter((v) => typeof v === "string");
  const seen = new Set();
  const out = [];
  for (const v of entries) {
    if (!seen.has(v)) { seen.add(v); out.push(v); }
    if (out.length >= n) break;
  }
  return out;
}

function formatSchemaForPrompt(schema) {
  if (!schema || typeof schema !== "object") return "(no schema available)";
  const lines = [];

  // Emit join advisory first so it sits at the top of context
  if (schema["__join_direction_advisory__"]) {
    lines.push(`\n⚡ ${schema["__join_direction_advisory__"]}`);
  }

  for (const [view, cols] of Object.entries(schema)) {
    // Special keys — emit advisory already done above; emit others normally
    if (view === "__join_direction_advisory__") continue;
    if (view.startsWith("__")) { lines.push(`\n${cols}`); continue; }
    if (!Array.isArray(cols)) { lines.push(`\n${view}: ${cols}`); continue; }

    // Row-count badge: pull _approxRows off the column array (injected by agentic-db-tools)
    const approxRows = cols._approxRows ?? null;
    let badge = "";
    if (approxRows !== null) {
      if (approxRows === 0)       badge = " ⚠️ EMPTY TABLE (0 rows)";
      else if (approxRows < 50)   badge = ` ⚠️ TINY TABLE (${approxRows} rows) — JOIN to this; never use as FROM in ranking queries`;
      else if (approxRows < 5000) badge = ` (${approxRows.toLocaleString()} rows — master/lookup)`;
      else if (approxRows < 5e5)  badge = ` (≈${approxRows.toLocaleString()} rows)`;
      else                        badge = ` (≈${(approxRows / 1e6).toFixed(1)}M rows — fact table → use as FROM)`;
    }

    lines.push(`\n${view}${badge}:`);
    for (const c of cols) {
      lines.push(`  ${c.column} (${c.type}${c.nullable ? ", nullable" : ""})`);
    }
  }
  return lines.join("\n");
}

function formatSampleForPrompt(sampleData) {
  if (!sampleData || typeof sampleData !== "object") return "";
  const lines = [];
  for (const [view, rows] of Object.entries(sampleData)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    lines.push(`\n${view} — sample rows:`);
    const headers = Object.keys(rows[0]);
    lines.push("  " + headers.join(" | "));
    for (const r of rows.slice(0, 3)) {
      lines.push("  " + headers.map(h => String(r[h] ?? "NULL")).join(" | "));
    }
  }
  return lines.join("\n");
}

function extractSQL(text) {
  if (!text) return "";
  const fenced = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const selectIdx = text.toUpperCase().indexOf("SELECT");
  if (selectIdx >= 0) return text.slice(selectIdx).replace(/;+\s*$/, "").trim();
  return text.trim();
}

function buildDateRangeClause(userDateRange) {
  if (!userDateRange) return "";
  const { from, to } = userDateRange;
  if (!from && !to) return "";
  const parts = [];
  if (from && to) parts.push(`date range ${from} to ${to} (inclusive)`);
  else if (from)  parts.push(`date range from ${from} onwards`);
  else            parts.push(`date range up to ${to}`);
  return `\n[USER DATE RANGE — use this in WHERE clause on the appropriate date column]\n${parts.join(", ")}`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 0 — retrieve_context  (RAG: examples + glossary + schema chunks)
   Runs after load_schema so topViews is known; results injected into generate_sql.
   ───────────────────────────────────────────────────────────────────────────── */
function makeRetrieveContext() {
  return async function retrieveContext(state) {
    console.log("[langchain] node: retrieve_context (RAG)");
    const question = state.question || "";

    try {
      const [examples, glossary, schemaDocs] = await Promise.all([
        ragStore.search(question, 5, { type: "example" }),   // more examples → better few-shot
        ragStore.search(question, 4, { type: "glossary" }),
        ragStore.search(question, 3, { type: "schema"   }),
      ]);

      const MIN_SCORE = 0.65; // slightly lower threshold to surface more useful context
      const relExamples = examples.filter(r => r.score >= MIN_SCORE);
      const relGlossary = glossary.filter(r => r.score >= 0.60);
      const relSchema   = schemaDocs.filter(r => r.score >= 0.65);

      let ctx = "";

      if (relExamples.length) {
        ctx += "═══ SIMILAR PAST QUERIES — follow these exact patterns ═══\n";
        for (const ex of relExamples) {
          ctx += `Q: ${ex.metadata.question}\n`;
          ctx += `SQL:\n${ex.metadata.sql}\n`;
          if (ex.metadata.note) ctx += `Note: ${ex.metadata.note}\n`;
          ctx += "\n";
        }
      }

      if (relGlossary.length) {
        ctx += "═══ BUSINESS GLOSSARY — use these definitions ═══\n";
        for (const g of relGlossary) {
          ctx += `• ${g.metadata.term}: ${g.metadata.definition}\n`;
        }
        ctx += "\n";
      }

      if (relSchema.length) {
        ctx += "═══ ADDITIONAL SCHEMA CONTEXT ═══\n";
        for (const s of relSchema) {
          ctx += `${s.text}\n\n`;
        }
      }

      const found = {
        examples: relExamples.length,
        glossary: relGlossary.length,
        schema:   relSchema.length,
      };
      console.log("[langchain] RAG retrieved:", found);

      return {
        ragContext: ctx.trim(),
        nodeLog:    [{ node: "retrieve_context", found }],
      };
    } catch (e) {
      // RAG failure must never block the main query
      console.error("[langchain] RAG retrieve error (non-fatal):", e.message);
      return { ragContext: "", nodeLog: ["retrieve_context:skipped"] };
    }
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 0 — pre_flight_gate (fast path + feasibility + single-view schema slice)
   ───────────────────────────────────────────────────────────────────────────── */
function makePreFlightGate() {
  return async function preFlightGate(state) {
    const t0 = Date.now();
    console.log("[langchain] node: pre_flight_gate");

    const gate = runPreFlightGate(state.originalQuestion || state.question, {
      tableHint: state.tableHint || undefined,
      fromDate: state.userDateRange?.from,
      toDate: state.userDateRange?.to,
    });

    const metaCheck = verifySchemaMetadata();
    if (!metaCheck.ok) {
      console.warn("[langchain] schema metadata:", metaCheck.message);
    }

    console.log(
      "[langchain] pre_flight:",
      gate.nextStep,
      gate.preFlightMs != null ? `${gate.preFlightMs}ms` : "",
      gate.clarityScore != null ? `clarity=${gate.clarityScore.toFixed(2)}` : ""
    );

    if (gate.nextStep === "PROMPT_USER_FOR_CLARIFICATION") {
      return {
        nextStep: gate.nextStep,
        clarificationMessage: gate.clarificationMessage,
        clarificationOptions: gate.clarificationOptions || [],
        suggestedOptions: gate.suggestedOptions || [],
        uiType: gate.uiType || "SUGGESTION_CHIPS",
        rankedViews: gate.rankedViews,
        clarityScore: gate.clarityScore,
        preFlightMs: gate.preFlightMs,
        finalAnswer: gate.clarificationMessage,
        confidence: "low",
        confidenceNote: gate.clarificationReason || "pre_flight_clarification",
        nodeLog: ["pre_flight_gate:clarification"],
      };
    }

    if (gate.nextStep === "FAST_PATH") {
      const qOrig = gate.originalQuestion || state.question;
      let view =
        gate.targetView ||
        gate.rankedViews?.[0]?.viewName ||
        getCanonicalSalesContext().table;
      if (isSalespersonTopNQuestion(qOrig)) {
        view = getCanonicalSalespersonContext().table;
      } else if (inferAiDomain(qOrig) === "purchase") {
        view = getCanonicalPurchaseContext().table;
      }
      return {
        nextStep: gate.nextStep,
        question: gate.correctedQuestion || state.question,
        originalQuestion: gate.originalQuestion || state.question,
        adaptiveEnrichment: gate.adaptiveEnrichment || "",
        fastPathSql: gate.fastPathSql,
        checkedSQL: gate.fastPathSql,
        generatedSQL: gate.fastPathSql,
        targetView: view,
        topViews: [view],
        rankedViews: gate.rankedViews,
        clarityScore: 1,
        preFlightMs: gate.preFlightMs,
        nodeLog: [`pre_flight_gate:fast_path:${gate.fastPathMatch}`],
      };
    }

    const qCheck = gate.originalQuestion || state.originalQuestion || state.question;
    let targetView = gate.targetView;
    if (isSalespersonTopNQuestion(qCheck)) {
      targetView = getCanonicalSalespersonContext().table;
    }
    const schemaText =
      formatSchemaWithSemantics([targetView]) || gate.schemaText;
    const businessDictionary = buildBusinessDictionaryPrompt(
      [targetView],
      state.question
    );

    return {
      nextStep: "CONTINUE",
      question: gate.correctedQuestion || state.question,
      originalQuestion: gate.originalQuestion || state.originalQuestion || state.question,
      adaptiveEnrichment: gate.adaptiveEnrichment || state.adaptiveEnrichment || "",
      targetView,
      topViews: gate.topViews,
      rankedViews: gate.rankedViews,
      schemaText,
      businessDictionary,
      clarityScore: gate.clarityScore,
      preFlightMs: Date.now() - t0,
      sampleData: {},
      sampleText: "",
      nodeLog: ["pre_flight_gate:continue"],
    };
  };
}

function routeAfterPreFlight(state) {
  if (state.nextStep === "PROMPT_USER_FOR_CLARIFICATION") return "generate_answer";
  if (state.nextStep === "FAST_PATH") return "execute_sql";
  return "retrieve_context";
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 3b — resolve_intent  (plain-English → structured plan, no SQL yet)
   ───────────────────────────────────────────────────────────────────────────── */
function makeResolveIntent(llm) {
  return async function resolveIntent(state) {
    if (!isIntentStepEnabled()) {
      return { queryIntent: null, nodeLog: ["resolve_intent:skipped"] };
    }

    const provider = state.aiProvider || normalizeProvider();
    console.log("[langchain] node: resolve_intent —", provider);
    try {
      const response = await llm.invoke([
        new SystemMessage(
          buildIntentSystemPromptForProvider(provider, state.schemaText, {
            targetView: state.targetView,
            question: state.question,
            userQuestion: state.originalQuestion || state.question,
          })
        ),
        new HumanMessage(buildIntentUserPrompt(state)),
      ]);
      const intent = parseIntentJson(response.content);
      if (intent) {
        console.log("[langchain] intent:", intent.metric_intent || JSON.stringify(intent).slice(0, 80));
      }
      return {
        queryIntent: intent,
        nodeLog: ["resolve_intent"],
      };
    } catch (e) {
      console.warn("[langchain] resolve_intent failed:", e.message);
      return { queryIntent: null, nodeLog: ["resolve_intent:error"] };
    }
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 3c — discover_column_values
   Layer 2 (value sampling) + original live sample discovery run in parallel.
   Injects real DB values into the SQL generation prompt so the LLM never
   hallucinates branch names, categories, department names etc.
   ───────────────────────────────────────────────────────────────────────────── */
function makeDiscoverColumnValues(pool) {
  return async function discoverColumnValuesNode(state) {
    if (!isColumnDiscoveryEnabled()) {
      return { columnDiscoveryText: "", liveColumnSamples: {}, nodeLog: ["discover_column_values:off"] };
    }

    console.log("[langchain] node: discover_column_values (Layer 2 — value sampling)");
    const groundingQuestion = state.originalQuestion || state.question;
    const view =
      state.targetView ||
      (Array.isArray(state.topViews) && state.topViews[0]) ||
      getCanonicalSalesContext().table;

    try {
      // Run original agentic sampler + Layer-2 semantic sampler in parallel
      const [agenticResult, semanticResult] = await Promise.allSettled([
        discoverLiveSamplesForQuestion(pool, groundingQuestion, view),
        sampleValuesForQuestion(pool, groundingQuestion, view),
      ]);

      // Merge samples from both sources
      const agenticSamples = agenticResult.status === "fulfilled" ? agenticResult.value?.samples || {} : {};
      const agenticText    = agenticResult.status === "fulfilled" ? agenticResult.value?.text    || "" : "";
      const semanticSamples = semanticResult.status === "fulfilled" ? semanticResult.value?.samples || {} : {};
      const semanticText    = semanticResult.status === "fulfilled" ? semanticResult.value?.text    || "" : "";

      const mergedSamples = { ...agenticSamples, ...semanticSamples };
      const flatSamples = {};
      for (const [col, entry] of Object.entries(mergedSamples)) {
        const vals = sampleValuesList(entry);
        if (vals.length) flatSamples[col] = vals;
      }

      // Build value-correction hints (e.g. "chenai" → "CHENNAI MAIN BRANCH")
      const correctionBlock = buildValueCorrectionBlock(groundingQuestion, flatSamples);

      // Combine all discovery text — semantic text first (higher priority)
      const combinedText = [semanticText, agenticText, correctionBlock]
        .filter(Boolean)
        .join("\n\n");

      const found = Object.keys(mergedSamples).length;
      console.log("[langchain] column discovery:", found, "column(s) sampled (Layer 2 + agentic)");

      return {
        liveColumnSamples:    mergedSamples,
        columnDiscoveryText:  combinedText,
        nodeLog: [`discover_column_values:${found}`],
      };
    } catch (e) {
      console.warn("[langchain] discover_column_values failed (non-fatal):", e.message);
      return { columnDiscoveryText: "", liveColumnSamples: {}, nodeLog: ["discover_column_values:error"] };
    }
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 3d — compile_sql_from_intent (deterministic T-SQL from JSON plan)
   ───────────────────────────────────────────────────────────────────────────── */
function makeCompileSqlFromIntent() {
  return async function compileSqlFromIntent(state) {
    const rootQ = state.originalQuestion || state.question;
    const homeHit = resolveHomeAlignedSql(state.question, rootQ);
    if (homeHit?.sql) {
      console.log("[langchain] compile_sql_from_intent: home-aligned", homeHit.label);
      return {
        generatedSQL: homeHit.sql,
        checkedSQL: homeHit.sql,
        sqlFromIntentCompiler: true,
        nodeLog: ["compile_sql_from_intent:home_aligned"],
      };
    }

    const sql = compileIntentToSql(state.queryIntent, {
      targetView: state.targetView,
      originalQuestion: rootQ,
      question: state.question,
    });
    if (sql) {
      console.log("[langchain] compile_sql_from_intent: success");
      return {
        generatedSQL: sql,
        checkedSQL: sql,
        sqlFromIntentCompiler: true,
        nodeLog: ["compile_sql_from_intent"],
      };
    }
    return { nodeLog: ["compile_sql_from_intent:skip"] };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 4 — generate_sql
   ───────────────────────────────────────────────────────────────────────────── */
function makeGenerateSQL(llm) {
  return async function generateSQL(state) {
    console.log("[langchain] node: generate_sql");

    if (state.generatedSQL && state.sqlFromIntentCompiler) {
      return { nodeLog: ["generate_sql:skipped_intent_compiler"] };
    }

    const rootQGen = state.originalQuestion || state.question;
    const homeBeforeLlm = resolveHomeAlignedSql(state.question, rootQGen);
    if (homeBeforeLlm?.sql) {
      console.log("[langchain] generate_sql: home-aligned", homeBeforeLlm.label);
      return {
        generatedSQL: homeBeforeLlm.sql,
        checkedSQL: homeBeforeLlm.sql,
        sqlFromIntentCompiler: true,
        nodeLog: ["generate_sql:home_aligned"],
      };
    }

    const observationBlock =
      (state.systemObservations || []).length > 0
        ? `\n\n${(state.systemObservations || []).join("\n\n")}`
        : "";

    const retryGuidance =
      state.retryCount > 0 && state.retryErrors.length
        ? `\n\n══ PRIOR FAILURES — fix before retrying ══\n${state.retryErrors.join("\n")}`
        : "";

    const sampleSection = state.sampleText
      ? `\n\n[SAMPLE DATA — note the actual date formats, branch code format, value scales]\n${state.sampleText}`
      : "";

    const dateRangeSection = buildDateRangeClause(state.userDateRange);

    const ragSection = state.ragContext
      ? `\n\n[RAG MEMORY — highest-priority context, follow these patterns exactly]\n${state.ragContext}`
      : "";

    const dictSection = state.businessDictionary
      ? `\n\n${state.businessDictionary}`
      : "";

    const intentSection = formatIntentForSqlPrompt(state.queryIntent);

    const discoverySection = state.columnDiscoveryText
      ? `\n\n${state.columnDiscoveryText}`
      : "";

    const adaptiveSection = state.adaptiveEnrichment
      ? `\n\n${state.adaptiveEnrichment}`
      : "";

    // Layer 1 — Semantic Mapping injection: critical column rules at top of every prompt
    const semanticMappingBlock = getSemanticMappingPrompt()
      ? `\n\n[MANDATORY COLUMN RULES — Layer 1 Semantic Map]\n${getSemanticMappingPrompt()}`
      : "";

    const provider = state.aiProvider || normalizeProvider();
    const systemPrompt = buildSqlGenerationSystemPromptForProvider(
      provider,
      state.queryIntent,
      state.dateContext || "",
      state.columnDiscoveryText || "",
      {
        targetView: state.targetView,
        question: state.question,
        userQuestion: state.originalQuestion || state.question,
        realDatabaseValueSamples: flattenSamplesForPrompt(state.liveColumnSamples),
        viewMetadata: state.schemaText,
      }
    );

    const userPrompt =
      `[SCHEMA — ONLY use columns listed here]\n${state.schemaText}` +
      semanticMappingBlock +
      adaptiveSection +
      dictSection +
      discoverySection +
      (intentSection ? `\n\n${intentSection}` : "") +
      sampleSection +
      ragSection +
      dateRangeSection +
      `\n\n[ORIGINAL QUESTION]\n${state.originalQuestion || state.question}` +
      `\n\n[NORMALIZED QUESTION]\n${state.question}` +
      observationBlock +
      retryGuidance;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    let sql = extractSQL(response.content);
    sql = remapLegacyColumnNames(sql);
    sql = enforceTopLimit(sql, 1000);
    console.log("[langchain] generated SQL:", sql.slice(0, 160));
    return { generatedSQL: sql, sqlValidationFailed: false, nodeLog: ["generate_sql"] };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 5 — check_sql  (structural validator + optional LLM review)
   ───────────────────────────────────────────────────────────────────────────── */
function makeCheckSQL(llm) {
  return async function checkSQL(state) {
    console.log("[langchain] node: check_sql");

    const rawSql = rewriteSalesSqlToHomeFact(
      remapLegacyColumnNames(state.generatedSQL || ""),
      state.originalQuestion || state.question
    );

    /* ── Layer 3: Compliance Guard — check for illegal columns first ─────── */
    const compliance = checkSqlCompliance(rawSql);
    if (!compliance.valid) {
      const attempt = (state.retryCount || 0) + 1;
      console.warn("[langchain] check_sql COMPLIANCE FAIL:", compliance.rejectionReason);

      // Try auto-repair first (may fix bracketed column references)
      const repaired = autoRepairSql(rawSql);
      if (repaired !== rawSql) {
        const recheck = checkSqlCompliance(repaired);
        if (recheck.valid) {
          console.log("[langchain] check_sql: compliance auto-repaired successfully");
          // Fall through with repaired SQL — skip retry
          const structR = validateSqlAccuracy(repaired, state.question, sqlValidationContextForQuestion(state.question));
          if (structR.isValid) {
            return { checkedSQL: repaired, sqlValidationFailed: false, nodeLog: ["check_sql:compliance_auto_repaired"] };
          }
        }
      }

      // Auto-repair didn't work — trigger LangGraph self-healing retry
      const observation = formatComplianceObservation(compliance, rawSql);

      if (attempt > 3) {
        return {
          checkedSQL: rawSql,
          sqlValidationFailed: true,
          nodeLog: ["check_sql:compliance_gave_up"],
        };
      }

      return {
        generatedSQL: rawSql,
        checkedSQL:   rawSql,
        sqlValidationFailed: true,
        retryCount:   attempt,
        executionResult: {
          error:           compliance.rejectionReason,
          failed_sql:      rawSql,
          validation_only: true,
        },
        systemObservations: [observation],
        nodeLog: ["check_sql:compliance_fail"],
      };
    }

    /* ── Structural validator (existing) ─────────────────────────────────── */
    const structural = validateSqlAccuracy(
      rawSql,
      state.question,
      sqlValidationContextForQuestion(state.question)
    );

    if (!structural.isValid) {
      const attempt = (state.retryCount || 0) + 1;
      console.warn("[langchain] check_sql structural fail:", structural.reason);
      const observation =
        `[System Observation] Your generated SQL failed validation rules: ${structural.reason} ` +
        "Correct column selection and regenerate.";

      if (attempt > 3) {
        return {
          checkedSQL: rawSql,
          sqlValidationFailed: true,
          nodeLog: ["check_sql:structural_gave_up"],
        };
      }

      return {
        generatedSQL: rawSql,
        checkedSQL: rawSql,
        sqlValidationFailed: true,
        retryCount: attempt,
        executionResult: {
          error: structural.reason,
          failed_sql: rawSql,
          validation_only: true,
        },
        systemObservations: [observation],
        nodeLog: ["check_sql:structural_fail"],
      };
    }

    const llmCheckOff = /^(0|false|no)$/i.test(String(process.env.LANGGRAPH_LLM_SQL_CHECK || "0").trim());
    if (llmCheckOff) {
      return { checkedSQL: rawSql, sqlValidationFailed: false, nodeLog: ["check_sql:structural_ok"] };
    }

    const topNMatch = state.question.match(/\btop\s+(\d+)\b/i);
    const userRequestedTopN = topNMatch ? parseInt(topNMatch[1]) : null;

    const systemPrompt = `You are a T-SQL reviewer for Microsoft SQL Server.
Fix definite bugs only — preserve intent. Enforce metadata mappings and aggregation rules.

${buildAggregationMandateBlock()}

Do-not-change: FROM/JOIN targets, user-requested TOP N${
      userRequestedTopN ? ` (${userRequestedTopN})` : ""
    }, valid JOIN ON clauses.

Fix when certain: invalid columns (use SCHEMA + business mappings), missing GROUP BY,
GETDATE()-N date math, missing TOP on non-aggregated scans, trailing semicolons, SQL comments.

Output ONLY the SQL — no explanation, no markdown fences.`;

    const userPrompt =
      `[SCHEMA — ONLY these columns exist]\n${state.schemaText}\n\n` +
      (state.sampleText ? `[SAMPLE DATA]\n${state.sampleText}\n\n` : "") +
      `[SQL TO REVIEW]\n${rawSql}`;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    let checkedSQL = remapLegacyColumnNames(extractSQL(response.content) || rawSql);
    const structural2 = validateSqlAccuracy(
      checkedSQL,
      state.question,
      sqlValidationContextForQuestion(state.question)
    );
    if (!structural2.isValid) {
      console.warn("[langchain] check_sql LLM output failed structural:", structural2.reason);
      checkedSQL = rawSql;
    }

    const changed = checkedSQL !== rawSql;
    console.log("[langchain] check_sql changed:", changed, "→", checkedSQL.slice(0, 160));
    return { checkedSQL, sqlValidationFailed: false, nodeLog: ["check_sql"] };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 6 — execute_sql
   ───────────────────────────────────────────────────────────────────────────── */
function makeExecuteSQL(pool) {
  return async function executeSQL(state) {
    console.log("[langchain] node: execute_sql");
    const sql = state.checkedSQL || state.generatedSQL;

    if (detectExportIntent(state.question)) {
      console.log("[langchain] execute_sql skipped — raw export will run async");
      return {
        executionResult: { error: null, export_only: true, row_count: 0, data: [] },
        finalSQL: sql,
        finalData: [],
        nodeLog: ["execute_sql:export_deferred"],
      };
    }

    const result = await dispatchAgenticTool(pool, "run_select", { sql }, state.question, "");
    console.log(
      "[langchain] execute_sql:",
      result.error ? `ERROR: ${result.error}` : `${result.row_count ?? (result.data?.length ?? 0)} rows`
    );

    const observation = result.system_observation || null;
    return {
      executionResult: result,
      finalSQL: result.error ? null : sql,
      finalData: result.error ? [] : (result.data || []),
      systemObservations: observation ? [observation] : [],
      nodeLog: ["execute_sql"],
    };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 7 — error_recovery
   ───────────────────────────────────────────────────────────────────────────── */
function makeErrorRecovery(llm) {
  return async function errorRecovery(state) {
    const errMsg    = state.executionResult?.error || "unknown error";
    const failedSQL = state.executionResult?.failed_sql || state.checkedSQL || state.generatedSQL;
    const attempt   = (state.retryCount || 0) + 1;
    console.log("[langchain] node: error_recovery attempt", attempt, "— error:", errMsg);

    const objMatch = errMsg.match(/invalid object name\s+'([^']+)'/i);
    if (objMatch) {
      markSalesFactTableUnavailable(objMatch[1]);
      const swapped = rewriteSqlToAvailableSalesFact(failedSQL);
      if (swapped && swapped !== failedSQL) {
        console.log("[langchain] error_recovery: swapped missing view →", getCanonicalSalesContext().table);
        return {
          checkedSQL: swapped,
          generatedSQL: swapped,
          sqlValidationFailed: false,
          executionResult: {},
          retryCount: attempt,
          retryErrors: [`Attempt ${attempt}: ${errMsg}`],
          nodeLog: [`error_recovery:view_fallback_${attempt}`],
        };
      }
    }

    const rootQ = state.originalQuestion || state.question || "";
    if (isTopVendorsByMrpValueQuestion(rootQ)) {
      const vendorSql = buildTopVendorsByMrpValueSql(rootQ);
      return {
        checkedSQL: vendorSql,
        generatedSQL: vendorSql,
        sqlValidationFailed: false,
        executionResult: {},
        retryCount: attempt,
        retryErrors: [`Attempt ${attempt}: ${errMsg}`],
        nodeLog: [`error_recovery:vendor_mrp_canonical_${attempt}`],
      };
    }

    // ── Build rich observation with column-specific replacement hints ──────
    const observation = formatSystemObservation(
      { message: errMsg, failed_sql: failedSQL },
      failedSQL,
      attempt
    );

    // ── Extract invalid column from Error 207 for targeted replacement ────
    const invalidColMatch = errMsg.match(/Invalid column name ['"]?(\w+)['"]?/i);
    let columnDirective = "";
    if (invalidColMatch) {
      const badCol = invalidColMatch[1];
      const knownFix = {
        SaleNetAmount: "MrpValue", NetSlsNetAmount: "MrpValue", NetAmount: "MrpValue",
        NetSalesAmount: "MrpValue",
        Quantity: "AppQty", Qty: "AppQty", Pcs: "AppQty", SalesQuantity: "AppQty",
        InvoiceNo: "XnNo", InvoiceDt: "XnDt", CashmemoDt: "XnDt", SaleDate: "XnDt",
        BranchId: "BranchAlias", BranchName: "BranchAlias", BranchShortName: "BranchAlias",
        CustomerId: "XnNo",  // proxy — CustomerCode not on APP_REPORT
        Colour: "Color",     // wrong spelling — actual column is Color
        SizeName: "Size",    // wrong column — actual column is Size
        EAN: "ArticleNo",    // does not exist on APP_REPORT
      };
      const fix = knownFix[badCol] || knownFix[badCol.replace(/^_/, "")] || null;
      if (fix) {
        columnDirective = `\n\n[CRITICAL FIX REQUIRED — SQL Error 207]\n` +
          `The column '${badCol}' does NOT exist in dbo.VW_MB_POWERBI_APP_REPORT.\n` +
          `You MUST replace every occurrence of '${badCol}' with '${fix}'.\n` +
          `This is a hard requirement — any SQL containing '${badCol}' will fail again.`;
      }
    }

    const systemPrompt =
      `${buildSqlGenerationSystemPrompt(
        state.queryIntent,
        state.dateContext || "",
        state.columnDiscoveryText || "",
        {
          targetView: state.targetView,
          question: state.question,
          userQuestion: state.originalQuestion || state.question,
        }
      )}\n\n` +
      `SELF-HEALING ATTEMPT ${attempt}/3: The database rejected the previous SQL.\n` +
      `Study the [System Observation] and ALL column directives below.\n` +
      `Output ONLY the corrected SQL — no explanation, no markdown fences, no semicolons.`;

    const semanticRetryBlock = getSemanticMappingPrompt()
      ? `[MANDATORY COLUMN RULES — retry]\n${getSemanticMappingPrompt()}\n\n`
      : "";

    const userPrompt =
      `[SCHEMA]\n${state.schemaText}\n\n` +
      semanticRetryBlock +
      `${state.businessDictionary || ""}\n\n` +
      (state.columnDiscoveryText ? `[VALUE SAMPLES]\n${state.columnDiscoveryText}\n\n` : "") +
      observation +
      columnDirective +
      `\n\n[ALL PRIOR ERRORS — do not repeat these mistakes]\n` +
      [...(state.retryErrors || []), `Attempt ${attempt}: ${errMsg}`].join("\n");

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    // Apply compliance auto-repair AND legacy column remap after LLM fix
    let fixedSQL = extractSQL(response.content) || failedSQL;
    fixedSQL = remapLegacyColumnNames(fixedSQL);
    fixedSQL = enforceTopLimit(fixedSQL, 1000);

    // If the LLM still has the bad column, do a hard string replacement
    if (invalidColMatch) {
      const badCol = invalidColMatch[1];
      const knownFix = {
        SaleNetAmount: "MrpValue", NetSlsNetAmount: "MrpValue", NetAmount: "MrpValue",
        NetSalesAmount: "MrpValue",
        Quantity: "AppQty", Qty: "AppQty", Pcs: "AppQty", SalesQuantity: "AppQty",
        InvoiceNo: "XnNo", InvoiceDt: "XnDt", CashmemoDt: "XnDt", SaleDate: "XnDt",
        BranchId: "BranchAlias", BranchName: "BranchAlias", BranchShortName: "BranchAlias",
        Colour: "Color", SizeName: "Size", EAN: "ArticleNo",
      };
      const fix = knownFix[badCol] || null;
      if (fix && fixedSQL.includes(badCol)) {
        fixedSQL = fixedSQL.replace(new RegExp(`\\b${badCol}\\b`, "g"), fix);
        console.log(`[error_recovery] hard-replaced '${badCol}' → '${fix}' in SQL`);
      }
    }

    return {
      checkedSQL:         fixedSQL,
      generatedSQL:       fixedSQL,
      sqlValidationFailed: false,
      executionResult:    {},
      retryCount:         attempt,
      retryErrors:        [`Attempt ${attempt}: ${errMsg}`],
      systemObservations: [observation],
      nodeLog:            [`error_recovery:attempt_${attempt}`],
    };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 8 — generate_answer
   ───────────────────────────────────────────────────────────────────────────── */
function makeGenerateAnswer(llm) {
  return async function generateAnswer(state) {
    console.log("[langchain] node: generate_answer");
    const rows = state.finalData || [];

    if (rows.length === 0) {
      const noDataMsg =
        state.executionResult?.error
          ? `Could not retrieve data — query error: ${state.executionResult.error}. Try rephrasing or using a different date range.`
          : "No matching records found for your question. Try widening the date range, checking filters (branch name, category, etc.), or rephrasing the question.";
      return { finalAnswer: noDataMsg, confidence: "low", confidenceNote: "0 rows returned", nodeLog: ["generate_answer"] };
    }

    const sample = JSON.stringify(rows.slice(0, 20), null, 2);
    const totalRows = rows.length;

    const systemPrompt = `You are a retail business intelligence analyst for a fashion ERP.
Summarize the query results in 2-5 plain English sentences.
Rules:
- Lead with the single most important number or finding
- Use Indian number system: values ÷ 100000 = Lakhs, ÷ 10000000 = Crores
- Example: 16825000 → ₹168.25 Lakhs or ₹1.68 Crores
- Be precise — include actual numbers from the data, not vague descriptions
- If there are totals/sums in the data, state them prominently
- If the data shows a trend, describe the direction clearly
- Do NOT mention SQL, database, columns, or technical details
- Do NOT say "the data shows" — speak directly ("Total sales were…")`;

    const userPrompt =
      `[QUESTION]\n${state.question}\n\n` +
      `[DATA — ${totalRows} row(s)]\n${sample}` +
      (totalRows > 20 ? `\n… (${totalRows - 20} more rows not shown)` : "");

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    return {
      finalAnswer: response.content,
      confidence:  "high",
      nodeLog:     ["generate_answer"],
    };
  };
}


/* ─────────────────────────────────────────────────────────────────────────────
   NODE 8.5 — zero_rows_recovery
   SQL ran OK but returned 0 rows. Try once to widen the date range or relax
   the filter and re-generate (sets zeroRowsRetried so we don't loop forever).
   ───────────────────────────────────────────────────────────────────────────── */
function tryDeterministicZeroRowSql(state) {
  const q = state.originalQuestion || state.question || "";
  const sql = String(state.checkedSQL || state.generatedSQL || "");

  if (isTopStoreYesterdayQuestion(q)) {
    const homeSql = buildTopStoreYesterdaySql(q);
    if (homeSql) return homeSql;
  }

  if (
    isSalespersonTopNQuestion(q) ||
    (/\bsalespersons?\b/i.test(q) &&
      (/\bMrpValue\b/i.test(sql) || /\bSupplierName\b/i.test(sql) && /\bAPP_REPORT\b/i.test(sql)))
  ) {
    const staffSql = buildSalespersonTopNSql(q);
    if (staffSql) return staffSql;
  }

  const homeHit = resolveHomeAlignedSql(q, state.originalQuestion);
  if (homeHit?.sql) return homeHit.sql;

  if (isTopInvoicesTodayQuestion(q) || (/\btoday\b/i.test(q) && /\binvoices?\b/i.test(q) && /\b(top|highest)\b/i.test(q))) {
    const invSql = buildTopInvoicesTodaySql(q);
    if (invSql) return invSql;
  }

  if (isSalesTopNBreakdownQuestion(q)) {
    const breakdownSql = buildSalesTopNBreakdownSql(q);
    if (breakdownSql) return breakdownSql;
  }

  if (/\btoday\b/i.test(q) && /DATEADD\s*\(\s*day\s*,\s*-7/i.test(sql) && /\binvoices?\b/i.test(q)) {
    const invSql = buildTopInvoicesTodaySql(q);
    if (invSql) return invSql;
  }

  if (/\byesterday\b/i.test(q) && /DATEADD\s*\(\s*day\s*,\s*-7/i.test(sql)) {
    const sales = getCanonicalSalesContext();
    const yesterday = buildTemporalWhere(sales.dateCol, "yesterday");
    if (yesterday && /BranchAlias|branch/i.test(q)) {
      return (
        `SELECT TOP 1 [${sales.branchCol}] AS Store, SUM(ISNULL([${sales.amountCol}], 0)) AS TotalMrpValue` +
        ` FROM ${sales.table} WITH (NOLOCK) WHERE ${yesterday}` +
        ` GROUP BY [${sales.branchCol}] ORDER BY TotalMrpValue DESC`
      );
    }
  }

  const anchor = detectTemporalFromQuestion(q);
  if (anchor === "yesterday" && !/\byesterday\b/i.test(sql.toLowerCase())) {
    const sales = getCanonicalSalesContext();
    const yesterday = buildTemporalWhere(sales.dateCol, "yesterday");
    if (yesterday) {
      return sql.replace(
        /WHERE[\s\S]+?(?=GROUP\s+BY|ORDER\s+BY|$)/i,
        `WHERE ${yesterday} `
      );
    }
  }

  return null;
}

/**
 * Validate that the WHERE clause filter values actually exist in the target view.
 * Returns { valid: bool, badFilters: string[], hint: string }
 *
 * Strategy: extract equality filters like [Col] = 'Value' or LIKE '%Value%'
 * from the SQL and probe the DB with a COUNT(*) query for each.
 */
async function validateFilterValues(sql, pool) {
  if (!pool) return { valid: true, badFilters: [], hint: "" };
  const bad = [];
  const hints = [];

  // Match patterns: [Col] = N'value' | [Col] LIKE N'%value%' | [Col] = 'value'
  const equalRe = /\[([^\]]+)\]\s*=\s*N?'([^']{2,100})'/gi;
  const likeRe  = /\[([^\]]+)\]\s+LIKE\s+N?'%([^'%]{2,80})%'/gi;

  // Extract FROM table for probing
  const fromMatch = sql.match(/FROM\s+(dbo\.\S+)/i);
  if (!fromMatch) return { valid: true, badFilters: [], hint: "" };
  const probeTable = fromMatch[1].replace(/WITH\s*\(NOLOCK\)/i, "").trim();

  const checked = new Map();

  async function probe(col, val) {
    const key = `${col}::${val}`;
    if (checked.has(key)) return checked.get(key);
    try {
      const result = await pool.request().query(
        `SELECT COUNT(*) AS N FROM ${probeTable} WITH (NOLOCK) WHERE LOWER([${col}]) = LOWER(N'${val.replace(/'/g, "''")}')`
      );
      const n = result.recordset?.[0]?.N ?? 0;
      checked.set(key, n > 0);
      return n > 0;
    } catch {
      checked.set(key, true); // assume valid if probe fails
      return true;
    }
  }

  for (const m of sql.matchAll(equalRe)) {
    const [, col, val] = m;
    // Skip date columns and numeric-looking values
    if (/Date|Dt|XnDt|CashmemoDt/i.test(col)) continue;
    if (/^\d/.test(val)) continue;
    const exists = await probe(col, val);
    if (!exists) {
      bad.push(`[${col}] = '${val}'`);
      hints.push(`No rows found where [${col}] = '${val}' — check spelling or try LIKE`);
    }
  }
  for (const m of sql.matchAll(likeRe)) {
    const [, col, val] = m;
    if (/Date|Dt/i.test(col)) continue;
    const exists = await probe(col, val);
    if (!exists) {
      bad.push(`[${col}] LIKE '%${val}%'`);
      hints.push(`No rows match [${col}] LIKE '%${val}%' — value may be misspelled`);
    }
  }

  return {
    valid: bad.length === 0,
    badFilters: bad,
    hint: hints.join("; "),
  };
}

function makeZeroRowsRecovery(llm, pool) {
  return async function zeroRowsRecovery(state) {
    console.log("[langchain] node: zero_rows_recovery");

    const deterministic = tryDeterministicZeroRowSql(state);
    if (deterministic) {
      console.log("[langchain] zero_rows_recovery: deterministic fix (yesterday/home table)");
      return {
        generatedSQL: deterministic,
        checkedSQL: deterministic,
        zeroRowsRetried: true,
        nodeLog: ["zero_rows_recovery:deterministic"],
      };
    }

    // ── Probe: are the filter values actually in the DB? ──────────────────────
    const currentSql = state.checkedSQL || state.generatedSQL || "";
    let filterHint = "";
    try {
      const filterCheck = await validateFilterValues(currentSql, pool);
      if (!filterCheck.valid) {
        console.log("[langchain] zero_rows_recovery: bad filter values detected:", filterCheck.badFilters);
        filterHint =
          `\n[ZERO-ROW CAUSE] These filter values do NOT exist in the database:\n` +
          filterCheck.badFilters.map((f) => `  • ${f}`).join("\n") +
          `\n${filterCheck.hint}` +
          `\nDo NOT widen the date range. Instead: remove or correct the bad filters. ` +
          `Use LOWER() LIKE '%partial%' if the exact value is unknown.`;
      }
    } catch (probeErr) {
      console.warn("[langchain] zero_rows_recovery: filter probe failed:", probeErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    const provider = state.aiProvider || normalizeProvider();
    const systemPrompt = `${buildSqlGenerationSystemPromptForProvider(
      provider,
      state.queryIntent,
      state.dateContext || "",
      "",
      {
        targetView: state.targetView,
        question: state.question,
        userQuestion: state.originalQuestion || state.question,
      }
    )}

A query returned 0 rows. Do NOT widen "yesterday" or "today" to 7 days or MTD unless the user asked for a range.
Try the Home analytics table if APP_REPORT is empty. Output ONLY corrected SQL.`;

    const userPrompt =
      `[SCHEMA]\n${state.schemaText}\n\n` +
      (state.sampleText ? `[SAMPLE DATA]\n${state.sampleText}\n\n` : "") +
      `[ORIGINAL QUESTION]\n${state.originalQuestion || state.question}\n\n` +
      `[ZERO-ROW QUERY]\n${currentSql}\n\n` +
      filterHint +
      `\nHint: keep explicit time words (yesterday/today) as single-day filters; try ${getCanonicalSalesContext().table} for branch sales.`;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);
    const fixedSQL = extractSQL(response.content) || currentSql;
    console.log("[langchain] zero_rows_recovery SQL:", fixedSQL.slice(0, 160));
    return {
      generatedSQL: fixedSQL,
      checkedSQL: fixedSQL,
      zeroRowsRetried: true,
      nodeLog: ["zero_rows_recovery"],
    };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 9 — verify_answer
   Cross-checks the generated natural-language answer against the actual data.
   If numbers don't match it corrects them silently rather than hallucinating.
   ───────────────────────────────────────────────────────────────────────────── */
function makeVerifyAnswer(llm) {
  return async function verifyAnswer(state) {
    console.log("[langchain] node: verify_answer");
    // Only verify when we have a meaningful answer and some rows
    const rows = state.finalData || [];
    if (!state.finalAnswer || rows.length === 0) {
      return { nodeLog: ["verify_answer"] };
    }

    const sample = JSON.stringify(rows.slice(0, 20), null, 2);
    const systemPrompt = `You are a fact-checker for a retail BI system.
You are given an answer text and the actual data rows it was generated from.
Your job: verify every number in the answer is correct according to the data.
If a number is wrong, silently correct it without mentioning the correction.
If the answer is completely correct, return it unchanged.
Do NOT add new insights or change wording beyond fixing wrong numbers.
Respond ONLY with the (possibly corrected) answer text — no JSON, no labels.`;

    const userPrompt =
      `[ANSWER TO VERIFY]\n${state.finalAnswer}\n\n` +
      `[ACTUAL DATA — ${rows.length} row(s)]\n${sample}` +
      (rows.length > 20 ? `\n… (${rows.length - 20} more rows not shown)` : "");

    try {
      const response = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);
      const verified = String(response.content || "").trim();

      // Auto-save to RAG store when confidence is high and query succeeded cleanly
      const autoSave =
        verified &&
        state.retryCount === 0 &&
        !state.zeroRowsRetried &&
        state.finalSQL &&
        rows.length >= 1 &&
        String(process.env.RAG_AUTO_SAVE || "1").trim() !== "0";

      if (autoSave) {
        ragStore.addExample(state.question, state.finalSQL, "", true).catch(() => {});
        console.log("[langchain] RAG: auto-saved successful query as example");
      }

      if (verified) {
        return { finalAnswer: verified, nodeLog: ["verify_answer"] };
      }
    } catch (e) {
      console.warn("[langchain] verify_answer error (skipped):", e.message);
    }
    return { nodeLog: ["verify_answer"] };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   ROUTING HELPERS
   ───────────────────────────────────────────────────────────────────────────── */
function routeAfterCheckSql(state) {
  if (state.sqlValidationFailed) {
    if ((state.retryCount || 0) <= 3 && state.executionResult?.error) {
      return "error_recovery";
    }
    return "generate_answer";
  }
  return "execute_sql";
}

function routeAfterExecute(state) {
  const err  = state.executionResult?.error;
  const rows = Array.isArray(state.finalData) ? state.finalData.length : 0;

  if (err) {
    if ((state.retryCount || 0) < 3) return "error_recovery";
    return "generate_answer";
  }
  if (rows === 0 && !state.zeroRowsRetried) {
    // Ran OK but no rows — try once to widen/relax
    return "zero_rows_recovery";
  }
  return "generate_answer";
}

function routeAfterZeroRows(state) {
  // After widening, go back to re-execute (not re-generate — SQL already fixed)
  return "execute_sql";
}

/* ─────────────────────────────────────────────────────────────────────────────
   GRAPH CONSTRUCTION
   ───────────────────────────────────────────────────────────────────────────── */
function buildGraph(pool, llmSQL, llmAnswer) {
  const graph = new StateGraph(AgentState);

  graph.addNode("pre_flight_gate",    makePreFlightGate());
  graph.addNode("retrieve_context",   makeRetrieveContext());
  graph.addNode("resolve_intent",          makeResolveIntent(llmSQL));
  graph.addNode("discover_column_values",  makeDiscoverColumnValues(pool));
  graph.addNode("compile_sql_from_intent", makeCompileSqlFromIntent());
  graph.addNode("generate_sql",            makeGenerateSQL(llmSQL));
  graph.addNode("check_sql",          makeCheckSQL(llmSQL));
  graph.addNode("execute_sql",        makeExecuteSQL(pool));
  graph.addNode("error_recovery",     makeErrorRecovery(llmSQL));
  graph.addNode("zero_rows_recovery", makeZeroRowsRecovery(llmSQL, pool));
  graph.addNode("generate_answer",    makeGenerateAnswer(llmAnswer));
  graph.addNode("verify_answer",      makeVerifyAnswer(llmAnswer));

  graph.addEdge(START, "pre_flight_gate");
  graph.addConditionalEdges("pre_flight_gate", routeAfterPreFlight, {
    generate_answer: "generate_answer",
    execute_sql: "execute_sql",
    retrieve_context: "retrieve_context",
  });
  graph.addEdge("retrieve_context", "resolve_intent");
  graph.addEdge("resolve_intent", "discover_column_values");
  graph.addEdge("discover_column_values", "compile_sql_from_intent");
  graph.addEdge("compile_sql_from_intent", "generate_sql");
  graph.addEdge("generate_sql", "check_sql");
  graph.addConditionalEdges("check_sql", routeAfterCheckSql, {
    error_recovery: "error_recovery",
    execute_sql: "execute_sql",
    generate_answer: "generate_answer",
  });

  // Conditional routing after execute
  graph.addConditionalEdges("execute_sql", routeAfterExecute, {
    error_recovery:    "error_recovery",
    zero_rows_recovery:"zero_rows_recovery",
    generate_answer:   "generate_answer",
  });

  // Error recovery re-validates SQL before execute
  graph.addEdge("error_recovery", "check_sql");

  // Zero-rows recovery loops back to execute (SQL was already rewritten)
  graph.addConditionalEdges("zero_rows_recovery", routeAfterZeroRows, {
    execute_sql: "execute_sql",
  });

  // Final pipeline
  graph.addEdge("generate_answer", "verify_answer");
  graph.addEdge("verify_answer",   END);

  return graph.compile();
}

/* ─────────────────────────────────────────────────────────────────────────────
   EXPORTED ENTRY POINT
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Run the full LangGraph SQL pipeline.
 *
 * Improvements over raw agentic loop:
 *  • temperature=0 for SQL generation/checking — no hallucinated column names
 *  • temperature=0.2 for answer — natural but grounded
 *  • Schema dynamically filtered to only relevant views (discover_views node)
 *  • Sample data injected so LLM sees real date formats / value ranges
 *  • 3-retry error recovery with cumulative error memory
 *  • Zero-rows recovery (widening filter) runs once before giving up
 *  • verify_answer cross-checks numbers against raw data
 *
 * @param {object} opts
 * @param {string} [opts.apiKey]       OpenAI API key (used when provider=openai)
 * @param {string} [opts.model]        Model id override (default: env OPENAI_MODEL / ANTHROPIC_MODEL)
 * @param {string} [opts.provider]     "openai" (default) | "claude" — which AI provider to use
 * @param {string} [opts.claudeApiKey] Anthropic API key (used when provider=claude)
 * @param {string} opts.question       Natural-language question
 * @param {object} opts.pool           mssql connection pool
 * @param {string} [opts.dateContext]  Pre-built date context string (FY dates etc.)
 * @param {object} [opts.userDateRange] { from, to } explicit date range
 * @param {string} [opts.tableHint]    Force-prefer a specific view/table
 * @returns {{ data, sql, answer, confidence, confidenceNote, retryCount, provider }}
 */
async function runLangChainQuery({
  apiKey,
  model,
  provider,
  claudeApiKey,
  question,
  pool,
  dateContext,
  userDateRange,
  tableHint,
  conversationHistory,
}) {
  const useProvider = normalizeProvider(provider);
  const { llmSQL, llmAnswer, model: activeModel } = createLangChainPair({
    provider: useProvider,
    apiKey,
    claudeApiKey,
    model,
  });

  const app = buildGraph(pool, llmSQL, llmAnswer);

  const initialState = {
    aiProvider:          useProvider,
    question:            String(question || ""),
    dateContext:         String(dateContext || ""),
    tableHint:           tableHint || null,
    userDateRange:       userDateRange || {},
    conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
  };

  console.log("[langchain] starting graph for:", question.slice(0, 80));

  let result;
  try {
    result = await app.invoke(initialState);
  } catch (graphErr) {
    console.error("[langchain] graph error:", graphErr.message);
    throw graphErr;
  }

  console.log(
    "[langchain] graph complete — rows:", (result.finalData || []).length,
    "confidence:", result.confidence,
    "retries:", result.retryCount
  );

  const clarificationNeeded =
    result.nextStep === "PROMPT_USER_FOR_CLARIFICATION" ||
    Boolean(result.clarificationMessage && !result.finalSQL && !(result.finalData || []).length);

  return {
    data: result.finalData || [],
    sql: result.finalSQL || result.fastPathSql || result.checkedSQL || null,
    answer: result.finalAnswer || "",
    confidence: result.confidence || "medium",
    confidenceNote: result.confidenceNote || "",
    retryCount: result.retryCount || 0,
    nodeLog: result.nodeLog || [],
    clarificationNeeded,
    clarificationQuestion: result.clarificationMessage || null,
    clarificationOptions: result.clarificationOptions || [],
    suggestedOptions: result.suggestedOptions || [],
    uiType: result.uiType || null,
    status: clarificationNeeded ? "CLARIFICATION_REQUIRED" : "SUCCESS",
    mode: result.nextStep === "FAST_PATH" ? "fast_path" : clarificationNeeded ? "clarification" : "langgraph",
    fastPath: result.nextStep === "FAST_PATH",
    targetView: result.targetView || null,
    clarityScore: result.clarityScore ?? null,
    preFlightMs: result.preFlightMs ?? null,
    originalQuestion: result.originalQuestion || null,
    adaptiveEnrichment: result.adaptiveEnrichment || null,
    provider: useProvider,
    model: activeModel,
  };
}

/**
 * Lightweight gateway-only SQL path (tests / direct orchestration without full graph).
 */
async function runOrchestratedAnalyticsQuery(pool, userQuestion, requestedProvider) {
  const provider = normalizeProvider(requestedProvider);
  const layer = require("./metadata/semantic-layer.json");
  const view = layer.target_view || getCanonicalSalesContext().table;
  const q = String(userQuestion || "").toLowerCase();

  let activeColumn = null;
  for (const [keyword, dim] of Object.entries(layer.semantic_mappings?.dimensions || {})) {
    if (q.includes(String(keyword).toLowerCase())) {
      activeColumn = dim.canonical_column;
      break;
    }
  }

  let samples = {};
  if (pool && userQuestion) {
    try {
      const sampled = await sampleValuesForQuestion(pool, userQuestion, view);
      samples = flattenSamplesForPrompt(sampled?.samples || {});
    } catch (e) {
      console.warn("[orchestrator] value sampling skipped:", e.message);
    }
  }

  const systemPrompt = buildClaudeDynamicPrompt({
    targetView: view,
    realDatabaseValueSamples: samples,
    activeDimension: activeColumn,
  });

  const raw = await invokeUnifiedGateway(
    provider,
    systemPrompt,
    `Compile this user data request: "${userQuestion}"`,
    false
  );

  const sql = remapLegacyColumnNames(extractSQL(raw));
  console.log(`[orchestrator] ${provider} SQL:\n${sql}`);
  return sql;
}

module.exports = { runLangChainQuery, runOrchestratedAnalyticsQuery };
