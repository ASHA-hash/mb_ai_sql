"use strict";

const { nlToSelectSql } = require("../ai-sql");

async function repairSql({ apiKey, model, question, context, failedSql, errorMessage }) {
  const repairPrompt = [
    "The previous SQL failed validation or execution. Fix it.",
    `User question: ${question}`,
    `Failed SQL: ${failedSql}`,
    `Error: ${errorMessage}`,
    `Allowed views: ${(context.viewConfig.allowed_views || []).join(", ")}`,
    "Rules:",
    "- Return one SELECT SQL only.",
    "- Use only allowed views and listed columns.",
    "- Sales revenue: prefer dbo.VW_MB_POWERBI_SLSXNS_REPORT → SUM(NetSlsNetAmount); date column XnDt; bills → SUM(BillCount).",
    "- Do NOT use dbo.VW_MB_POWERBI_APP_REPORT unless it exists — this tenant uses SLSXNS rollup.",
    "- Never use dbo.VwAISalesData. Salesperson → VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID + SalesPersonName.",
    "- Keep SQL Server syntax.",
  ].join("\n");

  return nlToSelectSql({
    apiKey,
    model,
    question: repairPrompt,
    schemaCatalog: JSON.stringify(
      {
        viewConfig: context.viewConfig,
        liveColumns: context.liveColumns || {},
      },
      null,
      2
    ),
  });
}

module.exports = { repairSql };
