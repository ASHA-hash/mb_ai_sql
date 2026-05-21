/**
 * Typed API client for the FastAPI backend.
 * All calls go through /api/* — proxied to :8000 in dev, served from same origin in prod.
 */

const BASE = import.meta.env.VITE_API_URL ?? "";

/** Browser fetch has no default timeout; stalled proxies/SQL can hang the UI forever. */
const DEFAULT_FETCH_TIMEOUT_MS = Number(import.meta.env.VITE_FETCH_TIMEOUT_MS ?? 125_000);

// ── Auth ──────────────────────────────────────────────────────────────────────
let _token: string | null = localStorage.getItem("erp_token");

export function setToken(t: string | null) {
  _token = t;
  if (t) localStorage.setItem("erp_token", t);
  else    localStorage.removeItem("erp_token");
}
export function getToken() { return _token; }

// ── Core fetch ────────────────────────────────────────────────────────────────
async function _fetch<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (_token) headers["Authorization"] = `Bearer ${_token}`;

  const ctrl = new AbortController();
  const tid = window.setTimeout(() => ctrl.abort(), timeoutMs);
  if (options.signal) {
    options.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...options, headers, signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(
        `Request timed out after ${timeoutMs / 1000}s — check that the API is running${BASE ? "" : " (Vite proxies /api to :8000)"}.`,
      );
    }
    throw e;
  } finally {
    window.clearTimeout(tid);
  }

  if (res.status === 401) {
    setToken(null);
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

const get  = <T>(path: string, options: RequestInit = {}, timeoutMs?: number) =>
  _fetch<T>(path, { method: "GET", ...options }, timeoutMs);
const post = <T>(path: string, body: unknown, timeoutMs?: number) =>
  _fetch<T>(path, { method: "POST", body: JSON.stringify(body) }, timeoutMs);
const patch = <T>(path: string, body: unknown)    => _fetch<T>(path, { method: "PATCH",  body: JSON.stringify(body) });
const del   = <T>(path: string)                   => _fetch<T>(path, { method: "DELETE" });

// ── Types ─────────────────────────────────────────────────────────────────────
export interface User {
  email:   string;
  role:    string;
  name:    string;
  roleDef: { features: string[] | "*"; datasets: string[] | "*" };
}

export interface LoginResponse {
  token: string;
  user:  User;
}

export interface QueryResponse {
  answer:          string;
  sql:             string;
  data:            Record<string, unknown>[];
  rowCount:        number;
  confidence:      "high" | "medium" | "low";
  confidenceNote:  string;
  nodeLog:         string[];
  intent:          unknown;
  retryCount:      number;
  elapsedMs:       number;
  provider:        string;
}

export interface HistoryEntry {
  query: string;
  ts:    string;
}

export interface Suggestion {
  text:   string;
  source: "rag" | "default";
}

export interface Template {
  id:          string;
  name:        string;
  sql:         string;
  description: string;
  created_by:  string;
  created_at:  string;
  updated_at:  string;
}

export interface KpiSlice {
  sales: number;
  bills: number;
  quantitySold?: number;
  customerCount?: number;
}

export interface KpiData {
  today?: KpiSlice;
  mtd?:   KpiSlice;
  asOf?:  string;
  error?: string;
}

export interface PeriodKpi {
  period: string;
  totalSales: number;
  billCount: number;
  txnCount: number;
  quantitySold: number;
  customerCount: number;
  error?: string;
}

export interface PeriodData {
  data:      { label: string; value: number; bills: number }[];
  period:    string;
  dimension: string;
  rowCount:  number;
  error?:    string;
}

export interface TrendData {
  data: { day: string; value: number; bills: number }[];
  days: number;
  error?: string;
}

/** Charts in one server-side parallel batch (see GET /api/analytics/home-bundle). */
export interface HomeBundle {
  branch?:      PeriodData;
  department?:  PeriodData;
  category?:    PeriodData;
  trend?:        TrendData;
  yoy?:          { cy: number; ly: number; change: number; period?: string; error?: string };
  errors?:       string[];
  asOf?:         string;
}

/** Analytics tab — sequential SQL on server, one HTTP call. */
export interface AnalyticsPageBundle {
  period:     string;
  dimension:  string;
  breakdown?: PeriodData;
  trend?:     TrendData;
  yoy?:       { cy: number; ly: number; change: number; period?: string; error?: string };
  errors?:    string[];
  asOf?:      string;
}

/** Full Analytics page — KPI + all dimensions + trend + YoY. */
export interface AnalyticsSnapshot {
  period:        string;
  periodRange?:  { from: string; to: string };
  description?:  string;
  table?:        string;
  asOf?:         string;
  yoySupported?: boolean;
  fyLabel?:      string | null;
  fyNote?:       string | null;
  crossFilter?:  Record<string, string>;
  dimensions?:   { branch: string; department: string; category: string };
  loadPhase?:    string;
  kpi?:          PeriodKpi;
  branch?:       PeriodData;
  department?:   PeriodData;
  category?:     PeriodData;
  trend?:        TrendData & { granularity?: string };
  yoy?:          { cy: number; ly: number; change: number; period?: string; supported?: boolean; error?: string };
  errors?:       string[];
}

export interface AnalyticsSnapshotOpts {
  period:       string;
  top?:         number;
  fy?:          string;
  customFrom?:  string;
  customTo?:    string;
  crossFilter?: Record<string, string>;
  trendMonth?:  string;
  trendGrain?:  "auto" | "day" | "month";
  loadPhase?:   "critical" | "widgets" | "full";
}

// ── Auth API ──────────────────────────────────────────────────────────────────
export const auth = {
  login:       (email: string, password: string) =>
    post<LoginResponse>("/api/auth/login", { email, password }),
  me:          () => get<User>("/api/auth/me"),
  listUsers:   () => get<{ email: string; role: string; name: string }[]>("/api/auth/users"),
  createUser:  (body: { email: string; role: string; name: string; password: string }) =>
    post("/api/auth/users", body),
  updateUser:  (email: string, updates: { role?: string; name?: string; password?: string }) =>
    patch(`/api/auth/users/${encodeURIComponent(email)}`, updates),
  deleteUser:  (email: string) => del(`/api/auth/users/${encodeURIComponent(email)}`),
};

// ── Query API ─────────────────────────────────────────────────────────────────
export const query = {
  adaptive: (body: {
    question:            string;
    aiProvider?:         string;
    conversationHistory?: { question: string; sql: string; summary?: string }[];
    userDateRange?:      { from?: string; to?: string };
    tableHint?:          string;
  }) => post<QueryResponse>("/api/query/adaptive", body, 360_000),

  feedback: (body: {
    question:  string;
    sql:       string;
    corrected?: string;
    helpful?:  boolean;
    note?:     string;
  }) => post("/api/query/feedback", body),

  history:      () => get<{ history: HistoryEntry[] }>("/api/query/history"),
  clearHistory: () => del("/api/query/history"),
  suggestions:  () => get<{ suggestions: Suggestion[]; fromRag: boolean }>("/api/query/suggestions"),
};

function buildAnalyticsSnapshotQs(opts: AnalyticsSnapshotOpts): string {
  const p = new URLSearchParams({
    period: opts.period,
    top: String(opts.top ?? 8),
    load_phase: opts.loadPhase ?? "full",
    trend_grain: opts.trendGrain ?? "auto",
  });
  if (opts.fy) p.set("fy", opts.fy);
  if (opts.customFrom) p.set("custom_from", opts.customFrom);
  if (opts.customTo) p.set("custom_to", opts.customTo);
  if (opts.trendMonth) p.set("trend_month", opts.trendMonth);
  if (opts.crossFilter && Object.keys(opts.crossFilter).length > 0) {
    p.set("cross_filter", JSON.stringify(opts.crossFilter));
  }
  return p.toString();
}

// ── Analytics API ─────────────────────────────────────────────────────────────
export const analytics = {
  /** Combined today+mtd (sequential on server). Prefer kpi() per period like Node. */
  homeKpis: () => get<KpiData>("/api/analytics/home-kpis", {}, 180_000),

  /** Node GET /api/home/kpi — today is fast; mtd can take longer on large fact tables. */
  kpi: (period = "mtd", timeoutMs = 120_000) =>
    get<PeriodKpi & { ok?: boolean; error?: string }>(
      `/api/home/kpi?period=${encodeURIComponent(period)}`,
      {},
      timeoutMs,
    ),

  /** Branch + dept + category + trend in one request (parallel SQL on server). */
  homeBundle: (opts?: { period?: string; trendDays?: number; top?: number; includeYoy?: boolean }) => {
    const p = new URLSearchParams({
      period: opts?.period ?? "mtd",
      trend_days: String(opts?.trendDays ?? 30),
      top: String(opts?.top ?? 10),
      include_yoy: opts?.includeYoy ? "true" : "false",
    });
    return get<HomeBundle>(`/api/analytics/home-bundle?${p}`, {}, 300_000);
  },

  /** One request for Analytics page (breakdown → trend → yoy on server). */
  pageBundle: (opts?: {
    period?: string;
    dimension?: string;
    trendDays?: number;
    includeYoy?: boolean;
  }) => {
    const period = opts?.period ?? "mtd";
    const trendDays =
      opts?.trendDays ??
      (period === "ytd" || period === "qtd" ? 90 : period === "today" || period === "yesterday" ? 14 : 30);
    const p = new URLSearchParams({
      period,
      dimension: opts?.dimension ?? "branch",
      trend_days: String(trendDays),
      top: "10",
      include_yoy: (opts?.includeYoy ?? (period === "mtd" || period === "ytd")) ? "true" : "false",
    });
    return get<AnalyticsPageBundle>(`/api/analytics/page-bundle?${p}`, {}, 300_000);
  },

  period: (period = "mtd", dimension = "branch", top = 10, timeoutMs = 240_000) =>
    get<PeriodData>(
      `/api/analytics/period?period=${period}&dimension=${dimension}&top=${top}`,
      {},
      timeoutMs,
    ),

  trend: (days = 30, timeoutMs = 180_000) =>
    get<TrendData>(`/api/analytics/trend?days=${days}`, {}, timeoutMs),

  /** Trend for same window as period chip (MTD → days in current month only). */
  trendForPeriod: (period = "mtd", timeoutMs = 180_000) =>
    get<TrendData>(`/api/analytics/trend?period=${encodeURIComponent(period)}`, {}, timeoutMs),

  yoy: (period = "mtd", timeoutMs = 240_000) =>
    get<{ cy: number; ly: number; change: number; error?: string }>(
      `/api/analytics/yoy?period=${period}`,
      {},
      timeoutMs,
    ),

  snapshot: (opts: AnalyticsSnapshotOpts = { period: "mtd" }, timeoutMs = 300_000) =>
    get<AnalyticsSnapshot>(
      `/api/analytics/snapshot?${buildAnalyticsSnapshotQs(opts)}`,
      {},
      timeoutMs,
    ),

  flushCache: () => post<{ ok: boolean }>("/api/analytics/invalidate-cache", {}),

  testDb:   () => get<{ ok: boolean }>("/api/analytics/test-db"),
};

// ── SQL Templates API ─────────────────────────────────────────────────────────
export const templates = {
  list:   () => get<{ templates: Template[] }>("/api/sql-templates/"),
  create: (body: { name: string; sql: string; description?: string }) =>
    post<{ id: string }>("/api/sql-templates/", body),
  update: (id: string, body: { name?: string; sql?: string; description?: string }) =>
    patch(`/api/sql-templates/${id}`, body),
  delete: (id: string) => del(`/api/sql-templates/${id}`),
};

// ── RAG API ───────────────────────────────────────────────────────────────────
export const rag = {
  stats:        () => get<{ total: number; byType: Record<string, number> }>("/api/rag/stats"),
  listExamples: () => get<{ examples: unknown[] }>("/api/rag/examples"),
  listGlossary: () => get<{ glossary: unknown[] }>("/api/rag/glossary"),
  addExample:   (question: string, sql: string, note?: string) =>
    post("/api/rag/examples", { question, sql, note }),
  addGlossary:  (term: string, definition: string) =>
    post("/api/rag/glossary", { term, definition }),
  search:       (q: string, k = 5, type?: string) =>
    post("/api/rag/search", { query: q, k, type }),
  delete:       (id: string) => del(`/api/rag/${id}`),
};

// ── Admin API ─────────────────────────────────────────────────────────────────
export const admin = {
  status:          () => get<Record<string, unknown>>("/api/admin/status"),
  getSettings:     () => get<{ settings: Record<string, string> }>("/api/admin/settings"),
  updateSetting:   (key: string, value: string) =>
    post("/api/admin/settings", { key, value }),
  bulkUpdate:      (settings: Record<string, string>) =>
    post("/api/admin/settings/bulk", { settings }),
  listRoles:       () => get<{ roles: unknown[] }>("/api/admin/roles"),
};

export interface DatasetInfo {
  name: string;
  type: string;
  columnCount: number;
}

export interface ConnectorConfig {
  hardCap: number;
  maxLimit: number;
  datasetCount: number;
  defaultLimit?: number;
  limits?: { hardCap: number; pageMax: number; defaultLimit: number };
}

// ── Datasets / connector ─────────────────────────────────────────────────────
export interface ConnectorDataset {
  key: string;
  label: string;
  objectName: string;
  shortName?: string;
  accessDenied?: boolean;
  accessMessage?: string;
  filters?: {
    date?: { enabled: boolean };
    financialYear?: { enabled: boolean };
  };
  columnCount?: number;
}

export interface ConnectorConfigFull extends ConnectorConfig {
  datasets?: ConnectorDataset[];
  allowAll?: boolean;
  dateInputHint?: string;
}

/** Node returns a raw JSON array from GET /api/dataset/:key */
async function fetchDatasetRows(path: string, timeoutMs = 300_000): Promise<{
  data: Record<string, unknown>[];
  headers: Record<string, string>;
}> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (_token) headers["Authorization"] = `Bearer ${_token}`;
  const ctrl = new AbortController();
  const tid = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { headers, signal: ctrl.signal });
    if (res.status === 401) {
      setToken(null);
      window.location.href = "/login";
      throw new Error("Unauthorized");
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      const detail = err.detail;
      const msg = typeof detail === "string" ? detail : JSON.stringify(detail);
      throw new Error(msg || `HTTP ${res.status}`);
    }
    const hdrs: Record<string, string> = {};
    res.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v; });
    const data = (await res.json()) as Record<string, unknown>[];
    return { data: Array.isArray(data) ? data : [], headers: hdrs };
  } finally {
    window.clearTimeout(tid);
  }
}

