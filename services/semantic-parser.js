/**
 * services/semantic-parser.js
 *
 * DETERMINISTIC natural-language -> structured query intent.
 * Zero LLM calls. Same input always produces same output.
 * Replaces the scattered if-else buildIntentGuidance() function.
 */
"use strict";

// ---------------------------------------------------------------------------
// DATE HELPERS
// ---------------------------------------------------------------------------

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function parseIndianDate(s) {
  const m = String(s).match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// DATE EXTRACTION
// ---------------------------------------------------------------------------

/**
 * Extract all explicit date/period references from a question.
 * Returns [{label, date}] where date is YYYY-MM-DD.
 */
function extractDates(text) {
  const q = String(text || "");
  const results = [];
  const seen = new Set();
  const now = new Date();

  function add(label, date) {
    if (date && !seen.has(date)) {
      seen.add(date);
      results.push({ label: label, date: date });
    }
  }

  function offsetISO(days) {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // Longer phrases first to avoid partial matches
  if (/\blast\s*monday\b/i.test(q)) {
    const dow = now.getDay(); // 0=Sun,1=Mon,...,6=Sat
    const daysBack = (dow === 0 ? 6 : dow - 1) + 7; // always LAST week's Monday
    add("Last Monday", offsetISO(-daysBack));
  }
  if (/\blast\s*month\b/i.test(q)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    add("Last Month", d.toISOString().slice(0, 10));
  }
  if (/\b7\s*days?\s*ago\b/i.test(q))  add("7 Days Ago",  offsetISO(-7));
  if (/\b30\s*days?\s*ago\b/i.test(q)) add("30 Days Ago", offsetISO(-30));

  // today / yesterday (after longer phrases)
  if (/\btoday\b/i.test(q))     add("Today",     todayISO());
  if (/\byesterday\b/i.test(q)) add("Yesterday",  yesterdayISO());

  // DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY
  var indianRe = /\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\b/g;
  var im;
  while ((im = indianRe.exec(q)) !== null) {
    var iso = parseIndianDate(im[0]);
    if (iso) add(im[0], iso);
  }

  // ISO dates YYYY-MM-DD
  var isoRe = /\b(\d{4}-\d{2}-\d{2})\b/g;
  var isom;
  while ((isom = isoRe.exec(q)) !== null) {
    add(isom[1], isom[1]);
  }

  return results;
}

// ---------------------------------------------------------------------------
// INTENT DETECTION
// ---------------------------------------------------------------------------

function isComparisonQuery(q) {
  return /\bvs\.?\b|\bversus\b|\bcompare\b|\bcomparison\b|\bagainst\b/i.test(q);
}

function isTrendQuery(q) {
  return /\btrend\b|\bover\s+time\b|\bday[\s-]by[\s-]day\b|\bweekly\b|\bmonthly\b|\bdaily\b|\bby\s+(day|week|month|quarter|year)\b|\bmonth[\s-]on[\s-]month\b|\byear[\s-]on[\s-]year\b/i.test(q);
}

function detectTopN(q) {
  var m = q.match(/\btop\s+(\d+)\b|\bbest\s+(\d+)\b|\bhighest\s+(\d+)\b/i);
  if (m) return { n: parseInt(m[1] || m[2] || m[3]), direction: "desc" };
  m = q.match(/\bbottom\s+(\d+)\b|\blowest\s+(\d+)\b|\bworst\s+(\d+)\b/i);
  if (m) return { n: parseInt(m[1]), direction: "asc" };
  return null;
}

function detectLastNDays(q) {
  var m = q.match(/\blast\s*(\d+)\s*days?\b/i);
  return m ? parseInt(m[1]) : null;
}

// ---------------------------------------------------------------------------
// MAIN PARSER
// ---------------------------------------------------------------------------

/**
 * parseQuery(text) -> structured intent object.
 * queryType: 'comparison' | 'top_n' | 'trend' | 'kpi' | 'generic'
 */
function parseQuery(text) {
  var q = String(text || "");
  var dates     = extractDates(q);
  var topN      = detectTopN(q);
  var lastNDays = detectLastNDays(q);

  var hasExplicitComparison = isComparisonQuery(q);
  var hasMultipleDates      = dates.length >= 2;
  var isComparison          = hasExplicitComparison || hasMultipleDates;
  var isTrend               = isTrendQuery(q);

  var queryType = "generic";
  if (isComparison && dates.length >= 2)  queryType = "comparison";
  else if (topN)                          queryType = "top_n";
  else if (isTrend)                       queryType = "trend";
  else if (/\btotal\b|\boverall\b|\bsummary\b|\bkpi\b|\baggregate\b/i.test(q) && !topN && !isTrend)
    queryType = "kpi";

  return {
    queryType:   queryType,
    dates:       dates,
    topN:        topN,
    lastNDays:   lastNDays,
    isComparison: isComparison,
    isTrend:     isTrend,
    rawQuestion: q,
  };
}

// ---------------------------------------------------------------------------
// SQL CONSTRAINT BUILDER
// Replaces buildIntentGuidance() -- driven purely by parsed intent,
// not by per-query-type if-else chains.
// ---------------------------------------------------------------------------

/**
 * buildIntentConstraints(parsed) -> string appended to LLM prompt.
 * Gives the LLM exact SQL structural constraints so it cannot guess the
 * wrong pattern. Works for any query because it's driven by parsed intent.
 */
function buildIntentConstraints(parsed) {
  if (!parsed) return "";
  var lines = ["\n\n[QUERY INTENT -- mandatory SQL contract]"];

  if (parsed.queryType === "comparison") {
    lines.push(
      "INTENT: Date comparison across " + parsed.dates.length + " specific point(s).",
      "MANDATORY SQL STRUCTURE: UNION ALL -- one SELECT branch per date below.",
      "Each branch MUST have a 'Period' label column (first column) + the metric column(s).",
      "Do NOT use date ranges. Do NOT merge dates. Each date = its own branch.",
      "",
      "Dates / periods to compare:"
    );
    parsed.dates.forEach(function(d) {
      lines.push("  - Label '" + d.label + "' -> WHERE CAST(<DateCol> AS date) = '" + d.date + "'");
    });
    var first = parsed.dates[0] || { label: "Period1", date: "YYYY-MM-DD" };
    lines.push(
      "",
      "Final SQL template:",
      "  SELECT '" + first.label + "' AS Period, SUM(<metric>) AS <MetricAlias> FROM dbo.<view> WHERE CAST(<DateCol> AS date) = '" + first.date + "'"
    );
    parsed.dates.slice(1).forEach(function(d) {
      lines.push("  UNION ALL SELECT '" + d.label + "' AS Period, SUM(<metric>) AS <MetricAlias> FROM dbo.<view> WHERE CAST(<DateCol> AS date) = '" + d.date + "'");
    });
    lines.push("ORDER BY 1");

  } else if (parsed.queryType === "top_n") {
    var n   = (parsed.topN && parsed.topN.n)  || 10;
    var dir = (parsed.topN && parsed.topN.direction === "asc") ? "ASC" : "DESC";
    lines.push(
      "INTENT: Top-" + n + " ranking query.",
      "MANDATORY: SELECT TOP " + n + " ... ORDER BY <metric> " + dir,
      "JOIN DIRECTION (critical): Always FROM the large fact table (e.g. VwAISalesData) and JOIN to master/lookup tables.",
      "NEVER start FROM a master table -- it has very few rows, capping results at that small count regardless of TOP " + n + ".",
      "The __join_direction_advisory__ in the schema block confirms which is the fact table."
    );

  } else if (parsed.queryType === "trend") {
    var q2 = parsed.rawQuestion || "";
    var isMonthly = /\bmonthly\b|\bby\s+month\b|\bmonth[\s-]by[\s-]month\b/i.test(q2);
    var isWeekly  = /\bweekly\b|\bby\s+week\b/i.test(q2);
    var groupExpr;
    if (isMonthly) {
      groupExpr = "FORMAT(<DateCol>, 'MMM yyyy') AS SaleMonth  -- also GROUP BY YEAR(<DateCol>), MONTH(<DateCol>)";
    } else if (isWeekly) {
      groupExpr = "DATEPART(week, <DateCol>) AS WeekNo  -- also GROUP BY YEAR(<DateCol>), DATEPART(week, <DateCol>)";
    } else {
      groupExpr = "CAST(<DateCol> AS date) AS SaleDate  -- GROUP BY CAST(<DateCol> AS date)";
    }
    lines.push(
      "INTENT: Time-series trend.",
      "GROUPING: " + groupExpr,
      "MANDATORY: Include the date/period group column in SELECT. ORDER BY the date ASC.",
      "Do NOT return one row per invoice/transaction -- aggregate (SUM/COUNT) by time period.",
      "Do NOT use TOP N (unless user specified a row limit)."
    );

  } else if (parsed.queryType === "kpi") {
    lines.push(
      "INTENT: Single-row aggregate KPI.",
      "Return exactly ONE row with clearly named aggregate columns (e.g. TotalSales, TotalOrders).",
      "No GROUP BY unless the user mentioned a grouping dimension."
    );

  } else {
    // generic
    if (parsed.lastNDays) {
      lines.push(
        "DATE FILTER: last " + parsed.lastNDays + " days.",
        "SQL: WHERE CAST(<DateCol> AS date) >= DATEADD(day, -" + parsed.lastNDays + ", CAST(GETDATE() AS date))"
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CHART POLICY from parsed intent (pre-execution hint)
// Post-execution shape-based selector will override this when results arrive.
// ---------------------------------------------------------------------------
function chartPolicyFromIntent(parsed) {
  if (!parsed) return "auto";
  if (parsed.queryType === "comparison") return "bar";
  if (parsed.queryType === "trend")      return "line";
  if (parsed.queryType === "top_n")      return "bar";
  if (parsed.queryType === "kpi")        return "kpi_card";
  return "auto";
}

module.exports = {
  parseQuery:            parseQuery,
  buildIntentConstraints: buildIntentConstraints,
  chartPolicyFromIntent: chartPolicyFromIntent,
  extractDates:          extractDates,
  isComparisonQuery:     isComparisonQuery,
  isTrendQuery:          isTrendQuery,
  detectTopN:            detectTopN,
};
