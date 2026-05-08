/**
 * Result checksums and lightweight anomaly flags before visualization.
 */
"use strict";

const crypto = require("crypto");

function hashRows(rows, valueKeys) {
  const lines = [];
  for (const r of rows || []) {
    const parts = valueKeys.map((k) => `${k}=${r[k]}`);
    lines.push(parts.join("|"));
  }
  lines.sort();
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

function sumSeries(rows, valueKey) {
  let s = 0;
  for (const r of rows || []) {
    s += Number(r[valueKey]) || 0;
  }
  return s;
}

/**
 * @param {{ label: string, metric_value: number }[]} breakdownRows
 * @param {number} kpiTotal
 */
function anomalyScan(breakdownRows, kpiTotal) {
  const warnings = [];
  const rows = breakdownRows || [];
  if (!rows.length || !Number.isFinite(kpiTotal) || kpiTotal <= 0) {
    return { warnings, concentrationRatio: null };
  }
  let maxShare = 0;
  let topLabel = "";
  for (const r of rows) {
    const v = Number(r.metric_value) || 0;
    const share = v / kpiTotal;
    if (share > maxShare) {
      maxShare = share;
      topLabel = String(r.label || "");
    }
  }
  if (maxShare > 0.85) {
    warnings.push({
      code: "concentration",
      severity: "info",
      message: `Top slice "${topLabel}" is ${(maxShare * 100).toFixed(1)}% of total — verify filters or seasonality.`,
    });
  }
  return { warnings, concentrationRatio: maxShare, topLabel };
}

/**
 * Simple spike / dip detection on trend series (before paint).
 */
function trendZScoreAnomalies(rows, metricKey = "metric_value", k = 3.5) {
  const warnings = [];
  const r = rows || [];
  if (r.length < 5) return { warnings };
  const vals = r.map((x) => Number(x[metricKey]) || 0);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(vals.length - 1, 1);
  const sd = Math.sqrt(Math.max(variance, 0));
  if (sd < 1e-9 || mean <= 0) return { warnings };
  const spikes = [];
  r.forEach((row, i) => {
    const z = Math.abs((vals[i] - mean) / sd);
    if (z >= k) {
      const label = row.period_label != null ? String(row.period_label) : `#${i}`;
      spikes.push({ z, label, v: vals[i] });
    }
  });
  spikes.sort((a, b) => b.z - a.z);
  for (const s of spikes.slice(0, 3)) {
    warnings.push({
      code: "trend_spike",
      severity: "info",
      message: `Spike/dip at ${s.label}: ${s.v.toFixed(2)} (${s.z.toFixed(1)}σ from mean).`,
    });
  }
  return { warnings };
}

function median(nums) {
  const s = nums.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Modified z-score using MAD (robust to existing spikes in the window).
 * @see Iglewicz & Hoaglin
 */
function madModifiedZScores(values) {
  const med = median(values);
  const dev = values.map((v) => Math.abs(v - med));
  const mad = median(dev);
  if (mad < 1e-12) {
    return values.map(() => 0);
  }
  return values.map((v) => (0.6745 * Math.abs(v - med)) / mad);
}

/**
 * Robust level anomalies (replaces/supplements Gaussian z on heavy-tailed retail series).
 */
function trendMadAnomalies(rows, metricKey = "metric_value", threshold = 3.5) {
  const warnings = [];
  const anomalies = [];
  const r = rows || [];
  if (r.length < 5) return { warnings, anomalies };
  const vals = r.map((x) => Number(x[metricKey]) || 0);
  if (vals.every((v) => v === 0)) return { warnings, anomalies };
  const mz = madModifiedZScores(vals);
  const hit = [];
  r.forEach((row, i) => {
    if (mz[i] >= threshold) {
      const label = row.period_label != null ? String(row.period_label) : `#${i}`;
      hit.push({ mz: mz[i], label, v: vals[i] });
    }
  });
  hit.sort((a, b) => b.mz - a.mz);
  for (const s of hit.slice(0, 3)) {
    const w = {
      code: "anomaly_trend_level_mad",
      severity: s.mz >= 5 ? "warn" : "info",
      alert: s.mz >= 5,
      message: `Unusual level at ${s.label}: ${s.v.toFixed(2)} (robust z≈${s.mz.toFixed(1)} vs series).`,
    };
    warnings.push(w);
    anomalies.push({ ...w, kind: "trend_level", period: s.label, value: s.v, score: s.mz });
  }
  return { warnings, anomalies };
}

/**
 * Period-over-period % change outliers (simple "structural break" detector).
 */
function trendPopAnomalies(rows, metricKey = "metric_value", zTh = 2.8, absPctWarn = 0.75) {
  const warnings = [];
  const anomalies = [];
  const r = rows || [];
  if (r.length < 6) return { warnings, anomalies };
  const vals = r.map((x) => Number(x[metricKey]) || 0);
  const pcts = [];
  for (let i = 1; i < vals.length; i++) {
    const prev = vals[i - 1];
    const curr = vals[i];
    if (Math.abs(prev) < 1e-9) {
      pcts.push(curr > 0 ? 1 : 0);
    } else {
      pcts.push((curr - prev) / Math.abs(prev));
    }
  }
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const varP =
    pcts.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(pcts.length - 1, 1);
  const sd = Math.sqrt(Math.max(varP, 0));
  if (sd < 1e-9) return { warnings, anomalies };

  /** @type {{ z:number, pct:number, label:string }[]} */
  const hits = [];
  for (let i = 1; i < vals.length; i++) {
    const pct = pcts[i - 1];
    const z = Math.abs((pct - mean) / sd);
    const label = r[i].period_label != null ? String(r[i].period_label) : `#${i}`;
    const severe = z >= zTh && Math.abs(pct) >= absPctWarn;
    const mild = z >= zTh || (Math.abs(pct) >= absPctWarn && z >= zTh * 0.65);
    if (!mild) continue;
    hits.push({ z, pct, label, severe });
  }
  hits.sort((a, b) => b.z - a.z);
  for (const h of hits.slice(0, 3)) {
    const w = {
      code: "anomaly_trend_step_change",
      severity: h.severe ? "warn" : "info",
      alert: h.severe,
      message: `Sharp change into ${h.label}: ${(h.pct * 100).toFixed(1)}% vs prior bucket (z=${h.z.toFixed(1)} on step series).`,
    };
    warnings.push(w);
    anomalies.push({
      ...w,
      kind: "trend_step",
      period: h.label,
      pctChange: h.pct,
      z: h.z,
    });
  }
  return { warnings, anomalies };
}

/**
 * IQR outlier on a single breakdown dimension (one dominant bar).
 */
function breakdownIqrAnomaly(rows, dimensionLabel, valueKey = "metric_value", iqrFactor = 2.0) {
  const warnings = [];
  const anomalies = [];
  const r = rows || [];
  if (r.length < 4) return { warnings, anomalies };
  const vals = r.map((x) => Number(x[valueKey]) || 0).filter((v) => v > 0);
  if (vals.length < 4) return { warnings, anomalies };
  const sorted = [...vals].sort((a, b) => a - b);
  const q = (p) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
  };
  const q1 = q(0.25);
  const q3 = q(0.75);
  const iqr = q3 - q1;
  if (iqr < 1e-9) return { warnings, anomalies };
  const hiFence = q3 + iqrFactor * iqr;
  for (const row of r) {
    const v = Number(row[valueKey]) || 0;
    if (v >= hiFence && v / (q3 + 1e-9) >= 1.35) {
      const lab = String(row.label || "").trim() || "(blank)";
      const w = {
        code: "anomaly_breakdown_outlier",
        severity: "info",
        message: `${dimensionLabel} "${lab}" is far above peer quartiles (possible spike share).`,
      };
      warnings.push(w);
      anomalies.push({ ...w, kind: "breakdown", dimension: dimensionLabel, label: lab, value: v, hiFence });
      break;
    }
  }
  return { warnings, anomalies };
}

/**
 * Runs all statistical checks before widgets are serialized (pre-visualization).
 * @param {{
 *   trendRows: object[],
 *   branchRows: object[],
 *   deptRows: object[],
 *   catRows: object[],
 *   totalSales: number,
 * }} input
 */
function preVisualizationAnomalyScan(input) {
  const trendRows = input.trendRows || [];
  const branchRows = input.branchRows || [];
  const deptRows = input.deptRows || [];
  const catRows = input.catRows || [];
  const totalSales = Number(input.totalSales) || 0;

  const useMad = String(process.env.ANOMALY_USE_MAD || "1").trim() !== "0";
  const usePop = String(process.env.ANOMALY_USE_STEP || "1").trim() !== "0";
  const useZ = String(process.env.ANOMALY_USE_CLASSIC_Z || "0").trim() === "1";
  const madTh = parseFloat(process.env.ANOMALY_MAD_THRESHOLD || "3.5") || 3.5;
  const popZ = parseFloat(process.env.ANOMALY_POP_Z_THRESHOLD || "2.8") || 2.8;
  const popAbs = parseFloat(process.env.ANOMALY_POP_ABS_PCT || "0.75") || 0.75;

  const warnings = [];
  const anomalies = [];

  if (useMad) {
    const m = trendMadAnomalies(trendRows, "metric_value", madTh);
    warnings.push(...m.warnings);
    anomalies.push(...m.anomalies);
  } else if (useZ) {
    const z = trendZScoreAnomalies(trendRows, "metric_value", madTh);
    warnings.push(...z.warnings);
  }

  if (usePop) {
    const p = trendPopAnomalies(trendRows, "metric_value", popZ, popAbs);
    warnings.push(...p.warnings);
    anomalies.push(...p.anomalies);
  }

  if (String(process.env.ANOMALY_BREAKDOWN_IQR || "1").trim() !== "0") {
    if (branchRows.length >= 4 && totalSales > 0) {
      const b = breakdownIqrAnomaly(branchRows, "Branch");
      warnings.push(...b.warnings);
      anomalies.push(...b.anomalies);
    }
    if (deptRows.length >= 4 && totalSales > 0) {
      const d = breakdownIqrAnomaly(deptRows, "Department");
      warnings.push(...d.warnings);
      anomalies.push(...d.anomalies);
    }
    if (catRows.length >= 4 && totalSales > 0) {
      const c = breakdownIqrAnomaly(catRows, "Category");
      warnings.push(...c.warnings);
      anomalies.push(...c.anomalies);
    }
  }

  return { warnings, anomalies };
}

function consistencyCheck(partialSums, grandTotal, tolerance = 0.02) {
  const s = partialSums.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(grandTotal) || grandTotal === 0) return { ok: true, drift: 0 };
  const drift = Math.abs(s - grandTotal) / grandTotal;
  if (drift > tolerance) {
    return {
      ok: false,
      drift,
      message: `Breakdown sum (${s.toFixed(2)}) vs KPI (${grandTotal.toFixed(2)}) differs by ${(drift * 100).toFixed(2)}%.`,
    };
  }
  return { ok: true, drift };
}

module.exports = {
  hashRows,
  sumSeries,
  anomalyScan,
  trendZScoreAnomalies,
  trendMadAnomalies,
  trendPopAnomalies,
  breakdownIqrAnomaly,
  preVisualizationAnomalyScan,
  consistencyCheck,
  median,
  madModifiedZScores,
};
