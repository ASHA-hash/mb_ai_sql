/**
 * Parameterized WHERE fragments for dataset queries (shared by index.js and analytics engine).
 */
"use strict";

const sql = require("mssql");
const {
  getDatasetEntry,
  getFilterColumns,
  getFilterMatchMode,
  shouldSkipDateFilterWhenUnconfigured,
  sanitizeColumnName,
  isIsoDate,
  parseDatasetFilters,
  buildLikePattern,
} = require("../filter-query");

/**
 * @param {import("mssql").Request} request
 * @param {string} datasetKey
 * @param {Record<string, unknown>} query - req.query-style
 * @returns {{ whereParts: string[], entry: object|null }}
 * @throws {Error & { status?: number, code?: string }}
 */
function appendDatasetFilterWhere(request, datasetKey, query) {
  const dk = String(datasetKey || "").toLowerCase().trim();
  const entry = getDatasetEntry(dk);
  const prefix = entry && entry.filterPrefix;
  const envPrefix = (entry && entry.filterPrefix) || "DATASET";

  const cfg = getFilterColumns(dk);
  const dateCol = sanitizeColumnName(cfg.date);
  const branchCol = sanitizeColumnName(cfg.branch);
  const statusCol = sanitizeColumnName(cfg.status);
  const deptCol = sanitizeColumnName(cfg.department);
  const catCol = sanitizeColumnName(cfg.category);

  const { from, to, branch, branches, status, department, category } = parseDatasetFilters(query, dk);

  if ((from && !to) || (!from && to)) {
    const e = new Error("from_and_to_must_be_used_together");
    e.status = 400;
    e.code = "invalid_date_range";
    throw e;
  }
  if (from && to) {
    if (!isIsoDate(from) || !isIsoDate(to)) {
      const e = new Error("from_and_to_must_be_YMD_or_dd_mm_yyyy");
      e.status = 400;
      e.code = "invalid_date_format";
      throw e;
    }
    if (!dateCol) {
      if (!shouldSkipDateFilterWhenUnconfigured(dk)) {
        const e = new Error(
          `Set ${envPrefix}_FILTER_DATE_COLUMN in server env (column must exist on this view)`
        );
        e.status = 400;
        e.code = "date_filter_not_configured";
        throw e;
      }
    }
  }

  if (branch) {
    if (!branchCol) {
      const e = new Error("branch_filter_not_configured");
      e.status = 400;
      e.code = "branch_filter_not_configured";
      throw e;
    }
  }
  if (status) {
    if (!statusCol) {
      const e = new Error("status_filter_not_configured");
      e.status = 400;
      e.code = "status_filter_not_configured";
      throw e;
    }
  }
  if (department) {
    if (!deptCol) {
      const e = new Error("department_filter_not_configured");
      e.status = 400;
      e.code = "department_filter_not_configured";
      throw e;
    }
  }
  if (category) {
    if (!catCol) {
      const e = new Error("category_filter_not_configured");
      e.status = 400;
      e.code = "category_filter_not_configured";
      throw e;
    }
  }

  const whereParts = [];
  if (from && to && dateCol) {
    request.input("from", sql.VarChar(10), from);
    request.input("to", sql.VarChar(10), to);
    whereParts.push(`CAST([${dateCol}] AS DATE) BETWEEN CAST(@from AS DATE) AND CAST(@to AS DATE)`);
  }
  if (branches.length > 0 && branchCol) {
    const bMode = prefix ? getFilterMatchMode(prefix, "BRANCH") : "equal";
    if (bMode === "like" && branches.length === 1) {
      request.input("branchLike", sql.NVarChar(4000), buildLikePattern(branches[0]));
      whereParts.push(`CAST([${branchCol}] AS NVARCHAR(4000)) LIKE @branchLike ESCAPE '\\'`);
    } else if (branches.length === 1) {
      request.input("branch", sql.NVarChar(4000), branches[0]);
      whereParts.push(`CAST([${branchCol}] AS NVARCHAR(4000)) = @branch`);
    } else {
      const branchPlaceholders = branches.map((b, i) => {
        const key = `branch_${i}`;
        request.input(key, sql.NVarChar(4000), b);
        return `@${key}`;
      });
      whereParts.push(`CAST([${branchCol}] AS NVARCHAR(4000)) IN (${branchPlaceholders.join(", ")})`);
    }
  }
  if (status && statusCol) {
    request.input("status", sql.NVarChar(4000), status);
    whereParts.push(`CAST([${statusCol}] AS NVARCHAR(4000)) = @status`);
  }
  if (department && deptCol) {
    const dMode = prefix ? getFilterMatchMode(prefix, "DEPARTMENT") : "equal";
    if (dMode === "like") {
      request.input("deptLike", sql.NVarChar(4000), buildLikePattern(department));
      whereParts.push(`CAST([${deptCol}] AS NVARCHAR(4000)) LIKE @deptLike ESCAPE '\\'`);
    } else {
      request.input("department", sql.NVarChar(4000), department);
      whereParts.push(`CAST([${deptCol}] AS NVARCHAR(4000)) = @department`);
    }
  }
  if (category && catCol) {
    const cMode = prefix ? getFilterMatchMode(prefix, "CATEGORY") : "equal";
    if (cMode === "like") {
      request.input("catLike", sql.NVarChar(4000), buildLikePattern(category));
      whereParts.push(`CAST([${catCol}] AS NVARCHAR(4000)) LIKE @catLike ESCAPE '\\'`);
    } else {
      request.input("category", sql.NVarChar(4000), category);
      whereParts.push(`CAST([${catCol}] AS NVARCHAR(4000)) = @category`);
    }
  }

  return { whereParts, entry, dateCol, branchCol, deptCol, catCol };
}

module.exports = {
  appendDatasetFilterWhere,
};
