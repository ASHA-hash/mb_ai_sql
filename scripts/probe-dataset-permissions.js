/**
 * List which registry datasets the current DB login can SELECT.
 *
 *   npm run probe:datasets
 *
 * Writes metadata/dataset-access.json for the UI (optional).
 */
"use strict";

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const sql = require("mssql");
const { probeAllRegistryDatasets } = require("../services/dataset-access-probe");

function envTrim(key) {
  const v = process.env[key];
  return v == null ? undefined : String(v).trim();
}

function getConfig() {
  const encryptEnv = String(process.env.DB_ENCRYPT || "").trim().toLowerCase();
  const encrypt = encryptEnv === "1" || encryptEnv === "true" || encryptEnv === "yes";
  return {
    user: envTrim("DB_USER"),
    password: envTrim("DB_PASSWORD"),
    server: envTrim("DB_SERVER"),
    port: parseInt(envTrim("DB_PORT") || "1433", 10),
    database: envTrim("DB_NAME"),
    options: {
      encrypt,
      trustServerCertificate: true,
      requestTimeout: 20000,
      connectTimeout: 20000,
    },
  };
}

async function main() {
  const cfg = getConfig();
  if (!cfg.server || !cfg.database) {
    console.error("Set DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD in .env");
    process.exit(1);
  }

  const pool = await sql.connect(cfg);
  const rows = await probeAllRegistryDatasets(pool);
  await pool.close();

  const denied = rows.filter((r) => !r.ok && r.denied);
  const otherFail = rows.filter((r) => !r.ok && !r.denied);
  const ok = rows.filter((r) => r.ok);

  console.log("\n=== Dataset SELECT permission probe ===\n");
  console.log(`OK (${ok.length}):`);
  for (const r of ok) {
    console.log(`  ✓ ${r.key} → ${r.table}`);
  }
  console.log(`\nPERMISSION DENIED (${denied.length}):`);
  for (const r of denied) {
    console.log(`  ✗ ${r.key} → ${r.table}`);
  }
  if (otherFail.length) {
    console.log(`\nOTHER ERRORS (${otherFail.length}):`);
    for (const r of otherFail) {
      console.log(`  ? ${r.key} → ${r.table}: ${r.message}`);
    }
  }

  const outPath = path.join(__dirname, "..", "metadata", "dataset-access.json");
  const payload = {
    generated_at_utc: new Date().toISOString(),
    database: cfg.database,
    server: cfg.server,
    byKey: Object.fromEntries(
      rows.map((r) => [
        r.key,
        { ok: r.ok, denied: r.denied, table: r.table, message: r.message || null },
      ])
    ),
    deniedKeys: denied.map((r) => r.key),
    okKeys: ok.map((r) => r.key),
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`\nWrote ${outPath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
