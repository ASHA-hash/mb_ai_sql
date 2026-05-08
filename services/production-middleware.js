/**
 * Request correlation IDs and per-route-class rate limiting.
 */
"use strict";

const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { logger } = require("./logger");

function rateLimitingEnabled() {
  return String(process.env.RATE_LIMIT_ENABLED || "1").trim() !== "0";
}

function requestIdMiddleware() {
  return (req, res, next) => {
    let id = String(req.get("x-request-id") || req.get("X-Request-Id") || "").trim();
    if (!id) id = crypto.randomBytes(8).toString("hex");
    req.requestId = id;
    res.setHeader("X-Request-Id", id);
    next();
  };
}

/**
 * Returns Express middleware or no-op if rate limiting disabled.
 */
function buildApiRateLimiter() {
  if (!rateLimitingEnabled()) {
    return (_req, _res, next) => next();
  }

  const rate429 = (req, res, msg) => {
    res.status(429).json({
      error: "rate_limit_exceeded",
      message: msg,
      requestId: req.requestId,
    });
  };

  const aiLimiter = rateLimit({
    windowMs: Math.max(1000, parseInt(process.env.RATE_LIMIT_AI_WINDOW_MS || "60000", 10) || 60000),
    max: Math.max(1, parseInt(process.env.RATE_LIMIT_AI_MAX || "30", 10) || 30),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) =>
      rate429(req, res, "Too many AI query requests — slow down or try again shortly."),
  });

  const analyticsLimiter = rateLimit({
    windowMs: Math.max(1000, parseInt(process.env.RATE_LIMIT_ANALYTICS_WINDOW_MS || "60000", 10) || 60000),
    max: Math.max(1, parseInt(process.env.RATE_LIMIT_ANALYTICS_MAX || "90", 10) || 90),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => rate429(req, res, "Too many dashboard requests — try again shortly."),
  });

  const defaultApiLimiter = rateLimit({
    windowMs: Math.max(1000, parseInt(process.env.RATE_LIMIT_API_WINDOW_MS || "900000", 10) || 900000),
    max: Math.max(10, parseInt(process.env.RATE_LIMIT_API_MAX || "800", 10) || 800),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => rate429(req, res, "Too many API requests for this client."),
  });

  return (req, res, next) => {
    const p = req.path || "";
    if (!p.startsWith("/api")) return next();
    if (p === "/api/health") return next();
    if (p === "/api/monitoring/kpis" || p === "/api/monitoring/kpis/") return next();

    if (
      req.method === "POST" &&
      /^\/api\/query\/(ai|adaptive|agentic)\/?$/.test(p)
    ) {
      return aiLimiter(req, res, next);
    }
    if (req.method === "POST" && (p === "/api/analytics/dashboard" || p === "/api/analytics/dashboard/")) {
      return analyticsLimiter(req, res, next);
    }
    return defaultApiLimiter(req, res, next);
  };
}

/** Log 5xx responses for SRE dashboards (sampled noisy paths optional). */
function httpAccessLogMiddleware() {
  return (req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const status = res.statusCode;
      if (status >= 500) {
        logger.warn("http_5xx", {
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status,
          ms: Date.now() - start,
        });
      }
    });
    next();
  };
}

module.exports = {
  requestIdMiddleware,
  buildApiRateLimiter,
  httpAccessLogMiddleware,
  rateLimitingEnabled,
};
