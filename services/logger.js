/**
 * Structured logging for production (JSON lines) or human-readable dev.
 * Set PRODUCTION_LOG_JSON=1 for one-JSON-object-per-line ingestion (Datadog, ELK, CloudWatch).
 */
"use strict";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function minLevel() {
  const raw = String(process.env.LOG_LEVEL || "info").trim().toLowerCase();
  return LEVELS[raw] != null ? LEVELS[raw] : LEVELS.info;
}

function jsonMode() {
  const j = String(process.env.PRODUCTION_LOG_JSON || "").trim();
  if (j === "0" || j === "false") return false;
  if (j === "1" || j === "true") return true;
  return String(process.env.NODE_ENV || "").trim() === "production";
}

function write(level, event, fields) {
  if (LEVELS[level] > minLevel()) return;
  const row = {
    ts: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
    ...(fields && typeof fields === "object" ? fields : {}),
  };
  if (jsonMode()) {
    console.log(JSON.stringify(row));
  } else if (fields && Object.keys(fields).length) {
    console.log(`[${level}] ${event}`, fields);
  } else {
    console.log(`[${level}] ${event}`);
  }
}

/** @type {{ log: typeof write, info: (e:string,f?:object)=>void, warn: ..., error: ..., debug: ... }} */
const logger = {
  log: write,
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
  debug: (event, fields) => write("debug", event, fields),
};

module.exports = { logger, jsonMode };
