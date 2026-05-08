/**
 * Sales trend forecasting: statistical models (OLS linear trend, Holt double exponential).
 * Pipeline: ingest history → fit → project horizons + approximate bands → chart-ready payload.
 */
"use strict";

const MIN_POINTS_LINEAR = parseInt(process.env.ANALYTICS_FORECAST_MIN_POINTS || "5", 10) || 5;
const MIN_POINTS_HOLT = parseInt(process.env.ANALYTICS_FORECAST_MIN_POINTS_HOLT || "8", 10) || 8;

function olsLinear(xs, ys) {
  const n = xs.length;
  if (n < 2) return { a: ys[0] || 0, b: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-18) return { a: sy / n, b: 0 };
  const b = (n * sxy - sx * sy) / den;
  const a = sy / n - (b * sx) / n;
  return { a, b };
}

function fittedLinear(xs, ys, a, b) {
  return xs.map((x) => a + b * x);
}

/** Simple linear regression prediction interval (approximate, homoskedastic). */
function linearPredictionBands(xs, ys, a, b, xFuture) {
  const n = xs.length;
  const fitted = fittedLinear(xs, ys, a, b);
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - fitted[i]) ** 2;
  const df = Math.max(1, n - 2);
  const sigma = Math.sqrt(sse / df);
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1e-12;
  const z = 1.96;
  return xFuture.map((xf) => {
    const se = sigma * Math.sqrt(1 + 1 / n + (xf - mx) ** 2 / sxx);
    const yhat = a + b * xf;
    return {
      mid: yhat,
      lo: Math.max(0, yhat - z * se),
      hi: yhat + z * se,
    };
  });
}

/**
 * Holt linear trend (double exponential smoothing).
 * @param {number[]} y
 * @param {number} alpha level 0-1
 * @param {number} beta trend 0-1
 */
function holtFit(y, alpha, beta, horizon) {
  if (y.length < 3) {
    const last = y[y.length - 1] || 0;
    return {
      level: last,
      trend: 0,
      forecast: new Array(horizon).fill(Math.max(0, last)),
      lower: new Array(horizon).fill(Math.max(0, last * 0.9)),
      upper: new Array(horizon).fill(last * 1.1),
    };
  }
  let L = y[0];
  let T = y[1] - y[0];
  for (let t = 1; t < y.length; t++) {
    const prevL = L;
    L = alpha * y[t] + (1 - alpha) * (L + T);
    T = beta * (L - prevL) + (1 - beta) * T;
  }
  const out = [];
  const lo = [];
  const hi = [];
  const mae =
    y.reduce((s, v, i) => {
      if (i === 0) return s;
      return s + Math.abs(y[i] - y[i - 1]);
    }, 0) /
    Math.max(1, y.length - 1);
  const band = Math.max(mae * 1.2, L * 0.03);
  for (let h = 1; h <= horizon; h++) {
    const f = L + h * T;
    const v = Math.max(0, f);
    out.push(v);
    lo.push(Math.max(0, v - band * Math.sqrt(h)));
    hi.push(v + band * Math.sqrt(h));
  }
  return { level: L, trend: T, forecast: out, lower: lo, upper: hi };
}

