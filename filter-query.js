/**
 * Shared dataset filter parsing for SQL Server (index.js) and PostgreSQL mirror (mirror-read.js).
 * Env per filterPrefix: {P}_FILTER_DATE_COLUMN, _BRANCH_, _STATUS_, _DEPARTMENT_, _CATEGORY_
 * Optional match mode: {P}_FILTER_BRANCH_MATCH=like|equal (same for DEPARTMENT, CATEGORY)
 */

const { DATASET_REGISTRY } = require("./datasets-registry");

/** Legacy UI / bookmarks — map table short names → registry keys. */
const DATASET_KEY_ALIASES = {
  mstsalesperson: "vw_ai_salesperson",
  mststockunit: "stock",
  vstocksalesperson: "vw_ai_salesperson",
  mb_powerbi_app_report: "sales",
  vw_mb_powerbi_app_report: "sales",
  vw_mb_powerbi_sls_report: "mb_powerbi_sls_report",
  vw_mb_powerbi_slsxns_report: "mb_powerbi_slsxns_report",
};

function normalizeDatasetKey(datasetKey) {
  const n = String(datasetKey || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/^dbo\./, "");
  return DATASET_KEY_ALIASES[n] || n;
}

function sanitizeColumnName(raw) {
  const s = String(raw || "").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(s)) {
    return null;
  }
  return s;
}

function getDatasetEntry(datasetKey) {
  const n = normalizeDatasetKey(datasetKey);
  return DATASET_REGISTRY.find((r) => r.key === n) || null;
}

/** Master / snapshot datasets: ?from/&to/&fy are ignored (no error) when no date column is configured in env. */
function shouldSkipDateFilterWhenUnconfigured(datasetKey) {
  const e = getDatasetEntry(datasetKey);
  return Boolean(e && e.skipDateParamsIfNoColumn);
}

function getFilterColumns(datasetKey) {
  const e = getDatasetEntry(datasetKey);
  const p = e && e.filterPrefix;
  if (!p) {
    return { date: "", branch: "", status: "", department: "", category: "" };
  }
  if (e.ignoreEnvDateColumn) {
    return {
      date: "",
      branch: process.env[`${p}_FILTER_BRANCH_COLUMN`] || "",
      status: process.env[`${p}_FILTER_STATUS_COLUMN`] || "",
      department: process.env[`${p}_FILTER_DEPARTMENT_COLUMN`] || "",
      category: process.env[`${p}_FILTER_CATEGORY_COLUMN`] || "",
    };
  }
  return {
    date:
      process.env[`${p}_FILTER_DATE_COLUMN`] ||
      (e && e.defaultDateColumn ? String(e.defaultDateColumn).trim() : "") ||
      "",
    branch: process.env[`${p}_FILTER_BRANCH_COLUMN`] || "",
    status: process.env[`${p}_FILTER_STATUS_COLUMN`] || "",
    department: process.env[`${p}_FILTER_DEPARTMENT_COLUMN`] || "",
    category: process.env[`${p}_FILTER_CATEGORY_COLUMN`] || "",
  };
}

/** equal | like — like = SQL LIKE %value% with ESCAPE */
function getFilterMatchMode(prefix, role) {
  const key = `${prefix}_FILTER_${role}_MATCH`;
  const v = String(process.env[key] || "equal").trim().toLowerCase();
  if (v === "like" || v === "contains" || v === "partial") {
    return "like";
  }
  return "equal";
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());
}

/**
 * Accept yyyy-mm-dd, dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy (European day-first).
 * @returns {string} yyyy-mm-dd or "" if empty/invalid
 */
function normalizeApiDate(raw) {
  const t = String(raw == null ? "" : raw).trim();
  if (!t) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return t;
  }
  const dmy = t.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (dmy) {
    const dd = dmy[1].padStart(2, "0");
    const mm = dmy[2].padStart(2, "0");
    const yyyy = dmy[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  const dmyDash = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmyDash) {
    const dd = dmyDash[1].padStart(2, "0");
    const mm = dmyDash[2].padStart(2, "0");
    const yyyy = dmyDash[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  return "";
}

/**
 * India-style financial year ending March: FY26 → 2025-04-01 .. 2026-03-31.
 * Accepts "FY26", "26", "2026" (ending calendar year).
 */
function financialYearToIsoRange(fyRaw) {
  let s = String(fyRaw || "").trim().toUpperCase().replace(/^FY\s*/, "");
  if (!s) {
    return null;
  }
  const num = parseInt(s, 10);
  if (!Number.isFinite(num)) {
    return null;
  }
  let endYear;
  if (num >= 1900 && num <= 2100) {
    endYear = num;
  } else if (num >= 0 && num <= 99) {
    endYear = 2000 + num;
  } else {
    return null;
  }
  const startYear = endYear - 1;
  return { from: `${startYear}-04-01`, to: `${endYear}-03-31` };
}

function buildLikePattern(userValue) {
  const esc = String(userValue).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return `%${esc}%`;
}

/**
 * @param {object} query - req.query
 * @param {string} datasetKey
 * @returns {{ from: string, to: string, branch: string, branches: string[], status: string, department: string, category: string, fy: string }}
 */
function parseDatasetFilters(query, datasetKey) {
  let from = normalizeApiDate(query.from);
  let to = normalizeApiDate(query.to);
  const branchRaw = query.branch;
  const branchValues = Array.isArray(branchRaw)
    ? branchRaw
    : (branchRaw == null ? [] : String(branchRaw).split(","));
  const branches = branchValues
    .map((v) => String(v == null ? "" : v).trim())
    .filter(Boolean);
  const branch = branches[0] || "";
  const status = query.status == null ? "" : String(query.status).trim();
  const department = query.department == null ? "" : String(query.department).trim();
  const category = query.category == null ? "" : String(query.category).trim();
  const fy = query.fy == null ? "" : String(query.fy).trim();

  const hasPartialRange = (from && !to) || (!from && to);
  if (!hasPartialRange && (!from || !to) && fy) {
    const r = financialYearToIsoRange(fy);
    if (r) {
      from = r.from;
      to = r.to;
    }
  }

  return { from, to, branch, branches, status, department, category, fy };
}

/** SQL snippet: newest-first ordering for SELECT TOP dumps when `{PREFIX}_FILTER_DATE_COLUMN` is set. */
function datasetDateOrderByDescSql(datasetKey) {
  const col = sanitizeColumnName(getFilterColumns(datasetKey).date);
  if (!col) return "";
  // Match WHERE … CAST([col] AS DATE) — avoids wrong lexicographic order if the column is string,
  // and aligns calendar-day ordering with the date filter.
  return ` ORDER BY CAST([${col}] AS date) DESC`;
}

module.exports = {
  DATASET_KEY_ALIASES,
  normalizeDatasetKey,
  getDatasetEntry,
  getFilterColumns,
  getFilterMatchMode,
  shouldSkipDateFilterWhenUnconfigured,
  sanitizeColumnName,
  isIsoDate,
  normalizeApiDate,
  financialYearToIsoRange,
  buildLikePattern,
  parseDatasetFilters,
  datasetDateOrderByDescSql,
};
