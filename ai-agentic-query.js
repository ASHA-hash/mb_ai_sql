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
const { buildMappingDictionaryBlock, buildAggregationMandateBlock } = require("./services/metadata-translation-engine");
const { buildSqlGenerationSystemPrompt } = require("./services/adaptive-intent");

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
  const mappingBlock = buildMappingDictionaryBlock(question);
  const systemPrompt = `You are a retail ERP analytics assistant (Meena Bazaar).
Answer by querying SQL Server through tools — metadata-driven, not hardcoded view rules.

══ MANDATORY WORKFLOW ══
1. SEPARATE intent from SQL: infer metrics/dimensions/filters first (use BUSINESS TERM MAPPINGS).
2. find_views_for_question → get_view_columns on ALL recommended views.
3. get_sample_rows on the primary view when formats are unclear.
4. get_distinct_values before filtering by branch/supplier/category names.
5. run_select with aggregated SQL (SUM/COUNT/AVG + GROUP BY) unless line-level detail is explicit.
6. On run_select error: read system_observation / hint in the tool result, fix columns, retry.

${mappingBlock}

${buildAggregationMandateBlock()}

${buildSqlGenerationSystemPrompt(null, dateContext || "")}

══ ANSWER FORMAT ══
- 2–5 sentences plain English; lead with the key number (₹ Lakhs/Crores).
- Never mention SQL or column names.
${userDateBlock}`;

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
    const { openAiOmitsTemperature } = require("./services/llm-params");
    const response = await openai.chat.completions.create({
      model: mdl,
      ...(openAiOmitsTemperature(mdl) ? {} : { temperature: 0 }),
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
            ? { hint: "Query failed. Use aggregation + date filter; see system_observation if present." }
            : {}),
        };
      }

      if (toolName === "run_select" && toolResult?.system_observation) {
        messages.push({
          role: "system",
          content: toolResult.system_observation,
        });
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
