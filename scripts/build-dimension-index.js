/**
 * Build distinct-value index for plain-English auto-correct and UI pickers.
 *
 * Usage: node scripts/build-dimension-index.js
 * Env: same DB_* as API (.env at repo root)
 */
"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const fs = require("fs");
const path = require("path");
const sql = require("mssql");

const OUT_PATH = path.join(__dirname, "../metadata/dimension-values.json");

const SOURCE_VIEWS = [
  "dbo.VW_MB_POWERBI_APP_REPORT",
  "dbo.VW_MB_POWERBI_SLSXNS_REPORT",
];

const DIMENSION_COLUMNS = [
  { key: "BranchAlias", columns: ["BranchAlias"] },
  { key: "Category", columns: ["Category", "CategoryShortName"] },
  { key: "Department", columns: ["Department", "DepartmentShortName"] },
  { key: "SupplierName", columns: ["SupplierName", "SupplierAlias"] },
];

function envTrim(key) {
  const v = process.env[key];
  return v == null ? undefined : String(v).trim();
}

function getDbConfig() {
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
      requestTimeout: 120000,
      connectTimeout: 30000,
    },
  };
}

function quoteIdent(name) {
  return `[${String(name).replace(/]/g, "]]")}]`;
}

async function distinctForColumn(pool, viewName, columnName, limit = 500) {
  const vn = viewName.replace(/^dbo\./i, "");
  const sqlText = `
    SELECT DISTINCT TOP (${limit}) ${quoteIdent(columnName)} AS val
    FROM dbo.${quoteIdent(vn)}
    WHERE ${quoteIdent(columnName)} IS NOT NULL
      AND LTRIM(RTRIM(CAST(${quoteIdent(columnName)} AS NVARCHAR(400)))) <> ''
    ORDER BY ${quoteIdent(columnName)}
  `;
  const r = await pool.request().query(sqlText);
  return (r.recordset || [])
    .map((row) => String(row.val ?? "").trim())
    .filter(Boolean);
}

async function columnExists(pool, viewName, columnName) {
  const vn = viewName.replace(/^dbo\./i, "");
  const r = await pool.request().input("v", sql.NVarChar(128), vn).input("c", sql.NVarChar(128), columnName)
    .query(`
      SELECT 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @v AND COLUMN_NAME = @c
    `);
  return (r.recordset || []).length > 0;
}

async function buildDimensionIndex(dbPool) {
  console.log("Indexing categorical dimensions for plain-English search…");

  const dimensions = {};
  const perView = {};

  for (const dim of DIMENSION_COLUMNS) {
    const merged = new Set();
    for (const viewName of SOURCE_VIEWS) {
      if (!perView[viewName]) perView[viewName] = {};
      for (const col of dim.columns) {
        if (!(await columnExists(dbPool, viewName, col))) continue;
        try {
          const vals = await distinctForColumn(dbPool, viewName, col, 800);
          perView[viewName][col] = vals.length;
          vals.forEach((v) => merged.add(v));
        } catch (e) {
          console.warn(`  skip ${viewName}.${col}:`, e.message);
        }
      }
    }
    dimensions[dim.key] = [...merged].sort((a, b) => a.localeCompare(b));
    console.log(`  ${dim.key}: ${dimensions[dim.key].length} values`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    database: envTrim("DB_NAME") || null,
    sourceViews: SOURCE_VIEWS,
    dimensions,
    views: perView,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log("Dimension lookup index written:", OUT_PATH);
  return payload;
}

async function main() {
  const pool = await sql.connect(getDbConfig());
  try {
    await buildDimensionIndex(pool);
  } finally {
    await pool.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { buildDimensionIndex, OUT_PATH };
