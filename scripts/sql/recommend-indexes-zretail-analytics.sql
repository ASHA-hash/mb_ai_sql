/*
  Recommended indexing pattern for zRetailHQ0 analytics (APP_REPORT / SLSXNS paths).

  IMPORTANT
  - Replace <BaseApprovalFactTable> with real table names from discover-powerbi-view-sources.sql
  - Do NOT run CREATE INDEX on dbo.ERP_Transactions_Table unless that object exists
  - UPDATE STATISTICS on base TABLES, not on views (view stats follow base tables)

  Target query shape (what the Node app runs):
    WHERE CAST(XnDt AS date) BETWEEN @from AND @to
    GROUP BY BranchAlias | DepartmentShortName | CategoryShortName | SupplierName
    SELECT SUM(MrpValue), SUM(AppQty), COUNT(DISTINCT XnNo)
*/

USE zRetailHQ0;
GO

/* ── Template A: date + branch covering index (approval / transaction fact) ── */
/*
CREATE NONCLUSTERED INDEX IX_<Table>_XnDt_Branch_Covering
ON dbo.<BaseApprovalFactTable> (XnDt, BranchAlias)
INCLUDE (XnNo, XnId, AppQty, MrpValue, CostValue, DepartmentShortName, CategoryShortName, SupplierName)
WITH (ONLINE = ON, SORT_IN_TEMPDB = ON);
GO
*/

/* ── Template B: date-only for trend GROUP BY day/month ── */
/*
CREATE NONCLUSTERED INDEX IX_<Table>_XnDt_Covering
ON dbo.<BaseApprovalFactTable> (XnDt)
INCLUDE (MrpValue, AppQty, BranchAlias, DepartmentShortName, CategoryShortName, SupplierName, XnNo)
WITH (ONLINE = ON, SORT_IN_TEMPDB = ON);
GO
*/

/* ── Template C: sales xns path (if analytics uses SLSXNS) ── */
/*
CREATE NONCLUSTERED INDEX IX_<Table>_XnDt_Branch_Sls
ON dbo.<BaseSalesFactTable> (XnDt, BranchAlias)
INCLUDE (NetSlsNetAmount, NetSlsQty, BillCount, DepartmentShortName, CategoryShortName)
WITH (ONLINE = ON, SORT_IN_TEMPDB = ON);
GO
*/

/* After indexes are created on BASE TABLES: */
/*
UPDATE STATISTICS dbo.<BaseApprovalFactTable> WITH FULLSCAN;
UPDATE STATISTICS dbo.<BaseSalesFactTable> WITH FULLSCAN;
GO
*/

/* Optional: pre-aggregated rollup table (fastest path — see scripts/analytics-rollups.sql) */
/* ANALYTICS_USE_LINE_ROLLUP=1 + ErpAgg_Sales_Day_* maintained by MERGE job */
