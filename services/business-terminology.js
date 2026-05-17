/**
 * Business dictionary for prompt injection — backed by metadata-translation-engine.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { loadSchema } = require("./schema-from-json");
const {
  BUSINESS_TERM_MAPPINGS,
  buildMappingDictionaryBlock,
  buildViewResolutionBlock,
  detectTermsInQuestion,
  selectTopViewsForPipeline,
  formatRankedSchemaForPrompt,
  verifySchemaMetadata,
  loadSemanticConfig,
} = require("./metadata-translation-engine");

const KPI_PATH = path.join(__dirname, "../metadata/kpi-dictionary.json");

let _kpi = null;

function loadSemanticLayer() {
  return loadSemanticConfig();
}

function loadKpiDictionary() {
  if (_kpi) return _kpi;
  try {
    _kpi = JSON.parse(fs.readFileSync(KPI_PATH, "utf8"));
  } catch {
    _kpi = [];
  }
  return _kpi;
}

function rankViewsByMappingCoverage(question, opts = {}) {
  return selectTopViewsForPipeline(question, {
    topN: opts.topN ?? 2,
    tableHint: opts.tableHint,
    schemaJson: opts.schemaJson || loadSchema(),
  });
}

function buildBusinessDictionaryPrompt(viewNames, question) {
  const schemaJson = loadSchema();
  const lines = [
    buildMappingDictionaryBlock(),
    buildViewResolutionBlock(viewNames, schemaJson),
  ];

  const layer = loadSemanticLayer();
  const q = String(question || "").toLowerCase();
  const views = Array.isArray(viewNames) ? viewNames : [];

  for (const vn of views) {
    const def = layer[vn];
    if (!def || !String(vn).startsWith("dbo.")) continue;
    lines.push(`\n[${vn} — semantic layer]`);
    if (def.purpose) lines.push(`Purpose: ${def.purpose}`);
    if (def.dateColumn) lines.push(`Date filter column: ${def.dateColumn}`);
    if (def.branchColumn) lines.push(`Branch column: ${def.branchColumn}`);
    if (def.revenueColumn) lines.push(`Revenue column: ${def.revenueColumn}`);
  }

  const kpis = loadKpiDictionary();
  const matchedKpis = Array.isArray(kpis)
    ? kpis
        .filter((k) => {
          const t = String(k.term || "").toLowerCase();
          const aliases = (k.aliases || []).map((a) => String(a).toLowerCase());
          return q.includes(t) || aliases.some((a) => a.length > 3 && q.includes(a));
        })
        .slice(0, 4)
    : [];

  if (matchedKpis.length) {
    lines.push("\n### KPI DEFINITIONS");
    for (const k of matchedKpis) {
      lines.push(`• ${k.term}: ${k.definition}`);
    }
  }

  return lines.join("\n");
}

function detectJargonHints(question) {
  return detectTermsInQuestion(question).map((h) => ({
    term: h.alias,
    def: `Maps to column ${h.schemaColumn}`,
  }));
}

module.exports = {
  loadSemanticLayer,
  loadKpiDictionary,
  buildBusinessDictionaryPrompt,
  detectJargonHints,
  BUSINESS_TERM_MAPPINGS,
  rankViewsByMappingCoverage,
  formatRankedSchemaForPrompt,
  verifySchemaMetadata,
};
