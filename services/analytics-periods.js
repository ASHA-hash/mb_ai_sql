/**
 * Preset period ranges (MTD / QTD / YTD / etc.) for parameterized analytics queries.
 *
 * Uses Indian Financial Year (starts April 1):
 *   Q1 = Apr–Jun  (month 4–6)
 *   Q2 = Jul–Sep  (month 7–9)
 *   Q3 = Oct–Dec  (month 10–12)
 *   Q4 = Jan–Mar  (month 1–3, belongs to FY of the PREVIOUS April)
 *   YTD = April 1 of current FY to today
 */
"use strict";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toIso(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function daysBetweenInclusive(fromIso, toIsoArg) {
  const a = new Date(`${fromIso}T12:00:00Z`).getTime();
  const b = new Date(`${toIsoArg}T12:00:00Z`).getTime();
  return Math.floor((b - a) / 86400000) + 1;
}

/**
 * Indian FY quarter start month (1-based) for the given 1-based month.
 * Q1 Apr–Jun → 4, Q2 Jul–Sep → 7, Q3 Oct–Dec → 10, Q4 Jan–Mar → 1
 */
function indianFyQtdStartMonth(m) {
  if (m >= 10) return 10; // Q3: Oct
  if (m >= 7)  return 7;  // Q2: Jul
  if (m >= 4)  return 4;  // Q1: Apr
  return 1;               // Q4: Jan
}

/**
 * Indian FY start: April 1 of the year that started the FY containing `month`.
 * Months 4–12 → April of same calendar year; months 1–3 → April of previous year.
 */
function indianFyStart(y, m) {
  return m >= 4 ? { y, m: 4, d: 1 } : { y: y - 1, m: 4, d: 1 };
}

/**
 * @param {string} preset - today|mtd|qtd|ytd|last_7d|last_30d|last_90d|last_180d|6m|last_6m|this_month|last_month|custom
 * @param {{ from?: string, to?: string }} [custom]
 * @param {Date} [now]
 */
function resolvePeriodRange(preset, custom, now) {
  const p = String(preset || "mtd").toLowerCase().trim();
  const ref = now && now instanceof Date ? new Date(now) : new Date();
  const y   = ref.getFullYear();
  const m   = ref.getMonth() + 1; // 1-based
  const day = ref.getDate();

  if (p === "custom") {
    const from = custom && custom.from ? String(custom.from).trim() : "";
    const to   = custom && custom.to   ? String(custom.to).trim()   : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const e = new Error("custom period requires from and to as yyyy-mm-dd");
      e.status = 400;
      e.code   = "invalid_custom_period";
      throw e;
    }
    return { preset: "custom", from, to, days: daysBetweenInclusive(from, to) };
  }

  if (p === "today") {
    return { preset: "today", from: toIso(y, m, day), to: toIso(y, m, day), days: 1 };
  }

  if (p === "mtd") {
    return { preset: "mtd", from: toIso(y, m, 1), to: toIso(y, m, day), days: day };
  }

  if (p === "qtd") {
    // Indian FY quarters: Q1=Apr, Q2=Jul, Q3=Oct, Q4=Jan
    const qStartMonth = indianFyQtdStartMonth(m);
    const start = toIso(y, qStartMonth, 1);
    return {
      preset: "qtd",
      from:   start,
      to:     toIso(y, m, day),
      days:   daysBetweenInclusive(start, toIso(y, m, day)),
    };
  }

  if (p === "ytd") {
    // Indian FY YTD: April 1 of the current FY
    const fy = indianFyStart(y, m);
    const start = toIso(fy.y, fy.m, fy.d);
    return {
      preset: "ytd",
      from:   start,
      to:     toIso(y, m, day),
      days:   daysBetweenInclusive(start, toIso(y, m, day)),
    };
  }

  if (p === "last_7d" || p === "7d") {
    const end   = new Date(ref);
    const start = new Date(ref);
    start.setDate(start.getDate() - 6);
    return {
      preset: "last_7d",
      from: toIso(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      to:   toIso(end.getFullYear(),   end.getMonth()   + 1, end.getDate()),
      days: 7,
    };
  }

  if (p === "last_30d" || p === "30d") {
    const end   = new Date(ref);
    const start = new Date(ref);
    start.setDate(start.getDate() - 29);
    return {
      preset: "last_30d",
      from: toIso(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      to:   toIso(end.getFullYear(),   end.getMonth()   + 1, end.getDate()),
      days: 30,
    };
  }

  if (p === "last_60d" || p === "60d") {
    const end = new Date(ref);
    const start = new Date(ref);
    start.setDate(start.getDate() - 59);
    return {
      preset: "last_60d",
      from: toIso(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      to: toIso(end.getFullYear(), end.getMonth() + 1, end.getDate()),
      days: 60,
    };
  }

  if (p === "last_90d" || p === "90d") {
    const end   = new Date(ref);
    const start = new Date(ref);
    start.setDate(start.getDate() - 89);
    return {
      preset: "last_90d",
      from: toIso(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      to:   toIso(end.getFullYear(),   end.getMonth()   + 1, end.getDate()),
      days: 90,
    };
  }

  /* Rolling 6 × 30 days — keep distinct from calendar "Last 6M" below. */
  if (p === "last_180d" || p === "180d") {
    const end = new Date(ref);
    const start = new Date(ref);
    start.setDate(start.getDate() - 179);
    return {
      preset: "last_180d",
      from: toIso(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      to: toIso(end.getFullYear(), end.getMonth() + 1, end.getDate()),
      days: 180,
    };
  }

  /* Last 6 calendar months (current + previous 5), month-aligned — matches Home Sales `getPeriodRange('6m')`. */
  if (p === "6m" || p === "last_6m") {
    const end = new Date(ref);
    const start = new Date(ref);
    start.setMonth(start.getMonth() - 5);
    start.setDate(1);
    return {
      preset: "6m",
      from: toIso(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      to: toIso(end.getFullYear(), end.getMonth() + 1, end.getDate()),
      days: daysBetweenInclusive(
        toIso(start.getFullYear(), start.getMonth() + 1, start.getDate()),
        toIso(end.getFullYear(), end.getMonth() + 1, end.getDate())
      ),
    };
  }

  if (p === "this_month") {
    const last = new Date(y, m, 0).getDate(); // last day of current month
    return { preset: "this_month", from: toIso(y, m, 1), to: toIso(y, m, last), days: last };
  }

  if (p === "last_month") {
    const lm   = m === 1 ? 12 : m - 1;
    const ly   = m === 1 ? y - 1 : y;
    const last = new Date(ly, lm, 0).getDate();
    return { preset: "last_month", from: toIso(ly, lm, 1), to: toIso(ly, lm, last), days: last };
  }

  const e = new Error(`Unknown period preset: ${preset}`);
  e.status = 400;
  e.code   = "unknown_period";
  throw e;
}

/**
 * India FY field (e.g. FY26) must not replace MTD/QTD/30d — clip the resolved
 * preset window to [fyFrom, fyTo]. ISO yyyy-mm-dd strings compare safely as strings.
 * @returns {object} Clipped range, or original range with fyIntersectEmpty if no overlap.
 */
function intersectPeriodWithFyBounds(periodRange, fyRange) {
  if (!periodRange || !fyRange || !periodRange.from || !periodRange.to || !fyRange.from || !fyRange.to) {
    return periodRange;
  }
  const from = periodRange.from > fyRange.from ? periodRange.from : fyRange.from;
  const to = periodRange.to < fyRange.to ? periodRange.to : fyRange.to;
  if (from > to) {
    return { ...periodRange, fyIntersectEmpty: true };
  }
  return {
    ...periodRange,
    from,
    to,
    days: daysBetweenInclusive(from, to),
  };
}

module.exports = {
  resolvePeriodRange,
  daysBetweenInclusive,
  intersectPeriodWithFyBounds,
};