export const datasets = {
  list: () => get<{ datasets: DatasetInfo[]; count: number }>("/api/datasets/"),
  fetch: (key: string, params?: Record<string, string>, timeoutMs = 300_000) => {
    const q = new URLSearchParams(params ?? { limit: "500" });
    return fetchDatasetRows(`/api/dataset/${encodeURIComponent(key)}?${q}`, timeoutMs);
  },
};

export const connector = {
  config: () => get<ConnectorConfigFull>("/api/connector-config"),
};

export interface SchemaObject {
  schema: string;
  name: string;
  type: string;
}

export interface SchemaColumn {
  column_name: string;
  data_type: string;
  is_nullable: string;
  max_length?: number;
  numeric_precision?: number;
  numeric_scale?: number;
  ordinal_position?: number;
}

export const schema = {
  objects: () => get<{ tables: SchemaObject[]; views: SchemaObject[]; total: number }>("/api/schema/objects"),
  columns: (sch: string, obj: string) =>
    get<SchemaColumn[]>(`/api/schema/columns/${encodeURIComponent(sch)}/${encodeURIComponent(obj)}`),
  preview: (sch: string, obj: string, limit = 15) =>
    get<Record<string, unknown>[]>(
      `/api/schema/preview/${encodeURIComponent(sch)}/${encodeURIComponent(obj)}?limit=${limit}`,
    ),
};

// ── Health ────────────────────────────────────────────────────────────────────
export const health = {
  check: () => get<{ status: string; version: string }>("/api/health"),
};
