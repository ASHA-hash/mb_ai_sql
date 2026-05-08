/**
 * Optional RBAC: set RBAC_ENABLED=1 and maintain users + roles.
 *
 * Storage:
 *   - If RBAC_DATABASE_URL or DATABASE_URL is set → PostgreSQL (tables erp_rbac_*).
 *   - Else → users-config.json next to this file.
 *
 * Two auth flows:
 *   1. Apps Script / Chrome extension: X-User-Email header (Google account email).
 *   2. Web dashboard: Authorization: Bearer <JWT> (issued by /api/auth/login).
 *
 * The API key (X-API-Key) is a separate, additional shared-secret guard.
 */
const fs = require("fs");
const path = require("path");
const rbacPg = require("./rbac-pg");

// Lazy-load to avoid circular dependency (auth.js loads before rbac in runtime)
let _auth = null;
function getAuth() {
  if (!_auth) _auth = require("./auth");
  return _auth;
}

const CONFIG_PATH = path.join(__dirname, "users-config.json");

/** @type {'file' | 'pg'} */
let storageMode = "file";

let cachedConfig = null;
let cachedMtimeMs = null;

function rbacEnabled() {
  const v = String(process.env.RBAC_ENABLED || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function loadUsersConfigFromFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("[rbac] RBAC is on but users-config.json is missing at", CONFIG_PATH);
    return { roles: {}, users: [] };
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

/**
 * Call once before server.listen when DATABASE_URL / RBAC_DATABASE_URL may be set.
 */
async function initStorage() {
  if (rbacEnabled() && rbacPg.isConfigured()) {
    storageMode = "pg";
    cachedConfig = await rbacPg.initAndLoad(CONFIG_PATH);
    cachedMtimeMs = null;
    console.log("[rbac] storage: PostgreSQL (RBAC_DATABASE_URL or DATABASE_URL)");
  } else {
    storageMode = "file";
    cachedConfig = null;
    cachedMtimeMs = null;
    if (rbacEnabled()) {
      try {
        const st = fs.statSync(CONFIG_PATH);
        cachedConfig = loadUsersConfigFromFile();
        cachedMtimeMs = st.mtimeMs;
      } catch (e) {
        if (e.code !== "ENOENT") {
          console.error("[rbac] read config failed:", e.message);
        }
        cachedConfig = { roles: {}, users: [] };
      }
    }
    console.log("[rbac] storage: users-config.json (set DATABASE_URL for Postgres persistence)");
  }
}

function loadUsersConfigFresh() {
  if (storageMode === "pg") {
    return cachedConfig || { roles: {}, users: [] };
  }
  return loadUsersConfigFromFile();
}

function getUsersConfig() {
  if (!rbacEnabled()) {
    return null;
  }
  if (storageMode === "pg") {
    return cachedConfig;
  }
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (!cachedConfig || st.mtimeMs !== cachedMtimeMs) {
      cachedConfig = loadUsersConfigFromFile();
      cachedMtimeMs = st.mtimeMs;
    }
    return cachedConfig;
  } catch (e) {
    if (e.code === "ENOENT") {
      return { roles: {}, users: [] };
    }
    console.error("[rbac] read config failed:", e.message);
    return cachedConfig || { roles: {}, users: [] };
  }
}

function invalidateConfigCache() {
  cachedConfig = null;
  cachedMtimeMs = null;
}

function getRoleForEmail(email) {
  const cfg = getUsersConfig();
  if (!cfg || !email) {
    return null;
  }
  const e = String(email).trim().toLowerCase();
  const u = (cfg.users || []).find((x) => String(x.email || "").trim().toLowerCase() === e);
  if (!u) {
    return null;
  }
  const roleDef = cfg.roles && cfg.roles[u.role];
  if (!roleDef) {
    return null;
  }
  return {
    roleKey: u.role,
    features: Array.isArray(roleDef.features) ? roleDef.features.slice() : [],
    datasets: roleDef.datasets,
  };
}

function rbacMiddleware(req, res, next) {
  const p = req.path || "";
  // Skip RBAC for health and login only. change-password needs Bearer → req.rbac.email.
  if (!p.startsWith("/api/") || p === "/api/health" || p === "/api/auth/login") {
    return next();
  }
  if (!rbacEnabled()) {
    return next();
  }

  // KPIs endpoint: allow MONITORING_API_KEY without user JWT (for Prometheus / cron scrapers).
  if (p === "/api/monitoring/kpis" || p === "/api/monitoring/kpis/") {
    const sec = String(process.env.MONITORING_API_KEY || "").trim();
    const sent = String(req.get("x-monitoring-key") || "").trim();
    if (sec && sent === sec) {
      return next();
    }
  }

  // ── Path 1: Bearer JWT (web dashboard) ──────────────────────
  const authHeader = String(req.get("authorization") || req.get("Authorization") || "").trim();
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const payload = getAuth().verifyToken(token);
    if (!payload) {
      return res.status(401).json({
        error: "invalid_token",
        message: "JWT is invalid or has expired. Please log in again.",
      });
    }
    req.rbac = {
      email:    payload.email,
      roleKey:  payload.role,
      features: Array.isArray(payload.features) ? payload.features : [],
      datasets: payload.datasets || "*",
    };
    return next();
  }

  // ── Path 1b: EventSource cannot send Authorization — ?access_token= JWT for analytics SSE only
  const qtok = String(
    (req.query && (req.query.access_token || req.query.token)) || ""
  ).trim();
  if (qtok && (p === "/api/analytics/events" || p === "/api/analytics/events/")) {
    const payload = getAuth().verifyToken(qtok);
    if (payload) {
      req.rbac = {
        email: payload.email,
        roleKey: payload.role,
        features: Array.isArray(payload.features) ? payload.features.slice() : [],
        datasets: payload.datasets || "*",
      };
      return next();
    }
    return res.status(401).json({
      error: "invalid_token",
      message: "JWT is invalid or expired (use a fresh token for analytics SSE).",
    });
  }

  // ── Path 2: X-User-Email header (Apps Script / Chrome extension) ──
  const email = String(req.get("x-user-email") || req.get("X-User-Email") || "").trim();
  if (!email) {
    return res.status(403).json({
      error: "access_denied",
      message:
        "Missing credentials. Send 'Authorization: Bearer <token>' (dashboard) or " +
        "'X-User-Email: your@email.com' (Apps Script).",
    });
  }
  const role = getRoleForEmail(email);
  if (!role) {
    return res.status(403).json({
      error: "access_denied",
      message: `No role configured for ${email}. Ask an administrator to add you in user management.`,
    });
  }
  req.rbac = { email, ...role };
  next();
}

