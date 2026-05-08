/**
 * Read cached dataset rows from PostgreSQL (erp_mirror_snapshots).
 * Used when GET /api/dataset/:key?source=mirror and MIRROR_READ_ENABLED=1.
 */

const { Client } = require("pg");
const {
  getDatasetEntry,
  getFilterColumns,
  getFilterMatchMode,
  shouldSkipDateFilterWhenUnconfigured,
  sanitizeColumnName,
  isIsoDate,
  parseDatasetFilters,
} = require("./filter-query");

function getMirrorUrl() {
  const u = String(process.env.MIRROR_DATABASE_URL || "").trim();
  if (!u || u.includes("YOUR_PG_HOST")) {
    return "";
  }
  return u;
}

function isMirrorReadEnabled() {
  const v = String(process.env.MIRROR_READ_ENABLED || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function mirrorFallbackToLive() {
  const v = String(process.env.MIRROR_READ_FALLBACK_LIVE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

let mirrorClientPromise = null;

function getMirrorClient() {
  const url = getMirrorUrl();
  if (!url) {
    return null;
  }
  if (!mirrorClientPromise) {
    mirrorClientPromise = (async () => {
      const c = new Client({ connectionString: url });
      await c.connect();
      return c;
    })().catch((err) => {
      mirrorClientPromise = null;
      throw err;
    });
  }
  return mirrorClientPromise;
}

/** Normalize cell to yyyy-mm-dd for range compare, or null */
function cellToYmd(val) {
  if (val == null || val === "") {
    return null;
  }
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) {
    return m[1];
  }
  return null;
}

function cellToCompareString(val) {
  if (val == null) {
    return "";
  }
  return String(val).trim();
}

/**
 * @param {Array<object>} rows
 * @param {string} datasetKey
 * @param {number} limit
 * @param {object} query - req.query
 * @returns {{ rows: Array<object>, error?: { status: number, code: string, message: string } }}
 */
function cellMatchesStringFilter(cellVal, filterVal, mode) {
  const a = cellToCompareString(cellVal);
  const b = String(filterVal || "").trim();
  if (!b) {
    return true;
  }
  if (mode === "like") {
    return a.toLowerCase().indexOf(b.toLowerCase()) !== -1;
  }
  return a === b;
}

function filterMirrorRows(rows, datasetKey, limit, query) {
  const dk = String(datasetKey || "").toLowerCase().trim();
  const entry = getDatasetEntry(dk);
  const envPrefix = (entry && entry.filterPrefix) || "DATASET";
  const prefix = entry && entry.filterPrefix;
  const cfg = getFilterColumns(dk);
  const dateCol = sanitizeColumnName(cfg.date);
  const branchCol = sanitizeColumnName(cfg.branch);
  const statusCol = sanitizeColumnName(cfg.status);
  const deptCol = sanitizeColumnName(cfg.department);
  const catCol = sanitizeColumnName(cfg.category);
  const { from, to, branch, branches, status, department, category } = parseDatasetFilters(query, dk);

  if ((from && !to) || (!from && to)) {
    return {
      rows: [],
      error: {
        status: 400,
        code: "invalid_date_range",
        message: "from_and_to_must_be_used_together",
      },
    };
  }
  if (from && to) {
    if (!isIsoDate(from) || !isIsoDate(to)) {
      return {
        rows: [],
        error: {
          status: 400,
          code: "invalid_date_format",
          message: "from_and_to_must_be_YMD",
        },
      };
    }
    if (!dateCol) {
      if (!shouldSkipDateFilterWhenUnconfigured(dk)) {
        return {
          rows: [],
          error: {
            status: 400,
            code: "date_filter_not_configured",
            message: `Set ${envPrefix}_FILTER_DATE_COLUMN in server env (column must exist on this view)`,
          },
        };
      }
    }
  }
  if (branch) {
    if (!branchCol) {
      return {
        rows: [],
        error: {
          status: 400,
          code: "branch_filter_not_configured",
          message: "branch_filter_not_configured",
        },
      };
    }
  }
  if (status) {
    if (!statusCol) {
      return {
        rows: [],
        error: {
          status: 400,
          code: "status_filter_not_configured",
          message: "status_filter_not_configured",
        },
      };
    }
  }
  if (department) {
    if (!deptCol) {
      return {
        rows: [],
        error: {
          status: 400,
          code: "department_filter_not_configured",
          message: "department_filter_not_configured",
        },
      };
    }
  }
  if (category) {
    if (!catCol) {
      return {
        rows: [],
        error: {
          status: 400,
          code: "category_filter_not_configured",
          message: "category_filter_not_configured",
        },
      };
    }
  }

  const branchMode = prefix ? getFilterMatchMode(prefix, "BRANCH") : "equal";
  const deptMode = prefix ? getFilterMatchMode(prefix, "DEPARTMENT") : "equal";
  const catMode = prefix ? getFilterMatchMode(prefix, "CATEGORY") : "equal";

  let out = rows.slice();
  if (from && to && dateCol) {
    out = out.filter((row) => {
      const ymd = cellToYmd(row[dateCol]);
      if (!ymd) {
        return false;
      }
      return ymd >= from && ymd <= to;
    });
  }
  if (branches.length > 0 && branchCol) {
    if (branchMode === "like" && branches.length === 1) {
      out = out.filter((row) => cellMatchesStringFilter(row[branchCol], branch, branchMode));
    } else {
      const selected = new Set(branches.map((v) => String(v)));
      out = out.filter((row) => selected.has(cellToCompareString(row[branchCol])));
    }
  }
  if (status && statusCol) {
    out = out.filter((row) => cellToCompareString(row[statusCol]) === status);
  }
  if (department && deptCol) {
    out = out.filter((row) => cellMatchesStringFilter(row[deptCol], department, deptMode));
  }
  if (category && catCol) {
    out = out.filter((row) => cellMatchesStringFilter(row[catCol], category, catMode));
  }

  // Match live SQL semantics: ORDER BY configured date DESC, then TOP — keeps newest-first.
  if (dateCol && out.length > 1) {
    out.sort((a, b) => {
      const ya = cellToYmd(a[dateCol]);
      const yb = cellToYmd(b[dateCol]);
      if (ya && yb && ya !== yb) return yb.localeCompare(ya);
      if (ya && !yb) return -1;
      if (!ya && yb) return 1;
      const ta =
        a[dateCol] instanceof Date ? a[dateCol].getTime() : Number.NaN;
      const tb =
        b[dateCol] instanceof Date ? b[dateCol].getTime() : Number.NaN;
      if (Number.isFinite(ta) && Number.isFinite(tb) && tb !== ta) return tb - ta;
      return 0;
    });
  }

  const hardCapRaw = parseInt(process.env.DATASET_HARD_CAP || "20000", 10);
  const hardCap = Number.isFinite(hardCapRaw) ? Math.max(hardCapRaw, 500) : 20000;
  const cap = Math.min(Math.max(parseInt(String(limit), 10) || 10, 1), hardCap);
  out = out.slice(0, cap);
  return { rows: out };
}

async function loadMirrorSnapshotRows(datasetKey) {
  const p = getMirrorClient();
  if (!p) {
    return null;
  }
  const client = await p;
  const key = String(datasetKey || "").toLowerCase().trim();
  const r = await client.query(
    `SELECT payload, row_count, synced_at FROM erp_mirror_snapshots WHERE dataset_key = $1`,
    [key]
  );
  if (!r.rows.length) {
    return { rows: [], syncedAt: null, storedRowCount: 0 };
  }
  const row = r.rows[0];
  const payload = row.payload;
  const arr = Array.isArray(payload) ? payload : [];
  return {
    rows: arr,
    syncedAt: row.synced_at,
    storedRowCount: row.row_count,
  };
}

async function listMirrorSnapshotMeta() {
  const p = getMirrorClient();
  if (!p) {
    return [];
  }
  const client = await p;
  const r = await client.query(
    `SELECT dataset_key, row_count, synced_at FROM erp_mirror_snapshots ORDER BY dataset_key`
  );
  return r.rows.map((x) => ({
    datasetKey: x.dataset_key,
    rowCount: x.row_count,
    syncedAt: x.synced_at,
  }));
}

module.exports = {
  getMirrorUrl,
  isMirrorReadEnabled,
  mirrorFallbackToLive,
  getMirrorClient,
  loadMirrorSnapshotRows,
  listMirrorSnapshotMeta,
  filterMirrorRows,
};
