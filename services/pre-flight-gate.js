/**
 * Pre-execution guard — fast path, feasibility validation, zero-token rejections.
 */
"use strict";

const { loadSchema, formatSchemaForPrompt } = require("./schema-from-json");
const {
  BUSINESS_TERM_MAPPINGS,
  checkFastPath,
  rankViewsByMappingCoverage,
  detectTermsInQuestion,
} = require("./metadata-translation-engine");
const { evaluateUserClarityGate, INTERACTIVE_CHIPS } = require("./user-guidance");
const { runAdaptivePreprocess } = require("./adaptive-query-pipeline");
const { resolveAdaptiveFastPathSql } = require("./adaptive-fast-path");
const { isFastPathEnabled } = require("./nlq-pipeline-config");
const { resolveViewForQuestion } = require("./dynamic-semantic-layer");
const { resolveHomeAlignedSql, getHomeAnalyticsTable } = require("./home-kpi-sql");
const { isSalespersonTopNQuestion } = require("./canonical-salesperson-sql");

// Lowered from 0.95 → 0.45 so the gate only blocks truly empty/nonsense queries.
// The LangGraph 7-node pipeline (intent → SQL → self-heal) handles ambiguous questions far better
// than the pre-flight rejection — blocking wastes a round-trip and confuses users.
const CLARITY_THRESHOLD = 0.45;

const CLARIFICATION_CHOICES = [
  { id: "gross_revenue", label: "Gross revenue (MrpValue)", term: "Gross revenue" },
  { id: "sales_volume", label: "Sales volume / Pcs (AppQty)", term: "Sales volume" },
  { id: "store", label: "By store / location (BranchAlias)", term: "Store" },
  { id: "date_today", label: "Today", term: "Transaction date" },
  { id: "date_yesterday", label: "Yesterday", term: "Sale Date" },
];

