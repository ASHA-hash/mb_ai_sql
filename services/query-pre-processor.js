/**
 * Deterministic plain-English → canonical column jargon (before any LLM call).
 * Complements metadata-translation-engine; does not replace fuzzy value repair.
 */
"use strict";

const { translateJargonToColumn } = require("./metadata-translation-engine");
const { isSalespersonTopNQuestion } = require("./canonical-salesperson-sql");

function isPurchaseDomainQuestion(text) {
  return /\b(purchase|purchases|procurement|grn|inward|vendor|vendors|supplier|suppliers)\b/i.test(
    String(text || "")
  );
}

/**
 * Longest phrases first — word-boundary safe replacements.
 * Maps colloquial retail jargon to canonical DB column names BEFORE any LLM call.
 * Columns verified against VW_MB_POWERBI_APP_REPORT schema.
 */
const JARGON_PHRASES = [
  // ── Purchase domain ───────────────────────────────────────────────────────
  ["purchase amount",      "NetPurNetAmount"],
  ["purchase value",       "NetPurNetAmount"],
  ["purchase cost",        "NetPurNetAmount"],

  // ── Multi-word sales metrics (longest first to avoid partial matches) ─────
  ["sale net amount",      "MrpValue"],
  ["salenetamount",        "MrpValue"],
  ["net sales amount",     "MrpValue"],
  ["gross revenue",        "MrpValue"],
  ["gross sales",          "MrpValue"],
  ["net sales",            "MrpValue"],
  ["sales amount",         "MrpValue"],
  ["sales value",          "MrpValue"],
  ["total revenue",        "MrpValue"],
  ["total sales value",    "MrpValue"],

  // ── Cost / margin ─────────────────────────────────────────────────────────
  ["cost of goods sold",   "CostValue"],
  ["product cost",         "CostValue"],
  ["item cost",            "CostValue"],
  ["cost value",           "CostValue"],

  // ── Net amount (real column — do NOT remap to MrpValue) ──────────────────
  // (keeping "net amount" as natural English; the LLM will see [NetAmount] in schema)

  // ── Quantity / volume ─────────────────────────────────────────────────────
  ["sales volume",         "AppQty"],
  ["quantity sold",        "AppQty"],
  ["units sold",           "AppQty"],
  ["pieces sold",          "AppQty"],
  ["items sold",           "AppQty"],

  // ── Bill / footfall ───────────────────────────────────────────────────────
  ["invoice count",        "BillCount"],
  ["bill count",           "BillCount"],
  ["number of bills",      "BillCount"],
  ["number of invoices",   "BillCount"],
  ["footfall",             "BillCount"],

  // ── Single-word metric aliases ─────────────────────────────────────────
  ["turnover",             "MrpValue"],
  ["revenue",              "MrpValue"],
  ["performance",          "MrpValue"],

  // ── Vendor / supplier dimension ──────────────────────────────────────────
  ["vendor alias",         "SupplierAlias"],
  ["brand alias",          "SupplierAlias"],
  ["supplier alias",       "SupplierAlias"],
  ["vendor city",          "SupplierCity"],
  ["supplier city",        "SupplierCity"],
  ["vendor state",         "SupplierState"],
  ["supplier state",       "SupplierState"],
  ["supplier",             "SupplierName"],
  ["vendor",               "SupplierName"],
  ["brand",                "SupplierName"],

  // ── Quantity singles ──────────────────────────────────────────────────────
  ["quantity",             "AppQty"],
  ["pieces",               "AppQty"],
  ["pcs",                  "AppQty"],
  ["units",                "AppQty"],

  // ── Invoice / bill ────────────────────────────────────────────────────────
  ["invoices",             "XnNo"],
  ["invoice",              "XnNo"],
  ["cashmemo",             "XnNo"],
  ["cash memo",            "XnNo"],
  ["memo no",              "XnNo"],
  ["memo number",          "XnNo"],

  // ── Article / product (multi-word first) ─────────────────────────────────
  ["article number",       "ArticleNo"],
  ["article no",           "ArticleNo"],
  ["product code",         "ArticleNo"],
  ["item code",            "ArticleNo"],
  ["style code",           "ArticleNo"],
  ["itemcode",             "ArticleNo"],
  ["style no",             "ArticleNo"],
  ["style number",         "ArticleNo"],
  ["articles",             "ArticleNo"],
  ["article",              "ArticleNo"],
  ["sku",                  "ArticleNo"],
  ["skus",                 "ArticleNo"],

  // ── Garment attributes ────────────────────────────────────────────────────
  ["sub fabric",           "SubFabric"],
  ["subfabric",            "SubFabric"],
  ["fabric type",          "Fabric"],
  ["material type",        "Fabric"],
  ["fabric",               "Fabric"],
  ["material",             "Fabric"],
  ["colour",               "Color"],   // British spelling → canonical DB column
  ["color",                "Color"],
  ["size",                 "Size"],
  ["concept",              "Concept"],
  ["property",             "Property"],
  ["contrast",             "Contrast"],

  // ── Item price ────────────────────────────────────────────────────────────
  ["selling price",        "ItemMRP"],
  ["retail price",         "ItemMRP"],
  ["mrp price",            "ItemMRP"],
  ["mrp",                  "ItemMRP"],
  ["max retail price",     "ItemMRP"],

  // ── Location / branch ─────────────────────────────────────────────────────
  ["store",                "BranchAlias"],
  ["branch",               "BranchAlias"],
  ["location",             "BranchAlias"],
  ["shop",                 "BranchAlias"],
  ["outlet",               "BranchAlias"],
  ["showroom",             "BranchAlias"],

  // ── Category / department ─────────────────────────────────────────────────
  ["product category",     "CategoryShortName"],
  ["category",             "CategoryShortName"],
  ["department",           "DepartmentShortName"],
  ["dept",                 "DepartmentShortName"],
  ["division",             "DepartmentShortName"],
  ["section",              "DepartmentShortName"],

  // ── Retail-specific KPI abbreviations & slang ────────────────────────────
  // Average Transaction Value / Average Selling Price
  ["average transaction value", "MrpValue"],
  ["atv",                  "MrpValue"],   // context: average per bill — handled by intent layer
  ["average basket",       "MrpValue"],
  ["basket size",          "MrpValue"],
  ["average selling price","ItemMRP"],
  ["asp",                  "ItemMRP"],

  // Gross profit / margin (GP)
  ["gross profit",         "GrossProfit"],
  ["gp value",             "GrossProfit"],
  ["gross margin",         "GrossProfit"],
  ["margin",               "GrossProfit"],

  // Closing / opening stock
  ["closing stock",        "ClosingQty"],
  ["closing qty",          "ClosingQty"],
  ["closing quantity",     "ClosingQty"],
  ["opening stock",        "OpeningQty"],
  ["opening qty",          "OpeningQty"],
  ["stock on hand",        "ClosingQty"],
  ["current stock",        "ClosingQty"],
  ["available stock",      "ClosingQty"],
  ["inventory",            "ClosingQty"],

  // Goods In Transit (GIT)
  ["goods in transit",     "GITQty"],
  ["git",                  "GITQty"],
  ["in transit",           "GITQty"],
  ["transit stock",        "GITQty"],

  // Sell-through rate
  ["sell through",         "SellThrough"],
  ["sell-through",         "SellThrough"],
  ["st%",                  "SellThrough"],

  // Return / refund
  ["return amount",        "ReturnAmount"],
  ["return value",         "ReturnAmount"],
  ["returns",              "ReturnAmount"],
  ["refund",               "ReturnAmount"],
  ["net of returns",       "NetSlsNetAmount"],
  ["net revenue",          "NetSlsNetAmount"],

  // Discount
  ["discount amount",      "DiscountAmount"],
  ["discount value",       "DiscountAmount"],
  ["markdown",             "DiscountAmount"],

  // Customer / loyalty
  ["loyalty points",       "LoyaltyPoints"],
  ["reward points",        "LoyaltyPoints"],
  ["points earned",        "LoyaltyPoints"],
  ["repeat customer",      "CustomerId"],
  ["unique customer",      "CustomerId"],
  ["new customer",         "CustomerId"],
  ["customer count",       "CustomerId"],

  // Transfer
  ["stock transfer out",   "StoQty"],
  ["sto",                  "StoQty"],
  ["stock transfer in",    "StiQty"],
  ["sti",                  "StiQty"],

  // Purchase / GRN (ensure these are recognised before generic "inward" hits LLM)
  ["goods received note",  "NetPurNetAmount"],
  ["grn",                  "NetPurNetAmount"],
  ["inward qty",           "PurQty"],
  ["purchase qty",         "PurQty"],
  ["purchase quantity",    "PurQty"],
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

  // Pure purchase-domain questions — keep plain English for fast-path + purchase LLM routing.
  if (isPurchaseDomainQuestion(text)) {
    return { text, replacements };
  }

  // Salesperson TOP-N ranking — bypass jargon replacement so fast-path canonical SQL fires.
  // The salesperson route uses VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID (SalesPersonName col),
  // not APP_REPORT (SupplierName), so we must NOT mangle the question before routing.
  if (isSalespersonTopNQuestion(text)) {
    return { text, replacements };
  }

  // Footfall / bill count — keep natural language so intent compiler routes to SLSXNS BillCount.
  if (/\bhow many\b/i.test(text) && /\b(bills?|invoices?|footfall|transactions?)\b/i.test(text)) {
    return { text, replacements };
  }

  // Stock / inventory questions — pass through so stock-domain fast-path + LLM routing fire correctly.
  if (/\b(stock|inventory|closing stock|opening stock|oos|out of stock|stockout|reorder)\b/i.test(text)) {
    return { text, replacements };
  }

  // Transfer questions — pass through so transfer fast-path fires.
  if (/\b(transfer|sti|sto|stock transfer)\b/i.test(text)) {
    return { text, replacements };
  }

  // Customer / loyalty questions — pass through so customer domain routes correctly.
  if (/\b(customer|loyalty|birthday|member|crm|lapsed|repeat|spender)\b/i.test(text)) {
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
