/*
  Analytics rollup layer for SQL Server — complements Node services/analytics-dashboard.js

  Goals
  - Reduce scans on multi-million-row line / invoice-grain tables
  - Support MTD / QTD / YTD via filtered SUM on daily grain (no separate period tables required)
  - Align column names with env: SALES_FILTER_DATE_COLUMN + SALES_ANALYTICS_* (Branch/Dept/Cat/Amount)

  Application wiring
    ANALYTICS_USE_LINE_ROLLUP=1
    ANALYTICS_ROLLUP_DAILY_TABLE=dbo.ErpAgg_Sales_Day_Branch_Dept_Cat
    ANALYTICS_ROLLUP_LINECOUNT_COLUMN=LineCount   (Σ line items in grain)

  Maintenance: hourly/near-real-time MERGE from fact (or nightly full rebuild).
*/

/* ── Example: partitioned daily aggregate (tune FILEGROUP paths in production) ─────────── */

IF OBJECT_ID(N'dbo.ErpAgg_Sales_Day_Branch_Dept_Cat', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ErpAgg_Sales_Day_Branch_Dept_Cat (
    SaleDate            date            NOT NULL,
    BranchName          nvarchar(200)   NOT NULL,
    DepartmentName      nvarchar(200)   NOT NULL,
    CategoryName        nvarchar(200)   NOT NULL,
    SaleNetAmount       decimal(38, 4)  NOT NULL CONSTRAINT DF_ErpAgg_Sales_Amt DEFAULT (0),
    LineCount           bigint          NOT NULL CONSTRAINT DF_ErpAgg_Sales_LC DEFAULT (0),
    AsOfUtc             datetime2(3)    NOT NULL CONSTRAINT DF_ErpAgg_Sales_AsOf DEFAULT (sysutcdatetime()),
    CONSTRAINT PK_ErpAgg_Sales_D PRIMARY KEY CLUSTERED (SaleDate, BranchName, DepartmentName, CategoryName)
  );
END
GO

/* Sliding-window partition (swap monthly filegroups in prod; RANGE RIGHT monthly) */
IF NOT EXISTS (SELECT 1 FROM sys.partition_functions WHERE name = N'PF_SaleDateMonthly')
BEGIN
  CREATE PARTITION FUNCTION PF_SaleDateMonthly (date) AS RANGE RIGHT FOR VALUES (
    '2024-07-01','2024-08-01','2024-09-01','2024-10-01','2024-11-01','2024-12-01',
    '2025-01-01','2025-02-01','2025-03-01','2025-04-01','2025-05-01','2025-06-01'
    -- extend quarterly via MERGE SPLIT as months roll forward
  );
END
GO

/*
  Optional nonclustered columnstore on rollup (good for arbitrary WHERE SaleDate BETWEEN + GROUP BY dims)
  DROP INDEX CCI_ErpAgg_Sales ON dbo.ErpAgg_Sales_Day_Branch_Dept_Cat;
  CREATE CLUSTERED COLUMNSTORE INDEX CCI_ErpAgg_Sales ON dbo.ErpAgg_Sales_Day_Branch_Dept_Cat;
*/

CREATE NONCLUSTERED INDEX IX_ErpAgg_Sales_Date_Amt
  ON dbo.ErpAgg_Sales_Day_Branch_Dept_Cat (SaleDate)
  INCLUDE (SaleNetAmount, LineCount, BranchName, DepartmentName, CategoryName);

CREATE NONCLUSTERED INDEX IX_ErpAgg_Sales_Branch_Date
  ON dbo.ErpAgg_Sales_Day_Branch_Dept_Cat (BranchName, SaleDate)
  INCLUDE (SaleNetAmount, LineCount);

GO

/*
  ── MERGE template from line-level view (adapt column names to your ERP view) ────────────────
  Run on schedule (e.g. every 15 min) for incremental days.
*/

/*
MERGE dbo.ErpAgg_Sales_Day_Branch_Dept_Cat AS tgt
USING (
  SELECT
      CAST(v.InvoiceDt AS date) AS SaleDate,
      CAST(ISNULL(v.BranchName, N'') AS nvarchar(200)) AS BranchName,
      CAST(ISNULL(v.DepartmentName, N'') AS nvarchar(200)) AS DepartmentName,
      CAST(ISNULL(v.CategoryName, N'') AS nvarchar(200)) AS CategoryName,
      SUM(ISNULL(v.SaleNetAmount, 0)) AS SaleNetAmount,
      CAST(COUNT_BIG(*) AS bigint) AS LineCount
    FROM dbo.VwAISalesData AS v
   WHERE CAST(v.InvoiceDt AS date) >= @FromDateInclusive
     AND CAST(v.InvoiceDt AS date) <= @ToDateInclusive
   GROUP BY
       CAST(v.InvoiceDt AS date),
       CAST(ISNULL(v.BranchName, N'') AS nvarchar(200)),
       CAST(ISNULL(v.DepartmentName, N'') AS nvarchar(200)),
       CAST(ISNULL(v.CategoryName, N'') AS nvarchar(200))
) AS src
ON  tgt.SaleDate = src.SaleDate
AND tgt.BranchName = src.BranchName
AND tgt.DepartmentName = src.DepartmentName
AND tgt.CategoryName = src.CategoryName
WHEN MATCHED THEN UPDATE SET
  tgt.SaleNetAmount = src.SaleNetAmount,
  tgt.LineCount     = src.LineCount,
  tgt.AsOfUtc       = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (
  SaleDate, BranchName, DepartmentName, CategoryName, SaleNetAmount, LineCount
) VALUES (
  src.SaleDate, src.BranchName, src.DepartmentName, src.CategoryName, src.SaleNetAmount, src.LineCount
);
*/

/*
  ── Indexes on SOURCE line table / view baseline (facts at millions of rows) ───────────────

  Aim: SEEK on date range + INCLUDE dimensions + INCLUDE amount for SUM without lookups.

CREATE NONCLUSTERED INDEX IX_VwAISales_InvoiceDt_CoverAgg
ON dbo.VwAISalesData (InvoiceDt)
INCLUDE (
  BranchName, DepartmentName, CategoryName,
  SaleNetAmount, Quantity, InvoiceNo
)
WHERE InvoiceDt >= '2020-01-01';  -- filtered index optional on very wide history

  If filters use CAST(InvoiceDt AS date) BETWEEN :from AND :to — match index key on CAST:
CREATE NONCLUSTERED INDEX IX_VwAISales_DtDate
ON dbo.VwAISalesData (CAST(InvoiceDt AS DATE))
INCLUDE (SaleNetAmount, BranchName);

  Avoid leading LIKE on BranchName unless necessary; equality + date seek preferred.

*/

/*
  ── Optional: persisted calendar for fiscal (India FY) KPI slices ───────────────────────────
  dbo.Dim_Date with ISO date, FiscalYear, FiscalQuarter, FiscalMonth —
  JOIN rollup.SaleDate = Dim_Date.Date for FY MTD/YTD predicates without YEAR/MONTH in WHERE.
*/

/*
  ── MTD / QTD / YTD (no extra tables — filter on granular rollup) ───────────────────────────

  MTD: WHERE SaleDate BETWEEN @MonthStart AND @AsOfCalendarDate
  QTD: calendar quarter boundaries from Dim_Date / computed params
  YTD: fiscal or calendar FY start through @AsOfCalendarDate

  Application already passes @from,@to → same predicates as today; rollup row count stays O(days×cardinalityDims).
*/
