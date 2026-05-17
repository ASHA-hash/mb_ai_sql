/**
 * AskYourDatabase-style adaptivity: jargon strip + fuzzy value repair before LLM.
 */
"use strict";

const { normalizeUserLanguage, buildJargonEnrichmentBlock } = require("./query-pre-processor");
const { repairFilterValues, buildValueRepairEnrichmentBlock } = require("./fuzzy-value-repair");
const { rankViewsByMappingCoverage } = require("./metadata-translation-engine");
const { loadSchema } = require("./schema-from-json");

/**
 * @param {string} rawUserQuestion
 * @param {{ autoCorrectOpts?: object, schemaJson?: object }} [opts]
 */
function runAdaptivePreprocess(rawUserQuestion, opts = {}) {
  const originalQuestion = String(rawUserQuestion || "").trim();
  const t0 = Date.now();

  const jargon = normalizeUserLanguage(originalQuestion);
  const fuzzy = repairFilterValues(jargon.text, {
    question: originalQuestion,
    ...opts.autoCorrectOpts,
  });

  const schemaJson = opts.schemaJson || loadSchema();
  const rankedViews = rankViewsByMappingCoverage(fuzzy.text, schemaJson).slice(0, 3);

  const enrichmentBlock = [
    buildJargonEnrichmentBlock(jargon.replacements),
    buildValueRepairEnrichmentBlock(fuzzy.corrections),
    rankedViews.length
      ? [
          "### VIEW ROUTING HINT (schema coverage)",
          `Prefer: \`${rankedViews[0].viewName}\` (${rankedViews[0].matchCount} canonical column hits).`,
          rankedViews[1]
            ? `Alternate: \`${rankedViews[1].viewName}\` (${rankedViews[1].matchCount} hits).`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const out = {
    originalQuestion,
    question: fuzzy.text,
    jargonReplacements: jargon.replacements,
    valueCorrections: fuzzy.corrections,
    rankedViews,
    enrichmentBlock,
    indexLoaded: fuzzy.indexLoaded,
    preprocessMs: Date.now() - t0,
  };

  if (jargon.replacements.length || fuzzy.corrections.length) {
    console.log(
      "[adaptive-preprocess]",
      `${out.preprocessMs}ms`,
      `jargon=${jargon.replacements.length}`,
      `values=${fuzzy.corrections.length}`,
      `→ "${fuzzy.text.slice(0, 100)}${fuzzy.text.length > 100 ? "…" : ""}"`
    );
  }

  return out;
}

module.exports = {
  runAdaptivePreprocess,
};
