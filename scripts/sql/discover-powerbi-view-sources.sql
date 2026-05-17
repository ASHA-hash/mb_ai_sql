/*
  Discover base tables behind Power BI views (run in SSMS on zRetailHQ0).
  You cannot CREATE INDEX on dbo.VW_MB_POWERBI_* views directly unless they are
  schema-bound indexed views — indexes belong on the underlying tables.

  After running section (1), give the table list to your DBA for section (2) in
  recommend-indexes-zretail-analytics.sql
*/

USE zRetailHQ0;
GO

/* 1) Tables referenced by key analytics views */
SELECT
  OBJECT_SCHEMA_NAME(d.referenced_id) AS ref_schema,
  OBJECT_NAME(d.referenced_id) AS ref_table,
  o.type_desc AS ref_type,
  OBJECT_SCHEMA_NAME(d.referencing_id) AS view_schema,
  OBJECT_NAME(d.referencing_id) AS view_name
FROM sys.sql_expression_dependencies AS d
INNER JOIN sys.objects AS o ON o.object_id = d.referenced_id
WHERE d.referencing_id IN (
  OBJECT_ID(N'dbo.VW_MB_POWERBI_APP_REPORT'),
  OBJECT_ID(N'dbo.VW_MB_POWERBI_SLSXNS_REPORT'),
  OBJECT_ID(N'dbo.VW_MB_POWERBI_SLS_REPORT')
)
AND o.type IN ('U', 'V')
ORDER BY view_name, ref_type, ref_table;
GO

/* 2) View definitions (first 4000 chars) — manual review */
SELECT name, type_desc, create_date, modify_date
FROM sys.objects
WHERE name IN (
  N'VW_MB_POWERBI_APP_REPORT',
  N'VW_MB_POWERBI_SLSXNS_REPORT',
  N'VW_MB_POWERBI_SLS_REPORT'
);
GO

EXEC sp_helptext N'dbo.VW_MB_POWERBI_APP_REPORT';
GO

/* 3) Missing-index hints from a representative dashboard query (live workload) */
SET STATISTICS IO, TIME ON;
GO

SELECT
  BranchAlias,
  SUM(MrpValue) AS metric_value
FROM dbo.VW_MB_POWERBI_APP_REPORT WITH (NOLOCK)
WHERE CAST(XnDt AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
  AND CAST(XnDt AS date) <= CAST(GETDATE() AS date)
GROUP BY BranchAlias
ORDER BY metric_value DESC;
GO

SET STATISTICS IO, TIME OFF;
GO

/* 4) Optional: missing index DMV (requires recent query execution above) */
SELECT
  migs.avg_user_impact,
  migs.user_seeks,
  mid.statement AS table_name,
  mid.equality_columns,
  mid.inequality_columns,
  mid.included_columns,
  migs.avg_total_user_cost,
  migs.avg_user_impact * migs.user_seeks AS score
FROM sys.dm_db_missing_index_groups AS mig
INNER JOIN sys.dm_db_missing_index_group_stats AS migs ON migs.group_handle = mig.index_group_handle
INNER JOIN sys.dm_db_missing_index_details AS mid ON mig.index_handle = mid.index_handle
WHERE mid.database_id = DB_ID()
  AND mid.statement LIKE N'%dbo.%'
ORDER BY score DESC;
GO
