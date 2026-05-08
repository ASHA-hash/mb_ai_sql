"use strict";

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");

function fetchOpts(extraHeaders) {
  const h = { "Content-Type": "application/json", ...extraHeaders };
  const token = String(process.env.GOLDEN_AUTH_BEARER || "").trim();
  if (token) h.Authorization = `Bearer ${token}`;
  return { headers: h };
}

async function assertApiReachable(base) {
  const url = `${base}/api/health`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { ...fetchOpts(), method: "GET", signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `Warning: ${url} returned HTTP ${res.status}. ${body.slice(0, 200)} — running golden tests anyway.\n`
      );
    }
  } catch (e) {
    clearTimeout(timer);
    const detail = e.cause && e.cause.code ? ` (${e.cause.code})` : e.cause ? ` (${e.cause})` : "";
    console.error(
      `Cannot reach the API at ${base}${detail}\n` +
        `  ${e.message}\n\n` +
        `  Fix:\n` +
        `  • In another terminal, from the project folder, run:  npm start\n` +
        `  • If the server uses another host/port, set:  set GOLDEN_BASE_URL=http://127.0.0.1:PORT\n` +
        `  • If RBAC blocks unauthenticated calls, log in via the dashboard and set GOLDEN_AUTH_BEARER to your JWT.\n`
    );
    process.exit(1);
  }
}

async function main() {
  const root = path.join(__dirname, "..");
  const file = path.join(root, "metadata", "golden_queries.json");
  const tests = JSON.parse(fs.readFileSync(file, "utf8"));
  const base = (process.env.GOLDEN_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");

  console.log(`Golden queries — base URL: ${base}`);
  await assertApiReachable(base);

  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    const started = Date.now();
    try {
      const res = await fetch(`${base}/api/query/adaptive`, {
        method: "POST",
        ...fetchOpts(),
        body: JSON.stringify({ question: t.query, tableHint: "dbo.VwAISalesData" }),
      });
      const json = await res.json();
      if (!res.ok) {
        fail++;
        console.log(
          `FAIL ${t.id} http=${res.status} error=${json.error || "?"} ${json.message || ""}`.trim()
        );
        continue;
      }
      const checks = [];
      checks.push(json.intentType === t.expect.intent);
      checks.push((json.rowCount || 0) >= (t.expect.minRows || 0));
      checks.push(json.chartPolicy === t.expect.chartPolicy);
      if (Array.isArray(t.expect.interpretationIncludes) && t.expect.interpretationIncludes.length) {
        const chips = (json.interpretation && json.interpretation.chips) || [];
        const blob = chips.map(String).join(" ").toLowerCase();
        for (const frag of t.expect.interpretationIncludes) {
          checks.push(blob.includes(String(frag || "").trim().toLowerCase()));
        }
      }
      const ok = checks.every(Boolean);
      if (ok) pass++; else fail++;
      const interp =
        json.interpretation && json.interpretation.chips ? ` interp=${JSON.stringify(json.interpretation.chips)}` : "";
      console.log(
        `${ok ? "PASS" : "FAIL"} ${t.id} (${Date.now() - started}ms) intent=${json.intentType} rows=${json.rowCount} chart=${json.chartPolicy}${interp}`
      );
    } catch (e) {
      fail++;
      const extra = e.cause ? ` cause=${e.cause.code || e.cause}` : "";
      console.log(`FAIL ${t.id} error=${e.message}${extra}`);
    }
  }
  console.log(`\nGolden tests complete: pass=${pass} fail=${fail} total=${tests.length}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
