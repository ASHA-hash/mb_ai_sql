/**
 * Central flags for NL → T-SQL pipeline behavior.
 * Default: adaptive LangGraph (no static exact-match short circuit).
 */
"use strict";

const runtimeConfig = require("./runtime-config");

/** Static EXACT_MATCH_CACHE + canonical fast paths (off by default). */
function isFastPathEnabled() {
  return runtimeConfig.getBool("NLQ_FAST_PATH");
}

/** Compile structured intent JSON → T-SQL without LLM when possible. */
function isIntentCompilerEnabled() {
  return runtimeConfig.getBool("NLQ_INTENT_COMPILER");
}

/** Mandatory resolve_intent step before SQL generation. */
function isIntentStepEnabled() {
  return runtimeConfig.getBool("ADAPTIVE_INTENT_STEP");
}

/** Live DISTINCT / LIKE value grounding before SQL generation. */
function isColumnDiscoveryEnabled() {
  return runtimeConfig.getBool("COGNITIVE_COLUMN_DISCOVERY");
}

module.exports = {
  envFlag,
  isFastPathEnabled,
  isIntentCompilerEnabled,
  isIntentStepEnabled,
  isColumnDiscoveryEnabled,
};
