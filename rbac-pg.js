/**
 * PostgreSQL persistence for RBAC users + roles.
 * Used when RBAC_DATABASE_URL or DATABASE_URL is set (e.g. Render Postgres).
 * Mirror data still uses MIRROR_DATABASE_URL — keep those separate.
 */
"use strict";

const fs = require("fs");
const { Pool } = require("pg");

/** @type {import("pg").Pool | null} */
let pool = null;

function connectionString() {
  return String(process.env.RBAC_DATABASE_URL || process.env.DATABASE_URL || "").trim();
}

function sslOption(url) {
  if (String(process.env.RBAC_PG_SSL || "").trim() === "0") {
    return false;
  }
  try {
    const u = new URL(url.replace(/^postgresql:/i, "http:"));
    const host = (u.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") {
      return false;
    }
  } catch (_) {
    /* ignore */
  }
  return { rejectUnauthorized: false };
}

function datasetsFromRow(val) {
  if (val === "*" || val === null || val === undefined) {
    return "*";
  }
  if (typeof val === "string") {
    return val;
  }
  if (Array.isArray(val)) {
    return val;
  }
  return "*";
}

/**
 * @param {string} configPath users-config.json path for one-time bootstrap
 * @returns {Promise<{ roles: object, users: object[] }>}
 *
 * Bootstrap policy (DB-first after first deploy):
 *   - ROLES: always synced from users-config.json (roles are config, not user data).
 *   - USERS: seeded from file ONLY when erp_rbac_users is empty (very first deploy).
 *            After that the DB is the single source of truth — deleting a user via
 *            the admin panel stays deleted across redeployments.
 */
