const { useState, useEffect, useRef, useCallback, useMemo } = React;

/* ═══════════════════════════════════════════════
   CONFIGURATION
═══════════════════════════════════════════════ */
/** When dashboard is opened from localhost, default API is same-origin (not legacy Render deploy). Override in Settings anytime. */
const DEFAULT_API =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? `${window.location.protocol}//${window.location.host}`
    : "https://mb-ai-sql-v8wk.onrender.com";
function getApiBase() { return (localStorage.getItem("erp_api_base") || DEFAULT_API).replace(/\/+$/, ""); }
function getApiKey()  { return String(localStorage.getItem("erp_api_key") || "").trim(); }

/* ═══════════════════════════════════════════════════════════════════
   GOOGLE DRIVE — per-user OAuth (saves to the LOGGED-IN user's Drive)
   ─────────────────────────────────────────────────────────────────
   HOW IT WORKS:
   • Developer registers ONE Google OAuth Web Client in Google Cloud Console (same Client ID as DEFAULT_DRIVE_CLIENT_ID in this file).
   • When any Manager/Viewer clicks "☁ Drive", a Google popup appears
     asking them to sign into THEIR OWN Google account.
   • The file uploads directly to THEIR personal Google Drive.
   • The Client ID is NOT a secret — it is safe to embed in the page.
   ─────────────────────────────────────────────────────────────────
   ADMIN ONE-TIME SETUP:
   1. console.cloud.google.com → APIs & Services → Enable "Google Drive API"
   2. APIs & Services → Credentials → Create Credential → OAuth 2.0 Client ID
      • Application type: Web application
      • Authorised JavaScript origins:  https://mb-ai-sql-v8wk.onrender.com
        (add localhost:3000 too if testing locally)
      • Authorised redirect URIs: add postmessage + your site URL (see Settings checklist)
   3. That Web client's ID must match DEFAULT_DRIVE_CLIENT_ID in this file.
═══════════════════════════════════════════════════════════════════ */

const DRIVE_FOLDER_ID_KEY = "erp_drive_folder_id";
const DRIVE_TOKEN_KEY     = "erp_drive_token_v2";

/** Production OAuth Web Client ID — fixed in code (no localStorage override). */
const DEFAULT_DRIVE_CLIENT_ID = "243860626444-u5749q82a7ue5dtckmqptiu8ov9qjnok.apps.googleusercontent.com";

/** Shown in OAuth error hints — must match an Authorised JavaScript origin in Cloud Console. */
const DRIVE_OAUTH_PRIMARY_ORIGIN = "https://smarterpconnector.in";

function driveOAuthConsoleHintHtml() {
  const o = typeof window !== "undefined" ? window.location.origin : DRIVE_OAUTH_PRIMARY_ORIGIN;
  const page =
    typeof window !== "undefined" && window.location.href
      ? window.location.href.replace(/#.*$/, "")
      : o + "/dashboard.html";
  return (
    "Google Cloud Console → Credentials (or Google Auth Platform → Clients) → this Web client ID:\n\n" +
    "1) Authorised JavaScript origins — must include exactly:\n   " + o + "\n\n" +
    "2) Authorised redirect URIs — add EACH as its own row (Google is strict; copy/paste):\n" +
    "   postmessage\n" +
    "   " + o + "\n" +
    "   " + o + "/\n" +
    "   " + page + "\n\n" +
    "3) OAuth consent screen → Authorised domains → add: onrender.com (required for apps on Render).\n\n" +
    "4) Save, wait 5–15 minutes, try again in a private window.\n\n" +
    "If it still fails: on the Google error page click \"Error details\" and find redirect_uri=... in the URL — " +
    "add that EXACT value as another Authorised redirect URI."
  );
}

function getDriveClientId() {
  return DEFAULT_DRIVE_CLIENT_ID;
}
function getDriveFolderId() { return String(localStorage.getItem(DRIVE_FOLDER_ID_KEY) || "").trim(); }

function _loadDriveToken() {
  try { return JSON.parse(sessionStorage.getItem(DRIVE_TOKEN_KEY) || "null"); } catch { return null; }
}
function _saveDriveToken(t) { sessionStorage.setItem(DRIVE_TOKEN_KEY, JSON.stringify(t)); }
function _clearDriveToken() { sessionStorage.removeItem(DRIVE_TOKEN_KEY); }
function _isDriveTokenValid(t) {
  if (!t?.access_token) return false;
  return Date.now() < Number(t.expires_at || 0) - 30_000;
}

/**
 * Returns a valid Google OAuth access token for the current user.
 * Opens a Google sign-in popup if needed (first time or token expired).
 * Uses DEFAULT_DRIVE_CLIENT_ID (must match Google Cloud Web client).
 */
async function getDriveAccessToken() {
  const existing = _loadDriveToken();
  if (_isDriveTokenValid(existing)) return existing.access_token;

  const clientId = getDriveClientId();

  const gis = window.google?.accounts?.oauth2;
  if (!gis) throw new Error("Google Identity Services failed to load. Please refresh.");

  return new Promise((resolve, reject) => {
    const client = gis.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/drive.file",
      error_callback: (err) => {
        console.error("[Drive OAuth] GIS error:", err);
      },
      callback: (resp) => {
        if (!resp || resp.error) {
          const code = resp?.error;
          let msg = resp?.error_description || resp?.error || "Google sign-in was cancelled or failed.";
          if (code === "redirect_uri_mismatch" || /redirect_uri/i.test(String(msg))) {
            msg = "Error 400: redirect_uri_mismatch\n\n" + driveOAuthConsoleHintHtml();
          }
          return reject(new Error(msg));
        }
        const expiresAt = Date.now() + (Number(resp.expires_in || 3600) * 1000);
        _saveDriveToken({ access_token: resp.access_token, expires_at: expiresAt });
        resolve(resp.access_token);
      },
    });
    // prompt: "" = only shows consent if not already granted; "consent" = always show
    client.requestAccessToken({ prompt: "" });
  });
}

/**
 * Upload a Blob directly to the signed-in user's Google Drive.
 * folderId = optional Drive folder ID to put the file in.
 */
async function uploadBlobToDrive({ blob, filename, mimeType, folderId }) {
  const accessToken = await getDriveAccessToken();
  const parent = String(folderId || getDriveFolderId() || "").trim();
  const meta = { name: filename };
  if (parent) meta.parents = [parent];

  const boundary = "erp_boundary_xyz987";
  const CRLF = "\r\n";
  const metaStr = JSON.stringify(meta);

  // Build multipart body
  const enc = new TextEncoder();
  const parts = [
    enc.encode(`--${boundary}${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}${metaStr}${CRLF}`),
    enc.encode(`--${boundary}${CRLF}Content-Type: ${mimeType}${CRLF}${CRLF}`),
    new Uint8Array(await blob.arrayBuffer()),
    enc.encode(`${CRLF}--${boundary}--`),
  ];
  const totalLen = parts.reduce((s, p) => s + p.byteLength, 0);
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { body.set(p, offset); offset += p.byteLength; }

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Token may have been revoked — clear it so next click re-authenticates
    if (res.status === 401) _clearDriveToken();
    throw new Error(data?.error?.message || `Drive upload failed (${res.status})`);
  }
  return data; // { id, name, webViewLink }
}


const CHART_COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6'];
const KPI_GRADIENTS = ['kpi-purple','kpi-purple','kpi-purple','kpi-purple'];

/**
 * AI_SUGGESTIONS — static fallback chips shown before the server responds.
 * The AI Query panel fetches /api/ai/suggestions on mount and replaces these
 * with live RAG-backed suggestions that improve as users verify queries.
 */
const AI_SUGGESTIONS = [
  { q: "Top 10 branches by total gross revenue (MrpValue) this month", hint: "dbo.VW_MB_POWERBI_APP_REPORT" },
  { q: "Top 10 salespersons by total sales (MrpValue) this month", hint: "dbo.VW_MB_POWERBI_APP_REPORT" },
  { q: "Top 10 product categories by total sales (MrpValue) this month", hint: "dbo.VW_MB_POWERBI_APP_REPORT" },
  { q: "Today's total gross revenue and number of bills", hint: "dbo.VW_MB_POWERBI_APP_REPORT" },
  { q: "Monthly sales trend for the last 6 months grouped by month", hint: "dbo.VW_MB_POWERBI_APP_REPORT" },
  { q: "Top 10 articles by quantity sold (AppQty) this month", hint: "dbo.VW_MB_POWERBI_APP_REPORT" },
  { q: "Top 10 departments by gross revenue (MrpValue) this month", hint: "dbo.VW_MB_POWERBI_APP_REPORT" },
  { q: "Top 10 vendors by purchase amount this month", hint: "dbo.VW_MB_POWERBI_PUR_REPORT" },
  { q: "Compare this month vs last month gross revenue by branch", hint: "dbo.VW_MB_POWERBI_APP_REPORT" },
  { q: "Top 20 highest selling articles all time by total MrpValue", hint: "dbo.VW_MB_POWERBI_APP_REPORT" },
];

/**
 * useDynamicSuggestions — fetches live suggestions from /api/ai/suggestions.
 * Falls back to AI_SUGGESTIONS on error or if server returns < 3 items.
 * @param {string|null} token - auth token
 * @returns {{ suggestions: Array<{q:string, hint?:string}>, loading: boolean }}
 */
function useDynamicSuggestions(token) {
  const [suggestions, setSuggestions] = React.useState(AI_SUGGESTIONS);
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch('/api/ai/suggestions', { token })
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.suggestions) && data.suggestions.length >= 3
          ? data.suggestions
          : AI_SUGGESTIONS;
        setSuggestions(list);
      })
      .catch(() => { /* keep fallback */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);
  return { suggestions, loading };
}

const ROLE_COLORS = {
  admin:   "bg-red-500/15 text-red-400",
  manager: "bg-indigo-500/15 text-indigo-400",
  viewer:  "bg-slate-500/15 text-slate-400",
};
const ROLE_COLORS_LIGHT = {
  admin:   "bg-red-50 text-red-700",
  manager: "bg-indigo-50 text-indigo-700",
  viewer:  "bg-slate-100 text-slate-600",
};

/* ═══════════════════════════════════════════════
   RESPONSIVE HOOK
═══════════════════════════════════════════════ */
function useBreakpoint() {
  const get = () => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
    return { mobile: w < 640, tablet: w >= 640 && w < 1024, desktop: w >= 1024 };
  };
  const [bp, setBp] = useState(get);
  useEffect(() => {
    const fn = () => setBp(get());
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return bp;
}

/* ═══════════════════════════════════════════════
   AUTH STORAGE
═══════════════════════════════════════════════ */
const AUTH_KEY = "erp_auth_v2";
function loadAuth() { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch { return null; } }
function saveAuth(a)  { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); }
function clearAuth()  { localStorage.removeItem(AUTH_KEY); }

/* ═══════════════════════════════════════════════
   API HELPER
═══════════════════════════════════════════════ */
/** Adaptive AI path (NL → LLM → validate → DB) can exceed 90s on slow models or repairs; keep client in sync with hosting limits. */
const AI_QUERY_CLIENT_TIMEOUT_MS = Math.min(
  600000,
  Math.max(120000, parseInt(String(typeof localStorage !== "undefined" ? localStorage.getItem("erp_ai_timeout_ms") : ""), 10) || 180000)
);

/** Deterministic analytics (QTD/YTD/custom) — overrides via localStorage `erp_analytics_timeout_ms`.
 *  Default raised to 600 s (10 min) so the client never gives up before the 8-min DB timeout. */
const ERP_ANALYTICS_TIMEOUT_MS = Math.min(
  720000,
  Math.max(
    180000,
    parseInt(String(typeof localStorage !== "undefined" ? localStorage.getItem("erp_analytics_timeout_ms") : ""), 10) || 600000
  )
);

/** Periods whose server query spans > 90 days — get an even longer client timeout. */
const ANALYTICS_HEAVY_PERIODS = new Set(["6m", "last_180d", "last_90d", "90d"]);
/** Timeout for heavy (90d / 180d / 6M) analytics requests — 660 s, above the 8-min DB ceiling. */
const ERP_ANALYTICS_HEAVY_TIMEOUT_MS = Math.min(
  780000,
  Math.max(ERP_ANALYTICS_TIMEOUT_MS, 660000)
);

/** Load Dataset tab — large views (SLS_REPORT, SLSXNS) need bounded client wait. */
const ERP_DATASET_TIMEOUT_MS = Math.min(
  600000,
  Math.max(120000, parseInt(String(typeof localStorage !== "undefined" ? localStorage.getItem("erp_dataset_timeout_ms") : ""), 10) || 300000)
);

const MONTH_SHORT_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function chartSeriesDisplayName(col) {
  const c = String(col || "");
  if (c === "TotalSales" || c === "SaleNetAmount") return "Current period";
  if (c === "PY_TotalSales" || c === "PY_SaleNetAmount") return "Same period last year";
  return c.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim();
}

/** X-axis label for month buckets when YoY bars are shown (avoids implying both bars are current year). */
function formatTrendChartBucketLabel(canonicalKey, hasPySeries) {
  const mo = /^(\d{4})-(\d{2})$/.exec(String(canonicalKey || ""));
  if (mo) {
    const monthName = MONTH_SHORT_EN[parseInt(mo[2], 10) - 1] || mo[2];
    return hasPySeries ? `${monthName} (CY vs LY)` : `${monthName} ${mo[1]}`;
  }
  return String(canonicalKey || "");
}

async function fetchSalesAnalyticsForPeriod({ token, period, fromDMY, toDMY, loadPhase, signal }) {
  const fromIso = dmyToISO(fromDMY);
  const toIso = dmyToISO(toDMY);
  const monthly = ["qtd", "ytd", "6m", "last_90d", "90d", "last_180d", "180d"].includes(String(period || ""));
  const body =
    fromIso && toIso
      ? {
          period: "custom",
          custom: { from: fromIso, to: toIso },
          dataset: "sales",
          loadPhase: loadPhase || "widgets",
          compact: true,
          ...(monthly ? { forceTrendGranularity: "month" } : {}),
        }
      : {
          period: period || "mtd",
          dataset: "sales",
          loadPhase: loadPhase || "widgets",
          compact: true,
          ...(monthly ? { forceTrendGranularity: "month" } : {}),
        };
  return apiFetch("/api/analytics/dashboard", {
    method: "POST",
    token,
    body,
    timeoutMs: ERP_ANALYTICS_TIMEOUT_MS,
    signal,
  });
}

async function apiFetch(path, { method = "GET", body, token, signal, timeoutMs = 0, returnHeaders = false } = {}) {
  const base = getApiBase();
  const headers = { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const k = getApiKey();
  if (k) headers["X-API-Key"] = k;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const ms = Math.max(0, Number(timeoutMs) || 0);
  let timer;
  const ctl = ms > 0 ? new AbortController() : null;
  if (ctl && ms > 0) {
    timer = setTimeout(() => {
      try {
        ctl.abort();
      } catch (_) {
        /* ignore */
      }
    }, ms);
  }
  if (signal && ctl) {
    if (signal.aborted) ctl.abort();
    else
      signal.addEventListener(
        "abort",
        () => {
          try {
            ctl.abort();
          } catch (_) {
            /* ignore */
          }
        },
        { once: true }
      );
  }
  opts.signal = ctl ? ctl.signal : signal;

  let res;
  try {
    res = await fetch(base + path, opts);
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e && e.name === "AbortError") {
      throw Object.assign(new Error(`Timeout: Request failed to complete in ${ms}ms`), {
        status: 408,
        name: "AbortError",
      });
    }
    throw e;
  }
  if (timer) clearTimeout(timer);
  let data;
  try {
    data = await res.json();
  } catch (_) {
    const text = await res.text().catch(() => "");
    const preview = text.slice(0, 300).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    data = { message: preview ? `Server error: ${preview}` : `HTTP ${res.status} (non-JSON response)` };
  }
  if (!res.ok) {
    const hadBearer = !!(token && String(token).trim());
    if (res.status === 401 && hadBearer) {
      const errCode = data && typeof data === "object" ? String(data.error || "") : "";
      const msg = data && typeof data === "object" ? String(data.message || "") : "";
      if (
        errCode === "invalid_token" ||
        /jwt|expired|invalid\s*token|log\s*in\s*again/i.test(msg) ||
        errCode === "token_expired"
      ) {
        try {
          window.dispatchEvent(
            new CustomEvent("erp-session-expired", { detail: { message: msg || "Session expired." } })
          );
        } catch (_) {
          /* ignore */
        }
      }
    }
    throw Object.assign(new Error(data.message || data.error || `HTTP ${res.status}`), { status: res.status, data });
  }
  if (returnHeaders) {
    return {
      data,
      headers: {
        rowLimit: res.headers.get("X-ERP-Row-Limit"),
        hardCap: res.headers.get("X-ERP-Hard-Cap"),
        rowCount: res.headers.get("X-ERP-Row-Count"),
        rowsCapped: res.headers.get("X-ERP-Rows-Capped") === "1",
      },
    };
  }
  return data;
}

/* ═══════════════════════════════════════════════
   CHART DETECTION ENGINE
═══════════════════════════════════════════════ */
const SALE_VALUE_DIVISOR = 1e5;

/**
 * Global column-tag map populated by the latest API response.
 * { colName: 'money'|'count'|'date'|'text'|'id'|'ratio'|'unknown' }
 * When present, all type-detection functions use this first.
 * Fallback to name-regex only when tag is absent.
 */
let _globalColTags = {};
function setGlobalColTags(tags) { _globalColTags = tags || {}; }
function getColTag(key) { return _globalColTags[key] || null; }

/** Master / dimension label columns — never currency KPIs (SalesPersonShortName is not revenue). */
function looksLikeDimensionLabelKey(key = '') {
  const k = String(key || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!k) return false;
  if (/(amount|qty|quantity|count|value|price|rate|limit|total|net|mrp|cost|revenue|turnover|metric)/.test(k)) return false;
  return (
    /^(salesperson|supplier|customer|branch|employee|staff|vendor|party|item|product|category|department)(name|shortname|alias|desc|description)?$/.test(k) ||
    /(person|supplier|customer|branch|item|product|category|department)(name|shortname|alias)$/.test(k) ||
    /^(name|shortname|alias|description|label)$/.test(k)
  );
}

const MASTER_REFERENCE_DATASET_KEYS = new Set([
  'vw_ai_salesperson', 'vw_ai_supplier', 'customers', 'branches',
  'vw_mst_items', 'vw_aimst_items', 'mb_powerbi_branch_list',
  'mb_powerbi_category_master', 'mb_powerbi_product_master', 'mb_powerbi_vendor_master',
]);

function isMasterReferenceDataset(datasetKey) {
  return MASTER_REFERENCE_DATASET_KEYS.has(String(datasetKey || '').toLowerCase().trim());
}

function isSaleValueKey(key = '') {
  const tag = getColTag(key);
  if (tag === 'money') return true;
  if (tag && tag !== 'unknown') return false;
  if (looksLikeDimensionLabelKey(key)) return false;
  const k = String(key || '').toLowerCase();
  /* Power BI APP_REPORT primary revenue — must not be blocked by generic "mrp" exclusion */
  if (/^(mrpvalue|metric_value|netslsnetamount|netamount|salenetamount|totalsales|totalrevenue|appnetvalue)$/.test(k)) {
    return true;
  }
  if (/^(itemmrp|mrp|stockmrp|cbsmrp|slsmrp|netmrp|purmrp)$/.test(k)) return false;
  return (
    /(sale|salenetamount|totalsales|salesamount|revenue|netamount|amount|value|turnover|metric)/.test(k) &&
    !/(qty|quantity|count|id|code|rate|price|discount|creditlimit|pct|percent|pincode|zip|ratio|stockqty|purqty|slsqty|costvalue|costprice)/.test(k)
  );
}

/** Canonical revenue / qty / label resolution (APP_REPORT + legacy API keys). */
const CANONICAL_REVENUE_FIELD_ORDER = [
  'MrpValue', 'metric_value', 'TotalSales', 'NetSlsNetAmount', 'SaleNetAmount', 'NetAmount',
  'SalesAmount', 'TotalSaleNetAmount', 'Amount', 'Revenue', 'Total', 'Value', 'TotalRevenue',
];
const CANONICAL_QTY_FIELD_ORDER = ['AppQty', 'NetSlsQty', 'SlsQty', 'Quantity', 'Qty', 'quantitySold'];
const CANONICAL_LABEL_FIELD_ORDER = [
  'BranchAlias', 'DepartmentShortName', 'CategoryShortName', 'Category', 'Department',
  'SupplierName', 'SupplierAlias', 'ArticleNo', 'XnDtMonth', 'period_label', 'label', 'Period',
];

