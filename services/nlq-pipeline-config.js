/**
 * Central flags for NL → T-SQL pipeline behavior.
 * Default: adaptive LangGraph (no static exact-match short circuit).
 */
"use strict";

function envFlag(name, defaultOn) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return defaultOn;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

/** Static EXACT_MATCH_CACHE + canonical fast paths (off by default). */
function isFastPathEnabled() {
  return envFlag("NLQ_FAST_PATH", false);
}

/** Compile structured intent JSON → T-SQL without LLM when possible. */
function isIntentCompilerEnabled() {
  return envFlag("NLQ_INTENT_COMPILER", true);
}

/** Mandatory resolve_intent step before SQL generation. */
function isIntentStepEnabled() {
  return envFlag("ADAPTIVE_INTENT_STEP", true);
}

/** Live DISTINCT / LIKE value grounding before SQL generation. */
function isColumnDiscoveryEnabled() {
  return envFlag("COGNITIVE_COLUMN_DISCOVERY", true);
}

module.exports = {
  envFlag,
  isFastPathEnabled,
  isIntentCompilerEnabled,
  isIntentStepEnabled,
  isColumnDiscoveryEnabled,
};
