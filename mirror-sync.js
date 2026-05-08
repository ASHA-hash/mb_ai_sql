/**
 * Optional one-way snapshot: SQL Server (ERP) → PostgreSQL mirror.
 * When MIRROR_READ_ENABLED=1, the API can serve these rows via GET /api/dataset/:key?source=mirror (see mirror-read.js).
 * Run on a cron host after setting placeholders (see DOCUMENTS/PLACEHOLDER_VALUES.md).
 *
 * Usage:  npm run mirror-sync
 * Requires: MIRROR_DATABASE_URL in .env (postgresql://USER:PASSWORD@YOUR_PG_HOST:5432/YOUR_DB)
 */

require("dotenv").config({ quiet: true });
const sql = require("mssql");
const { Client } = require("pg");
const { DATASET_REGISTRY } = require("./datasets-registry");
const { datasetDateOrderByDescSql } = require("./filter-query");

function sanitizeTableName(raw) {
  const s = String(raw || "").trim();
  if (!/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(s)) {
    return null;
  }
  return s;
}

function getDatasetEntry(datasetKey) {
  const n = String(datasetKey || "").toLowerCase().trim();
  return DATASET_REGISTRY.find((r) => r.key === n) || null;
}

function resolveDatasetTable(datasetKey) {
  const e = getDatasetEntry(datasetKey);
  if (!e) {
    return null;
  }
  let full = e.defaultTable;
  if (e.envOverride && process.env[e.envOverride]) {
    full = process.env[e.envOverride];
  }
  return sanitizeTableName(full);
}

function envTrim(key) {
  const v = process.env[key];
  if (v == null) {
    return undefined;
  }
  return String(v).trim();
}

function getDbConfig() {
  const requestTimeout = parseInt(process.env.DB_REQUEST_TIMEOUT_MS || "120000", 10);
  const connectTimeout = parseInt(process.env.DB_CONNECT_TIMEOUT_MS || "60000", 10);
  const encryptEnv = String(process.env.DB_ENCRYPT || "")
    .trim()
    .toLowerCase();
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
      requestTimeout: Number.isFinite(requestTimeout) ? requestTimeout : 120000,
      connectTimeout: Number.isFinite(connectTimeout) ? connectTimeout : 60000,
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  };
}

function rowsForJson(recordset) {
  return recordset.map((row) => {
    const out = {};
    for (const key of Object.keys(row)) {
      const val = row[key];
      if (Buffer.isBuffer(val)) {
        out[key] = val.toString("hex");
      } else if (val instanceof Uint8Array) {
        out[key] = Buffer.from(val).toString("hex");
      } else if (val instanceof Date) {
        out[key] = val.toISOString();
      } else {
        out[key] = val;
      }
    }
    return out;
  });
}

async function ensureMirrorTable(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS erp_mirror_snapshots (
      dataset_key TEXT PRIMARY KEY,
      row_count INTEGER NOT NULL,
      payload JSONB NOT NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function main() {
  const mirrorUrl = String(process.env.MIRROR_DATABASE_URL || "").trim();
  if (!mirrorUrl || mirrorUrl.includes("YOUR_PG_HOST")) {
    console.log(
      "[mirror-sync] Skip: set MIRROR_DATABASE_URL in .env (see DOCUMENTS/PLACEHOLDER_VALUES.md)."
    );
    process.exit(0);
  }

  const rawKeys = process.env.MIRROR_SYNC_KEYS || "sales,stock";
  const keys = rawKeys
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  const rowLimit = Math.min(
    500,
    Math.max(1, parseInt(process.env.MIRROR_ROW_LIMIT || "500", 10) || 500)
  );

  const pg = new Client({ connectionString: mirrorUrl });
  await pg.connect();
  await ensureMirrorTable(pg);

  const pool = await sql.connect(getDbConfig());

  for (const key of keys) {
    const table = resolveDatasetTable(key);
    if (!table) {
      console.warn("[mirror-sync] Unknown dataset key, skipping:", key);
      continue;
    }
    const request = pool.request();
    request.input("limit", sql.Int, rowLimit);
    const sqlText =
      `SELECT TOP (@limit) * FROM ${table}${datasetDateOrderByDescSql(key)}`;
    const result = await request.query(sqlText);
    const data = rowsForJson(result.recordset);
    const payload = JSON.stringify(data);
    await pg.query(
      `INSERT INTO erp_mirror_snapshots (dataset_key, row_count, payload, synced_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (dataset_key) DO UPDATE SET
         row_count = EXCLUDED.row_count,
         payload = EXCLUDED.payload,
         synced_at = now();`,
      [key, data.length, payload]
    );
    console.log("[mirror-sync] OK", key, data.length, "rows");
  }

  await pg.end();
  await pool.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("[mirror-sync] Failed:", err.message || err);
  process.exit(1);
});
