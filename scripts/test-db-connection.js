/**
 * Test SQL Server connectivity using the same env vars as the API (DB_*).
 *
 * Usage (from repo root):
 *   npm run test:db
 *
 * Set credentials in .env at repo root (copy from .env.example). Do not commit .env.
 * Optional: DB_ENCRYPT=true if your server requires TLS.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const sql = require("mssql");

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
      requestTimeout: 30000,
      connectTimeout: 30000,
    },
  };
}

async function main() {
  const cfg = getConfig();
  if (!cfg.server || !cfg.user || cfg.password == null || !cfg.database) {
    console.error(
      "Missing DB_* in .env — need DB_SERVER, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME"
    );
    process.exit(1);
  }

  console.log(
    `Connecting to ${cfg.server}:${cfg.port} / ${cfg.database} as ${cfg.user} ...`
  );

  try {
    const pool = await sql.connect(cfg);
    const r = await pool.request().query("SELECT 1 AS ok, DB_NAME() AS db_name");
    const row = r.recordset[0];
    console.log("OK — connected.");
    console.log("  ", row);
    await pool.close();
  } catch (err) {
    console.error("FAILED:", err.message || err);
    process.exit(1);
  }
}

main();
