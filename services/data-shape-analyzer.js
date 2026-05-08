/**
 * services/data-shape-analyzer.js
 *
 * VALUE-BASED column tagging + result-shape detection + chart selection.
 *
 * Key principle: look at ACTUAL DATA VALUES, not column names.
 * Column names are a secondary tiebreaker only.
 *
 * Tags:  'money' | 'count' | 'date' | 'text' | 'id' | 'ratio' | 'unknown'
 * Shapes: 'comparison' | 'trend' | 'ranking' | 'kpi' | 'distribution' | 'table' | 'empty'
 * Charts: 'bar' | 'line' | 'pie' | 'kpi_card' | 'table'
 */
"use strict";

const { decideChart } = require("./chart-decision-engine");

/* ---------------------------------------------------------------------------
   COLUMN TAGGER -- value-first, name-as-tiebreaker
--------------------------------------------------------------------------- */

/**
 * Tag each column by examining its actual values across the dataset.
 * Uses column name only when values are ambiguous.
 *
 * @param {object[]} rows
 * @returns {{ [colName]: 'money'|'count'|'date'|'text'|'id'|'ratio'|'unknown' }}
 */
function tagColumnsByValues(rows) {
  if (!rows || rows.length === 0) return {};
  var cols = Object.keys(rows[0]);
  var sample = rows.slice(0, Math.min(rows.length, 30));
  var tags = {};

  for (var ci = 0; ci < cols.length; ci++) {
    var col = cols[ci];
    var colLower = col.toLowerCase();
    var allVals = sample.map(function(r) { return r[col]; });
    var values = allVals.filter(function(v) { return v !== null && v !== undefined && v !== ""; });

    if (values.length === 0) { tags[col] = "unknown"; continue; }

    /* 1. DATE: check value format first */
    var dateCount = values.filter(function(v) {
      if (v instanceof Date) return true;
      var s = String(v);
      return (
        /^\d{4}-\d{2}-\d{2}/.test(s) ||
        /^\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(s) ||
        /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s/i.test(s)
      );
    }).length;
    if (dateCount / values.length >= 0.6) { tags[col] = "date"; continue; }

    /* 2. NUMERIC ratio */
    var numericValues = values.filter(function(v) {
      if (typeof v === "number") return true;
      var s = String(v).replace(/[,\s]/g, "");
      return s.length > 0 && !isNaN(parseFloat(s)) && isFinite(parseFloat(s));
    });
    var numericRatio = numericValues.length / values.length;

    if (numericRatio < 0.7) {
      tags[col] = "text"; continue;
    }

    /* All-numeric path */
    var nums = numericValues.map(function(v) {
      return typeof v === "number" ? v : parseFloat(String(v).replace(/[,\s]/g, ""));
    });
    var maxVal = Math.max.apply(null, nums);
    var minVal = Math.min.apply(null, nums);
    var avgVal = nums.reduce(function(a, b) { return a + b; }, 0) / nums.length;
    var allInts = nums.every(function(n) { return Number.isInteger(n) || Math.abs(n % 1) < 0.0001; });
    var hasDecimal = nums.some(function(n) { return Math.abs(n % 1) > 0.001; });
    var uniqueCount = (new Set(nums)).size;
    var uniqueRatio = uniqueCount / nums.length;

    /* 2b. HELPER/SORT columns: tag as id so they are excluded */
    var nameIsHelper = /^(sortorder|sort_order|roworder|row_order|sortkey|sort_key|displayorder|display_order|rn|rownum|rankno|seqno|sno|orderno|lineorder|itemorder)$/i.test(colLower);
    if (nameIsHelper) { tags[col] = "id"; continue; }

    /* 3. ID: all unique integers, looks like a key */
    var nameIsId = /(?:^|_)(id|no|num|code|ref|key|seq|recno|rowno|sno)(?:_|$)/i.test(colLower)
               || /^(id|no|branchid|itemid|customerid|vendorid)$/i.test(colLower);
    if (nameIsId && allInts && uniqueRatio > 0.8 && maxVal < 1e8) {
      tags[col] = "id"; continue;
    }

    /* 4. RATIO / PERCENTAGE */
    var nameIsRatio = /pct$|percent|ratio|rate$|share$|margin|growth|discount/i.test(colLower);
    if (nameIsRatio && maxVal <= 100 && minVal >= -100) { tags[col] = "ratio"; continue; }
    if (!nameIsId && !nameIsRatio && maxVal <= 100 && minVal >= 0 && hasDecimal && avgVal < 50) {
      tags[col] = "ratio"; continue;
    }

    /* 5. MONEY vs COUNT */
    var nameMoney = /amount|value|sales|revenue|net|gross|total|cost|price|profit|earning|purchase|turnover|avg|aov|average|salary|wages/i.test(colLower);
    var nameCount = /count$|qty$|quantity$|units?$|bills?$|invoices?$|orders?$|customers?$|items?$|pieces?$|txn|transactions?$|footfall/i.test(colLower);

    if (nameCount && !nameMoney) { tags[col] = "count"; continue; }
    if (nameMoney) { tags[col] = "money"; continue; }

    if (hasDecimal || avgVal > 1000) { tags[col] = "money"; continue; }
    if (allInts && avgVal <= 10000 && maxVal < 1e7) { tags[col] = "count"; continue; }

    tags[col] = avgVal > 500 ? "money" : "count";
  }

  return tags;
}

/* ---------------------------------------------------------------------------
   RESULT SHAPE DETECTOR
--------------------------------------------------------------------------- */

/**
 * Detect what kind of result set this is — delegates to chart-decision-engine.
 *
 * @param {object[]} rows
 * @param {{ [col]: string }} colTags  -- from tagColumnsByValues
 * @returns {{ shape, chartType, labelCol, valueCols, title, engine }}
 */
function detectResultShape(rows, colTags) {
  if (!rows || rows.length === 0) {
    return { shape: "empty", chartType: null, labelCol: null, valueCols: [], title: "", engine: null };
  }
  var tags = colTags || {};
  if (!tags || Object.keys(tags).length === 0) {
    tags = tagColumnsByValues(rows);
  }
  var d = decideChart(rows, tags, {});
  return {
    shape: d.shape,
    chartType: d.chartType,
    labelCol: d.labelCol,
    valueCols: d.valueCols,
    title: d.title,
    engine: {
      vizKind: d.vizKind,
      rationale: d.rationale,
      renderHints: d.renderHints,
    },
  };
}

/* ---------------------------------------------------------------------------
   FRIENDLY COLUMN NAME
--------------------------------------------------------------------------- */
function friendlyName(col) {
  return col
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------------------------------------------------------------------------
   EXPORTS
--------------------------------------------------------------------------- */
module.exports = {
  tagColumnsByValues:  tagColumnsByValues,
  detectResultShape:   detectResultShape,
  friendlyName:        friendlyName,
};
