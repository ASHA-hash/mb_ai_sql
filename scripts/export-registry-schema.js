/**
 * Export column metadata for every dbo object wired in datasets-registry + AI views.json.
 *
 * From repo root (requires .env DB_* like test:db):
 *   node scripts/export-registry-schema.js
 *   node scripts/export-registry-schema.js --out metadata/schema-registry-columns.json
 *   node scripts/export-registry-schema.js --format md
 */

"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const { DATASET_REGISTRY } = require("../datasets-registry");
const views = require("../metadata/views.json");

function envTrim(key) {
  const v = process.env[key];
  if (v == null) return undefined;
  return String(v).trim();
}

function getConfig() {
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
      requestTimeout: parseInt(envTrim("DB_REQUEST_TIMEOUT_MS") || "120000", 10),
      connectTimeout: parseInt(envTrim("DB_CONNECT_TIMEOUT_MS") || "60000", 10),
    },
  };
}

function splitSchemaObject(fullName) {
  const raw = String(fullName || "").trim().replace(/^\[|\]$/g, "");
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [schemaName, objectName] = parts;
  if (!/^[A-Za-z0-9_]+$/.test(schemaName) || !/^[A-Za-z0-9_]+$/.test(objectName)) return null;
  return { schemaName, objectName, fullName: `${schemaName}.${objectName}` };
}

function collectWiredObjects() {
  const set = new Map();
  for (const row of DATASET_REGISTRY) {
    const p = splitSchemaObject(row.defaultTable);
    if (!p) continue;
    const cur = set.get(p.fullName) || {};
    set.set(p.fullName, {
      ...cur,
      datasetKey: row.key,
      datasetLabel: row.label,
    });
  }
  for (const domain of Object.keys(views)) {
    const cfg = views[domain];
    const list = cfg && cfg.allowed_views;
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      const p = splitSchemaObject(v);
      if (!p) continue;
      const cur = set.get(p.fullName) || {};
      const doms = new Set(cur.aiDomains || []);
      doms.add(domain);
      set.set(p.fullName, { ...cur, aiDomains: [...doms].sort() });
    }
  }
  return set;
}

function buildWhereClause(objects) {
  const parts = [];
  for (const name of objects) {
    const p = splitSchemaObject(name);
    if (!p) continue;
    parts.push(`(TABLE_SCHEMA = N'${p.schemaName}' AND TABLE_NAME = N'${p.objectName}')`);
  }
  if (!parts.length) throw new Error("No valid schema.object names collected.");
  return parts.join(" OR ");
}

async function main() {
  const argv = process.argv.slice(2);
  let outPath = "";
  let format = "json";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") outPath = argv[++i] || "";
    else if (argv[i] === "--format") format = argv[++i] || "json";
  }

  const cfg = getConfig();
  if (!cfg.server || !cfg.user || cfg.password == null || !cfg.database) {
    console.error("Missing DB_* in .env — need DB_SERVER, DB_USER, DB_PASSWORD, DB_NAME");
    process.exit(1);
  }

  const metaByObject = collectWiredObjects();
  const sortedNames = [...metaByObject.keys()].sort();

  const where = buildWhereClause(sortedNames);
  const pool = await sql.connect(cfg);

  const qry = `
    SELECT TABLE_SCHEMA AS table_schema,
           TABLE_NAME AS table_name,
           COLUMN_NAME AS column_name,
           DATA_TYPE AS data_type,
           CHARACTER_MAXIMUM_LENGTH AS char_max_len,
           NUMERIC_PRECISION AS num_precision,
           NUMERIC_SCALE AS num_scale,
           IS_NULLABLE AS is_nullable,
           ORDINAL_POSITION AS ordinal_position
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE ${where}
    ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
  `;

  const result = await pool.request().query(qry);
  await pool.close();

  const rows = result.recordset || [];
  /** @type Record<string, Array<{column_name:string,data_type:string,is_nullable:string,ordinal_position:number}>> */
  const byTable = {};

  const fullRowKey = (r) => `${r.table_schema}.${r.table_name}`;

  function formatDt(r) {
    const dt = String(r.data_type || "");
    if (r.char_max_len != null && Number(r.char_max_len) > 0 && Number(r.char_max_len) < 8000) {
      return `${dt}(${r.char_max_len})`;
    }
    if (r.char_max_len === -1) return `${dt}(max)`;
    if (r.num_precision != null) {
      const s = r.num_scale != null ? `(${r.num_precision},${r.num_scale})` : `(${r.num_precision})`;
      return dt + s;
    }
    return dt;
  }

  for (const r of rows) {
    const key = fullRowKey(r);
    if (!byTable[key])
      byTable[key] = [];
    byTable[key].push({
      column_name: r.column_name,
      data_type: formatDt(r),
      is_nullable: r.is_nullable,
      ordinal_position: r.ordinal_position,
    });
  }

  const payload = {
    generatedAtIso: new Date().toISOString(),
    database: cfg.database,
    objectCount: sortedNames.length,
    objectsMeta: sortedNames.map((full) => ({
      qualifiedName: full,
      ...(metaByObject.get(full) || {}),
      columnCount: (byTable[full] || []).length,
      columns: byTable[full] || [],
    })),
  };

  if (format === "md") {
    let md = `# Schema (${payload.database})\n\nGenerated ${payload.generatedAtIso}\n\n`;
    for (const o of payload.objectsMeta) {
      md += `## ${o.qualifiedName}\n\n`;
      if (!o.columns.length) md += `_No rows in INFORMATION_SCHEMA (missing object or permission)._\n\n`;
      else {
        md += "| # | Column | Type | Nullable |\n|---:|--------|------|----------|\n";
        let i = 0;
        for (const c of o.columns) {
          i++;
          md += `| ${i} | \`${c.column_name}\` | ${c.data_type} | ${c.is_nullable} |\n`;
        }
        md += "\n";
      }
    }
    if (outPath) fs.writeFileSync(outPath, md, "utf8");
    else process.stdout.write(md);
    return;
  }

  const json = JSON.stringify(payload, null, 2);
  if (outPath) fs.writeFileSync(outPath, json, "utf8");
  else process.stdout.write(json);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
