#!/usr/bin/env node
"use strict";
/**
 * Measure /api/analytics/dashboard latency (cold vs warm cache).
 *
 * Usage:
 *   node scripts/measure-analytics-latency.js --token YOUR_JWT
 *   node scripts/measure-analytics-latency.js --base http://localhost:3000 --period mtd
 *
 * Env: ERP_API_KEY if API_KEY is set on server.
 */
require("dotenv").config({ quiet: true });

const http = require("http");
const https = require("https");

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {
    base: process.env.ERP_BASE_URL || "http://localhost:3000",
    token: process.env.ERP_TEST_TOKEN || "",
    period: "mtd",
    phases: ["critical", "widgets"],
  };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--base" && a[i + 1]) out.base = a[++i];
    else if (a[i] === "--token" && a[i + 1]) out.token = a[++i];
    else if (a[i] === "--period" && a[i + 1]) out.period = a[++i];
  }
  return out;
}

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const payload = JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...headers,
      },
    };
    const t0 = Date.now();
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const ms = Date.now() - t0;
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* ignore */
        }
        resolve({ ms, status: res.statusCode, headers: res.headers, json, text: text.slice(0, 200) });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const { base, token, period, phases } = parseArgs();
  if (!token) {
    console.error("Provide --token or ERP_TEST_TOKEN in .env");
    process.exit(1);
  }
  const apiKey = process.env.API_KEY || process.env.ERP_API_KEY || "";
  const hdrs = {
    Authorization: `Bearer ${token}`,
    "ngrok-skip-browser-warning": "true",
  };
  if (apiKey) hdrs["X-API-Key"] = apiKey;

  console.log(`Base: ${base}  Period: ${period}\n`);

  for (const loadPhase of phases) {
    const body = { period, dataset: "sales", compact: true, loadPhase };
    const r = await postJson(`${base}/api/analytics/dashboard`, body, hdrs);
    const cache = r.headers["x-erp-cache-hit"] || r.headers["X-ERP-Cache-Hit"] || "?";
    const serverMs = r.headers["x-erp-server-ms"] || r.headers["X-ERP-Server-Ms"] || "?";
    const kpi = r.json && r.json.kpi ? r.json.kpi.totalSales : null;
    console.log(
      `${loadPhase.padEnd(10)} HTTP ${r.status}  client ${r.ms}ms  server ${serverMs}ms  cacheHit=${cache}  totalSales=${kpi != null ? kpi : "—"}`
    );
    if (r.status !== 200) console.log("  body:", r.text);
  }

  console.log("\nTip: run twice — second run should show cacheHit=1 and much lower ms if cache is warm.");
  console.log("Flush: POST /api/analytics/invalidate-cache (admin) then re-test cold path.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
