/**
 * Adaptive chart selection + progressive rendering hints (Zoho-style).
 */
"use strict";

function coefficientOfVariation(values) {
  const v = (values || []).filter((x) => Number.isFinite(x) && x >= 0);
  if (v.length < 2) return 0;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  if (Math.abs(mean) < 1e-12) return 0;
  let variance = 0;
  for (const x of v) variance += (x - mean) ** 2;
  variance /= Math.max(v.length - 1, 1);
  const sd = Math.sqrt(Math.max(variance, 0));
  return sd / mean;
}

function chartForTrend(granularity, rowCount) {
  const n = rowCount || 0;
  if (n <= 1) return "table";
  if (n > 400) return "line_large";
  return granularity === "month" ? "line" : "line";
}

/**
 * @param {number} rowCount
 * @param {string[]} [labels] — longest label steers horizontal bars when many long names
 * @param {number[]} [metricValues] — skew / concentration → prefer bar over pie
 */
function chartForBreakdown(rowCount, labels, metricValues) {
  const n = rowCount || 0;
  if (n <= 0) return "table";
  const cv = coefficientOfVariation(metricValues);
  const maxLab = (labels || []).reduce((m, s) => Math.max(m, String(s || "").length), 0);
  if (n <= 8) {
    if (cv >= 2.2) return "bar";
    return "pie";
  }
  if (n <= 24) {
    if (maxLab > 22) return "bar_horizontal";
    return "bar";
  }
  return "bar_horizontal";
}

function progressiveHint(rowCount, maxPoints = 500) {
  if (rowCount <= maxPoints) {
    return { mode: "full", sampleSize: rowCount, maxPoints };
  }
  const step = Math.ceil(rowCount / maxPoints);
  return { mode: "sampled", sampleSize: Math.ceil(rowCount / step), stride: step, maxPoints };
}

module.exports = {
  chartForTrend,
  chartForBreakdown,
  progressiveHint,
  coefficientOfVariation,
};