function firstMatchingKey(row, candidates) {
  if (!row || typeof row !== 'object') return null;
  const keys = Object.keys(row);
  for (const name of candidates) {
    const hit = keys.find((k) => k.toLowerCase() === name.toLowerCase());
    if (hit && row[hit] != null && String(row[hit]).trim() !== '') return hit;
  }
  for (const name of candidates) {
    const hit = keys.find((k) => k.toLowerCase().includes(name.toLowerCase()));
    if (hit && row[hit] != null && String(row[hit]).trim() !== '') return hit;
  }
  return null;
}

function pickCanonicalRevenueKey(rows) {
  if (!rows?.length) return null;
  return firstMatchingKey(rows[0], CANONICAL_REVENUE_FIELD_ORDER)
    || Object.keys(rows[0]).find((k) => isSaleValueKey(k) && isNumericCol(rows, k))
    || null;
}

function pickCanonicalQtyKey(rows) {
  if (!rows?.length) return null;
  return firstMatchingKey(rows[0], CANONICAL_QTY_FIELD_ORDER)
    || Object.keys(rows[0]).find((k) => isCountKey(k) && isNumericCol(rows, k))
    || null;
}

function pickCanonicalLabelKey(rows, groupKey) {
  if (!rows?.length) return null;
  if (groupKey === 'branch') {
    return firstMatchingKey(rows[0], ['BranchAlias', 'BranchName', 'BranchShortName', 'label'])
      || pickAILabelCol(rows, 'branch');
  }
  if (groupKey === 'cat') {
    return firstMatchingKey(rows[0], ['CategoryShortName', 'CategoryName', 'Category', 'label'])
      || pickAILabelCol(rows, 'cat');
  }
  if (groupKey === 'dept') {
    return firstMatchingKey(rows[0], ['DepartmentShortName', 'Department', 'label'])
      || pickAILabelCol(rows, 'dept');
  }
  return firstMatchingKey(rows[0], CANONICAL_LABEL_FIELD_ORDER) || pickAILabelCol(rows, groupKey);
}

function readRevenueFromRow(row, revenueKey) {
  if (!row) return 0;
  const k = revenueKey || pickCanonicalRevenueKey([row]);
  if (k && row[k] != null) return parseFloat(row[k]) || 0;
  for (const name of CANONICAL_REVENUE_FIELD_ORDER) {
    const hit = Object.keys(row).find((x) => x.toLowerCase() === name.toLowerCase());
    if (hit != null && row[hit] != null) return parseFloat(row[hit]) || 0;
  }
  return 0;
}

function readQtyFromRow(row, qtyKey) {
  if (!row) return 0;
  const k = qtyKey || pickCanonicalQtyKey([row]);
  if (k && row[k] != null) return parseFloat(row[k]) || 0;
  return 0;
}

function readLabelFromRow(row, labelKey) {
  if (!row) return '';
  const k = labelKey || firstMatchingKey(row, CANONICAL_LABEL_FIELD_ORDER);
  if (k && row[k] != null) return String(row[k]);
  return 'Summary';
}

/** Normalize API rows for charts/KPIs — maps MrpValue/AppQty into chart-friendly SaleNetAmount slot. */
function normalizeAnalyticsChartRows(rows, groupKey) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const revKey = pickCanonicalRevenueKey(rows);
  const qtyKey = pickCanonicalQtyKey(rows);
  const labelKey = pickCanonicalLabelKey(rows, groupKey);
  return rows
    .map((row) => ({
      label: readLabelFromRow(row, labelKey),
      SaleNetAmount: readRevenueFromRow(row, revKey),
      MrpValue: readRevenueFromRow(row, revKey),
      AppQty: readQtyFromRow(row, qtyKey),
      metric_value: readRevenueFromRow(row, revKey),
      txn_count: row.txn_count != null ? parseFloat(row.txn_count) : undefined,
      _source: row,
    }))
    .filter((r) => r.label && !isJunkGroupKey(r.label));
}

function isCountKey(key = '', rows = null) {
  const tag = getColTag(key);
  if (tag === 'count') return true;
  if (tag && tag !== 'unknown') return false;
  if (rows && isPerRowBillCountColumn(rows, key)) return false;
  const k = String(key || '').toLowerCase();
  return /(count$|qty$|quantity$|invoicecount|customercount|billcount|stockqty|purqty|slsqty|txncount|transactioncount|ordercount|itemcount|linecount|visits|footfall)/.test(k);
}

/**
 * Returns { money[], counts[], dualAxis:bool } — used for dual Y-axis assignment.
 * Tag-aware: uses _globalColTags if available, regex fallback otherwise.
 */
function classifyValueCols(valueCols = [], rows = null) {
  const money  = valueCols.filter(c => isSaleValueKey(c));
  const counts = valueCols.filter(c => isCountKey(c, rows));
  const other  = valueCols.filter(c => !isSaleValueKey(c) && !isCountKey(c, rows));
  const dual   = money.length > 0 && counts.length > 0;
  return { money, counts: [...counts, ...other], dualAxis: dual };
}

function scaleSaleValue(n, key = '') {
  const x = parseFloat(n);
  if (isNaN(x)) return x;
  return isSaleValueKey(key) ? (x / SALE_VALUE_DIVISOR) : x;
}

function formatCompactNumber(n) {
  const x = parseFloat(n);
  if (isNaN(x)) return String(n ?? '');
  const abs = Math.abs(x);
  /* Always show in Lakhs — never convert to Crore (user requirement) */
  if (abs >= 1e5) return (x / 1e5).toFixed(2) + ' L';
  if (abs >= 1e3) return (x / 1e3).toFixed(1) + 'K';
  return x % 1 === 0 ? String(x) : x.toFixed(2);
}

/**
 * Formatter for chart Y-axes whose values are ALREADY scaled to ₹ Lakhs
 * (i.e. after scaleSaleValue). Shows compact Lakhs notation: 1578.86 → "1578.9 L",
 * 15788 → "15.8K L".
 */
function fmtLakhsAxis(v) {
  if (!Number.isFinite(v)) return '';
  /* Lakhs only — Indian grouping, no Crore/K-lakh shortcut (customer requirement). */
  return `${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 })} L`;
}

function formatNum(n, key = '') {
  const scaled = scaleSaleValue(n, key);
  if (isNaN(scaled)) return String(n ?? '');
  if (isSaleValueKey(key)) return Number(scaled).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' L';
  return formatCompactNumber(scaled);
}

function isPlainNumericString(v) {
  const s = String(v ?? '').trim();
  if (!s) return false;
  return /^-?\d+(?:\.\d+)?$/.test(s);
}

function isISODateTimeString(v) {
  // Matches 2026-04-27T00:00:00.000Z or 2026-04-27T00:00:00 or 2026-04-27
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T|\s|$)/.test(v);
}

function formatDateDDMMYYYY(v) {
  try {
    const d = new Date(v);
    if (isNaN(d)) return String(v ?? "");
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  } catch {
    return String(v ?? "");
  }
}

function formatTableDateValue(v) {
  const s = String(v ?? "").trim();
  if (!s) return s;
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) return s;
  return formatDateDDMMYYYY(v);
}

function shouldFormatTableNumeric(key, value) {
  if (value === null || value === undefined) return false;
  if (isNonAggregableDigitKey(key)) return false;
  const k = String(key || '').toLowerCase();
  // Keep identifiers exactly as source values.
  if (/id$|_id$|(^|_)(id|code|no|num|ref|invoice)(_|$)/.test(k)) return false;
  // Date/time columns → handled separately by isISODateTimeString check in DataTable
  if (/date|dt|time/.test(k)) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  return isPlainNumericString(value);
}

function formatTableNumericValue(key, value) {
  if (isSaleValueKey(key)) {
    return formatNum(value, key);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/* Format a rupee value for KPI cards: ₹ prefix + Lakh/Crore */
function fmtRupee(n) {
  const x = parseFloat(n);
  if (isNaN(x)) return '—';
  const scaled = x / SALE_VALUE_DIVISOR;
  return '₹' + scaled.toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' L';
}

/* Smart rupee formatter — uses Lakhs only if value ≥ ₹1L.
   For smaller values (like Avg Bill ₹5,200) shows as ₹5,200 directly.
   Use this for KPI tiles where the value range is unpredictable. */
function fmtRupeeAuto(n) {
  const x = parseFloat(n);
  if (isNaN(x) || !Number.isFinite(x)) return '—';
  if (x >= 1e7) {
    // ≥ 1 Crore — show in Crores
    return '₹' + (x / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' Cr';
  }
  if (x >= 1e5) {
    // ≥ 1 Lakh — show in Lakhs
    return '₹' + (x / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' L';
  }
  if (x >= 1000) {
    // ₹1,000–₹99,999 — show with commas, no decimal
    return '₹' + Math.round(x).toLocaleString('en-IN');
  }
  // Below ₹1,000 — plain
  return '₹' + Math.round(x).toLocaleString('en-IN');
}

function localizeWesternUnitsToIndian(text) {
  const src = String(text ?? '');
  if (!src) return src;
  return src
    .replace(/([$₹])?\s*([\d,.]+)\s*(billion|bn)\b/gi, (_, sym, num) => {
      const n = parseFloat(String(num).replace(/,/g, ''));
      if (!isFinite(n)) return _;
      const inLakhs = n * 10000;
      const prefix = sym || '';
      return `${prefix}${inLakhs.toLocaleString('en-IN', { maximumFractionDigits: 2 })} lakh`;
    })
    .replace(/([$₹])?\s*([\d,.]+)\s*(million|mn)\b/gi, (_, sym, num) => {
      const n = parseFloat(String(num).replace(/,/g, ''));
      if (!isFinite(n)) return _;
      const inLakhs = n * 10;
      const prefix = sym || '';
      return `${prefix}${inLakhs.toLocaleString('en-IN', { maximumFractionDigits: 2 })} lakh`;
    });
}

/* Convert dd.mm.yyyy / dd-mm-yyyy / dd/mm/yyyy -> yyyy-mm-dd for unambiguous SQL filtering */
function dmyToISO(dmy) {
  if (!dmy) return dmy;
  const raw = String(dmy).trim();
  const p = raw.split(/[./-]/);
  if (p.length === 3 && p[0].length <= 2 && p[1].length <= 2 && p[2].length === 4) {
    return `${p[2]}-${p[1].padStart(2, "0")}-${p[0].padStart(2, "0")}`;
  }
  return dmy; // already ISO or unknown
}

function trunc(s, n = 12) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** PIN / postal codes are digit-like but must not be summed, averaged, or charted as measures */
function looksLikePostalOrPinKey(key) {
  const k = String(key || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!k) return false;
  if (k.includes('pincode') || k.includes('postcode') || k.includes('postalcode') || k.includes('zipcode')) return true;
  if (k.includes('postal') && k.includes('code')) return true;
  if (k === 'zip' || k === 'postal' || k.endsWith('zip')) return true;
  return false;
}

/** Phone / mobile / fax — digit strings, not sums or chart measures */
function looksLikePhoneOrMobileKey(key) {
  const k = String(key || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!k || k.includes('microphone')) return false;
  if (k.includes('contactmobile') || k.includes('mobileno') || k.includes('phoneno')) return true;
  if (k.includes('phonenumber') || k.includes('cellphone') || k.includes('whatsapp')) return true;
  if (k.includes('telephone') || k.includes('telephoneno') || k.includes('telno')) return true;
  if (k.includes('landline') || k.includes('landlineno')) return true;
  if (k === 'fax' || k.includes('faxno') || (k.startsWith('fax') && k.length <= 12)) return true;
  if (k.includes('workphone') || k.includes('homephone') || k.includes('officephone')) return true;
  if (k.includes('alternatemobile') || k.includes('primaryphone') || k.includes('secondaryphone')) return true;
  if (k.endsWith('mobile') && !k.includes('automobile')) return true;
  if (k === 'mobile' || k === 'phone' || k === 'tel' || k === 'sms') return true;
  return false;
}

/** Invoice / PO / memo numbers parsed as digits — not additive KPIs */
function looksLikeInvoiceDocumentKey(key) {
  const k = String(key || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!k) return false;
  return /purinvoice|purinvno|invoiceno|invoiceid|billno|billnumber|billnum|cashmemono|memono|orderno|ordernumber|voucherno|grnno|ponumber|purchaseorder|challanno|purchallan|purchallanno|purrefno|documentno/.test(k);
}

/** Para1Index, Para2Index — not additive */
function looksLikeParaIndexKey(key) {
  return /^para\d+index$/i.test(String(key || '').trim());
}

/** Item / article catalog identifiers — never sum (Itemcode is not a metric). */
function looksLikeItemCatalogIdentifierKey(key) {
  const k = String(key || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!k) return false;
  return (
    /^(itemcode|itemid|articleid|articleno|sku|hsncode|purchaseid|purpartyid|uomid|gstuqc|uomtype|codingtype|articlestocktype|gstclassification)$/.test(k) ||
    /^para\d+id$/.test(k) ||
    /^inv(department|category|subcategory)id$/.test(k)
  );
}

/** Per-SKU list prices on item master — not portfolio totals when browsing catalog rows. */
function looksLikeCatalogUnitPriceKey(key) {
  const k = String(key || '').toLowerCase().replace(/[\s_-]+/g, '');
  return /^(itemmrp|itemwsp|itemexp|purchaseprice|mrp|wsp|listprice|unitprice)$/.test(k);
}

function rowsLookLikeItemMasterCatalog(rows) {
  if (!rows?.length || !rows[0] || typeof rows[0] !== 'object') return false;
  const keys = new Set(Object.keys(rows[0]).map((x) => x.toLowerCase()));
  return keys.has('itemcode') && keys.has('itemmrp') && (keys.has('description') || keys.has('articleno'));
}

function getMasterDatasetHint(datasetKey) {
  const dk = String(datasetKey || '').toLowerCase().trim();
  if (dk === 'vw_ai_salesperson') {
    return 'Salesperson master — IDs and names only. ShortName is often an internal code (e.g. 116), not revenue. For sales by person use sales or mb_powerbi_sls_data_without_itemid.';
  }
  if (dk === 'vw_mst_items' || dk === 'vw_aimst_items' || dk === 'mb_powerbi_product_master') {
    return 'Item catalog — do not sum Itemcode, ArticleNo, or unit prices (ItemMRP/WSP/EXP). Each row is one SKU. Use stock or sales datasets for inventory value or revenue.';
  }
  if (dk === 'stock') {
    return 'Stock snapshot (ItemId x BranchId). SUM(StockQty) on loaded rows is not total company inventory. Use mb_powerbi_stock_report for valued stock or load more rows.';
  }
  if (dk === 'customers') {
    return 'Customer master — one row per customer. CreditLimit is per account (often 0 in ERP); do not SUM across loaded rows. No date column — TOP 500 is a sample, not “newest customers”.';
  }
  if (dk === 'branches') {
    return 'Branch master — one row per store. No date column; a full load lists every branch (often ~100–120). Use sales / APP_REPORT for revenue by BranchAlias.';
  }
  if (dk === 'vw_ai_supplier') {
    return 'Reference master — browse and export; use sales/stock/purchase datasets for amounts and quantities.';
  }
  return 'Reference master list — not transactional totals.';
}

function isNonAggregableDigitKey(key) {
  return (
    looksLikePostalOrPinKey(key) ||
    looksLikePhoneOrMobileKey(key) ||
    looksLikeInvoiceDocumentKey(key) ||
    looksLikeParaIndexKey(key) ||
    looksLikeItemCatalogIdentifierKey(key)
  );
}

function isNumericCol(rows, key, sample = 20) {
  if (looksLikeDimensionLabelKey(key)) return false;
  if (looksLikeItemCatalogIdentifierKey(key)) return false;
  if (isNonAggregableDigitKey(key)) return false;
  const slice = rows.slice(0, Math.min(rows.length, sample));
  let valid = 0, total = 0;
  for (const r of slice) {
    const v = r[key];
    if (v === null || v === undefined || v === '') continue;
    total++;
    if (!isNaN(parseFloat(v)) && isFinite(Number(v))) valid++;
  }
  return total > 0 && valid / total >= 0.75;
}

function looksLikeId(rows, key) {
  const lk = key.toLowerCase();
  if (looksLikeItemCatalogIdentifierKey(key)) return true;
  // Exclude by column name: anything ending in Id/ID, or known ID patterns
  if (/id$|_id$|branchid|personid|customerid|itemid|invoiceid|userid|salespersonid/i.test(key)) return true;
  // Exclude helper sort/order columns from UNION ALL period-comparison queries
  if (/^sortorder$|^sort_order$|^roworder$|^row_order$|^sortkey$|^sort_key$/i.test(key)) return true;
  const nameIsId = /^(id|_id|sno|s_no|rowid|row_id|seq|sequence|refno|ref_no|recno|rec_no)$|(?:^|_)(id|no|num|code|key|seq|ref)$/.test(lk);
  if (!nameIsId) return false;
  const vals = rows.map(r => r[key]).filter(v => v !== null && v !== undefined);
  if (!vals.every(v => Number.isInteger(Number(v)))) return false;
  return true; // name matches ID pattern + all integers
}

/** APP_REPORT / sales line grid (XnNo + MrpValue + AppQty). */
function rowsLookLikeAppReportLines(rows) {
  if (!rows?.length || !rows[0] || typeof rows[0] !== 'object') return false;
  const keys = new Set(Object.keys(rows[0]).map((x) => x.toLowerCase()));
  return keys.has('mrpvalue') && keys.has('appqty') && (keys.has('xnno') || keys.has('xndt'));
}

/** Current stock snapshot: one row per ItemId x BranchId (VwAIStockData). */
function rowsLookLikeStockSnapshot(rows) {
  if (!rows?.length || !rows[0] || typeof rows[0] !== 'object') return false;
  const keys = new Set(Object.keys(rows[0]).map((x) => x.toLowerCase()));
  return keys.has('stockqty') && keys.has('branchid') && keys.has('itemid') && keys.size <= 6;
}

/** Customer master (VwAICustomerDetails) — browse contacts, do not SUM CreditLimit as portfolio exposure. */
function rowsLookLikeCustomerMaster(rows) {
  if (!rows?.length || !rows[0] || typeof rows[0] !== 'object') return false;
  const keys = new Set(Object.keys(rows[0]).map((x) => x.toLowerCase()));
  return keys.has('customerid') &&
    (keys.has('customerfirstname') || keys.has('contactmobile') || keys.has('creditlimit'));
}

/** Branch / store master (VwAIBranch). */
function rowsLookLikeBranchMaster(rows) {
  if (!rows?.length || !rows[0] || typeof rows[0] !== 'object') return false;
  const keys = new Set(Object.keys(rows[0]).map((x) => x.toLowerCase()));
  return keys.has('branchid') && keys.has('branchname') && keys.size <= 12;
}

function distinctColumnCount(rows, colPattern) {
  const key = Object.keys(rows[0] || {}).find((k) => colPattern.test(k));
  if (!key) return null;
  const s = new Set();
  for (const r of rows) {
    const v = r[key];
    if (v != null && String(v).trim()) s.add(String(v).trim());
  }
  return s.size;
}

/** View column BillCount is often 1 per line — SUM equals row count, not distinct bills. */
function isPerRowBillCountColumn(rows, key) {
  if (!/^billcount$/i.test(String(key || '').trim())) return false;
  const vals = rows
    .slice(0, Math.min(rows.length, 120))
    .map((r) => parseFloat(r[key]))
    .filter((v) => Number.isFinite(v));
  if (!vals.length) return false;
  return vals.every((v) => v === 0 || v === 1);
}

/** Secondary money cols on line detail when MrpValue is primary revenue. */
function isAuxiliaryTxnMoneyKey(key, rows) {
  const k = String(key || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!rowsLookLikeAppReportLines(rows)) return false;
  if (!/^(netamount|costvalue|cgstamount|sgstamount|igstamount|saleamountbeforetax|taxamount)$/.test(k)) {
    return false;
  }
  return Object.keys(rows[0] || {}).some((c) => /^mrpvalue$/i.test(c));
}

function distinctXnNoCount(rows) {
  const xnKey = Object.keys(rows[0] || {}).find((k) => /^xnno$/i.test(k));
  if (!xnKey) return null;
  const s = new Set();
  for (const r of rows) {
    const v = r[xnKey];
    if (v != null && String(v).trim()) s.add(String(v).trim());
  }
  return s.size;
}

function aggregateRowsByLabel(rows, labelCol, valueCols) {
  const map = new Map();
  for (const r of rows) {
    const lab = String(r[labelCol] ?? '').trim() || '(blank)';
    if (!map.has(lab)) map.set(lab, { [labelCol]: lab });
    const agg = map.get(lab);
    for (const k of valueCols) {
      if (isPerRowBillCountColumn(rows, k)) continue;
      const v = parseFloat(r[k]);
      if (Number.isFinite(v)) agg[k] = (agg[k] || 0) + v;
    }
  }
  const primary = valueCols[0];
  return Array.from(map.values()).sort(
    (a, b) => (parseFloat(b[primary]) || 0) - (parseFloat(a[primary]) || 0)
  );
}

function shouldAggregateChartRows(rows, labelCol) {
  if (!rows || rows.length < 8 || !labelCol) return false;
  if (!rowsLookLikeAppReportLines(rows) && !rowLooksLikeTxnQtyAmount(rows[0])) return false;
  const labels = rows.map((r) => String(r[labelCol] ?? ''));
  const unique = new Set(labels).size;
  return unique < rows.length * 0.85 && unique <= 48;
}

function filterTxnLineValueCols(rows, cols) {
  return (cols || []).filter(
    (k) =>
      !isPerRowBillCountColumn(rows, k) &&
      !isAuxiliaryTxnMoneyKey(k, rows) &&
      !looksLikeItemCatalogIdentifierKey(k)
  );
}

function detectChart(rows) {
  if (!rows || rows.length < 2) return null;
  /* ECharts handles tens of thousands of points — raise the cap. */
  if (rows.length > 50000) return null;

  const keys = Object.keys(rows[0]);
  if (keys.length < 2) return null;
  if (rowsLookLikeItemMasterCatalog(rows)) return null;
  if (rowsLookLikeStockSnapshot(rows)) return null;
  if (rowsLookLikeCustomerMaster(rows)) return null;
  if (rowsLookLikeBranchMaster(rows)) return null;
  /* Reference masters (salesperson / supplier / branch lists) — table only, no bogus bar charts. */
  if (
    keys.length <= 6 &&
    keys.every((k) => looksLikeDimensionLabelKey(k) || looksLikeId(rows, k) || /^(salesperson|supplier|customer|branch|item|product|vendor|party)id$/i.test(String(k).replace(/[\s_-]/g, '')))
  ) {
    return null;
  }

  const numericKeys = keys.filter(k => isNumericCol(rows, k) && !looksLikeId(rows, k));
  let labelKeys   = keys.filter(k => !numericKeys.includes(k));

  // All-numeric result (e.g. Yr, Mo, TotalSales) — force first col as label
  if (numericKeys.length === 0) return null;
  if (labelKeys.length === 0) {
    // Promote first column to label (treat year/month numbers as categories)
    labelKeys = [keys[0]];
    // Remove it from numericKeys so it's not treated as a value
    numericKeys.splice(numericKeys.indexOf(keys[0]), 1);
    if (numericKeys.length === 0) return null;
  }

  // Need at least one finite numeric somewhere (stock qty / MRP / costs are often legitimate when all-equal)
  const hasNumericValues = numericKeys.some(k =>
    rows.some(r => Number.isFinite(parseFloat(r[k])))
  );
  if (!hasNumericValues) return null;

  // Prefer a text/name label column over an ID-named column
  const ID_NAME_PAT = /^(id|_id|sno|s_no|rowid|row_id|seq|sequence|refno|ref_no|recno|rec_no)$|(?:^|_)(id|no|num|code|key|seq|ref)$/;
  const labelCol = labelKeys.find(k => !ID_NAME_PAT.test(k.toLowerCase())) || labelKeys[0];

  // Column priority: prefer net/total sales, exclude raw unit price, before-tax, and helper sort columns
  const EXCLUDE_COLS = /^(salesprice|unitprice|mrpprice|saleamountbeforetax|amountbeforetax|taxamount|discountamount|salesperson|sortorder|sort_order|roworder|row_order)/i;
  const PREFER_COLS  = /mrpvalue|salenetamount|netsales|netsale|totalnet|metric_value|totalpurchase|purnetamount|nettpurchase|netslscostvalue|netslsqty|appqty/i;
  const preferred = numericKeys.filter(k => PREFER_COLS.test(k) && !isPerRowBillCountColumn(rows, k) && !isAuxiliaryTxnMoneyKey(k, rows));
  const rest       = numericKeys.filter(k => !PREFER_COLS.test(k) && !EXCLUDE_COLS.test(k) && !isPerRowBillCountColumn(rows, k) && !isAuxiliaryTxnMoneyKey(k, rows));
  // Multi-metric: up to 4 series for dual-axis (money+count) or multi-money comparison; otherwise cap at 3
  const rawCols = [...preferred, ...rest];
  const { dualAxis: isDual } = classifyValueCols(rawCols, rows);
  // Allow 4 cols when: dual-axis (money+count) OR multiple preferred money cols (comparison query)
  const multiMoney = preferred.length >= 2;
  const valueCols  = rawCols.slice(0, (isDual || multiMoney) ? 4 : 3);
  const finalCols  = filterTxnLineValueCols(rows, valueCols.length > 0 ? valueCols : numericKeys.slice(0, 3));
  const singleVal  = finalCols[0];
  // isTimeSeries: match by column name suffix OR by actual data values being ISO dates
  const isTimeSeriesByName = /month|year|date|week|quarter|period|day|time|created|updated|\bdt\b|dt$/i.test(labelCol);
  const sampleVals = rows.slice(0, 5).map(r => String(r[labelCol] ?? ''));
  const isTimeSeriesByData = sampleVals.some(v => /^\d{4}-\d{2}-\d{2}/.test(v));
  const isTimeSeries = isTimeSeriesByName || isTimeSeriesByData;

  // Friendly display name for chart title (remove prefix noise)
  const friendlyCol = (c) => c.replace(/^(Total|Sum|Net|Avg)/i, '').replace(/([A-Z])/g, ' $1').trim();
  const seriesLabel = finalCols.length > 1
    ? finalCols.map(friendlyCol).join(' vs ')
    : friendlyCol(finalCols[0] || singleVal);

  // 1. Line: time-series — ECharts virtual rendering handles many points well
  if (isTimeSeries && rows.length >= 3 && rows.length <= 5000) {
    return { type: 'line', labelCol, valueCols: finalCols, title: `📈 ${seriesLabel} over Time` };
  }
  // 2. Pie: exactly 2 cols, single numeric, ≤7 rows — avoids overcrowded pies
  if (keys.length === 2 && numericKeys.length === 1 && rows.length <= 7) {
    return { type: 'pie', labelCol, valueCol: singleVal, title: `${friendlyCol(singleVal)} by ${labelCol}` };
  }
  // 3. Period comparison (UNION ALL): small row count + Period-like label
  if (rows.length <= 6 && /^period$|^label$|^time$|^range$/i.test(labelCol) && finalCols.length >= 1) {
    return { type: 'bar', labelCol, valueCols: finalCols, title: `📊 Period Comparison: ${seriesLabel}` };
  }
  // 3b. Raw ERP keys × many rows (e.g. stock ItemId × BranchId) — bar is unreadable; table + KPIs enough
  const normLabel = String(labelCol || "").replace(/[\s_-]/g, "");
  const rawIdBarLabel =
    /^(itemid|branchid|customerid|invoiceid|invoiceno|orderid|billno|cashmemono|skuid|productid|materialid|vendorid|supplierid|partyno|purchaseid)$/i.test(
      normLabel
    );
  if (rawIdBarLabel && rows.length > 400) return null;
  // 4. Bar: default for grouping / category / ranking data
  return { type: 'bar', labelCol, valueCols: finalCols, title: `📊 ${seriesLabel} by ${labelCol}` };
}

/** Rows that look like invoice / line grids (qty + net amount) — drives returns filter UX. */
function rowLooksLikeTxnQtyAmount(row) {
  if (!row || typeof row !== "object") return false;
  const keys = Object.keys(row);
  const hasAmt = keys.some(k =>
    /salenetamount|netslsnetamount|slsnetamount|net.?sls.*amount|saleamountbeforetax|netamount|purnetamount|pur.?net|netpur|slrnetamount/i.test(k)
  );
  const hasQty = keys.some(k =>
    /^quantity$/i.test(k) || /slsqty|netslsqty|slrqty|purqty|prtqty|netpurqty/i.test(k)
  );
  return hasAmt && hasQty;
}

function isSalesLikeTxnDataset(datasetKey, sampleRow) {
  const dk = String(datasetKey || "").toLowerCase().trim();
  if (isMasterReferenceDataset(dk)) return false;
  if (dk === "sales") return true;
  if (/mb_powerbi_.*_(sls|sales|cashmemo|bill|xns|article|mis_supplier)/i.test(dk)) return true;
  if (/(?:^|_)(sales|sls)(?:_|$)/.test(dk) || /\bsales_|\b_sales\b/.test(dk)) return true;
  if (/slsxns|invoice|cashmemo|billcount|purxns|pur_report|pur_qty|sto_|sti_|app_|apr_/.test(dk)) return true;
  return rowLooksLikeTxnQtyAmount(sampleRow);
}

function findMoneyMetricColumnKey(row) {
  if (!row || typeof row !== "object") return null;
  return Object.keys(row).find(k =>
    /totalsales|salenetamount|netslsnetamount|slsnetamount|purnetamount|netpur|netamount|saleamount|totalpurchase|netslscostvalue/i.test(k) &&
    !/beforetax|taxamount|cgst|sgst|igst|costvalue|mrpvalue|pretax|slscost|gstamount|mrv|slrmrp/i.test(k)
  ) || null;
}

function filterExcludeReturnCreditRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  return rows.filter((r) => {
    const amtKeys = Object.keys(r).filter(k =>
      /salenetamount|netslsnetamount|slsnetamount|net.?sls.*amount|netamount|saleamountbeforetax|purnetamount|pur.?net|netpur|slrnetamount/i.test(k)
    );
    const qtyKeys = Object.keys(r).filter(k =>
      /^quantity$/i.test(k) || /slsqty|netslsqty|purqty|prtqty|netpurqty|slrqty/i.test(k)
    );
    let hasNegQty = false;
    let hasNegAmt = false;
    for (const k of qtyKeys) {
      const q = Number(r[k]);
      if (Number.isFinite(q) && q < 0) hasNegQty = true;
    }
    for (const k of amtKeys) {
      const n = Number(r[k]);
      if (Number.isFinite(n) && n < 0) hasNegAmt = true;
    }
    return !(hasNegQty || hasNegAmt);
  });
}

/* ═══════════════════════════════════════════════════════════════════
   THEME HOOK — single source of truth for light / dark
═══════════════════════════════════════════════════════════════════ */
const THEME_KEY = "erp_theme";
function getInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch { return 'light'; }
}
function useTheme() {
  const [theme, setTheme] = useState(getInitialTheme);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
    /* Notify ECharts instances so they re-paint with the right colors. */
    window.dispatchEvent(new CustomEvent('erp-theme-change', { detail: { theme } }));
  }, [theme]);
  return [theme, () => setTheme(t => t === 'dark' ? 'light' : 'dark')];
}

