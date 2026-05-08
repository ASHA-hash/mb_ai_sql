/**
 * Chart decision engine — maps dataset shape → visualization (+ sampling / binning hints).
 *
 * Rules (weighted order):
 * 1. KPI row           → kpi_card
 * 2. Named period compare (few rows, Period column) → bar (category_comparison)
 * 3. Time series       → line (heavy series → sampling + optional bin hint → line_large)
 * 4. Part-to-whole     → pie (only small N, moderate skew / concentration)
 * 5. Category × measure→ bar | bar_horizontal
 *
 * Uses value-based colTags when provided; otherwise defers to data-shape-analyzer.tagColumnsByValues (lazy).
 */
"use strict";

const { coefficientOfVariation, progressiveHint, chartForBreakdown } = require("./analytics-chart-policy");

/** @typedef {{ mode: string, sampleSize: number, stride?: number, maxPoints?: number }} ProgressiveHint */
/** @typedef {{ unit?: 'day'|'week'|'month', reason: string, suggestedAgg?: string } | null } BinHint */

const DEFAULT_OPTS = {
  maxPieSlices: 8,
  cvSkewForPieAvoid: 2.2,
  lineLargeThreshold: 400,
  samplingCap: parseInt(process.env.CHART_ENGINE_MAX_POINTS || "500", 10) || 500,
  dailyBinSuggestionRows: 120,
};

function resolveColTags(rows, colTags) {
  if (colTags && typeof colTags === "object" && Object.keys(colTags).length > 0) return colTags;
  return require("./data-shape-analyzer").tagColumnsByValues(rows || []);
}

/**
 * Parse cell to Date or null (NaN rejected).
 * @param {unknown} val
 * @returns {Date|null}
 */
function coerceDate(val) {
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  const s = String(val ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.slice(0, 10) + "T12:00:00Z");
    return isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  if (m) {
    const d = new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Ratio of ISO-like strings in label column sample.
 */
function labelColumnLooksLikeDates(rows, labelKey, threshold) {
  if (!labelKey || !rows.length) return false;
  const sample = rows.slice(0, Math.min(rows.length, 50));
  let ok = 0;
  let empty = 0;
  for (const r of sample) {
    const s = String(r[labelKey] ?? "").trim();
    if (!s) {
      empty++;
      continue;
    }
    if (coerceDate(s)) ok++;
    else if (/^(today|yesterday)$/i.test(s)) ok++;
  }
  const denom = sample.length - empty;
  return denom > 0 && ok / denom >= threshold;
}

/**
 * Are parsed dates monotone non-decreasing in row order (common for ORDER BY)?
 */
function datesNonDecreasingInOrder(rows, labelKey, minParsable) {
  const dates = [];
  for (let i = 0; i < rows.length; i++) {
    const d = coerceDate(rows[i][labelKey]);
    if (d) dates.push(d.getTime());
  }
  if (dates.length < minParsable) return false;
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] < dates[i - 1]) return false;
  }
  return true;
}

/** Is span of successive day-grain-ish labels near (n-1) days median? heuristic for daily granularity */
function likelyDailyGrain(rows, labelKey) {
  const n = Math.min(rows.length, 31);
  if (n < 3) return false;
  const deltas = [];
  let prev = null;
  let c = 0;
  for (let i = 0; i < rows.length && c < n; i++) {
    const d = coerceDate(rows[i][labelKey]);
    if (!d) continue;
    if (prev) deltas.push(Math.abs(d.getTime() - prev.getTime()) / 86400000);
    prev = d;
    c++;
  }
  const med =
    deltas.length === 0
      ? NaN
      : [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)];
  return med >= 0.9 && med <= 1.2;
}

/**
 * @param {object[]} rows
 * @param {{ [col: string]: string }} [colTags]
 * @param {Partial<typeof DEFAULT_OPTS> & { simplify?: boolean }} [options]
 * @returns {{
 *   shape: string,
 *   vizKind: string,
 *   chartType: string|null,
 *   labelCol: string|null,
 *   valueCols: string[],
 *   title: string,
 *   rationale: string[],
 *   renderHints: { progressive: ProgressiveHint, binning: BinHint }
 * }}
 */