function normalizeInput(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasRecognizedMetric(cleanInput) {
  // Check multi-word business term mappings first
  if (Object.keys(BUSINESS_TERM_MAPPINGS).some((term) => cleanInput.includes(term.toLowerCase()))) {
    return true;
  }
  // Also catch bare retail metric words — "sales", "amount", "cost", "profit", "margin", "count", "invoice"
  return /\b(sales|amount|cost|profit|margin|invoice|invoices|orders?|purchases?|items?|products?|articles?|pcs|pieces|units)\b/.test(cleanInput);
}

function hasTimeOrFilterAnchor(cleanInput) {
  // Date / period anchors
  if (/\b(today|yesterday|mtd|ytd|qtd|last\s+\d+\s+days?|this\s+month|all\s*time|all-time|overall|ever|lifetime|may|june|january|february|march|april|august|september|october|november|december|\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/i.test(cleanInput)) {
    return true;
  }
  // Dimension anchors
  if (/\b(branch|store|location|shop|category|department|supplier|vendor|salesperson|staff|employee)\b/i.test(cleanInput)) {
    return true;
  }
  // Ranking / top-N queries are self-anchored — "top 10", "highest", "best", "lowest", "worst", "rank"
  if (/\b(top\s+\d+|top\s+ten|highest|lowest|best|worst|rank(ing)?|most|least|maximum|minimum|biggest|smallest|largest)\b/i.test(cleanInput)) {
    return true;
  }
  return false;
}

/**
 * INTENT AUTOPILOT — Returns true when the query contains unambiguous retail intent signals.
 * These queries bypass ALL clarification loops and go directly to SQL generation.
 * "highest selling articles", "top 20 by MrpValue", "total turnover this month" etc.
 */
function hasObviousRetailIntent(cleanInput) {
  // Ranking / superlative queries — user knows exactly what they want
  if (/\b(top\s+\d+|highest\s+sell|best\s+sell|most\s+sold|lowest\s+sell|worst\s+sell|top\s+sell|fastest\s+sell)\b/i.test(cleanInput)) return true;
  // Explicit column reference — user typed the actual column or metric name
  if (/\b(mrpvalue|appqty|suppliername|branchalias|xndt|xnno|categoryshortname|departmentshortname)\b/i.test(cleanInput)) return true;
  // Aggregation + time = complete query
  if (/\b(total|sum|count|average|avg)\b/i.test(cleanInput) && /\b(today|yesterday|this month|mtd|ytd|qtd|this year|last month|last year|all time|all-time)\b/i.test(cleanInput)) return true;
  // Article/product ranking — "articles by total sales", "items by revenue", "products by MrpValue"
  if (/\b(article|item|product|sku)\b/i.test(cleanInput) && /\b(by|rank|top|highest|most|best|turnover|revenue|sales|mrpvalue)\b/i.test(cleanInput)) return true;
  // Explicit time window — enough context for SQL generation
  if (/\b(all\s*time|all-time|overall|lifetime|since\s+(inception|beginning|start)|ever)\b/i.test(cleanInput) && hasRecognizedMetric(cleanInput)) return true;
  return false;
}

function computeClarityScore(cleanInput, rankedViews, detectedTerms) {
  const top = rankedViews[0];
  const viewScore = top && top.matchCount > 0 ? Math.min(top.matchCount / 5, 1) : 0;
  const metricScore = hasRecognizedMetric(cleanInput) ? 1 : detectedTerms.length > 0 ? 0.7 : 0;
  const anchorScore = hasTimeOrFilterAnchor(cleanInput) ? 1 : 0.4;
  return metricScore * 0.5 + viewScore * 0.35 + anchorScore * 0.15;
}

function suggestValidBusinessTerms(userQuestion) {
  const detected = detectTermsInQuestion(userQuestion);
  const used = new Set(detected.map((d) => d.alias.toLowerCase()));
  return CLARIFICATION_CHOICES.filter((c) => !used.has(c.term.toLowerCase())).slice(0, 4);
}

/**
 * Semantic validation gate — no LLM, no DB.
 */
function validateQueryFeasibility(userQuestion, rankedViews) {
  const cleanInput = normalizeInput(userQuestion);

  if (!cleanInput || cleanInput.length < 3) {
    return {
      viable: false,
      reason: "empty_query",
      clarityScore: 0,
      suggestedQuestion:
        "Please ask a specific retail question using metrics like **Gross revenue**, **Sales volume**, or a **Store** filter.",
      clarificationOptions: suggestValidBusinessTerms(userQuestion),
    };
  }

  // ── INTENT AUTOPILOT: obvious retail query → skip all clarification loops ──
  if (hasObviousRetailIntent(cleanInput)) {
    return { viable: true, clarityScore: 0.95, reason: "ok_autopilot" };
  }

  const hasMetric = hasRecognizedMetric(cleanInput);
  const detectedTerms = detectTermsInQuestion(userQuestion);
  const topView = rankedViews[0];
  const isViewViable = topView && topView.matchCount > 0;
  const clarityScore = computeClarityScore(cleanInput, rankedViews, detectedTerms);

  if (!hasMetric && !isViewViable) {
    return {
      viable: false,
      reason: "missing_core_concepts",
      clarityScore,
      suggestedQuestion:
        "I couldn't confidently map your request to our data columns. Did you mean to check **Gross revenue**, **Sales volume**, or filter by **Store / Location**?",
      clarificationOptions: suggestValidBusinessTerms(userQuestion),
    };
  }

  if (!hasMetric && isViewViable && clarityScore < CLARITY_THRESHOLD) {
    return {
      viable: false,
      reason: "missing_metric_terms",
      clarityScore,
      suggestedQuestion:
        "Which metric should I calculate? Choose **Gross revenue (Turnover)**, **Sales volume (Pcs)**, or **Product cost**.",
      clarificationOptions: suggestValidBusinessTerms(userQuestion),
    };
  }

  if (hasMetric && !isViewViable) {
    return {
      viable: false,
      reason: "no_structural_view_match",
      clarityScore,
      suggestedQuestion:
        "No retail view exposes the columns needed for that question. Try rephrasing with **approval**, **sales**, or **store** context.",
      clarificationOptions: suggestValidBusinessTerms(userQuestion),
    };
  }

  if (
    /\bsales\s+for\b/.test(cleanInput) &&
    !/\b(branch|store|location|shop|category|department|supplier)\b/.test(cleanInput)
  ) {
    return {
      viable: false,
      reason: "ambiguous_dimension_filter",
      clarityScore,
      suggestedQuestion:
        "Are you looking for sales filtered by a specific **Store / Location** or a product **Category**? Please clarify.",
      clarificationOptions: [
        { id: "store", label: "Filter by Store / Location", term: "Store" },
        { id: "category", label: "Filter by Category", term: "Category" },
      ],
    };
  }

  // Ranking / top-N queries are always viable — the user knows exactly what they want
  const isRankingQuery = /\b(top\s+\d+|top\s+ten|highest|lowest|best|worst|rank(ing)?|most|least|maximum|minimum|biggest|smallest|largest)\b/i.test(cleanInput);
  if (isRankingQuery) {
    return { viable: true, clarityScore: Math.max(clarityScore, 0.8), reason: "ok" };
  }

  if (clarityScore < CLARITY_THRESHOLD && !hasTimeOrFilterAnchor(cleanInput)) {
    return {
      viable: false,
      reason: "low_clarity",
      clarityScore,
      suggestedQuestion:
        "Please add a time period (**today**, **yesterday**, **this month**) or a dimension (**by store**, **by category**) so I can run an accurate query.",
      clarificationOptions: suggestValidBusinessTerms(userQuestion),
    };
  }

  return { viable: true, clarityScore, reason: "ok" };
}

/**
 * Full pre-flight: fast path → rank → validate → localized schema (1 view).
 */
function runPreFlightGate(userQuestion, opts = {}) {
  const t0 = Date.now();
  const schemaJson = opts.schemaJson || loadSchema();
  let question = String(userQuestion || "").trim();

  const clarityGate = evaluateUserClarityGate(question);
  if (!clarityGate.viable) {
    return {
      nextStep: "PROMPT_USER_FOR_CLARIFICATION",
      clarificationMessage: clarityGate.message,
      clarificationReason: "interactive_clarification",
      uiType: "SUGGESTION_CHIPS",
      suggestedOptions: clarityGate.suggestedOptions || INTERACTIVE_CHIPS,
      clarificationOptions: (clarityGate.suggestedOptions || INTERACTIVE_CHIPS).map((o, i) => ({
        id: `chip_${i}`,
        label: o.label,
        term: o.text,
      })),
      rankedViews: [],
      clarityScore: 0,
      preFlightMs: Date.now() - t0,
    };
  }

  const originalQuestion = question;

  const homeHit = resolveHomeAlignedSql(originalQuestion, originalQuestion);
  if (homeHit?.sql) {
    let homeView = getHomeAnalyticsTable();
    if (isSalespersonTopNQuestion(originalQuestion)) {
      const { getCanonicalSalespersonContext } = require("./canonical-salesperson-sql");
      homeView = getCanonicalSalespersonContext().table;
    }
    const rankedViews = rankViewsByMappingCoverage(question, schemaJson);
    return {
      nextStep: "FAST_PATH",
      fastPathSql: homeHit.sql,
      fastPathMatch: "home_kpi_aligned",
      fastPathKey: homeHit.label || "home_kpi_aligned",
      targetView: homeView,
      rankedViews: rankedViews.slice(0, 3),
      preFlightMs: Date.now() - t0,
      clarityScore: 1,
      correctedQuestion: question,
      originalQuestion,
    };
  }

  const adaptive = runAdaptivePreprocess(originalQuestion, {
    autoCorrectOpts: opts.autoCorrectOpts,
    schemaJson,
  });
  question = adaptive.question;

  const homeHitAfter = resolveHomeAlignedSql(question, originalQuestion);
  if (homeHitAfter?.sql) {
    let homeView = getHomeAnalyticsTable();
    if (isSalespersonTopNQuestion(originalQuestion)) {
      const { getCanonicalSalespersonContext } = require("./canonical-salesperson-sql");
      homeView = getCanonicalSalespersonContext().table;
    }
    const rankedViews = rankViewsByMappingCoverage(question, schemaJson);
    return {
      nextStep: "FAST_PATH",
      fastPathSql: homeHitAfter.sql,
      fastPathMatch: "home_kpi_aligned",
      fastPathKey: homeHitAfter.label || "home_kpi_aligned",
      targetView: homeView,
      rankedViews: rankedViews.slice(0, 3),
      preFlightMs: Date.now() - t0,
      clarityScore: 1,
      correctedQuestion: question,
      originalQuestion: adaptive.originalQuestion || originalQuestion,
      adaptiveEnrichment: adaptive.enrichmentBlock,
      jargonReplacements: adaptive.jargonReplacements,
      valueCorrections: adaptive.valueCorrections,
    };
  }

  const canonicalBefore = isFastPathEnabled()
    ? resolveAdaptiveFastPathSql(originalQuestion, {
        fromDate: opts.fromDate,
        toDate: opts.toDate,
      })
    : null;

  const fastPath = isFastPathEnabled()
    ? canonicalBefore ||
      (() => {
        const c = checkFastPath(question);
        return c
          ? { sql: c.sql, source: "exact_match_cache", matchType: c.matchType, matchedKey: c.matchedKey }
          : null;
      })()
    : null;

  if (fastPath?.sql) {
    return {
      nextStep: "FAST_PATH",
      fastPathSql: fastPath.sql,
      fastPathMatch: fastPath.matchType || fastPath.source,
      fastPathKey: fastPath.matchedKey || fastPath.source,
      rankedViews: rankViewsByMappingCoverage(question, schemaJson).slice(0, 3),
      preFlightMs: Date.now() - t0,
      clarityScore: 1,
      correctedQuestion: question,
      originalQuestion: adaptive.originalQuestion || originalQuestion,
      adaptiveEnrichment: adaptive.enrichmentBlock,
      jargonReplacements: adaptive.jargonReplacements,
      valueCorrections: adaptive.valueCorrections,
    };
  }

  const rankedViews = rankViewsByMappingCoverage(question, schemaJson);
  const targetView = resolveViewForQuestion(question, { schemaJson });
  const orderedRanked = rankedViews.some((r) => r.viewName === targetView)
    ? rankedViews
    : [{ viewName: targetView, matchCount: 99 }, ...rankedViews];
  const validation = validateQueryFeasibility(question, orderedRanked);

  if (!validation.viable) {
    return {
      nextStep: "PROMPT_USER_FOR_CLARIFICATION",
      clarificationMessage: validation.suggestedQuestion,
      clarificationReason: validation.reason,
      clarificationOptions: validation.clarificationOptions || [],
      rankedViews: orderedRanked.slice(0, 3),
      clarityScore: validation.clarityScore ?? 0,
      preFlightMs: Date.now() - t0,
    };
  }
  const localizedSchema = formatSchemaForPrompt([targetView]);

  return {
    nextStep: "CONTINUE",
    targetView,
    rankedViews: orderedRanked.slice(0, 3),
    schemaText: localizedSchema,
    topViews: [targetView],
    clarityScore: validation.clarityScore ?? 1,
    preFlightMs: Date.now() - t0,
    correctedQuestion: question,
    originalQuestion: adaptive.originalQuestion || originalQuestion,
    adaptiveEnrichment: adaptive.enrichmentBlock,
    jargonReplacements: adaptive.jargonReplacements,
    valueCorrections: adaptive.valueCorrections,
    autoCorrections: adaptive.valueCorrections || [],
  };
}

module.exports = {
  CLARITY_THRESHOLD,
  CLARIFICATION_CHOICES,
  validateQueryFeasibility,
  suggestValidBusinessTerms,
  evaluateUserClarityGate,
  runPreFlightGate,
};
