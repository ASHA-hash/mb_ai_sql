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
    "- On dbo.VwAISalesData use SaleNetAmount for revenue; on VW_MB_POWERBI_SLS_* use NetAmount if present in column list.",
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
