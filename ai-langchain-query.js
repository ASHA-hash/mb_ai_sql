/**
 * ai-langchain-query.js
 *
 * LangGraph-powered SQL query engine — 7-node StateGraph.
 *
 * Workflow:
 *   load_schema → generate_sql → check_sql
 *       → execute_sql → [error_recovery (×3)] → generate_answer → verify_answer
 *
 * Key accuracy improvements:
 *   • load_schema  — instant JSON lookup from db_tables_views_columns.json (no DB round-trip)
 *                    passes EXACT column names to AI — no guessing, no hallucination
 *   • temperature=0 for SQL — deterministic, no invented column names
 *   • check_sql    — LLM pre-validates T-SQL rules before DB execution
 *   • verify_answer — LLM cross-checks numbers against actual rows
 *   • zero_rows_recovery — widens filters and retries once
 *   • 3 retry attempts with cumulative error memory
 */
"use strict";

const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");
const { StateGraph, Annotation, END, START } = require("@langchain/langgraph");
const { dispatchAgenticTool } = require("./services/agentic-db-tools");
const { findRelevantViews, formatSchemaForPrompt: formatSchemaFromJson, getViewColumns } = require("./services/schema-from-json");
const { normalizeApiDate } = require("./filter-query");
const ragStore = require("./services/rag-store");

/* ─────────────────────────────────────────────────────────────────────────────
   ERP DOMAIN RULES — injected into every generation / check prompt
   ───────────────────────────────────────────────────────────────────────────── */
const ERP_SQL_RULES = `
══ ERP T-SQL RULES — ALL MANDATORY ══

1. BRANCH IDENTIFIER (most common mistake)
   • VwAI* views            → BranchId  (INT, numeric)
   • VW_MB_POWERBI_* views  → BranchAlias (varchar, e.g. "01-SE")
   ❌ NEVER use BranchId on PowerBI views — column does not exist
   ❌ NEVER use BranchAlias on VwAI* views — column does not exist
   ✅ To filter by branch name, use BranchAlias on PowerBI views or join VwAIBranch

2. REVENUE COLUMN (second most common mistake)
   • VwAI* views            → SaleNetAmount   (post-discount net revenue)
   • VW_MB_POWERBI_* views  → NetAmount
   ❌ NEVER use MRPValue, GrossValue, NetAmountBeforeTax, CostValue as revenue
   ❌ NEVER use SaleAmountBeforeTax as final revenue

3. DATE ARITHMETIC (critical for time-range queries)
   ✅ CORRECT:   DATEADD(day, -7, CAST(GETDATE() AS DATE))
   ✅ CORRECT:   CAST(InvoiceDt AS date) BETWEEN '2026-01-01' AND '2026-01-31'
   ❌ WRONG:     GETDATE() - 7          (integer subtraction on date — always 0 rows)
   ❌ WRONG:     InvoiceDt >= GETDATE() - 30  (same mistake)
   • Date columns are often datetime — always CAST to date before comparison
   • "This week" = DATEADD(day, 1-DATEPART(dw,GETDATE()), CAST(GETDATE() AS DATE)) to CAST(GETDATE() AS DATE)
   • "This month" / MTD = YEAR(col)=YEAR(GETDATE()) AND MONTH(col)=MONTH(GETDATE())
   • "Last Monday" = CAST(col AS date) = DATEADD(day, 2-DATEPART(WEEKDAY,GETDATE()), DATEADD(day,-7,CAST(GETDATE() AS date)))
   • "Last month same period" = CAST(col AS date) BETWEEN DATEADD(month,-1,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) AND DATEADD(month,-1,CAST(GETDATE() AS date))

3a. INDIAN FISCAL YEAR (critical — do NOT use calendar year logic)
   • FY = April 1 – March 31.  Q1=Apr–Jun | Q2=Jul–Sep | Q3=Oct–Dec | Q4=Jan–Mar
   ❌ WRONG for QTD/YTD: DATEDIFF(quarter,...) or YEAR(col)=YEAR(GETDATE())
   ✅ QTD: WHERE CAST(col AS date) >= '<quarter start from date context>' AND CAST(col AS date) <= CAST(GETDATE() AS date)
   ✅ YTD: WHERE CAST(col AS date) >= '<April 1 of current FY from date context>' AND CAST(col AS date) <= CAST(GETDATE() AS date)
   • The [SERVER DATE CONTEXT] block in the question contains the exact current quarter start and FY start — use those dates

4. BIRTHDAY / ANNIVERSARY (filter by month only)
   ✅ CORRECT:   MONTH(BirthdayDt) = MONTH(GETDATE())
   ❌ WRONG:     YEAR(BirthdayDt) = YEAR(GETDATE())  — returns 0 rows (DOB year ≠ current year)

5. JOINS (always explicit — direction depends on the question)
   ✅ Normal ranking / top products / invoices (sales rows drive the grain):
      FROM dbo.VwAISalesData s INNER JOIN dbo.VwMstItems i ON s.ItemId = i.ItemId
      FROM dbo.VwAISalesData s LEFT  JOIN dbo.VwAIBranch b ON <matching branch keys>
      FROM dbo.VwAISalesData s LEFT  JOIN dbo.VwAICustomerDetails c ON s.CustomerId = c.CustomerId
   ✅ EXCEPTION — "branches with NO / ZERO sales in <period>" (branch is the grain, NOT sales rows):
      Start FROM dbo.VwAIBranch b and use LEFT JOIN dbo.VwAISalesData … WHERE sales key IS NULL,
      OR use WHERE NOT EXISTS (SELECT 1 FROM dbo.VwAISalesData s WHERE same branch key AND date in period).
      Return ONE row per branch (BranchId + display name). Never SELECT only from VwAISalesData for this.
   ❌ WRONG for normal ranking: FROM dbo.VwMstItems i LEFT JOIN dbo.VwAISalesData s …
   ❌ WRONG for zero-sales question: FROM dbo.VwAISalesData with TOP 500 — duplicates one branch per invoice line.
   ❌ NEVER use implicit cross joins (missing ON clause)

6. RESULT SIZE
   • Non-aggregate SELECT → MUST include TOP (N), max 200
   • Aggregate returning many groups → TOP 500 on outer query
   • "Top 10" questions → TOP 10 ... ORDER BY metric DESC

7. NULL SAFETY
   • Wrap nullable numeric cols: ISNULL(SaleNetAmount, 0)
   • Wrap nullable string cols: ISNULL(BranchAlias, 'Unknown')

8. FORMAT
   • No semicolons at end
   • No SQL comments (-- or /* */)
   • Always alias all aggregates: SUM(x) AS TotalX, COUNT(*) AS TxnCount
   • Always include ORDER BY for trend/ranking queries
   • Column aliases must not contain spaces (use CamelCase or underscore)

9. GROUPING
   • Every non-aggregate SELECT column must appear in GROUP BY
   • Do NOT group by datetime — always GROUP BY CAST(col AS date) or FORMAT(col, 'MMM yyyy')

10. COMMON PATTERNS
    • Daily trend:
      SELECT CAST(InvoiceDt AS date) AS SaleDate, SUM(SaleNetAmount) AS TotalSales, COUNT(DISTINCT InvoiceNo) AS InvoiceCount
      FROM dbo.VwAISalesData GROUP BY CAST(InvoiceDt AS date) ORDER BY SaleDate
    • Branch ranking:
      SELECT TOP 20 BranchAlias, SUM(NetAmount) AS TotalSales FROM VW_MB_POWERBI_...
      GROUP BY BranchAlias ORDER BY TotalSales DESC
    • Product/item ranking (CORRECT — fact table first):
      SELECT TOP 10 ISNULL(i.<name_col>, 'Unknown') AS ProductName, SUM(s.SaleNetAmount) AS TotalSales
      FROM dbo.VwAISalesData s INNER JOIN dbo.VwMstItems i ON s.ItemId = i.ItemId
      GROUP BY i.<name_col> ORDER BY TotalSales DESC
      — replace <name_col> with the actual name column from the schema (e.g. Description, ArticleShortName, ItemName)
    • Customer count: COUNT(DISTINCT CustomerId) AS CustomerCount
    • Invoice count: COUNT(DISTINCT InvoiceNo) AS InvoiceCount

11. MULTI-METRIC COMPARISON
    • Two measures in one chart (e.g. "sales + purchases simultaneously", "revenue and cost together"):
      Return ONE result set with a label column AND two numeric columns (one per metric).
      SELECT <date> AS Period, SUM(s.SaleNetAmount) AS NetSales, SUM(p.PurNetAmount) AS Purchases
      FROM dbo.VwAISalesData s LEFT JOIN <purchase_view> p ON <date join> GROUP BY <date> ORDER BY <date>
    • Period comparison (e.g. "today vs last Monday vs last month"):
      Use UNION ALL with identical column aliases across branches:
      SELECT 'Today' AS Period, 1 AS SortOrder, SUM(SaleNetAmount) AS NetSales FROM ... WHERE <today>
      UNION ALL SELECT 'Last Monday', 2, SUM(SaleNetAmount) FROM ... WHERE <last Monday>
      UNION ALL SELECT 'Last Month', 3, SUM(SaleNetAmount) FROM ... WHERE <last month same range>
      ORDER BY SortOrder
`;