/* ═══════════════════════════════════════════════════════════════════
   ECHARTS THEME PALETTE — derived from CSS variables at run-time
═══════════════════════════════════════════════════════════════════ */
function readCssVar(name, fallback) {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function buildEchartsTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    isDark,
    bg:        readCssVar('--bg-surface', isDark ? '#111726' : '#ffffff'),
    text:      readCssVar('--text', isDark ? '#e6ecf6' : '#0f172a'),
    textMuted: readCssVar('--text-muted', isDark ? '#94a3b8' : '#64748b'),
    grid:      readCssVar('--grid-line', isDark ? '#1f2a40' : '#eef2f6'),
    gridStrong:readCssVar('--grid-line-strong', isDark ? '#2c3958' : '#d8dee8'),
    tipBg:     readCssVar('--chart-tip-bg', isDark ? '#f8fafc' : '#0b1220'),
    tipFg:     readCssVar('--chart-tip-fg', isDark ? '#0b1220' : '#f8fafc'),
    series:    isDark
      ? ['#60a5fa','#34d399','#fbbf24','#f87171','#a78bfa','#22d3ee','#fb923c','#a3e635','#f472b6','#2dd4bf']
      : ['#2563eb','#10b981','#f59e0b','#ef4444','#7c3aed','#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6'],
  };
}

/* ═══════════════════════════════════════════════════════════════════
   ECharts wrapper — handles mount, resize, theme swap, and dispose
═══════════════════════════════════════════════════════════════════ */
function EChart({ option, height = 340, onPointClick = null, onInit = null }) {
  const ref = useRef(null);
  const instRef = useRef(null);

  /* Mount once, dispose once.
     Uses ResizeObserver so the chart always fills its container —
     even when it first renders inside a hidden tab or lazy-loaded panel. */
  useEffect(() => {
    if (!ref.current || !window.echarts) return;
    const inst = window.echarts.init(ref.current, null, { renderer: 'canvas' });
    instRef.current = inst;
    if (typeof onInit === 'function') onInit(inst);

    /* Window resize (orientation change, window drag) */
    const onWinResize = () => { try { inst.resize(); } catch {} };
    window.addEventListener('resize', onWinResize);

    /* ResizeObserver: fires every time the container changes size.
       Always call resize() — ECharts re-measures the DOM itself. */
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        try { inst.resize(); } catch {}
      });
      ro.observe(ref.current);
    }

    return () => {
      window.removeEventListener('resize', onWinResize);
      if (ro) { try { ro.disconnect(); } catch {} }
      try { inst.dispose(); } catch {}
      instRef.current = null;
    };
  }, []);

  /* Apply the option whenever it changes. */
  useEffect(() => {
    const inst = instRef.current;
    if (!inst) return;
    inst.setOption(option, true);
    /* Multi-stage resize: rAF × 2 + 100ms + 300ms covers every lazy-render
       scenario — hidden tabs, CSS transitions, async flex layout. */
    requestAnimationFrame(() => {
      try { inst.resize(); } catch {}
      requestAnimationFrame(() => { try { inst.resize(); } catch {} });
    });
    const t1 = setTimeout(() => { try { inst.resize(); } catch {} }, 100);
    const t2 = setTimeout(() => { try { inst.resize(); } catch {} }, 300);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [option]);

  useEffect(() => {
    const inst = instRef.current;
    if (!inst) return;
    const handler = (params) => {
      if (typeof onPointClick === "function") {
        onPointClick(params);
      }
    };
    inst.off("click");
    if (onPointClick) {
      inst.on("click", handler);
    }
    return () => {
      try { inst.off("click", handler); } catch {}
    };
  }, [onPointClick]);

  return <div ref={ref} style={{ width: '100%', height }} />;
}

/* Helper: build the shared base option (axes, grid, tooltip, theme) */
function baseEchartsOption(themeTokens, opts = {}) {
  const t = themeTokens;
  return {
    backgroundColor: 'transparent',
    color: t.series,
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: t.text },
    grid: { top: 28, right: 24, bottom: 64, left: 56, containLabel: true, ...opts.grid },
    tooltip: {
      trigger: opts.trigger || 'axis',
      backgroundColor: t.tipBg,
      borderColor: 'transparent',
      textStyle: { color: t.tipFg, fontSize: 12 },
      axisPointer: { type: 'shadow', shadowStyle: { color: t.isDark ? 'rgba(96,165,250,0.10)' : 'rgba(37,99,235,0.06)' } },
      extraCssText: 'box-shadow:0 8px 24px rgba(0,0,0,.18); border-radius:10px; padding:8px 12px;',
      formatter: (params) => {
        const arr = Array.isArray(params) ? params : [params];
        if (!arr.length) return "";
        const rawLabel = arr[0]?.axisValueLabel ?? arr[0]?.axisValue ?? arr[0]?.name ?? "";
        const label = fmtLabel(rawLabel);
        const lines = [label];
        for (const p of arr) {
          if (!p) continue;
          const marker = p.marker || "";
          const name = p.seriesName || "";
          const val = Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value;
          lines.push(`${marker}${name}: ${formatCompactNumber(val)}`);
        }
        return lines.join("<br/>");
      },
    },
    legend: {
      top: 0, right: 8, type: 'scroll',
      textStyle: { color: t.textMuted, fontSize: 11, fontWeight: 600 },
      itemGap: 14, icon: 'roundRect', itemWidth: 12, itemHeight: 12,
    },
  };
}

/* ═══════════════════════════════════════════════
   BAR CHART (smart: vertical when ≤8 rows, horizontal otherwise)
═══════════════════════════════════════════════ */
/* Format ISO timestamps and long date strings into short readable labels */
function fmtLabel(v) {
  if (!v) return '';
  const s = String(v);
  /* Calendar yyyy-mm-dd (ignore time + TZ drift from ISO strings like ...T00:00:00.000Z). */
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(s)) {
    const [y, mo, d] = s.slice(0, 10).split('-');
    if (y && mo && d) return `${d}-${mo}-${y}`;
  }
  /* Bare ISO date prefix for odd formats */
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const f = formatDateDDMMYYYY(s);
    if (f && f !== "Invalid Date") return f;
  }
  /* Human date text like "1 Nov 2025" */
  if (/^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(s)) {
    const f = formatDateDDMMYYYY(s);
    if (f && f !== "Invalid Date") return f;
  }
  return s.length > 20 ? s.slice(0, 19) + '…' : s;
}

/**
 * @param {'auto'|'vertical'|'horizontal'} barOrientation
 *   - auto: long lists → horizontal (categories on Y); short lists → vertical (categories on X)
 *   - vertical: categories on X axis (classic vertical bars) — default for most callers
 *   - horizontal: categories on Y axis (horizontal bars)
 */
