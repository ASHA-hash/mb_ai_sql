"use strict";

const BLOCKED = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|MERGE|EXEC(UTE)?|CREATE)\b/i;
const JOIN_PATTERN = /\bjoin\b/gi;
const JOIN_ON_PATTERN = /\bjoin\b[\s\S]*?\bon\b/gi;
const DATE_FILTER_PATTERN = /\b(where|and)\b[\s\S]*\b(dateadd|getdate|year\s*\(|month\s*\(|cast\s*\(.*as\s+date\))/i;
const TOP_PATTERN = /\bTOP\s*\(\s*(\d+)\s*\)|\bTOP\s+(\d+)\b/i;

/** Upper bound for TOP (align with AI_SQL_TOP_MAX / assertSafeSelectSql). Default 200 if unset. */
function maxTopAllowed() {
  const v = parseInt(String(process.env.AI_SQL_TOP_MAX || process.env.SQL_VALIDATOR_TOP_MAX || "200"), 10);
  if (!Number.isFinite(v) || v <= 0) return 200;
  return Math.min(v, 10000);
}

function normalize(sql) {
  return String(sql || "").replace(/\s+/g, " ").trim();
}

function createValidationError(message, code, details) {
  const err = new Error(message);
  err.code = code || "sql_validation_failed";
  err.details = details || {};
  return err;
}

function ensureSelectOnly(sql) {
  const s = normalize(sql);
  if (!s.toUpperCase().startsWith("SELECT")) {
    throw createValidationError("Only SELECT statements are allowed.", "only_select_allowed");
  }
  if (BLOCKED.test(s)) {
    throw createValidationError("Blocked keyword found in SQL.", "blocked_keyword");
  }
  if (/;\s*\S/.test(s)) {
    throw createValidationError("Multiple SQL statements are not allowed.", "multiple_statements");
  }
  return s.replace(/;+\s*$/g, "");
}

function ensureAllowlistedViews(sql, allowedViews) {
  const list = Array.isArray(allowedViews) ? allowedViews : [];
  if (!list.length) return;
  const allowedSet = new Set(
    list.flatMap((v) => {
      const n = normalizeViewName(v);
      return [n, stripDbo(n)];
    })
  );
  const referenced = extractViews(sql);
  if (!referenced.length) {
    throw createValidationError("SQL does not reference any allowlisted view for this domain.", "no_allowlisted_view");
  }
  const hasAllowed = referenced.some((v) => {
    const n = normalizeViewName(v);
    return allowedSet.has(n) || allowedSet.has(stripDbo(n));
  });
  if (!hasAllowed) {
    throw createValidationError("SQL does not reference any allowlisted view for this domain.", "no_allowlisted_view", {
      referenced_views: referenced,
      allowed_views: list,
    });
  }
}

function stripDbo(viewName) {
  return String(viewName || "").replace(/^dbo\./i, "");
}

function normalizeViewName(viewName) {
  return String(viewName || "")
    .replace(/\[|\]/g, "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function extractViews(sql) {
  const re = /\b(?:from|join)\s+((?:(?:\[[^\]]+\]|\w+)\.)?(?:\[[^\]]+\]|\w+))/gi;
  const out = [];
  let m;
  while ((m = re.exec(sql))) {
    const raw = String(m[1] || "");
    const cleaned = raw.replace(/\[|\]/g, "").trim();
    if (!cleaned) continue;
    const withSchema = cleaned.includes(".") ? cleaned : `dbo.${cleaned}`;
    if (!out.includes(withSchema)) out.push(withSchema);
  }
  return out;
}

function extractColumns(sql) {
  const re = /\b[a-zA-Z_][a-zA-Z0-9_]*\.(?:\[[^\]]+\]|[a-zA-Z_][a-zA-Z0-9_]*)/g;
  const out = [];
  const matches = String(sql || "").match(re) || [];
  for (const token of matches) {
    const parts = token.split(".");
    if (parts.length < 2) continue;
    // Ignore schema.object references like dbo.ViewName in FROM/JOIN clauses.
    if (String(parts[0]).replace(/\[|\]/g, "").toLowerCase() === "dbo") continue;
    const col = String(parts[1] || "").replace(/\[|\]/g, "");
    if (col && !out.includes(col)) out.push(col);
  }
  return out;
}

