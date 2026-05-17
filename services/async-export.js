/**
 * Background CSV export for large raw extracts (never through LLM/chat payload).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { finalizeGeneratedSelectSql, buildAiValidationContext } = require("../ai-sql");
const { exportMaxRows, validatePerformanceShape } = require("./query-performance");

const EXPORT_DIR = path.join(__dirname, "../exports");
const jobs = new Map();

function ensureExportDir() {
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

function newJobId() {
  return `exp_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function escapeCsv(val) {
  if (val == null) return "";
  const s = String(val);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Strip TOP for export pagination — caller adds FETCH.
 */
function sqlWithoutTop(sql) {
  return String(sql || "")
    .replace(/^\s*SELECT\s+TOP\s*\(\s*\d+\s*\)\s+/i, "SELECT ")
    .replace(/^\s*SELECT\s+TOP\s+\d+\s+/i, "SELECT ");
}

function getJob(jobId) {
  return jobs.get(String(jobId || "")) || null;
}

/**
 * Queue validated SELECT for background CSV write.
 * @param {{ pool, sql, question, userId? }} opts
 */
function queueExportJob(opts) {
  const { pool, sql, question, userId } = opts;
  const id = newJobId();
  const job = {
    id,
    status: "queued",
    question: String(question || "").slice(0, 500),
    sql: String(sql || "").slice(0, 8000),
    userId: userId || null,
    rowCount: 0,
    maxRows: exportMaxRows(),
    filePath: null,
    downloadUrl: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(id, job);

  setImmediate(() => {
    runExportJob(pool, job).catch((e) => {
      job.status = "failed";
      job.error = e.message;
      job.finishedAt = new Date().toISOString();
    });
  });

  return { jobId: id, status: "queued", maxRows: job.maxRows };
}

async function runExportJob(pool, job) {
  job.status = "running";
  ensureExportDir();

  const ctx = buildAiValidationContext({ domain: "generic" });
  let execSql;
  try {
    validatePerformanceShape(job.sql, job.question, { allowRawExport: true });
    execSql = finalizeGeneratedSelectSql(job.sql, { ...ctx, question: job.question });
  } catch (e) {
    job.status = "failed";
    job.error = e.message;
    job.finishedAt = new Date().toISOString();
    return;
  }

  const baseSql = sqlWithoutTop(execSql);
  const filename = `${job.id}.csv`;
  const filePath = path.join(EXPORT_DIR, filename);
  const pageSize = Math.min(5000, parseInt(process.env.EXPORT_PAGE_SIZE || "5000", 10) || 5000);
  const timeoutMs = parseInt(process.env.EXPORT_DB_TIMEOUT_MS || "600000", 10) || 600000;

  let offset = 0;
  let total = 0;
  let headersWritten = false;
  const stream = fs.createWriteStream(filePath, { encoding: "utf8" });

  try {
    while (total < job.maxRows) {
      const fetch = Math.min(pageSize, job.maxRows - total);
      const pageSql =
        `${baseSql.replace(/;\s*$/g, "")} ` +
        `ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${fetch} ROWS ONLY`;

      const req = pool.request();
      req.timeout = timeoutMs;
      const result = await req.query(pageSql);
      const rows = result.recordset || [];
      if (!rows.length) break;

      if (!headersWritten) {
        const headers = Object.keys(rows[0]);
        stream.write(headers.map(escapeCsv).join(",") + "\n");
        headersWritten = true;
      }
      for (const row of rows) {
        stream.write(
          Object.keys(rows[0])
            .map((h) => escapeCsv(row[h]))
            .join(",") + "\n"
        );
        total++;
        if (total >= job.maxRows) break;
      }
      if (rows.length < fetch) break;
      offset += rows.length;
    }

    await new Promise((resolve, reject) => {
      stream.end(() => resolve());
      stream.on("error", reject);
    });

    job.status = "completed";
    job.rowCount = total;
    job.filePath = filePath;
    job.downloadUrl = `/api/query/export-async/${job.id}/download`;
    job.finishedAt = new Date().toISOString();
  } catch (e) {
    try {
      stream.destroy();
    } catch (_) {
      /* ignore */
    }
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {
      /* ignore */
    }
    job.status = "failed";
    job.error = String(e.message || e);
    job.finishedAt = new Date().toISOString();
  }
}

function pruneOldJobs(maxAgeMs = 3600000) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - new Date(job.finishedAt).getTime() > maxAgeMs) {
      if (job.filePath && fs.existsSync(job.filePath)) {
        try {
          fs.unlinkSync(job.filePath);
        } catch (_) {
          /* ignore */
        }
      }
      jobs.delete(id);
    }
  }
}

setInterval(() => pruneOldJobs(), 600000).unref();

module.exports = {
  queueExportJob,
  getJob,
  EXPORT_DIR,
};