/* ─────────────────────────────────────────────────────────────────────────────
   STATE SCHEMA
   ───────────────────────────────────────────────────────────────────────────── */
const last = (a, b) => (b !== undefined ? b : a);

const AgentState = Annotation.Root({
  // Inputs
  question:        Annotation({ reducer: last }),
  dateContext:     Annotation({ reducer: last }),
  tableHint:       Annotation({ reducer: last }),
  userDateRange:   Annotation({ reducer: last }),

  // Schema discovery
  viewScores:      Annotation({ reducer: last }),
  topViews:        Annotation({ reducer: last }),
  schema:          Annotation({ reducer: last }),
  schemaText:      Annotation({ reducer: last }),

  // Sample data (new — helps LLM understand actual formats)
  sampleData:      Annotation({ reducer: last }),
  sampleText:      Annotation({ reducer: last }),

  // SQL lifecycle
  generatedSQL:    Annotation({ reducer: last }),
  checkedSQL:      Annotation({ reducer: last }),
  executionResult: Annotation({ reducer: last }),
  retryCount:      Annotation({ default: () => 0, reducer: last }),
  retryErrors:     Annotation({ default: () => [], reducer: (a, b) => [...(a || []), ...(b || [])] }),
  zeroRowsRetried: Annotation({ default: () => false, reducer: last }),

  // RAG — retrieved context injected before SQL generation
  ragContext:      Annotation({ reducer: last }),

  // Output
  finalAnswer:     Annotation({ reducer: last }),
  finalData:       Annotation({ reducer: last }),
  finalSQL:        Annotation({ reducer: last }),
  confidence:      Annotation({ reducer: last }),   // "high" | "medium" | "low"
  confidenceNote:  Annotation({ reducer: last }),

  // Trace
  nodeLog:         Annotation({ default: () => [], reducer: (a, b) => [...(a || []), ...(b || [])] }),
});