function requireFeature(feature) {
  return (req, res, next) => {
    if (!rbacEnabled()) {
      return next();
    }
    const feats = req.rbac && req.rbac.features;
    if (!feats || !feats.includes(feature)) {
      return res.status(403).json({
        error: "feature_denied",
        message: `Your role does not include: ${feature}`,
      });
    }
    next();
  };
}

/** Admin JSON API is only meaningful when RBAC is on (otherwise do not expose user list). */
function requireAdminApi(req, res, next) {
  if (!rbacEnabled()) {
    return res.status(403).json({
      error: "rbac_disabled",
      message: "Set RBAC_ENABLED=1 on the server to use /api/admin/*.",
    });
  }
  return requireFeature("admin")(req, res, next);
}

function filterDatasets(datasets, rbacCtx) {
  if (!rbacEnabled() || !rbacCtx) {
    return datasets;
  }
  const allowed = rbacCtx.datasets;
  if (allowed === "*") {
    return datasets;
  }
  if (!Array.isArray(allowed)) {
    return [];
  }
  const set = new Set(allowed.map((k) => String(k).toLowerCase()));
  return (datasets || []).filter((d) => set.has(String(d.key || "").toLowerCase()));
}

function assertDatasetAllowed(rbacCtx, datasetKey) {
  if (!rbacEnabled()) {
    return true;
  }
  if (!rbacCtx) {
    return false;
  }
  const dk = String(datasetKey || "").toLowerCase().trim();
  const allowed = rbacCtx.datasets;
  if (allowed === "*") {
    return true;
  }
  if (!Array.isArray(allowed)) {
    return false;
  }
  return allowed.map((k) => String(k).toLowerCase()).includes(dk);
}

/**
 * @param {object[]} users
 * @returns {Promise<number>}
 */
async function validateAndReplaceUsers(users) {
  const cfg =
    storageMode === "pg"
      ? getUsersConfig()
      : loadUsersConfigFromFile();
  if (!cfg.roles || typeof cfg.roles !== "object") {
    throw new Error(
      storageMode === "pg"
        ? "roles missing in database (bootstrap failed?)"
        : "users-config.json must define roles"
    );
  }
  if (!Array.isArray(users)) {
    throw new Error("users must be an array");
  }
  const existingByEmail = {};
  for (const u of cfg.users || []) {
    existingByEmail[String(u.email || "").toLowerCase()] = u;
  }

  const cleaned = users.map((u) => {
    const email = String(u.email || "").trim();
    const existing = existingByEmail[email.toLowerCase()] || {};
    return {
      email,
      role:         String(u.role || "").trim(),
      name:         String(u.name || existing.name || "").trim(),
      passwordHash: u.passwordHash != null
        ? String(u.passwordHash)
        : (existing.passwordHash || ""),
    };
  });
  for (const u of cleaned) {
    if (!u.email || !u.role) {
      throw new Error("Each user needs a non-empty email and role");
    }
    if (!cfg.roles[u.role]) {
      throw new Error(`Unknown role "${u.role}" for ${u.email}`);
    }
  }

  if (storageMode === "pg") {
    await rbacPg.replaceUsers(cleaned);
    cachedConfig = await rbacPg.fetchFullConfig();
    return cleaned.length;
  }

  cfg.users = cleaned;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  invalidateConfigCache();
  return cleaned.length;
}

/**
 * @param {string} email
 * @param {string} newHash
 * @returns {Promise<void>}
 */
function usesPostgresForUsers() {
  return storageMode === "pg";
}

async function setUserPasswordHash(email, newHash) {
  if (storageMode === "pg") {
    await rbacPg.setPasswordHash(email, newHash);
    cachedConfig = await rbacPg.fetchFullConfig();
    return;
  }
  const cfg = loadUsersConfigFromFile();
  const e = String(email || "").trim().toLowerCase();
  const user = (cfg.users || []).find(
    (u) => String(u.email || "").trim().toLowerCase() === e
  );
  if (!user) throw new Error(`User not found: ${email}`);
  user.passwordHash = String(newHash);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  invalidateConfigCache();
}

module.exports = {
  rbacEnabled,
  rbacMiddleware,
  requireFeature,
  requireAdminApi,
  filterDatasets,
  assertDatasetAllowed,
  getRoleForEmail,
  getUsersConfig,
  loadUsersConfigFresh,
  validateAndReplaceUsers,
  setUserPasswordHash,
  invalidateConfigCache,
  initStorage,
  usesPostgresForUsers,
  CONFIG_PATH,
};