function ensureJoinClauses(sql) {
  const joins = (String(sql).match(JOIN_PATTERN) || []).length;
  if (!joins) return;
  const joinsWithOn = (String(sql).match(JOIN_ON_PATTERN) || []).length;
  if (joinsWithOn < joins) {
    throw createValidationError("JOIN found without valid ON clause.", "invalid_join_on");
  }
}

function editDistance(a, b) {
  const aa = String(a || "").toLowerCase();
  const bb = String(b || "").toLowerCase();
  const dp = Array.from({ length: aa.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= bb.length; j++) dp[0][j] = j;
  for (let i = 1; i <= aa.length; i++) {
    for (let j = 1; j <= bb.length; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[aa.length][bb.length];
}

function suggestColumns(invalidColumn, knownColumns) {
  const candidates = [...knownColumns]
    .map((col) => ({ col, d: editDistance(invalidColumn, col) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.col);
  return candidates;
}

function ensureLiveSchemaColumns(sql, context) {
  // Live schema introspection is helpful but brittle for AI-generated SQL
  // that includes computed aliases/subqueries. Keep it opt-in.
  if (String(process.env.LIVE_SCHEMA_VALIDATION || "0").trim() !== "1") return;

  const live = context?.liveColumns || {};
  const liveKeys = Object.keys(live);
  // If live metadata is unavailable, skip strict live-schema validation.
  if (!liveKeys.length) return;
  const referencedViews = extractViews(sql);
  if (!referencedViews.length) return;
  const liveKeyMap = {};
  for (const [k, cols] of Object.entries(live)) {
    const nk = normalizeViewName(k);
    liveKeyMap[nk] = cols;
    liveKeyMap[stripDbo(nk)] = cols;
  }
  const knownViewColumns = {};
  for (const view of referencedViews) {
    const n = normalizeViewName(view);
    const cols = liveKeyMap[n] || liveKeyMap[stripDbo(n)] || null;
    if (cols) knownViewColumns[view] = cols;
  }

  // If none of the referenced views are present in live metadata, skip this strict check.
  // This avoids blocking valid SQL when INFORMATION_SCHEMA introspection is partial/unavailable.
  const matchedViews = Object.keys(knownViewColumns);
  if (!matchedViews.length) return;

  const knownColumns = new Set();
  const viewObjectNames = new Set(
    matchedViews.map((v) => {
      const clean = String(v).replace(/\[|\]/g, "");
      const parts = clean.split(".");
      return String(parts[parts.length - 1] || "").toLowerCase();
    })
  );
  for (const view of matchedViews) {
    const cols = knownViewColumns[view] || [];
    for (const c of cols) knownColumns.add(String(c).toLowerCase());
  }
  if (!knownColumns.size) return;
  const referencedColumns = extractColumns(sql);
  for (const c of referencedColumns) {
    // Skip object names accidentally captured from object references.
    if (viewObjectNames.has(String(c).toLowerCase())) continue;
    if (!knownColumns.has(String(c).toLowerCase())) {
      throw createValidationError(`Unknown column in SQL (live schema check): ${c}`, "unknown_column", {
        invalid_column: c,
        suggested_columns: suggestColumns(c, knownColumns),
      });
    }
  }
}

function ensureCostProtection(sql, context) {
  const s = String(sql || "");
  const cap = maxTopAllowed();
  const topMatch = s.match(TOP_PATTERN);
  if (topMatch) {
    const topValue = parseInt(topMatch[1] || topMatch[2], 10);
    if (!Number.isFinite(topValue) || topValue < 1 || topValue > cap) {
      throw createValidationError(`TOP value must be between 1 and ${cap}.`, "invalid_top_value");
    }
  }
  if (/select\s+\*/i.test(s) && !/\b(group\s+by|sum\s*\(|count\s*\(|avg\s*\(|min\s*\(|max\s*\()/i.test(s)) {
    throw createValidationError("SELECT * without aggregation is blocked for cost protection.", "select_star_blocked");
  }
  // Date filter recommendation is now prompt-driven, not a hard validator block.
}

/**
 * Revenue Guard:
 * reject SQL that appears to compute revenue using disallowed fields.
 */
function validateRevenueUsage(sql, context) {
  const upperSql = String(sql || "").toUpperCase();
  const domain = String(context?.domain || "").toLowerCase();
  const hasAggregate = upperSql.includes("SUM(");
  const hasRevenueIntentToken =
    upperSql.includes("REVENUE") || upperSql.includes("NETAMOUNT") || upperSql.includes("TOTALSALES");
  const hasAmountLikeToken = upperSql.includes("AMOUNT") || upperSql.includes("VALUE");

  const shouldApplyGuard = hasAggregate && (domain === "sales" || hasRevenueIntentToken || hasAmountLikeToken);
  if (!shouldApplyGuard) return;

  const allowedRevenue =
    /\bSUM\s*\(\s*(?:ISNULL\s*\(\s*)?\[?(?:MRPVALUE|NETAMOUNT|NETSLSNETAMOUNT|SALENETAMOUNT|APPNETVALUE|NETSLSNETAMOUNT)\]?/i.test(
      sql
    );
  const usesItemMrp =
    /\bSUM\s*\(\s*(?:ISNULL\s*\(\s*)?\[?ITEMMRP\]?/i.test(sql) ||
    /\bSUM\s*\(\s*(?:ISNULL\s*\(\s*)?\[?MRP\](?!\s*VALUE)/i.test(sql);
  const isAiSalesView = upperSql.includes("VWAISALESDATA");
  const usesBeforeTax =
    upperSql.includes("NETAMOUNTBEFORETAX") ||
    (!isAiSalesView && upperSql.includes("SALEAMOUNTBEFORETAX"));
  const usesCostOnly =
    (upperSql.includes("SUM(COSTVALUE)") ||
      upperSql.includes("SUM(PURCOST)") ||
      upperSql.includes("SUM(NETSLSCOSTVALUE)")) &&
    !allowedRevenue;

  if ((usesItemMrp || usesBeforeTax || usesCostOnly) && !allowedRevenue) {
    throw createValidationError(
      "Revenue must use SUM(MrpValue), SUM(NetAmount), or SUM(NetSlsNetAmount) from an allowlisted Power BI view. " +
        "Do not use ItemMRP, cost-only fields, or amount-before-tax as revenue.",
      "invalid_revenue_metric"
    );
  }
}

function validateSql(sql, context) {
  const clean = ensureSelectOnly(sql);
  ensureAllowlistedViews(clean, context?.viewConfig?.allowed_views);
  ensureJoinClauses(clean);
  ensureLiveSchemaColumns(clean, context);
  validateRevenueUsage(clean, context);
  ensureCostProtection(clean, context);
  return clean;
}

/**
 * Structural accuracy gate (LangGraph check_sql) — no DB round-trip.
 * Catches revenue metric drift and unbounded line-level scans before execute_sql.
 */
function validateSqlAccuracy(generatedSql, userQuestion, context = {}) {
  const sql = String(generatedSql || "").trim();
  const q = String(userQuestion || "").toLowerCase();
  if (!sql) {
    return { isValid: false, reason: "No SQL was generated." };
  }

  const upper = sql.toUpperCase();
  const asksPurchase =
    /\b(purchase|procurement|pur_report|purxns|inward|grn)\b/.test(q) ||
    (/\b(vendor|supplier)\b/.test(q) && /\b(purchase|pur_|procurement)\b/.test(q));

  const asksRevenue =
    !asksPurchase &&
    (/\b(revenue|sales|turnover|salenetamount|gross|net\s*sales|mrp|mtd|ytd|qtd|invoice|bills?)\b/.test(q) ||
      (/\b(highest|top|best|leading)\b/.test(q) &&
        /\b(branch|branches|salesperson|staff|category|categories|department|dept|article|product|store)\b/.test(q)));

  const amountTokens = ["MRPVALUE", "NETAMOUNT", "NETSLSNETAMOUNT", "SALENETAMOUNT", "APPNETVALUE"];
  const purchaseAmountTokens = [
    "NETPURNETAMOUNT",
    "PURNETAMOUNT",
    "PURMRPVALUE",
    "PURCOSTVALUE",
    "PURCHASEPRICE",
    "NETPURCOST",
    "PURNETAMOUNT",
  ];
  const hasRevenueAgg = amountTokens.some((t) => upper.includes(`SUM(${t}`) || upper.includes(`SUM([${t}]`) || upper.includes(`SUM( ${t}`));
  const hasPurchaseAgg = purchaseAmountTokens.some(
    (t) => upper.includes(`SUM(${t}`) || upper.includes(`SUM([${t}]`) || upper.includes(`SUM( ${t}`) || upper.includes(`SUM(ISNULL([${t}]`)
  );
  const hasAnyAgg =
    /\bSUM\s*\(/i.test(sql) ||
    /\bCOUNT\s*\(/i.test(sql) ||
    /\bAVG\s*\(/i.test(sql) ||
    /\bMIN\s*\(/i.test(sql) ||
    /\bMAX\s*\(/i.test(sql);

  if (asksPurchase && hasAnyAgg && !hasPurchaseAgg && !hasRevenueAgg) {
    return {
      isValid: false,
      reason:
        "Purchase questions must aggregate purchase amount (e.g. SUM(NetPurNetAmount) on PURXNS, or SUM(PurchasePrice*PurQty) on SUPPLIER_PUR_REPORT).",
    };
  }

  if (asksRevenue && hasAnyAgg && !hasRevenueAgg) {
    const preferred = String(context?.amountCol || "MrpValue");
    return {
      isValid: false,
      reason:
        `The user requested revenue/sales metrics, but the query does not aggregate canonical revenue ` +
        `(SUM(${preferred}) or SUM(NetAmount)). Do not use quantity-only or cost-only fields.`,
    };
  }

  const hasTop = TOP_PATTERN.test(sql);
  if (upper.includes("SELECT") && !hasAnyAgg && !hasTop) {
    return {
      isValid: false,
      reason:
        "Unbounded non-aggregated scan detected. Apply server-side aggregation (SUM, COUNT, AVG) " +
        "or include TOP (100) when returning raw rows.",
    };
  }

  if (/\bSELECT\s+\*/i.test(sql) && !hasAnyAgg && !hasTop) {
    return {
      isValid: false,
      reason: "SELECT * without aggregation or TOP is blocked — specify columns and aggregate.",
    };
  }

  const legacyView = /\bVWAISALESDATA\b/i.test(sql);
  if (legacyView && String(context?.domain || "").toLowerCase() === "sales") {
    return {
      isValid: false,
      reason: "Use dbo.VW_MB_POWERBI_APP_REPORT (allowlisted) instead of dbo.VwAISalesData.",
    };
  }

  return { isValid: true };
}

/** True if SQL appears to constrain by a dynamic date (GETDATE, DATEADD, YEAR/MONTH on dates, CAST-as-date patterns). */
function hasDatePredicate(sql) {
  return DATE_FILTER_PATTERN.test(String(sql || ""));
}

module.exports = { validateSql, validateSqlAccuracy, hasDatePredicate };