/* ─────────────────────────────────────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────────────────────────────────────── */
function extractTopViews(viewScores, n) {
  if (!viewScores || typeof viewScores !== "object") return [];
  const entries = Object.entries(viewScores)
    .filter(([k]) => k !== "recommended_approach" && !k.startsWith("_"))
    .flatMap(([, arr]) => (Array.isArray(arr) ? arr : []))
    .filter((v) => typeof v === "string");
  const seen = new Set();
  const out = [];
  for (const v of entries) {
    if (!seen.has(v)) { seen.add(v); out.push(v); }
    if (out.length >= n) break;
  }
  return out;
}

function formatSchemaForPrompt(schema) {
  if (!schema || typeof schema !== "object") return "(no schema available)";
  const lines = [];

  // Emit join advisory first so it sits at the top of context
  if (schema["__join_direction_advisory__"]) {
    lines.push(`\n⚡ ${schema["__join_direction_advisory__"]}`);
  }

  for (const [view, cols] of Object.entries(schema)) {
    // Special keys — emit advisory already done above; emit others normally
    if (view === "__join_direction_advisory__") continue;
    if (view.startsWith("__")) { lines.push(`\n${cols}`); continue; }
    if (!Array.isArray(cols)) { lines.push(`\n${view}: ${cols}`); continue; }

    // Row-count badge: pull _approxRows off the column array (injected by agentic-db-tools)
    const approxRows = cols._approxRows ?? null;
    let badge = "";
    if (approxRows !== null) {
      if (approxRows === 0)       badge = " ⚠️ EMPTY TABLE (0 rows)";
      else if (approxRows < 50)   badge = ` ⚠️ TINY TABLE (${approxRows} rows) — JOIN to this; never use as FROM in ranking queries`;
      else if (approxRows < 5000) badge = ` (${approxRows.toLocaleString()} rows — master/lookup)`;
      else if (approxRows < 5e5)  badge = ` (≈${approxRows.toLocaleString()} rows)`;
      else                        badge = ` (≈${(approxRows / 1e6).toFixed(1)}M rows — fact table → use as FROM)`;
    }

    lines.push(`\n${view}${badge}:`);
    for (const c of cols) {
      lines.push(`  ${c.column} (${c.type}${c.nullable ? ", nullable" : ""})`);
    }
  }
  return lines.join("\n");
}

function formatSampleForPrompt(sampleData) {
  if (!sampleData || typeof sampleData !== "object") return "";
  const lines = [];
  for (const [view, rows] of Object.entries(sampleData)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    lines.push(`\n${view} — sample rows:`);
    const headers = Object.keys(rows[0]);
    lines.push("  " + headers.join(" | "));
    for (const r of rows.slice(0, 3)) {
      lines.push("  " + headers.map(h => String(r[h] ?? "NULL")).join(" | "));
    }
  }
  return lines.join("\n");
}

function extractSQL(text) {
  if (!text) return "";
  const fenced = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const selectIdx = text.toUpperCase().indexOf("SELECT");
  if (selectIdx >= 0) return text.slice(selectIdx).replace(/;+\s*$/, "").trim();
  return text.trim();
}

function buildDateRangeClause(userDateRange) {
  if (!userDateRange) return "";
  const { from, to } = userDateRange;
  if (!from && !to) return "";
  const parts = [];
  if (from && to) parts.push(`date range ${from} to ${to} (inclusive)`);
  else if (from)  parts.push(`date range from ${from} onwards`);
  else            parts.push(`date range up to ${to}`);
  return `\n[USER DATE RANGE — use this in WHERE clause on the appropriate date column]\n${parts.join(", ")}`;
}

function quoteIdent(name) {
  return `[${String(name || "").replace(/]/g, "]]")}]`;
}

function pickFirstExisting(columns, preferred) {
  const set = new Set((columns || []).map((c) => String(c).toLowerCase()));
  for (const p of preferred) {
    if (set.has(String(p).toLowerCase())) return p;
  }
  return null;
}

function getSchemaColumnNames(schema, viewName) {
  if (!schema || typeof schema !== "object") return [];
  const candidates = [
    viewName,
    `dbo.${viewName}`,
    String(viewName || "").replace(/^dbo\./i, ""),
  ].map((s) => String(s || "").toLowerCase());
  const key = Object.keys(schema).find((k) => candidates.includes(String(k || "").toLowerCase()));
  const cols = key ? schema[key] : null;
  if (!Array.isArray(cols)) return [];
  return cols.map((c) => c?.column).filter(Boolean);
}

function isTopProductsSalesQuestion(question) {
  const q = String(question || "").toLowerCase();
  return /\btop\s+\d+\b/.test(q) &&
    /\b(product|item|article|sku)\b/.test(q) &&
    /\b(sale|sales|revenue|amount)\b/.test(q);
}

