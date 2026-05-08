/**
 * auth.js — JWT signing/verification + PBKDF2 password hashing.
 * Zero external dependencies (only Node.js built-in `crypto`).
 *
 * Environment variables:
 *   JWT_SECRET              — signing key (REQUIRED in production)
 *   TOKEN_EXPIRY_HOURS      — session length (default 8)
 *   ADMIN_DEFAULT_PASSWORD  — fallback for users with no passwordHash yet
 */
"use strict";

const crypto = require("crypto");

const JWT_SECRET =
  process.env.JWT_SECRET || "erp-connector-change-this-secret-in-production";
const TOKEN_HOURS = parseInt(process.env.TOKEN_EXPIRY_HOURS || "8", 10);

/* ── base64url helpers ────────────────────────────────────────── */
function toB64url(s) {
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function padB64(s) {
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}
function fromB64url(s) {
  return padB64(s.replace(/-/g, "+").replace(/_/g, "/"));
}

/* ── JWT (HS256) ──────────────────────────────────────────────── */
function signToken(payload) {
  const hdr = toB64url(
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64")
  );
  const bdy = toB64url(
    Buffer.from(JSON.stringify(payload)).toString("base64")
  );
  const sig = toB64url(
    crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${hdr}.${bdy}`)
      .digest("base64")
  );
  return `${hdr}.${bdy}.${sig}`;
}

/**
 * Verifies a JWT token. Returns the payload object or null.
 * @param {string} token
 * @returns {object|null}
 */
function verifyToken(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const [hdr, bdy, sig] = parts;
    const expected = toB64url(
      crypto
        .createHmac("sha256", JWT_SECRET)
        .update(`${hdr}.${bdy}`)
        .digest("base64")
    );
    if (sig !== expected) return null;
    const payload = JSON.parse(
      Buffer.from(fromB64url(bdy), "base64").toString("utf8")
    );
    if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

/**
 * Generates a signed JWT for a user.
 * @param {{ email, role, name, features, datasets }} user
 * @returns {string}
 */
function generateToken(user) {
  const now = Math.floor(Date.now() / 1000);
  return signToken({
    email:    user.email,
    role:     user.role,
    name:     user.name || user.email,
    features: user.features || [],
    datasets: user.datasets || "*",
    iat: now,
    exp: now + TOKEN_HOURS * 3600,
  });
}

/* ── Password hashing (PBKDF2 / SHA-256) ─────────────────────── */

/**
 * Hash a plain-text password.  Returns "pbkdf2:<salt_hex>:<hash_hex>".
 * @param {string} password
 * @returns {string}
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, 100_000, 32, "sha256")
    .toString("hex");
  return `pbkdf2:${salt}:${hash}`;
}

/**
 * Verify a password against a stored hash.
 * @param {string} password   — plain text
 * @param {string} stored     — "pbkdf2:<salt>:<hash>" stored in users-config.json
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split(":");
  if (parts[0] !== "pbkdf2" || parts.length !== 3) return false;
  const [, salt, expectedHash] = parts;
  const hash = crypto
    .pbkdf2Sync(password, salt, 100_000, 32, "sha256")
    .toString("hex");
  // Constant-time compare
  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(expectedHash, "hex")
  );
}

/**
 * Check password for a user entry.  Falls back to ADMIN_DEFAULT_PASSWORD
 * env var when the user has no passwordHash (first-run setup).
 * @param {string} password
 * @param {{ passwordHash?: string, email: string }} userEntry
 * @returns {{ ok: boolean, firstRun: boolean }}
 */
function checkUserPassword(password, userEntry) {
  const stored = String(userEntry.passwordHash || "").trim();
  if (stored) {
    return { ok: verifyPassword(password, stored), firstRun: false };
  }
  // No hash set yet → allow the ADMIN_DEFAULT_PASSWORD env var (first-run only)
  const defaultPwd = String(process.env.ADMIN_DEFAULT_PASSWORD || "Admin@1234");
  const ok = password === defaultPwd;
  return { ok, firstRun: ok }; // firstRun=true signals "please change password"
}

module.exports = { generateToken, verifyToken, hashPassword, verifyPassword, checkUserPassword };
