"use strict";

/**
 * Exercise /api/query/adaptive (Adaptive Agent = forceMode langgraph) like the dashboard.
 *
 * Usage:
 *   node scripts/test-adaptive-dynamic-suite.js
 *   node scripts/test-adaptive-dynamic-suite.js --fast-only
 *   ADAPTIVE_TEST_MAX=5 node scripts/test-adaptive-dynamic-suite.js
 *
 * Env: .env (OPENAI_API_KEY, DB_*), optional API_KEY, RBAC via X-User-Email.
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");

const BASE = (process.env.ADAPTIVE_TEST_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const TIMEOUT_MS = Math.max(30000, parseInt(process.env.ADAPTIVE_TEST_TIMEOUT_MS || "180000", 10));
const MAX = parseInt(process.env.ADAPTIVE_TEST_MAX || "0", 10) || 0;
const FAST_ONLY = process.argv.includes("--fast-only");

const TESTS = [
  { id: "fp1", group: "fast", q: "Top 5 branches by gross revenue this month", expect: { minRows: 0, sqlIncludes: ["BranchAlias", "MrpValue"] } },
  { id: "fp2", group: "fast", q: "What is today's total gross revenue?", expect: { minRows: 0, sqlIncludes: ["MrpValue", "GETDATE()"] } },
  { id: "fp3", group: "fast", q: "What is MTD gross revenue?", expect: { minRows: 0, sqlIncludes: ["MrpValue", "DATEFROMPARTS"] } },
  { id: "fp4", group: "fast", q: "Top 10 vendors by purchase amount this month", expect: { minRows: 0, sqlIncludes: ["PUR", "SupplierName"], sqlExcludes: ["APP_REPORT"] } },
  { id: "fp5", group: "fast", q: "Top 10 salespersons by gross revenue this month", expect: { minRows: 0, sqlIncludes: ["SalesPersonName", "SLS_DATA"], sqlExcludes: ["SupplierName AS StaffName"] } },
  { id: "fp6", group: "fast", q: "Show top 5 categories by gross revenue this month", expect: { minRows: 0, sqlIncludes: ["CategoryShortName"] } },
  { id: "fp7", group: "fast", q: "best branches this month by sales", expect: { minRows: 0, sqlIncludes: ["BranchAlias"] } },
  { id: "fp8", group: "fast", q: "leading vendors by purchase value MTD", expect: { minRows: 0, sqlIncludes: ["PUR", "SupplierName"] } },

  { id: "dyn1", group: "dynamic", q: "Which store had the highest MrpValue yesterday?", expect: { minRows: 0, sqlIncludes: ["BranchAlias", "MrpValue", "DATEADD"] } },
  { id: "dyn2", group: "dynamic", q: "Top 15 branches by bill count MTD", expect: { minRows: 0, sqlIncludes: ["BranchAlias", "XnNo", "COUNT"] } },
  { id: "dyn3", group: "dynamic", q: "Who sold the most units this month?", expect: { minRows: 0, sqlIncludes: ["SalesPersonName", "SalesQuantity"] } },
  { id: "dyn4", group: "dynamic", q: "Best performing salesperson last 30 days", expect: { minRows: 0, sqlIncludes: ["SalesPersonName"] } },
  { id: "dyn5", group: "dynamic", q: "Which department sold the most pieces MTD?", expect: { minRows: 0, sqlIncludes: ["DepartmentShortName", "AppQty"] } },
  { id: "dyn6", group: "dynamic", q: "Top vendors by purchase quantity this month", expect: { minRows: 0, sqlIncludes: ["PurQty", "PUR_REPORT"] } },
  { id: "dyn7", group: "dynamic", q: "MTD purchase returns by vendor", expect: { minRows: 0, sqlIncludes: ["PRT_REPORT", "PrtQty"] } },
  { id: "dyn8", group: "dynamic", q: "Daily sales trend for the last 30 days", expect: { minRows: 0, intent: "trend", sqlIncludes: ["GROUP BY", "MrpValue"] } },
  { id: "dyn9", group: "dynamic", q: "How many bills today?", expect: { minRows: 0, sqlIncludes: ["BillCount", "SLSXNS"] } },
  { id: "dyn10", group: "dynamic", q: "YTD gross revenue", expect: { minRows: 0, sqlIncludes: ["MrpValue", "4, 1"] } },
  { id: "dyn11", group: "dynamic", q: "Largest invoices today by MrpValue", expect: { minRows: 0, sqlIncludes: ["XnNo", "MrpValue"] } },
  { id: "dyn12", group: "dynamic", q: "How many distinct invoices this month?", expect: { minRows: 0, sqlIncludes: ["COUNT", "DISTINCT", "XnNo"] } },

  { id: "stress1", group: "stress", q: "Top 10", expect: { allowClarification: true } },
  { id: "stress2", group: "stress", q: "Top vendors by MrpValue this month", expect: { minRows: 0, sqlIncludes: ["PUR", "PurQty", "PurchasePrice", "NetPur"], sqlExcludes: ["APP_REPORT"] } },
  { id: "stress3", group: "stress", q: "Top salespersons by purchase amount", expect: { minRows: 0, allowClarification: true } },
];

function headers() {
  const h = { "Content-Type": "application/json" };
  const apiKey = String(process.env.API_KEY || "").trim();
  if (apiKey) h["X-API-Key"] = apiKey;
  const email = String(process.env.ADAPTIVE_TEST_EMAIL || "ashakarthikeyan24@gmail.com").trim();
  if (email) h["X-User-Email"] = email;
  const bearer = String(process.env.GOLDEN_AUTH_BEARER || "").trim();
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  return h;
}

function sqlOk(sql, expect) {
  const s = String(sql || "").toUpperCase();
  const issues = [];
  if (expect.sqlIncludes) {
    for (const frag of expect.sqlIncludes) {
      if (!s.includes(String(frag).toUpperCase())) issues.push(`missing SQL fragment: ${frag}`);
    }
  }
  if (expect.sqlExcludes) {
    for (const frag of expect.sqlExcludes) {
      if (s.includes(String(frag).toUpperCase())) issues.push(`forbidden SQL fragment: ${frag}`);
    }
  }
  return issues;
}

async function runOne(test) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/query/adaptive`, {
      method: "POST",
      headers: headers(),
      signal: ac.signal,
      body: JSON.stringify({
        question: test.q,
        forceMode: "langgraph",
        provider: "openai",
      }),
    });
    const json = await res.json();
    const ms = Date.now() - t0;
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, ms, error: json.message || json.error || `HTTP ${res.status}` };
    }
    if (json.clarificationNeeded && test.expect.allowClarification) {
      return { ok: true, ms, mode: "clarification", rowCount: 0, sql: null };
    }
    if (json.clarificationNeeded) {
      return { ok: false, ms, error: `unexpected clarification: ${json.clarificationQuestion || "?"}` };
    }

    const sql = json.sql || "";
    const rowCount = json.rowCount ?? (json.data && json.data.length) ?? 0;
    const issues = [];

    if (test.expect.intent && json.intentType !== test.expect.intent) {
      issues.push(`intent ${json.intentType} != ${test.expect.intent}`);
    }
    if (rowCount < (test.expect.minRows ?? 0)) {
      issues.push(`rowCount ${rowCount} < ${test.expect.minRows ?? 0}`);
    }
    issues.push(...sqlOk(sql, test.expect));

    if (/salesperson|sales\s*rep|staff/i.test(test.q) && /SupplierName/i.test(sql) && !/SalesPersonName/i.test(sql)) {
      issues.push("salesperson question used SupplierName without SalesPersonName");
    }

    return {
      ok: issues.length === 0,
      ms,
      mode: json.mode,
      rowCount,
      retryCount: json.retryCount || json._langchainRetries || 0,
      sql: sql.slice(0, 200),
      issues,
    };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, ms: Date.now() - t0, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

async function main() {
  let list = TESTS;
  if (FAST_ONLY) list = list.filter((t) => t.group === "fast");
  if (MAX > 0) list = list.slice(0, MAX);

  try {
    const h = await fetch(`${BASE}/api/health`, { headers: headers() });
    if (!h.ok) throw new Error(`health ${h.status}`);
  } catch (e) {
    console.error(`Cannot reach ${BASE} — run npm start\n`, e.message);
    process.exit(1);
  }

  console.log(`Adaptive suite — ${list.length} tests — ${BASE}\n`);
  let pass = 0;
  let fail = 0;
  const failures = [];

  for (const t of list) {
    const r = await runOne(t);
    const fastModes = ["canonical_fast", "deterministic_fast", "rag_verified", "fast_path"];
    if (r.ok && t.group === "fast" && r.mode && !fastModes.includes(r.mode)) {
      r.ok = false;
      r.issues = [`expected fast path mode, got ${r.mode}`];
    }
    const status = r.ok ? "PASS" : "FAIL";
    if (r.ok) pass++;
    else {
      fail++;
      failures.push({ id: t.id, q: t.q, ...r });
    }
    console.log(
      `[${status}] ${t.id} (${t.group}) ${r.ms}ms mode=${r.mode || "-"} rows=${r.rowCount ?? "-"} retries=${r.retryCount ?? "-"}`
    );
    if (!r.ok) console.log(`       ${r.error || r.issues?.join("; ") || "?"}`);
    if (r.sql) console.log(`       SQL: ${r.sql}…`);
    console.log("");
  }

  const outPath = path.join(__dirname, "..", "logs", "adaptive-suite-results.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), pass, fail, failures }, null, 2));

  console.log(`Summary: ${pass} passed, ${fail} failed → ${outPath}`);
  process.exit(fail ? 1 : 0);
}

main();
