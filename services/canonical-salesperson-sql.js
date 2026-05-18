"use strict";

/**
 * Salesperson / staff ranking — use SalesPersonName on SLS lines, NOT SupplierName on APP_REPORT
 * (SupplierName there is the vendor/brand on the line, often one value per month).
 */

const DEFAULT_TABLE = "dbo.VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID";

function getSalespersonTopNTable() {
  const raw =
    process.env.SALESPERSON_TOPN_VIEW ||
    process.env.VW_AI_SALESPERSON_VIEW ||
    process.env.MB_POWERBI_SLS_DATA_WITHOUT_ITEMID_VIEW ||
    DEFAULT_TABLE;
  const s = String(raw || "").trim();
  return s.startsWith("dbo.") ? s : `dbo.${s}`;
}

function isSalespersonTopNQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (isSalespersonUnitsQuestion(question)) return true;
  const wantsStaff =
    /\b(salesperson|salespersons|sales\s*person|sales\s*people|sales\s*rep|salesrep|sales\s*man|salesmen|staff|employees?|executives?)\b/.test(
      q
    ) ||
    whoMostPhrase(q);
  const wantsRank =
    /\b(top\s*\d+|top|highest|best|leading|rank(?:ing)?|most|lowest|worst)\b/.test(q);
  const wantsMetric =
    /\b(revenue|sales|amount|value|turnover|performance|gross|net)\b/.test(q) ||
    /\b(units?|qty|quantity|pieces|pcs)\b/.test(q) ||
    /\bsold\b/.test(q);
  const purchaseVendor =
    /\b(purchase|procurement|inward|grn)\b/.test(q) &&
    !/\b(salespersons?|sales\s*person|sales\s*people|sales\s*rep|staff)\b/.test(q);
  return wantsStaff && wantsRank && wantsMetric && !purchaseVendor;
}

function labelExpr(col) {
  return `ISNULL(NULLIF(LTRIM(RTRIM(CAST([${col}] AS NVARCHAR(200)))), ''), '(Unknown)')`;
}

function buildSalespersonTopNSql(question, fromDate, toDate) {
  const q = String(question || "");
  const nMatch = q.match(/\btop\s*(\d+)\b/i);
  const whoMost = /\b(who|which)\b/i.test(q) && /\b(most|highest|best)\b/i.test(q);
  const singleWinner =
    !nMatch &&
    /\b(highest|best|leading|top)\b/i.test(q) &&
    /\b(salespersons?|sales\s*people|sales\s*person|sales\s*rep|staff)\b/i.test(q);
  const topN = Math.min(
    Math.max(
      parseInt(nMatch ? nMatch[1] : whoMost || singleWinner ? 1 : 10, 10) ||
        (whoMost || singleWinner ? 1 : 10),
      1
    ),
    100
  );
  const orderByUnits = /\b(units?|qty|quantity|pieces|pcs)\b/i.test(q);
  const table = getSalespersonTopNTable();
  const useMtd =
    /\b(this month|mtd|current month)\b/i.test(q) || !(fromDate && toDate);

  let dateWhere;
  if (useMtd) {
    dateWhere = `CAST([CashmemoDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
  AND CAST([CashmemoDt] AS date) <= CAST(GETDATE() AS date)`;
  } else if (fromDate && toDate) {
    dateWhere = `CAST([CashmemoDt] AS date) >= CAST('${String(fromDate).replace(/'/g, "''")}' AS date)
  AND CAST([CashmemoDt] AS date) <= CAST('${String(toDate).replace(/'/g, "''")}' AS date)`;
  } else {
    dateWhere = `CAST([CashmemoDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
  AND CAST([CashmemoDt] AS date) <= CAST(GETDATE() AS date)`;
  }

  const staffLabel = labelExpr("SalesPersonName");

  return [
    `SELECT TOP (${topN})`,
    `  ${staffLabel} AS StaffName,`,
    `  SUM(ISNULL([SalesNetAmount], 0)) AS TotalSales,`,
    `  SUM(ISNULL([SalesQuantity], 0)) AS TotalUnitsSold,`,
    `  COUNT(DISTINCT [CashmemoNo]) AS Bills`,
    `FROM ${table} WITH (NOLOCK)`,
    `WHERE ${dateWhere}`,
    `  AND NULLIF(LTRIM(RTRIM([SalesPersonName])), '') IS NOT NULL`,
    `GROUP BY ${staffLabel}`,
    orderByUnits
      ? `HAVING SUM(ISNULL([SalesQuantity], 0)) > 0`
      : `HAVING SUM(ISNULL([SalesNetAmount], 0)) > 0`,
    orderByUnits ? `ORDER BY TotalUnitsSold DESC` : `ORDER BY TotalSales DESC`,
  ].join("\n");
}

function isSalespersonUnitsQuestion(question) {
  const q = String(question || "").toLowerCase();
  return (
    (/\b(salespersons?|sales\s*people|sales\s*person|sales\s*rep|staff|who)\b/.test(q) ||
      whoMostPhrase(q)) &&
    /\b(units?|qty|quantity|pieces|pcs)\b/.test(q) &&
    /\b(most|top|highest|best|sold)\b/.test(q) &&
    !/\b(purchase|vendor|supplier|procurement)\b/.test(q)
  );
}

function whoMostPhrase(q) {
  return /\bwho\b/.test(q) && /\b(sold|sell|sales)\b/.test(q);
}

function getCanonicalSalespersonContext() {
  return {
    table: getSalespersonTopNTable(),
    staffCol: "SalesPersonName",
    dateCol: "CashmemoDt",
    amountCol: "SalesNetAmount",
    qtyCol: "SalesQuantity",
    billCol: "CashmemoNo",
  };
}

module.exports = {
  getSalespersonTopNTable,
  isSalespersonTopNQuestion,
  isSalespersonUnitsQuestion,
  buildSalespersonTopNSql,
  getCanonicalSalespersonContext,
};