function buildTopProductsSqlFromSchema(state) {
  if (!isTopProductsSalesQuestion(state.question)) return null;
  const salesCols = getSchemaColumnNames(state.schema, "VwAISalesData");
  const itemCols = getSchemaColumnNames(state.schema, "VwMstItems");
  if (!salesCols.length || !itemCols.length) return null;

  const amountCol = pickFirstExisting(salesCols, ["SaleNetAmount", "NetAmount", "Amount"]);
  if (!amountCol) return null;

  const productNameCol = pickFirstExisting(itemCols, [
    "ProductName",
    "Description",
    "ItemName",
    "ArticleShortName",
    "ArticleName",
    "ArticleNo",
  ]);
  if (!productNameCol) return null;

  const topNMatch = String(state.question || "").match(/\btop\s+(\d+)\b/i);
  const requestedTop = topNMatch ? parseInt(topNMatch[1], 10) : 10;
  const topN = Number.isFinite(requestedTop) ? Math.min(Math.max(requestedTop, 1), 200) : 10;

  const labelExpr = `ISNULL(NULLIF(LTRIM(RTRIM(i.${quoteIdent(productNameCol)})), ''), 'Unknown')`;
  return [
    `SELECT TOP ${topN}`,
    `  ${labelExpr} AS ProductName,`,
    `  SUM(ISNULL(s.${quoteIdent(amountCol)}, 0)) AS TotalSales`,
    `FROM dbo.VwAISalesData s`,
    `INNER JOIN dbo.VwMstItems i ON s.ItemId = i.ItemId`,
    `GROUP BY ${labelExpr}`,
    `HAVING SUM(ISNULL(s.${quoteIdent(amountCol)}, 0)) > 0`,
    `ORDER BY TotalSales DESC`,
  ].join("\n");
}

function isZeroSalesBranchesQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!/\b(branch|branches|store|stores|outlet|location)\b/.test(q)) return false;
  return /\b(zero sales|no sales|without sales|0\s+sales|didn'?t sell|haven'?t\s+sold|not selling)\b/.test(q);
}

function pickSalesDateColumnFromJson() {
  const salesCols = getViewColumns("dbo.VwAISalesData");
  if (!salesCols.length) return null;
  const envCol = String(process.env.SALES_FILTER_DATE_COLUMN || "").trim();
  if (envCol) {
    const hit = salesCols.find((c) => c.toLowerCase() === envCol.toLowerCase());
    if (hit) return hit;
  }
  return pickFirstExisting(salesCols, ["InvoiceDt", "SaleDate", "BillDate", "TxnDate", "InvoiceDate"]);
}

/**
 * Builds NOT EXISTS predicate date filter for dbo.VwAISalesData alias s (parameterized dates in SQL literals).
 */
function buildZeroSalesDateWindowSql(question, userDateRange) {
  const dateCol = pickSalesDateColumnFromJson();
  if (!dateCol) return null;
  const qc = `s.${quoteIdent(dateCol)}`;

  const ur = userDateRange || {};
  const fromN = ur.from != null ? normalizeApiDate(String(ur.from)) : "";
  const toN = ur.to != null ? normalizeApiDate(String(ur.to)) : "";

  if (fromN && toN && /^\d{4}-\d{2}-\d{2}$/.test(fromN) && /^\d{4}-\d{2}-\d{2}$/.test(toN)) {
    return `CAST(${qc} AS date) BETWEEN CAST('${fromN}' AS date) AND CAST('${toN}' AS date)`;
  }

  const q = String(question || "").toLowerCase();
  const m = q.match(/\blast\s*(\d+)\s*days?\b/);
  const n = m ? Math.min(Math.max(parseInt(m[1], 10), 1), 366) : 7;
  return (
    `CAST(${qc} AS date) >= DATEADD(day, -${n}, CAST(GETDATE() AS date)) ` +
    `AND CAST(${qc} AS date) <= CAST(GETDATE() AS date)`
  );
}

/**
 * Override LLM SQL for "branches with zero/no sales in period" — one row per branch, anti-join pattern.
 */
function buildZeroSalesBranchesSqlFromJson(state) {
  if (!isZeroSalesBranchesQuestion(state.question)) return null;

  const branchCols = getViewColumns("dbo.VwAIBranch");
  const salesCols = getViewColumns("dbo.VwAISalesData");
  if (!branchCols.length || !salesCols.length) return null;
  if (!branchCols.includes("BranchId") || !salesCols.includes("BranchId")) return null;

  const dateWindow = buildZeroSalesDateWindowSql(state.question, state.userDateRange);
  if (!dateWindow) return null;

  const bKey = `LTRIM(RTRIM(CAST(b.${quoteIdent("BranchId")} AS NVARCHAR(50))))`;
  const sKey = `LTRIM(RTRIM(CAST(s.${quoteIdent("BranchId")} AS NVARCHAR(50))))`;

  const aliasExpr = branchCols.includes("BranchShortName")
    ? `ISNULL(NULLIF(LTRIM(RTRIM(b.${quoteIdent("BranchShortName")})), ''), b.${quoteIdent("BranchName")})`
    : `b.${quoteIdent("BranchName")}`;

  return [
    `SELECT`,
    `  b.${quoteIdent("BranchId")} AS BranchId,`,
    `  ${aliasExpr} AS BranchAlias`,
    `FROM dbo.VwAIBranch b`,
    `WHERE NOT EXISTS (`,
    `  SELECT 1`,
    `  FROM dbo.VwAISalesData s`,
    `  WHERE ${sKey} = ${bKey}`,
    `    AND (${dateWindow})`,
    `)`,
    `ORDER BY b.${quoteIdent("BranchId")}`,
  ].join("\n");
}