function BarChart({ rows, labelCol, valueCols, title, forceVertical = false, barOrientation = 'vertical', onPointClick = null, valueAxisMaxRaw = null }) {
  const [, force] = useState(0);
  const chartInstRef = useRef(null);   // holds the ECharts instance for Fit button
  useEffect(() => {
    const fn = () => force(x => x + 1);
    window.addEventListener('erp-theme-change', fn);
    return () => window.removeEventListener('erp-theme-change', fn);
  }, []);

  const t = buildEchartsTheme();
  const n = rows.length;

  /* Format labels — this also shortens ISO dates before measuring length */
  const rawLabels  = rows.map(r => String(r[labelCol] ?? ''));
  const seenLabels = new Map();
  const uniqueRawLabels = rawLabels.map((raw) => {
    const count = (seenLabels.get(raw) || 0) + 1;
    seenLabels.set(raw, count);
    return count > 1 ? `${raw} (${count})` : raw;
  });
  const isDateCol  = rawLabels.some(v => /^\d{4}-\d{2}-\d{2}/.test(v));
  const labels     = uniqueRawLabels.map(fmtLabel);

  const avgLabelLen = labels.reduce((s, v) => s + v.length, 0) / Math.max(n, 1);
  /* Date columns → always vertical. Long-label non-date columns → horizontal. */
  const autoHorizontal = !forceVertical && !isDateCol && (n > 12 || avgLabelLen > 12);
  const horizontal = barOrientation === 'horizontal'
    ? true
    : barOrientation === 'vertical'
      ? false
      : autoHorizontal;
  /* Detect mixed money + count columns → dual Y-axis (vertical bars only) */
  const { dualAxis } = !horizontal ? classifyValueCols(valueCols, rows) : { dualAxis: false };

  const series = valueCols.map((k, i) => {
    const yIdx = (!horizontal && dualAxis) ? (isCountKey(k, rows) ? 1 : 0) : 0;
    const isMoneyCol = isSaleValueKey(k);
    return {
      name: chartSeriesDisplayName(k),
      type: 'bar',
      yAxisIndex: yIdx,
      data: rows.map(r => scaleSaleValue(r[k], k) || 0),
      itemStyle: {
        color: {
          type: 'linear',
          x: 0, y: 0, x2: horizontal ? 1 : 0, y2: horizontal ? 0 : 1,
          colorStops: [
            { offset: 0, color: t.series[i % t.series.length] },
            { offset: 1, color: t.series[i % t.series.length] + (t.isDark ? 'CC' : 'D9') },
          ],
        },
        borderRadius: horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0],
      },
      label: {
        show: true,
        position: horizontal ? 'right' : 'top',
        fontSize: 10,
        fontWeight: 600,
        color: t.text,
        formatter: (params) => {
          const v = typeof params.value === 'number' ? params.value : parseFloat(params.value);
          if (!Number.isFinite(v) || v === 0) return '';
          if (isMoneyCol) return fmtLakhsAxis(v);
          return formatCompactNumber(v);
        },
      },
      emphasis: { focus: 'series', itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,.25)' } },
      barMinHeight: horizontal ? undefined : 3,
      barMaxWidth: 40,
    };
  });

  const showZoom = n > 16;
  const defaultWindow = horizontal ? 12 : 10;
  const defaultEndValue = Math.min(defaultWindow - 1, n - 1);
  const catAxis = {
    type: 'category',
    data: labels,
    axisLabel: { color: t.text, fontSize: 11, rotate: (!horizontal && n > 6) ? 30 : 0, formatter: v => fmtLabel(v) },
    axisLine: { lineStyle: { color: t.gridStrong } },
    axisTick: { show: false },
    inverse: horizontal,
  };
  const hasMoneyColBar = valueCols.some(c => isSaleValueKey(c));
  const valAxisLeft = {
    type: 'value',
    name: dualAxis ? '₹ Lakhs' : '',
    nameTextStyle: { color: t.textMuted, fontSize: 10 },
    axisLabel: { color: t.textMuted, fontSize: 11, formatter: hasMoneyColBar ? fmtLakhsAxis : v => formatNum(v) },
    axisLine: { show: false },
    splitLine: { lineStyle: { color: t.grid, type: 'dashed' } },
  };
  if (!dualAxis && valueAxisMaxRaw != null && Number.isFinite(Number(valueAxisMaxRaw)) && valueCols.length) {
    const refCol = valueCols.find((c) => isSaleValueKey(c)) || valueCols[0];
    const scaled = scaleSaleValue(valueAxisMaxRaw, refCol);
    if (Number.isFinite(scaled) && scaled > 0) {
      valAxisLeft.max = scaled;
    }
  }
  const valAxisRight = dualAxis ? {
    type: 'value',
    name: 'Count',
    nameTextStyle: { color: t.textMuted, fontSize: 10 },
    position: 'right',
    alignTicks: true,
    axisLabel: { color: t.textMuted, fontSize: 11, formatter: v => formatCompactNumber(v) },
    axisLine: { show: false },
    splitLine: { show: false },
  } : null;

  /* Build a bar-chart-specific tooltip that shows "₹ X.XX L" for money columns */
  const barTooltipFormatter = (params) => {
    const arr = Array.isArray(params) ? params : [params];
    if (!arr.length) return '';
    const rawLabel = arr[0]?.axisValueLabel ?? arr[0]?.axisValue ?? arr[0]?.name ?? '';
    const label = fmtLabel(rawLabel);
    const lines = [`<b>${label}</b>`];
    for (const p of arr) {
      if (!p) continue;
      const v = Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value;
      const key = p.seriesName || '';
      const isMoney = isSaleValueKey(key);
      const numV = typeof v === 'number' ? v : parseFloat(v);
      const fmt = isMoney
        ? '₹ ' + (Number.isFinite(numV) ? numV.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—') + ' L'
        : formatCompactNumber(numV);
      lines.push(`${p.marker || ''}${key}: <b>${fmt}</b>`);
    }
    return lines.join('<br/>');
  };

  const opt = {
    ...baseEchartsOption(t, {
      grid: horizontal
        ? { top: 30, right: 28, bottom: showZoom ? 56 : 16, left: 16 }
        : { top: 36, right: dualAxis ? 70 : 18, bottom: showZoom ? 64 : 32, left: 16 },
    }),
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tipBg,
      borderColor: 'transparent',
      textStyle: { color: t.tipFg, fontSize: 12 },
      axisPointer: { type: 'shadow', shadowStyle: { color: t.isDark ? 'rgba(96,165,250,0.10)' : 'rgba(37,99,235,0.06)' } },
      extraCssText: 'box-shadow:0 8px 24px rgba(0,0,0,.18); border-radius:10px; padding:8px 12px;',
      formatter: barTooltipFormatter,
    },
    xAxis: horizontal ? valAxisLeft : catAxis,
    yAxis: horizontal ? catAxis : (dualAxis ? [valAxisLeft, valAxisRight] : valAxisLeft),
    series,
    dataZoom: showZoom ? [
      /* inside: scroll/pinch to pan the CATEGORY axis only.
         For vertical bars → control X (category) only, never Y (value axis),
         otherwise mouse-scroll pans bars vertically off-screen.
         For horizontal bars → control Y (category) only. */
      { type: 'inside',
        xAxisIndex: horizontal ? null : 0,
        yAxisIndex: horizontal ? 0  : null,
        orient:     horizontal ? 'vertical' : 'horizontal',
        zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false,
        startValue: 0, endValue: defaultEndValue },
      /* slider thumb at the bottom/right */
      { type: 'slider',
        xAxisIndex: horizontal ? null : 0,
        yAxisIndex: horizontal ? 0  : null,
        orient:     horizontal ? 'vertical' : 'horizontal',
        height: horizontal ? null : 18, width: horizontal ? 14 : null,
        right: horizontal ? 6 : null, bottom: horizontal ? null : 14,
        backgroundColor: 'transparent',
        fillerColor: t.isDark ? 'rgba(96,165,250,.15)' : 'rgba(37,99,235,.10)',
        borderColor: 'transparent',
        handleStyle: { color: t.series[0], borderWidth: 0 },
        textStyle: { color: t.textMuted, fontSize: 10 },
        startValue: 0, endValue: defaultEndValue,
      }
    ] : undefined,
  };

  const dynamicH = horizontal ? Math.max(280, Math.min(680, 32 + n * 22)) : 360;

  return (
    <div className="fade-in">
      {title && <p className="text-xs font-semibold mb-2 uppercase tracking-wider" style={{color:'var(--text-muted)'}}>{title}</p>}
      {dualAxis && !horizontal && (
        <p className="text-[11px] mb-1" style={{color:'var(--text-soft)'}}>
          Left axis: ₹ Lakhs &nbsp;|&nbsp; Right axis: Count
        </p>
      )}
      {!dualAxis && valueCols.length > 1 && valueCols.every(c => isSaleValueKey(c)) && (
        <p className="text-[11px] mb-1" style={{color:'var(--text-soft)'}}>
          All values in ₹ Lakhs &nbsp;·&nbsp; {valueCols.length} series
        </p>
      )}
      {n > 30 && <p className="text-[11px] mb-1" style={{color:'var(--text-soft)'}}>Drag the slider or scroll to explore all {n.toLocaleString()} rows.</p>}

      {/* Fit-to-view button — only when zoom slider is active */}
      {showZoom && (
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:4 }}>
          <button
            title="Reset zoom — show all bars"
            onClick={() => {
              const inst = chartInstRef.current;
              if (!inst) return;
              /* Snap dataZoom back to the full initial window */
              inst.dispatchAction({
                type: 'dataZoom',
                batch: [
                  { dataZoomIndex: 0, startValue: 0, endValue: defaultEndValue },
                  { dataZoomIndex: 1, startValue: 0, endValue: defaultEndValue },
                ],
              });
              /* Also force a resize so bars land exactly on the axis */
              requestAnimationFrame(() => { try { inst.resize(); } catch {} });
            }}
            style={{
              fontSize: 11, padding: '2px 10px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--surface2)', color: 'var(--text-muted)', cursor: 'pointer',
              fontWeight: 600, display:'flex', alignItems:'center', gap:4,
            }}
          >⊡ Fit</button>
        </div>
      )}

      <EChart option={opt} height={dynamicH} onPointClick={onPointClick}
        onInit={(inst) => { chartInstRef.current = inst; }} />
    </div>
  );
}

/* Backward-compat: HBarChart and VBarChart now both forward to BarChart. */
function HBarChart(props) { return <BarChart {...props} />; }
function VBarChart(props) { return <BarChart {...props} />; }

/* ═══════════════════════════════════════════════
   LINE CHART — smooth area + dataZoom for huge series
═══════════════════════════════════════════════ */
function LineChart({ rows, labelCol, valueCols, title, onPointClick = null, valueAxisMaxRaw = null, forecast = null }) {
  const [, force] = useState(0);
  const chartInstRef = useRef(null);
  useEffect(() => {
    const fn = () => force(x => x + 1);
    window.addEventListener('erp-theme-change', fn);
    return () => window.removeEventListener('erp-theme-change', fn);
  }, []);

  const t = buildEchartsTheme();
  const fc =
    forecast && forecast.enabled &&
    Array.isArray(forecast.periodLabels) && forecast.periodLabels.length &&
    Array.isArray(forecast.values) && forecast.values.length === forecast.periodLabels.length
      ? forecast
      : null;
  const fN = fc ? fc.periodLabels.length : 0;

  /* Detect mixed money + count columns → dual Y-axis */
  const { dualAxis } = classifyValueCols(valueCols);
  const moneyColIdx = valueCols.findIndex((k) => isSaleValueKey(k));
  const forecastTargetCol = moneyColIdx >= 0 ? valueCols[moneyColIdx] : valueCols[0];

  /* Deduplicate labels — if the DB returned two rows for the same date,
     the second occurrence gets "(2)" to prevent a flat repeated X-axis. */
  const seenLineLabels = new Map();
  const labels = rows.map(r => {
    const fmt = fmtLabel(String(r[labelCol] ?? ''));
    const cnt = (seenLineLabels.get(fmt) || 0) + 1;
    seenLineLabels.set(fmt, cnt);
    return cnt > 1 ? `${fmt} (${cnt})` : fmt;
  });
  const labelsExt = fc
    ? [...labels, ...fc.periodLabels.map((L) => fmtLabel(String(L)))]
    : labels;
  const n = labelsExt.length;

  const nullPad = (arr) => (fc ? [...arr, ...new Array(fN).fill(null)] : arr);

  const hasMoneyColLine = valueCols.some(c => isSaleValueKey(c));
  const series = [];
  valueCols.forEach((k, i) => {
    const color = t.series[i % t.series.length];
    const yIdx = dualAxis ? (isCountKey(k) ? 1 : 0) : 0;
    const isMoneySeries = isSaleValueKey(k);
    const histData = rows.map(r => scaleSaleValue(r[k], k) || 0);
    /* Show inline labels when dataset is small enough to be readable (≤ 45 points) */
    const showLabels = n <= 96 && !fc;
    series.push({
      name: chartSeriesDisplayName(k),
      type: 'line',
      yAxisIndex: yIdx,
      smooth: true,
      symbol: n > 80 ? 'none' : 'circle',
      symbolSize: 6,
      sampling: rows.length > 200 ? 'lttb' : undefined,
      lineStyle: { width: 2.4, color, type: yIdx === 1 ? 'dashed' : 'solid' },
      itemStyle: { color, borderColor: t.bg, borderWidth: 2 },
      label: showLabels ? {
        show: true,
        position: 'top',
        fontSize: 10,
        fontWeight: 600,
        color: t.text,
        formatter: (params) => {
          const v = typeof params.value === 'number' ? params.value : parseFloat(params.value);
          if (!Number.isFinite(v) || v === 0) return '';
          if (isMoneySeries) return fmtLakhsAxis(v);
          return formatCompactNumber(v);
        },
      } : { show: false },
      areaStyle: yIdx === 0 && !fc ? {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: color + (t.isDark ? '40' : '40') },
            { offset: 1, color: color + '00' },
          ],
        },
      } : (yIdx === 0 && fc ? {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: color + (t.isDark ? '35' : '35') },
            { offset: 1, color: color + '00' },
          ],
        },
      } : undefined),
      connectNulls: false,
      emphasis: { focus: 'series' },
      data: nullPad(histData),
      z: 2,
    });
  });

  if (fc && forecastTargetCol) {
    const fcColor = t.series[(valueCols.length) % t.series.length];
    const blank = new Array(rows.length).fill(null);
    const fut = fc.values.map((v) => scaleSaleValue(v, forecastTargetCol) || 0);
    series.push({
      name: 'Forecast',
      type: 'line',
      yAxisIndex: dualAxis && isCountKey(forecastTargetCol) ? 1 : 0,
      smooth: true,
      symbol: 'emptyCircle',
      symbolSize: 5,
      lineStyle: { width: 2.6, color: fcColor, type: 'dashed' },
      itemStyle: { color: fcColor, borderColor: t.bg, borderWidth: 1 },
      emphasis: { focus: 'series' },
      data: [...blank, ...fut],
      z: 3,
    });
  }

  const showZoom = n > 24;
  const yAxisLeft = {
    type: 'value',
    name: dualAxis ? '₹ Lakhs' : '',
    nameTextStyle: { color: t.textMuted, fontSize: 10 },
    axisLabel: { color: t.textMuted, fontSize: 11, formatter: hasMoneyColLine ? fmtLakhsAxis : v => formatNum(v) },
    axisLine: { show: false },
    splitLine: { lineStyle: { color: t.grid, type: 'dashed' } },
  };
  if (!dualAxis && valueAxisMaxRaw != null && Number.isFinite(Number(valueAxisMaxRaw)) && valueCols.length) {
    const refCol = valueCols.find((c) => isSaleValueKey(c)) || valueCols[0];
    const scaled = scaleSaleValue(valueAxisMaxRaw, refCol);
    if (Number.isFinite(scaled) && scaled > 0) {
      yAxisLeft.max = scaled;
    }
  }
  const yAxisRight = dualAxis ? {
    type: 'value',
    name: 'Count',
    nameTextStyle: { color: t.textMuted, fontSize: 10 },
    position: 'right',
    alignTicks: true,
    axisLabel: { color: t.textMuted, fontSize: 11, formatter: v => formatCompactNumber(v) },
    axisLine: { show: false },
    splitLine: { show: false },
  } : null;

  const opt = {
    ...baseEchartsOption(t, { grid: { top: 36, right: dualAxis ? 64 : 24, bottom: showZoom ? 60 : 30, left: 16 } }),
    xAxis: {
      type: 'category',
      data: labelsExt,
      boundaryGap: false,
      /* interval:0 = show exactly the ticks that match data points; prevents phantom repeated labels
         for single-day or small-range views */
      axisLabel: {
        color: t.text,
        fontSize: 11,
        hideOverlap: true,
        /* Show every bucket when moderately sparse so trends stay readable */
        interval: labelsExt.length <= 24 ? 0 : labelsExt.length <= 48 ? 1 : 'auto',
        rotate: labelsExt.length > 18 ? 32 : 0,
        formatter: v => fmtLabel(v),
      },
      axisLine: { lineStyle: { color: t.gridStrong } },
      axisTick: { show: false },
    },
    yAxis: dualAxis ? [yAxisLeft, yAxisRight] : yAxisLeft,
    series,
    dataZoom: showZoom ? [
      { type: 'inside', startValue: Math.max(0, n - 60), endValue: n - 1 },
      { type: 'slider', height: 18, bottom: 12,
        fillerColor: t.isDark ? 'rgba(96,165,250,.15)' : 'rgba(37,99,235,.10)',
        borderColor: 'transparent', backgroundColor: 'transparent',
        handleStyle: { color: t.series[0] }, textStyle: { color: t.textMuted, fontSize: 10 } },
    ] : undefined,
  };

  return (
    <div className="fade-in">
      {title && <p className="text-xs font-semibold mb-2 uppercase tracking-wider" style={{color:'var(--text-muted)'}}>{title}</p>}
      {fc && (
        <p className="text-[11px] mb-1" style={{color:'var(--text-soft)'}}>
          <span className="font-medium" style={{ color: t.text }}>Forecast</span>
          {' — '}{String(fc.method || '').replace(/_/g, ' ')}
          {' · '}{fc.horizon} {fc.granularity === 'month' ? 'months' : 'days'} ahead
          {fc.disclaimer ? ' — statistical projection only.' : ''}
        </p>
      )}
      {dualAxis && (
        <p className="text-[11px] mb-1" style={{color:'var(--text-soft)'}}>
          Left axis: ₹ Lakhs &nbsp;|&nbsp; Right axis: Count (dashed lines)
        </p>
      )}
      {!dualAxis && valueCols.length > 1 && valueCols.every(c => isSaleValueKey(c)) && (
        <p className="text-[11px] mb-1" style={{color:'var(--text-soft)'}}>
          All values in ₹ Lakhs &nbsp;·&nbsp; {valueCols.length} series
        </p>
      )}
      {showZoom && (
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:4 }}>
          <button
            title="Reset zoom — show recent data"
            onClick={() => {
              const inst = chartInstRef.current;
              if (!inst) return;
              inst.dispatchAction({
                type: 'dataZoom',
                batch: [
                  { dataZoomIndex: 0, startValue: Math.max(0, n - 60), endValue: n - 1 },
                  { dataZoomIndex: 1, startValue: Math.max(0, n - 60), endValue: n - 1 },
                ],
              });
              requestAnimationFrame(() => { try { inst.resize(); } catch {} });
            }}
            style={{
              fontSize: 11, padding: '2px 10px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--surface2)', color: 'var(--text-muted)', cursor: 'pointer',
              fontWeight: 600, display:'flex', alignItems:'center', gap:4,
            }}
          >⊡ Fit</button>
        </div>
      )}
      <EChart option={opt} height={360} onPointClick={onPointClick}
        onInit={(inst) => { chartInstRef.current = inst; }} />
    </div>
  );
}

/* ═══════════════════════════════════════════════
   PIE / DONUT CHART
═══════════════════════════════════════════════ */
const PIE_MAX_SLICES = 9; // default named slices; rest → "Others" (override via maxSlices prop)

