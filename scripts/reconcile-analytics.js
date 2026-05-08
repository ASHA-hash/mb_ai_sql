/**
 * Periodic reconciliation: run analytics dashboard payloads and exit non-zero on mismatch.
 *
 *   node scripts/reconcile-analytics.js [period]
 *   RECON_PERIODS=mtd,qtd node scripts/reconcile-analytics.js
 *
 * Uses DB_* from .env (same as the API). Cron (twice hourly): minute 0 and 30 with full path to node.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const sql = require("mssql");
const { runAnalyticsDashboard } = require("../services/analytics-dashboard");

function envTrim(key) {
  const v = process.env[key];
  if (v == null) return undefined;
  return String(v).trim();
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
      requestTimeout: parseInt(envTrim("DB_REQUEST_TIMEOUT_MS") || "120000", 10),
      connectTimeout: parseInt(envTrim("DB_CONNECT_TIMEOUT_MS") || "60000", 10),
    },
  };
}

function summarize(out) {
  const q = out && out.quality && out.quality.reconciliation;
  if (!q) return { ok: true, note: "no_reconciliation_block" };
  if (q.error) return { ok: false, reason: "reconciliation_error", detail: q.message };
  if (q.mismatch) return { ok: false, reason: "mismatch", detail: q };
  return { ok: true, skipped: q.skipped, compared: q.compared };
}

async function main() {
  const cfg = getConfig();
  if (!cfg.server || !cfg.user || cfg.password == null || !cfg.database) {
    console.error("Missing DB_* — need DB_SERVER, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME");
    process.exit(2);
  }

  const multi = String(process.env.RECON_PERIODS || "").trim();
  const argvPeriod = process.argv[2] ? String(process.argv[2]).trim() : "";
  const periods = multi
    ? multi.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)
    : argvPeriod
      ? [argvPeriod]
      : ["mtd"];

  const pool = await sql.connect(cfg);
  let bad = false;
  try {
    for (const period of periods) {
      const out = await runAnalyticsDashboard(pool, {
        dataset: "sales",
        period,
      });
      const s = summarize(out);
      const line = `[reconcile] period=${period} composite=${out.quality && out.quality.compositeFingerprint ? out.quality.compositeFingerprint.slice(0, 12) : "—"}`;
      if (!s.ok) {
        console.error(line, "FAIL", s.reason, s.detail != null ? JSON.stringify(s.detail).slice(0, 500) : "");
        bad = true;
      } else {
        console.log(line, "OK", s.skipped ? `(skipped ${s.compared || ""})` : "");
      }
    }
  } finally {
    await pool.close();
  }
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error("[reconcile]", e);
  process.exit(1);
});
