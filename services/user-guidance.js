/**
 * Adaptive user guidance — clarity chips, auto-correct, dimension pickers.
 */
"use strict";

const { searchDimensionValues, applyAutoCorrectionsToQuestion } = require("./string-auto-correct");
const { loadDimensionIndex, indexIsStale } = require("./dimension-index");

const INTERACTIVE_CHIPS = [
  {
    label: "Total sales by month",
    text: "Show total gross revenue performance split by month",
  },
  {
    label: "Top performing stores",
    text: "Rank top store locations by total gross revenue this month",
  },
  {
    label: "Best selling categories",
    text: "Which product categories sold the most pieces this month",
  },
  {
    label: "Sales today",
    text: "total sales today",
  },
];

const VAGUE_SINGLE_WORD = new Set([
  "sales",
  "revenue",
  "performance",
  "turnover",
  "report",
  "data",
  "numbers",
  "results",
  "compare",
  "comparison",
]);

/**
 * AskYourDatabase-style interactive gate (zero tokens).
 */
function evaluateUserClarityGate(userQuestion) {
  const query = normalizeInput(userQuestion);

  if (!query) {
    return {
      viable: false,
      type: "INTERACTIVE_CLARIFICATION",
      message: "Ask me something about your retail data — for example sales by store or revenue this month.",
      suggestedOptions: INTERACTIVE_CHIPS,
    };
  }

  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 1 && VAGUE_SINGLE_WORD.has(words[0])) {
    return {
      viable: false,
      type: "INTERACTIVE_CLARIFICATION",
      message:
        "I can pull that summary for you. How would you like to break down the information?",
      suggestedOptions: INTERACTIVE_CHIPS,
    };
  }

  if (
    (words.length <= 2 && /\b(performance|compare|comparison|report)\b/.test(query)) ||
    query === "compare performance"
  ) {
    return {
      viable: false,
      type: "INTERACTIVE_CLARIFICATION",
      message:
        "I can compare performance for you. Pick a breakdown or add a time period:",
      suggestedOptions: INTERACTIVE_CHIPS,
    };
  }

  return { viable: true, type: "OK" };
}

function normalizeInput(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect likely branch/category token without exact index hit → suggest picker.
 */
function detectDimensionPickerNeed(question) {
  const q = String(question || "");
  const clean = normalizeInput(q);

  const forMatch = clean.match(/\b(?:sales|revenue|turnover|for|at|in)\s+(?:the\s+)?([a-z][a-z0-9\s]{2,40})/i);
  if (!forMatch) return null;

  const phrase = forMatch[1].trim();
  if (/\b(today|yesterday|month|year|mtd|ytd|branch|store|category)\b/.test(phrase)) {
    return null;
  }

  const branchHits = searchDimensionValues(phrase, "BranchAlias", 8);
  const exactBranch = branchHits.find((v) => v.toLowerCase() === phrase);
  if (exactBranch) return null;

  if (branchHits.length > 0) {
    const partial = branchHits.filter((v) => v.toLowerCase().includes(phrase.slice(0, 4)));
    if (partial.length >= 2 && partial.length <= 12) {
      return {
        dimension: "BranchAlias",
        query: phrase,
        options: partial,
        message: `I found several stores matching "${phrase}". Which location did you mean?`,
      };
    }
  }

  return null;
}

/**
 * Full pre-API preparation: clarity → auto-correct → optional picker.
 */
function prepareQuestionForPipeline(userQuestion) {
  const clarityGate = evaluateUserClarityGate(userQuestion);
  if (!clarityGate.viable) {
    return {
      ok: false,
      status: "CLARIFICATION_REQUIRED",
      uiType: "SUGGESTION_CHIPS",
      clarificationNeeded: true,
      clarificationQuestion: clarityGate.message,
      suggestedOptions: clarityGate.suggestedOptions,
      clarificationOptions: (clarityGate.suggestedOptions || []).map((o, i) => ({
        id: `chip_${i}`,
        label: o.label,
        term: o.text,
      })),
    };
  }

  const auto = applyAutoCorrectionsToQuestion(userQuestion);
  const workingQuestion = auto.correctedQuestion;

  const picker = detectDimensionPickerNeed(workingQuestion);
  if (picker && picker.options.length >= 2) {
    return {
      ok: false,
      status: "CLARIFICATION_REQUIRED",
      uiType: "DIMENSION_PICKER",
      clarificationNeeded: true,
      clarificationQuestion: picker.message,
      dimensionPicker: picker,
      correctedQuestion: workingQuestion,
      autoCorrections: auto.corrections,
    };
  }

  return {
    ok: true,
    question: workingQuestion,
    originalQuestion: userQuestion,
    autoCorrections: auto.corrections,
    indexStale: indexIsStale(),
    indexLoaded: auto.indexLoaded,
  };
}

function toAdaptiveClarificationResponse(prep) {
  return {
    clarificationNeeded: true,
    status: prep.status || "CLARIFICATION_REQUIRED",
    uiType: prep.uiType || "SUGGESTION_CHIPS",
    clarificationQuestion: prep.clarificationQuestion,
    suggestedOptions: prep.suggestedOptions || [],
    clarificationOptions: prep.clarificationOptions || [],
    dimensionPicker: prep.dimensionPicker || null,
    autoCorrections: prep.autoCorrections || [],
    mode: "user_guidance",
  };
}

module.exports = {
  evaluateUserClarityGate,
  prepareQuestionForPipeline,
  toAdaptiveClarificationResponse,
  INTERACTIVE_CHIPS,
};
