/**
 * ai-agentic-query.js
 *
 * Dashboard agentic flow: OpenAI function-calling with tools served over MCP HTTP+SSE,
 * falling back to in-process dispatchAgenticTool if MCP is unreachable.
 */
"use strict";

const OpenAI = require("openai");
const { dispatchAgenticTool } = require("./services/agentic-db-tools");
const { getMCPTools, callMCPTool, runMCPExclusive } = require("./services/mcp-client");

/** If tools/list fails at startup — keep names aligned with MCP server + OpenAI compatibility. */
const AGENTIC_TOOLS = [
  {
    type: "function",
    function: {
      name: "find_views_for_question",
      description:
        "Given a business question, returns the most relevant database views. " +
        "Call this FIRST before any other tool. Returns view names grouped by domain.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The user question in plain English" },
          prefer_view: {
            type: "string",
            description: "Optional dbo view name hint — usually omitted; injected from dashboard context.",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_view_columns",
      description:
        "Get EXACT column names and data types for one or more views. " +
        "ALWAYS call this before writing any SQL — never guess column names.",
      parameters: {
        type: "object",
        properties: {
          view_names: {
            type: "array",
            items: { type: "string" },
            description: "One or more view names to inspect",
          },
        },
        required: ["view_names"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sample_rows",
      description:
        "Get a few sample rows from a view to understand actual data format and values.",
      parameters: {
        type: "object",
        properties: {
          view_name: { type: "string" },
          limit: { type: "number", description: "Max rows (default 5, max 20)" },
        },
        required: ["view_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_distinct_values",
      description:
        "Get distinct values for a specific column — use before string filters.",
      parameters: {
        type: "object",
        properties: {
          view_name: { type: "string" },
          column_name: { type: "string" },
          limit: { type: "number", description: "Max distinct (default 50, max 200)" },
        },
        required: ["view_name", "column_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_select",
      description:
        "Execute T-SQL SELECT. Only SELECT. If invalid column errors, inspect schema and retry.",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "T-SQL SELECT; no trailing semicolon" },
          description: { type: "string", description: "Brief description of the query purpose" },
        },
        required: ["sql"],
      },
    },
  },
];

function buildUserDateRangeBlock(range) {
  const from = range?.from ? String(range.from).trim() : "";
  const to = range?.to ? String(range.to).trim() : "";
  if (!from && !to) return "";
  const lines = ["\n[USER DATE RANGE — must respect this once you identify the correct date column]"];
  if (from && to) {
    lines.push(`Filter transaction/activity dates: >= '${from}' AND <= '${to}' (YYYY-MM-DD), inclusive unless the question says otherwise.`);
  } else if (from) {
    lines.push(`Lower bound on the appropriate date column: >= '${from}'.`);
  } else {
    lines.push(`Upper bound on the appropriate date column: <= '${to}'.`);
  }
  lines.push("If zero rows: consider widening dates or verifying the date column name from get_view_columns.");
  return lines.join("\n");
}

function tableHintToPreferView(th) {
  if (!th) return undefined;
  const s = String(th).replace(/\[|\]/g, "").replace(/^dbo\./i, "").trim();
  return s || undefined;
}

function enrichToolArgs(toolName, rawArgs, { tableHint, question }) {
  const out = { ...(rawArgs || {}) };
  if (toolName === "find_views_for_question") {
    const pv = tableHintToPreferView(tableHint);
    if (pv) out.prefer_view = pv;
    if (!out.question && question) out.question = question;
  }
  return out;
}

/** True when MCP transport is unavailable OR timed out — fallback to dispatchAgenticTool. */
function shouldFallbackConnectError(err) {
  const chunks = [];
  let e = err;
  let depth = 0;
  while (e && depth++ < 8) {
    if (typeof e.code === "string") chunks.push(e.code);
    if (typeof e.code === "number") chunks.push(String(e.code));
    if (e.message) chunks.push(e.message);
    e = e.cause;
  }
  const text = chunks.join(" ").toLowerCase();
  return (
    text.includes("econnrefused") ||
    text.includes("not connected") ||
    text.includes("fetch failed") ||
    text.includes("connection closed") ||
    text.includes("econnreset") ||
    text.includes("epipe") ||
    text.includes("efatal") ||
    text.includes("network") ||
    text.includes("session not found") ||
    text.includes("missing or stale session") ||
    text.includes("timed out") ||        // MCP -32001 request timeout
    text.includes("request timed out") ||
    text.includes("-32001") ||
    text.includes("timeout")
  );
}

/**
 * @param {{ apiKey: string, model?: string, question: string, pool?: object, dateContext?: string, userDateRange?: { from?: string, to?: string }, tableHint?: string }} opts
 */
async function runAgenticQuery(opts) {
  return runMCPExclusive(() => internalRun(opts));
}

async function internalRun({
  apiKey,
  model,
  question,
  pool,
  dateContext,
  userDateRange,
  tableHint: tableHintOpt,
}) {
  const openai = new OpenAI({ apiKey });
  const mdl = model || "gpt-4o-mini";
  const tableHint = tableHintOpt && String(tableHintOpt).trim() ? String(tableHintOpt).trim() : "";

  const hintPrefix = tableHint
    ? `[Table hint — use this view/table if it matches the question: ${tableHint}]\n\n`
    : "";

  const userDateBlock = buildUserDateRangeBlock(userDateRange || {});
  const systemPrompt = `You are a retail fashion ERP business analytics assistant for Meena Bazaar.
Answer the user's question by querying a Microsoft SQL Server database using the provided tools.

══ MANDATORY WORKFLOW — follow every step, every time ══
1. call find_views_for_question — discover relevant views
2. call get_view_columns on ALL views found — never guess column names
3. call get_sample_rows on the primary view — understand real date formats, branch codes, value scales
4. if the question mentions a named filter (branch, supplier, category, department):
   call get_distinct_values to find the exact stored value before writing SQL
5. write and call run_select with a validated SQL query
6. if run_select errors: read the error message, call get_view_columns again if needed, fix and retry
7. answer in plain English based on the returned data

══ STRICT SQL RULES ══
COLUMN NAMES
- NEVER guess — only use columns returned by get_view_columns
- If a column is not in that list, it does not exist — find the right column

BRANCH IDENTIFIER
- VwAI* views → BranchId (INT) | VW_MB_POWERBI_* → BranchAlias (varchar e.g. "01-SE")
- NEVER mix these — the wrong one will always return an error

REVENUE COLUMN
- VwAI* views → SaleNetAmount | VW_MB_POWERBI_* → NetAmount
- NEVER use MRPValue, GrossValue, CostValue, or NetAmountBeforeTax as revenue

JOIN DIRECTION (critical for ranking queries)
- ALWAYS start FROM dbo.VwAISalesData (the fact table with millions of rows) and JOIN to master tables
- ✅ CORRECT: FROM dbo.VwAISalesData s INNER JOIN dbo.VwMstItems i ON s.ItemId = i.ItemId
- ✅ CORRECT: FROM dbo.VwAISalesData s LEFT JOIN dbo.VwAIBranch b ON s.BranchId = b.BranchId
- ❌ WRONG: FROM dbo.VwMstItems i LEFT JOIN dbo.VwAISalesData s ...  ← returns at most as many rows as are in VwMstItems (could be just 4!)
- ❌ WRONG: FROM dbo.VwAIBranch b LEFT JOIN dbo.VwAISalesData s ...  ← same problem
- WHY: Master tables (VwMstItems, VwAIBranch) may have very few pre-loaded rows. Starting FROM them limits results to that tiny count even when TOP 100 is requested.

DATE ARITHMETIC
- CORRECT: DATEADD(day, -7, CAST(GETDATE() AS DATE))
- WRONG:   GETDATE() - 7  ← integer subtraction, always returns wrong/0 rows
- Always CAST datetime columns to date: CAST(InvoiceDt AS date)
- "This week": CAST(InvoiceDt AS date) >= DATEADD(day, 1-DATEPART(dw,GETDATE()), CAST(GETDATE() AS DATE))
- "This month" / MTD: YEAR(col)=YEAR(GETDATE()) AND MONTH(col)=MONTH(GETDATE())
- "Last Monday": CAST(col AS date) = DATEADD(day, 2-DATEPART(WEEKDAY,GETDATE()), DATEADD(day,-7, CAST(GETDATE() AS date)))
- "Last month MTD" (same day range last month): CAST(col AS date) BETWEEN DATEADD(month,-1,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) AND DATEADD(month,-1,CAST(GETDATE() AS date))

INDIAN FISCAL YEAR
- FY starts April 1. Q1=Apr–Jun, Q2=Jul–Sep, Q3=Oct–Dec, Q4=Jan–Mar
- Do NOT use DATEDIFF(quarter,...) — it uses calendar quarters
- QTD: WHERE CAST(col AS date) >= '<qStart>' AND CAST(col AS date) <= CAST(GETDATE() AS date)
- YTD: WHERE CAST(col AS date) >= '<fyStart Apr 1>' AND CAST(col AS date) <= CAST(GETDATE() AS date)
- The date context block appended to each question contains the exact current quarter start and FY start

BIRTHDAY/ANNIVERSARY
- Filter by MONTH(col) ONLY — never YEAR(col), which returns 0 rows

MULTI-METRIC COMPARISON (purchase + sales, period vs period)
- When asked for two metrics in the same chart (e.g. "sales and purchases simultaneously"):
  Return ONE result set with a label column AND two numeric columns (one per metric).
  Example: SELECT <date> AS Period, SUM(SaleNetAmount) AS NetSales, SUM(PurNetAmount) AS Purchases ...
- When asked for period comparison (e.g. "today vs last Monday vs last month"):
  Use UNION ALL with a 'Period' text label and identical numeric aliases in every branch:
  SELECT 'Today' AS Period, SUM(SaleNetAmount) AS NetSales FROM ... WHERE <today filter>
  UNION ALL SELECT 'Last Monday' AS Period, SUM(SaleNetAmount) AS NetSales FROM ... WHERE <last Monday>
  UNION ALL SELECT 'Last Month' AS Period, SUM(SaleNetAmount) AS NetSales FROM ... WHERE <last month same days>
  ORDER BY 1

GROUPING AND AGGREGATES
- Every non-aggregate SELECT column must be in GROUP BY
- Always alias aggregates: SUM(x) AS TotalX, COUNT(DISTINCT x) AS UniqueX
- For trend queries: GROUP BY CAST(InvoiceDt AS date) not the raw datetime

RESULT SIZE
- Non-aggregate queries: always add TOP (N), max 200
- Ranking queries: TOP 10 / TOP 20 + ORDER BY metric DESC

FORMAT
- No semicolons, no SQL comments
- Column aliases must not have spaces (use CamelCase)
- Always ORDER BY for trend and ranking results

══ ANSWER FORMAT ══
- 2–5 sentences in plain English
- Lead with the single most important number (₹ in Lakhs/Crores using Indian system)
- Include actual numbers from the data — be specific, not vague
- If 0 rows returned: say why (likely cause) and suggest what to try instead
- Never mention SQL, columns, or technical terms in the answer

${userDateBlock}
${dateContext || ""}`;

  let toolsOpenAI;
  try {
    toolsOpenAI = await getMCPTools();
  } catch (listErr) {
    console.warn("[agentic] MCP tool list unavailable, using local schemas:", listErr.message);
    toolsOpenAI = AGENTIC_TOOLS;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: hintPrefix + String(question || "").trim() },
  ];

  const toolCallLog = [];
  let generatedSQL = null;
  let finalData = [];
  let finalAnswer = null;
  const MAX_TURNS = 18;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await openai.chat.completions.create({
      model: mdl,
      temperature: 0,
      tools: toolsOpenAI,
      tool_choice: "auto",
      messages,
      max_tokens: 1400,
    });

    const msg = response.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalAnswer = msg.content;
      break;
    }

    for (const toolCall of msg.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        toolArgs = {};
      }

      const enriched = enrichToolArgs(toolName, toolArgs, { tableHint, question });

      console.log("[MCP] Calling tool:", toolName, JSON.stringify(enriched).slice(0, 160));

      let toolResult;
      try {
        if (toolName === "run_select" && enriched.sql) generatedSQL = enriched.sql;

        if (toolName === "run_select" && pool) {
          // Always execute SQL in-process — MCP transport is unreliable for long-running queries
          // (orphan MCP server from previous run may have stale connections / short timeouts).
          console.log("[agentic] run_select → in-process (direct pool)");
          toolResult = await dispatchAgenticTool(pool, toolName, enriched, question, "");
        } else {
          try {
            const parsed = await callMCPTool(toolName, enriched);
            toolResult =
              typeof parsed === "object" && parsed !== null ? parsed : { _raw_text: parsed };
          } catch (mcpErr) {
            if (pool && shouldFallbackConnectError(mcpErr)) {
              console.warn("[agentic] MCP unavailable, falling back to in-process tools:", mcpErr.message);
              toolResult = await dispatchAgenticTool(pool, toolName, enriched, question, "");
            } else {
              throw mcpErr;
            }
          }
        }

        if (toolName === "run_select" && !toolResult.error && Array.isArray(toolResult.data)) {
          finalData = toolResult.data;
        }
      } catch (toolErr) {
        console.warn(`[agentic] tool error in ${toolName}:`, toolErr.message);
        toolResult = {
          error: `Tool execution error: ${toolErr.message}`,
          ...(toolName === "run_select"
            ? { hint: "Query failed. Try adding TOP 50, narrowing the date range to a single week, or using a simpler aggregation." }
            : {}),
        };
      }

      toolCallLog.push({ tool: toolName, args: enriched, result: toolResult });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  return {
    answer: finalAnswer,
    sql: generatedSQL,
    data: finalData,
    rowCount: finalData.length,
    toolCalls: toolCallLog,
    turnsUsed: toolCallLog.length,
  };
}

module.exports = { runAgenticQuery, AGENTIC_TOOLS };
