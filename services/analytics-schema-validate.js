/**
 * Minimal response envelope checks before returning dashboard payloads (data contract).
 */
"use strict";

function validateDashboardPayload(p) {
  if (!p || typeof p !== "object") {
    const e = new Error("analytics_invalid_envelope");
    e.status = 500;
    throw e;
  }
  if (typeof p.kpi !== "object" || !Number.isFinite(Number(p.kpi.totalSales))) {
    const e = new Error("analytics_invalid_kpi");
    e.status = 500;
    throw e;
  }
  if (!p.widgets || typeof p.widgets !== "object") {
    const e = new Error("analytics_invalid_widgets");
    e.status = 500;
    throw e;
  }
  for (const k of ["byBranch", "byDepartment", "byCategory", "byTrend"]) {
    const w = p.widgets[k];
    if (!w || !Array.isArray(w.rows)) {
      const e = new Error(`analytics_invalid_widget_${k}`);
      e.status = 500;
      throw e;
    }
  }
}

/**
 * POST body.loadPhase === "widgets" — breakdown + insights patch (no KPI/trend).
 */
function validateWidgetsPhasePayload(p) {
  if (!p || typeof p !== "object") {
    const e = new Error("analytics_invalid_envelope");
    e.status = 500;
    throw e;
  }
  if (p.loadPhase !== "widgets") {
    const e = new Error("analytics_invalid_load_phase");
    e.status = 500;
    throw e;
  }
  if (!p.widgets || typeof p.widgets !== "object") {
    const e = new Error("analytics_invalid_widgets");
    e.status = 500;
    throw e;
  }
  for (const k of ["byBranch", "byDepartment", "byCategory"]) {
    const w = p.widgets[k];
    if (!w || !Array.isArray(w.rows)) {
      const e = new Error(`analytics_invalid_widget_${k}`);
      e.status = 500;
      throw e;
    }
  }
}

module.exports = { validateDashboardPayload, validateWidgetsPhasePayload };