function decideChart(rows, colTags, options) {
  const opts = { ...DEFAULT_OPTS, ...(options || {}) };
  const empty = () => ({
    shape: "empty",
    vizKind: "none",
    chartType: null,
    labelCol: null,
    valueCols: [],
    title: "",
    rationale: ["empty dataset"],
    renderHints: { progressive: progressiveHint(0, opts.samplingCap), binning: null },
  });

  if (!rows || rows.length === 0) return empty();

  const tags = resolveColTags(rows, colTags || {});
  const cols = Object.keys(rows[0] || {});
  if (cols.length === 0) return empty();

  const dateCols = cols.filter((c) => tags[c] === "date");
  const moneyCols = cols.filter((c) => tags[c] === "money");
  const countCols = cols.filter((c) => tags[c] === "count");
  const textCols = cols.filter((c) => tags[c] === "text");
  const idCols = cols.filter((c) => tags[c] === "id");
  const ratioCols = cols.filter((c) => tags[c] === "ratio");
  const numericCols = ([]).concat(moneyCols, countCols, ratioCols);
  /** @type {string[]} */
  const rationale = [];
  /** @type {BinHint} */
  let binning = null;

  /** @param {ProgressiveHint} p */
  const hints = () => ({
    progressive: progressiveHint(rows.length, opts.samplingCap),
    binning,
  });

  if (rows.length === 1 && numericCols.length >= 1) {
    rationale.push("single-row aggregate ⇒ KPI tile");
    return {
      shape: "kpi",
      vizKind: "kpi",
      chartType: "kpi_card",
      labelCol: null,
      valueCols: numericCols,
      title: "Summary",
      rationale,
      renderHints: hints(),
    };
  }

  let textLabelCol = null;
  for (let i = 0; i < textCols.length; i++) {
    if (idCols.indexOf(textCols[i]) === -1) {
      textLabelCol = textCols[i];
      break;
    }
  }

  let periodCol = null;
  for (const c of textCols) {
    if (/^(period|label|range|timerange|periodlabel|periodname|comparelabel)$/i.test(c)) {
      periodCol = c;
      break;
    }
  }
  if (
    periodCol &&
    rows.length <= 12 &&
    numericCols.length >= 1 &&
    rows.slice(0, Math.min(rows.length, 6)).every((r) => {
      const v = String(r[periodCol] ?? "");
      return v.length > 0 && v.length < 40;
    })
  ) {
    rationale.push("few rows + Period-style label ⇒ category comparison bar");
    return {
      shape: "comparison",
      vizKind: "category_comparison",
      chartType: "bar",
      labelCol: periodCol,
      valueCols: numericCols,
      title: `Comparison: ${numericCols.join(" vs ")}`,
      rationale,
      renderHints: hints(),
    };
  }

  if (dateCols.length >= 1 && numericCols.length >= 1 && rows.length >= 2) {
    const timeCol = dateCols[0];
    rationale.push("date-typed axis + numeric measures ⇒ time series → line chart");
    let chartType = "line";
    if (numericCols.length > 1)
      rationale.push("multiple numeric series ⇒ multi-series line recommended");
    if (rows.length > opts.lineLargeThreshold) {
      chartType = "line_large";
      rationale.push(`${rows.length} points > ${opts.lineLargeThreshold} ⇒ line_large + sampling`);
      if (likelyDailyGrain(rows, timeCol)) {
        binning = { unit: "week", reason: "many daily buckets — optional server-side WEEK bucket for readability" };
      } else {
        binning = { unit: "month", reason: "heavy series — consider monthly buckets for dashboards" };
      }
    }
    return {
      shape: "trend",
      vizKind: "time_series",
      chartType,
      labelCol: timeCol,
      valueCols: numericCols,
      title: `Trend: ${numericCols.join(", ")}`,
      rationale,
      renderHints: hints(),
    };
  }

  if (numericCols.length === 1 && rows.length >= 3) {
    const labelGuess =
      textCols.find((c) => idCols.indexOf(c) === -1) ||
      cols.find((c) => numericCols.indexOf(c) === -1 && tags[c] === "unknown");
    if (
      labelGuess &&
      (/period|month|date|day|sale|dt|invoice|time/i.test(labelGuess) ||
        labelColumnLooksLikeDates(rows, labelGuess, 0.55)) &&
      datesNonDecreasingInOrder(rows, labelGuess, Math.min(rows.length, 2))
    ) {
      rationale.push(`label "${labelGuess}" is date-like ⇒ time_series → line`);
      let chartType = "line";
      if (rows.length > opts.lineLargeThreshold) {
        chartType = "line_large";
        if (likelyDailyGrain(rows, labelGuess))
          binning = {
            unit: "week",
            reason: ">120 daily points ⇒ suggest WEEK binning upstream",
          };
        else
          binning = { unit: "month", reason: ">400 points ⇒ suggest MONTH binning" };
      }
      return {
        shape: "trend",
        vizKind: "time_series",
        chartType,
        labelCol: labelGuess,
        valueCols: numericCols,
        title: `Trend: ${numericCols[0]}`,
        rationale,
        renderHints: hints(),
      };
    }
  }

  const valuesForPie = [];
  const pieValueCol =
    numericCols.find((c) => moneyCols.includes(c)) || numericCols.find((c) => countCols.includes(c)) || numericCols[0];
  const pieEligible =
    Boolean(textLabelCol) &&
    moneyCols.length === 1 &&
    countCols.length === 0 &&
    ratioCols.length === 0 &&
    rows.length > 1;

  if (pieEligible && pieValueCol) {
    rows.forEach((r) => {
      const x = typeof r[pieValueCol] === "number" ? r[pieValueCol] : parseFloat(String(r[pieValueCol]).replace(/,/g, ""));
      if (Number.isFinite(x) && x >= 0) valuesForPie.push(x);
    });
    const cvVal = coefficientOfVariation(valuesForPie);
    const n = rows.length;
    if (
      n <= opts.maxPieSlices &&
      cvVal < opts.cvSkewForPieAvoid &&
      numericCols.length === 1
    ) {
      rationale.push(
        `${n} slices, CV=${cvVal.toFixed(2)} < ${opts.cvSkewForPieAvoid} ⇒ part-to-whole → pie`,
        "(part-to-whole / contribution semantics)"
      );
      return {
        shape: "distribution",
        vizKind: "contribution",
        chartType: "pie",
        labelCol: textLabelCol,
        valueCols: [pieValueCol],
        title: `Distribution: ${pieValueCol}`,
        rationale,
        renderHints: hints(),
      };
    }
    if (n <= opts.maxPieSlices || cvVal >= opts.cvSkewForPieAvoid)
      rationale.push(
        cvVal >= opts.cvSkewForPieAvoid
          ? `high skew CV=${cvVal.toFixed(2)} — bar easier to read than pie`
          : "too many categories for pie slice readability"
      );
  }

  if (textLabelCol && numericCols.length >= 1) {
    const subVals = numericCols
      .length === 1
      ? rows.map((r) => {
          const x =
            typeof r[numericCols[0]] === "number" ? r[numericCols[0]] : parseFloat(String(r[numericCols[0]]).replace(/,/g, ""));
          return Number.isFinite(x) ? x : NaN;
        })
      : rows.map(() => NaN); // fallback: no single measure for breakdown rule
    const clean = numericCols.length === 1 ? subVals.filter((x) => Number.isFinite(x) && x >= 0) : [];
    let chartSubtype = chartForBreakdown(
      rows.length,
      rows.map((r) => String(r[textLabelCol] ?? "")),
      clean
    );
    const vizKindCmp = chartSubtype === "pie" ? "contribution" : "category_comparison";
    rationale.push(
      `categorical label + ${numericCols.length} measure(s) ⇒ ${chartSubtype} (${vizKindCmp})`
    );
    if (rows.length > opts.samplingCap) {
      rationale.push(`row count ${rows.length} > cap ${opts.samplingCap} — apply even stride sampling for render`);
    }
    return {
      shape: chartSubtype === "pie" ? "distribution" : "ranking",
      vizKind: vizKindCmp,
      chartType: chartSubtype,
      labelCol: textLabelCol,
      valueCols: numericCols,
      title: `${numericCols.join(" & ")} by ${textLabelCol}`,
      rationale,
      renderHints: hints(),
    };
  }

  rationale.push("no clear axis — default bar or table in UI");
  return {
    shape: "table",
    vizKind: "ambiguous",
    chartType: "bar",
    labelCol: cols[0],
    valueCols: numericCols.length > 0 ? numericCols : cols.slice(1),
    title: "Results",
    rationale,
    renderHints: hints(),
  };
}

/**
 * Even-stride row indices for client-side downsample (preserves first/last).
 * @param {number} n
 * @param {number} maxPoints
 * @returns {number[]}
 */
function sampleRowIndices(n, maxPoints) {
  if (n <= maxPoints) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / maxPoints);
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx.slice(0, maxPoints);
}

module.exports = {
  decideChart,
  sampleRowIndices,
  DEFAULT_OPTS,
};
