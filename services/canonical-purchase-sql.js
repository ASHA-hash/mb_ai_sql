"use strict";

/**
 * Verified T-SQL for vendor / purchase questions.
 * PUR_REPORT has PurchaseDt + PurQty only (no MrpValue / XnDt).
 * Prefer PURXNS (NetPurNetAmount) or SUPPLIER_PUR_REPORT (PurchasePrice × PurQty).
 */

const VENDOR_PUR_TOPN_SQL = `SELECT TOP 10
  [SupplierName] AS Vendor,
  SUM(ISNULL([NetPurNetAmount], 0)) AS TotalPurchase
FROM dbo.VW_MB_POWERBI_PURXNS_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
GROUP BY [SupplierName]
HAVING SUM(ISNULL([NetPurNetAmount], 0)) > 0
ORDER BY TotalPurchase DESC`;

const VENDOR_PUR_TOPN_SUPPLIER_VIEW_SQL = `SELECT TOP 10
  [SupplierName] AS Vendor,
  SUM(ISNULL([PurchasePrice], 0) * ISNULL([PurQty], 1)) AS TotalPurchase
FROM dbo.VW_MB_POWERBI_SUPPLIER_PUR_REPORT WITH (NOLOCK)
WHERE CAST([PurDate] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
  AND CAST([PurDate] AS date) <= CAST(GETDATE() AS date)
GROUP BY [SupplierName]
HAVING SUM(ISNULL([PurchasePrice], 0) * ISNULL([PurQty], 1)) > 0
ORDER BY TotalPurchase DESC`;

function isVendorPurchaseTopNQuestion(question) {
  const q = String(question || "").toLowerCase();
  return (
    /\b(top\s*\d+|top|highest|best|leading)\b/.test(q) &&
    /\b(vendors?|suppliers?)\b/.test(q) &&
    /\b(purchase|purchases|procurement|buying)\b/.test(q) &&
    (/\b(amount|value|cost|spend|net)\b/.test(q) || /\bpurchase\s+amount\b/.test(q))
  );
}

function pickFirstColumn(cols, preferred) {
  const set = new Set((cols || []).map((c) => String(c).toLowerCase()));
  for (const p of preferred) {
    if (set.has(String(p).toLowerCase())) return p;
  }
  return null;
}

function getObjectColumns(schemaMeta, tableName) {
  const target = String(tableName || "").toLowerCase();
  const obj = (schemaMeta?.objects || []).find((o) => String(o.name || "").toLowerCase() === target);
  return (obj?.columns || []).map((c) => String(c.name || ""));
}

function monthFilterClause(dateCol, fromDate, toDate) {
  if (fromDate && toDate) {
    const f = String(fromDate).trim();
    const t = String(toDate).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t)) {
      return `WHERE CAST(p.[${dateCol}] AS date) >= '${f}' AND CAST(p.[${dateCol}] AS date) <= '${t}'`;
    }
  }
  return `WHERE CAST(p.[${dateCol}] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
  AND CAST(p.[${dateCol}] AS date) <= CAST(GETDATE() AS date)`;
}

/**
 * Build vendor top-N SQL from live column metadata (fallback when static SQL fails).
 */
function buildVendorPurchaseTopNSql(schemaMeta, question, fromDate, toDate) {
  const q = String(question || "");
  const nMatch = q.match(/\btop\s*(\d+)\b/i);
  const topN = Math.min(Math.max(parseInt(nMatch ? nMatch[1] : 10, 10) || 10, 1), 100);
  const useMtd =
    /\b(this month|mtd|current month)\b/i.test(q) || !(fromDate && toDate);

  const purxnsView = "dbo.VW_MB_POWERBI_PURXNS_REPORT";
  const purxnsCols = getObjectColumns(schemaMeta, purxnsView);
  if (purxnsCols.length) {
    const amountCol = pickFirstColumn(purxnsCols, [
      "NetPurNetAmount",
      "PurNetAmount",
      "PurMrpValue",
      "NetPurCost",
      "PurCostValue",
    ]);
    const vendorCol = pickFirstColumn(purxnsCols, ["SupplierName", "SupplierAlias", "PartyName"]);
    const dateCol = pickFirstColumn(purxnsCols, ["XnDt", "PurInvDate"]);
    if (amountCol && vendorCol) {
      const labelExpr = `ISNULL(NULLIF(LTRIM(RTRIM(CAST(p.[${vendorCol}] AS NVARCHAR(300)))),''),'Unknown')`;
      const where =
        useMtd && dateCol ? monthFilterClause(dateCol, fromDate, toDate) : "";
      return [
        `SELECT TOP (${topN})`,
        `  ${labelExpr} AS Vendor,`,
        `  SUM(ISNULL(p.[${amountCol}], 0)) AS TotalPurchase`,
        `FROM ${purxnsView} p`,
        where,
        `GROUP BY ${labelExpr}`,
        `HAVING SUM(ISNULL(p.[${amountCol}], 0)) > 0`,
        `ORDER BY TotalPurchase DESC`,
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  const supplierView = "dbo.VW_MB_POWERBI_SUPPLIER_PUR_REPORT";
  const supplierCols = getObjectColumns(schemaMeta, supplierView);
  if (supplierCols.length) {
    const hasPrice = supplierCols.some((c) => c.toLowerCase() === "purchaseprice");
    const hasQty = supplierCols.some((c) => c.toLowerCase() === "purqty");
    const vendorCol = pickFirstColumn(supplierCols, ["SupplierName", "SupplierAlias", "PartyName"]);
    const dateCol = pickFirstColumn(supplierCols, ["PurDate", "PurchaseDt", "PurInvDt"]);
    if (vendorCol && (hasPrice || hasQty)) {
      const amountExpr = hasPrice && hasQty
        ? "ISNULL(p.[PurchasePrice], 0) * ISNULL(p.[PurQty], 1)"
        : hasPrice
          ? "ISNULL(p.[PurchasePrice], 0)"
          : "ISNULL(p.[PurQty], 0)";
      const labelExpr = `ISNULL(NULLIF(LTRIM(RTRIM(CAST(p.[${vendorCol}] AS NVARCHAR(300)))),''),'Unknown')`;
      const where =
        useMtd && dateCol ? monthFilterClause(dateCol, fromDate, toDate) : "";
      return [
        `SELECT TOP (${topN})`,
        `  ${labelExpr} AS Vendor,`,
        `  SUM(${amountExpr}) AS TotalPurchase`,
        `FROM ${supplierView} p`,
        where,
        `GROUP BY ${labelExpr}`,
        `HAVING SUM(${amountExpr}) > 0`,
        `ORDER BY TotalPurchase DESC`,
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  return VENDOR_PUR_TOPN_SQL.replace(/TOP\s+10/i, `TOP ${topN}`);
}

module.exports = {
  VENDOR_PUR_TOPN_SQL,
  VENDOR_PUR_TOPN_SUPPLIER_VIEW_SQL,
  isVendorPurchaseTopNQuestion,
  buildVendorPurchaseTopNSql,
};