function enforcedLangGraphSql(state) {
  const top = buildTopProductsSqlFromSchema(state);
  if (top) return top;
  const zero = buildZeroSalesBranchesSqlFromJson(state);
  if (zero) return zero;
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 0 — retrieve_context  (RAG: examples + glossary + schema chunks)
   Runs after load_schema so topViews is known; results injected into generate_sql.
   ───────────────────────────────────────────────────────────────────────────── */
function makeRetrieveContext() {
  return async function retrieveContext(state) {
    console.log("[langchain] node: retrieve_context (RAG)");
    const question = state.question || "";

    try {
      const [examples, glossary, schemaDocs] = await Promise.all([
        ragStore.search(question, 3, { type: "example" }),
        ragStore.search(question, 3, { type: "glossary" }),
        ragStore.search(question, 2, { type: "schema"   }),
      ]);

      const MIN_SCORE = 0.70; // only surface genuinely similar results
      const relExamples = examples.filter(r => r.score >= MIN_SCORE);
      const relGlossary = glossary.filter(r => r.score >= 0.65);
      const relSchema   = schemaDocs.filter(r => r.score >= 0.72);

      let ctx = "";

      if (relExamples.length) {
        ctx += "═══ SIMILAR PAST QUERIES — follow these exact patterns ═══\n";
        for (const ex of relExamples) {
          ctx += `Q: ${ex.metadata.question}\n`;
          ctx += `SQL:\n${ex.metadata.sql}\n`;
          if (ex.metadata.note) ctx += `Note: ${ex.metadata.note}\n`;
          ctx += "\n";
        }
      }

      if (relGlossary.length) {
        ctx += "═══ BUSINESS GLOSSARY — use these definitions ═══\n";
        for (const g of relGlossary) {
          ctx += `• ${g.metadata.term}: ${g.metadata.definition}\n`;
        }
        ctx += "\n";
      }

      if (relSchema.length) {
        ctx += "═══ ADDITIONAL SCHEMA CONTEXT ═══\n";
        for (const s of relSchema) {
          ctx += `${s.text}\n\n`;
        }
      }

      const found = {
        examples: relExamples.length,
        glossary: relGlossary.length,
        schema:   relSchema.length,
      };
      console.log("[langchain] RAG retrieved:", found);

      return {
        ragContext: ctx.trim(),
        nodeLog:    [{ node: "retrieve_context", found }],
      };
    } catch (e) {
      // RAG failure must never block the main query
      console.error("[langchain] RAG retrieve error (non-fatal):", e.message);
      return { ragContext: "", nodeLog: ["retrieve_context:skipped"] };
    }
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 1 — load_schema
   Replaces the old discover_views + get_schema + sample_data trio.
   Uses db_tables_views_columns.json (local file, instant) — no DB round-trip.
   Picks the most relevant views for the question using keyword scoring, then
   formats their exact column names for injection into the AI prompt.
   ───────────────────────────────────────────────────────────────────────────── */
function makeLoadSchema() {
  return function loadSchema(state) {
    console.log("[langchain] node: load_schema (JSON-based, instant)");

    // Keyword-scored view selection from local JSON
    const relevantViews = findRelevantViews(state.question, {
      topN: 4,
      tableHint: state.tableHint || undefined,
    });

    console.log("[langchain] relevant views:", relevantViews);

    // Format exact column names from JSON — no DB call
    const schemaText = formatSchemaFromJson(relevantViews);

    return {
      topViews:   relevantViews,
      schema:     {},          // not used downstream but kept for state compat
      schemaText,
      sampleData: {},
      sampleText: "",
      nodeLog:    ["load_schema"],
    };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 4 — generate_sql
   ───────────────────────────────────────────────────────────────────────────── */
function makeGenerateSQL(llm) {
  return async function generateSQL(state) {
    console.log("[langchain] node: generate_sql");

    const retryGuidance =
      state.retryCount > 0 && state.retryErrors.length
        ? `\n\n══ PREVIOUS ERRORS — do NOT repeat these mistakes ══\n${state.retryErrors.join("\n")}`
        : "";

    const sampleSection = state.sampleText
      ? `\n\n[SAMPLE DATA — note the actual date formats, branch code format, value scales]\n${state.sampleText}`
      : "";

    const dateRangeSection = buildDateRangeClause(state.userDateRange);

    const ragSection = state.ragContext
      ? `\n\n[RAG MEMORY — highest-priority context, follow these patterns exactly]\n${state.ragContext}`
      : "";

    const systemPrompt = `You are a Microsoft T-SQL expert for a retail fashion ERP (Meena Bazaar).
Write ONE valid T-SQL SELECT statement that answers the user's question.
Use ONLY column names that appear in the provided schema — never guess or invent columns.
${ERP_SQL_RULES}
${state.dateContext || ""}
Output ONLY the SQL — no explanation, no markdown fences, no semicolons at end.`;

    const userPrompt =
      `[SCHEMA — ONLY use columns listed here]\n${state.schemaText}` +
      sampleSection +
      ragSection +
      dateRangeSection +
      `\n\n[QUESTION]\n${state.question}` +
      retryGuidance;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const sql = extractSQL(response.content);
    const enforced = enforcedLangGraphSql(state);
    const finalSql = enforced || sql;
    if (enforced) {
      console.log("[langchain] generated SQL overridden by deterministic guardrail");
    }
    console.log("[langchain] generated SQL:", finalSql.slice(0, 160));
    return { generatedSQL: finalSql, nodeLog: ["generate_sql"] };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 5 — check_sql  (QuerySQLCheckerTool — 15-point review)
   ───────────────────────────────────────────────────────────────────────────── */
function makeCheckSQL(llm) {
  return async function checkSQL(state) {
    console.log("[langchain] node: check_sql");
    const enforced = enforcedLangGraphSql(state);
    if (enforced) {
      return { checkedSQL: enforced, nodeLog: ["check_sql"] };
    }

    // Extract the user-requested TOP N from original question so checker doesn't override it
    const topNMatch = state.question.match(/\btop\s+(\d+)\b/i);
    const userRequestedTopN = topNMatch ? parseInt(topNMatch[1]) : null;

    const systemPrompt = `You are a T-SQL code reviewer for Microsoft SQL Server.
Your job is to FIX BUGS without changing the intent or scope of the query.

══ ABSOLUTE DO-NOT-CHANGE RULES (never override these) ══
1. NEVER change FROM table name or JOIN table name — even if it's not in the schema list.
   The schema list only shows discovered views; join/lookup tables may be valid but not listed.
   If "VwMstItems", "VwAIBranch", "VwAICustomerDetails" appear in JOINs — leave them exactly as is.
2. NEVER increase TOP N if the user asked for a specific number.
   ${userRequestedTopN ? `The user asked for TOP ${userRequestedTopN} — keep TOP ${userRequestedTopN}, do NOT change to any other number.` : 'Only add TOP if there is no TOP at all and no GROUP BY aggregation.'}
3. NEVER rename a column alias unless it contains spaces or is an SQL reserved word.
4. NEVER change a column to a different column name unless it truly does not exist in ANY table in the schema — check ALL tables before flagging a column as missing.
5. NEVER remove or change a JOIN that already has a valid ON clause.

══ ONLY fix these actual errors ══
  A. Column name that definitely does not exist in ANY schema table → find the correct column
  B. Wrong branch identifier: BranchId on PowerBI views, or BranchAlias on VwAI* views
  C. Wrong revenue: SaleAmountBeforeTax or GrossValue used as final revenue → use SaleNetAmount/NetAmount
  D. Integer date subtraction: GETDATE()-7 → DATEADD(day,-7,CAST(GETDATE() AS DATE))
  E. YEAR(BirthdayDt) filter → remove YEAR, keep only MONTH
  F. Missing GROUP BY for a non-aggregate SELECT column (only if clearly missing)
  G. Missing aggregate alias (SUM/COUNT without AS)
  H. SELECT * → replace with explicit columns only if a specific error would result
  I. Trailing semicolon → remove
  J. SQL comments → remove

IMPORTANT APPROACH:
- When in doubt, LEAVE IT UNCHANGED.
- A query that runs correctly is better than a "fixed" query that is wrong.
- Return the SQL UNCHANGED if you cannot identify a definite error.

${ERP_SQL_RULES}

Output ONLY the SQL — no explanation, no markdown fences.`;

    const userPrompt =
      `[SCHEMA — ONLY these columns exist]\n${state.schemaText}\n\n` +
      (state.sampleText ? `[SAMPLE DATA]\n${state.sampleText}\n\n` : "") +
      `[SQL TO REVIEW]\n${state.generatedSQL}`;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const checkedSQL = extractSQL(response.content) || state.generatedSQL;
    const changed = checkedSQL !== state.generatedSQL;
    console.log("[langchain] check_sql changed:", changed, "→", checkedSQL.slice(0, 160));
    return { checkedSQL, nodeLog: ["check_sql"] };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 6 — execute_sql
   ───────────────────────────────────────────────────────────────────────────── */
function makeExecuteSQL(pool) {
  return async function executeSQL(state) {
    console.log("[langchain] node: execute_sql");
    const sql = state.checkedSQL || state.generatedSQL;
    const result = await dispatchAgenticTool(pool, "run_select", { sql }, state.question, "");
    console.log(
      "[langchain] execute_sql:",
      result.error ? `ERROR: ${result.error}` : `${result.row_count ?? (result.data?.length ?? 0)} rows`
    );
    return {
      executionResult: result,
      finalSQL:  result.error ? null : sql,
      finalData: result.error ? [] : (result.data || []),
      nodeLog:   ["execute_sql"],
    };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 7 — error_recovery
   ───────────────────────────────────────────────────────────────────────────── */
function makeErrorRecovery(llm) {
  return async function errorRecovery(state) {
    const errMsg   = state.executionResult?.error || "unknown error";
    const failedSQL = state.executionResult?.failed_sql || state.checkedSQL || state.generatedSQL;
    const attempt  = (state.retryCount || 0) + 1;
    console.log("[langchain] node: error_recovery attempt", attempt, "error:", errMsg);

    const systemPrompt = `You are a T-SQL debugger for Microsoft SQL Server.
A query failed with the error shown. Fix the SQL so it executes without error.
Study the error carefully — it usually tells you exactly which column or syntax is wrong.
${ERP_SQL_RULES}
Output ONLY the corrected SQL — no explanation, no markdown, no semicolons.`;

    const userPrompt =
      `[SCHEMA — use ONLY these columns]\n${state.schemaText}\n\n` +
      `[FAILED SQL]\n${failedSQL}\n\n` +
      `[DB ERROR]\n${errMsg}\n\n` +
      `[ALL PREVIOUS ERRORS]\n${[...state.retryErrors, errMsg].join("\n")}\n\n` +
      `Fix the SQL. If the error is "Invalid column name X", find the correct column in the schema above.`;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const fixedSQL = extractSQL(response.content) || failedSQL;
    return {
      checkedSQL:  fixedSQL,
      generatedSQL: fixedSQL,
      retryCount:  attempt,
      retryErrors: [`Attempt ${attempt}: ${errMsg}`],
      nodeLog:     ["error_recovery"],
    };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 8 — generate_answer
   ───────────────────────────────────────────────────────────────────────────── */
function makeGenerateAnswer(llm) {
  return async function generateAnswer(state) {
    console.log("[langchain] node: generate_answer");
    const rows = state.finalData || [];

    if (rows.length === 0) {
      const noDataMsg =
        state.executionResult?.error
          ? `Could not retrieve data — query error: ${state.executionResult.error}. Try rephrasing or using a different date range.`
          : "No matching records found for your question. Try widening the date range, checking filters (branch name, category, etc.), or rephrasing the question.";
      return { finalAnswer: noDataMsg, confidence: "low", confidenceNote: "0 rows returned", nodeLog: ["generate_answer"] };
    }

    const sample = JSON.stringify(rows.slice(0, 20), null, 2);
    const totalRows = rows.length;

    const systemPrompt = `You are a retail business intelligence analyst for a fashion ERP.
Summarize the query results in 2-5 plain English sentences.
Rules:
- Lead with the single most important number or finding
- Use Indian number system: values ÷ 100000 = Lakhs, ÷ 10000000 = Crores
- Example: 16825000 → ₹168.25 Lakhs or ₹1.68 Crores
- Be precise — include actual numbers from the data, not vague descriptions
- If there are totals/sums in the data, state them prominently
- If the data shows a trend, describe the direction clearly
- Do NOT mention SQL, database, columns, or technical details
- Do NOT say "the data shows" — speak directly ("Total sales were…")`;

    const userPrompt =
      `[QUESTION]\n${state.question}\n\n` +
      `[DATA — ${totalRows} row(s)]\n${sample}` +
      (totalRows > 20 ? `\n… (${totalRows - 20} more rows not shown)` : "");

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    return {
      finalAnswer: response.content,
      confidence:  "high",
      nodeLog:     ["generate_answer"],
    };
  };
}


/* ─────────────────────────────────────────────────────────────────────────────
   NODE 8.5 — zero_rows_recovery
   SQL ran OK but returned 0 rows. Try once to widen the date range or relax
   the filter and re-generate (sets zeroRowsRetried so we don't loop forever).
   ───────────────────────────────────────────────────────────────────────────── */
function makeZeroRowsRecovery(llm) {
  return async function zeroRowsRecovery(state) {
    console.log("[langchain] node: zero_rows_recovery");
    const systemPrompt = `You are a T-SQL expert. A query returned 0 rows.
Common causes: date range too narrow, filter value mis-spelled, wrong table used.
Fix the query so it returns data.
${ERP_SQL_RULES}
Output ONLY the corrected SQL — no explanation, no markdown, no semicolons.`;

    const userPrompt =
      `[SCHEMA]\n${state.schemaText}\n\n` +
      (state.sampleText ? `[SAMPLE DATA]\n${state.sampleText}\n\n` : "") +
      `[ZERO-ROW QUERY — widen date range or relax filters]\n${state.checkedSQL || state.generatedSQL}\n\n` +
      `Hint: remove or widen date filters; if filtering by name, try removing the filter.`;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);
    const fixedSQL = extractSQL(response.content) || state.checkedSQL || state.generatedSQL;
    console.log("[langchain] zero_rows_recovery SQL:", fixedSQL.slice(0, 160));
    return {
      generatedSQL:    fixedSQL,
      checkedSQL:      fixedSQL,
      zeroRowsRetried: true,
      nodeLog:         ["zero_rows_recovery"],
    };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   NODE 9 — verify_answer
   Cross-checks the generated natural-language answer against the actual data.
   If numbers don't match it corrects them silently rather than hallucinating.
   ───────────────────────────────────────────────────────────────────────────── */
function makeVerifyAnswer(llm) {
  return async function verifyAnswer(state) {
    console.log("[langchain] node: verify_answer");
    // Only verify when we have a meaningful answer and some rows
    const rows = state.finalData || [];
    if (!state.finalAnswer || rows.length === 0) {
      return { nodeLog: ["verify_answer"] };
    }

    const sample = JSON.stringify(rows.slice(0, 20), null, 2);
    const systemPrompt = `You are a fact-checker for a retail BI system.
You are given an answer text and the actual data rows it was generated from.
Your job: verify every number in the answer is correct according to the data.
If a number is wrong, silently correct it without mentioning the correction.
If the answer is completely correct, return it unchanged.
Do NOT add new insights or change wording beyond fixing wrong numbers.
Respond ONLY with the (possibly corrected) answer text — no JSON, no labels.`;

    const userPrompt =
      `[ANSWER TO VERIFY]\n${state.finalAnswer}\n\n` +
      `[ACTUAL DATA — ${rows.length} row(s)]\n${sample}` +
      (rows.length > 20 ? `\n… (${rows.length - 20} more rows not shown)` : "");

    try {
      const response = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);
      const verified = String(response.content || "").trim();

      // Auto-save to RAG store when confidence is high and query succeeded cleanly
      const autoSave =
        verified &&
        state.retryCount === 0 &&
        !state.zeroRowsRetried &&
        state.finalSQL &&
        rows.length >= 1 &&
        String(process.env.RAG_AUTO_SAVE || "1").trim() !== "0";

      if (autoSave) {
        ragStore.addExample(state.question, state.finalSQL, "", true).catch(() => {});
        console.log("[langchain] RAG: auto-saved successful query as example");
      }

      if (verified) {
        return { finalAnswer: verified, nodeLog: ["verify_answer"] };
      }
    } catch (e) {
      console.warn("[langchain] verify_answer error (skipped):", e.message);
    }
    return { nodeLog: ["verify_answer"] };
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   ROUTING HELPERS
   ───────────────────────────────────────────────────────────────────────────── */
function routeAfterExecute(state) {
  const err  = state.executionResult?.error;
  const rows = Array.isArray(state.finalData) ? state.finalData.length : 0;

  if (err) {
    // SQL error — retry up to 3 times
    if ((state.retryCount || 0) < 3) return "error_recovery";
    return "generate_answer"; // give up, answer with error message
  }
  if (rows === 0 && !state.zeroRowsRetried) {
    // Ran OK but no rows — try once to widen/relax
    return "zero_rows_recovery";
  }
  return "generate_answer";
}

function routeAfterZeroRows(state) {
  // After widening, go back to re-execute (not re-generate — SQL already fixed)
  return "execute_sql";
}

/* ─────────────────────────────────────────────────────────────────────────────
   GRAPH CONSTRUCTION
   ───────────────────────────────────────────────────────────────────────────── */
function buildGraph(pool, llmSQL, llmAnswer) {
  const graph = new StateGraph(AgentState);

  // Register nodes — load_schema replaces discover_views + get_schema + sample_data
  graph.addNode("load_schema",        makeLoadSchema());
  graph.addNode("retrieve_context",   makeRetrieveContext());
  graph.addNode("generate_sql",       makeGenerateSQL(llmSQL));
  graph.addNode("check_sql",          makeCheckSQL(llmSQL));
  graph.addNode("execute_sql",        makeExecuteSQL(pool));
  graph.addNode("error_recovery",     makeErrorRecovery(llmSQL));
  graph.addNode("zero_rows_recovery", makeZeroRowsRecovery(llmSQL));
  graph.addNode("generate_answer",    makeGenerateAnswer(llmAnswer));
  graph.addNode("verify_answer",      makeVerifyAnswer(llmAnswer));

  // Linear entry pipeline — RAG retrieval between schema load and SQL gen
  graph.addEdge(START,                "load_schema");
  graph.addEdge("load_schema",        "retrieve_context");
  graph.addEdge("retrieve_context",   "generate_sql");
  graph.addEdge("generate_sql",  "check_sql");
  graph.addEdge("check_sql",     "execute_sql");

  // Conditional routing after execute
  graph.addConditionalEdges("execute_sql", routeAfterExecute, {
    error_recovery:    "error_recovery",
    zero_rows_recovery:"zero_rows_recovery",
    generate_answer:   "generate_answer",
  });

  // Error recovery loops back to execute
  graph.addEdge("error_recovery",     "execute_sql");

  // Zero-rows recovery loops back to execute (SQL was already rewritten)
  graph.addConditionalEdges("zero_rows_recovery", routeAfterZeroRows, {
    execute_sql: "execute_sql",
  });

  // Final pipeline
  graph.addEdge("generate_answer", "verify_answer");
  graph.addEdge("verify_answer",   END);

  return graph.compile();
}

/* ─────────────────────────────────────────────────────────────────────────────
   EXPORTED ENTRY POINT
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Run the full LangGraph SQL pipeline.
 *
 * Improvements over raw agentic loop:
 *  • temperature=0 for SQL generation/checking — no hallucinated column names
 *  • temperature=0.2 for answer — natural but grounded
 *  • Schema dynamically filtered to only relevant views (discover_views node)
 *  • Sample data injected so LLM sees real date formats / value ranges
 *  • 3-retry error recovery with cumulative error memory
 *  • Zero-rows recovery (widening filter) runs once before giving up
 *  • verify_answer cross-checks numbers against raw data
 *
 * @param {object} opts
 * @param {string} opts.apiKey        OpenAI API key
 * @param {string} [opts.model]       OpenAI model id (default: env OPENAI_MODEL)
 * @param {string} opts.question      Natural-language question
 * @param {object} opts.pool          mssql connection pool
 * @param {string} [opts.dateContext] Pre-built date context string (FY dates etc.)
 * @param {object} [opts.userDateRange] { from, to } explicit date range
 * @param {string} [opts.tableHint]   Force-prefer a specific view/table
 * @returns {{ data, sql, answer, confidence, confidenceNote, retryCount }}
 */
async function runLangChainQuery({
  apiKey,
  model,
  question,
  pool,
  dateContext,
  userDateRange,
  tableHint,
}) {
  const modelName = String(model || process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

  // SQL LLM — temperature=0 for maximum determinism (no hallucinated columns)
  const llmSQL = new ChatOpenAI({
    openAIApiKey: apiKey,
    model:        modelName,
    temperature:  0,
    maxTokens:    2048,
  });

  // Answer LLM — slightly warmer for natural language summaries
  const llmAnswer = new ChatOpenAI({
    openAIApiKey: apiKey,
    model:        modelName,
    temperature:  0.2,
    maxTokens:    1024,
  });

  const app = buildGraph(pool, llmSQL, llmAnswer);

  const initialState = {
    question:      String(question || ""),
    dateContext:   String(dateContext || ""),
    tableHint:     tableHint || null,
    userDateRange: userDateRange || {},
  };

  console.log("[langchain] starting graph for:", question.slice(0, 80));

  let result;
  try {
    result = await app.invoke(initialState);
  } catch (graphErr) {
    console.error("[langchain] graph error:", graphErr.message);
    throw graphErr;
  }

  console.log(
    "[langchain] graph complete — rows:", (result.finalData || []).length,
    "confidence:", result.confidence,
    "retries:", result.retryCount
  );

  return {
    data:           result.finalData  || [],
    sql:            result.finalSQL   || null,
    answer:         result.finalAnswer || "",
    confidence:     result.confidence  || "medium",
    confidenceNote: result.confidenceNote || "",
    retryCount:     result.retryCount  || 0,
    nodeLog:        result.nodeLog     || [],
  };
}

module.exports = { runLangChainQuery };