function addMonthsYm(ym, delta) {
  const [Y, M] = String(ym)
    .trim()
    .split("-")
    .map((x) => parseInt(x, 10));
  if (!Number.isFinite(Y) || !Number.isFinite(M)) return null;
  const d = new Date(Y, M - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addDaysIso(iso, delta) {
  const d = new Date(`${String(iso).trim().slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function nextPeriodLabels(lastLabel, granularity, count) {
  const lab = String(lastLabel || "").trim();
  const out = [];
  if (granularity === "month") {
    const m = lab.match(/^(\d{4})-(\d{2})/);
    if (!m) return null;
    let cur = `${m[1]}-${m[2]}`;
    for (let i = 1; i <= count; i++) {
      const n = addMonthsYm(cur, 1);
      if (!n) return null;
      out.push(n);
      cur = n;
    }
    return out;
  }
  if (granularity === "day") {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(lab) ? lab : null;
    if (!iso) return null;
    let cur = iso;
    for (let i = 1; i <= count; i++) {
      const n = addDaysIso(cur, 1);
      if (!n) return null;
      out.push(n);
      cur = n;
    }
    return out;
  }
  return null;
}

/**
 * @param {{
 *   series: { period_label: string, metric_value: number }[],
 *   granularity: "day"|"month",
 *   horizon?: number,
 *   method?: "linear"|"holt",
 * }} opts
 */
function buildSalesForecast(opts) {
  const series = Array.isArray(opts.series) ? opts.series : [];
  const granularity = opts.granularity === "month" ? "month" : "day";
  const hzRaw = opts.horizon != null ? opts.horizon : process.env.ANALYTICS_FORECAST_HORIZON || "4";
  const horizon = Math.min(Math.max(parseInt(String(hzRaw), 10) || 4, 1), 36);
  const method = String(opts.method || process.env.ANALYTICS_FORECAST_METHOD || "linear").toLowerCase();

  const clean = series
    .map((r) => ({
      period_label: String(r.period_label || "").trim(),
      v: parseFloat(String(r.metric_value)) || 0,
    }))
    .filter((r) => r.period_label);

  if (clean.length < Math.min(MIN_POINTS_LINEAR, MIN_POINTS_HOLT)) {
    return {
      enabled: false,
      reason: "insufficient_history",
      minPoints: MIN_POINTS_LINEAR,
    };
  }

  const ys = clean.map((r) => r.v);
  const xs = clean.map((_, i) => i);
  const lastLabel = clean[clean.length - 1].period_label;
  const futureLabels = nextPeriodLabels(lastLabel, granularity, horizon);
  if (!futureLabels || futureLabels.length !== horizon) {
    return { enabled: false, reason: "period_parse_failed", lastLabel };
  }

  const useHolt = method === "holt" && clean.length >= MIN_POINTS_HOLT;
  if (useHolt) {
    const alpha = parseFloat(process.env.ANALYTICS_FORECAST_HOLT_ALPHA || "0.35") || 0.35;
    const beta = parseFloat(process.env.ANALYTICS_FORECAST_HOLT_BETA || "0.12") || 0.12;
    const h = holtFit(ys, alpha, beta, horizon);
    const avgGrowth =
      ys.length >= 2 ? (ys[ys.length - 1] - ys[0]) / Math.max(1, ys.length - 1) / Math.max(ys[0], 1e-9) : 0;
    return {
      enabled: true,
      method: "holt_linear_trend",
      horizon,
      granularity,
      periodLabels: futureLabels,
      values: h.forecast,
      lower: h.lower,
      upper: h.upper,
      anchorLabel: lastLabel,
      metrics: {
        impliedGrowthPerStep: avgGrowth,
        level: h.level,
        trend: h.trend,
      },
      disclaimer:
        "Projected from Holt smoothing on recent history — not financial guidance; use for planning signals only.",
    };
  }

  if (clean.length < MIN_POINTS_LINEAR) {
    return {
      enabled: false,
      reason: "insufficient_history_linear",
      minPoints: MIN_POINTS_LINEAR,
    };
  }

  const { a, b } = olsLinear(xs, ys);
  const xStart = xs[xs.length - 1] + 1;
  const xFuture = [];
  for (let h = 0; h < horizon; h++) xFuture.push(xStart + h);
  const bands = linearPredictionBands(xs, ys, a, b, xFuture);
  const values = bands.map((p) => Math.max(0, p.mid));
  const lower = bands.map((p) => Math.max(0, p.lo));
  const upper = bands.map((p) => Math.max(0, p.hi));

  const fitted = fittedLinear(xs, ys, a, b);
  let sse = 0;
  for (let i = 0; i < ys.length; i++) sse += (ys[i] - fitted[i]) ** 2;
  const rmse = Math.sqrt(sse / Math.max(1, ys.length - 2));

  return {
    enabled: true,
    method: "linear_ols",
    horizon,
    granularity,
    periodLabels: futureLabels,
    values,
    lower,
    upper,
    anchorLabel: lastLabel,
    metrics: {
      slope: b,
      intercept: a,
      rmse,
      meanAbsoluteStepGrowth:
        ys.length >= 2 ? (ys[ys.length - 1] - ys[0]) / Math.max(1, ys.length - 1) : 0,
    },
    disclaimer:
      "Projection from linear regression on the visible trend — uncertainty increases over the horizon; not a binding forecast.",
  };
}

module.exports = {
  buildSalesForecast,
  olsLinear,
  nextPeriodLabels,
};
