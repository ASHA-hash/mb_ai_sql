/**
 * Build a text schema document for the AI prompt using INFORMATION_SCHEMA.COLUMNS.
 * Tables are resolved the same way as dataset routes (env overrides).
 */
const sql = require("mssql");

function sanitizeTableName(raw) {
  const s = String(raw || "").trim();
  if (!/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(s)) {
    return null;
  }
  return s;
}

function resolveTableForEntry(entry) {
  let full = entry.defaultTable;
  if (entry.envOverride && process.env[entry.envOverride]) {
    full = process.env[entry.envOverride];
  }
  return sanitizeTableName(full);
}

function formatDataType(row) {
  const base = String(row.DATA_TYPE || "unknown");
  const len = row.CHARACTER_MAXIMUM_LENGTH;
  if (len != null && len > 0 && len < 8000) {
    return len === -1 ? `${base}(max)` : `${base}(${len})`;
  }
  if (row.NUMERIC_PRECISION != null) {
    const scale = row.NUMERIC_SCALE;
    if (scale != null && scale > 0) {
      return `${base}(${row.NUMERIC_PRECISION},${scale})`;
    }
    return `${base}(${row.NUMERIC_PRECISION})`;
  }
  return base;
}

/**
 * @param {import("mssql").ConnectionPool} pool
 * @param {Array<{ key: string, label: string, defaultTable: string, envOverride?: string }>} registry
 * @param {{ maxTables?: number }} [options]
 * @returns {Promise<string>}
 */
async function buildSchemaDocFromDb(pool, registry, options) {
  const maxTables = Math.min(
    Math.max(parseInt(String(options?.maxTables ?? "14"), 10) || 14, 1),
    40
  );
  const seen = new Set();
  const blocks = [];

  for (const entry of registry) {
    if (blocks.length >= maxTables) {
      break;
    }
    const table = resolveTableForEntry(entry);
    if (!table || seen.has(table)) {
      continue;
    }
    seen.add(table);
    const [schemaName, objectName] = table.split(".");

    try {
      const result = await pool
        .request()
        .input("sch", sql.NVarChar(128), schemaName)
        .input("obj", sql.NVarChar(128), objectName).query(`
          SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = @sch AND TABLE_NAME = @obj
          ORDER BY ORDINAL_POSITION
        `);

      const rows = result.recordset || [];
      if (!rows.length) {
        blocks.push(
          `${table} — ${entry.label} (dataset key: ${entry.key}):\n(no columns returned — check name or permissions)`
        );
        continue;
      }

      const colLines = rows.map((r) => {
        const nullable = String(r.IS_NULLABLE).toUpperCase() === "YES" ? ", nullable" : "";
        return `  - ${r.COLUMN_NAME} (${formatDataType(r)}${nullable})`;
      });
      blocks.push(
        `${table} — ${entry.label} (dataset key: ${entry.key}):\n${colLines.join("\n")}`
      );
    } catch (err) {
      blocks.push(
        `${table} — ${entry.label}: (introspection error: ${String(err.message || err)})`
      );
    }
  }

  if (!blocks.length) {
    return "";
  }

  return `Real column metadata (use these names exactly in SELECT lists, WHERE, GROUP BY, ORDER BY):\n\n${blocks.join(
    "\n\n"
  )}`;
}

module.exports = {
  buildSchemaDocFromDb,
  resolveTableForEntry,
};