async function initAndLoad(configPath) {
  const conn = connectionString();
  if (!conn) {
    throw new Error("rbac-pg: no RBAC_DATABASE_URL or DATABASE_URL");
  }
  pool = new Pool({ connectionString: conn, ssl: sslOption(conn) });
  const client = await pool.connect();
  try {
    // Create tables + a bootstrap-flag table
    await client.query(`
      CREATE TABLE IF NOT EXISTS erp_rbac_roles (
        role_key TEXT PRIMARY KEY,
        features_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        datasets_json JSONB NOT NULL DEFAULT '"*"'::jsonb
      );
      CREATE TABLE IF NOT EXISTS erp_rbac_users (
        email TEXT PRIMARY KEY,
        role_key TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS erp_rbac_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS erp_sql_templates (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        sql         TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_by  TEXT NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Check if users have already been bootstrapped from the file
    const { rows: metaRows } = await client.query(
      "SELECT value FROM erp_rbac_meta WHERE key = 'users_bootstrapped'"
    );
    const alreadyBootstrapped = metaRows.length > 0;

    if (!alreadyBootstrapped && fs.existsSync(configPath)) {
      // FIRST DEPLOY ONLY: seed roles + users from users-config.json
      const raw = fs.readFileSync(configPath, "utf8");
      const cfg = JSON.parse(raw);
      const roles = cfg.roles || {};
      for (const [roleKey, def] of Object.entries(roles)) {
        const features = Array.isArray(def.features) ? def.features : [];
        const datasets = def.datasets != null ? def.datasets : "*";
        await client.query(
          `INSERT INTO erp_rbac_roles (role_key, features_json, datasets_json)
           VALUES ($1, $2::jsonb, $3::jsonb)
           ON CONFLICT (role_key) DO NOTHING`,
          [roleKey, JSON.stringify(features), JSON.stringify(datasets)]
        );
      }
      for (const u of cfg.users || []) {
        const email = String(u.email || "").trim();
        const role  = String(u.role  || "").trim();
        if (!email || !role) continue;
        await client.query(
          `INSERT INTO erp_rbac_users (email, role_key, name, password_hash)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (email) DO NOTHING`,
          [
            email,
            role,
            String(u.name || "").trim(),
            String(u.passwordHash != null ? u.passwordHash : ""),
          ]
        );
      }
      // Mark as bootstrapped — never re-seed users from file again
      await client.query(
        `INSERT INTO erp_rbac_meta (key, value) VALUES ('users_bootstrapped', $1)
         ON CONFLICT (key) DO NOTHING`,
        [new Date().toISOString()]
      );
      console.log("[rbac-pg] First-run bootstrap: roles + users seeded from users-config.json.");
    } else if (alreadyBootstrapped) {
      console.log("[rbac-pg] DB already bootstrapped — users-config.json ignored for users.");
    }
  } finally {
    client.release();
  }

  // Always sync role definitions (features/datasets) from config file on every deploy.
  // Roles are application config (not user data), so this is safe and keeps them in sync.
  await syncRolesFromFile(configPath);

  // NOTE: syncMissingUsersFromFile is intentionally NOT called here.
  // After the first bootstrap the DB is the single source of truth for users.
  // Users deleted via the admin panel stay deleted across redeployments.

  return fetchFullConfig();
}

/**
 * Add users that exist in users-config.json but not yet in Postgres.
 * Bootstrap only runs when roles table was empty; this catches new rows added to Git later.
 */
async function syncMissingUsersFromFile(configPath) {
  if (!pool || !fs.existsSync(configPath)) {
    return;
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (_) {
    return;
  }
  const roles = cfg.roles || {};
  const users = cfg.users || [];
  const client = await pool.connect();
  try {
    for (const u of users) {
      const email = String(u.email || "").trim();
      const role = String(u.role || "").trim();
      if (!email || !role || !roles[role]) {
        continue;
      }
      const exists = await client.query(
        "SELECT 1 FROM erp_rbac_users WHERE lower(email) = lower($1) LIMIT 1",
        [email]
      );
      if (exists.rowCount > 0) {
        continue;
      }
      await client.query(
        `INSERT INTO erp_rbac_users (email, role_key, name, password_hash)
         VALUES ($1, $2, $3, $4)`,
        [
          email,
          role,
          String(u.name || "").trim(),
          String(u.passwordHash != null ? u.passwordHash : ""),
        ]
      );
      console.log("[rbac-pg] Inserted user from users-config.json (was missing in DB):", email);
    }
  } finally {
    client.release();
  }
}

/** Keep role definitions in sync with repo `users-config.json` on each deploy. */
async function syncRolesFromFile(configPath) {
  if (!pool || !fs.existsSync(configPath)) {
    return;
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (_) {
    return;
  }
  const roles = cfg.roles || {};
  const client = await pool.connect();
  try {
    for (const [roleKey, def] of Object.entries(roles)) {
      const features = Array.isArray(def.features) ? def.features : [];
      const datasets = def.datasets != null ? def.datasets : "*";
      await client.query(
        `INSERT INTO erp_rbac_roles (role_key, features_json, datasets_json)
         VALUES ($1, $2::jsonb, $3::jsonb)
         ON CONFLICT (role_key) DO UPDATE SET
           features_json = EXCLUDED.features_json,
           datasets_json = EXCLUDED.datasets_json`,
        [roleKey, JSON.stringify(features), JSON.stringify(datasets)]
      );
    }
  } finally {
    client.release();
  }
}

/**
 * @returns {Promise<{ roles: object, users: object[] }>}
 */
async function fetchFullConfig() {
  if (!pool) {
    throw new Error("rbac-pg: pool not initialized");
  }
  const rolesRes = await pool.query(
    "SELECT role_key, features_json, datasets_json FROM erp_rbac_roles ORDER BY role_key"
  );
  const usersRes = await pool.query(
    "SELECT email, role_key, name, password_hash FROM erp_rbac_users ORDER BY email"
  );
  const roles = {};
  for (const row of rolesRes.rows) {
    roles[row.role_key] = {
      features: Array.isArray(row.features_json) ? row.features_json : [],
      datasets: datasetsFromRow(row.datasets_json),
    };
  }
  const users = usersRes.rows.map((row) => ({
    email: row.email,
    role: row.role_key,
    name: row.name || "",
    passwordHash: row.password_hash || "",
  }));
  return { roles, users };
}

/**
 * @param {Array<{ email: string, role: string, name: string, passwordHash: string }>} cleaned
 */
async function replaceUsers(cleaned) {
  if (!pool) {
    throw new Error("rbac-pg: pool not initialized");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM erp_rbac_users");
    for (const u of cleaned) {
      await client.query(
        `INSERT INTO erp_rbac_users (email, role_key, name, password_hash)
         VALUES ($1, $2, $3, $4)`,
        [u.email, u.role, u.name || "", u.passwordHash || ""]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * @param {string} email
 * @param {string} newHash
 */
async function setPasswordHash(email, newHash) {
  if (!pool) {
    throw new Error("rbac-pg: pool not initialized");
  }
  const e = String(email || "").trim().toLowerCase();
  const r = await pool.query(
    "UPDATE erp_rbac_users SET password_hash = $1 WHERE lower(email) = $2",
    [String(newHash), e]
  );
  if (r.rowCount === 0) {
    throw new Error(`User not found: ${email}`);
  }
}

function isConfigured() {
  return !!connectionString();
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/* ── SQL Templates — stored in PostgreSQL so they survive redeployments ──── */

/**
 * List all SQL templates, newest first.
 * @returns {Promise<Array<{id,name,sql,desc,createdAt,updatedAt,createdBy}>>}
 */
async function listSqlTemplates() {
  if (!pool) return null; // caller falls back to JSON file
  const r = await pool.query(
    "SELECT id, name, sql, description, created_by, created_at, updated_at FROM erp_sql_templates ORDER BY created_at DESC"
  );
  return r.rows.map((row) => ({
    id:        row.id,
    name:      row.name,
    sql:       row.sql,
    desc:      row.description || "",
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Create a new SQL template.
 * @param {{ id: string, name: string, sql: string, desc?: string, createdBy?: string }} tpl
 */
async function createSqlTemplate(tpl) {
  if (!pool) return null;
  await pool.query(
    `INSERT INTO erp_sql_templates (id, name, sql, description, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
    [tpl.id, tpl.name, tpl.sql, tpl.desc || "", tpl.createdBy || ""]
  );
}

/**
 * Update an existing SQL template.
 * @param {string} id
 * @param {{ name: string, sql: string, desc?: string }} fields
 * @returns {Promise<boolean>} true if found and updated
 */
async function updateSqlTemplate(id, fields) {
  if (!pool) return false;
  const r = await pool.query(
    `UPDATE erp_sql_templates SET name = $1, sql = $2, description = $3, updated_at = NOW()
     WHERE id = $4`,
    [fields.name, fields.sql, fields.desc || "", id]
  );
  return r.rowCount > 0;
}

/**
 * Delete a SQL template.
 * @param {string} id
 * @returns {Promise<boolean>} true if found and deleted
 */
async function deleteSqlTemplate(id) {
  if (!pool) return false;
  const r = await pool.query("DELETE FROM erp_sql_templates WHERE id = $1", [id]);
  return r.rowCount > 0;
}

/**
 * One-time import: copy templates from JSON array into Postgres (skips duplicates).
 * @param {Array<{id,name,sql,desc,createdBy,createdAt}>} templates
 */
async function importSqlTemplatesFromJson(templates) {
  if (!pool || !Array.isArray(templates) || templates.length === 0) return;
  for (const t of templates) {
    await pool.query(
      `INSERT INTO erp_sql_templates (id, name, sql, description, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        t.id,
        t.name,
        t.sql,
        t.desc || t.description || "",
        t.createdBy || t.created_by || "",
        t.createdAt || t.created_at || new Date(),
        t.updatedAt || t.updated_at || new Date(),
      ]
    );
  }
}

module.exports = {
  connectionString,
  initAndLoad,
  syncRolesFromFile,
  fetchFullConfig,
  replaceUsers,
  setPasswordHash,
  isConfigured,
  closePool,
  listSqlTemplates,
  createSqlTemplate,
  updateSqlTemplate,
  deleteSqlTemplate,
  importSqlTemplatesFromJson,
  getPool: () => pool,
};