function PieChart({ rows, labelCol, valueCol, title, maxSlices = PIE_MAX_SLICES }) {
  const pieCap = Math.max(1, parseInt(String(maxSlices), 10) || PIE_MAX_SLICES);
  const [, force] = useState(0);
  const [othersModal, setOthersModal] = useState(false);
  const [othersItems, setOthersItems] = useState([]);
  const [othersSearch, setOthersSearch] = useState('');

  useEffect(() => {
    const fn = () => force(x => x + 1);
    window.addEventListener('erp-theme-change', fn);
    return () => window.removeEventListener('erp-theme-change', fn);
  }, []);

  const t = buildEchartsTheme();
  const isMoney = isSaleValueKey(valueCol);

  // Build full data array sorted by value descending
  const allData = rows
    .map(r => ({
      name: fmtLabel(String(r[labelCol] ?? '')),
      value: Math.abs(scaleSaleValue(r[valueCol], valueCol) || 0),
    }))
    .filter(d => d.value > 0)
    .sort((a, b) => b.value - a.value);

  if (allData.length === 0) return null;

  // Group small slices into "Others" when there are too many
  let data = allData;
  let restItems = [];
  let othersCount = 0;
  let othersNote = null;
  const grandTotal = allData.reduce((s, d) => s + d.value, 0);
  if (allData.length > pieCap) {
    const top = allData.slice(0, pieCap);
    restItems = allData.slice(pieCap);
    othersCount = restItems.length;
    const othersVal = restItems.reduce((s, d) => s + d.value, 0);
    const othersLabel = `Others (${othersCount})`;
    data = [...top, {
      name: othersLabel,
      value: othersVal,
      itemStyle: {
        color: t.isDark ? '#475569' : '#94a3b8',
        borderColor: t.bg, borderWidth: 3, borderRadius: 4,
      },
      emphasis: { itemStyle: { color: t.isDark ? '#64748b' : '#64748b' } },
    }];
    othersNote = `Top ${pieCap} of ${allData.length} items shown — click "Others" slice or link to see the rest`;
  }

  // Handle click on pie slices — open modal when "Others" slice is clicked
  const handlePieClick = (params) => {
    if (params && params.name && params.name.startsWith('Others (')) {
      setOthersItems(restItems);
      setOthersSearch('');
      setOthersModal(true);
    }
  };

  const opt = {
    ...baseEchartsOption(t, { trigger: 'item', grid: { top: 0, right: 0, bottom: 0, left: 0 } }),
    legend: {
      orient: 'vertical', right: 8, top: 'middle',
      textStyle: { color: t.textMuted, fontSize: 11, fontWeight: 600 },
      itemGap: 10, icon: 'circle',
    },
    series: [{
      type: 'pie',
      radius: ['52%', '78%'],
      center: ['38%', '50%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: t.bg, borderWidth: 3, borderRadius: 4 },
      label: { show: true, formatter: '{b}\n{d}%', color: t.text, fontSize: 11, fontWeight: 600 },
      labelLine: { length: 10, length2: 10, lineStyle: { color: t.textMuted } },
      emphasis: { scale: true, scaleSize: 6, label: { fontSize: 12, fontWeight: 700 } },
      data,
    }],
  };

  const filteredItems = othersSearch.trim()
    ? othersItems.filter(it => it.name.toLowerCase().includes(othersSearch.trim().toLowerCase()))
    : othersItems;

  const totalOthersVal = othersItems.reduce((s, d) => s + d.value, 0);

  return (
    <div className="fade-in">
      {title && <p className="text-xs font-semibold mb-2 uppercase tracking-wider" style={{color:'var(--text-muted)'}}>{title}</p>}
      <EChart option={opt} height={320} onPointClick={handlePieClick} />
      {othersNote && (
        <p
          onClick={() => { setOthersItems(restItems); setOthersSearch(''); setOthersModal(true); }}
          style={{
            fontSize:11, color:'var(--brand,#2563eb)', marginTop:6, textAlign:'center',
            background:'var(--bg-muted,#f1f5f9)', borderRadius:6, padding:'4px 10px',
            fontStyle:'italic', cursor:'pointer', textDecoration:'underline dotted',
          }}
          title="Click to view all grouped items"
        >
          ℹ️ {othersNote}
        </p>
      )}

      {/* ── Others Modal ── */}
      {othersModal && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setOthersModal(false); }}
          style={{
            position:'fixed', inset:0, zIndex:9999,
            background:'rgba(0,0,0,0.65)',
            backdropFilter:'blur(6px)',
            display:'flex', alignItems:'center', justifyContent:'center',
            padding:16,
          }}
        >
          <div className="pie-others-modal-panel" style={{
            background:'#ffffff',
            borderRadius:20,
            width:'100%', maxWidth:540,
            maxHeight:'82vh',
            display:'flex', flexDirection:'column',
            boxShadow:'0 32px 80px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.05)',
            overflow:'hidden',
            color:'#0f172a',
          }}>
            {/* ── Gradient Header ── */}
            <div style={{
              background:'linear-gradient(135deg,#4f46e5 0%,#7c3aed 50%,#9333ea 100%)',
              padding:'18px 20px 16px',
              position:'relative', overflow:'hidden',
            }}>
              {/* Decorative blobs */}
              <div style={{position:'absolute',top:-30,right:-20,width:100,height:100,borderRadius:'50%',background:'rgba(255,255,255,0.07)'}}/>
              <div style={{position:'absolute',bottom:-40,left:-10,width:80,height:80,borderRadius:'50%',background:'rgba(255,255,255,0.05)'}}/>

              <div style={{position:'relative', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12}}>
                <div>
                  <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:6}}>
                    <span style={{fontSize:18}}>📋</span>
                    <h2 style={{margin:0, fontSize:17, fontWeight:800, color:'#fff', letterSpacing:'-0.3px'}}>
                      Others — {othersItems.length} items
                    </h2>
                  </div>
                  <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
                    <span style={{
                      fontSize:12, fontWeight:700, color:'rgba(255,255,255,0.9)',
                      background:'rgba(255,255,255,0.15)', padding:'3px 10px', borderRadius:12,
                    }}>
                      Group total: {isMoney ? '₹ ' + totalOthersVal.toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' L' : totalOthersVal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </span>
                    <span style={{
                      fontSize:12, fontWeight:700, color:'rgba(255,255,255,0.7)',
                      background:'rgba(255,255,255,0.10)', padding:'3px 10px', borderRadius:12,
                    }}>
                      {grandTotal > 0 ? (totalOthersVal / grandTotal * 100).toFixed(1) + '% of grand total' : ''}
                    </span>
                    <span style={{fontSize:11, fontWeight:600, color:'rgba(255,255,255,0.5)'}}>
                      Ranked #{pieCap + 1}–#{pieCap + othersItems.length}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setOthersModal(false)}
                  style={{
                    border:'1.5px solid rgba(255,255,255,0.3)',
                    background:'rgba(255,255,255,0.12)',
                    borderRadius:10, width:34, height:34,
                    fontSize:18, cursor:'pointer', color:'rgba(255,255,255,0.85)',
                    display:'flex', alignItems:'center', justifyContent:'center',
                    flexShrink:0, lineHeight:1, transition:'all 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.22)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.12)'; }}
                >×</button>
              </div>
            </div>

            {/* ── Search box (fixed light surface — theme vars are wrong on white in dark mode) ── */}
            <div className="pie-others-modal-search-strip" style={{padding:'12px 16px', borderBottom:'1px solid #e2e8f0', background:'#ffffff'}}>
              <div style={{position:'relative'}}>
                <span style={{
                  position:'absolute', left:11, top:'50%', transform:'translateY(-50%)',
                  fontSize:14, color:'#64748b', pointerEvents:'none',
                }}>🔍</span>
                <input
                  type="text"
                  value={othersSearch}
                  onChange={e => setOthersSearch(e.target.value)}
                  placeholder={`Search ${othersItems.length} items…`}
                  autoFocus
                  style={{
                    width:'100%', boxSizing:'border-box',
                    border:'1.5px solid #cbd5e1',
                    borderRadius:12, padding:'8px 12px 8px 34px',
                    fontSize:13, outline:'none',
                    color:'#0f172a', background:'#f8fafc',
                    transition:'border-color 0.15s',
                  }}
                  onFocus={e => { e.target.style.borderColor = '#6366f1'; }}
                  onBlur={e => { e.target.style.borderColor = '#cbd5e1'; }}
                />
                {othersSearch && (
                  <button
                    onClick={() => setOthersSearch('')}
                    style={{
                      position:'absolute', right:10, top:'50%', transform:'translateY(-50%)',
                      border:'none', background:'#e2e8f0', borderRadius:'50%',
                      width:20, height:20, fontSize:12, cursor:'pointer',
                      color:'#475569', display:'flex', alignItems:'center', justifyContent:'center',
                    }}
                  >✕</button>
                )}
              </div>
              {othersSearch && (
                <p style={{margin:'6px 0 0', fontSize:11, color:'#64748b', fontWeight:500}}>
                  {filteredItems.length} of {othersItems.length} match
                </p>
              )}
            </div>

            {/* ── Table ── */}
            <div style={{overflowY:'auto', flex:1, background:'#ffffff'}}>
              {filteredItems.length === 0 ? (
                <div style={{padding:32, textAlign:'center', background:'#ffffff'}}>
                  <p style={{fontSize:28, marginBottom:8}}>🔍</p>
                  <p style={{fontSize:13, color:'#475569', fontWeight:600}}>No items match "{othersSearch}"</p>
                </div>
              ) : (
                <table className="pie-others-modal-table" style={{width:'100%', borderCollapse:'collapse', background:'#ffffff'}}>
                  <thead>
                    <tr style={{background:'#f1f5f9', borderBottom:'2px solid #e2e8f0'}}>
                      <th style={{textAlign:'center', padding:'8px 10px', color:'#475569', fontWeight:700, fontSize:10, textTransform:'uppercase', letterSpacing:'0.05em', width:36}}>#</th>
                      <th style={{textAlign:'left', padding:'8px 12px', color:'#475569', fontWeight:700, fontSize:10, textTransform:'uppercase', letterSpacing:'0.05em'}}>Name</th>
                      <th style={{textAlign:'right', padding:'8px 12px', color:'#475569', fontWeight:700, fontSize:10, textTransform:'uppercase', letterSpacing:'0.05em', whiteSpace:'nowrap'}}>Value</th>
                      <th style={{textAlign:'right', padding:'8px 8px', color:'#475569', fontWeight:700, fontSize:10, textTransform:'uppercase', letterSpacing:'0.05em', width:110}}>
                        <div style={{display:'flex', flexDirection:'column', alignItems:'flex-end', gap:1}}>
                          <span style={{color:'#6366f1'}}>of Others</span>
                          <span style={{color:'#10b981'}}>of Total</span>
                        </div>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.map((item, idx) => {
                      const sharePct      = totalOthersVal > 0 ? (item.value / totalOthersVal) * 100 : 0;
                      const totalSharePct = grandTotal > 0 ? (item.value / grandTotal) * 100 : 0;
                      const shareStr      = sharePct.toFixed(1);
                      const totalShareStr = totalSharePct.toFixed(2);
                      const valFmt = isMoney
                        ? '₹ ' + item.value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' L'
                        : item.value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
                      const rankColor = sharePct >= 7 ? '#4f46e5' : sharePct >= 4 ? '#059669' : '#475569';
                      return (
                        <tr key={idx} style={{
                          borderBottom:'1px solid #f1f5f9',
                          background:'#ffffff',
                          transition:'background 0.1s',
                        }}>
                          {/* Rank */}
                          <td style={{padding:'9px 10px', textAlign:'center'}}>
                            <span className="pom-rank" style={{
                              fontSize:11, fontWeight:700,
                              color:'#334155',
                              background:'#e2e8f0',
                              borderRadius:6, padding:'2px 6px',
                              display:'inline-block', minWidth:24, textAlign:'center',
                            }}>
                              {pieCap + idx + 1}
                            </span>
                          </td>
                          {/* Name */}
                          <td style={{padding:'9px 12px'}}>
                            <span className="pom-name" style={{fontSize:13, fontWeight:600, color:'#0f172a'}}>{item.name}</span>
                          </td>
                          {/* Value */}
                          <td style={{padding:'9px 12px', textAlign:'right'}}>
                            <span className="pom-value" style={{
                              fontSize:13, fontWeight:700, color:'#0f172a',
                              fontVariantNumeric:'tabular-nums',
                            }}>{valFmt}</span>
                          </td>
                          {/* Two-tier share: within-Others + within-Grand-Total */}
                          <td style={{padding:'9px 10px', textAlign:'right'}}>
                            <div style={{display:'flex', flexDirection:'column', alignItems:'flex-end', gap:3}}>
                              {/* Within Others bar */}
                              <div style={{display:'flex', alignItems:'center', gap:4}}>
                                <div style={{width:36, height:4, borderRadius:3, background:'#e2e8f0', overflow:'hidden'}}>
                                  <div style={{width:`${Math.min(sharePct * 2, 100)}%`, height:'100%', borderRadius:3, background:'linear-gradient(90deg,#6366f1,#8b5cf6)', transition:'width 0.3s ease'}}/>
                                </div>
                                <span className="pom-pct-others" style={{ ['--pom-pct-others']: rankColor, fontSize:11, fontWeight:800, color: rankColor, minWidth:34, textAlign:'right'}}>{shareStr}%</span>
                              </div>
                              {/* Within Total bar */}
                              <div style={{display:'flex', alignItems:'center', gap:4}}>
                                <div style={{width:36, height:4, borderRadius:3, background:'#e2e8f0', overflow:'hidden'}}>
                                  <div style={{width:`${Math.min(totalSharePct * 10, 100)}%`, height:'100%', borderRadius:3, background:'#10b981', transition:'width 0.3s ease'}}/>
                                </div>
                                <span className="pom-pct-total" style={{fontSize:10, fontWeight:700, color:'#047857', minWidth:34, textAlign:'right'}}>{totalShareStr}%</span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* ── Footer ── */}
            <div className="pie-others-modal-footer" style={{
              padding:'10px 16px', borderTop:'1px solid #e2e8f0',
              display:'flex', alignItems:'center', justifyContent:'space-between',
              background:'#f8fafc',
            }}>
              <div style={{margin:0}}>
                <div style={{display:'flex', gap:12, marginBottom:2}}>
                  <span className="pom-legend-others" style={{fontSize:10, fontWeight:700, color:'#4f46e5'}}>■ % of Others group</span>
                  <span className="pom-legend-total" style={{fontSize:10, fontWeight:700, color:'#047857'}}>■ % of Grand Total</span>
                </div>
                <p className="pom-legend-hint" style={{margin:0, fontSize:10, color:'#64748b'}}>Hover any row to highlight</p>
              </div>
              <button
                onClick={() => setOthersModal(false)}
                style={{
                  border:'1px solid #cbd5e1', background:'#ffffff',
                  borderRadius:8, padding:'5px 14px', fontSize:12, fontWeight:700,
                  cursor:'pointer', color:'#0f172a', transition:'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor='#6366f1'; e.currentTarget.style.color='#4f46e5'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor='#cbd5e1'; e.currentTarget.style.color='#0f172a'; }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const MemoBarChart = typeof React.memo === "function" ? React.memo(BarChart) : BarChart;
const MemoLineChart = typeof React.memo === "function" ? React.memo(LineChart) : LineChart;
const MemoPieChart = typeof React.memo === "function" ? React.memo(PieChart) : PieChart;

/* (legacy SVG chart implementations removed — replaced by ECharts above) */

/* ═══════════════════════════════════════════════
   SMART CHART ROUTER
═══════════════════════════════════════════════ */
/* ── Chart-type switcher pill ── */
const ChartTypePicker = React.memo(function ChartTypePicker({ active, onChange }) {
  const opts = [
    { type: 'bar',  icon: '📊', label: 'Bar'  },
    { type: 'line', icon: '📈', label: 'Line' },
    { type: 'pie',  icon: '🥧', label: 'Pie'  },
  ];
  return (
    <div style={{
      display:'flex', gap:2, background:'var(--bg-muted,#f1f5f9)',
      borderRadius:12, padding:3, flexShrink:0,
    }}>
      {opts.map(({ type, icon, label }) => {
        const isActive = active === type;
        return (
          <button
            key={type}
            onClick={() => onChange(type)}
            title={`Switch to ${label} chart`}
            style={{
              padding:'4px 11px', borderRadius:9, border:'none', cursor:'pointer',
              fontSize:11, fontWeight:700, display:'flex', alignItems:'center', gap:4,
              background: isActive ? 'var(--brand,#2563eb)' : 'transparent',
              color:      isActive ? '#fff' : 'var(--text-muted,#64748b)',
              transition: 'all 0.15s ease',
              boxShadow:  isActive ? '0 2px 6px rgba(99,102,241,.35)' : 'none',
            }}
          >
            <span>{icon}</span>{label}
          </button>
        );
      })}
    </div>
  );
});

/** Bar only: which axis shows category labels (X = vertical bars, Y = horizontal bars). */
const BarAxisPicker = React.memo(function BarAxisPicker({ active, onChange }) {
  const opts = [
    { v: 'auto', label: 'Auto', title: 'Smart: long lists use categories on Y (horizontal bars); short use X' },
    { v: 'vertical', label: 'Cat. on X', title: 'Vertical bars — category names on the bottom (X axis)' },
    { v: 'horizontal', label: 'Cat. on Y', title: 'Horizontal bars — category names on the left (Y axis)' },
  ];
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:6, flexWrap:'wrap', justifyContent:'flex-end',
    }}>
      <span style={{ fontSize:10, fontWeight:700, color:'var(--text-muted,#64748b)', textTransform:'uppercase', letterSpacing:'.04em' }}>Bar axis</span>
      <div style={{
        display:'flex', gap:2, background:'var(--bg-muted,#f1f5f9)',
        borderRadius:12, padding:3, flexShrink:0,
      }}>
        {opts.map(({ v, label, title: tip }) => {
          const isActive = active === v;
          return (
            <button
              key={v}
              onClick={() => onChange(v)}
              title={tip}
              style={{
                padding:'3px 9px', borderRadius:9, border:'none', cursor:'pointer',
                fontSize:10, fontWeight:700, whiteSpace:'nowrap',
                background: isActive ? 'var(--chart-axis-active,#0ea5e9)' : 'transparent',
                color:      isActive ? '#fff' : 'var(--text-muted,#64748b)',
                transition: 'all 0.15s ease',
                boxShadow:  isActive ? '0 1px 4px rgba(14,165,233,.35)' : 'none',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
});

function SmartChart({ rows, label, chartPolicyHint, columnTags }) {
  // Keep global tags in sync with this chart's props — clearing when absent avoids
  // Analytics columnTags (money/count) sticking around on Load Dataset rows with the same names.
  useEffect(() => {
    setGlobalColTags(columnTags != null && typeof columnTags === "object" ? columnTags : {});
  }, [columnTags]);

  // detectChart as fallback only — backend shape detection drives type when available
  const cfg = useMemo(() => detectChart(rows), [rows]);

  /* Map server chartPolicy → local type name */
  function policyToType(policy) {
    if (!policy || policy === 'auto' || policy === 'kpi_card') return null;
    if (policy === 'line') return 'line';
    if (policy === 'bar') return 'bar';
    if (policy === 'pie') return 'pie';
    return null;
  }

  /* User-chosen override; null = trust policy/auto-detect */
  const [override, setOverride] = useState(null);
  const [barAxis, setBarAxis] = useState('vertical');

  if (!cfg) return null;

  /* Priority: user override > server chartPolicy (shape-based) > auto-detected */
  const policyType  = policyToType(chartPolicyHint);
  const type        = override || policyType || cfg.type;
  const typeIcons   = { bar:'📊', line:'📈', pie:'🥧' };
  const sourceLabel = override ? 'user' : policyType ? 'shape-detected' : 'auto';

  /* Derive label/value cols from tags when available (not just name-regex) */
  const allCols = rows.length > 0 ? Object.keys(rows[0]) : [];
  const taggedLabelCol = columnTags
    ? (
        // Prefer 'period'/'label' cols first (comparison queries)
        allCols.find(c => columnTags[c] === 'text' && /^(period|label|range|periodlabel)$/i.test(c)) ||
        // Then any text col that isn't an ID
        allCols.find(c => columnTags[c] === 'text' && columnTags[c] !== 'id') ||
        // Then date col (trend queries)
        allCols.find(c => columnTags[c] === 'date')
      )
    : null;
  const taggedValueCols = columnTags
    ? allCols.filter(c =>
        (columnTags[c] === 'money' || columnTags[c] === 'count' || columnTags[c] === 'ratio') &&
        !isNonAggregableDigitKey(c)
      )
    : null;

  const effectiveLabelCol = taggedLabelCol || cfg.labelCol;
  const rawTaggedVals = (taggedValueCols && taggedValueCols.length > 0) ? taggedValueCols : null;
  const cfgVals = filterTxnLineValueCols(rows, (cfg.valueCols || []).filter(c => !isNonAggregableDigitKey(c)));
  const effectiveValueCols = filterTxnLineValueCols(rows, rawTaggedVals || cfgVals);
  const pieValCol = effectiveValueCols[0];

  if (!effectiveValueCols || effectiveValueCols.length === 0) return null;

  const chartAggregated = shouldAggregateChartRows(rows, effectiveLabelCol);
  const chartRows = chartAggregated
    ? aggregateRowsByLabel(rows, effectiveLabelCol, effectiveValueCols)
    : rows;
  const chartDidAggregate = chartAggregated && chartRows.length >= 2;
  const chartDisplayRows = chartDidAggregate ? chartRows : rows;
  const chartTitle = chartDidAggregate
    ? `${cfg.title} (summed by ${effectiveLabelCol})`
    : cfg.title;

  /* Warn when user manually picks pie but there are too many unique labels */
  const pieTooManyRows = type === 'pie' && override === 'pie' && rows.length > PIE_MAX_SLICES * 2;
  const pieTooManyNote = pieTooManyRows
    ? `${rows.length} items — top ${PIE_MAX_SLICES} shown, rest grouped as "Others". Bar chart shows all.`
    : null;

  /* Annotate value columns with money/count tag for display */
  function formatColLabel(col) {
    const tag = columnTags && columnTags[col];
    if (!tag) return col;
    const tagIcons = { money: ' ₹', count: ' #', ratio: ' %', date: ' 📅', id: ' 🔑', text: '' };
    return col + (tagIcons[tag] || '');
  }

  return (
    <div className="chart-wrapper mt-4 fade-in w-full min-w-0">
      {/* header row */}
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span style={{fontSize:18}}>{typeIcons[type]}</span>
          <p className="text-sm font-bold truncate" style={{color:'var(--text-strong)'}}>{label || 'Chart'}</p>
          <span style={{
            fontSize:10, padding:'2px 8px', borderRadius:20, whiteSpace:'nowrap',
            background:'var(--brand-soft,#eef2ff)', color:'var(--brand,#2563eb)', fontWeight:700,
          }}>{type} ({sourceLabel})</span>
          {pieTooManyNote && (
            <span style={{
              fontSize:10, padding:'2px 8px', borderRadius:20, whiteSpace:'nowrap',
              background:'#fff7ed', color:'#c2410c', fontWeight:700, border:'1px solid #fed7aa',
            }}>⚠️ {pieTooManyNote}</span>
          )}
        </div>
        <div className="flex items-center flex-wrap gap-2 justify-end">
          {type === 'bar' && <BarAxisPicker active={barAxis} onChange={setBarAxis} />}
          <ChartTypePicker active={type} onChange={setOverride} />
        </div>
      </div>

      {/* chart area — uses tag-derived cols when available, detectChart as fallback */}
      {chartDidAggregate && (
        <p className="text-[10px] mb-2" style={{color:'var(--text-muted)'}}>
          Chart aggregates {rows.length.toLocaleString()} line rows by <strong>{effectiveLabelCol}</strong> ({chartDisplayRows.length} groups).
        </p>
      )}
      {type === 'bar'  && <BarChart  rows={chartDisplayRows} labelCol={effectiveLabelCol} valueCols={effectiveValueCols} title={chartTitle} barOrientation={barAxis} />}
      {type === 'line' && <LineChart rows={chartDisplayRows} labelCol={effectiveLabelCol} valueCols={effectiveValueCols} title={chartTitle} />}
      {type === 'pie'  && <PieChart  rows={chartDisplayRows} labelCol={effectiveLabelCol} valueCol={pieValCol}           title={chartTitle} />}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   ChartWithToggle — Bar/Line/Pie toggle, default=line
═══════════════════════════════════════════════ */
function trendMoneyAxisMax(rows, cols) {
  let max = 0;
  for (const r of rows || []) {
    for (const c of cols || []) {
      if (!isSaleValueKey(c)) continue;
      max = Math.max(max, parseFloat(r[c]) || 0);
    }
  }
  return max > 0 ? max * 1.08 : null;
}

function ChartWithToggle({ rows, labelCol, valueCols, valueCol, title, icon, defaultChartType = 'line', valueAxisMaxRaw = null }) {
  const [chartType, setChartType] = useState(defaultChartType);
  const pieCol = valueCol || (valueCols && valueCols[0]);
  if (!rows || rows.length === 0) return null;

  const allCols = valueCols || (valueCol ? [valueCol] : []);
  const primaryCol = allCols[0];
  const axisMaxRaw = valueAxisMaxRaw != null ? valueAxisMaxRaw : trendMoneyAxisMax(rows, allCols);

  // Compute per-column totals and top performer for the summary strip
  const colSummaries = allCols.map(col => {
    const vals = rows.map(r => parseFloat(r[col]) || 0).filter(v => v > 0);
    const total = vals.reduce((s, v) => s + v, 0);
    const isMoney = isSaleValueKey(col);
    const fmt = isMoney
      ? fmtRupee(total)
      : total >= 1e6 ? (total / 1e6).toFixed(1) + 'M' : total >= 1000 ? (total / 1000).toFixed(1) + 'K' : total.toFixed(0);
    return { col, total, fmt, isMoney };
  }).filter(s => s.total > 0);

  // Top performer for primary col
  const topPerf = (() => {
    if (!primaryCol || rows.length < 2) return null;
    const sorted = [...rows].sort((a, b) => (parseFloat(b[primaryCol]) || 0) - (parseFloat(a[primaryCol]) || 0));
    const top = sorted[0];
    const topVal = parseFloat(top[primaryCol]) || 0;
    const total = colSummaries.find(s => s.col === primaryCol)?.total || 0;
    const pct = total > 0 ? ((topVal / total) * 100).toFixed(1) : '0';
    return { label: String(top[labelCol] || '—'), pct };
  })();

  const typeOpts = [
    { v: 'bar',  icon: '📊', label: 'Bar'  },
    { v: 'line', icon: '📈', label: 'Line' },
    { v: 'pie',  icon: '🥧', label: 'Pie'  },
  ];

  // Legend dots for multi-series
  const seriesColors = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#0ea5e9'];

  return (
    <div style={{ marginBottom: 24 }}>
      {/* ── Title row ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8, flexWrap:'wrap', gap:8 }}>
        <p style={{ fontWeight:700, fontSize:14, color:'var(--text-strong)', margin:0 }}>
          {icon && <span style={{ marginRight:6 }}>{icon}</span>}{title}
        </p>
        <div style={{
          display:'flex', gap:2, background:'var(--surface2,rgba(100,116,139,0.08))', borderRadius:10,
          padding:3, border:'1px solid var(--border)',
        }}>
          {typeOpts.map(({ v, icon: ic, label }) => (
            <button key={v} onClick={() => setChartType(v)} style={{
              padding:'4px 12px', borderRadius:8, border:'none', cursor:'pointer',
              fontSize:11, fontWeight:700, display:'flex', alignItems:'center', gap:4,
              background: chartType === v ? 'var(--brand,#6366f1)' : 'transparent',
              color:      chartType === v ? '#fff' : 'var(--text-muted,#64748b)',
              transition: 'all 0.15s ease',
              boxShadow:  chartType === v ? '0 1px 6px rgba(124,58,237,.4)' : 'none',
            }}>
              <span>{ic}</span><span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Data summary strip ── */}
      {colSummaries.length > 0 && (
        <div style={{
          display:'flex', alignItems:'center', flexWrap:'wrap', gap:6, marginBottom:10,
        }}>
          {/* Per-column totals */}
          {colSummaries.map((s, i) => (
            <div key={s.col} style={{
              display:'inline-flex', alignItems:'center', gap:5,
              padding:'4px 10px', borderRadius:20,
              background: i === 0 ? 'rgba(99,102,241,0.1)' : 'var(--bg-muted,rgba(100,116,139,0.08))',
              border: i === 0 ? '1px solid rgba(99,102,241,0.25)' : '1px solid var(--border)',
            }}>
              <span style={{
                width:8, height:8, borderRadius:'50%', flexShrink:0,
                background: seriesColors[i % seriesColors.length],
                boxShadow: `0 0 4px ${seriesColors[i % seriesColors.length]}88`,
              }}/>
              <span style={{ fontSize:11, fontWeight:600, color:'var(--text-muted,#64748b)' }}>
                {chartSeriesDisplayName(s.col)}
              </span>
              <span style={{
                fontSize:12, fontWeight:800,
                color: i === 0 ? 'var(--brand,#6366f1)' : 'var(--text-strong)',
              }}>
                {s.fmt}
              </span>
            </div>
          ))}

          {/* Divider */}
          {topPerf && colSummaries.length > 0 && (
            <span style={{color:'var(--border)', fontSize:14}}>·</span>
          )}

          {/* Items count */}
          <div style={{
            display:'inline-flex', alignItems:'center', gap:4,
            padding:'4px 10px', borderRadius:20,
            background:'var(--bg-muted,rgba(100,116,139,0.08))',
            border:'1px solid var(--border)',
          }}>
            <span style={{ fontSize:11, color:'var(--text-muted,#64748b)', fontWeight:600 }}>
              {rows.length} {rows.length === 1 ? 'item' : 'items'}
            </span>
          </div>

          {/* Top performer */}
          {topPerf && (
            <div style={{
              display:'inline-flex', alignItems:'center', gap:5,
              padding:'4px 10px', borderRadius:20,
              background:'rgba(16,185,129,0.08)', border:'1px solid rgba(16,185,129,0.2)',
            }}>
              <span style={{ fontSize:11 }}>🏆</span>
              <span style={{ fontSize:11, color:'var(--text-muted,#64748b)', fontWeight:600 }}>Top:</span>
              <span style={{ fontSize:11, fontWeight:800, color:'#059669', maxWidth:120, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {topPerf.label}
              </span>
              <span style={{ fontSize:11, color:'var(--text-muted,#64748b)', fontWeight:600 }}>
                {topPerf.pct}%
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Chart ── */}
      {chartType === 'bar'  && <BarChart  rows={rows} labelCol={labelCol} valueCols={valueCols || [valueCol]} title={title} barOrientation="vertical" valueAxisMaxRaw={axisMaxRaw} />}
      {chartType === 'line' && <LineChart rows={rows} labelCol={labelCol} valueCols={valueCols || [valueCol]} title={title} valueAxisMaxRaw={axisMaxRaw} />}
      {chartType === 'pie'  && <PieChart  rows={rows} labelCol={labelCol} valueCol={pieCol}                   title={title} />}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   THEME TOGGLE — sun/moon pill that lives in the header
═══════════════════════════════════════════════ */
function ThemeToggle({ theme, onToggle }) {
  const isDark = theme === 'dark';
  return (
    <button onClick={onToggle}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 14px', borderRadius: 20,
        border: '1.5px solid var(--border)',
        background: 'var(--surface2)',
        color: 'var(--text)',
        cursor: 'pointer', fontSize: 12, fontWeight: 700,
        transition: 'all 0.2s ease',
        boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.3)' : '0 1px 4px rgba(0,0,0,0.06)',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--brand)'; e.currentTarget.style.color = 'var(--brand)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text)'; }}
    >
      {isDark ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"/>
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      )}
      {isDark ? 'Light' : 'Dark'}
    </button>
  );
}

/* ═══════════════════════════════════════════════
   BASE COMPONENTS
═══════════════════════════════════════════════ */
function Spinner({ size = 16, color = '#6366f1' }) {
  return <span className="spin inline-block border-2 border-slate-200 rounded-full"
    style={{ width: size, height: size, borderTopColor: color, flexShrink:0 }} />;
}

function Alert({ type = "error", msg, onClose }) {
  if (!msg) return null;
  const cfg = {
    error:   { bg: "bg-red-50 border-red-200",    text: "text-red-700",   icon: "⛔" },
    ok:      { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", icon: "✅" },
    info:    { bg: "bg-blue-50 border-blue-200",   text: "text-blue-700",  icon: "ℹ️" },
    warning: { bg: "bg-amber-50 border-amber-200", text: "text-amber-800", icon: "⚠️" },
  }[type] || {};
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${cfg.bg} ${cfg.text} fade-in`}>
      <span className="mt-0.5 flex-shrink-0">{cfg.icon}</span>
      <span className="flex-1 leading-snug">{msg}</span>
      {onClose && <button onClick={onClose} className="opacity-50 hover:opacity-100 ml-1 flex-shrink-0">✕</button>}
    </div>
  );
}

function DataTable({ rows, maxHeight = "400px" }) {
  const [expanded, setExpanded] = useState(false);
  if (!rows || !rows.length) return <p className="text-slate-400 text-sm py-6 text-center">No rows returned.</p>;
  const headers = Object.keys(rows[0]);
  const effectiveMaxHeight = expanded ? "none" : maxHeight;
  return (
    <div>
      <div className="overflow-auto table-scroll rounded-xl border border-slate-200 touch-pan-x" style={{ maxHeight: effectiveMaxHeight }}>
        <table className="data-table">
          <thead>
            <tr>{headers.map(h => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
              {headers.map(h => (
                <td key={h} title={String(r[h] ?? "")}>
                  {r[h] === null || r[h] === undefined
                    ? <span className="text-slate-300">—</span>
                    : (() => {
                        const v = r[h];
                        // Format ISO date/datetime strings into readable dates
                        if (isISODateTimeString(v)) {
                          return <span style={{color:'var(--text-muted)', fontVariantNumeric:'tabular-nums'}}>{formatTableDateValue(v)}</span>;
                        }
                        if (shouldFormatTableNumeric(h, v)) {
                          return <span className="font-mono text-slate-700">{formatTableNumericValue(h, v)}</span>;
                        }
                        return String(v);
                      })()
                  }
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {rows.length > 10 && (
      <button
        onClick={() => setExpanded(e => !e)}
        className="btn-ghost text-xs w-full mt-1.5 justify-center"
        style={{display:'flex',alignItems:'center',gap:4}}
      >
        {expanded
          ? <><span>▲</span> Collapse table</>
          : <><span>▼</span> Show all {rows.length} rows (expand)</>}
      </button>
    )}
    </div>
  );
}

function StatsBar({ rows, masterOnly, datasetKey }) {
  if (!rows || rows.length === 0) return null;

  if (rowsLookLikeCustomerMaster(rows) || String(datasetKey || '').toLowerCase() === 'customers') {
    const mobileKey = Object.keys(rows[0]).find((k) => /^contactmobile$/i.test(k));
    const emailKey = Object.keys(rows[0]).find((k) => /^contactemail$/i.test(k));
    const activeKey = Object.keys(rows[0]).find((k) => /^activestatus$/i.test(k));
    let withMobile = 0;
    let withEmail = 0;
    let activeCount = 0;
    let creditPositive = 0;
    for (const r of rows) {
      if (mobileKey && String(r[mobileKey] || '').trim()) withMobile += 1;
      if (emailKey && String(r[emailKey] || '').trim()) withEmail += 1;
      if (activeKey) {
        const a = r[activeKey];
        if (a === true || a === 1 || String(a).toLowerCase() === 'true') activeCount += 1;
      }
      const cl = parseFloat(r.CreditLimit ?? r.creditlimit);
      if (Number.isFinite(cl) && cl > 0) creditPositive += 1;
    }
    const branches = distinctColumnCount(rows, /^branchname$/i);

    const cards = [
      { icon: '👥', val: rows.length.toLocaleString('en-IN'), lbl: 'Customers in load', sub: 'Master list sample (TOP cap)' },
      { icon: '📱', val: withMobile.toLocaleString('en-IN'), lbl: 'With mobile', sub: withEmail ? `${withEmail} with email` : '' },
    ];
    if (activeKey) {
      cards.push({ icon: '✓', val: activeCount.toLocaleString('en-IN'), lbl: 'ActiveStatus true', sub: 'In this slice only' });
    }
    if (branches != null) {
      cards.push({ icon: '🏪', val: branches.toLocaleString('en-IN'), lbl: 'Distinct BranchName', sub: `${creditPositive} with CreditLimit > 0` });
    }

    return (
      <div>
        <div className="grid-stats mb-2">
          {cards.map((c, i) => (
            <div key={c.lbl} className={`kpi-card ${KPI_GRADIENTS[i % KPI_GRADIENTS.length]} fade-in`}>
              <span className="kpi-icon">{c.icon}</span>
              <div className="kpi-val" style={{ position: 'relative', zIndex: 1 }}>{c.val}</div>
              <div className="kpi-lbl" style={{ position: 'relative', zIndex: 1 }}>{c.lbl}</div>
              {c.sub ? (
                <div style={{ position: 'relative', zIndex: 1, marginTop: 8, fontSize: 11, opacity: 0.85 }}>{c.sub}</div>
              ) : null}
            </div>
          ))}
        </div>
        <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
          {getMasterDatasetHint(datasetKey)}
        </p>
      </div>
    );
  }

  if (rowsLookLikeBranchMaster(rows) || String(datasetKey || '').toLowerCase() === 'branches') {
    const states = distinctColumnCount(rows, /^state$/i);
    const cities = distinctColumnCount(rows, /^city$/i);
    const cards = [
      {
        icon: '🏪',
        val: rows.length.toLocaleString('en-IN'),
        lbl: 'Branches loaded',
        sub: rows.length <= 500 ? 'Likely full branch master' : 'TOP slice only',
      },
    ];
    if (states != null) {
      cards.push({ icon: '🗺️', val: states.toLocaleString('en-IN'), lbl: 'Distinct State', sub: '' });
    }
    if (cities != null) {
      cards.push({ icon: '📍', val: cities.toLocaleString('en-IN'), lbl: 'Distinct City', sub: 'PinCode is postal text, not a metric' });
    }

    return (
      <div>
        <div className="grid-stats mb-2">
          {cards.map((c, i) => (
            <div key={c.lbl} className={`kpi-card ${KPI_GRADIENTS[i % KPI_GRADIENTS.length]} fade-in`}>
              <span className="kpi-icon">{c.icon}</span>
              <div className="kpi-val" style={{ position: 'relative', zIndex: 1 }}>{c.val}</div>
              <div className="kpi-lbl" style={{ position: 'relative', zIndex: 1 }}>{c.lbl}</div>
              {c.sub ? (
                <div style={{ position: 'relative', zIndex: 1, marginTop: 8, fontSize: 11, opacity: 0.85 }}>{c.sub}</div>
              ) : null}
            </div>
          ))}
        </div>
        <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
          {getMasterDatasetHint(datasetKey)}
        </p>
      </div>
    );
  }

  const catalogMaster = masterOnly || rowsLookLikeItemMasterCatalog(rows);
  if (masterOnly || catalogMaster) {
    const keys = Object.keys(rows[0]);
    const colPreview = keys.length > 8 ? `${keys.slice(0, 8).join(', ')}… (+${keys.length - 8})` : keys.join(', ');
    return (
      <div className="mb-4 fade-in" style={{
        padding:'12px 16px', borderRadius:12,
        background:'var(--surface2)', border:'1px solid var(--border)',
        fontSize:13, color:'var(--text-muted)',
      }}>
        <strong style={{color:'var(--text-strong)'}}>{rows.length.toLocaleString()} reference row(s)</strong>
        {catalogMaster && !masterOnly ? ' · item catalog detected' : ''}
        <span style={{display:'block', marginTop:4, fontSize:11, fontFamily:'monospace'}}>{colPreview}</span>
        <span style={{display:'block', marginTop:6, fontSize:12}}>
          {getMasterDatasetHint(datasetKey)}
        </span>
      </div>
    );
  }

  if (rowsLookLikeAppReportLines(rows)) {
    const revKey = pickCanonicalRevenueKey(rows) || 'MrpValue';
    const qtyKey = pickCanonicalQtyKey(rows) || 'AppQty';
    let sumRev = 0;
    let sumQty = 0;
    for (const r of rows) {
      sumRev += parseFloat(r[revKey]) || 0;
      sumQty += parseFloat(r[qtyKey]) || 0;
    }
    const distinctBills = distinctXnNoCount(rows);
    const wrongBillSum = Object.keys(rows[0]).some((k) => /^billcount$/i.test(k))
      ? rows.reduce((a, r) => a + (parseFloat(r.BillCount ?? r.billcount) || 0), 0)
      : null;

    const cards = [
      { icon: '📈', val: formatNum(sumRev, revKey), lbl: `Sum ${revKey}`, sub: `${rows.length} approval lines in this load` },
      { icon: '📦', val: Number(sumQty).toLocaleString('en-IN'), lbl: `Sum ${qtyKey}`, sub: 'Units on loaded lines' },
    ];
    if (distinctBills != null) {
      cards.push({
        icon: '🏆',
        val: Number(distinctBills).toLocaleString('en-IN'),
        lbl: 'Distinct bills (XnNo)',
        sub: wrongBillSum != null && wrongBillSum !== distinctBills
          ? `Do not use SUM(BillCount)=${wrongBillSum} — it double-counts lines`
          : 'Unique invoice numbers in slice',
      });
    }

    return (
      <div>
        <div className="grid-stats mb-2">
          {cards.map((c, i) => (
            <div key={c.lbl} className={`kpi-card ${KPI_GRADIENTS[i % KPI_GRADIENTS.length]} fade-in`}>
              <span className="kpi-icon">{c.icon}</span>
              <div className="kpi-val" style={{position:'relative',zIndex:1}}>{c.val}</div>
              <div className="kpi-lbl" style={{position:'relative',zIndex:1}}>{c.lbl}</div>
              {c.sub ? (
                <div style={{position:'relative',zIndex:1,marginTop:8,fontSize:11,opacity:0.85}}>{c.sub}</div>
              ) : null}
            </div>
          ))}
        </div>
        <p className="text-[11px] mb-4" style={{color:'var(--text-muted)'}}>
          Totals are for the <strong>{rows.length.toLocaleString()} loaded lines</strong> only (newest in your date window), not full-period MTD/YTD.
          Primary revenue metric is <strong>MrpValue</strong>. Use the Analytics tab or a larger row cap for period KPIs.
        </p>
      </div>
    );
  }

  if (rowsLookLikeStockSnapshot(rows) || String(datasetKey || '').toLowerCase() === 'stock') {
    const qtyKey = pickCanonicalQtyKey(rows) || 'StockQty';
    let sumQty = 0;
    let posQtyRows = 0;
    for (const r of rows) {
      const q = parseFloat(r[qtyKey]) || 0;
      sumQty += q;
      if (q > 0) posQtyRows += 1;
    }
    const distinctItems = distinctColumnCount(rows, /^itemid$/i);
    const distinctBranches = distinctColumnCount(rows, /^branchid$/i);

    const cards = [
      {
        icon: '📦',
        val: Number(sumQty).toLocaleString('en-IN', { maximumFractionDigits: 2 }),
        lbl: `Sum ${qtyKey} (loaded slice)`,
        sub: `${rows.length.toLocaleString()} item×branch rows — not full inventory`,
      },
    ];
    if (distinctItems != null) {
      cards.push({
        icon: '🏷️',
        val: Number(distinctItems).toLocaleString('en-IN'),
        lbl: 'Distinct ItemId',
        sub: 'In this load only',
      });
    }
    if (distinctBranches != null) {
      cards.push({
        icon: '🏪',
        val: Number(distinctBranches).toLocaleString('en-IN'),
        lbl: 'Distinct BranchId',
        sub: `${posQtyRows.toLocaleString()} rows with qty > 0`,
      });
    }

    return (
      <div>
        <div className="grid-stats mb-2">
          {cards.map((c, i) => (
            <div key={c.lbl} className={`kpi-card ${KPI_GRADIENTS[i % KPI_GRADIENTS.length]} fade-in`}>
              <span className="kpi-icon">{c.icon}</span>
              <div className="kpi-val" style={{ position: 'relative', zIndex: 1 }}>{c.val}</div>
              <div className="kpi-lbl" style={{ position: 'relative', zIndex: 1 }}>{c.lbl}</div>
              {c.sub ? (
                <div style={{ position: 'relative', zIndex: 1, marginTop: 8, fontSize: 11, opacity: 0.85 }}>{c.sub}</div>
              ) : null}
            </div>
          ))}
        </div>
        <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
          Each row is <strong>one SKU at one branch</strong>. This view has <strong>no date column</strong> — Load Dataset returns an arbitrary TOP slice.
          For company-wide stock value/qty use <strong>mb_powerbi_stock_report</strong> or raise the row cap / export.
        </p>
      </div>
    );
  }

  const keys = Object.keys(rows[0]);

  // Use global column tags when available — order and filter by tag, not by name-regex
  const hasTags = Object.keys(_globalColTags).length > 0;
  let numericKeys;

  if (hasTags) {
    // Tag-driven: money first, then count, then ratio — skip id/text/date
    const money = keys.filter(k => _globalColTags[k] === 'money');
    const count  = keys.filter(k => _globalColTags[k] === 'count');
    const ratio  = keys.filter(k => _globalColTags[k] === 'ratio');
    numericKeys = [...money, ...count, ...ratio].filter(k => !isNonAggregableDigitKey(k));
    if (rowsLookLikeItemMasterCatalog(rows)) {
      numericKeys = numericKeys.filter((k) => !looksLikeCatalogUnitPriceKey(k));
    }
    // Hide before-tax when net-sales present — still useful ERP-specific logic
    const BEFORE_TAX_PAT = /beforetax|before_tax|pretax|pre_tax/i;
    const NET_SALES_PAT  = /mrpvalue|salenetamount|netsale|netsales|totalnet|netamount|metric_value|netslsnetamount/i;
    if (numericKeys.some(k => NET_SALES_PAT.test(k))) {
      numericKeys = numericKeys.filter(k => !BEFORE_TAX_PAT.test(k));
    }
    numericKeys = numericKeys.slice(0, 4);
  } else {
    // Fallback: original name-regex path
    numericKeys = keys.filter(k =>
      isNumericCol(rows, k) &&
      !looksLikeId(rows, k) &&
      !looksLikeItemCatalogIdentifierKey(k) &&
      !isPerRowBillCountColumn(rows, k) &&
      !isAuxiliaryTxnMoneyKey(k, rows) &&
      !(rowsLookLikeCustomerMaster(rows) && /^creditlimit$/i.test(k)) &&
      !(rowsLookLikeItemMasterCatalog(rows) && looksLikeCatalogUnitPriceKey(k))
    );
    const BEFORE_TAX_PAT = /beforetax|before_tax|pretax|pre_tax/i;
    const NET_SALES_PAT  = /mrpvalue|salenetamount|netsale|netsales|totalnet|totalsales|netamount|metric_value|netslsnetamount/i;
    if (numericKeys.some(k => NET_SALES_PAT.test(k))) {
      numericKeys = numericKeys.filter(k => !BEFORE_TAX_PAT.test(k));
    }
    const preferredFirst = [
      ...numericKeys.filter(k => NET_SALES_PAT.test(k)),
      ...numericKeys.filter(k => !NET_SALES_PAT.test(k) && isCountKey(k)),
      ...numericKeys.filter(k => !NET_SALES_PAT.test(k) && !isCountKey(k)),
    ];
    numericKeys = [...new Set(preferredFirst)].slice(0, 4);
  }
  if (numericKeys.length === 0) return null;

  const stats = numericKeys.map(k => {
    const vals = rows.map(r => parseFloat(r[k])).filter(v => !isNaN(v));
    const sum = vals.reduce((a, b) => a + b, 0);
    return { key: k, sum, count: vals.length, avg: sum / vals.length };
  });

  const fmtStat = (n, key) => {
    if (isSaleValueKey(key)) return formatNum(n, key);
    return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  };

  return (
    <div className="grid-stats mb-4">
      {stats.map((s, i) => (
        <div key={s.key} className={`kpi-card ${KPI_GRADIENTS[i % KPI_GRADIENTS.length]} fade-in`}>
          <span className="kpi-icon">{['📈','💰','📦','🏆'][i % 4]}</span>
          <div className="kpi-val" style={{position:'relative',zIndex:1}}>{fmtStat(s.sum, s.key)}</div>
          <div className="kpi-lbl" style={{position:'relative',zIndex:1}}>{s.key}</div>
          <div style={{position:'relative',zIndex:1,marginTop:10,display:'flex',alignItems:'center',gap:12,fontSize:11,opacity:0.8}}>
            <span>avg {fmtStat(s.avg, s.key)}</span>
            <span>·</span>
            <span>{s.count} rows</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return <button onClick={copy} className="btn-ghost text-xs px-3 py-1.5">{copied ? "✓ Copied" : "Copy"}</button>;
}

/* ── Drive CSV button ── saves to the SIGNED-IN user's own Google Drive */
function DriveSaveBtn({ buildBlob, filename, mimeType, folderId, label }) {
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const blob = await buildBlob();
      const out = await uploadBlobToDrive({ blob, filename, mimeType, folderId });
      const link = out.webViewLink ? `\n\n🔗 Open in Drive:\n${out.webViewLink}` : "";
      alert(`✅ Saved to YOUR Google Drive!\nFile: ${out.name || filename}${link}`);
    } catch (e) {
      alert("❌ Drive error:\n" + String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      onClick={save}
      disabled={saving}
      className="btn-ghost text-xs px-3 py-1.5"
      title="Save to your own Google Drive — you will be asked to sign in" 
    >
      {saving
        ? <><span className="spin inline-block border-2 border-slate-200 rounded-full" style={{width:11,height:11,borderTopColor:'#6366f1',marginRight:4}}/> Saving…</>
        : (label || "☁ My Drive CSV")}
    </button>
  );
}

/* ── Drive Excel button ── saves .xlsx to the SIGNED-IN user's own Google Drive */
function DriveXLSXBtn({ rows, filename = "export.xlsx", sheetName = "Data", folderId }) {
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving || !rows?.length) return;
    setSaving(true);
    try {
      const XLSX = window.XLSX;
      if (!XLSX) throw new Error("Excel library not loaded — please refresh");
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, String(sheetName || "Data").slice(0, 31));
      const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const out = await uploadBlobToDrive({ blob, filename, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", folderId });
      const link = out.webViewLink ? `\n\n🔗 Open in Drive:\n${out.webViewLink}` : "";
      alert(`✅ Saved to YOUR Google Drive!\nFile: ${out.name || filename}${link}`);
    } catch (e) {
      alert("❌ Drive error:\n" + String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      onClick={save}
      disabled={saving || !rows?.length}
      className="btn-ghost text-xs px-3 py-1.5"
      title="Save Excel to your own Google Drive — you will be asked to sign in" 
    >
      {saving
        ? <><span className="spin inline-block border-2 border-slate-200 rounded-full" style={{width:11,height:11,borderTopColor:'#6366f1',marginRight:4}}/> Saving…</>
        : "☁ My Drive Excel"}
    </button>
  );
}

function ExportCSV({ rows, filename = "export.csv" }) {
  const exp = () => {
    if (!rows?.length) return;
    const h = Object.keys(rows[0]);
    const lines = [h.join(","), ...rows.map(r => h.map(k => {
      const v = String(r[k] ?? "").replace(/"/g, '""');
      return v.includes(",") || v.includes("\n") || v.includes('"') ? `"${v}"` : v;
    }).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };
  return <button onClick={exp} className="btn-ghost text-xs px-3 py-1.5">⬇ CSV</button>;
}

function ExportXLSX({ rows, filename = "export.xlsx", sheetName = "Data" }) {
  const exp = () => {
    if (!rows?.length) return;
    const XLSX = window.XLSX;
    if (!XLSX) {
      alert("Excel export library not loaded. Please refresh the page.");
      return;
    }
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, String(sheetName || "Data").slice(0, 31));
    XLSX.writeFile(wb, filename);
  };
  return <button onClick={exp} className="btn-ghost text-xs px-3 py-1.5">⬇ Excel</button>;
}

/* ═══════════════════════════════════════════════
   HOME / OVERVIEW PANEL
═══════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════
   SALES PERIOD PANEL — Today / MTD / QTD / YTD / Last 6M
   with switchable Group-by: Branch | Department | Category | Date
═══════════════════════════════════════════════════════════════ */

/* Convert JS Date to dd.mm.yyyy which the API filter expects */
function toDMY(d) {
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function getPeriodRange(period) {
  const now  = new Date();
  const today = toDMY(now);
  const yr = now.getFullYear();
  const mo = now.getMonth(); // 0=Jan … 11=Dec
  let from;
  let to = today;
  switch (period) {
    case 'today': from = today; break;
    case 'yesterday': {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      from = toDMY(d);
      to = from;
      break;
    }
    case 'mtd':   from = toDMY(new Date(now.getFullYear(), now.getMonth(), 1)); break;
    case 'qtd': {
      /* Indian FY quarters: Q1=Apr-Jun(3-5), Q2=Jul-Sep(6-8), Q3=Oct-Dec(9-11), Q4=Jan-Mar(0-2) */
      let qStartMonth;
      if      (mo >= 9) qStartMonth = 9;  // Q3 starts Oct
      else if (mo >= 6) qStartMonth = 6;  // Q2 starts Jul
      else if (mo >= 3) qStartMonth = 3;  // Q1 starts Apr
      else              qStartMonth = 0;  // Q4 starts Jan
      from = toDMY(new Date(yr, qStartMonth, 1)); break;
    }
    case 'ytd': {
      /* Indian FY YTD: Apr 1 of current financial year */
      const fyStartYear = mo >= 3 ? yr : yr - 1;
      from = toDMY(new Date(fyStartYear, 3, 1)); break;
    }
    case '6m': {
      /* Last 6 months including current month: current + previous 5 */
      const d = new Date(now); d.setMonth(d.getMonth() - 5); d.setDate(1);
      from = toDMY(d); break;
    }
    case 'last_30d':
    case '30d': {
      const d = new Date(now); d.setDate(d.getDate() - 29);
      from = toDMY(d); break;
    }
    case 'last_60d':
    case '60d': {
      const d = new Date(now); d.setDate(d.getDate() - 59);
      from = toDMY(d); break;
    }
    case 'last_90d':
    case '90d': {
      const d = new Date(now); d.setDate(d.getDate() - 89);
      from = toDMY(d); break;
    }
    case 'last_180d':
    case '180d': {
      const d = new Date(now); d.setDate(d.getDate() - 179);
      from = toDMY(d); break;
    }
    default: from = today;
  }
  return { from, to };
}

/* Strip ZWSP/BOM; trim — category keys from SQL often have invisible chars */
function stripInvisible(s) {
  return String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}
/**
 * Placeholder / junk dimension values to exclude from bar charts (and from summing as a named bucket).
 * Covers exact "Unknown", common misspellings, N/A, and SQL null sentinels.
 */
function isJunkGroupKey(s) {
  const key = stripInvisible(s);
  if (!key) return true;
  const low = key.toLowerCase();
  if (/^n\/?a$/i.test(key) || /^#n\/?a$/i.test(key)) return true;
  if (low === 'null' || low === 'none' || low === 'undefined' || low === '?' || low === '—' || low === '-') return true;
  if (low === 'not applicable' || low === 'not available' || low === 'tbd' || low === 'tbc') return true;
  const compact = low.replace(/[^a-z0-9]/g, '');
  if (compact.length === 0) return true;
  if (compact === 'na' || compact === 'null' || compact === 'none') return true;
  if (compact === 'unknown' || compact === 'unkown' || compact === 'unkonw' || compact === 'unknwn' || compact === 'unknow') return true;
  if (/^unknown(\b|_|$)/i.test(low)) return true;
  return false;
}

/** Normalize a cell to YYYY-MM-DD for daily buckets; returns '' if not parseable. */
function toDayKeyFromCell(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* Aggregate raw rows by a grouping column, summing a value column */
function aggregateBy(rows, groupCol, valueCol) {
  if (!groupCol || !rows.length) return [];
  const map = {};
  rows.forEach(r => {
    const key = stripInvisible(r[groupCol]);
    if (isJunkGroupKey(key)) return;
    const val = parseFloat(r[valueCol]) || 0;
    map[key] = (map[key] || 0) + val;
  });
  if (!Object.keys(map).length) {
    return [{ label: "No mapped values", value: 0 }];
  }
  return Object.entries(map)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

/* Aggregate by date column, summing value column */
function aggregateByDate(rows, dateCol, valueCol) {
  if (!dateCol || !rows.length) return [];
  const map = {};
  rows.forEach(r => {
    const dayKey = toDayKeyFromCell(r[dateCol]);
    if (!dayKey) return;
    const val = parseFloat(r[valueCol]) || 0;
    map[dayKey] = (map[dayKey] || 0) + val;
  });
  return Object.entries(map)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([label, value]) => ({ label, value }));
}

/* Aggregate by month key YYYY-MM from date column */
function aggregateByMonth(rows, dateCol, valueCol) {
  if (!dateCol || !rows.length) return [];
  const map = {};
  rows.forEach(r => {
    const raw = String(r[dateCol] ?? '');
    const d = new Date(raw);
    if (isNaN(d)) return;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const val = parseFloat(r[valueCol]) || 0;
    map[key] = (map[key] || 0) + val;
  });
  return Object.entries(map)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([label, value]) => ({ label, value }));
}

const MONTH_NAME_TO_NUM = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function monthNameToIsoKey(label) {
  const s = String(label ?? "").trim();
  if (!s) return null;
  const m1 = /^([A-Za-z]+)[\s\-/]+(\d{4})$/.exec(s);
  if (m1) {
    const mo = MONTH_NAME_TO_NUM[m1[1].toLowerCase()] || MONTH_NAME_TO_NUM[m1[1].toLowerCase().slice(0, 3)];
    if (mo) return `${m1[2]}-${String(mo).padStart(2, "0")}`;
  }
  const m2 = /^(\d{4})[\s\-/]([A-Za-z]+)$/.exec(s);
  if (m2) {
    const mo = MONTH_NAME_TO_NUM[m2[2].toLowerCase()] || MONTH_NAME_TO_NUM[m2[2].toLowerCase().slice(0, 3)];
    if (mo) return `${m2[1]}-${String(mo).padStart(2, "0")}`;
  }
  const m3 = /^(\d{1,2})[\s\-/](\d{4})$/.exec(s);
  if (m3) {
    const mo = parseInt(m3[1], 10);
    if (mo >= 1 && mo <= 12) return `${m3[2]}-${String(mo).padStart(2, "0")}`;
  }
  return null;
}

/** Normalize trend period_label to a stable key for YoY alignment (yyyy-mm-dd or yyyy-mm). */
function canonicalTrendLabelKey(lbl) {
  const s = String(lbl ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const named = monthNameToIsoKey(s);
  if (named) return named;
  const iso = toDayKeyFromCell(s);
  if (iso) return iso.length >= 7 ? iso.slice(0, 7) : iso;
  return s;
}

/** Map current-period key → prior-year key (same month/day or same fiscal month bucket). */
function priorYearTrendKey(canonicalKey) {
  const k = String(canonicalKey || "");
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
  if (day) {
    const d = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  const mo = /^(\d{4})-(\d{2})$/.exec(k);
  if (mo) return `${Number(mo[1]) - 1}-${mo[2]}`;
  return null;
}

/** Combine multiple DB rows sharing the same trend bucket (fixes repeated X-axis labels / double-count visuals). */
function aggregateTrendChartRows(rows) {
  if (!rows?.length) return [];
  const map = new Map();
  const order = [];
  for (const r of rows) {
    const k = canonicalTrendLabelKey(r.label);
    if (!k) continue;
    if (!map.has(k)) {
      order.push(k);
      map.set(k, {
        label: String(r.label ?? ''),
        TotalSales: parseFloat(r.TotalSales) || 0,
        InvoiceCount: r.InvoiceCount != null ? parseFloat(r.InvoiceCount) || 0 : null,
      });
    } else {
      const agg = map.get(k);
      agg.TotalSales += parseFloat(r.TotalSales) || 0;
      if (r.InvoiceCount != null) {
        agg.InvoiceCount = (agg.InvoiceCount || 0) + (parseFloat(r.InvoiceCount) || 0);
      }
    }
  }
  return order.map((k) => {
    const o = map.get(k);
    const out = {
      label: /^\d{4}-\d{2}-\d{2}$/.test(k) ? `${k.slice(8, 10)}-${k.slice(5, 7)}-${k.slice(0, 4)}` : /^\d{4}-\d{2}$/.test(k) ? k : o.label,
      TotalSales: o.TotalSales,
    };
    if (o.InvoiceCount != null && Number.isFinite(o.InvoiceCount)) out.InvoiceCount = o.InvoiceCount;
    return out;
  });
}

function normalizeDateToDMY(s) {
  const raw = String(s || '').trim();
  if (!raw) return '';
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-');
    return `${d}.${m}.${y}`;
  }
  const m1 = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) {
    const dd = String(parseInt(m1[1], 10)).padStart(2, '0');
    const mm = String(parseInt(m1[2], 10)).padStart(2, '0');
    return `${dd}.${mm}.${m1[3]}`;
  }
  return '';
}

function parseFromToDateRange(question) {
  const q = String(question || '');
  const m = q.match(/from\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}-\d{2}-\d{2})\s+to\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}-\d{2}-\d{2})/i);
  if (!m) return null;
  const from = normalizeDateToDMY(m[1]);
  const to = normalizeDateToDMY(m[2]);
  if (!from || !to) return null;
  return { from, to };
}

function detectSalesDashboardIntent(question) {
  const q = String(question || '').toLowerCase();

  // Scalar KPI / count questions → Adaptive Agent SQL (not branch+dept+cat dashboard)
  const isScalarCount =
    /\b(how many|count|number of|what is|what's|whats)\b/.test(q) &&
    !/\b(by\s+|per\s+|each\s+|breakdown|split\s+by|compare|versus|vs\b)\b/.test(q);
  if (isScalarCount && /\b(bills?|invoices?|footfall|transactions?)\b/.test(q)) return null;
  if (
    isScalarCount &&
    /\b(revenue|sales|turnover|gross|net\s+sales)\b/.test(q) &&
    !/\b(trend|chart|graph|dashboard)\b/.test(q)
  ) {
    return null;
  }

  const salesLike = /\b(sale|sales|revenue|invoice)\b/.test(q);
  const pToday = /\b(today|today'?s)\b/.test(q);
  const pYesterday = /\b(yesterday|yday|yday'?s)\b/.test(q);
  const pMtd = /\b(mtd|month[\s-]*to[\s-]*date|this month)\b/.test(q);
  const pQtd = /\b(qtd|quarter[\s-]*to[\s-]*date|this quarter)\b/.test(q);
  const pYtd = /\b(ytd|year[\s-]*to[\s-]*date|this year)\b/.test(q);
  const p6m = /\b(last\s*6\s*months?|last\s*six\s*months?)\b/.test(q);
  const pCustom = !!parseFromToDateRange(q);
  const explicitDateMatches = q.match(/\b\d{1,2}[./-]\d{1,2}[./-]\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g) || [];
  const hasDatePointSetCompare = explicitDateMatches.length >= 2;
  const hasCompareOperator = /\b(compare|vs|versus|against)\b/.test(q);

  // ── Specificity guard ────────────────────────────────────────────────────────
  // If the question names a SPECIFIC entity (branch code/name, supplier, category,
  // department, item, customer, salesperson), the generic multi-chart dashboard
  // is the WRONG answer — route to the AI engine instead so it can filter properly.
  const hasSpecificFilter =
    // Branch codes like "01-SE", "08-VK", numeric branch ids
    /\b\d{2}-[A-Z]{2,4}\b/i.test(q) ||
    // "for branch X", "branch X", "for store X"
    /\b(branch|store|outlet)\s+[\w\-]+/.test(q) ||
    // "for <named entity>" — supplier, vendor, category, dept, customer, item, salesperson
    /\bfor\s+(branch|store|supplier|vendor|category|dept|department|customer|item|product|salesperson|employee)\b/.test(q) ||
    // "by department X / category X" when a name follows
    /\b(department|category|dept|cat)\s+[A-Z][A-Z]+/.test(q) ||
    // Explicit comparison operators
    hasCompareOperator ||
    // Multiple specific dates in one query => must go to deterministic compare path
    hasDatePointSetCompare ||
    // Ranking / top-N, or stock/purchase/supplier queries → AI engine
    /\btop\s+\d+\b/.test(q) ||
    /\b(stock|purchase|return|supplier|vendor|product|item)\b/.test(q) ||
    // Unique / distinct count → needs COUNT DISTINCT SQL, send to AI engine
    /\b(unique|distinct)\s+\w/.test(q) ||
    // Explicit count-metric questions about a specific dimension → AI engine
    /\b(customer\s+count|invoice\s+count|transaction\s+count)\b/.test(q) ||
    // Specific named locations or values in quotes
    /["'][^"']{2,}["']/.test(q);

  if (hasSpecificFilter) return null;  // ← send to AI engine, not dashboard

  // Person / SKU / customer rankings — not the generic branch+dept+cat dashboard
  if (/\b(salesperson|sales\s*person|salesman|sales\s*rep|employee|staff)\b/.test(q)) return null;
  if (
    /\b(highest|lowest|best|worst|top)\b/.test(q) &&
    /\b(salesperson|sales\s*person|supplier|vendor|customer|product|item|sku|article|employee)\b/.test(q) &&
    !/\b(branches?|department|dept|categor(y|ies))\b/.test(q)
  ) {
    return null;
  }

  // Period-only phrases (e.g. "today", "MTD") without sales context → not a dashboard request
  if (!salesLike && !(pToday || pYesterday || pMtd || pQtd || pYtd || p6m || pCustom)) return null;
  // Require sales/revenue context OR explicit dashboard/trend wording for multi-chart path
  if (
    !salesLike &&
    (pToday || pYesterday || pMtd || pQtd || pYtd || p6m) &&
    !/\b(trend|dashboard|chart|graph|overview|summary)\b/.test(q)
  ) {
    return null;
  }

  if (pToday) return "today";
  if (pYesterday) return "yesterday";
  if (pMtd) return "mtd";
  if (pQtd) return "qtd";
  if (pYtd) return "ytd";
  if (p6m) return "6m";
  if (pCustom) return "custom";
  return null;
}

const PERIODS = [
  { key: 'today', label: "Today" },
  { key: 'mtd',   label: "MTD"   },
  { key: 'qtd',   label: "QTD"   },
  { key: 'ytd',   label: "YTD"   },
  { key: '6m',    label: "Last 6M" },
  { key: 'last_30d', label: "30d" },
  { key: 'last_60d', label: "60d" },
  { key: 'last_90d', label: "90d" },
  { key: 'last_180d', label: "180d" },
];

const GROUP_OPTIONS = [
  { key: 'branch', label: "Branch Alias", col: "BranchAlias",         fallbacks: ["BranchName","Branch","BranchCode","BranchId"]         },
  { key: 'dept',   label: "Department",   col: "DepartmentShortName", fallbacks: ["DepartmentName","Department","DeptName","Dept"]        },
  { key: 'cat',    label: "Category",     col: "CategoryShortName",   fallbacks: ["CategoryName","Category","Cat","CategoryCode","ItemCategory"] },
  { key: 'date',   label: "Date-wise",    col: null /* special */                                                                         },
];

/**
 * Given the actual data rows and a GROUP_OPTIONS entry, returns the best
 * available column name — trying the primary col first, then fallbacks,
 * picking whichever has at least one non-junk value.
 */
function resolveGroupCol(rows, opt) {
  if (!opt || !rows?.length) return opt?.col || null;
  const available = Object.keys(rows[0]).map(k => k.toLowerCase());
  const candidates = [opt.col, ...(opt.fallbacks || [])].filter(Boolean);
  for (const c of candidates) {
    const actual = Object.keys(rows[0]).find(k => k.toLowerCase() === c.toLowerCase());
    if (!actual) continue;
    const hasReal = rows.some(r => !isJunkGroupKey(String(r[actual] ?? '')));
    if (hasReal) return actual;
  }
  // All candidates yield only junk — return null so caller can show a message
  return null;
}

/* Which group-by keys need an AI JOIN query (no direct column in sales view) */
const AI_GROUPBY_KEYS = ['cat', 'dept'];

/* AI question templates for Category and Department */
function buildAIGroupQuestion(groupKey, from, to) {
  const f = dmyToISO(from);
  const t = dmyToISO(to);
  if (groupKey === 'kpi_total') {
    return `Total sales amount and transaction count from ${f} to ${t}. Use dbo.VwAISalesData. ` +
      `SELECT SUM(SaleNetAmount) AS TotalSales, COUNT(*) AS TransactionCount ` +
      `FROM dbo.VwAISalesData WHERE CAST(InvoiceDt AS date) BETWEEN '${f}' AND '${t}'.`;
  }
  if (groupKey === 'trend_daily') {
    return `Day-wise sales AND invoice count AND customer count from ${f} to ${t}. Use dbo.VwAISalesData. ` +
      `SELECT CONVERT(varchar(12), CAST(InvoiceDt AS date), 105) AS SaleDate, ` +
      `SUM(SaleNetAmount) AS TotalSales, COUNT(DISTINCT InvoiceNo) AS InvoiceCount, COUNT(DISTINCT CustomerId) AS CustomerCount ` +
      `FROM dbo.VwAISalesData WHERE CAST(InvoiceDt AS date) BETWEEN '${f}' AND '${t}' ` +
      `GROUP BY CAST(InvoiceDt AS date) ORDER BY CAST(InvoiceDt AS date) ASC.`;
  }
  if (groupKey === 'trend_monthly') {
    return `Month-wise sales AND invoice count AND customer count from ${f} to ${t}. Use dbo.VwAISalesData. ` +
      `SELECT FORMAT(InvoiceDt, 'MMM yyyy') AS SaleMonth, ` +
      `SUM(SaleNetAmount) AS TotalSales, COUNT(DISTINCT InvoiceNo) AS InvoiceCount, COUNT(DISTINCT CustomerId) AS CustomerCount ` +
      `FROM dbo.VwAISalesData WHERE CAST(InvoiceDt AS date) BETWEEN '${f}' AND '${t}' ` +
      `GROUP BY YEAR(InvoiceDt), MONTH(InvoiceDt), FORMAT(InvoiceDt,'MMM yyyy') ` +
      `ORDER BY YEAR(InvoiceDt), MONTH(InvoiceDt) ASC.`;
  }
  if (groupKey === 'branch') {
    return `Top 30 branches by total MrpValue from ${f} to ${t}. ` +
      `Use ONLY dbo.VW_MB_POWERBI_APP_REPORT. ` +
      `WHERE CAST(XnDt AS date) BETWEEN '${f}' AND '${t}'. ` +
      `GROUP BY BranchAlias, SELECT BranchAlias, SUM(MrpValue) AS SaleNetAmount, ORDER BY SaleNetAmount DESC.`;
  }
  if (groupKey === 'cat') {
    return `Top 20 categories by total MrpValue from ${f} to ${t}. ` +
      `Use ONLY dbo.VW_MB_POWERBI_APP_REPORT. ` +
      `WHERE CAST(XnDt AS date) BETWEEN '${f}' AND '${t}'. ` +
      `GROUP BY CategoryShortName, SELECT CategoryShortName, SUM(MrpValue) AS SaleNetAmount, ORDER BY SaleNetAmount DESC.`;
  }
  if (groupKey === 'dept') {
    return `Top 20 departments by total MrpValue from ${f} to ${t}. ` +
      `Use ONLY dbo.VW_MB_POWERBI_APP_REPORT. ` +
      `WHERE CAST(XnDt AS date) BETWEEN '${f}' AND '${t}'. ` +
      `GROUP BY DepartmentShortName, SELECT DepartmentShortName, SUM(MrpValue) AS SaleNetAmount, ORDER BY SaleNetAmount DESC.`;
  }
  return '';
}

/* Pick the best label column from AI query result rows */
function pickAILabelCol(rows, groupKey) {
  if (!rows?.length) return null;
  const keys = Object.keys(rows[0]);
  if (groupKey === 'branch') {
    return keys.find(k => /alias/i.test(k) && !/amount|net|total|value|sale/i.test(k))
      || keys.find(k => /branch/i.test(k) && !/id|amount|net|total|value|sale/i.test(k))
      || keys.find(k => /name/i.test(k) && !/amount|net|total|value|sale/i.test(k))
      || keys[0];
  }
  if (groupKey === 'cat') {
    return keys.find(k => /category|cat/i.test(k) && !/amount|net|total|value|sale/i.test(k))
      || keys.find(k => /name|desc|short/i.test(k))
      || keys[0];
  }
  if (groupKey === 'dept') {
    return keys.find(k => /dept|department/i.test(k) && !/amount|net|total|value|sale/i.test(k))
      || keys.find(k => /name|desc|short/i.test(k))
      || keys[0];
  }
  return keys[0];
}

/* Pick the best value column from AI query result rows */
function pickAIValueCol(rows) {
  return pickCanonicalRevenueKey(rows) || (rows?.length ? Object.keys(rows[0])[0] : null);
}

/** Value column(s) for ChartWithToggle from chart row objects (label + metrics). */
function pickChartValueCols(chartRows, fallbackCol) {
  if (!chartRows?.length) return fallbackCol ? [fallbackCol] : ['SaleNetAmount'];
  const keys = Object.keys(chartRows[0]).filter((k) => k !== 'label');
  const money = keys.filter((k) => isSaleValueKey(k) || /amount|mrp|metric|revenue|sales|value/i.test(k));
  if (money.length) return money;
  const numeric = keys.filter((k) => isNumericCol(chartRows, k));
  if (numeric.length) return numeric;
  return fallbackCol ? [fallbackCol] : ['SaleNetAmount'];
}

const HOME_BREAKDOWN_LIMIT_OPTIONS = [
  { value: 10, label: "Top 10" },
  { value: 20, label: "Top 20" },
  { value: 30, label: "Top 30" },
  { value: 0, label: "All" },
];

function homeBreakdownRowLimit(limitSetting, totalRows) {
  const n = parseInt(String(limitSetting), 10);
  if (!Number.isFinite(n) || n <= 0) return totalRows;
  return Math.min(totalRows, n);
}

function homePieSliceCap(limitSetting, totalRows) {
  const n = parseInt(String(limitSetting), 10);
  if (!Number.isFinite(n) || n <= 0) return Math.max(PIE_MAX_SLICES, totalRows);
  return n;
}

const HOME_SECTION_DEFAULTS = { trend: true, branch: true, dept: true, cat: true };

function salesPeriodTrendGranularity(period) {
  const p = String(period || "");
  // Day-grain: today, MTD, and spans ≤ 60 days
  if (p === "today" || p === "mtd" || p === "last_30d" || p === "30d" || p === "last_60d" || p === "60d") {
    return "day";
  }
  // Month-grain: QTD, YTD, 90d, 180d, Last 6M — avoids too many X-axis points
  return "month";
}

/** Human-readable trend chart title — matches granularity (day vs month). */
function homeTrendChartTitle(periodKey, hasPyTrend) {
  const p = String(periodKey || "");
  const grain = salesPeriodTrendGranularity(p);
  const dayish = grain === "day";
  const period =
    {
      today:     "Today",
      mtd:       "MTD",
      qtd:       "QTD",
      ytd:       "YTD",
      "6m":      "Last 6M",
      last_30d:  "30d",
      "30d":     "30d",
      last_60d:  "60d",
      "60d":     "60d",
      last_90d:  "90d",
      "90d":     "90d",
      last_180d: "180d",
      "180d":    "180d",
    }[p] ||
    PERIODS.find((x) => x.key === p)?.label ||
    p.toUpperCase();
  const grainLabel = dayish ? "Day-wise" : "Month-wise";
  const suffix = hasPyTrend ? " (Current vs Last Year)" : "";
  return `📅 ${period} — ${grainLabel} Sales${suffix}`;
}

/**
 * Explain sparse month-axis points (Indian FY starts Apr — early in FY you only see a few months).
 */
function monthTrendDisclaimer(periodKey, trendPointCount, rangeFromDMY, rangeToDMY) {
  if (salesPeriodTrendGranularity(periodKey) !== "month") return "";
  const n = parseInt(String(trendPointCount), 10) || 0;
  if (!rangeFromDMY || !rangeToDMY || n > 6) return "";
  const p = String(periodKey || "");
  if (p === "ytd") {
    return (
      `YTD compares each month to the same calendar month last year (Apr vs Apr LY, May vs May LY, …). ` +
      `Indian FY starts 1 April — as of ${rangeToDMY} you have ${n} month bucket${n === 1 ? "" : "s"}. ` +
      `The current month includes only days through ${rangeToDMY} in both years.`
    );
  }
  if (p === "qtd") {
    return (
      `QTD is month-wise within the current Indian FY quarter. Range ${rangeFromDMY} → ${rangeToDMY} — ` +
      `${n} month${n === 1 ? "" : "s"} shown.`
    );
  }
  return (
    `Month-wise trend: ${n} calendar month${n === 1 ? "" : "s"} in ${rangeFromDMY} → ${rangeToDMY}. ` +
      `Periods longer than ~60 days use monthly buckets for readability.`
  );
}

/** When widgets API fails/timeouts, derive branch/dept/cat from loaded flat sample rows. */
function syntheticWidgetRowsFromFlat(rows, groupKey, revenueCol) {
  const rel = syntheticWidgetRowsFromFlatUnfiltered(rows, groupKey, revenueCol).filter((r) => r.metric_value > 0);
  rel.sort((a, b) => b.metric_value - a.metric_value);
  return rel;
}

function syntheticWidgetRowsFromFlatUnfiltered(rows, groupKey, revenueCol) {
  if (!rows?.length || !revenueCol) return [];
  const opt = GROUP_OPTIONS.find((o) => o.key === groupKey);
  if (!opt) return [];
  const dimCol = resolveGroupCol(rows, opt);
  if (!dimCol) return [];
  return aggregateBy(rows, dimCol, revenueCol).map((r) => ({
    label: String(r.label ?? "").trim(),
    metric_value: parseFloat(r.value) || 0,
  }));
}

/** Build analytics-shaped trend rows from flat TOP-N sample (fallback path). */
function buildFlatTrendRows(flatData, period, dateCol, valueCol) {
  if (!flatData?.length || !dateCol || !valueCol) return [];
  const grain = salesPeriodTrendGranularity(period);
  const agg =
    grain === "day"
      ? aggregateByDate(flatData, dateCol, valueCol)
      : aggregateByMonth(flatData, dateCol, valueCol);
  return agg.map((r) => ({ period_label: r.label, metric_value: parseFloat(r.value) || 0 }));
}

/** Insert zero-valued buckets so line charts span the full MTD/QTD/YTD window (not a single dot). */
function fillTrendSeriesGaps(trendRows, fromDMY, toDMY, grain) {
  const fromIso = dmyToISO(fromDMY);
  const toIso = dmyToISO(toDMY);
  if (!fromIso || !toIso) return trendRows || [];

  const byKey = new Map();
  for (const r of trendRows || []) {
    const label = r.period_label != null ? r.period_label : r.label;
    const k = canonicalTrendLabelKey(label);
    if (!k) continue;
    const entry = {
      period_label: String(label),
      metric_value: parseFloat(r.metric_value != null ? r.metric_value : r.TotalSales) || 0,
      txn_count: r.txn_count != null ? parseFloat(r.txn_count) : undefined,
    };
    byKey.set(k, entry);
  }

  const out = [];
  if (grain === "day") {
    const start = new Date(`${fromIso}T12:00:00Z`);
    const end = new Date(`${toIso}T12:00:00Z`);
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const hit = byKey.get(k);
      out.push(
        hit || {
          period_label: k,
          metric_value: 0,
        }
      );
    }
    return out;
  }

  let y = parseInt(fromIso.slice(0, 4), 10);
  let m = parseInt(fromIso.slice(5, 7), 10);
  const endY = parseInt(toIso.slice(0, 4), 10);
  const endM = parseInt(toIso.slice(5, 7), 10);
  while (y < endY || (y === endY && m <= endM)) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    const hit = byKey.get(k);
    out.push(hit || { period_label: k, metric_value: 0 });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function sumFlatKpis(flatData) {
  if (!Array.isArray(flatData) || !flatData.length) {
    return { total: 0, txCount: 0, quantity: 0, bills: 0, customers: 0 };
  }
  const keys = Object.keys(flatData[0]);
  const amountKey = pickCanonicalRevenueKey(flatData)
    || keys.find((k) => /amount|net|sale|revenue|total|value|mrpvalue/i.test(k));
  const qtyKey = pickCanonicalQtyKey(flatData)
    || keys.find((k) => /quantity|qty|appqty|netslsqty|slsqty/i.test(k));
  const billKey = keys.find((k) => /billcount|invoicecount|txn_count|xnno|invoiceno/i.test(k));
  const custKey = keys.find((k) => /customerid|customercount|xnid/i.test(k));

  let total = 0;
  let quantity = 0;
  const invoices = new Set();
  const customers = new Set();
  for (const r of flatData) {
    if (amountKey) total += parseFloat(r[amountKey]) || 0;
    if (qtyKey) quantity += parseFloat(r[qtyKey]) || 0;
    if (billKey) {
      const v = r[billKey];
      if (v != null && String(v).trim() !== "") invoices.add(String(v));
    }
    if (custKey) {
      const v = r[custKey];
      if (v != null && String(v).trim() !== "") customers.add(String(v));
    }
  }
  return {
    total,
    txCount: flatData.length,
    quantity,
    bills: invoices.size || flatData.length,
    customers: customers.size,
  };
}

function mapAnalyticsBreakdownRows(aiRows, groupKey) {
  return normalizeAnalyticsChartRows(aiRows, groupKey)
    .filter((r) => r.SaleNetAmount > 0)
    .sort((a, b) => b.SaleNetAmount - a.SaleNetAmount);
}

function mergeBreakdownYoY(chartRows, pyAiRows, groupKey) {
  const pyMap = new Map(
    mapAnalyticsBreakdownRows(pyAiRows, groupKey).map((r) => [stripInvisible(r.label), r.SaleNetAmount])
  );
  return chartRows.map((r) => ({
    label: r.label,
    SaleNetAmount: r.SaleNetAmount,
    PY_SaleNetAmount: pyMap.has(stripInvisible(r.label)) ? pyMap.get(stripInvisible(r.label)) : 0,
  }));
}


