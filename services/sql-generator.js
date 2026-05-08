"use strict";

const OpenAI = require("openai");
const { assertSafeSelectSql } = require("../ai-sql");

function formatKpi(k) {
  const base = `- ${k.name}: ${k.definition} (${k.description})`;
  if (k.strict_rule) {
    return `${base}\n  strict_rule: ${k.strict_rule}`;
  }
  return base;
}

/** Plain-English asks like "yesterday vs today" must become two aggregated rows, not one date range. */
function periodComparisonHardRules(question) {
  const q = String(question || "").toLowerCase();
  if (!/\b(sale|sales|revenue|invoice|turnover)\b/.test(q)) return [];
  const comparative =
    /\b(vs\.?|versus)\b/.test(q) ||
    /\b(day\s+before|previous\s+day|prior\s+day)\b/.test(q) ||
    (/\btoday\b/.test(q) && /\byesterday\b/.test(q)) ||
    (/\bcompare(?:d|s|ing)?\b/.test(q) &&
      /\b(today|yesterday|day|mtd|ytd|month|week)\b/.test(q));
  if (!comparative) return [];
  return [
    "Period comparison:",
    "- Output ONE ROW per named time slice (normally 2 rows), with a VARCHAR PeriodLabel naming each slice.",
    "- Use UNION ALL of two (or more) SELECTs; each SELECT filters a single disjoint calendar window and aggregates SaleNetAmount (revenue) for that window only.",
    "- Do not use one wide BETWEEN that merges both periods into a single total.",
    '- Slice windows on sales date (usually InvoiceDt): "Today" → >= CONVERT(date, GETDATE()) AND < DATEADD(day, 1, CONVERT(date, GETDATE())).',
    '- "Yesterday" → >= DATEADD(day, -1, CONVERT(date, GETDATE())) AND < CONVERT(date, GETDATE()).',
    '- "Day before yesterday" → >= DATEADD(day, -2, CONVERT(date, GETDATE())) AND < DATEADD(day, -1, CONVERT(date, GETDATE())).',
  ];
}

function buildPrompt(question, context) {
  const allowedViews = context.viewConfig.allowed_views || [];
  const allowedColumns = Object.entries(context.liveColumns || {})
    .map(([view, cols]) => `- ${view}: ${Array.isArray(cols) ? cols.join(", ") : ""}`)
    .join("\n");
  const kpiLines = context.kpis.map((k) => formatKpi(k));
  const ruleLines = context.rules.map((r) => `- ${r}`);
  const joinLines = Object.entries(context.joins || {}).map(
    ([name, pair]) => `- ${name}: ${pair.left} = ${pair.right}`
  );
  const exampleLines = (context.examples || []).length > 0
    ? context.examples.map((e) => `- Q: ${e.question}\n  SQL: ${e.sql}`)
    : ["- No examples available for this domain yet."];

  const compareRules = periodComparisonHardRules(question);

  return [
    `User Question: ${question}`,
    `Domain: ${context.domain}`,
    `Allowed Views: ${allowedViews.join(", ")}`,
    "Allowed Columns:",
    allowedColumns,
    "Business Rules:",
    ...ruleLines,
    "KPI Definitions:",
    ...kpiLines,
    "Preferred Joins:",
    ...joinLines,
    "Reference Examples:",
    ...exampleLines,
    ...(compareRules.length ? compareRules : []),
    "Hard Rules:",
    "- Only SELECT queries.",
    "- SQL Server dialect only.",
    "- No DELETE / DROP / UPDATE / INSERT / ALTER / TRUNCATE / EXEC.",
    "- Max 200 rows for list outputs: use TOP (200) unless user explicitly asks smaller top.",
    "- For ranking queries, prefer TOP (10) by default unless user asks a different count.",
    "- No unknown columns. Use only allowed columns above.",
    "- Use only allowed views.",
    "- Revenue amount column depends on the base view: on dbo.VwAISalesData use SaleNetAmount with InvoiceDt (or the date column listed for that view); on dbo.VW_MB_POWERBI_SLS_* views use NetAmount and that view's date column from Allowed Columns. Prefer the view that matches the question grain.",
    "- Revenue KPI: never use ItemMRP/MRPValue, NetAmountBeforeTax/SaleAmountBeforeTax, or cost-only sums for revenue unless the user explicitly asks for those metrics.",
    "- Respect strict KPI rules exactly when present in KPI Definitions.",
    "- Prefer these canonical joins when join is needed:",
    "-   VwAISalesData.CustomerId = VwAICustomerDetails.CustomerId",
    "-   VwAISalesData.ItemId = VwMstItems.ItemId",
    "-   VwAISalesData.BranchId = VwAIBranch.BranchId",
    "-   VwAISalesData.SalesPersonId = VwAISalesPerson.SalesPersonId",
    "-   VwAIStockData.ItemId = VwMstItems.ItemId",
    "-   VwAIStockData.BranchId = VwAIBranch.BranchId",
    "- Default period when not specified: This Month.",
    "- If no date range is specified by user, default to current month using MONTH(DateColumn)=MONTH(GETDATE()) AND YEAR(DateColumn)=YEAR(GETDATE()).",
    "- For date filters use SQL Server format: CONVERT(date, GETDATE()) for today, DATEADD and MONTH/YEAR functions for period filters. Never use string date literals like '2024-01-01' directly.",
    "- If the question is ambiguous and missing period/metric/branch needed for correct SQL, set clarification_needed=true and keep sql as SELECT TOP (0) 1 AS placeholder WHERE 1=0.",
    'Return ONLY valid JSON with this exact shape:',
    '{ "sql": "", "assumptions": [], "clarification_needed": false, "confidence": 0 }',
  ].join("\n");
}

async function generateSql({ apiKey, model, question, context }) {
  const prompt = buildPrompt(question, context);
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model: model || "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a SQL generation engine for Microsoft SQL Server. Output JSON only. Never explain. Never add markdown. Never add text outside JSON. If you cannot generate SQL, still return valid JSON with clarification_needed: true.",
      },
      { role: "user", content: prompt },
    ],
  });
  const raw = completion.choices?.[0]?.message?.content || "{}";
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = {};
  }
  if (!parsed || typeof parsed !== "object" || !parsed.sql) {
    return {
      sql: "",
      assumptions: [],
      clarification_needed: true,
      confidence: 0,
    };
  }
  const sql = assertSafeSelectSql(parsed.sql || "");
  return {
    sql,
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    clarification_needed: Boolean(parsed.clarification_needed),
    confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 50,
  };
}

module.exports = { generateSql };
