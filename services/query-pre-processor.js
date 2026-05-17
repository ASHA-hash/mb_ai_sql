/**
 * Deterministic plain-English → canonical column jargon (before any LLM call).
 * Complements metadata-translation-engine; does not replace fuzzy value repair.
 */
"use strict";

const { translateJargonToColumn } = require("./metadata-translation-engine");

function isPurchaseDomainQuestion(text) {
  return /\b(purchase|purchases|procurement|grn|inward|vendor|vendors|supplier|suppliers)\b/i.test(
    String(text || "")
  );
}

/** Longest phrases first — word-boundary safe replacements. */
const JARGON_PHRASES = [
  ["purchase amount", "NetPurNetAmount"],
  ["purchase value", "NetPurNetAmount"],
  ["purchase cost", "NetPurNetAmount"],
  ["sale net amount", "MrpValue"],
  ["salenetamount", "MrpValue"],
  ["net sales amount", "MrpValue"],
  ["gross revenue", "MrpValue"],
  ["gross sales", "MrpValue"],
  ["net sales", "MrpValue"],
  ["net amount", "MrpValue"],
  ["sales amount", "MrpValue"],
  ["sales value", "MrpValue"],
  ["sales volume", "AppQty"],
  ["quantity sold", "AppQty"],
  ["invoice count", "BillCount"],
  ["bill count", "BillCount"],
  ["sales person", "SupplierName"],
  ["sales rep", "SupplierName"],
  ["salesperson", "SupplierName"],
  ["performance", "MrpValue"],
  ["turnover", "MrpValue"],
  ["revenue", "MrpValue"],
  ["employee", "SupplierName"],
  ["supplier", "SupplierName"],
  ["vendor", "SupplierName"],
  ["staff", "SupplierName"],
  ["quantity", "AppQty"],
  ["invoices", "XnNo"],
  ["invoice", "XnNo"],
  ["pieces", "AppQty"],
  ["pcs", "AppQty"],
  ["bills", "XnNo"],
  ["bill", "XnNo"],
  ["store", "BranchAlias"],
  ["branch", "BranchAlias"],
  ["location", "BranchAlias"],
  ["shop", "BranchAlias"],
  ["outlet", "BranchAlias"],
  ["category", "CategoryShortName"],
  ["department", "DepartmentShortName"],
];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Swap business jargon for canonical column tokens the SQL compiler understands.
 * @param {string} userInput
 * @returns {{ text: string, replacements: { from: string, to: string }[] }}
 */
function normalizeUserLanguage(userInput) {
  let text = String(userInput || "").trim();
  const replacements = [];
  if (!text) return { text: "", replacements };

  // Purchase/vendor questions use different views and metrics — keep plain English for fast-path + LLM.
  if (isPurchaseDomainQuestion(text)) {
    return { text, replacements };
  }

  for (const [phrase, canonical] of JARGON_PHRASES) {
    const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "gi");
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const before = text;
    text = text.replace(re, canonical);
    if (before !== text) {
      replacements.push({ from: phrase, to: canonical });
    }
  }

  const skipToken = new Set([
    "month", "year", "day", "week", "today", "yesterday", "mtd", "ytd", "qtd",
    "this", "last", "next", "from", "to", "and", "the", "for", "by", "with",
  ]);
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i].replace(/[^\w]/g, "");
    if (raw.length < 3 || skipToken.has(raw.toLowerCase())) continue;
    const col = translateJargonToColumn(raw);
    if (col && col.toLowerCase() !== raw.toLowerCase()) {
      const re = new RegExp(`\\b${escapeRegex(tokens[i])}\\b`, "g");
      const before = text;
      text = text.replace(re, col);
      if (before !== text) {
        replacements.push({ from: raw, to: col });
      }
    }
  }

  return { text, replacements };
}

function buildJargonEnrichmentBlock(replacements) {
  if (!replacements?.length) return "";
  const lines = replacements.map((r) => `- "${r.from}" → column \`${r.to}\``);
  return [
    "### PRE-PROCESSED JARGON (deterministic)",
    "The user's question was normalized before SQL generation:",
    ...lines,
    "Use the canonical column names in T-SQL; do not invent SaleNetAmount or NetAmount unless the target view lists them.",
  ].join("\n");
}

module.exports = {
  JARGON_PHRASES,
  normalizeUserLanguage,
  buildJargonEnrichmentBlock,
};
