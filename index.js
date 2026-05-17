require("dotenv").config({ quiet: true });
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");
const fs = require("fs");
const http = require("http");
const express = require("express");
const compression = require("compression");
const sql = require("mssql");
const cors = require("cors");
const rootDir = __dirname;
const { google } = require("googleapis");
const {
  DATASET_REGISTRY,
  DATASET_KEYS,
} = require(path.join(rootDir, "datasets-registry"));
const {
  buildSchemaCatalog,
  nlToSelectSql,
  finalizeGeneratedSelectSql,
  buildAiValidationContext,
  inferAiDomain,
  adaptiveSummaryEnabled,
  summarizeAdaptiveResult,
  analyzeDataResult,
  classifyQueryIntent,
  validateResultContract,
  tagColumns,
  generateDrillDownSuggestions,
  filterDrillDownSuggestionsVerified,
} = require("./ai-sql");
const { runAgenticQuery } = require("./ai-agentic-query");
const { runLangChainQuery } = require("./ai-langchain-query");
const {
  buildAiSalesFactPromptBlock,
  isSalesDomainQuestion,
} = require(path.join(rootDir, "services", "canonical-sales-sql"));
const ragStore         = require("./services/rag-store");
const ragFastPath      = require("./services/rag-fast-path");
const asyncExport      = require("./services/async-export");
const {
  detectExportIntent,
  isBroadListQuestion,
  PERFORMANCE_MANDATE,
} = require("./services/query-performance");
const ragSchemaIndexer = require("./services/rag-schema-indexer");
const { seedOnStartup: seedRagKnowledge } = require("./services/semantic-seeder");
const { runDeterministicQuery, chartPolicyFromResultShape } = require("./services/deterministic-ai");
const {
  prepareQuestionForPipeline,
  toAdaptiveClarificationResponse,
} = require("./services/user-guidance");
const { indexIsStale } = require("./services/dimension-index");
const { parseQuery, buildIntentConstraints, chartPolicyFromIntent } = require("./services/semantic-parser");
const { tagColumnsByValues, detectResultShape } = require("./services/data-shape-analyzer");
const { initMCPClient } = require("./services/mcp-client");

/** Normalize intent for API/dashboard (legacy names + period_dashboard vs KPI/breakdown/top-N). */
function reconcileIntentTypeForResponse(question, intentTypeIn, data) {
  const q = String(question || "").toLowerCase();
  const rows = Array.isArray(data) ? data : [];
  let t = String(intentTypeIn || "generic");
  if (t === "ranking") t = "top_n";
  if (t === "distribution") t = "breakdown";

  const hasTop = /\btop\s+\d+\b/i.test(q);
  const dimBreakdown =
    /\b(breakdown|by\s+branch|by\s+category|by\s+dept\b|by\s+department|by\s+product)\b/i.test(q) ||
    /\bsales\s+breakdown\b/i.test(q);

  if (hasTop && (t === "kpi" || t === "period_dashboard" || t === "generic")) t = "top_n";
  if (t === "period_dashboard" && dimBreakdown) t = "breakdown";

  const moneyKpi =
    /\b(total|sum|overall)\b/.test(q) &&
    /\b(sales|revenue|amount|invoice|transaction)\b/.test(q) &&
    !/\b(trend|vs\b|compare|daily|monthly\s+trend)\b/.test(q);
  const quantityKpi =
    /\b(total|sum|overall)\b/.test(q) &&
    /\b(quantity|qty|units?)\b/.test(q) &&
    /\b(month\s+to\s+date|mtd|today|ytd|qtd|this\s+month|last\s+30)\b/.test(q);
  const looksLikeKpi =
    rows.length >= 1 &&
    rows.length <= 3 &&
    !hasTop &&
    !dimBreakdown &&
    (moneyKpi || quantityKpi);

  if ((t === "period_dashboard" || t === "generic") && looksLikeKpi) t = "kpi";

  return t;
}

/** Prefer line chart for explicit monthly/daily trend questions when shape heuristic picked bar. */
function preferChartForTrendQuestion(question, intentType, chartPolicyIn) {
  if (String(intentType || "") !== "trend") return chartPolicyIn;
  if (chartPolicyIn !== "bar") return chartPolicyIn;
  const q = String(question || "").toLowerCase();
  if (/\b(monthly|daily|weekly)\b/.test(q) && /\btrend\b/.test(q)) return "line";
  return chartPolicyIn;
}

/** Optional follow-up chips for Sheets sidebar + dashboard; bounded latency. */
async function maybeDrillDownSuggestions({ apiKey, model, question, data, intentType, tableHint }) {
  const off = /^(0|false|no)$/i.test(String(process.env.ADAPTIVE_DRILL_SUGGESTIONS ?? "1").trim());
  if (off) return [];
  if (!Array.isArray(data) || data.length === 0) return [];
  const timeoutMs = Math.max(
    2000,
    Math.min(25000, Number(process.env.ADAPTIVE_DRILL_SUGGESTIONS_TIMEOUT_MS) || 10000)
  );
  try {
    const raw = await Promise.race([
      generateDrillDownSuggestions({
        apiKey: String(apiKey).trim(),
        model,
        question,
        data,
        intentType,
      }),
      new Promise((resolve) => {
        setTimeout(() => resolve([]), timeoutMs);
      }),
    ]);
    return filterDrillDownSuggestionsVerified({
      question,
      tableHint,
      suggestions: Array.isArray(raw) ? raw : [],
    });
  } catch (e) {
    console.warn("[adaptive] drillDownSuggestions:", e.message);
    return [];
  }
}

/**
 * If RAG has a verified example for this question, run its SQL directly (no LLM).
 * @returns {Promise<boolean>} true when response was sent
 */
function respondAsyncExport(res, { question, sql, pool, userId }) {
  const queued = asyncExport.queueExportJob({
    pool,
    sql,
    question,
    userId: userId || null,
  });
  return res.json({
    sql,
    rowCount: 0,
    data: [],
    mode: "async_export",
    asyncExport: {
      jobId: queued.jobId,
      status: queued.status,
      maxRows: queued.maxRows,
      statusUrl: `/api/query/export-async/${queued.jobId}`,
      downloadUrl: `/api/query/export-async/${queued.jobId}/download`,
    },
    summary:
      "Raw export queued in the background. Open the status URL to download the CSV when ready (large extracts are never loaded into chat).",
    intentType: "export",
    intentDescription: "Background CSV export — server streams rows to file",
    chartPolicy: "table",
    dataSource: "async_export",
    contractPassed: true,
    contractIssues: [],
    contractWarnings: [],
    columnTags: {},
    confidence: "high",
    confidenceNote: "Export runs outside the 180s chat timeout.",
    retryCount: 0,
  });
}

async function tryRagVerifiedFastPath(res, { question, pool, fromDate, toDate, tableHint, apiKey, model, userId }) {
  if (!ragFastPath.isFastPathEnabled()) return false;
  if (ragFastPath.shouldSkipForDatePicker(fromDate, toDate)) return false;

  let hit;
  try {
    hit = await ragFastPath.resolveVerifiedExample(question);
  } catch (e) {
    console.warn("[adaptive] RAG fast-path lookup failed:", e.message);
    return false;
  }
  if (!hit) return false;

  if (detectExportIntent(question)) {
    respondAsyncExport(res, { question, sql: hit.sql, pool, userId });
    return true;
  }

  try {
    const { execSql, rows } = await ragFastPath.executeVerifiedSql(pool, hit.sql);
    const data = rowsForJson(rows);
    const tags = tagColumnsByValues(data);
    const intent = classifyQueryIntent(question);
    const shape = detectResultShape(data, tags);
    const intentType = reconcileIntentTypeForResponse(question, intent.type, data);
    const chartPolicyBase = shape.chartType || intent.chartPolicy || "auto";
    const chartPolicy = preferChartForTrendQuestion(question, intentType, chartPolicyBase);
    const drillDownSuggestions = await maybeDrillDownSuggestions({
      apiKey: String(apiKey).trim(),
      model,
      question,
      data,
      intentType,
      tableHint,
    });
    const matchLabel = hit.match === "semantic" ? `semantic ${(hit.score * 100).toFixed(0)}%` : "exact";
    console.log(`[adaptive] RAG fast-path (${matchLabel}) id=${hit.id}`);
    res.json({
      sql: execSql,
      rowCount: data.length,
      data,
      mode: "rag_verified",
      ragExampleId: hit.id,
      ragMatch: hit.match,
      tableHint: tableHint || null,
      summary: null,
      intentType,
      intentDescription: `Verified RAG example (${matchLabel}) — executed stored SQL, skipped AI generation`,
      chartPolicy,
      resultShape: shape.shape,
      dataSource: "rag_verified",
      contractPassed: data.length > 0,
      contractIssues: data.length === 0 ? ["No rows returned"] : [],
      contractWarnings: [],
      columnTags: tags,
      confidence: "high",
      confidenceNote:
        `Used approved RAG SQL for: "${hit.question}". ` +
        "Switch to LangGraph only when you need a new question variant.",
      retryCount: 0,
    });
    return true;
  } catch (err) {
    console.warn("[adaptive] RAG fast-path execution failed, continuing pipeline:", err.message);
    return false;
  }
}

/** Vendor purchase top-N and other always-on templates (runs before RAG/LangGraph). */
async function tryDeterministicFastPatterns(res, { question, pool, fromDate, toDate, apiKey, model, tableHint }) {
  try {
    const deterministic = await runDeterministicQuery({
      apiKey: String(apiKey || "").trim(),
      model,
      question,
      pool,
      fromDate,
      toDate,
    });
    if (!deterministic?.handled) return false;

    const data = rowsForJson(deterministic.data || []);
    const tags = tagColumnsByValues(data);
    const intentType = reconcileIntentTypeForResponse(
      question,
      String(deterministic.intent?.intent || "generic"),
      data
    );
    const shapeChart = chartPolicyFromResultShape(data);
    const chartPolicyBase =
      shapeChart !== "table"
        ? shapeChart
        : deterministic.chartPolicy ||
          (intentType === "trend"
            ? "line"
            : intentType === "top_n" || intentType === "breakdown"
              ? "bar"
              : intentType === "kpi"
                ? "kpi_card"
                : "auto");
    const chartPolicy = preferChartForTrendQuestion(question, intentType, chartPolicyBase);
    const drillDownSuggestions = await maybeDrillDownSuggestions({
      apiKey: String(apiKey || "").trim(),
      model,
      question,
      data,
      intentType,
      tableHint,
    });
    res.json({
      sql: deterministic.sql,
      rowCount: data.length,
      data,
      mode: "deterministic_fast",
      tableHint: tableHint || null,
      summary: deterministic.summary || null,
      intentType,
      intentDescription: `Fast template (${deterministic.reliability?.reason || "pattern_match"}) — skipped LLM SQL generation`,
      chartPolicy,
      resultShape: detectResultShape(data, tags).shape,
      dataSource: "full_aggregate",
      contractPassed: data.length > 0,
      contractIssues: data.length === 0 ? ["No rows returned"] : [],
      contractWarnings: [],
      columnTags: tags,
      confidence: deterministic.confidence?.level || (data.length ? "high" : "medium"),
      confidenceNote: deterministic.confidence?.note || "",
      retryCount: 0,
      interpretation: deterministic.interpretation || null,
      drillDownSuggestions,
    });
    return true;
  } catch (e) {
    console.warn("[adaptive] deterministic fast-pattern skipped:", e.message);
    return false;
  }
}

const { buildSchemaDocFromDb } = require(path.join(rootDir, "ai-schema-introspect"));
const {
  getMirrorUrl,
  isMirrorReadEnabled,
  mirrorFallbackToLive,
  loadMirrorSnapshotRows,
  listMirrorSnapshotMeta,
  filterMirrorRows,
} = require(path.join(rootDir, "mirror-read"));
const {
  getDatasetEntry,
  getFilterColumns,
  getFilterMatchMode,
  sanitizeColumnName,
  datasetDateOrderByDescSql,
} = require(path.join(rootDir, "filter-query"));
const rbac = require("./rbac");
const auth = require("./auth");
const {
  httpMetricsMiddleware,
  recordDataFreshnessFromPayload,
  getSnapshot,
} = require("./services/observability-kpis");
const { logger } = require("./services/logger");
const { connectWithRetries } = require("./services/db-resilience");
const {
  requestIdMiddleware,
  buildApiRateLimiter,
  httpAccessLogMiddleware,
} = require("./services/production-middleware");
const { appendDatasetFilterWhere } = require("./services/dataset-where");
const {
  runAnalyticsDashboard,
  scheduleAnalyticsWarmup,
  bumpDataEpoch,
  getDataEpoch,
} = require("./services/analytics-dashboard");
const {
  registerAnalyticsSse,
  unregisterAnalyticsSse,
} = require("./services/analytics-cache");
const { shapeAnalyticsResponse, sendJsonOrMsgpack } = require("./services/api-response-optimize");
const {
  buildDrillQueryObject,
  resolveDatasetTable: resolveDrillDatasetTable,
} = require("./services/analytics-drillthrough");
const {
  executeDatasetQueryWithReliability,
  executeWithSqlRetryBundle,
} = require("./services/query-reliability");
const {
  resolveAnalyticsDateCol,
  salesDimColumns,
  buildKpiSelectSql,
} = require("./services/analytics-sql-context");
const { DEFAULT_ANALYTICS_TABLE } = require("./services/analytics-column-map");

const SCHEMA_CATALOG_FALLBACK = buildSchemaCatalog(DATASET_REGISTRY);
const SEMANTIC_DICTIONARY_PATH = path.join(rootDir, "metadata", "semantic_dictionary.json");

/** DB errors that warrant one LLM regeneration pass (adaptive + simple AI route). */
function isRetryableAiSqlError(msg) {
  return /invalid column name|operand type clash|conversion failed|is incompatible with|cannot convert|ambiguous column name|incorrect syntax/i.test(
    String(msg || "")
  );
}

/** Rich prompt text: live columns from DB when introspection succeeds */
let aiSchemaContextCache = null;
let aiSchemaContextPromise = null;

async function ensureAiSchemaContext(pool) {
  if (process.env.AI_SCHEMA_DISABLE === "1" || process.env.AI_SCHEMA_DISABLE === "true") {
    return SCHEMA_CATALOG_FALLBACK;
  }
  if (aiSchemaContextCache) {
    return aiSchemaContextCache;
  }
  if (!aiSchemaContextPromise) {
    const maxTables = parseInt(process.env.AI_SCHEMA_MAX_TABLES || "18", 10);
    aiSchemaContextPromise = buildSchemaDocFromDb(pool, DATASET_REGISTRY, { maxTables })
      .then((doc) => {
        const trimmed = doc && String(doc).trim();
        aiSchemaContextCache = trimmed
          ? `${trimmed}\n\n---\nDataset catalog (keys for routing; columns above win):\n${SCHEMA_CATALOG_FALLBACK}`
          : SCHEMA_CATALOG_FALLBACK;
        return aiSchemaContextCache;
      })
      .catch((err) => {
        console.warn("[ai-schema] introspection failed, using catalog only:", err.message);
        aiSchemaContextCache = SCHEMA_CATALOG_FALLBACK;
        return aiSchemaContextCache;
      });
  }
  return aiSchemaContextPromise;
}

/**
 * Purchase/vendor questions: prepend live columns for PowerBI/supplier views (they are beyond AI_SCHEMA_MAX_TABLES in the registry order).
 */
function inferKeywordTableHints(question) {
  const q = String(question || "").toLowerCase();
  const out = [];
  const add = (t) => {
    if (t && !out.includes(t)) {
      out.push(t);
    }
  };

  // ── Purchase / vendor / supplier ──────────────────────────────────────────
  if (
    /\b(purchase|purchases|purchasing|vendor|vendors|supplier|suppliers|procurement|grn|payable|po\b)\b/.test(q)
  ) {
    add("dbo.VW_MB_POWERBI_PUR_REPORT");
    add("dbo.VW_MB_POWERBI_SUPPLIER_PUR_REPORT");
    add("dbo.VwAISupplier");
  }

  // ── Product / item names with sales ───────────────────────────────────────
  if (/\b(product|products|item|items|sku|article)\b/.test(q)) {
    add("dbo.VwAISalesData");
    add("dbo.VwMstItems");
    add("dbo.VwAIMstItems");
  }

  // ── Customer details ───────────────────────────────────────────────────────
  if (/\b(customer|customers|buyer|buyers|client|clients)\b/.test(q)) {
    add("dbo.VwAISalesData");
    add("dbo.VwAICustomerDetails");
  }

  // ── Branch-level queries (all types) ──────────────────────────────────────
  if (/\b(branch|branches|store|stores|outlet|outlets)\b/.test(q)) {
    add("dbo.VwAIBranch");
    // Zero / no sales branches need both branch master and sales
    if (/\b(zero|no sales|without sales|didn'?t sell|no transaction|inactive)\b/.test(q)) {
      add("dbo.VwAISalesData");
    }
    // Branch sales summary
    if (/\b(sales|revenue|amount|total|performance)\b/.test(q)) {
      add("dbo.VwAISalesData");
    }
  }

  // ── Salesperson / sales rep performance ───────────────────────────────────
  if (/\b(salesperson|sales person|sales rep|salesrep|rep|agent)\b/.test(q) &&
      /\b(revenue|sales|highest|top|best|performance|ranking)\b/.test(q)) {
    add("dbo.VwAISalesData");
    add("dbo.VwAISalesPerson");
  }

  // ── Stock / inventory ─────────────────────────────────────────────────────
  if (/\b(stock|inventory|reorder|restock)\b/.test(q)) {
    add("dbo.VwAIStockData");
  }

  // ── Category / department breakdown ───────────────────────────────────────
  if (/\b(category|subcategory|department|division|segment)\b/.test(q)) {
    add("dbo.VwMstItems");
    add("dbo.VwAIMstItems");
    add("dbo.VwAISalesData");
  }

  // ── Date-based sales queries (today/yesterday/this week/month/year/last N days) ─
  const isDateQuery = /\b(today|yesterday|this\s*week|last\s*week|this\s*month|last\s*month|this\s*year|last\s*year|this\s*quarter|last\s*\d+\s*days?|daily|weekly|monthly|yearly|annual)\b/.test(q);
  const isSalesContext = /\b(sale|sales|invoice|transaction|revenue|amount|order|bill)\b/.test(q);
  if (isDateQuery && isSalesContext) {
    add("dbo.VwAISalesData");
  }

  // ── General sales / invoices / transactions ────────────────────────────────
  if (/\b(transaction|transactions|invoice|invoices|bill|bills|order|orders)\b/.test(q) &&
      !/\b(purchase|vendor|supplier)\b/.test(q)) {
    add("dbo.VwAISalesData");
  }

  // ── Sales trend / time-series ─────────────────────────────────────────────
  if (/\b(trend|monthly trend|daily trend|weekly trend|yoy|mom|year.on.year|month.on.month)\b/.test(q) &&
      /\b(sales|revenue|amount)\b/.test(q)) {
    add("dbo.VwAISalesData");
  }

  // ── Average order value ────────────────────────────────────────────────────
  if (/\b(average order value|aov|avg order|average basket)\b/.test(q)) {
    add("dbo.VwAISalesData");
  }

  // ── Top N anything sales-related ──────────────────────────────────────────
  if (/\b(top\s*\d+|highest|best performing|top selling|most sold)\b/.test(q) &&
      /\b(sales|revenue|amount|product|customer|branch|salesperson)\b/.test(q) &&
      !/\b(purchase|vendor|supplier)\b/.test(q)) {
    add("dbo.VwAISalesData");
  }

  return out;
}

/**
 * Returns a short server-side date context string injected into agentic system prompts.
 */
function buildDateContext() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const yr = now.getFullYear();
  const mo = now.getMonth(); // 0=Jan … 11=Dec
  const dateStr = `${yr}-${pad(mo + 1)}-${pad(now.getDate())}`;
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  // Indian FY: Apr 1 – Mar 31
  const fyStartYear = mo >= 3 ? yr : yr - 1;
  const fyLabel = `FY${String(fyStartYear).slice(-2)}-${String(fyStartYear + 1).slice(-2)}`;
  const fyStart = `${fyStartYear}-04-01`;

  // Current Indian FY quarter
  let currentQ, qStart, qEnd;
  if      (mo >= 9)  { currentQ = "Q3"; qStart = `${yr}-10-01`; qEnd = `${yr}-12-31`; }
  else if (mo >= 6)  { currentQ = "Q2"; qStart = `${yr}-07-01`; qEnd = `${yr}-09-30`; }
  else if (mo >= 3)  { currentQ = "Q1"; qStart = `${yr}-04-01`; qEnd = `${yr}-06-30`; }
  else               { currentQ = "Q4"; qStart = `${yr}-01-01`; qEnd = `${yr}-03-31`; }

  return (
    `\n[SERVER DATE CONTEXT]\n` +
    `Today: ${dateStr} (${days[now.getDay()]})\n` +
    `Current month: ${months[mo]} ${yr}\n` +
    `Current financial year (Apr–Mar): ${fyLabel}\n` +
    `Indian FY quarters: Q1=Apr–Jun | Q2=Jul–Sep | Q3=Oct–Dec | Q4=Jan–Mar\n` +
    `Current quarter: ${currentQ} (${qStart} to ${qEnd})\n` +
    `YTD (financial year-to-date) start: ${fyStart}\n` +
    `Use GETDATE() in SQL for all dynamic date arithmetic — never hardcode dates.`
  );
}

/**
 * Converts ambiguous business questions into stricter intent guidance.
 * This text is appended to the user question so model picks better joins/metrics.
 */
function buildIntentGuidance(question) {
  const q = String(question || "").toLowerCase();
  const lines = [];
  const has = (re) => re.test(q);

  if (isSalesDomainQuestion(question)) {
    lines.push(buildAiSalesFactPromptBlock());
  }

  lines.push(PERFORMANCE_MANDATE.trim());
  if (isBroadListQuestion(question)) {
    lines.push(
      "- User asked for a broad list — you MUST aggregate (GROUP BY month/branch/category/supplier) with SUM/COUNT; do NOT return raw line items without TOP."
    );
  }
  if (detectExportIntent(question)) {
    lines.push(
      "- User wants a raw EXPORT — still write valid filtered SQL with a date range; chat will queue a background CSV (not millions of rows in the response)."
    );
  }

  // ── Product / item names ────────────────────────────────────────────────
  if (has(/\b(product|products|item|items|sku|article)\b/) && has(/\b(sales|revenue|amount|top|highest|rank|best)\b/)) {
    lines.push(
      "- Return readable product/item name (Description, ArticleShortName, ItemName, ItemCode) by joining the item master on ItemId. Do NOT return only ItemId.",
      "- Use dbo.VW_MB_POWERBI_APP_REPORT or another allowlisted Power BI view from schema; ArticleNo is on APP_REPORT.",
      "  ❌ NEVER use dbo.VwAISalesData or dbo.VwMstItems-only FROM for sales ranking.",
      "- Use ISNULL(i.<name_col>, 'Unknown') AS ProductName where <name_col> is the real column from the schema (e.g. Description, ArticleShortName).",
      "- Use GROUP BY i.<name_col> and ORDER BY TotalSales DESC to get the correct ranking."
    );
  }

  // ── Customer ranking ────────────────────────────────────────────────────
  if (has(/\b(customer|customers|buyer|buyers|client)\b/) && has(/\b(top|highest|sales|amount|revenue|value|ranking)\b/)) {
    lines.push(
      "- For customer ranking: aggregate SaleNetAmount by CustomerId/CustomerName. Include customer name/details from customer master view when available."
    );
  }

  // ── Vendor / supplier purchase ranking ─────────────────────────────────
  if (has(/\b(vendor|supplier)\b/) && has(/\b(top|highest|amount|value|report|purchase|ranking)\b/)) {
    lines.push(
      "- For vendor purchase ranking: use the amount/value/net-cost column from the purchase view, NOT the quantity column. Only use quantity if user explicitly asks for it."
    );
  }

  // ── Average order value ─────────────────────────────────────────────────
  if (has(/\b(average order value|aov|avg order|average basket|average.*order|order.*average)\b/)) {
    const byBranch = has(/\bbranch(es)?\b/);
    if (byBranch) {
      lines.push(
        "- Average order value BY BRANCH requires TWO steps:",
        "  Step 1: SUM(SaleNetAmount) per InvoiceId AND per branch — group by both in an inner subquery on dbo.VwAISalesData.",
        "  Step 2: JOIN that subquery with dbo.VwAIBranch using the shared branch key column (find it in the FOCUSED TABLE blocks for both views — it is the column that appears in both lists).",
        "  Step 3: AVG the per-invoice totals, GROUP BY BranchName.",
        "  ❌ Do NOT use AVG(SaleNetAmount) directly — it averages line items, not orders.",
        "  ❌ NEVER assume the branch join key is 'BranchId' — read both column lists from the schema."
      );
    } else {
      lines.push(
        "- For average order value: two-step from dbo.VwAISalesData.",
        "  Step 1: SUM(SaleNetAmount) per InvoiceId (and per group-by dimension) in an inner subquery.",
        "  Step 2: AVG those per-invoice totals, GROUP BY the dimension.",
        "  ❌ Do NOT use AVG(SaleNetAmount) directly — it averages line items, not orders."
      );
    }
  }

  // ── Zero / no sales branches ────────────────────────────────────────────
  if (has(/\b(zero sales|no sales|without sales|inactive branch|didn'?t sell)\b/) && has(/\b(branch|branches|store|outlet)\b/)) {
    lines.push(
      "- For zero-sales branches: SELECT all branches from the branch master view, LEFT JOIN sales data for the date window, then WHERE the sales join key IS NULL (or HAVING COUNT(sales)=0)."
    );
  }

  // ── Date-scoped: today ───────────────────────────────────────────────────
  if (has(/\btoday('?s?)?\b/)) {
    lines.push(
      "- For today's data: WHERE DateCol >= CAST(GETDATE() AS DATE) AND DateCol < DATEADD(day,1,CAST(GETDATE() AS DATE)). Replace DateCol with the exact date column from the focused schema."
    );
  }

  // ── Date-scoped: yesterday ──────────────────────────────────────────────
  if (has(/\byesterday('?s?)?\b/)) {
    lines.push(
      "- For yesterday's data: WHERE DateCol >= DATEADD(day,-1,CAST(GETDATE() AS DATE)) AND DateCol < CAST(GETDATE() AS DATE)."
    );
  }

  // ── Date-scoped: last N days ─────────────────────────────────────────────
  const lastNMatch = q.match(/\blast\s*(\d+)\s*days?\b/);
  if (lastNMatch) {
    lines.push(
      `- For last ${lastNMatch[1]} days: WHERE DateCol >= DATEADD(day,-${lastNMatch[1]},CAST(GETDATE() AS DATE)). NEVER subtract integers from dates with "-".`
    );
  }

  // ── Date-scoped: this week / last 7 days ────────────────────────────────
  if (has(/\b(this\s*week|last\s*7\s*days?|last seven)\b/)) {
    lines.push(
      "- For this week / last 7 days: WHERE DateCol >= DATEADD(day,-7,CAST(GETDATE() AS DATE))."
    );
  }

  // ── Date-scoped: this month ──────────────────────────────────────────────
  if (has(/\bthis\s*month\b/)) {
    lines.push(
      "- For this month: WHERE YEAR(DateCol)=YEAR(GETDATE()) AND MONTH(DateCol)=MONTH(GETDATE())."
    );
  }

  // ── Date-scoped: last month ──────────────────────────────────────────────
  if (has(/\blast\s*month\b/)) {
    lines.push(
      "- For last month: WHERE YEAR(DateCol)=YEAR(DATEADD(month,-1,GETDATE())) AND MONTH(DateCol)=MONTH(DATEADD(month,-1,GETDATE()))."
    );
  }

  // ── Date-scoped: this year ───────────────────────────────────────────────
  if (has(/\bthis\s*year\b/)) {
    lines.push(
      "- For this year: WHERE YEAR(DateCol)=YEAR(GETDATE())."
    );
  }

  // ── Date-scoped: last year ───────────────────────────────────────────────
  if (has(/\blast\s*year\b/)) {
    lines.push(
      "- For last year: WHERE YEAR(DateCol)=YEAR(GETDATE())-1."
    );
  }

  // ── Date-scoped: this quarter (Indian FY) ───────────────────────────────
  if (has(/\b(this\s*quarter|current\s*quarter|qtd|quarter.to.date)\b/)) {
    lines.push(
      "- Indian FY quarters: Q1=Apr–Jun, Q2=Jul–Sep, Q3=Oct–Dec, Q4=Jan–Mar.",
      "- Do NOT use DATEDIFF(quarter,...) — it uses calendar quarters, not Indian FY.",
      "- The [SERVER DATE CONTEXT] block shows the exact current quarter and its start/end dates — use those directly.",
      "- For QTD: WHERE CAST(DateCol AS date) >= '<qStart from context>' AND CAST(DateCol AS date) <= CAST(GETDATE() AS date)."
    );
  }

  // ── Date-scoped: YTD / financial year to date ───────────────────────────
  if (has(/\b(ytd|year.to.date|financial.year|fy\s*\d*|year.*date)\b/)) {
    lines.push(
      "- Indian FY YTD starts April 1. The [SERVER DATE CONTEXT] block shows the exact YTD start date.",
      "- For YTD: WHERE CAST(DateCol AS date) >= '<fyStart from context>' AND CAST(DateCol AS date) <= CAST(GETDATE() AS date).",
      "- Do NOT use YEAR(DateCol)=YEAR(GETDATE()) — that is calendar year, not financial year."
    );
  }

  // ── Monthly trend / time-series ──────────────────────────────────────────
  if (has(/\b(monthly trend|sales trend|trend|monthly sales|month.by.month|over time)\b/)) {
    lines.push(
      "- For monthly trend: GROUP BY YEAR(DateCol), MONTH(DateCol) — or FORMAT(DateCol,'yyyy-MM') — and ORDER BY year/month ascending. Use TOP (N) only if the user asks for a limited range."
    );
  }

  // ── Salesperson performance ──────────────────────────────────────────────
  if (has(/\b(salesperson|sales rep|sales agent|staff)\b/) && has(/\b(top|highest|revenue|ranking|best|performance)\b/)) {
    lines.push(
      "- For salesperson/staff ranking: FROM dbo.VW_MB_POWERBI_APP_REPORT, GROUP BY SupplierName (or SupplierAlias), SUM(MrpValue) AS TotalSales, ORDER BY TotalSales DESC.",
      "  There is no SalesPerson column in the 28-view schema — do not use VwAISalesPerson."
    );
  }

  // ── Low stock ────────────────────────────────────────────────────────────
  if (has(/\b(low stock|low inventory|reorder|out of stock|less than|minimum stock)\b/)) {
    lines.push(
      "- For low stock: filter where the stock quantity column is less than the reorder/minimum level column, or less than the threshold the user specifies."
    );
  }

  // ── Branch performance comparison ───────────────────────────────────────
  if (has(/\b(branch|branches)\b/) && has(/\b(performance|comparison|compare|ranking|top|best)\b/)) {
    lines.push(
      "- For branch performance: FROM dbo.VW_MB_POWERBI_APP_REPORT, GROUP BY BranchAlias, SUM(MrpValue) AS TotalSales."
    );
  }

  // ── Customer birthday / anniversary queries ─────────────────────────────
  if (has(/\b(birthday|anniversary|bday)\b/)) {
    lines.push(
      "- Birthday/anniversary columns are in dbo.VwAICustomerDetails: BirthdayDt, AnniversaryDt.",
      "- ❌ NEVER filter by YEAR(BirthdayDt) — birthdays are year-independent. Use MONTH() only.",
      "  Example (this month's birthdays): WHERE MONTH(BirthdayDt) = MONTH(GETDATE())",
      "  Example (next month's birthdays): WHERE MONTH(BirthdayDt) = MONTH(DATEADD(month,1,GETDATE()))",
      "  Example (specific month Apr): WHERE MONTH(BirthdayDt) = 4",
      "- Return CustomerFirstName, CustomerLastName, BirthdayDt, ContactMobile, BranchName."
    );
  }

  // ── Customer credit limit ───────────────────────────────────────────────
  if (has(/\b(credit limit|creditlimit|credit)\b/) && has(/\b(customer|customers)\b/)) {
    lines.push(
      "- CreditLimit is a column in dbo.VwAICustomerDetails — it is a rupee amount, NOT divided by anything.",
      "- Return CustomerFirstName, CustomerLastName, CreditLimit, BranchName from VwAICustomerDetails."
    );
  }

  // ── Customer without purchases / inactive ──────────────────────────────
  if (has(/\b(customer|customers)\b/) && has(/\b(no purchase|not purchased|inactive|never bought|haven'?t bought)\b/)) {
    lines.push(
      "- For customers with no purchases: SELECT from dbo.VwAICustomerDetails LEFT JOIN dbo.VwAISalesData ON c.CustomerId = s.CustomerId. WHERE s.CustomerId IS NULL.",
      "- Add optional date window on the sales side (InvoiceDt) to find customers who haven't bought 'in the last X days'."
    );
  }

  // ── Multi-metric: two measures in the same chart ────────────────────────
  if (has(/\b(purchase.*sales?|sales?.*purchase|simultaneously|same.chart|together|both|vs\.?|versus|compar(e|ison))\b/)) {
    lines.push(
      "- For comparing two measures (e.g. sales + purchases, or revenue + cost) in one result:",
      "  Return a single result set where each ROW has a label column and TWO numeric columns, one per metric.",
      "  Example: SELECT <date/label> AS Period, SUM(s.SaleNetAmount) AS NetSales, SUM(p.PurNetAmount) AS Purchases FROM ... GROUP BY ...",
      "  Do NOT return two separate result sets. One SELECT (possibly with JOINs or subqueries) with multiple aggregate columns.",
      "- For period comparison (today vs last Monday vs last month): use UNION ALL with a Period label column:",
      "  SELECT 'Today' AS Period, SUM(SaleNetAmount) AS NetSales FROM ... WHERE <today>",
      "  UNION ALL SELECT 'Last Monday' AS Period, SUM(SaleNetAmount) AS NetSales FROM ... WHERE <last Monday>",
      "  UNION ALL SELECT 'Last Month MTD' AS Period, SUM(SaleNetAmount) AS NetSales FROM ... WHERE <same day range last month>",
      "  ORDER BY 1"
    );
  }

  // ── Period comparison (today vs X vs Y) ─────────────────────────────────
  if (has(/\b(today.*vs|vs.*today|yesterday.*vs|previous.*monday|last.*monday.*vs|period.*compar)\b/)) {
    lines.push(
      "- Period comparison: use UNION ALL with a 'Period' text column (e.g. 'Today', 'Last Monday', 'Last Month').",
      "  Each UNION branch should filter to its own date window and aggregate the same metric(s).",
      "  Alias the metric columns identically in every branch so UNION ALL works (e.g. all branches use 'NetSales').",
      "  ORDER BY the Period column or add a SortOrder INT column (1,2,3) so the chart shows left-to-right order."
    );
  }

  if (!lines.length) {
    return "";
  }
  return `\n\nIntent guidance (must follow):\n${lines.join("\n")}`;
}

/**
 * @param {import("mssql").ConnectionPool} pool
 * @param {string} schemaName
 * @param {string} objectName
 * @returns {Promise<string|null>}
 */
async function fetchFocusedColumnsMarkdown(pool, schemaName, objectName) {
  const sh = sanitizeIdentifier(schemaName);
  const tn = sanitizeIdentifier(objectName);
  if (!sh || !tn) {
    return null;
  }
  try {
    const colResult = await pool
      .request()
      .input("sch", sql.NVarChar(128), sh)
      .input("obj", sql.NVarChar(128), tn)
      .query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE,
               CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @sch AND TABLE_NAME = @obj
        ORDER BY ORDINAL_POSITION
      `);
    if (!colResult.recordset.length) {
      return null;
    }
    const colLines = colResult.recordset
      .map((c) => {
        let dt = c.DATA_TYPE || "unknown";
        if (c.CHARACTER_MAXIMUM_LENGTH && c.CHARACTER_MAXIMUM_LENGTH > 0) {
          dt += `(${c.CHARACTER_MAXIMUM_LENGTH === -1 ? "max" : c.CHARACTER_MAXIMUM_LENGTH})`;
        } else if (c.NUMERIC_PRECISION) {
          dt += `(${c.NUMERIC_PRECISION}${c.NUMERIC_SCALE ? "," + c.NUMERIC_SCALE : ""})`;
        }
        const nullable = String(c.IS_NULLABLE).toUpperCase() === "YES" ? " nullable" : "";
        return `  - ${c.COLUMN_NAME} (${dt}${nullable})`;
      })
      .join("\n");
    return `FOCUSED TABLE (use columns exactly as listed):\n[${sh}].[${tn}]\nColumns:\n${colLines}\n\nIMPORTANT: For SUM/aggregates, pick numeric columns from the list above only. Never use the name NetAmount unless it appears in the list. Prefer names containing Amount, Value, Amt, Cost, Qty, or Net as listed.`;
  } catch (e) {
    console.warn("[adaptive] focused columns failed:", sh, tn, e.message);
    return null;
  }
}

/**
 * @param {import("mssql").ConnectionPool} pool
 * @param {string} schemaContext
 * @param {string} question
 * @param {string} [tableHint] e.g. dbo.VwAISalesData from Explorer
 */
async function augmentSchemaWithFocusedTables(pool, schemaContext, question, tableHint) {
  const ordered = [];
  const push = (full) => {
    const t = String(full || "").trim();
    if (t && !ordered.includes(t)) {
      ordered.push(t);
    }
  };
  if (tableHint) {
    push(tableHint);
  }
  for (const h of inferKeywordTableHints(question)) {
    push(h);
  }
  const blocks = [];
  const seen = new Set();
  for (const full of ordered) {
    if (blocks.length >= 5) {
      break;
    }
    const parts = full.split(".");
    if (parts.length !== 2) {
      continue;
    }
    const k = `${parts[0]}.${parts[1]}`.toLowerCase();
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    const sh = sanitizeIdentifier(parts[0].replace(/[\[\]]/g, ""));
    const tn = sanitizeIdentifier(parts[1].replace(/[\[\]]/g, ""));
    if (!sh || !tn) {
      continue;
    }
    const block = await fetchFocusedColumnsMarkdown(pool, sh, tn);
    if (block) {
      blocks.push(block);
    }
  }
  if (!blocks.length) {
    return schemaContext;
  }
  return `${blocks.join("\n\n---\n\n")}\n\n---\nFull schema catalog:\n${schemaContext}`;
}

const app = express();

if (String(process.env.TRUST_PROXY || "").trim() === "1") {
  app.set("trust proxy", 1);
}

app.use(cors());
const compressionThreshold = parseInt(process.env.API_COMPRESSION_THRESHOLD_BYTES || "1024", 10) || 1024;
app.use(
  compression({
    threshold: Number.isFinite(compressionThreshold) && compressionThreshold >= 0 ? compressionThreshold : 1024,
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    },
  })
);
app.use(express.json());
app.use(requestIdMiddleware());
app.use(buildApiRateLimiter());
app.use(httpAccessLogMiddleware());
app.use(httpMetricsMiddleware());

/** Optional: set API_KEY in env to require matching X-API-Key on /api/* (except /api/health). */
app.use((req, res, next) => {
  const required = String(process.env.API_KEY || "").trim();
  if (!required) {
    return next();
  }
  const path = req.path || "";
  if (path === "/api/health") {
    return next();
  }
  if (!path.startsWith("/api/")) {
    return next();
  }
  let sent = String(req.get("x-api-key") || req.get("X-API-Key") || "").trim();
  // EventSource cannot set headers — allow key on query for GET analytics SSE only.
  if (!sent && req.method === "GET" && (req.path === "/api/analytics/events" || req.path === "/api/analytics/events/")) {
    sent = String(req.query && (req.query.api_key || req.query.x_api_key) || "").trim();
  }
  if (sent !== required) {
    res.status(403).json({
      error: "forbidden",
      message: "Invalid or missing X-API-Key header",
    });
    return;
  }
  next();
});

/** Optional RBAC: X-User-Email + users-config.json when RBAC_ENABLED=1 */
app.use(rbac.rbacMiddleware);

/** Landing page at root — serves index.html. Not under /api/ — skips API key + RBAC. */
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/index.html", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/** Web dashboard (static HTML next to this file). Not under /api/ — skips API key + RBAC. */
app.get("/dashboard", (_req, res) => {
  res.redirect(302, "/dashboard.html");
});
app.get("/dashboard.html", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

/** RAG / connector guide (static HTML next to this file). Not under /api/ — skips API key + RBAC. */
app.get("/rag-guide.html", (_req, res) => {
  res.sendFile(path.join(__dirname, "rag-guide.html"));
});

/**
 * Google Search Console HTML file verification. Must be at site root, public (no API key).
 * If Search Console gives a new file name, add that file next to this script (do not change contents).
 */
app.get(/^\/(google[0-9a-z]+\.html)$/i, (req, res, next) => {
  const name = req.params[0];
  if (!name) return next();
  const file = path.join(__dirname, name);
  if (!fs.existsSync(file)) return next();
  res.type("text/html; charset=utf-8");
  res.sendFile(file);
});

/* ── Legal & support pages (required for Workspace Marketplace listing) ── */
app.get("/privacy", (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Privacy Policy — Smart ERP Connector</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 24px;color:#1e293b;line-height:1.7}
  h1{font-size:28px;font-weight:800;color:#6366f1;margin-bottom:4px}
  h2{font-size:17px;font-weight:700;margin-top:32px;color:#334155}
  p,li{font-size:15px;color:#475569}
  a{color:#6366f1}
  .updated{font-size:13px;color:#94a3b8;margin-bottom:32px}
  footer{margin-top:48px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:13px;color:#94a3b8}
</style></head><body>
<h1>Privacy Policy</h1>
<p class="updated">Last updated: May 2026</p>

<h2>1. What this add-on does</h2>
<p>Smart ERP Connector is a Google Sheets Editor Add-on that connects your spreadsheet to your own ERP API server. It reads data from your server and writes it into your Google Sheet.</p>

<h2>2. Data we collect</h2>
<p>We collect and store only what is necessary to operate the add-on:</p>
<ul>
  <li><strong>Your Google account email</strong> — used to identify you to your ERP server for role-based access control. Stored in Google Apps Script UserProperties, never sent to any third party.</li>
  <li><strong>Your ERP API URL and API key</strong> — stored in Google Apps Script UserProperties on your account. Never transmitted anywhere except to the ERP server URL you provide.</li>
  <li><strong>Spreadsheet data</strong> — rows fetched from your ERP server are written directly into your Google Sheet. We do not store, copy, or transmit this data anywhere else.</li>
</ul>

<h2>3. How we use Google user data</h2>
<p>Data obtained through Google APIs — including your Google account email and Google Sheets access — is used solely to provide and improve the functionality of Smart ERP Connector. Specifically:</p>
<ul>
  <li>Your email is used only to authenticate your identity with your own ERP server</li>
  <li>Sheets access is used only to write ERP data into your active spreadsheet</li>
  <li>We do not use Google user data for advertising, marketing, analytics, or any purpose unrelated to the core features of this add-on</li>
  <li>We do not sell, license, or share Google user data with any third party</li>
</ul>

<h2>4. Data protection mechanisms</h2>
<p>We protect your data using the following mechanisms:</p>
<ul>
  <li>All data transmitted between the add-on and your ERP server is encrypted using HTTPS/TLS</li>
  <li>Google OAuth tokens are managed entirely by Google's infrastructure and are never stored on our servers</li>
  <li>Your Google email address is transmitted only to your own configured ERP API endpoint and is not retained by us</li>
  <li>API keys and settings are stored in Google Apps Script UserProperties, which are scoped to your Google account and inaccessible to other users</li>
  <li>Access to your data is restricted to your authenticated session only</li>
</ul>

<h2>5. Data we do NOT collect</h2>
<p>We do not collect analytics, crash reports, usage telemetry, or any personally identifiable information beyond your Google email address. We do not sell or share any data with third parties.</p>

<h2>6. Third-party services</h2>
<p>The add-on communicates exclusively with the ERP API server URL you configure. No other third-party services receive your data.</p>

<h2>7. Data retention</h2>
<p>Settings (API URL, key, email) are stored in Google Apps Script UserProperties and can be deleted at any time by uninstalling the add-on or clearing the settings via the setup wizard.</p>

<h2>8. Contact</h2>
<p>For privacy questions contact: <a href="mailto:ashapersonal24@gmail.com">ashapersonal24@gmail.com</a></p>

<footer>Smart ERP Connector &mdash; <a href="/support">Support</a></footer>
</body></html>`);
});

app.get("/support", (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Support — Smart ERP Connector</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 24px;color:#1e293b;line-height:1.7}
  h1{font-size:28px;font-weight:800;color:#6366f1;margin-bottom:4px}
  h2{font-size:17px;font-weight:700;margin-top:32px;color:#334155}
  p,li{font-size:15px;color:#475569}
  a{color:#6366f1}
  .card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px 24px;margin-top:16px}
  footer{margin-top:48px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:13px;color:#94a3b8}
</style></head><body>
<h1>Support</h1>
<p>Need help with Smart ERP Connector? We're here to help.</p>

<div class="card">
  <h2>📧 Email Support</h2>
  <p>Send your question to <a href="mailto:ashapersonal24@gmail.com">ashapersonal24@gmail.com</a> and we'll get back to you within 1 business day.</p>
</div>

<div class="card">
  <h2>⚙️ Setup Issues</h2>
  <p>If the setup wizard isn't working, try: <strong>Extensions → Smart ERP Connector → Run setup wizard…</strong> to restart it.</p>
</div>

<div class="card">
  <h2>🔄 Reset the add-on</h2>
  <p>To clear all saved settings and start fresh, go to <strong>Extensions → Smart ERP Connector → Run setup wizard…</strong> inside any Google Sheet.</p>
</div>

<div class="card">
  <h2>🔗 Common issues</h2>
  <ul>
    <li><strong>"Authorization required"</strong> — click Allow on the permissions dialog when it appears.</li>
    <li><strong>Panel not showing</strong> — open any Google Sheet → Extensions → Smart ERP Connector → Open panel.</li>
    <li><strong>Connection failed</strong> — make sure your ERP server is running and the API URL starts with https://</li>
  </ul>
</div>

<footer>Smart ERP Connector &mdash; <a href="/privacy">Privacy Policy</a></footer>
</body></html>`);
});

const LEGAL_CSS = `
  body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 24px;color:#1e293b;line-height:1.7}
  h1{font-size:28px;font-weight:800;color:#6366f1;margin-bottom:4px}
  h2{font-size:17px;font-weight:700;margin-top:32px;color:#334155}
  p,li{font-size:15px;color:#475569} a{color:#6366f1}
  .sub{font-size:13px;color:#94a3b8;margin-bottom:32px}
  .card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px 24px;margin-top:16px}
  footer{margin-top:48px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:13px;color:#94a3b8}
  nav a{margin-right:16px;font-size:13px}
`;

app.get("/tos", (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Terms of Service — Smart ERP Connector</title>
<style>${LEGAL_CSS}</style></head><body>
<h1>Terms of Service</h1>
<p class="sub">Last updated: April 2026</p>
<h2>1. Acceptance</h2>
<p>By installing or using Smart ERP Connector ("the Add-on"), you agree to these terms. If you do not agree, do not install or use the Add-on.</p>
<h2>2. Description of Service</h2>
<p>Smart ERP Connector is a Google Sheets Editor Add-on that connects your spreadsheet to your ERP API server. It reads data from your server and displays it inside Google Sheets.</p>
<h2>3. Your Responsibilities</h2>
<p>You are responsible for: (a) the security of your ERP API server and API key; (b) ensuring your use complies with your organisation's data policies; (c) keeping your API credentials confidential.</p>
<h2>4. Limitations</h2>
<p>The Add-on is provided "as is" without warranty of any kind. We are not liable for any data loss, service interruption, or damages arising from use of the Add-on.</p>
<h2>5. Changes</h2>
<p>We may update these terms at any time. Continued use after changes constitutes acceptance.</p>
<h2>6. Contact</h2>
<p>Questions? Email <a href="mailto:ashapersonal24@gmail.com">ashapersonal24@gmail.com</a></p>
<footer><nav><a href="/privacy">Privacy Policy</a><a href="/support">Support</a><a href="/help">Help</a></nav></footer>
</body></html>`);
});

app.get("/setup-guide", (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Setup Guide — Smart ERP Connector</title>
<style>${LEGAL_CSS}
  .step{display:flex;gap:16px;align-items:flex-start;margin-bottom:24px}
  .num{background:#6366f1;color:white;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;flex-shrink:0}
</style></head><body>
<h1>Setup Guide</h1>
<p class="sub">Get connected in under 60 seconds.</p>
<div class="step"><div class="num">1</div><div><strong>Install the add-on</strong><p>Click Install on the Marketplace page and accept the permissions. The add-on is now available in every Google Sheet you open.</p></div></div>
<div class="step"><div class="num">2</div><div><strong>Open a Google Sheet</strong><p>Open any Google Sheet. Click <strong>Extensions → Smart ERP Connector → Open panel</strong>. The setup wizard launches automatically.</p></div></div>
<div class="step"><div class="num">3</div><div><strong>Enter your API URL</strong><p>Paste your ERP server's HTTPS URL (e.g. <code>https://your-erp.onrender.com</code>). Click Save &amp; test.</p></div></div>
<div class="step"><div class="num">4</div><div><strong>API Key (optional)</strong><p>If your server requires an API key, paste it here. Otherwise click Skip.</p></div></div>
<div class="step"><div class="num">5</div><div><strong>Done!</strong><p>The wizard verifies your connection and shows your available datasets. Click Open dashboard to start exploring your data.</p></div></div>
<p>Your settings are saved to your Google account and will work across all your sheets automatically.</p>
<footer><nav><a href="/support">Support</a><a href="/privacy">Privacy Policy</a><a href="/tos">Terms</a></nav></footer>
</body></html>`);
});

app.get("/help", (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Help — Smart ERP Connector</title>
<style>${LEGAL_CSS}</style></head><body>
<h1>Help Centre</h1>
<div class="card"><h2>🔌 Connection issues</h2>
<p><strong>Error: Could not connect to API</strong> — Make sure your ERP server is running and the URL starts with <code>https://</code>. Test it by opening the URL in your browser.</p>
<p><strong>403 Forbidden</strong> — Your email may not be in the users-config on the server. Contact your ERP administrator.</p></div>
<div class="card"><h2>⚙️ Wizard & setup</h2>
<p>To rerun the wizard: <strong>Extensions → Smart ERP Connector → Run setup wizard…</strong></p>
<p>Your settings (API URL, key, email) are stored securely in your Google account and persist across all sheets.</p></div>
<div class="card"><h2>📊 Charts not showing</h2>
<p>Charts appear automatically when data has at least 2 columns (one text, one numeric). Use the <strong>Bar / Line / Pie</strong> toggle above any chart to switch types.</p></div>
<div class="card"><h2>🔄 Refreshing data</h2>
<p>Click the refresh button in the panel, or use <strong>Extensions → Smart ERP Connector → Refresh data</strong> to pull the latest data from your server.</p></div>
<p>Still stuck? <a href="/support">Contact support</a> or <a href="/report-issue">report an issue</a>.</p>
<footer><nav><a href="/support">Support</a><a href="/setup-guide">Setup Guide</a><a href="/privacy">Privacy</a></nav></footer>
</body></html>`);
});

app.get("/report-issue", (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Report an Issue — Smart ERP Connector</title>
<style>${LEGAL_CSS}
  input,textarea{width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;margin-bottom:12px;font-family:inherit;box-sizing:border-box}
  button{background:#6366f1;color:white;border:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer}
</style></head><body>
<h1>Report an Issue</h1>
<p>Found a bug or something not working? Let us know and we'll fix it fast.</p>
<p>Email your issue directly to: <a href="mailto:ashapersonal24@gmail.com?subject=Smart ERP Connector Issue">ashapersonal24@gmail.com</a></p>
<p>Please include:</p>
<ul>
  <li>What you were trying to do</li>
  <li>What happened instead</li>
  <li>Any error messages you saw</li>
  <li>Your Google Sheets version and browser</li>
</ul>
<p>We aim to respond within 1 business day.</p>
<footer><nav><a href="/support">Support</a><a href="/help">Help</a><a href="/privacy">Privacy</a></nav></footer>
</body></html>`);
});

/* ── Google OAuth2 callback ── */
app.get("/oauth2callback", (req, res) => {
  const { code, error, state } = req.query;
  if (error) {
    // User denied access — redirect to dashboard with message
    return res.redirect("/dashboard.html?oauth=denied");
  }
  if (code) {
    // Auth code received — for the Workspace add-on, the Apps Script
    // handles token exchange itself. This endpoint just confirms the
    // redirect URI is valid and sends the user back to the dashboard.
    return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Authorisation Complete — Smart ERP Connector</title>
<style>
  body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#f1f5f9}
  .card{background:#1e293b;border-radius:16px;padding:48px 40px;max-width:480px;text-align:center;box-shadow:0 25px 50px rgba(0,0,0,.5)}
  .icon{font-size:56px;margin-bottom:16px}
  h1{font-size:24px;font-weight:800;color:#a5b4fc;margin:0 0 8px}
  p{color:#94a3b8;font-size:15px;margin:0 0 24px}
  a{display:inline-block;background:#6366f1;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px}
  a:hover{background:#4f46e5}
</style>
<script>setTimeout(()=>location.href='/dashboard.html',3000)</script>
</head><body>
<div class="card">
  <div class="icon">✅</div>
  <h1>Authorisation Complete</h1>
  <p>Smart ERP Connector has been granted the requested permissions.<br/>Redirecting you to the dashboard&hellip;</p>
  <a href="/dashboard.html">Go to Dashboard</a>
</div>
</body></html>`);
  }
  // No code or error — just redirect home
  res.redirect("/dashboard.html");
});

app.get("/admin-config", (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin Configuration — Smart ERP Connector</title>
<style>${LEGAL_CSS}</style></head><body>
<h1>Admin Configuration</h1>
<p>Smart ERP Connector is configured per-user through the in-sheet setup wizard. There is no separate admin portal — all settings are managed inside Google Sheets.</p>
<div class="card"><h2>For Google Workspace Admins</h2>
<p>You can deploy Smart ERP Connector to all users in your domain via the Google Workspace Admin Console:<br/>
<strong>Apps → Google Workspace Marketplace apps → Add app</strong> → search Smart ERP Connector → Install for all users.</p></div>
<div class="card"><h2>Server-side configuration</h2>
<p>The ERP API server is configured separately. Set the following environment variables on your server:</p>
<ul>
  <li><code>DATABASE_URL</code> — your database connection string</li>
  <li><code>API_KEY</code> — optional API key for authentication</li>
  <li><code>PORT</code> — server port (default 3000)</li>
</ul></div>
<footer><nav><a href="/support">Support</a><a href="/help">Help</a><a href="/privacy">Privacy</a></nav></footer>
</body></html>`);
});

const port = parseInt(process.env.PORT || "3000", 10);

function envTrim(key) {
  const v = process.env[key];
  if (v == null) {
    return undefined;
  }
  return String(v).trim();
}

function getDbConfig() {
  /* Large analytics views (PowerBI rollups, QTD/YTD) often exceed 120s — default 480s unless overridden.
     IMPORTANT: In mssql v9+, requestTimeout MUST be at the top-level of the config object,
     NOT inside options{} — otherwise it is ignored and tedious uses its default of 120 s. */
  const requestTimeout = parseInt(process.env.DB_REQUEST_TIMEOUT_MS || "480000", 10);
  const connectTimeout = parseInt(process.env.DB_CONNECT_TIMEOUT_MS || "60000", 10);
  const encryptEnv = String(process.env.DB_ENCRYPT || "")
    .trim()
    .toLowerCase();
  const encrypt = encryptEnv === "1" || encryptEnv === "true" || encryptEnv === "yes";
  const safeReqTimeout = Number.isFinite(requestTimeout) ? requestTimeout : 480000;
  const safeConTimeout = Number.isFinite(connectTimeout) ? connectTimeout : 60000;

  /* Pool sizing:
     - max: 20 connections (up from 10) — analytics runs up to 6 parallel queries per request;
       warmup + concurrent user requests would exhaust a pool of 10.
     - acquireTimeoutMillis: how long tarn waits for a free connection before throwing
       "operation timed out for an unknown reason". Default is 60s — too short when
       analytics warmup holds connections for several minutes. Set to 3 min. */
  const poolMax = parseInt(process.env.DB_POOL_MAX || "20", 10);
  const acquireTimeout = parseInt(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS || "180000", 10);

  return {
    user: envTrim("DB_USER"),
    password: envTrim("DB_PASSWORD"),
    server: envTrim("DB_SERVER"),
    port: parseInt(envTrim("DB_PORT") || "1433", 10),
    database: envTrim("DB_NAME"),
    /* mssql v9+ reads requestTimeout from the TOP level, not from options{} */
    requestTimeout: safeReqTimeout,
    connectionTimeout: safeConTimeout,
    options: {
      encrypt,
      trustServerCertificate: true,
    },
    pool: {
      max: poolMax,
      min: 0,
      idleTimeoutMillis: 30000,
      acquireTimeoutMillis: acquireTimeout,
    },
  };
}

/** Only allow schema.table names for dynamic SQL */
function sanitizeTableName(raw) {
  const s = String(raw || "").trim();
  if (!/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(s)) {
    return null;
  }
  return s;
}

/** Single SQL identifier (no dots) for schema/object names from URL params */
function sanitizeIdentifier(raw) {
  const s = String(raw || "").trim().replace(/^\[|\]$/g, "");
  if (!s || s.length > 128 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
    return null;
  }
  return s;
}

/**
 * Runs SELECT TOP (@limit) * FROM table [WHERE ...] with parameterized filters.
 * When the dataset's env date column is set, adds ORDER BY CAST([col] AS date) DESC so TOP (N)
 * matches the newest calendar rows in-range (same grain as the date filter).
 * Query params: from, to (yyyy-mm-dd or dd.mm.yyyy), fy (e.g. FY26 → Apr–Mar India FY),
 * branch, status, department, category.
 * @throws {Error & { status?: number, code?: string }} on validation errors
 */
async function runFilteredDatasetQuery(pool, table, datasetKey, limit, query) {
  const dk = String(datasetKey || "").toLowerCase().trim();
  const request = pool.request();
  request.input("limit", sql.Int, limit);
  const { whereParts } = appendDatasetFilterWhere(request, dk, query);
  let sqlText = `SELECT TOP (@limit) * FROM ${table}`;
  if (whereParts.length) {
    sqlText += ` WHERE ${whereParts.join(" AND ")}`;
  }
  sqlText += datasetDateOrderByDescSql(dk);

  return request.query(sqlText);
}

let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    poolPromise = connectWithRetries(getDbConfig, sql).catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

/** Buffers / binary columns break JSON for Sheets; stringify safely */
function rowsForJson(recordset) {
  return recordset.map((row) => {
    const out = {};
    for (const key of Object.keys(row)) {
      const val = row[key];
      if (Buffer.isBuffer(val)) {
        out[key] = val.toString("hex");
      } else if (val instanceof Uint8Array) {
        out[key] = Buffer.from(val).toString("hex");
      } else {
        out[key] = val;
      }
    }
    return out;
  });
}

function getDatasetHardCap() {
  const hardCapRaw = parseInt(process.env.DATASET_HARD_CAP || "20000", 10);
  return Number.isFinite(hardCapRaw) ? Math.max(hardCapRaw, 500) : 20000;
}

/** Upper bound for explicit numeric ?limit= (dashboard row dropdown goes up to 5,000). */
function getDatasetPageMax() {
  const hardCap = getDatasetHardCap();
  const raw = parseInt(process.env.DATASET_PAGE_MAX || "5000", 10);
  const n = Number.isFinite(raw) && raw >= 1 ? raw : 5000;
  return Math.min(n, hardCap);
}

function parseLimit(query) {
  const hardCap = getDatasetHardCap();
  const pageMax = getDatasetPageMax();

  const raw = query && query.limit != null ? String(query.limit).trim().toLowerCase() : "";
  if (!raw) {
    // Dashboard default: show up to 500 unless caller asks otherwise.
    return 500;
  }
  if (raw === "all") {
    // "All" means: up to a server-side hard cap, to avoid accidental overload.
    return hardCap;
  }

  const rawLimit = parseInt(raw, 10);
  return Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), pageMax) : 500;
}

/**
 * Whitelist: dataset keys come only from DATASET_REGISTRY (see datasets-registry.js).
 */
const { resolveDatasetTable } = require(path.join(rootDir, "services", "dataset-table-resolve"));

/**
 * UI + Apps Script: which filters exist per dataset (driven by env columns only).
 */
function loadDatasetAccessMap() {
  try {
    const p = path.join(rootDir, "metadata", "dataset-access.json");
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j && j.byKey && typeof j.byKey === "object" ? j.byKey : null;
  } catch {
    return null;
  }
}

function buildConnectorConfig() {
  const hardCap = getDatasetHardCap();
  const pageMax = getDatasetPageMax();
  const accessByKey = loadDatasetAccessMap();
  const datasets = [];
  for (const entry of DATASET_REGISTRY) {
    const table = resolveDatasetTable(entry.key);
    if (!table) {
      continue;
    }
    const cfg = getFilterColumns(entry.key);
    const dateCol = sanitizeColumnName(cfg.date);
    const branchCol = sanitizeColumnName(cfg.branch);
    const statusCol = sanitizeColumnName(cfg.status);
    const deptCol = sanitizeColumnName(cfg.department);
    const catCol = sanitizeColumnName(cfg.category);
    const p = entry.filterPrefix || "";
    const shortObject = table.includes(".") ? table.split(".").pop() : table;
    const access = accessByKey && accessByKey[entry.key] ? accessByKey[entry.key] : null;
    datasets.push({
      key: entry.key,
      label: entry.label,
      objectName: table,
      shortName: shortObject,
      accessOk: access ? Boolean(access.ok) : null,
      accessDenied: access ? Boolean(access.denied) : null,
      accessMessage: access && access.message ? String(access.message) : null,
      filters: {
        date: { enabled: Boolean(dateCol), column: dateCol || null },
        financialYear: {
          enabled: Boolean(dateCol),
          hint: "Apr–Mar (India-style). Use fy=FY26 or set From/To instead.",
        },
        branch: {
          enabled: Boolean(branchCol),
          column: branchCol || null,
          match: p ? getFilterMatchMode(p, "BRANCH") : "equal",
        },
        status: { enabled: Boolean(statusCol), column: statusCol || null },
        department: {
          enabled: Boolean(deptCol),
          column: deptCol || null,
          match: p ? getFilterMatchMode(p, "DEPARTMENT") : "equal",
        },
        category: {
          enabled: Boolean(catCol),
          column: catCol || null,
          match: p ? getFilterMatchMode(p, "CATEGORY") : "equal",
        },
      },
    });
  }
  return {
    maxLimit: pageMax,
    hardCap,
    defaultLimit: 500,
    allowAll: true,
    datasetCount: datasets.length,
    dateInputHint: "dd.mm.yyyy, dd-mm-yyyy, or yyyy-mm-dd",
    datasets,
  };
}

/* ─────────────────────────────────────────────────────────────
   AUTH ENDPOINTS  (no RBAC middleware — these are public)
   ───────────────────────────────────────────────────────────── */

/**
 * POST /api/auth/login
 * Body: { email: string, password: string }
 * Returns: { token, email, role, name, features, firstRun }
 *
 * firstRun=true means the user logged in via ADMIN_DEFAULT_PASSWORD
 * (no hash stored yet). The dashboard should prompt for a password change.
 */
app.post("/api/auth/login", (req, res) => {
  if (!rbac.rbacEnabled()) {
    return res.status(403).json({
      error: "rbac_disabled",
      message: "Set RBAC_ENABLED=1 on the server to use dashboard login.",
    });
  }
  const email    = String(req.body?.email    || "").trim().toLowerCase();
  const password = String(req.body?.password || "").trim();
  if (!email || !password) {
    return res.status(400).json({ error: "missing_fields", message: "email and password are required." });
  }
  const cfg = rbac.getUsersConfig();
  const userEntry = (cfg?.users || []).find(
    (u) => String(u.email || "").trim().toLowerCase() === email
  );
  if (!userEntry) {
    return res.status(401).json({ error: "unknown_user", message: "Invalid email or password." });
  }
  const { ok, firstRun } = auth.checkUserPassword(password, userEntry);
  if (!ok) {
    return res.status(401).json({ error: "wrong_password", message: "Invalid email or password." });
  }
  const roleDef = cfg.roles?.[userEntry.role];
  const features = roleDef?.features || [];
  const datasets = rbac.normalizeDatasetScope(roleDef?.datasets);
  const token = auth.generateToken({
    email:    userEntry.email,
    role:     userEntry.role,
    name:     userEntry.name || userEntry.email,
    features,
    datasets,
  });
  res.json({
    token,
    email:    userEntry.email,
    role:     userEntry.role,
    name:     userEntry.name || userEntry.email,
    features,
    firstRun: !!firstRun,
  });
});

/**
 * POST /api/auth/google
 * Body: { credential: <google_id_token from GIS> }
 * Verifies the Google ID token, checks the email against users-config, returns a JWT session.
 * This lets users log in with "Sign in with Google" — no password required.
 */
app.post("/api/auth/google", async (req, res) => {
  if (!rbac.rbacEnabled()) {
    return res.status(403).json({
      error: "rbac_disabled",
      message: "Set RBAC_ENABLED=1 on the server to use dashboard login.",
    });
  }
  const credential = String(req.body?.credential || "").trim();
  if (!credential) {
    return res.status(400).json({ error: "missing_credential", message: "Google credential token is required." });
  }

  let tokenInfo;
  try {
    // Verify id_token using Google's public endpoint (no extra library needed)
    const verifyRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
    );
    tokenInfo = await verifyRes.json();
    if (!verifyRes.ok || !tokenInfo.email) {
      return res.status(401).json({ error: "invalid_google_token", message: "Could not verify Google identity." });
    }
  } catch (err) {
    console.error("[auth/google] verification failed:", err);
    return res.status(502).json({ error: "google_verify_failed", message: "Could not reach Google to verify login." });
  }

  const email = String(tokenInfo.email || "").trim().toLowerCase();
  const cfg = rbac.getUsersConfig();
  const userEntry = (cfg?.users || []).find(
    (u) => String(u.email || "").trim().toLowerCase() === email
  );

  if (!userEntry) {
    return res.status(401).json({
      error: "unknown_user",
      message: "This Google account (" + email + ") is not registered. Ask your admin to add you.",
    });
  }

  const roleDef  = cfg.roles?.[userEntry.role];
  const features = roleDef?.features || [];
  const datasets = rbac.normalizeDatasetScope(roleDef?.datasets);
  const name     = userEntry.name || tokenInfo.name || tokenInfo.email;

  const token = auth.generateToken({ email: userEntry.email, role: userEntry.role, name, features, datasets });

  res.json({ token, email: userEntry.email, role: userEntry.role, name, features, firstRun: false });
});

/**
 * POST /api/auth/change-password
 * Requires valid Bearer JWT.
 * Body: { currentPassword: string, newPassword: string }
 */
app.post("/api/auth/change-password", rbac.rbacMiddleware, async (req, res) => {
  const email       = req.rbac?.email;
  const currentPwd  = String(req.body?.currentPassword || "").trim();
  const newPwd      = String(req.body?.newPassword      || "").trim();
  if (!email) {
    return res.status(401).json({
      error: "unauthorized",
      message: "Send Authorization: Bearer <token> from a logged-in session.",
    });
  }
  if (!currentPwd || !newPwd) {
    return res.status(400).json({ error: "missing_fields", message: "currentPassword and newPassword are required." });
  }
  if (newPwd.length < 8) {
    return res.status(400).json({ error: "weak_password", message: "New password must be at least 8 characters." });
  }
  const cfg = rbac.getUsersConfig();
  const userEntry = (cfg?.users || []).find(
    (u) => String(u.email || "").trim().toLowerCase() === email.toLowerCase()
  );
  if (!userEntry) {
    return res.status(404).json({ error: "user_not_found" });
  }
  const { ok } = auth.checkUserPassword(currentPwd, userEntry);
  if (!ok) {
    return res.status(401).json({ error: "wrong_current_password", message: "Current password is incorrect." });
  }
  try {
    await rbac.setUserPasswordHash(email, auth.hashPassword(newPwd));
    res.json({ ok: true, message: "Password changed successfully." });
  } catch (err) {
    res.status(500).json({ error: "change_failed", message: String(err.message) });
  }
});

/**
 * POST /api/admin/users/:email/set-password
 * Admin-only: reset any user's password.
 */
app.post("/api/admin/users/:email/set-password", rbac.requireAdminApi, async (req, res) => {
  const targetEmail = decodeURIComponent(req.params.email || "").trim();
  const newPwd      = String(req.body?.newPassword || "").trim();
  if (!targetEmail || !newPwd) {
    return res.status(400).json({ error: "missing_fields" });
  }
  if (newPwd.length < 8) {
    return res.status(400).json({ error: "weak_password", message: "Password must be at least 8 characters." });
  }
  try {
    await rbac.setUserPasswordHash(targetEmail, auth.hashPassword(newPwd));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "failed", message: String(err.message) });
  }
});

/** No SQL Server query — may list mirror snapshot keys from PostgreSQL when mirror read is enabled */
app.get("/api/connector-config", async (req, res) => {
  try {
    const base = buildConnectorConfig();
    if (req.rbac) {
      base.datasets = rbac.filterDatasets(base.datasets, req.rbac);
      base.userRole = {
        email: req.rbac.email,
        role: req.rbac.roleKey,
        features: req.rbac.features,
      };
    }
    base.mirror = {
      readEnabled: Boolean(isMirrorReadEnabled() && getMirrorUrl()),
      fallbackToLive: mirrorFallbackToLive(),
      snapshots: [],
    };
    if (base.mirror.readEnabled) {
      try {
        base.mirror.snapshots = await listMirrorSnapshotMeta();
      } catch (err) {
        console.warn("[connector-config] mirror list failed:", err.message);
        base.mirror.snapshots = [];
        base.mirror.mirrorListError = String(err.message);
      }
    }
    res.json(base);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "config_failed", message: String(err.message) });
  }
});

app.get("/api/health", async (req, res) => {
  const out = { ok: true, db: true, mirror: null };
  try {
    const pool = await getPool();
    await pool.request().query("SELECT 1 AS ok");
  } catch (err) {
    console.error(err);
    out.ok = false;
    out.db = false;
    out.error = "db_unavailable";
    res.status(500).json(out);
    return;
  }
  if (isMirrorReadEnabled() && getMirrorUrl()) {
    try {
      const snaps = await listMirrorSnapshotMeta();
      out.mirror = { ok: true, snapshotCount: snaps.length };
    } catch (err) {
      out.mirror = { ok: false, error: String(err.message) };
    }
  }
  out.limits = {
    hardCap: getDatasetHardCap(),
    pageMax: getDatasetPageMax(),
    defaultLimit: 500,
  };
  res.json(out);
});

/**
 * GET /api/monitoring/kpis
 * Rolling latency/error/freshness metrics for SRE dashboards. Auth: X-Monitoring-Key (= MONITORING_API_KEY) or RBAC admin.
 */
app.get("/api/monitoring/kpis", (req, res, next) => {
  const secret = String(process.env.MONITORING_API_KEY || "").trim();
  if (secret) {
    const sent = String(req.get("x-monitoring-key") || "").trim();
    if (sent !== secret) {
      res.status(403).json({
        error: "forbidden",
        message: "Invalid or missing X-Monitoring-Key (must match MONITORING_API_KEY)",
      });
      return;
    }
    return next();
  }
  return rbac.requireAdminApi(req, res, next);
}, (_req, res) => {
  try {
    res.json(getSnapshot());
  } catch (e) {
    res.status(500).json({ error: "metrics_failed", message: String(e.message) });
  }
});

/* ─────────────────────────────────────────────────────────────
   GOOGLE DRIVE EXPORT (SERVICE ACCOUNT) — OPTIONAL
   Requires env:
   - GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON  (full JSON string)
   - GOOGLE_DRIVE_FOLDER_ID             (optional default folder)
   ───────────────────────────────────────────────────────────── */

function getDriveServiceAccountJson() {
  const raw = String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn("[drive] invalid GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON:", e.message);
    return null;
  }
}

function getDriveAuth() {
  const sa = getDriveServiceAccountJson();
  if (!sa?.client_email || !sa?.private_key) return null;
  return new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
}

async function driveUploadBuffer({ buffer, filename, mimeType, folderId }) {
  const auth = getDriveAuth();
  if (!auth) {
    const e = new Error("drive_not_configured");
    e.status = 503;
    e.code = "drive_not_configured";
    throw e;
  }
  const drive = google.drive({ version: "v3", auth });
  const parents = [];
  const p = String(folderId || process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();
  if (p) parents.push(p);

  const created = await drive.files.create({
    requestBody: {
      name: filename,
      parents: parents.length ? parents : undefined,
    },
    media: { mimeType, body: Buffer.from(buffer) },
    fields: "id,name,webViewLink",
  });
  return created.data;
}

function rowsToCsvBuffer(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  if (!arr.length) return Buffer.from("", "utf8");
  const headers = Object.keys(arr[0]);
  const esc = (v) => {
    const s = String(v ?? "");
    const q = s.replace(/"/g, '""');
    return /[",\n]/.test(q) ? `"${q}"` : q;
  };
  const lines = [headers.join(","), ...arr.map((r) => headers.map((h) => esc(r[h])).join(","))];
  return Buffer.from(lines.join("\n"), "utf8");
}

app.post("/api/drive/export-dataset", rbac.requireFeature("data"), async (req, res) => {
  const dk = String(req.body?.datasetKey || "").toLowerCase().trim();
  const limitRaw = req.body?.limit;
  const limit = parseLimit({ limit: limitRaw == null ? "500" : String(limitRaw) });
  const folderId = String(req.body?.folderId || "").trim() || undefined;
  const format = String(req.body?.format || "csv").toLowerCase().trim();

  if (!dk) return res.status(400).json({ error: "missing_datasetKey" });
  if (req.rbac && !rbac.assertDatasetAllowed(req.rbac, dk)) {
    return res.status(403).json({ error: "dataset_denied", message: `You do not have access to dataset: ${dk}` });
  }
  if (format !== "csv") {
    return res.status(400).json({ error: "unsupported_format", message: "Only csv is supported for server export right now." });
  }

  const table = resolveDatasetTable(dk);
  if (!table) {
    return res.status(400).json({ error: "unknown_dataset", allowed: DATASET_KEYS });
  }

  try {
    const pool = await getPool();
    const filters = req.body?.filters || {};
    const reliable = await executeDatasetQueryWithReliability(
      () => runFilteredDatasetQuery(pool, table, dk, limit, filters),
      { context: "POST /api/drive/export-dataset", datasetKey: dk, limit, query: filters }
    );
    const rows = rowsForJson(reliable.recordset);
    const buf = rowsToCsvBuffer(rows);
    const filename = `${dk}_${new Date().toISOString().slice(0, 10)}.csv`;
    const uploaded = await driveUploadBuffer({ buffer: buf, filename, mimeType: "text/csv", folderId });
    res.json({ ok: true, file: uploaded, rowCount: rows.length, limit });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.code || "drive_export_failed", message: String(err.message || err) });
  }
});

/**
 * POST /api/drive/upload-raw
 * Browser sends already-built file data (base64) → server uploads to Drive via service account.
 * Body: { filename, mimeType, dataBase64, folderId? }
 * This means users NEVER need a Google OAuth Client ID — the service account does the upload.
 */
app.post("/api/drive/upload-raw", rbac.requireFeature("data"), async (req, res) => {
  const filename   = String(req.body?.filename   || "export.csv").trim();
  const mimeType   = String(req.body?.mimeType   || "text/csv").trim();
  const dataBase64 = String(req.body?.dataBase64 || "").trim();
  const folderId   = String(req.body?.folderId   || "").trim() || undefined;

  if (!dataBase64) return res.status(400).json({ error: "missing_data", message: "dataBase64 is required." });

  let buffer;
  try {
    buffer = Buffer.from(dataBase64, "base64");
  } catch (e) {
    return res.status(400).json({ error: "invalid_base64", message: "Could not decode dataBase64." });
  }

  try {
    const uploaded = await driveUploadBuffer({ buffer, filename, mimeType, folderId });
    res.json({ ok: true, file: uploaded });
  } catch (err) {
    const status = err.status || 500;
    const isDriveNotConfigured = err.code === "drive_not_configured";
    res.status(status).json({
      error: err.code || "drive_upload_failed",
      message: isDriveNotConfigured
        ? "Google Drive not configured on server. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON on Render."
        : String(err.message || err),
    });
  }
});

/** GET /api/drive/status — lets the dashboard check if Drive is configured server-side */
app.get("/api/drive/status", rbac.requireFeature("data"), (_req, res) => {
  const configured = !!getDriveAuth();
  res.json({ configured, folderConfigured: !!(process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim() });
});

/** Snapshot inventory (same auth as other /api routes) */
app.get("/api/mirror-status", rbac.requireFeature("data"), async (req, res) => {
  if (!isMirrorReadEnabled() || !getMirrorUrl()) {
    res.status(403).json({
      error: "mirror_read_disabled",
      message: "Set MIRROR_READ_ENABLED=1 and MIRROR_DATABASE_URL",
    });
    return;
  }
  try {
    const snapshots = await listMirrorSnapshotMeta();
    res.json({ snapshots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "mirror_status_failed", message: String(err.message) });
  }
});

/**
 * GET /api/dataset/:name
 * Names map to views/tables via env whitelist only (see resolveDatasetTable).
 */
app.get("/api/dataset/:name", rbac.requireFeature("data"), async (req, res) => {
  const limit = parseLimit(req.query);
  const { normalizeDatasetKey } = require(path.join(rootDir, "filter-query"));
  const dk = normalizeDatasetKey(req.params.name);
  if (req.rbac && !rbac.assertDatasetAllowed(req.rbac, dk)) {
    res.status(403).json({
      error: "dataset_denied",
      message: `You do not have access to dataset: ${dk}`,
    });
    return;
  }
  const table = resolveDatasetTable(dk);
  if (!table) {
    res.status(400).json({
      error: "unknown_dataset",
      hint: "GET /api/connector-config lists valid keys",
      allowed: DATASET_KEYS,
    });
    return;
  }

  const source = String(req.query.source || "").toLowerCase().trim();
  if (source === "mirror") {
    if (!isMirrorReadEnabled() || !getMirrorUrl()) {
      res.status(403).json({
        error: "mirror_read_disabled",
        message: "Set MIRROR_READ_ENABLED=1 and a valid MIRROR_DATABASE_URL on the server",
      });
      return;
    }
    try {
      const snap = await loadMirrorSnapshotRows(dk);
      if (snap == null) {
        if (mirrorFallbackToLive()) {
          /* fall through to SQL Server */
        } else {
          res.status(503).json({
            error: "mirror_unavailable",
            message: "Could not connect to PostgreSQL mirror",
          });
          return;
        }
      } else {
        const filtered = filterMirrorRows(snap.rows, dk, limit, req.query);
        if (filtered.error) {
          res.status(filtered.error.status).json({
            error: filtered.error.code,
            message: filtered.error.message,
          });
          return;
        }
        res.setHeader("X-ERP-Data-Source", "mirror");
        res.json(rowsForJson(filtered.rows));
        return;
      }
    } catch (err) {
      console.error("[mirror-read]", err);
      if (!mirrorFallbackToLive()) {
        res.status(500).json({
          error: "mirror_read_failed",
          message: String(err.message),
        });
        return;
      }
    }
  }

  try {
    const pool = await getPool();
    const out = await executeDatasetQueryWithReliability(
      () => runFilteredDatasetQuery(pool, table, dk, limit, req.query),
      { context: `GET /api/dataset/${dk}`, datasetKey: dk, limit, query: req.query || {} }
    );
    res.setHeader("X-ERP-Data-Source", out.source === "mirror_fallback" ? "mirror_fallback" : "live");
    if (out.degraded) {
      res.setHeader("X-ERP-Query-Degraded", "mirror_after_live_failure");
    }
    const hardCap = getDatasetHardCap();
    const rowCount = out.recordset ? out.recordset.length : 0;
    res.setHeader("X-ERP-Row-Limit", String(limit));
    res.setHeader("X-ERP-Hard-Cap", String(hardCap));
    res.setHeader("X-ERP-Row-Count", String(rowCount));
    res.setHeader(
      "X-ERP-Rows-Capped",
      rowCount >= limit && limit >= hardCap ? "1" : "0"
    );
    res.json(rowsForJson(out.recordset));
  } catch (err) {
    if (err.status === 400) {
      res.status(400).json({
        error: err.code || "bad_request",
        message: err.message,
      });
      return;
    }
    console.error(err);
    const msg = String(err.message);
    let hint = null;
    if (/permission was denied|select permission was denied/i.test(msg) && /MstSalesPerson|VwAISalesPerson/i.test(msg)) {
      hint =
        "The database user for this API cannot read the salesperson master chain (often dbo.MstSalesPerson behind dbo.VwAISalesPerson). " +
        "Fix in SSMS: GRANT SELECT ON dbo.MstSalesPerson TO [your_api_login]; — or set VW_AI_SALESPERSON_VIEW=dbo.VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID in .env and restart, " +
        "or use dataset “mb_powerbi_sls_data_without_itemid” in the Data tab (SalesPersonName on transaction lines).";
    } else if (/permission was denied|select permission was denied/i.test(msg) && dk === "vw_ai_salesperson") {
      hint =
        "Salesperson dataset failed: grant SELECT on underlying master objects, or set VW_AI_SALESPERSON_VIEW=dbo.VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID in .env, or load dataset mb_powerbi_sls_data_without_itemid.";
    }
    res.status(500).json({ error: "query_failed", message: msg, ...(hint ? { hint } : {}) });
  }
});

/**
 * Legacy route — same dataset as /api/dataset/sales (sales view by default).
 */
app.get("/api/sales", rbac.requireFeature("data"), async (req, res) => {
  if (req.rbac && !rbac.assertDatasetAllowed(req.rbac, "sales")) {
    res.status(403).json({
      error: "dataset_denied",
      message: "You do not have access to dataset: sales",
    });
    return;
  }
  const limit = parseLimit(req.query);
  const table = sanitizeTableName(
    process.env.SALES_VIEW || process.env.SALES_TABLE || "dbo.VwAISalesData"
  );
  if (!table) {
    res.status(500).json({ error: "Invalid SALES_VIEW / SALES_TABLE in .env" });
    return;
  }

  try {
    const pool = await getPool();
    const out = await executeDatasetQueryWithReliability(
      () => runFilteredDatasetQuery(pool, table, "sales", limit, req.query),
      { context: "GET /api/sales", datasetKey: "sales", limit, query: req.query || {} }
    );
    res.setHeader("X-ERP-Data-Source", out.source === "mirror_fallback" ? "mirror_fallback" : "live");
    if (out.degraded) res.setHeader("X-ERP-Query-Degraded", "mirror_after_live_failure");
    res.json(rowsForJson(out.recordset));
  } catch (err) {
    if (err.status === 400) {
      res.status(400).json({
        error: err.code || "bad_request",
        message: err.message,
      });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "query_failed", message: String(err.message) });
  }
});

/**
 * GET /api/home/kpi?period=today|mtd
 * Ultra-lightweight endpoint for the Home panel — runs a single aggregation query
 * instead of the full analytics-dashboard pipeline (6 parallel queries).
 * Returns { totalSales, txnCount } only.
 */
app.get("/api/home/kpi", rbac.requireFeature("data"), async (req, res) => {
  const period = String(req.query.period || "today").toLowerCase().trim();
  const nl = String(process.env.ANALYTICS_NOLOCK || "").trim() === "1" ? " WITH (NOLOCK)" : "";

  const table = String(process.env.ANALYTICS_BASE_TABLE || DEFAULT_ANALYTICS_TABLE).trim();
  const datCol = resolveAnalyticsDateCol(table, "sales");
  if (!datCol) {
    res.status(500).json({
      ok: false,
      error: "date_column_not_configured",
      message: "Set per-table *_FILTER_DATE_COLUMN or MB_POWERBI_APP_REPORT_FILTER_DATE_COLUMN for the analytics base table.",
    });
    return;
  }
  const dims = salesDimColumns(table, "sales");
  const amtCol = dims.amount;

  let whereSql;
  if (period === "today") {
    whereSql = `WHERE CAST([${datCol}] AS DATE) = CAST(GETDATE() AS DATE)`;
  } else {
    // mtd — 1st of current month to today
    whereSql = `WHERE CAST([${datCol}] AS DATE) >= CAST(DATEADD(day, 1 - DAY(GETDATE()), CAST(GETDATE() AS DATE)) AS DATE)\n      AND CAST([${datCol}] AS DATE) <= CAST(GETDATE() AS DATE)`;
  }

  const rollupDaily = String(process.env.ANALYTICS_USE_LINE_ROLLUP || "").trim() === "1";
  const lcCol = String(process.env.ANALYTICS_ROLLUP_LINECOUNT_COLUMN || "LineCount").trim();
  const rowCntAgg = rollupDaily
    ? `CAST(SUM(ISNULL([${lcCol}], 0)) AS BIGINT)`
    : "COUNT(*)";

  const sqlText = `
    SELECT
      ${buildKpiSelectSql(dims, datCol, rowCntAgg, "")}
    FROM ${table}${nl}
    ${whereSql}`;

  try {
    const pool = await getPool();
    const request = pool.request();
    /* MTD touches far more rows than "today"; 20s often timed out while analytics (120s driver cap) succeeded. */
    const homeKpiReqMs = parseInt(
      String(process.env.HOME_KPI_REQUEST_TIMEOUT_MS || process.env.DB_REQUEST_TIMEOUT_MS || "120000"),
      10
    );
    request.timeout =
      Number.isFinite(homeKpiReqMs) && homeKpiReqMs > 0 ? Math.min(300000, Math.max(30000, homeKpiReqMs)) : 120000;
    const result = await request.query(sqlText);
    const row = (result.recordset || [])[0] || {};
    const txnCount = parseInt(String(row.txn_count), 10) || 0;
    const billCount = parseInt(String(row.bill_count), 10) || 0;
    res.json({
      ok: true,
      period,
      totalSales: parseFloat(row.total_sales) || 0,
      txnCount,
      billCount: billCount || txnCount,
      customerCount: parseInt(String(row.customer_count), 10) || 0,
      quantitySold: parseFloat(row.quantity_sold) || 0,
    });
  } catch (err) {
    console.error(`[home/kpi] ${period} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/analytics/dashboard
 * Body: { period, custom?, branch?, department?, category?, crossFilter?, dataset?, topN?,
 *         compact?: boolean, fields?: string[] | "kpi,period,widgets.trend",
 *         loadPhase?: "full" | "critical" | "widgets",
 *         format?: "msgpack" } —
 *       loadPhase splits work: critical = KPI+trend first; widgets = branch/dept/category + insights (merge client-side).
 *       compact trims quality; fields projects allowlisted paths;
 *       Accept: application/x-msgpack also selects MessagePack. gzip/brotli via compression middleware.
 */
app.post("/api/analytics/dashboard", rbac.requireFeature("data"), async (req, res) => {
  const dk = String((req.body && req.body.dataset) || "sales").toLowerCase().trim();
  if (req.rbac && !rbac.assertDatasetAllowed(req.rbac, dk)) {
    res.status(403).json({
      error: "dataset_denied",
      message: `You do not have access to dataset: ${dk}`,
    });
    return;
  }

  const t0 = Date.now();
  try {
    const pool = await getPool();
    const out = await executeWithSqlRetryBundle(
      () => runAnalyticsDashboard(pool, req.body || {}),
      "POST /api/analytics/dashboard"
    );
    res.setHeader("X-ERP-Server-Ms", String(Date.now() - t0));
    res.setHeader("X-ERP-Analytics-Version", String(out.dataVersion || ""));
    res.setHeader("X-ERP-Cache-Hit", out.cacheHit ? "1" : "0");
    if (out.cacheLayer) {
      res.setHeader("X-ERP-Cache-Layer", String(out.cacheLayer));
    }
    recordDataFreshnessFromPayload(out);
    const shaped = shapeAnalyticsResponse(out, req.body || {});
    sendJsonOrMsgpack(req, res, shaped);
  } catch (err) {
    if (err.status === 400) {
      res.status(400).json({
        error: err.code || "bad_request",
        message: err.message,
      });
      return;
    }
    console.error("[analytics-dashboard]", err);
    res.status(500).json({ error: "analytics_failed", message: String(err.message) });
  }
});

app.get("/api/analytics/version", rbac.requireFeature("data"), (_req, res) => {
  res.json({ dataVersion: getDataEpoch() });
});

/** Bump analytics cache epoch (admin / ETL hook). */
app.post("/api/analytics/invalidate-cache", rbac.requireAdminApi, (_req, res) => {
  res.json({ ok: true, dataVersion: bumpDataEpoch() });
});

/**
 * Server-Sent Events: dataVersion pings + broadcast on cache invalidation.
 */
app.get("/api/analytics/events", rbac.requireFeature("data"), (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  registerAnalyticsSse(res);
  const hello = JSON.stringify({ type: "hello", dataVersion: getDataEpoch(), t: new Date().toISOString() });
  res.write(`data: ${hello}\n\n`);
  const hb = setInterval(() => {
    try {
      const ping = JSON.stringify({ type: "ping", dataVersion: getDataEpoch(), t: Date.now() });
      res.write(`data: ${ping}\n\n`);
    } catch {
      clearInterval(hb);
      unregisterAnalyticsSse(res);
    }
  }, 25000);
  req.on("close", () => {
    clearInterval(hb);
    unregisterAnalyticsSse(res);
  });
});

/**
 * POST /api/analytics/drillthrough
 * Body: dataset, from, to, crossFilter?, branch?, limit? — raw slice (TOP limit) for investigation/export.
 */
app.post("/api/analytics/drillthrough", rbac.requireFeature("data"), async (req, res) => {
  let dk = "sales";
  try {
    const body = req.body || {};
    dk = String(body.dataset || "sales").toLowerCase().trim();
    if (req.rbac && !rbac.assertDatasetAllowed(req.rbac, dk)) {
      res.status(403).json({
        error: "dataset_denied",
        message: `You do not have access to dataset: ${dk}`,
      });
      return;
    }
    const limit = Math.min(Math.max(parseInt(String(body.limit || "500"), 10) || 500, 1), 5000);
    const q = buildDrillQueryObject(body);
    const table = resolveDrillDatasetTable(dk);
    if (!table) {
      res.status(400).json({ error: "unknown_dataset" });
      return;
    }
    const pool = await getPool();
    const result = await executeDatasetQueryWithReliability(
      () => runFilteredDatasetQuery(pool, table, dk, limit, q),
      { context: "POST /api/analytics/drillthrough", datasetKey: dk, limit, query: q }
    );
    res.setHeader("X-ERP-Drill-Rows", String(result.recordset.length));
    if (result.source === "mirror_fallback") {
      res.setHeader("X-ERP-Data-Source", "mirror_fallback");
      res.setHeader("X-ERP-Query-Degraded", "mirror_after_live_failure");
    }
    res.json({
      rowCount: result.recordset.length,
      data: rowsForJson(result.recordset),
      filters: q,
    });
  } catch (err) {
    if (err.status === 400) {
      res.status(400).json({
        error: err.code || "bad_request",
        message: err.message,
      });
      return;
    }
    console.error("[analytics-drillthrough]", err);
    res.status(500).json({ error: "drillthrough_failed", message: String(err.message) });
  }
});

/**
 * POST /api/query/ai
 * Body: { "question": "natural language..." }
 * Returns: { sql, rowCount, data } — SELECT only, validated; requires OPENAI_API_KEY.
 */
app.post("/api/query/ai", rbac.requireFeature("ai"), async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    res.status(503).json({
      error: "openai_not_configured",
      message: "Set OPENAI_API_KEY on the server",
    });
    return;
  }

  const question = String(req.body?.question ?? "").trim();
  if (!question) {
    res.status(400).json({ error: "missing_question", message: "Send JSON { question: \"...\" }" });
    return;
  }
  if (question.length > 4000) {
    res.status(400).json({ error: "question_too_long", max: 4000 });
    return;
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  let pool;
  try {
    pool = await getPool();
  } catch (err) {
    console.error("[ai-query] database unavailable:", err);
    res.status(503).json({
      error: "db_unavailable",
      message: String(err.message || err),
    });
    return;
  }

  const schemaContext = await ensureAiSchemaContext(pool);

  const guidedQuestion = `${question}${buildIntentGuidance(question)}`;

  /** Registry-wide allowlist + revenue guard (same as adaptive NL path). */
  const aiValidationCtx = buildAiValidationContext({ domain: inferAiDomain(guidedQuestion) });

  async function generateAndValidateSql(retryHint) {
    const q = retryHint ? `${retryHint}\n\nOriginal question:\n${guidedQuestion}` : guidedQuestion;
    const raw = await nlToSelectSql({
      apiKey: String(apiKey).trim(),
      model,
      question: q,
      schemaCatalog: schemaContext,
    });
    return finalizeGeneratedSelectSql(raw, aiValidationCtx);
  }

  let sqlText;
  try {
    sqlText = await generateAndValidateSql(null);
  } catch (err) {
    if (err.status === 400) {
      res.status(400).json({
        error: err.code || "bad_request",
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
      return;
    }
    if (err.code === "openai_quota_exceeded") {
      res.status(429).json({
        error: "openai_quota_exceeded",
        message: err.message,
        billingUrl: "https://platform.openai.com/account/billing",
        usageUrl: "https://platform.openai.com/usage",
      });
      return;
    }
    if (err.code === "openai_auth_failed") {
      res.status(503).json({
        error: "openai_auth_failed",
        message: err.message,
      });
      return;
    }
    if (err.code === "openai_api_error") {
      console.error("[ai-query] OpenAI API error:", err);
      res.status(502).json({
        error: "openai_api_error",
        message: String(err.message || err),
      });
      return;
    }
    console.error("[ai-query] generation failed:", err);
    res.status(500).json({
      error: "ai_generation_failed",
      message: String(err.message || err),
    });
    return;
  }

  try {
    let result = await pool.request().query(sqlText);
    let data = rowsForJson(result.recordset);
    res.json({
      sql: sqlText,
      rowCount: data.length,
      data,
      validation: "passed",
    });
  } catch (err) {
    const msg = String(err.message || err);
    if (!isRetryableAiSqlError(msg)) {
      console.error("[ai-query] execution failed:", err);
      res.status(500).json({
        error: "query_failed",
        message: msg,
        sql: sqlText,
      });
      return;
    }
    try {
      const hint = `[SQL EXECUTION FAILED — fix and regenerate ONE SELECT]\n${msg.slice(0, 500)}\n`;
      sqlText = await generateAndValidateSql(hint);
      const result = await pool.request().query(sqlText);
      const data = rowsForJson(result.recordset);
      res.json({
        sql: sqlText,
        rowCount: data.length,
        data,
        validation: "passed",
        retried: true,
      });
    } catch (err2) {
      console.error("[ai-query] execution/fallback failed:", err2);
      const validation = err2.code && String(err2.code).includes("validation");
      if (err2.status === 400 || validation) {
        res.status(400).json({
          error: err2.code || "sql_validation_failed",
          message: String(err2.message || err2),
          ...(err2.details ? { details: err2.details } : {}),
        });
        return;
      }
      res.status(500).json({
        error: "query_failed",
        message: String(err2.message || err2),
        sql: sqlText,
        priorError: msg,
      });
    }
  }
});

/* ─────────────────────────────────────────────────────────────
   DYNAMIC SCHEMA ENDPOINTS  (explorer + adaptive AI)
   ───────────────────────────────────────────────────────────── */

/**
 * GET /api/schema/objects
 * Returns ALL tables and views visible in INFORMATION_SCHEMA.
 * The sidebar uses this to populate the Explorer tab without any whitelist.
 */
app.get("/api/schema/objects", rbac.requireFeature("explorer"), async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        TABLE_SCHEMA  AS [schema],
        TABLE_NAME    AS [name],
        TABLE_TYPE    AS [type]
      FROM INFORMATION_SCHEMA.TABLES
      ORDER BY TABLE_TYPE DESC, TABLE_SCHEMA, TABLE_NAME
    `);
    const all = rowsForJson(result.recordset);
    res.json({
      tables: all.filter((o) => o.type === "BASE TABLE"),
      views:  all.filter((o) => o.type === "VIEW"),
      total:  all.length,
    });
  } catch (err) {
    console.error("[schema/objects]", err);
    res.status(500).json({ error: "schema_failed", message: String(err.message) });
  }
});

/**
 * GET /api/schema/columns/:schemaName/:objectName
 * Returns INFORMATION_SCHEMA.COLUMNS for one table or view.
 * Sidebar uses this when user clicks a DB object in the Explorer.
 */
app.get("/api/schema/columns/:schemaName/:objectName", rbac.requireFeature("explorer"), async (req, res) => {
  const schemaName = sanitizeIdentifier(req.params.schemaName);
  const objectName = sanitizeIdentifier(req.params.objectName);
  if (!schemaName || !objectName) {
    return res.status(400).json({ error: "invalid_name", message: "Invalid schema or object name" });
  }
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("sch", sql.NVarChar(128), schemaName)
      .input("obj", sql.NVarChar(128), objectName)
      .query(`
        SELECT
          COLUMN_NAME        AS column_name,
          DATA_TYPE          AS data_type,
          IS_NULLABLE        AS is_nullable,
          CHARACTER_MAXIMUM_LENGTH AS max_length,
          NUMERIC_PRECISION  AS numeric_precision,
          NUMERIC_SCALE      AS numeric_scale,
          ORDINAL_POSITION   AS ordinal_position
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @sch AND TABLE_NAME = @obj
        ORDER BY ORDINAL_POSITION
      `);
    res.json(rowsForJson(result.recordset));
  } catch (err) {
    console.error("[schema/columns]", err);
    res.status(500).json({ error: "columns_failed", message: String(err.message) });
  }
});

/**
 * GET /api/schema/preview/:schemaName/:objectName?limit=10
 * Returns up to 50 live rows from any table or view.
 * Sidebar uses this for "Load preview" quick action in Explorer.
 */
app.get("/api/schema/preview/:schemaName/:objectName", rbac.requireFeature("explorer"), async (req, res) => {
  const schemaName = sanitizeIdentifier(req.params.schemaName);
  const objectName = sanitizeIdentifier(req.params.objectName);
  if (!schemaName || !objectName) {
    return res.status(400).json({ error: "invalid_name" });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 50);
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input("lim", sql.Int, limit);
    const result = await request.query(
      `SELECT TOP (@lim) * FROM [${schemaName}].[${objectName}]`
    );
    res.setHeader("X-ERP-Data-Source", "live");
    res.json(rowsForJson(result.recordset));
  } catch (err) {
    console.error("[schema/preview]", err);
    res.status(500).json({ error: "preview_failed", message: String(err.message) });
  }
});

/**
 * POST /api/query/adaptive
 * Body: { question: string, tableHint?: "schema.ObjectName" }
 *
 * Prepends live column lists for: optional Explorer tableHint; and for
 * purchase/vendor/supplier-style questions, dbo.VW_MB_POWERBI_PUR_REPORT,
 * VW_MB_POWERBI_SUPPLIER_PUR_REPORT, VwAISupplier (so SQL uses real purchase columns, not sales-line guesses).
 */
app.post("/api/query/adaptive", rbac.requireFeature("ai"), async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    return res.status(503).json({
      error: "openai_not_configured",
      message: "Set OPENAI_API_KEY on the server",
    });
  }

  let question = String(req.body?.question ?? "").trim();
  if (!question) {
    return res.status(400).json({ error: "missing_question", message: 'Send JSON { question: "..." }' });
  }
  if (question.length > 4000) {
    return res.status(400).json({ error: "question_too_long", max: 4000 });
  }

  const guidancePrep = prepareQuestionForPipeline(question);
  if (!guidancePrep.ok) {
    return res.json(toAdaptiveClarificationResponse(guidancePrep));
  }
  question = guidancePrep.question;
  const userGuidanceMeta = {
    autoCorrections: guidancePrep.autoCorrections || [],
    originalQuestion: guidancePrep.originalQuestion,
    dimensionIndexStale: guidancePrep.indexStale,
  };

  const tableHint = String(req.body?.tableHint ?? "").trim(); // e.g. "dbo.VwAISalesData"
  const fromDate = req.body?.fromDate ? String(req.body.fromDate).trim() : "";
  const toDate = req.body?.toDate ? String(req.body.toDate).trim() : "";
  // provider: "openai" (default) | "claude" — sent by dashboard AI model toggle
  const aiProvider  = String(req.body?.provider ?? "openai").toLowerCase().trim();
  const isClaude    = aiProvider === "claude";
  const model       = isClaude
    ? (process.env.ANTHROPIC_MODEL || "claude-opus-4-5")
    : (process.env.OPENAI_MODEL || "gpt-4o-mini");
  const claudeApiKey = isClaude ? (process.env.ANTHROPIC_API_KEY || "") : undefined;
  const forceMode = String(req.body?.forceMode ?? "").trim().toLowerCase(); // "langgraph" | ""

  // ── LangGraph forced mode: fast templates + RAG, then LangGraph ───────────
  if (forceMode === "langgraph") {
    let pool;
    try { pool = await getPool(); } catch (err) {
      return res.status(503).json({ error: "db_unavailable", message: String(err.message) });
    }
    if (
      await tryDeterministicFastPatterns(res, {
        question,
        pool,
        fromDate,
        toDate,
        apiKey,
        model,
        tableHint,
      })
    ) {
      return;
    }
    if (
      await tryRagVerifiedFastPath(res, {
        question,
        pool,
        fromDate,
        toDate,
        tableHint,
        apiKey,
        model,
        userId: req.rbac?.email,
      })
    ) {
      return;
    }
    try {
      const dateContext = buildDateContext();
      const userDateRange = {};
      if (fromDate) userDateRange.from = fromDate;
      if (toDate)   userDateRange.to   = toDate;
      const lg = await runLangChainQuery({
        apiKey:       String(apiKey || "").trim(),
        model,
        provider:     aiProvider,
        claudeApiKey,
        question,
        pool,
        dateContext,
        userDateRange,
        tableHint: tableHint || undefined,
      });
      if (lg.clarificationNeeded) {
        return res.json({
          clarificationNeeded: true,
          clarificationQuestion: lg.clarificationQuestion,
          clarificationOptions: lg.clarificationOptions || [],
          suggestedOptions: lg.suggestedOptions || [],
          uiType: lg.uiType || "SUGGESTION_CHIPS",
          status: "CLARIFICATION_REQUIRED",
          mode: "pre_flight_clarification",
          preFlightMs: lg.preFlightMs,
          clarityScore: lg.clarityScore,
          tableHint: tableHint || null,
          userGuidanceMeta,
        });
      }
      if (detectExportIntent(question) && lg.sql) {
        respondAsyncExport(res, { question, sql: lg.sql, pool, userId: req.rbac?.email });
        return;
      }
      const data = rowsForJson(lg.data || []);
      const tags = tagColumnsByValues(data);
      const intent = classifyQueryIntent(question);
      const lgShape = detectResultShape(data, tags);
      const lgIntent = reconcileIntentTypeForResponse(question, intent.type, data);
      const lgChartRaw = lgShape.chartType || intent.chartPolicy || "auto";
      const lgChart = preferChartForTrendQuestion(question, lgIntent, lgChartRaw);
      const drillDownSuggestions = await maybeDrillDownSuggestions({
        apiKey: String(apiKey).trim(),
        model,
        question,
        data,
        intentType: lgIntent,
        tableHint,
      });
      return res.json({
        sql: lg.sql,
        rowCount: data.length,
        data,
        mode: lg.fastPath ? "fast_path" : "langgraph",
        tableHint: tableHint || null,
        summary: lg.answer || null,
        intentType: lgIntent,
        intentDescription:
          "Adaptive agent — schema RAG → intent resolution → T-SQL → self-healing retry (AskYourDatabase-style)",
        chartPolicy: lgChart,
        resultShape: lgShape.shape,
        dataSource: "full_aggregate",
        contractPassed: data.length > 0,
        contractIssues: data.length === 0 ? ["No rows returned"] : [],
        contractWarnings: [],
        columnTags: tags,
        confidence: lg.confidence || "medium",
        confidenceNote: lg.confidenceNote || "",
        retryCount: lg.retryCount || 0,
        _langchainNodes: lg.nodeLog || [],
        _langchainRetries: lg.retryCount || 0,
        drillDownSuggestions,
      });
    } catch (lgErr) {
      console.error("[adaptive] LangGraph forced mode error:", lgErr.message);
      return res.status(500).json({ error: "langgraph_error", message: String(lgErr.message) });
    }
  }

  // Follow-up analysis mode: when UI passes contextData from the currently shown table,
  // answer from those rows only (no SQL regeneration/execution).
  const contextData = req.body?.contextData || null;
  if (contextData && Array.isArray(contextData.data)) {
    try {
      const rows = contextData.data
        .filter((r) => r && typeof r === "object")
        .slice(0, 2000);
      const answer = await analyzeDataResult({
        apiKey: String(apiKey).trim(),
        model,
        question,
        previousQuestion: String(contextData.previousQuestion || ""),
        previousSQL: String(contextData.previousSQL || ""),
        data: rows,
      });
      return res.json({
        type: "analysis",
        answer,
        basedOnRows: rows.length,
        mode: "context_followup",
      });
    } catch (followErr) {
      console.warn("[adaptive] follow-up analysis failed:", followErr.message);
      return res.status(500).json({
        error: "followup_analysis_failed",
        message: String(followErr.message || followErr),
      });
    }
  }

  // ── Raw SQL short-circuit: execute user-provided SQL directly, skip AI ──────
  const rawSql = String(req.body?.rawSql ?? "").trim();
  if (rawSql) {
    let rawPool;
    try { rawPool = await getPool(); } catch (err) {
      return res.status(503).json({ error: "db_unavailable", message: String(err.message) });
    }
    try {
      const rawResult = await rawPool.request().query(rawSql);
      const data = rowsForJson(rawResult.recordset || []);
      const tags = tagColumnsByValues(data);
      const intent = classifyQueryIntent(question);
      const shape = detectResultShape(data, tags);
      const intentType = reconcileIntentTypeForResponse(question, intent.type, data);
      const chartPolicyBase = shape.chartType || intent.chartPolicy || "auto";
      const chartPolicy = preferChartForTrendQuestion(question, intentType, chartPolicyBase);
      return res.json({
        sql: rawSql,
        rowCount: data.length,
        data,
        mode: "raw_sql_template",
        tableHint: null,
        summary: null,
        intentType,
        intentDescription: "User-saved SQL template — executed directly",
        chartPolicy,
        resultShape: shape.shape,
        dataSource: "raw_sql",
        contractPassed: data.length >= 0,
        contractIssues: [],
        contractWarnings: [],
        columnTags: tags,
        confidence: "high",
        confidenceNote: "Executed saved SQL template verbatim — no AI generation",
        retryCount: 0,
      });
    } catch (rawErr) {
      console.error("[adaptive] rawSql execution error:", rawErr.message);
      return res.status(400).json({
        error: "raw_sql_error",
        message: String(rawErr.message),
        sql: rawSql,
      });
    }
  }

  let pool;
  try {
    pool = await getPool();
  } catch (err) {
    return res.status(503).json({ error: "db_unavailable", message: String(err.message) });
  }

  if (
    await tryDeterministicFastPatterns(res, {
      question,
      pool,
      fromDate,
      toDate,
      apiKey,
      model,
      tableHint,
    })
  ) {
    return;
  }

  if (
    await tryRagVerifiedFastPath(res, {
      question,
      pool,
      fromDate,
      toDate,
      tableHint,
      apiKey,
      model,
      userId: req.rbac?.email,
    })
  ) {
    return;
  }

  // Single deterministic path first: strict intent -> semantic mapping -> SQL templates.
  try {
    const deterministic = await runDeterministicQuery({
      apiKey: String(apiKey).trim(),
      model,
      question,
      pool,
      fromDate,
      toDate,
    });
    if (deterministic?.handled) {
      if (
        deterministic.intent &&
        String(deterministic.intent.confidence || "").toLowerCase() === "low" &&
        deterministic.intent.clarification_question
      ) {
        return res.json({
          clarificationNeeded: true,
          clarificationQuestion: deterministic.intent.clarification_question,
          mode: "deterministic",
          intentType: String(deterministic.intent.intent || "generic"),
        });
      }
      const data = rowsForJson(deterministic.data || []);
      const tags = tagColumnsByValues(data);
      const intentTypeRaw = String(deterministic.intent?.intent || "generic");
      const intentType = reconcileIntentTypeForResponse(question, intentTypeRaw, data);
      const shapeChart = chartPolicyFromResultShape(data);
      const chartPolicyBase =
        shapeChart !== "table" ? shapeChart : deterministic.chartPolicy ||
        (intentType === "trend" ? "line" :
          intentType === "top_n" || intentType === "breakdown" ? "bar" :
          intentType === "kpi" ? "kpi_card" : "auto");
      const chartPolicy = preferChartForTrendQuestion(question, intentType, chartPolicyBase);
      const plannerLogicalPlan = deterministic.intent?.planner?.logicalPlan ?? null;
      const drillDownSuggestions = await maybeDrillDownSuggestions({
        apiKey: String(apiKey).trim(),
        model,
        question,
        data,
        intentType,
        tableHint,
      });
      return res.json({
        sql: deterministic.sql,
        rowCount: data.length,
        data,
        mode: "deterministic",
        tableHint: tableHint || null,
        summary: deterministic.summary || null,
        intentType,
        intentDescription: "Deterministic semantic-template pipeline",
        chartPolicy,
        dataSource: "full_aggregate",
        contractPassed: deterministic.reliability?.ok !== false,
        contractIssues: deterministic.reliability?.ok ? [] : [deterministic.reliability?.reason || "reliability_check_failed"],
        contractWarnings: deterministic.reliability?.reason === "fallback_applied" ? ["Applied deterministic fallback query for higher accuracy."] : [],
        columnTags: tags,
        confidence: deterministic.confidence?.level || "high",
        confidenceNote: deterministic.confidence?.note || "",
        retryCount: deterministic.retriesUsed || 0,
        interpretation: deterministic.interpretation || null,
        logicalPlan: plannerLogicalPlan,
        drillDownSuggestions,
      });
    }
  } catch (detErr) {
    console.warn("[adaptive] deterministic pipeline skipped:", detErr.message);
  }

  // ── Semantic parser runs FIRST — before any LLM fallback ──────────────────
  // Same input → same intent every time. Used by LangGraph fallback AND main path.
  const parsedIntent = parseQuery(question);
  const semanticConstraints = buildIntentConstraints(parsedIntent);

  // Optional fallback: deterministic-first, then LangGraph for hard/edge queries.
  // Skip LangGraph for comparison queries — it generates trend queries instead of UNION ALL.
  const langgraphFallbackOn = !/^(0|false|no)$/i.test(String(process.env.DETERMINISTIC_LANGGRAPH_FALLBACK || "1").trim());
  const skipLGForComparison = parsedIntent.queryType === "comparison";
  if (langgraphFallbackOn && !skipLGForComparison) {
    try {
      const dateContext = buildDateContext();
      const userDateRange = {};
      if (fromDate) userDateRange.from = fromDate;
      if (toDate) userDateRange.to = toDate;
      // Pass semantic constraints so LangGraph uses correct SQL structure
      const lgQuestion = semanticConstraints
        ? `${question}${semanticConstraints}`
        : question;
      const lg = await runLangChainQuery({
        apiKey:       String(apiKey || "").trim(),
        model,
        provider:     aiProvider,
        claudeApiKey,
        question:     lgQuestion,
        pool,
        dateContext,
        userDateRange,
        tableHint: tableHint || undefined,
      });
      if (lg.clarificationNeeded) {
        return res.json({
          clarificationNeeded: true,
          clarificationQuestion: lg.clarificationQuestion,
          clarificationOptions: lg.clarificationOptions || [],
          suggestedOptions: lg.suggestedOptions || [],
          uiType: lg.uiType || "SUGGESTION_CHIPS",
          status: "CLARIFICATION_REQUIRED",
          mode: "pre_flight_clarification",
          preFlightMs: lg.preFlightMs,
          clarityScore: lg.clarityScore,
          tableHint: tableHint || null,
          userGuidanceMeta,
        });
      }
      if (lg.fastPath && Array.isArray(lg.data) && lg.data.length >= 0) {
        const data = rowsForJson(lg.data || []);
        const tags = tagColumnsByValues(data);
        const intent = classifyQueryIntent(question);
        const lgShape = detectResultShape(data, tags);
        const lgIntent = reconcileIntentTypeForResponse(question, intent.type, data);
        const lgChart = preferChartForTrendQuestion(question, lgIntent, lgShape.chartType || "kpi_card");
        return res.json({
          sql: lg.sql,
          rowCount: data.length,
          data,
          mode: "fast_path",
          tableHint: tableHint || null,
          summary: lg.answer || null,
          intentType: lgIntent,
          intentDescription: "Pre-flight cached SQL (no LLM planning)",
          chartPolicy: lgChart,
          resultShape: lgShape.shape,
          dataSource: "fast_path_cache",
          contractPassed: true,
          contractIssues: [],
          columnTags: tags,
          confidence: "high",
          confidenceNote: `Fast path ${lg.preFlightMs}ms`,
          retryCount: 0,
          preFlightMs: lg.preFlightMs,
        });
      }
      if (Array.isArray(lg.data) && lg.data.length > 0) {
        const data = rowsForJson(lg.data);
        const tags = tagColumnsByValues(data);
        const intent = classifyQueryIntent(question);
        // Shape-based chart detection — not name guessing
        const lgShape = detectResultShape(data, tags);
        const lgIntent = reconcileIntentTypeForResponse(question, intent.type, data);
        const lgChartRaw =
          lgShape.chartType || (lgShape.shape !== "table" ? lgShape.chartType : intent.chartPolicy) || "auto";
        const lgChart = preferChartForTrendQuestion(question, lgIntent, lgChartRaw);
        return res.json({
          sql: lg.sql,
          rowCount: data.length,
          data,
          mode: "deterministic_langgraph_fallback",
          tableHint: tableHint || null,
          summary: lg.answer || null,
          intentType: lgIntent,
          intentDescription: "Deterministic pipeline with LangGraph fallback",
          chartPolicy: lgChart,
          resultShape: lgShape.shape,
          dataSource: "full_aggregate",
          contractPassed: true,
          contractIssues: [],
          contractWarnings: ["Fallback path used LangGraph execution for higher recovery."],
          columnTags: tags,
          confidence: lg.confidence || "medium",
          confidenceNote: lg.confidenceNote || "",
          retryCount: lg.retryCount || 0,
        });
      }
    } catch (lgErr) {
      console.warn("[adaptive] langgraph fallback skipped:", lgErr.message);
    }
  }

  // ── Classify intent before SQL generation ──────────────────────────────────
  const queryIntent = classifyQueryIntent(question);

  // Cached schema + Explorer table hint + keyword-based purchase/vendor view columns
  let schemaContext = await ensureAiSchemaContext(pool);
  schemaContext = await augmentSchemaWithFocusedTables(pool, schemaContext, question, tableHint);

  // Append intent-specific output contract guidance to the prompt
  function buildIntentContractGuidance(intent) {
    if (!intent || intent.type === "generic") return "";
    const lines = ["\n\n[OUTPUT CONTRACT — follow exactly or the result will be rejected]"];
    if (intent.type === "trend") {
      lines.push(
        "- This is a TREND query. Your SELECT MUST include:",
        "  1. A date/time label column (e.g. XnDt, XnDtMonth, or FORMAT(XnDt,'MMM yyyy') AS SaleMonth).",
        "  2. At least one numeric metric column (e.g. SUM(MrpValue) AS TotalSales).",
        "  3. An ORDER BY on the date column (ascending).",
        "  Do NOT return only totals without a time axis."
      );
    } else if (intent.type === "top_n") {
      lines.push(
        "- This is a RANKING query. Your SELECT MUST include:",
        "  1. A readable label column (product name, customer name, branch name — NOT just an ID).",
        "  2. A numeric metric column (SUM of amount/revenue/value — NOT quantity unless asked).",
        "  3. ORDER BY the metric DESC.",
        "  Use TOP (N) clause. Always join master tables for readable names."
      );
    } else if (intent.type === "aov") {
      lines.push(
        "- This is an AVERAGE ORDER VALUE query. Your SELECT MUST include:",
        "  1. A readable label column (BranchName, CategoryName, or 'Overall' — NOT an ID).",
        "  2. An AVG column named AvgOrderValue computed as AVG of per-invoice totals.",
        "  Algorithm: inner subquery sums SaleNetAmount per (InvoiceId, <branch key col>) from dbo.VwAISalesData,",
        "  then JOIN dbo.VwAIBranch on the shared branch key column (look it up in FOCUSED TABLE — never guess).",
        "  Outer query: AVG(OrderTotal) AS AvgOrderValue, GROUP BY b.BranchName ORDER BY AvgOrderValue DESC.",
        "  ❌ Do NOT use AVG(SaleNetAmount) directly — averages line items, not orders.",
        "  ❌ Do NOT skip the inner subquery.",
        "  ❌ NEVER use a column name not present in the FOCUSED TABLE block for that table."
      );
    } else if (intent.type === "breakdown") {
      lines.push(
        "- This is a DISTRIBUTION/BREAKDOWN query. Your SELECT MUST include:",
        "  1. A readable dimension label column (branch name, category, department — NOT just ID).",
        "  2. A numeric metric column (SUM of amount/revenue).",
        "  3. ORDER BY the metric DESC.",
        "  Join master tables as needed for readable names."
      );
    } else if (intent.type === "period_dashboard") {
      lines.push(
        "- This question is scoped to a calendar period (today / MTD / YTD / this quarter).",
        " Use dbo.VW_MB_POWERBI_APP_REPORT, filter on CAST(XnDt AS date), aggregate SUM(MrpValue).",
        " MTD: XnDt >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND XnDt <= CAST(GETDATE() AS date).",
        " Map user term SaleNetAmount → MrpValue."
      );
    } else if (intent.type === "kpi") {
      lines.push(
        "- This is a KPI/AGGREGATE query. Return one or more named aggregate columns.",
        "  e.g. SELECT SUM(MrpValue) AS TotalSales, COUNT(DISTINCT XnNo) AS TotalBills FROM dbo.VW_MB_POWERBI_APP_REPORT ..."
      );
    }
    return lines.join("\n");
  }

  // parsedIntent + semanticConstraints already computed above (before LangGraph fallback).
  // Domain-specific ERP guidance stacked after structural constraints.
  const guidedQuestion = `${question}${semanticConstraints}${buildIntentGuidance(question)}${buildIntentContractGuidance(queryIntent)}`;

  let sqlText;
  try {
    sqlText = await nlToSelectSql({
      apiKey: String(apiKey).trim(),
      model,
      question: guidedQuestion,
      schemaCatalog: schemaContext,
    });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.code || "bad_request", message: err.message });
    }
    if (err.code === "openai_quota_exceeded") {
      return res.status(429).json({
        error: "openai_quota_exceeded",
        message: err.message,
        billingUrl: "https://platform.openai.com/account/billing",
      });
    }
    if (err.code === "openai_auth_failed") {
      return res.status(503).json({ error: "openai_auth_failed", message: err.message });
    }
    console.error("[adaptive]", err);
    return res.status(500).json({ error: "ai_generation_failed", message: String(err.message) });
  }

  const validationCtx = buildAiValidationContext({ domain: inferAiDomain(question), registry: DATASET_REGISTRY });

  // Helper: errors the AI can fix if given feedback
  function isRetryableSqlError(msg) {
    return /invalid column name|operand type clash|conversion failed|is incompatible with|cannot convert|ambiguous column name/i.test(String(msg));
  }

  /**
   * Lightweight semantic guard: detect SQL/question mismatch before execution.
   * Returns issues that should trigger SQL regeneration.
   */
  function semanticSqlIssues(questionText, sqlAttempt) {
    const q = String(questionText || "").toLowerCase();
    const s = String(sqlAttempt || "").toLowerCase();
    const out = [];
    const has = (re) => re.test(q);
    const sqlHas = (re) => re.test(s);

    const asksTopProduct = has(/\b(top|highest|best)\b/) && has(/\b(product|products|item|items|sku|article)\b/) && has(/\b(sales|revenue|amount|value)\b/);
    if (asksTopProduct) {
      const hasReadableName = sqlHas(/\b(productname|description|articleshortname|itemcode|item_name|stockname)\b/);
      if (!hasReadableName) {
        out.push("Top product question should return readable product name, not only ItemId.");
      }
    }

    const asksVendorByAmount = has(/\b(vendor|supplier)\b/) && has(/\b(purchase)\b/) && has(/\b(amount|value|cost|net)\b/);
    if (asksVendorByAmount) {
      const usesQtyOnly = sqlHas(/sum\s*\(\s*purqty\s*\)/) && !sqlHas(/\b(amount|value|cost|net|amt)\b/);
      if (usesQtyOnly) {
        out.push("Vendor purchase amount question is using quantity instead of amount/value column.");
      }
    }

    const asksAov = has(/\b(average order value|aov)\b/);
    if (asksAov) {
      if (!sqlHas(/\bavg\s*\(/) || !sqlHas(/\binvoiceid\b/)) {

        out.push("Average order value should average invoice-level totals (InvoiceId-based).");
      }
    }

    const asksZeroSalesBranch = has(/\b(branch|branches)\b/) && has(/\b(zero sales|no sales|without sales)\b/);
    if (asksZeroSalesBranch) {
      const hasAntiJoinPattern = sqlHas(/\bleft join\b|\bnot exists\b|\bhaving\s+count\s*\(/);
      if (!hasAntiJoinPattern) {
        out.push("Zero-sales branches should use branch master with LEFT JOIN/NOT EXISTS anti-join pattern.");
      }
    }

    const asksDateScoped = has(/\b(today|yesterday|last\s*\d+\s*days?|last\s*7|last\s*30|last\s*90|this\s*week|this\s*month|last\s*month|this\s*year|last\s*year|this\s*quarter)\b/);
    if (asksDateScoped) {
      // Accept date predicates in WHERE *or* JOIN ON clauses (both are valid T-SQL).
      const hasDateFunction = sqlHas(/\b(getdate\s*\(|dateadd\s*\(|year\s*\(\s*getdate|month\s*\(\s*getdate|datepart\s*\()/);
      const hasDateColumn = /invoicedt|invoicedate|purchasedt|purchasedate|docdt|docdate|transdt|saledt|entrydt|\bdate\b|\bdt\b/.test(s);
      if (!hasDateFunction) {
        out.push(
          "Date-scoped question must use SQL Server date functions: DATEADD(day,-N,CAST(GETDATE() AS DATE)). " +
          "Do NOT subtract integers from dates with '-'. Put the date filter in WHERE or JOIN ON clause."
        );
      } else if (!hasDateColumn) {
        out.push(
          "Date-scoped question should filter on a date column (e.g. InvoiceDt, PurchaseDt, DocDt). " +
          "Check the FOCUSED TABLE columns list and use the correct date column name."
        );
      }
    }

    return out;
  }

  // Run SQL; on retryable errors, regenerate SQL (up to 3 executions: initial + 2 retries)
  async function runWithAutoRetry(firstSql) {
    function buildSqlErrorHint(msg) {
      const m = String(msg || "");
      const hints = [];

      // ── Generic: extract the bad column name and forbid it explicitly ──────
      const badColMatch = m.match(/invalid column name '(\w+)'/i);
      if (badColMatch) {
        const badCol = badColMatch[1];
        hints.push(
          `- Column '${badCol}' does NOT EXIST in any table currently in the query.`,
          `- NEVER use '${badCol}' in the rewritten SQL — not in SELECT, WHERE, JOIN ON, GROUP BY, or ORDER BY.`,
          `- Open the FOCUSED TABLE block in the schema and find the nearest equivalent column name for what you need.`,
          `- Common mistakes: BranchId→BranchAlias (purchase views) | DepartmentShortName→InvDepartmentName (item views) | NetAmount→SaleNetAmount or NetSlsNetAmount | CustomerName→CustomerFirstName+CustomerLastName`
        );
      }

      // ── Specific overrides (more targeted advice) ────────────────────────
      if (/invalid column name 'BranchId'/i.test(m)) {
        hints.push(
          "- 'BranchId' does NOT exist in the view being queried.",
          "- For dbo.VwAISalesData: look at the FOCUSED TABLE column list — the branch key may be named BranchCode, BranchAlias, StoreId, or something else entirely.",
          "- For purchase views (VW_MB_POWERBI_PUR_REPORT etc.): the branch column is BranchAlias, not BranchId.",
          "- NEVER guess a branch column name — use ONLY what appears in the FOCUSED TABLE block."
        );
      }
      if (/invalid column name 'BranchAlias'/i.test(m)) {
        hints.push(
          "- BranchAlias is not in the current focused view. Use BranchId or BranchName from the focused schema, or join dbo.VwAIBranch only if it appears in the schema context."
        );
      }
      if (/invalid column name 'DepartmentShortName'/i.test(m)) {
        hints.push(
          "- DepartmentShortName is not present here. Use InvDepartmentName (item views) or omit the department filter."
        );
      }
      if (/invalid column name 'SupplierName'/i.test(m)) {
        hints.push(
          "- Check the FOCUSED TABLE schema for the exact supplier name column (may be PartyName, SupplierAlias, or SupplierName only in certain views)."
        );
      }
      if (/multi-part identifier/i.test(m) && /could not be bound/i.test(m)) {
        hints.push(
          "- Multi-part identifier error: you used alias.column but that alias is not declared in FROM/JOIN.",
          "- Only use table aliases that are explicitly defined in the FROM or JOIN clauses."
        );
      }
      return hints.length ? (`\n${hints.join("\n")}\n`) : "";
    }

    let sqlAttempt = firstSql;
    let lastMsg = "";
    const MAX_ATTEMPTS = 4;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let validatedSql;
      try {
        validatedSql = finalizeGeneratedSelectSql(sqlAttempt, validationCtx);
      } catch (vErr) {
        lastMsg = `[validation] ${vErr.message}`;
        if (attempt >= MAX_ATTEMPTS - 1) {
          const combined = new Error(
            `[SQL failed static validation after ${MAX_ATTEMPTS} attempt(s)] ${lastMsg}\n(First SQL: ${String(firstSql).slice(0, 200)}…)`
          );
          combined.originalSql = firstSql;
          combined.retrySql = sqlAttempt;
          combined.code = vErr.code;
          throw combined;
        }
        console.warn("[adaptive] static validation – auto-retry", attempt + 1, lastMsg.slice(0, 200));
        try {
          sqlAttempt = await nlToSelectSql({
            apiKey: String(apiKey).trim(),
            model,
            question:
              `[STATIC SQL VALIDATION FAILED]\n${lastMsg}\n\n` +
              `Regenerate ONE SELECT only. Rules:\n` +
              `- Use only allowlisted Power BI views (dbo.VW_MB_POWERBI_*). Never dbo.VwAISalesData.\n` +
              `- Every JOIN must have ON. TOP must be within server limits.\n` +
              `- Revenue: SUM(MrpValue) on APP_REPORT; NetAmount/NetSlsNetAmount on SLS* views. Map SaleNetAmount → MrpValue.\n` +
              `Original question: ${guidedQuestion}`,
            schemaCatalog: schemaContext,
          });
        } catch (genErr) {
          const combined = new Error(`${lastMsg}\n(Regeneration failed: ${String(genErr.message || genErr)})`);
          combined.originalSql = firstSql;
          throw combined;
        }
        continue;
      }

      const semanticIssues = semanticSqlIssues(question, validatedSql);
      if (semanticIssues.length) {
        lastMsg = `[semantic_mismatch] ${semanticIssues.join(" | ")}`;
        if (attempt >= MAX_ATTEMPTS - 1) {
          const combined = new Error(
            `[SQL rejected by semantic guard after ${MAX_ATTEMPTS} attempt(s)] ${lastMsg}\n(First SQL: ${String(firstSql).slice(0, 200)}…)`
          );
          combined.originalSql = firstSql;
          combined.retrySql = sqlAttempt;
          throw combined;
        }
        console.warn("[adaptive] semantic mismatch – auto-retry", attempt + 1, lastMsg.slice(0, 220));
        const retryQuestion =
          `[PREVIOUS SQL REJECTED — REASON]: ${lastMsg}\n\n` +
          `Fix the issue above and regenerate ONE SELECT statement only. Rules:\n` +
          `- Use ONLY column names from the FOCUSED TABLE block in the schema. Never invent columns.\n` +
          `- For date filters: always use DATEADD(day,-N,CAST(GETDATE() AS DATE)). NEVER subtract integers from dates with "-".\n` +
          `- Date filter may appear in WHERE or in a JOIN ON clause — both are valid.\n` +
          `- "Today": XnDt >= CAST(GETDATE() AS DATE) AND XnDt < DATEADD(day,1,CAST(GETDATE() AS DATE))\n` +
          `- "Yesterday": XnDt >= DATEADD(day,-1,CAST(GETDATE() AS DATE)) AND XnDt < CAST(GETDATE() AS DATE)\n` +
          `- "Last 7 days": XnDt >= DATEADD(day,-7,CAST(GETDATE() AS DATE))\n` +
          `- "This month": CAST(XnDt AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)\n` +
          `- Use dbo.VW_MB_POWERBI_APP_REPORT and MrpValue for sales; replace XnDt only if another allowlisted view is in schema.\n` +
          `Original question: ${guidedQuestion}`;
        try {
          sqlAttempt = await nlToSelectSql({
            apiKey: String(apiKey).trim(),
            model,
            question: retryQuestion,
            schemaCatalog: schemaContext,
          });
          continue;
        } catch (genErr) {
          const combined = new Error(`${lastMsg}\n(Regeneration failed: ${String(genErr.message || genErr)})`);
          combined.originalSql = firstSql;
          throw combined;
        }
      }
      try {
        const r = await pool.request().query(validatedSql);
        return {
          sql: validatedSql,
          recordset: r.recordset,
          retried: attempt > 0,
          originalSql: attempt > 0 ? firstSql : undefined,
        };
      } catch (err) {
        lastMsg = String(err.message || err);
        const retryable = isRetryableSqlError(lastMsg);
        if (!retryable) {
          const e = attempt > 0
            ? Object.assign(
                new Error(`[SQL failed after ${attempt + 1} attempt(s)] ${lastMsg}`),
                { originalSql: firstSql, retrySql: sqlAttempt }
              )
            : err;
          throw e;
        }
        if (attempt >= MAX_ATTEMPTS - 1) {
          const combined = new Error(
            `[SQL failed after ${MAX_ATTEMPTS} attempt(s)] ${lastMsg}\n(First SQL: ${String(firstSql).slice(0, 200)}…)`
          );
          combined.originalSql = firstSql;
          combined.retrySql = sqlAttempt;
          throw combined;
        }
        console.warn("[adaptive] SQL error – auto-retry", attempt + 1, lastMsg.slice(0, 180));
        const retryQuestion =
          `[SQL EXECUTION FAILED — ERROR]: ${lastMsg.slice(0, 450)}\n\n` +
          `Fix the error above and regenerate ONE SELECT only. Follow ALL these rules:\n` +
          `- Use ONLY column names from the FOCUSED TABLE block in the schema. Check exact spelling.\n` +
          `- NEVER invent columns: not NetAmount, not InvCategoryName, not ProductName unless listed.\n` +
          `- Invalid column name error → find the correct column name in the FOCUSED TABLE block.\n` +
          `- Operand type clash → you used date arithmetic with "-" or "+". Fix: use DATEADD(day,-N,CAST(GETDATE() AS DATE)).\n` +
          `- Ambiguous column name → qualify every column with its table alias (e.g. s.InvoiceDt, b.BranchId).\n` +
          `- For dates: "today" → DateCol >= CAST(GETDATE() AS DATE) AND DateCol < DATEADD(day,1,CAST(GETDATE() AS DATE))\n` +
          `- For dates: "last 7 days" → DateCol >= DATEADD(day,-7,CAST(GETDATE() AS DATE))\n` +
          `- For dates: "this month" → YEAR(DateCol)=YEAR(GETDATE()) AND MONTH(DateCol)=MONTH(GETDATE())\n` +
          `Original question: ${guidedQuestion}`;
        try {
          sqlAttempt = await nlToSelectSql({
            apiKey: String(apiKey).trim(),
            model,
            question: retryQuestion,
            schemaCatalog: schemaContext,
          });
        } catch (genErr) {
          const combined = new Error(`${lastMsg}\n(Regeneration failed: ${String(genErr.message || genErr)})`);
          combined.originalSql = firstSql;
          throw combined;
        }
      }
    }
    throw new Error(lastMsg || "query failed");
  }

  try {
    let { sql: finalSql, recordset, retried, originalSql } = await runWithAutoRetry(sqlText);
    let data = rowsForJson(recordset);

    // ── Post-query contract validation ──────────────────────────────────────
    let contractResult = validateResultContract(queryIntent, data);
    let contractRetried = false;

    if (!contractResult.passed && data.length > 0) {
      // One auto-regeneration pass with the contract issues appended
      console.warn("[adaptive] contract fail – auto-retry with contract guidance:", contractResult.issues);
      const contractRetryQ =
        `[CONTRACT VALIDATION FAILED]\nIssues: ${contractResult.issues.join(" | ")}\n\n` +
        `Fix the issues above and regenerate ONE SELECT statement. ` +
        `The output contract for intent "${queryIntent.type}" is:\n` +
        `${queryIntent.description}\n\n` +
        `Original question: ${guidedQuestion}`;
      try {
        const retryRaw = await nlToSelectSql({
          apiKey: String(apiKey).trim(),
          model,
          question: contractRetryQ,
          schemaCatalog: schemaContext,
        });
        const retrySql = finalizeGeneratedSelectSql(retryRaw, validationCtx);
        const retryResult = await pool.request().query(retrySql);
        const retryData = rowsForJson(retryResult.recordset);
        const retryContract = validateResultContract(queryIntent, retryData);
        if (retryContract.passed || retryData.length > 0) {
          finalSql = retrySql;
          data = retryData;
          contractResult = retryContract;
          contractRetried = true;
          console.log("[adaptive] contract retry succeeded for intent:", queryIntent.type);
        }
      } catch (retryErr) {
        console.warn("[adaptive] contract retry failed:", retryErr.message);
        // Keep original data -- contract warnings will surface to UI
      }
    }

    // Column semantic tags — value-based, not name-regex
    const colTags = tagColumnsByValues(data);

    // Plain-English summary
    let summary = null;
    if (adaptiveSummaryEnabled()) {
      try {
        summary = await summarizeAdaptiveResult({
          apiKey: String(apiKey).trim(),
          model,
          question,
          sqlText: finalSql,
          rowCount: data.length,
          sampleRows: data,
        });
      } catch (sumErr) {
        console.warn("[adaptive] plain-English summary skipped:", sumErr.message);
      }
    }

    // Shape-based chart selection — derived from actual result shape, not intent guessing
    const resultShape = detectResultShape(data, colTags);
    const shapeChart  = resultShape.chartType || chartPolicyFromResultShape(data);
    const intentForResponse = reconcileIntentTypeForResponse(question, queryIntent.type, data);
    const chartOutRaw = shapeChart !== "table" ? shapeChart : (queryIntent.chartPolicy || "auto");
    const chartOut = preferChartForTrendQuestion(question, intentForResponse, chartOutRaw);
    res.json({
      sql: finalSql,
      rowCount: data.length,
      data,
      mode: "nl_sql",
      tableHint: tableHint || null,
      summary,
      intentType: intentForResponse,
      intentDescription: queryIntent.description,
      chartPolicy: chartOut,
      resultShape: resultShape.shape,
      dataSource: "full_aggregate",
      contractPassed: contractResult.passed,
      contractIssues: contractResult.issues,
      contractWarnings: contractResult.warnings,
      columnTags: colTags,
      ...(retried || contractRetried ? { retried: true, contractRetried, originalSql } : {}),
    });
  } catch (err) {
    console.error("[adaptive] execution failed:", err);
    // SQL / validation errors are a 400 (bad request), not a server fault (500)
    const isSqlError =
      err.code === "invalid_sql" ||
      /invalid column|operand type|incorrect syntax|ambiguous column|multi-part identifier|cannot bind|does not exist/i.test(String(err.message || "")) ||
      String(err.message || "").startsWith("[SQL failed") ||
      String(err.message || "").startsWith("[SQL rejected") ||
      String(err.message || "").startsWith("[SQL failed static validation") ||
      String(err.message || "").startsWith("[validation]");
    res.status(isSqlError ? 400 : 500).json({
      error: "query_failed",
      message: String(err.message),
      sql: err.retrySql || sqlText,
      ...(err.originalSql ? { originalSql: err.originalSql } : {}),
    });
  }
});

/* ─────────────────────────────────────────────────────────────
   AGENTIC AI QUERY — schema-discovery mode
   OpenAI uses function-calling to explore INFORMATION_SCHEMA,
   verify column names, and self-correct on SQL errors.
   More accurate than /adaptive for unknown schema questions.
   ───────────────────────────────────────────────────────────── */
app.post("/api/query/agentic", rbac.requireFeature("ai"), async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    return res.status(503).json({
      error: "openai_not_configured",
      message: "Set OPENAI_API_KEY on the server",
    });
  }

  const question = String(req.body?.question ?? "").trim();
  if (!question) {
    return res.status(400).json({ error: "missing_question", message: 'Send JSON { question: "..." }' });
  }
  if (question.length > 4000) {
    return res.status(400).json({ error: "question_too_long", max: 4000 });
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  let pool;
  try {
    pool = await getPool();
  } catch (err) {
    return res.status(503).json({ error: "db_unavailable", message: String(err.message) });
  }

  try {
    // Build date context (same as adaptive route)
    const dateContext = buildDateContext();
    const fromDate = req.body?.fromDate != null ? String(req.body.fromDate).trim() : "";
    const toDate = req.body?.toDate != null ? String(req.body.toDate).trim() : "";
    const tableHint = req.body?.tableHint != null ? String(req.body.tableHint).trim() : "";
    const userDateRange = {};
    if (fromDate) userDateRange.from = fromDate;
    if (toDate) userDateRange.to = toDate;

    const result = await runAgenticQuery({
      apiKey: String(apiKey).trim(),
      model,
      question,
      pool,
      dateContext,
      userDateRange,
      tableHint: tableHint || undefined,
    });

    const colTags    = tagColumnsByValues(result.data);
    const agShape    = detectResultShape(result.data, colTags);

    res.json({
      answer: result.answer,
      sql: result.sql,
      rowCount: result.rowCount,
      data: result.data,
      columnTags: colTags,
      chartPolicy: agShape.chartType || "auto",
      resultShape: agShape.shape,
      turnsUsed: result.turnsUsed,
      toolCalls: result.toolCalls.map((t) => ({ tool: t.tool, args: t.args })),
      mode: "agentic",
    });
  } catch (err) {
    console.error("[agentic] failed:", err);
    const isSqlErr =
      err.code === "invalid_sql" ||
      /invalid column|operand type|incorrect syntax|ambiguous column/i.test(String(err.message || ""));
    res.status(isSqlErr ? 400 : 500).json({
      error: "agentic_query_failed",
      message: String(err.message),
      mode: "agentic",
    });
  }
});

/* ─────────────────────────────────────────────────────────────
   LANGCHAIN / LANGGRAPH QUERY
   7-node LangGraph workflow:
   discover_views → get_schema → generate_sql → check_sql (SQL pre-validator)
     → execute_sql → error_recovery (×2) → generate_answer
   ───────────────────────────────────────────────────────────── */
app.post("/api/query/langchain", rbac.requireFeature("ai"), async (req, res) => {
  // Support both OpenAI and Claude providers
  const lgProvider    = String(req.body?.provider ?? "openai").toLowerCase().trim();
  const isLgClaude    = lgProvider === "claude";
  const lgApiKey      = isLgClaude ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  const lgModel       = isLgClaude
    ? (process.env.ANTHROPIC_MODEL || "claude-opus-4-5")
    : (process.env.OPENAI_MODEL || "gpt-4o-mini");

  if (!lgApiKey || !String(lgApiKey).trim()) {
    const errKey = isLgClaude ? "anthropic_not_configured" : "openai_not_configured";
    const errMsg = isLgClaude ? "Set ANTHROPIC_API_KEY on the server" : "Set OPENAI_API_KEY on the server";
    return res.status(503).json({ error: errKey, message: errMsg });
  }

  const question = String(req.body?.question ?? "").trim();
  if (!question) return res.status(400).json({ error: "missing_question" });
  if (question.length > 4000) return res.status(400).json({ error: "question_too_long" });

  let pool;
  try {
    pool = await getPool();
  } catch (err) {
    return res.status(503).json({ error: "db_unavailable", message: String(err.message) });
  }

  try {
    const dateContext  = buildDateContext();
    const fromDate     = req.body?.fromDate  ? String(req.body.fromDate).trim()  : "";
    const toDate       = req.body?.toDate    ? String(req.body.toDate).trim()    : "";
    const tableHint    = req.body?.tableHint ? String(req.body.tableHint).trim() : "";
    const userDateRange = {};
    if (fromDate) userDateRange.from = fromDate;
    if (toDate)   userDateRange.to   = toDate;

    const result = await runLangChainQuery({
      apiKey:       isLgClaude ? undefined : String(lgApiKey).trim(),
      claudeApiKey: isLgClaude ? String(lgApiKey).trim() : undefined,
      model:        lgModel,
      provider:     lgProvider,
      question,
      pool,
      dateContext,
      userDateRange,
      tableHint: tableHint || undefined,
    });

    const colTags  = tagColumnsByValues(result.data);
    const lgShape  = detectResultShape(result.data, colTags);

    res.json({
      answer:         result.answer,
      summary:        result.answer,
      sql:            result.sql,
      rowCount:       result.rowCount,
      data:           result.data,
      columnTags:     colTags,
      chartPolicy:    lgShape.chartType || "auto",
      resultShape:    lgShape.shape,
      nodeLog:        result.nodeLog,
      retryCount:     result.retryCount,
      confidence:     result.confidence     || "high",
      confidenceNote: result.confidenceNote || "",
      mode:           "langchain",
    });
  } catch (err) {
    console.error("[langchain] failed:", err);
    res.status(500).json({
      error:   "langchain_query_failed",
      message: String(err.message),
      mode:    "langchain",
    });
  }
});

/* ─────────────────────────────────────────────────────────────
   ADMIN — RBAC user list (requires admin feature + RBAC_ENABLED)
   ───────────────────────────────────────────────────────────── */

app.get("/api/admin/users", rbac.requireAdminApi, (req, res) => {
  try {
    const cfg = rbac.loadUsersConfigFresh();
    res.json({
      roles: cfg.roles || {},
      users: cfg.users || [],
    });
  } catch (err) {
    res.status(500).json({ error: "admin_read_failed", message: String(err.message) });
  }
});

app.post("/api/admin/users", rbac.requireAdminApi, async (req, res) => {
  if (!rbac.usesPostgresForUsers()) {
    const persist = String(process.env.RBAC_PERSIST || "1").trim().toLowerCase();
    if (persist === "0" || persist === "false") {
      res.status(403).json({
        error: "persist_disabled",
        message:
          "RBAC_PERSIST=0: the API will not write users-config.json. Edit the file on the server instead.",
      });
      return;
    }
  }
  const users = req.body && req.body.users;
  if (!Array.isArray(users)) {
    res.status(400).json({
      error: "invalid_body",
      message: 'Send JSON: { "users": [ { "email": "user@domain.com", "role": "viewer" } ] }',
    });
    return;
  }
  try {
    const savedCount = await rbac.validateAndReplaceUsers(users);
    res.json({ ok: true, savedCount });
  } catch (err) {
    res.status(400).json({ error: "validation_failed", message: String(err.message) });
  }
});

app.get("/api/admin/semantic-dictionary", rbac.requireAdminApi, (req, res) => {
  try {
    const raw = fs.readFileSync(SEMANTIC_DICTIONARY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: "semantic_dictionary_read_failed", message: String(err.message) });
  }
});

app.post("/api/admin/semantic-dictionary", rbac.requireAdminApi, (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "invalid_body", message: "Send semantic dictionary JSON object." });
    }
    if (!payload.metrics || !payload.dimensions) {
      return res.status(400).json({ error: "invalid_dictionary", message: "Dictionary must include metrics and dimensions." });
    }
    fs.writeFileSync(SEMANTIC_DICTIONARY_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "semantic_dictionary_save_failed", message: String(err.message) });
  }
});

/* ─────────────────────────────────────────────────────────────
   AI QUERY HISTORY — server-side per-user store
   Stored in data/ai-history.json  { "email": ["q1","q2",...] }
   Max 20 entries per user. Replaces localStorage.
   ───────────────────────────────────────────────────────────── */
const AI_HISTORY_PATH = path.join(rootDir, "data", "ai-history.json");
const AI_HISTORY_MAX  = 20;

function readAiHistory() {
  try {
    const dir = path.dirname(AI_HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(AI_HISTORY_PATH)) return {};
    return JSON.parse(fs.readFileSync(AI_HISTORY_PATH, "utf8") || "{}");
  } catch { return {}; }
}
function writeAiHistory(data) {
  try { fs.writeFileSync(AI_HISTORY_PATH, JSON.stringify(data, null, 2)); } catch {}
}

/** GET /api/ai/history — returns array of recent query strings for the logged-in user */
app.get("/api/ai/history", rbac.rbacMiddleware, (req, res) => {
  const email = req.rbac?.email || "";
  if (!email) return res.json([]);
  const all = readAiHistory();
  res.json(all[email.toLowerCase()] || []);
});

/** POST /api/ai/history — { query: string } — prepend to user's history list */
app.post("/api/ai/history", rbac.rbacMiddleware, (req, res) => {
  const email = req.rbac?.email || "";
  const query = String((req.body && req.body.query) || "").trim();
  if (!email || !query) return res.json({ ok: false });
  const all = readAiHistory();
  const key = email.toLowerCase();
  const prev = Array.isArray(all[key]) ? all[key] : [];
  all[key] = [query, ...prev.filter(q => q !== query)].slice(0, AI_HISTORY_MAX);
  writeAiHistory(all);
  res.json({ ok: true, count: all[key].length });
});

/** DELETE /api/ai/history — clears history for the logged-in user */
app.delete("/api/ai/history", rbac.rbacMiddleware, (req, res) => {
  const email = req.rbac?.email || "";
  if (!email) return res.json({ ok: false });
  const all = readAiHistory();
  delete all[email.toLowerCase()];
  writeAiHistory(all);
  res.json({ ok: true });
});

/* ─────────────────────────────────────────────────────────────
   SQL TEMPLATES — server-side CRUD
   Stored in data/sql-templates.json, shared across all users.
   Each template: { id, name, sql, desc, createdAt, updatedAt }
   ───────────────────────────────────────────────────────────── */
const SQL_TEMPLATES_PATH = path.join(rootDir, "data", "sql-templates.json");

function readSqlTemplates() {
  try {
    const dir = path.dirname(SQL_TEMPLATES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(SQL_TEMPLATES_PATH)) return [];
    return JSON.parse(fs.readFileSync(SQL_TEMPLATES_PATH, "utf8") || "[]");
  } catch { return []; }
}

function writeSqlTemplates(templates) {
  const dir = path.dirname(SQL_TEMPLATES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SQL_TEMPLATES_PATH, JSON.stringify(templates, null, 2) + "\n", "utf8");
}

/** GET /api/sql-templates — list all (auth: global rbacMiddleware on /api/*) */
app.get("/api/sql-templates", (req, res) => {
  res.json({ ok: true, templates: readSqlTemplates() });
});

/** POST /api/sql-templates — create */
app.post("/api/sql-templates", rbac.requireManagerOrAdminApi, (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const sql  = String(req.body?.sql  ?? "").trim();
  const desc = String(req.body?.desc ?? "").trim();
  if (!name || !sql) {
    return res.status(400).json({ error: "missing_fields", message: "name and sql are required" });
  }
  const templates = readSqlTemplates();
  const entry = {
    id: `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name, sql, desc,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: (req.rbac && req.rbac.email) || "unknown",
  };
  templates.unshift(entry);
  writeSqlTemplates(templates);
  res.json({ ok: true, template: entry });
});

/** PUT /api/sql-templates/:id — update */
app.put("/api/sql-templates/:id", rbac.requireManagerOrAdminApi, (req, res) => {
  const { id } = req.params;
  const name = String(req.body?.name ?? "").trim();
  const sql  = String(req.body?.sql  ?? "").trim();
  const desc = String(req.body?.desc ?? "").trim();
  if (!name || !sql) {
    return res.status(400).json({ error: "missing_fields", message: "name and sql are required" });
  }
  const templates = readSqlTemplates();
  const idx = templates.findIndex(t => t.id === id);
  if (idx < 0) return res.status(404).json({ error: "not_found", message: `Template ${id} not found` });
  templates[idx] = { ...templates[idx], name, sql, desc, updatedAt: new Date().toISOString() };
  writeSqlTemplates(templates);
  res.json({ ok: true, template: templates[idx] });
});

/** DELETE /api/sql-templates/:id — delete */
app.delete("/api/sql-templates/:id", rbac.requireManagerOrAdminApi, (req, res) => {
  const { id } = req.params;
  const templates = readSqlTemplates();
  const next = templates.filter(t => t.id !== id);
  if (next.length === templates.length) {
    return res.status(404).json({ error: "not_found", message: `Template ${id} not found` });
  }
  writeSqlTemplates(next);
  res.json({ ok: true });
});

/* ─────────────────────────────────────────────────────────────
   GLOBAL JSON ERROR HANDLER
   Ensures Express never sends HTML error pages to API clients.
   ───────────────────────────────────────────────────────────── */
const showErrorDetails =
  String(process.env.SHOW_ERROR_DETAILS || "").trim() === "1" ||
  String(process.env.NODE_ENV || "").trim() !== "production";

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status =
    typeof err.status === "number"
      ? err.status
      : typeof err.statusCode === "number"
        ? err.statusCode
        : 500;
  logger.error("express_unhandled_error", {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    status,
    code: err.code,
    message: String(err.message || err),
  });
  if (res.headersSent) return;
  const safeMsg =
    status === 500 && !showErrorDetails
      ? "An internal error occurred. Retry or contact support with the request ID."
      : String(err.message || "An unexpected error occurred");
  res.status(status).json({
    error: err.code || "internal_error",
    message: safeMsg,
    path: req.path,
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
});

/* ─────────────────────────────────────────────────────────────
   END DYNAMIC SCHEMA ENDPOINTS
   ───────────────────────────────────────────────────────────── */

try {
  process.stdin.resume();
} catch (_) {
  /* ignore */
}

process.on("beforeExit", (code) => {
  console.error(
    "[erp-api] beforeExit code=%s — event loop is empty; server should not exit here.",
    code
  );
});

/** Child process MCP HTTP+SSE (dashboard agentic ↔ tools). Disabled with ERP_MCP_SPAWN_CHILD=0. */
let erpMcpHttpChild = null;

function tcpPeerListening(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch (_) {
        //
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

/**
 * Spawn embedded MCP HTTP only if MCP_PORT is not already accepting TCP
 * (avoids EADDRINUSE when you already run `npm run mcp:erp-http`).
 */
async function maybeSpawnErpMcpHttpProcess() {
  if (
    process.env.ERP_MCP_SPAWN_CHILD !== undefined &&
    /^0|false|no$/i.test(String(process.env.ERP_MCP_SPAWN_CHILD).trim())
  ) {
    console.log("[mcp:http] Spawn skipped — ERP_MCP_SPAWN_CHILD is off (start MCP manually if needed)");
    return;
  }

  const mcpHost = envTrim("MCP_HTTP_HOST") || "127.0.0.1";
  const mcpPort = parseInt(String(process.env.MCP_PORT || "3001"), 10) || 3001;

  const busy = await tcpPeerListening(mcpHost, mcpPort, 750);
  if (busy) {
    console.log(`[mcp:http] ${mcpHost}:${mcpPort} already in use — skipping embedded MCP spawn`);
    return;
  }

  const script = path.join(rootDir, "mcp", "erp-database-server.js");
  erpMcpHttpChild = spawn(process.execPath, [script, "--http"], {
    cwd: rootDir,
    env: { ...process.env },
    stdio: "inherit",
  });
  erpMcpHttpChild.on("error", (err) => {
    console.error("[mcp:http] MCP server spawn error:", err.message);
  });
}

function killErpMcpChild() {
  if (!erpMcpHttpChild || erpMcpHttpChild.killed) return;
  try {
    erpMcpHttpChild.kill("SIGTERM");
  } catch (_) {
    //
  }
  erpMcpHttpChild = null;
}

process.once("exit", killErpMcpChild);

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", {
    reason: String(reason && reason.message ? reason.message : reason),
  });
});

process.on("uncaughtException", (err) => {
  logger.error("uncaught_exception", {
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

const server = http.createServer(app);

/** Graceful shutdown: stop HTTP, close SQL pool, kill MCP child. */
async function gracefulShutdown(signal) {
  const force = setTimeout(() => {
    logger.error("graceful_shutdown_timeout_forcing_exit", { ms: 12000 });
    process.exit(1);
  }, 12000);
  force.unref();
  logger.info("graceful_shutdown_start", { signal });
  killErpMcpChild();
  try {
    await new Promise((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
    });
  } catch (e) {
    logger.warn("graceful_shutdown_http_close", { err: String(e.message || e) });
  }
  try {
    await sql.close();
  } catch (_) {
    //
  }
  clearTimeout(force);
  logger.info("graceful_shutdown_done", { signal });
  process.exit(0);
}

process.once("SIGINT", () => {
  gracefulShutdown("SIGINT").catch(() => process.exit(1));
});
process.once("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch(() => process.exit(1));
});

server.on("error", (err) => {
  console.error("[erp-api] HTTP server error:", err);
  process.exit(1);
});

/* ═══════════════════════════════════════════════════════════════════════════
   RAG MEMORY API
   ═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
   ASYNC EXPORT (large raw CSV — never through chat payload)
   ═══════════════════════════════════════════════════════════════════════════ */

/** POST /api/query/export-async — queue background CSV from validated SELECT */
app.post("/api/query/export-async", rbac.requireFeature("ai"), async (req, res) => {
  const sql = String(req.body?.sql ?? "").trim();
  const question = String(req.body?.question ?? "export").trim();
  if (!sql) {
    return res.status(400).json({ error: "missing_sql", message: "Send { sql, question? }" });
  }
  let pool;
  try {
    pool = await getPool();
  } catch (err) {
    return res.status(503).json({ error: "db_unavailable", message: String(err.message) });
  }
  try {
    const queued = asyncExport.queueExportJob({
      pool,
      sql,
      question,
      userId: req.rbac?.email,
    });
    res.json({
      ok: true,
      mode: "async_export",
      asyncExport: {
        ...queued,
        statusUrl: `/api/query/export-async/${queued.jobId}`,
        downloadUrl: `/api/query/export-async/${queued.jobId}/download`,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.code || "export_queue_failed", message: String(err.message) });
  }
});

/** GET /api/query/export-async/:jobId — poll job status */
app.get("/api/query/export-async/:jobId", rbac.requireFeature("ai"), (req, res) => {
  const job = asyncExport.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: "job_not_found" });
  res.json({
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      rowCount: job.rowCount,
      maxRows: job.maxRows,
      error: job.error,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      downloadUrl: job.status === "completed" ? job.downloadUrl : null,
    },
  });
});

/** GET /api/query/export-async/:jobId/download — download CSV when complete */
app.get("/api/query/export-async/:jobId/download", rbac.requireFeature("ai"), (req, res) => {
  const job = asyncExport.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job_not_found" });
  if (job.status !== "completed" || !job.filePath) {
    return res.status(409).json({ error: "not_ready", status: job.status, message: job.error || "Export still running" });
  }
  const fs = require("fs");
  if (!fs.existsSync(job.filePath)) {
    return res.status(410).json({ error: "file_gone", message: "Export file expired or removed" });
  }
  res.download(job.filePath, `erp_export_${job.id}.csv`);
});

/** GET /api/rag/stats — store summary */
app.get("/api/rag/stats", (req, res) => {
  res.json({ ok: true, stats: ragStore.stats() });
});

/** GET /api/rag/examples — list saved query examples */
app.get("/api/rag/examples", (req, res) => {
  const examples = ragStore.listByType("example").map(({ id, metadata, addedAt, updatedAt }) => ({
    id,
    addedAt,
    updatedAt: updatedAt || null,
    question: String(metadata.question || ""),
    sql: String(metadata.sql || ""),
    note: String(metadata.note || ""),
    autoSaved: !!metadata.autoSaved,
    verified: !!metadata.verified,
    /** Full metadata — dashboard filters/cards use ex.metadata.* */
    metadata: { ...metadata, type: "example" },
  }));
  res.json({ ok: true, examples });
});

/** POST /api/rag/example — manually save a query example */
app.post("/api/rag/example", rbac.requireManagerOrAdminApi, async (req, res) => {
  try {
    const { question, sql, note } = req.body || {};
    if (!question || !sql) return res.status(400).json({ ok: false, error: "question and sql required" });
    const id = await ragStore.addExample(String(question), String(sql), String(note || ""), false);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** DELETE /api/rag/example/:id — remove an example */
app.delete("/api/rag/example/:id", rbac.requireManagerOrAdminApi, (req, res) => {
  const removed = ragStore.remove(req.params.id);
  res.json({ ok: removed });
});

/** PUT /api/rag/example/:id — edit question / sql / note of an existing example */
app.put("/api/rag/example/:id", rbac.requireManagerOrAdminApi, async (req, res) => {
  try {
    const { question, sql, note = "" } = req.body || {};
    if (!question || !sql) return res.status(400).json({ ok: false, error: "question and sql required" });
    const updated = await ragStore.updateExample(req.params.id, String(question), String(sql), String(note));
    if (!updated) return res.status(404).json({ ok: false, error: "example not found" });
    res.json({ ok: true, example: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/rag/example/:id/thumbs-up — mark example as verified/correct */
app.post("/api/rag/example/:id/thumbs-up", rbac.requireManagerOrAdminApi, (req, res) => {
  const ok = ragStore.thumbsUp(req.params.id);
  res.json({ ok });
});

/** POST /api/rag/example/:id/thumbs-down — mark as wrong and remove */
app.post("/api/rag/example/:id/thumbs-down", rbac.requireManagerOrAdminApi, (req, res) => {
  const ok = ragStore.thumbsDown(req.params.id);
  res.json({ ok });
});

/**
 * POST /api/rag/example/:id/run — execute the verified SQL for a RAG example by ID.
 * Safe: SQL comes from server-side verified store, not from the caller.
 * Optional body: { limit: 200 } to cap rows returned (default 200, max 500).
 * Returns: { ok, id, question, sql, data, rowCount, verified }
 */
app.post("/api/rag/example/:id/run", rbac.requireFeature("data"), async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const all = ragStore.listByType("example");
    const entry = all.find(e => e.id === id) || null;
    if (!entry) return res.status(404).json({ ok: false, error: "Example not found: " + id });

    const sql = String(entry.metadata?.sql || "").trim();
    if (!sql) return res.status(400).json({ ok: false, error: "Example has no SQL stored" });

    const question = String(entry.metadata?.question || "").trim();
    const verified = !!entry.metadata?.verified;

    // Safety check: only allow SELECT statements from the verified store
    const sqlUpper = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").trim().toUpperCase();
    if (!sqlUpper.startsWith("SELECT") && !sqlUpper.startsWith("WITH")) {
      return res.status(400).json({ ok: false, error: "Only SELECT/WITH statements allowed" });
    }

    const rawLimit = parseInt(String((req.body && req.body.limit) || "200"), 10);
    const rowLimit = isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;

    // Inject TOP if not already present and SQL starts with SELECT
    let execSql = sql;
    if (sqlUpper.startsWith("SELECT") && !/^\s*SELECT\s+TOP\s+\d+/i.test(sql)) {
      execSql = sql.replace(/^\s*SELECT\s+/i, `SELECT TOP ${rowLimit} `);
    }

    const pool = await getPool();
    const request = pool.request();
    request.timeout = 60000; // 60s cap for verified examples
    const result = await request.query(execSql);
    const rows = result.recordset || [];

    res.json({ ok: true, id, question, sql, data: rows, rowCount: rows.length, verified });
  } catch (err) {
    console.error("[rag/example/run] error:", err.message);
    res.status(500).json({ ok: false, error: err.message || "Query failed" });
  }
});

/** GET /api/rag/glossary — list glossary terms */
app.get("/api/rag/glossary", (req, res) => {
  const terms = ragStore.listByType("glossary").map(({ id, metadata, addedAt }) => ({
    id,
    term:       metadata.term || "",
    definition: metadata.definition || "",
    addedAt,
  }));
  res.json({ ok: true, terms });
});

/** POST /api/rag/glossary — add a business glossary term */
app.post("/api/rag/glossary", rbac.requireManagerOrAdminApi, async (req, res) => {
  try {
    const { term, definition } = req.body || {};
    if (!term || !definition) return res.status(400).json({ ok: false, error: "term and definition required" });
    const id = await ragStore.addGlossary(String(term), String(definition));
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** DELETE /api/rag/glossary/:id — remove a glossary term */
app.delete("/api/rag/glossary/:id", rbac.requireManagerOrAdminApi, (req, res) => {
  const removed = ragStore.remove(req.params.id);
  res.json({ ok: removed });
});

/** POST /api/rag/index-schema — re-index all schema views */
app.post("/api/rag/index-schema", rbac.requireManagerOrAdminApi, async (req, res) => {
  try {
    await ragSchemaIndexer.indexSchema(true);
    res.json({ ok: true, stats: ragStore.stats() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/rag/seed-examples — bulk-load predefined starter examples */
const PREDEFINED_EXAMPLES_PATH = path.join(rootDir, "data", "predefined-rag-examples.json");
app.post("/api/rag/seed-examples", rbac.requireManagerOrAdminApi, async (req, res) => {
  try {
    if (!fs.existsSync(PREDEFINED_EXAMPLES_PATH)) {
      return res.status(404).json({ ok: false, error: "predefined-rag-examples.json not found" });
    }
    const examples = JSON.parse(fs.readFileSync(PREDEFINED_EXAMPLES_PATH, "utf8"));
    if (!Array.isArray(examples) || !examples.length) {
      return res.status(400).json({ ok: false, error: "No examples in file" });
    }
    const { replace = false } = req.body || {};
    let added = 0, skipped = 0;
    const existingExamples = ragStore.listByType("example");
    const existingQuestions = new Set(
      existingExamples.map(e => String(e.metadata?.question || "").toLowerCase().trim())
    );
    for (const ex of examples) {
      if (!ex.question || !ex.sql) { skipped++; continue; }
      const qLow = ex.question.toLowerCase().trim();
      // If replace=false, skip examples that already exist (same question)
      if (!replace && existingQuestions.has(qLow)) { skipped++; continue; }
      try {
        await ragStore.addExample(ex.question, ex.sql, ex.note || "predefined starter", false);
        added++;
      } catch (err) {
        console.error("[seed-examples] failed:", ex.question, err.message);
        skipped++;
      }
    }
    res.json({
      ok: true,
      added,
      skipped,
      total: examples.length,
      stats: ragStore.stats(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/rag/feedback
 * Saves a user-verified query pair into the RAG store so the AI learns from corrections.
 * Body: { question, sql, correct: true|false, correctedSql?, note? }
 *
 * When correct=true  → saves question+sql as a verified example (👍)
 * When correct=false → if correctedSql provided, saves the correction (👎 + fix)
 */
app.post("/api/rag/feedback", async (req, res) => {
  const { question, sql, correct, correctedSql, note } = req.body || {};
  if (!question) {
    return res.status(400).json({ ok: false, error: "question is required" });
  }
  try {
    if (correct === true) {
      if (sql) {
        const noteText = note
          ? `✅ User-verified. ${note}`
          : `✅ User-verified correct answer.`;
        await ragStore.addExample(question, sql, noteText);
        return res.json({ ok: true, action: "saved_verified_example" });
      }
      console.log(`[feedback] ✅ positive (no SQL attached): "${question}"`);
      return res.json({ ok: true, action: "positive_feedback_noted" });
    }
    if (correct === false && correctedSql) {
      // 👎 User provided corrected SQL — save correction
      const noteText = `✅ User-corrected answer. Original was wrong. ${note || ""}`.trim();
      await ragStore.addExample(question, correctedSql, noteText);
      return res.json({ ok: true, action: "saved_corrected_example" });
    }
    // Negative feedback with no correction — log for awareness
    console.log(`[feedback] ❌ negative feedback for: "${question}" (no correction provided)`);
    return res.json({ ok: true, action: "negative_feedback_noted" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/rag/reseed — force re-seed from all metadata files */
app.post("/api/rag/reseed", rbac.requireManagerOrAdminApi, async (req, res) => {
  try {
    await seedRagKnowledge(true); // force=true
    res.json({ ok: true, stats: ragStore.stats() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

(async function startServer() {
  try {
    await rbac.initStorage();
  } catch (err) {
    console.error("[erp-api] RBAC storage init failed:", err);
    process.exit(1);
  }

  await maybeSpawnErpMcpHttpProcess();
  try {
    await initMCPClient();
  } catch (err) {
    console.error("[mcp:http] MCP Client failed to connect:", err.message || err);
    console.warn("[mcp:http] Agentic queries will use in-process tools until MCP HTTP is reachable");
  }

  // Seed RAG with business semantic layer + query examples + KPI dictionary.
  // Runs in background — idempotent, only re-seeds when metadata files change.
  seedRagKnowledge().catch(e =>
    console.warn("[semantic-seeder] non-fatal:", e.message)
  );

  // Index raw schema into RAG store in background (non-blocking)
  ragSchemaIndexer.indexSchema().catch(e =>
    console.warn("[rag-schema-indexer] background index failed:", e.message)
  );

  // Schedule analytics cache warm-up (30s delay, then every 15 min).
  // Pre-runs MTD/QTD/YTD/180d so the first user never waits for a cold query.
  // Disable: ANALYTICS_WARMUP=0 in .env
  getPool().then(pool => scheduleAnalyticsWarmup(pool)).catch(() => {});

  if (!/^(0|false|no)$/i.test(String(process.env.BUILD_DIMENSION_INDEX_ON_STARTUP || "0").trim())) {
    getPool()
      .then(async (pool) => {
        const { buildDimensionIndex } = require("./scripts/build-dimension-index");
        const { indexIsStale } = require("./services/dimension-index");
        if (indexIsStale(24)) {
          await buildDimensionIndex(pool);
          console.log("[dimension-index] background build complete");
        }
      })
      .catch((e) => console.warn("[dimension-index] startup build skipped:", e.message));
  }

  server.listen(port, "0.0.0.0", () => {
    server.ref();
    console.log(`ERP API listening on http://0.0.0.0:${port} (pid ${process.pid})`);
    console.log(
      "[datasets] DATASET_HARD_CAP=%s  DATASET_PAGE_MAX=%s (restart required after .env changes)",
      getDatasetHardCap(),
      getDatasetPageMax()
    );
    console.log(
      "Leave this window open. Health: http://127.0.0.1:%s/api/health  Dashboard: http://127.0.0.1:%s/dashboard.html",
      port,
      port
    );

    if (rbac.rbacEnabled()) {
      try {
        const cfg = rbac.loadUsersConfigFresh();
        const n = (cfg.users || []).length;
        const where = rbac.usesPostgresForUsers() ? "PostgreSQL" : "users-config.json";
        console.log(`[rbac] ON — ${n} user(s) in ${where} (emails must match X-User-Email for Sheets)`);
      } catch (e) {
        console.warn("[rbac] user list read failed:", e.message);
      }
    } else {
      console.log("[rbac] off — set RBAC_ENABLED=1 to require X-User-Email");
    }
  });
})();
