/**
 * Natural language → T-SQL SELECT for ERP views (OpenAI).
 * All execution paths must pass assertSafeSelectSql before hitting the database.
 */
const OpenAI = require("openai");
const { validateSql } = require("./services/sql-validator");
const { DATASET_REGISTRY } = require("./datasets-registry");

/** Domain hint for revenue guard + validation (sales | purchase | stock | generic). */
function inferAiDomain(question) {
  const q = String(question || "").toLowerCase();
  if (/\b(purchase|vendor|supplier|procurement|grn|payable|pur qty|pur cost)\b/.test(q)) return "purchase";
  if (/\b(stock|inventory|on hand|reorder)\b/.test(q)) return "stock";
  if (/\b(sale|sales|invoice|revenue|turnover|customer|branch performance|mtd|ytd)\b/.test(q)) return "sales";
  return "generic";
}

/**
 * Build validator context: union of all registry views (+ env overrides + optional extras).
 * @param {{ registry?: object[], domain?: string, liveColumns?: object }} opts
 */
function buildAiValidationContext(opts = {}) {
  const reg = Array.isArray(opts.registry) && opts.registry.length ? opts.registry : DATASET_REGISTRY;
  const set = new Set();
  for (const r of reg) {
    if (r.defaultTable) set.add(String(r.defaultTable).trim());
    if (r.envOverride && process.env[r.envOverride]) {
      const v = String(process.env[r.envOverride]).trim();
      if (v && /[\w.]+\.[\w]+/.test(v)) set.add(v.includes(".") ? v : `dbo.${v}`);
    }
  }
  const extras = String(process.env.AI_SQL_EXTRA_ALLOWED_VIEWS || "")
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const x of extras) set.add(x);
  return {
    viewConfig: { allowed_views: [...set] },
    domain: opts.domain || "generic",
    liveColumns: opts.liveColumns,
  };
}

/**
 * Safe + policy validation: fixes, SELECT-only guard, TOP cap, allowlist, joins, revenue guard.
 * @param {string} sqlRaw
 * @param {ReturnType<typeof buildAiValidationContext>} validationContext
 */
function finalizeGeneratedSelectSql(sqlRaw, validationContext) {
  let s = String(sqlRaw || "").trim();
  s = fixCommonTsqlMistakes(s);
  s = assertSafeSelectSql(s);
  const maxRows = parseInt(String(process.env.AI_SQL_MAX_RESULT_ROWS || "500"), 10) || 500;
  const capped = Math.min(Math.max(maxRows, 1), 2000);
  s = enforceTopLimit(s, capped);
  try {
    return validateSql(s, validationContext);
  } catch (e) {
    if (!e.status) e.status = 400;
    throw e;
  }
}

function buildSchemaCatalog(registry) {
  return registry
    .map((r) => `${r.defaultTable} — ${r.label} (dataset key: ${r.key})`)
    .join("\n");
}

function extractSqlFromLlmText(text) {
  const raw = String(text || "").trim();
  const fence = raw.match(/```(?:sql|tsql|mssql)?\s*([\s\S]*?)```/i);
  if (fence) {
    return fence[1].trim();
  }
  return raw;
}

/** Strips T-SQL block comments and quote-safe line comments before validation. */
function stripTsSqlComments(input) {
  let s = String(input || "").replace(/\/\*[\s\S]*?\*\//g, " ");
  const lines = s.split(/\n/);
  const out = [];
  for (const line of lines) {
    let cut = line.length;
    let inStr = false;
    for (let i = 0; i < line.length - 1; i++) {
      const c = line[i];
      if (c === "'") {
        if (inStr && line[i + 1] === "'") {
          i++;
          continue;
        }
        inStr = !inStr;
        continue;
      }
      if (!inStr && c === "-" && line[i + 1] === "-") {
        cut = i;
        break;
      }
    }
    out.push(line.slice(0, cut).replace(/\s+$/g, ""));
  }
  return out.join("\n").trim();
}

/**
 * @returns {string} normalized SQL (no trailing semicolons)
 */
function assertSafeSelectSql(sqlRaw) {
  let s = stripTsSqlComments(String(sqlRaw || "").trim());
  s = s.replace(/;+\s*$/g, "").trim();
  if (!s) {
    const e = new Error("empty_sql");
    e.status = 400;
    e.code = "invalid_sql";
    throw e;
  }
  // After stripTsSqlComments, block comments (/*…*/) must be gone.
  // Line-comment markers (--) may legitimately remain INSIDE SQL string literals
  // (e.g. WHERE BranchName = 'North--South'), so we only reject block-comment
  // remnants here; the stripper already removed all out-of-string -- sequences.
  if (/\/\*/.test(s)) {
    const e = new Error("SQL block comments are not allowed (strip failed — report this query)");
    e.status = 400;
    e.code = "invalid_sql";
    throw e;
  }
  if (/;\s*\S/.test(s)) {
    const e = new Error("Multiple SQL statements are not allowed");
    e.status = 400;
    e.code = "invalid_sql";
    throw e;
  }
  const upper = s.toUpperCase();
  if (!upper.startsWith("SELECT")) {
    const e = new Error("Only SELECT statements are allowed");
    e.status = 400;
    e.code = "invalid_sql";
    throw e;
  }
  const bad =
    /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|MERGE|EXEC(UTE)?|GRANT|REVOKE|DENY|OPENROWSET|OPENDATASOURCE|BULK|INTO\s+|OUTFILE|WAITFOR\s+DELAY|SLEEP\s*\(|xp_|sp_executesql)\b/i;
  if (bad.test(s)) {
    const e = new Error("Forbidden keyword or pattern in SQL");
    e.status = 400;
    e.code = "invalid_sql";
    throw e;
  }
  const hasTopParens = /\bTOP\s*\(\s*(\d+)\s*\)/i.exec(s);
  const hasTopBare = !hasTopParens && /\bTOP\s+(\d+)\b/i.exec(s);
  const topMatch = hasTopParens || hasTopBare;
  if (topMatch) {
    const n = parseInt(topMatch[1], 10);
    if (!Number.isFinite(n) || n < 1) {
      const e = new Error("TOP value must be a positive integer");
      e.status = 400;
      e.code = "invalid_sql";
      throw e;
    }
    const maxTop = parseInt(String(process.env.AI_SQL_TOP_MAX ?? "0"), 10);
    if (Number.isFinite(maxTop) && maxTop > 0 && n > maxTop) {
      const e = new Error(`TOP value must be between 1 and ${maxTop}`);
      e.status = 400;
      e.code = "invalid_sql";
      throw e;
    }
  }
  return s;
}

async function nlToSelectSql({ apiKey, model, question, schemaCatalog }) {
  const openai = new OpenAI({ apiKey });
  const system = `You are an expert Microsoft SQL Server (T-SQL) read-only query builder for a fashion/apparel retail ERP system.

════════════════════════════════════════════════════
STRICT RULES — violating any rule causes a runtime error
════════════════════════════════════════════════════
1. Output a SINGLE SELECT statement only. No prose, no markdown fences except one optional \`\`\`sql block.
2. Use ONLY column names that are explicitly listed in the FOCUSED TABLE blocks or schema below. NEVER invent or guess column names.
3. Always qualify table/view names as dbo.ObjectName. Never use unqualified names.
4. TOP (N) is recommended for performance. N must be a positive integer.
5. No INSERT, UPDATE, DELETE, DDL, EXEC, OPENROWSET, SQL comments (-- or /* */), or multiple statements.
6. No trailing semicolons.

════════════════════════════════════════════════════
DATE ARITHMETIC — T-SQL ONLY (critical — wrong syntax = SQL Server error)
════════════════════════════════════════════════════
❌ NEVER: CAST(GETDATE() AS DATE) - 5         (date minus integer = INVALID in SQL Server)
❌ NEVER: CAST(GETDATE() AS DATE) + 1         (date plus integer = INVALID in SQL Server)
❌ NEVER: CURDATE(), NOW(), DATE(), CURRENT_DATE, SYSDATE()  (MySQL/Oracle — not SQL Server)
❌ NEVER: DATEPART(WEEKDAY,...)-based subtraction from a date

✅ ALWAYS use DATEADD(unit, offset, date) for all date math.

DATE PATTERNS (replace DateCol with actual column from focused schema):
- "Today":
    WHERE DateCol >= CAST(GETDATE() AS DATE)
      AND DateCol < DATEADD(day,1,CAST(GETDATE() AS DATE))

- "Yesterday":
    WHERE DateCol >= DATEADD(day,-1,CAST(GETDATE() AS DATE))
      AND DateCol < CAST(GETDATE() AS DATE)

- "Last 7 days" / "This week":
    WHERE DateCol >= DATEADD(day,-7,CAST(GETDATE() AS DATE))

- "Last 30 days":
    WHERE DateCol >= DATEADD(day,-30,CAST(GETDATE() AS DATE))

- "Last N days" (any N):
    WHERE DateCol >= DATEADD(day,-N,CAST(GETDATE() AS DATE))

- "This month":
    WHERE YEAR(DateCol)=YEAR(GETDATE()) AND MONTH(DateCol)=MONTH(GETDATE())

- "Last month":
    WHERE YEAR(DateCol)=YEAR(DATEADD(month,-1,GETDATE()))
      AND MONTH(DateCol)=MONTH(DATEADD(month,-1,GETDATE()))

- "This year" / YTD (Indian FY):
    WHERE CAST(DateCol AS date) >= '<FY start Apr-01 from date context>'
      AND CAST(DateCol AS date) <= CAST(GETDATE() AS date)

- "Last year":
    WHERE YEAR(DateCol)=YEAR(GETDATE())-1

- "This quarter" / QTD (Indian FY quarter):
    WHERE CAST(DateCol AS date) >= '<QTD start from date context>'
      AND CAST(DateCol AS date) <= CAST(GETDATE() AS date)

DATE COLUMN NAMES — use the column from the FOCUSED TABLE block:
- Sales views: typically InvoiceDt, InvoiceDate, SaleDt
- Purchase views: typically PurchaseDt, DocDt, PurchaseDate
- If no date column is listed, omit the date filter and return all rows.

Date predicates may appear in a WHERE clause OR in a JOIN ON clause — both are valid T-SQL.

════════════════════════════════════════════════════
DOMAIN KNOWLEDGE — retail fashion/apparel ERP
════════════════════════════════════════════════════
- ONLY use column names visible in the FOCUSED TABLE block or schema below.
- If a concept has no matching column (e.g. "category", "NetAmount"), omit it or use the closest listed column.
- NEVER invent: NetAmount, InvCategoryName, CategoryName, ProductName, VendorName unless they appear in the schema.
- On dbo.VwAISalesData: use SaleNetAmount for the sale amount column (when listed).
- On purchase PowerBI views: use the column whose name contains Amount, Value, NetAmt, or Cost.
- For readable product/item names: JOIN sales with item master (dbo.VwMstItems or dbo.VwAIMstItems) on ItemId and SELECT Description / ArticleShortName / ItemCode.
- For customer details: JOIN or use dbo.VwAICustomerDetails when present in focused schema.
- For salesperson names: JOIN or use dbo.VwAISalesPerson when present.
- For branch names: JOIN or use dbo.VwAIBranch on BranchId when branch name is needed.

COLUMN ALIASES (same concept, different names across views):
- Para1Name = Color  (SLS_REPORT, PUR_REPORT, STOCK_REPORT, VwMstItems)
- Para2Name = Size
- Para3Name = Fabric
- Para4Name = Property / Fit
- BranchAlias = short text branch id in PowerBI views (e.g. "EENA BAZAAR LJP")
- BranchId    = numeric branch key in VwAIBranch, VwAISalesData, SLS_BILLCOUNT
- XnMemoDate  = sale date in SLS_REPORT, SLS_ARTICLE_REPORT
- XnDt        = txn date in SLSXNS, STI, STO, APP, APR, PURXNS views
- PurchaseDt  = purchase date in PUR_REPORT, PUR_QTY_WITH_COST
- PurInvoiceDt= purchase invoice date in STOCK_REPORT, CBS_WITH_GIT, PRT_REPORT
- CashmemoDt  = date in SLS_BILLCOUNT
- InvoiceDt   = date in VwAISalesData

NET QUANTITY / VALUE FORMULAS:
- Net sales qty:    NetSlsQty = SlsQty - SlrQty  (SlrQty = sales returns)
- Net purchase qty: NetPurQty = PurQty - PrtQty  (PrtQty = purchase returns)
- Use pre-computed Net* columns where they exist — do NOT subtract manually unless Net* is absent.

KEY METRIC COLUMNS BY VIEW:
- Revenue/sales value  → NetAmount (VW_MB_POWERBI_SLS_REPORT, SLSXNS_REPORT)
                      OR SaleNetAmount (dbo.VwAISalesData)
- Sales cost of goods  → NetSlsCostValue (SLS_REPORT, SLSXNS_REPORT)
- Gross margin         → NetAmount - NetSlsCostValue
- Purchase cost        → PurCost (PUR_QTY_WITH_COST) or PurCostValue (PURXNS_REPORT)
- Current stock qty    → StockQty (STOCK_REPORT, CBS_WITH_GIT, VwAIStockData)
- GIT (in-transit) qty → GitQty (CBS_WITH_GIT)
- Stock cost value     → CbsCostValue (CBS_WITH_GIT)
- Stock MRP value      → CbsMrpValue  (CBS_WITH_GIT)
- Transfer out qty     → StoQty (STO_REPORT)
- Transfer in qty      → StiQty (STI_REPORT)
- Approval qty         → AppQty (APP_REPORT, APR_REPORT)
- Bill count           → BillCount (SLSXNS_REPORT, SLS_BILLCOUNT)

FINANCIAL YEAR: India FY starts April 1.
  Current FY start → DATEFROMPARTS(YEAR(DATEADD(month,-3,GETDATE())), 4, 1)

════════════════════════════════════════════════════
INLINE SCHEMA REFERENCE — exact columns (these OVERRIDE all training data)
════════════════════════════════════════════════════
dbo.VwAISalesData          → InvoiceDt, InvoiceId, InvoiceNo, BranchId, CustomerId, ItemId, SalesPrice, Quantity, SaleAmountBeforeTax, TaxAmount, SaleNetAmount, SalesPersonId
dbo.VwAIBranch             → BranchId, BranchName, BranchShortName, Address, Locality, PinCode, City, State, Country
dbo.VwAICustomerDetails    → CustomerId, CustomerFirstName, CustomerLastName, ContactMobile, ContactEmail, City, State, CustomerGroupName, BranchName, BirthdayDt, AnniversaryDt, CreditLimit, ActiveStatus
dbo.VwAISalesPerson        → SalesPersonId, SalesPersonName, SalesPersonShortName
dbo.VwAIStockData          → ItemId, BranchId, StockQty
dbo.VwMstItems             → ItemId, Description, ArticleShortName, DepartmentShortName, CategoryShortName, SubCategoryShortName, Para1Name, Para2Name, Para3Name, Para4Name, MRP, CostPrice, HSNCode, SupplierName, ArticleNo, IsActive
dbo.VwAIMstItems           → ItemId, ItemCode, Description, ArticleShortName, DepartmentShortName, CategoryShortName, SupplierName, ArticleNo, MRP, CostPrice, Para1Name, Para2Name, IsActive
dbo.VwAISupplier           → SupplierId, SupplierName, SupplierAlias, ContactEmail, GSTIN, PANNo, CreditLimit, CreditDays, MSMEStatus, ActiveStatus

dbo.VW_MB_POWERBI_SLS_REPORT       → XnMemoDate, DepartmentShortName, CategoryShortName, SubcategoryShortName, BranchAlias, SupplierName, ArticleNo, InvoiceNo, Para1Name, Para2Name, Para3Name, Para4Name, InvConcept, InvSilhouette, SlsQty, SlrQty, NetSlsQty, SlsNetAmount, SlrNetAmount, NetAmount, NetSlsCostValue, SalesMRP, MrpValue, NetMrpValue
dbo.VW_MB_POWERBI_SLS_ARTICLE_REPORT → XnMemoDate, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, Para3Name, Para4Name, SlsQty, SlrQty, NetSlsQty, NetAmount, NetSlsCostValue
dbo.VW_MB_POWERBI_SLSXNS_REPORT    → XnDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, SlsQty, SlrQty, NetSlsQty, NetAmount, NetSlsCostValue, BillCount
dbo.SLS_BILLCOUNT                  → CashmemoDt, BranchId, BranchAlias, BillCount
dbo.VW_MB_POWERBI_MIS_SUPPLIER_SLS_DATA → SalesMonth, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, NetSlsQty, NetAmount, NetSlsCostValue
dbo.VW_MB_POWERBI_PUR_REPORT       → PurchaseDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, PurQty, PrtQty, NetPurQty, PurNetAmount
dbo.VW_MB_POWERBI_PURXNS_REPORT    → XnDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, PurQty, PrtQty, NetPurQty, PurCostValue, PurNetAmount
dbo.VW_MB_POWERBI_PUR_QTY_WITH_COST → PurchaseDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, PurQty, PurCost, PurCostValue
dbo.VW_MB_POWERBI_SUPPLIER_PUR_REPORT → PurchaseDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, Para3Name, Para4Name, PurQty, PrtQty, NetPurQty, PurNetAmount
dbo.VW_MB_POWERBI_PRT_REPORT       → XnDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, PrtQty, PrtNetAmount
dbo.VW_MB_POWERBI_STOCK_REPORT     → PurInvoiceDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, StockQty, StockNetValue, StockMrpValue
dbo.VW_MB_POWERBI_CBS_WITH_GIT     → PurInvoiceDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, StockQty, GitQty, CbsCostValue, CbsMrpValue
dbo.VW_MB_POWERBI_STO_REPORT       → XnDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, StoQty, StoNetValue
dbo.VW_MB_POWERBI_STI_REPORT       → XnDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, StiQty, StiNetValue
dbo.VW_MB_POWERBI_APP_REPORT       → XnDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, AppQty, AppNetValue
dbo.VW_MB_POWERBI_APR_REPORT       → XnDt, DepartmentShortName, CategoryShortName, BranchAlias, SupplierName, ArticleNo, Para1Name, Para2Name, AprQty, AprNetValue
dbo.VW_MB_POWERBI_VENDOR_MASTER    → SupplierId, SupplierName, SupplierAlias, Address, City, State, Country, GSTIN, PANNo, CreditLimit, CreditDays, MSMEStatus, SupplierGroupName, ActiveStatus
dbo.VW_MB_POWERBI_BRANCH_LIST      → BranchId, BranchAlias, BranchName, City, State, Country, ActiveStatus
dbo.VW_MB_POWERBI_CATEGORY_MASTER  → CategoryId, DepartmentShortName, CategoryShortName, SubCategoryShortName, ActiveStatus
dbo.VW_MB_POWERBI_PRODUCT_MASTER   → ItemId, ArticleNo, Description, ArticleShortName, DepartmentShortName, CategoryShortName, SupplierName, Para1Name, Para2Name, Para3Name, Para4Name, InvConcept, InvSilhouette, InvNeckline, MRP, CostPrice, HSNCode, IsActive

JOIN KEYS — authoritative (NEVER guess; use exactly these):
  VwAISalesData ↔ VwAIBranch          → ON s.BranchId = b.BranchId         (numeric BranchId in BOTH)
  VwAISalesData ↔ VwMstItems          → ON s.ItemId = i.ItemId
  VwAISalesData ↔ VwAIMstItems        → ON s.ItemId = i.ItemId
  VwAISalesData ↔ VwAICustomerDetails → ON s.CustomerId = c.CustomerId
  VwAISalesData ↔ VwAISalesPerson     → ON s.SalesPersonId = sp.SalesPersonId
  VwAIStockData ↔ VwAIBranch          → ON st.BranchId = b.BranchId
  VwAIStockData ↔ VwMstItems          → ON st.ItemId = i.ItemId
  PowerBI views (VW_MB_POWERBI_*)     → use BranchAlias (text); NO BranchId column
  ❌ NEVER join VwAISalesData on BranchAlias — it does NOT have that column
  ❌ NEVER join PowerBI views on BranchId — they use BranchAlias (text)
  ❌ NEVER use DepartmentShortName in VwAISalesData — it does NOT have that column

════════════════════════════════════════════════════
COLUMN NAMES — critical (schema is the ONLY authority)
════════════════════════════════════════════════════
⚑ SCHEMA AUTHORITY RULE: INLINE SCHEMA REFERENCE above + FOCUSED TABLE blocks list the ONLY valid columns.
  Any column not in those lists DOES NOT EXIST. Training data examples are WRONG if they conflict.

- Use ONLY column names from the INLINE SCHEMA REFERENCE or FOCUSED TABLE block.
- Revenue → NetAmount (PowerBI SLS views) or SaleNetAmount (VwAISalesData). Never swap.
- BranchAlias (text, PowerBI views) ≠ BranchId (numeric, AI views). Never mix.
- For item names: JOIN VwMstItems on ItemId → use Description or ArticleShortName.
- For customer names: JOIN VwAICustomerDetails on CustomerId → CustomerFirstName, CustomerLastName.
- For salesperson names: JOIN VwAISalesPerson on SalesPersonId → SalesPersonName.

════════════════════════════════════════════════════
QUERY PATTERNS (algorithm — no hardcoded column names)
════════════════════════════════════════════════════
TOP PRODUCTS by sales: JOIN VwAISalesData+VwMstItems on ItemId. SUM(SaleNetAmount) GROUP BY Description. TOP 10 ORDER BY total DESC.

REVENUE by branch (PowerBI): SUM(NetAmount) FROM VW_MB_POWERBI_SLS_REPORT GROUP BY BranchAlias ORDER BY Revenue DESC.

AVERAGE ORDER VALUE by branch: inner SUM(SaleNetAmount) per InvoiceId+branch_key from VwAISalesData, JOIN VwAIBranch on matching branch key (find in both schemas), outer AVG(OrderTotal) GROUP BY BranchName.

MONTHLY TREND: GROUP BY YEAR(date_col), MONTH(date_col), SUM(amount_col). ORDER BY year ASC, month ASC.

TOP CUSTOMERS: JOIN VwAISalesData+VwAICustomerDetails on CustomerId. SUM(SaleNetAmount) GROUP BY CustomerFirstName+CustomerLastName. TOP 20 ORDER BY total DESC.

TOP VENDORS by purchase cost: SUM(PurCostValue or PurNetAmount) from PURXNS. GROUP BY SupplierName. TOP 10 ORDER BY total DESC.

ZERO-SALES BRANCHES: VwAIBranch LEFT JOIN VwAISalesData on branch key for date window. WHERE sales join key IS NULL.

SELL-THROUGH RATE: SUM(NetSlsQty)*100.0/NULLIF(SUM(PurQty),0) joining SLS_REPORT+PUR_REPORT on ArticleNo.

GROSS MARGIN %: SUM(NetAmount-NetSlsCostValue)/NULLIF(SUM(NetAmount),0)*100 from SLS_REPORT.

BILL COUNT + AVG BILL VALUE: SUM(BillCount), SUM(NetAmount)/NULLIF(SUM(BillCount),0) from SLSXNS_REPORT.

STOCK AGE: DATEDIFF(day, PurInvoiceDt, GETDATE()) from STOCK_REPORT or CBS_WITH_GIT.

CURRENT FY SALES: WHERE date_col >= DATEFROMPARTS(YEAR(DATEADD(month,-3,GETDATE())),4,1).

════════════════════════════════════════════════════
FEW-SHOT EXAMPLES — follow these join patterns exactly
════════════════════════════════════════════════════
Q: Top 10 products by sales this month
A: SELECT TOP (10) i.Description AS ProductName, SUM(s.SaleNetAmount) AS TotalSales
   FROM dbo.VwAISalesData s JOIN dbo.VwMstItems i ON s.ItemId = i.ItemId
   WHERE YEAR(s.InvoiceDt)=YEAR(GETDATE()) AND MONTH(s.InvoiceDt)=MONTH(GETDATE())
   GROUP BY i.Description ORDER BY TotalSales DESC

Q: Average order value by branch
A: SELECT b.BranchName, AVG(o.OrderTotal) AS AvgOrderValue
   FROM (SELECT BranchId, InvoiceId, SUM(SaleNetAmount) AS OrderTotal
         FROM dbo.VwAISalesData GROUP BY BranchId, InvoiceId) o
   JOIN dbo.VwAIBranch b ON o.BranchId = b.BranchId
   GROUP BY b.BranchName ORDER BY AvgOrderValue DESC

Q: Sales yesterday vs day before yesterday
A: SELECT 'Yesterday' AS PeriodLabel, SUM(SaleNetAmount) AS TotalSales
   FROM dbo.VwAISalesData
   WHERE InvoiceDt >= DATEADD(day,-1,CAST(GETDATE() AS DATE)) AND InvoiceDt < CAST(GETDATE() AS DATE)
   UNION ALL
   SELECT 'Day Before Yesterday', SUM(SaleNetAmount)
   FROM dbo.VwAISalesData
   WHERE InvoiceDt >= DATEADD(day,-2,CAST(GETDATE() AS DATE)) AND InvoiceDt < DATEADD(day,-1,CAST(GETDATE() AS DATE))

Q: Revenue by branch department from SLS_REPORT
A: SELECT TOP (50) BranchAlias, DepartmentShortName, SUM(NetAmount) AS Revenue
   FROM dbo.VW_MB_POWERBI_SLS_REPORT
   GROUP BY BranchAlias, DepartmentShortName ORDER BY Revenue DESC

Q: Branches with zero sales today
A: SELECT b.BranchName FROM dbo.VwAIBranch b
   LEFT JOIN dbo.VwAISalesData s ON b.BranchId = s.BranchId
     AND s.InvoiceDt >= CAST(GETDATE() AS DATE)
     AND s.InvoiceDt < DATEADD(day,1,CAST(GETDATE() AS DATE))
   WHERE s.BranchId IS NULL

Q: Top customers by spend this year
A: SELECT TOP (20) c.CustomerFirstName + ' ' + c.CustomerLastName AS CustomerName,
   SUM(s.SaleNetAmount) AS TotalSpend
   FROM dbo.VwAISalesData s JOIN dbo.VwAICustomerDetails c ON s.CustomerId = c.CustomerId
   WHERE YEAR(s.InvoiceDt) = YEAR(GETDATE())
   GROUP BY c.CustomerFirstName, c.CustomerLastName ORDER BY TotalSpend DESC

Q: Customers with birthdays this month
A: SELECT TOP (100) CustomerFirstName, CustomerLastName, BirthdayDt, ContactMobile, BranchName
   FROM dbo.VwAICustomerDetails
   WHERE MONTH(BirthdayDt) = MONTH(GETDATE())

════════════════════════════════════════════════════
GUARDRAILS
════════════════════════════════════════════════════
- "top products/items" → JOIN item master for readable name. NEVER return only ItemId.
- "revenue / sales amount" → NetAmount (PowerBI) or SaleNetAmount (VwAISalesData). Never MrpValue or SalesPrice.
- "average order value" → two-step subquery: per-InvoiceId SUM first, then AVG.
- "zero-sales branches" → branch master LEFT JOIN sales WHERE join key IS NULL.
- "purchase amount" → PurCostValue/PurNetAmount/PurCost — NOT PurQty (that is quantity).
- "net sales" → use NetSlsQty/NetAmount — already net of returns in PowerBI views.
- "gross margin" → NetAmount - NetSlsCostValue, never just NetAmount alone.
- Any date filter → DATEADD/GETDATE patterns only. Never subtract integers from dates.
- Purchase/vendor → VW_MB_POWERBI_PUR* or PURXNS views. Not sales views.
- Stock → VW_MB_POWERBI_STOCK_REPORT or CBS_WITH_GIT or VwAIStockData.

Schema and dataset reference:
${schemaCatalog}`;

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: question },
      ],
      temperature: 0.1,
      max_tokens: 1200,
    });
  } catch (err) {
    const httpStatus =
      err?.status ??
      err?.statusCode ??
      err?.response?.status ??
      err?.error?.status ??
      null;
    const msg = String(err?.message || err || "OpenAI request failed");

    if (httpStatus === 429 || /\b429\b|quota|rate limit/i.test(msg)) {
      const e = new Error(
        "OpenAI quota or rate limit exceeded for chat completions. " +
          "Listing models can still work while completions are blocked. " +
          "Add billing / credits at https://platform.openai.com/account/billing and check usage limits."
      );
      e.code = "openai_quota_exceeded";
      throw e;
    }
    if (httpStatus === 401) {
      const e = new Error("OpenAI rejected the API key (401). Check OPENAI_API_KEY on the server.");
      e.code = "openai_auth_failed";
      throw e;
    }

    const e = new Error(msg);
    e.code = "openai_api_error";
    throw e;
  }

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned empty content");
  }
  const extracted = extractSqlFromLlmText(content);
  const fixed = fixCommonTsqlMistakes(extracted);
  return assertSafeSelectSql(fixed);
}

/**
 * Fixes frequent model mistakes that still pass a naive SELECT-only check.
 */
function fixCommonTsqlMistakes(sql) {
  let s = String(sql || "");
  // SQL Server: date - int is invalid; models often emit CAST(GETDATE() AS DATE) - N
  s = s.replace(
    /CAST\s*\(\s*GETDATE\s*\(\s*\)\s+AS\s+DATE\s*\)\s*-\s*(\d+)/gi,
    "DATEADD(day,-$1,CAST(GETDATE() AS DATE))"
  );
  s = s.replace(
    /\(\s*CAST\s*\(\s*GETDATE\s*\(\s*\)\s+AS\s+DATE\s*\)\s*-\s*(\d+)\s*\)/gi,
    "(DATEADD(day,-$1,CAST(GETDATE() AS DATE)))"
  );
  // Week-boundary hacks that cause date/int clashes — approximate as last 7 calendar days
  s = s.replace(
    /CAST\s*\(\s*GETDATE\s*\(\s*\)\s+AS\s+DATE\s*\)\s*-\s*DATEPART\s*\(\s*WEEKDAY\s*,\s*GETDATE\s*\(\s*\)\s*\)\s*\+\s*\d+/gi,
    "DATEADD(day,-7,CAST(GETDATE() AS DATE))"
  );
  return s;
}

function adaptiveSummaryEnabled() {
  const v = String(process.env.AI_ADAPTIVE_SUMMARY ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/**
 * After SQL runs: short conversational explanation for the sidebar (not multi-turn chat).
 * @param {{ apiKey: string, model?: string, question: string, sqlText: string, rowCount: number, sampleRows: object[] }} opts
 * @returns {Promise<string|null>}
 */
async function summarizeAdaptiveResult({
  apiKey,
  model,
  question,
  sqlText,
  rowCount,
  sampleRows,
}) {
  if (rowCount === 0) {
    return (
      "The query ran successfully but returned no rows for the current filters. " +
      "That usually means no data matched the date range, branch, or other criteria. " +
      "Try a wider period, remove a branch or category filter, or confirm the business date column in your question."
    );
  }
  const openai = new OpenAI({ apiKey });
  const safeSql = String(sqlText || "").slice(0, 1800);
  const q = String(question || "").slice(0, 2000);
  const rows = Array.isArray(sampleRows) ? sampleRows : [];
  const rowsPreview = `Sample of returned data (up to 3 rows, JSON, truncated):\n${JSON.stringify(rows.slice(0, 3)).slice(0, 2200)}`;

  const system = `You are a helpful ERP analytics assistant. The user asked a question in plain English. A read-only SQL SELECT was executed.

Write a short, friendly reply (3–6 sentences) in plain English:
- Summarize ONLY what is visible in the sample JSON and row count. Every number and label you mention MUST appear in the sample or be clearly implied by aggregation (e.g. "largest in the sample").
- If the sample is too small to support a strong claim, say so briefly.
- Do not show full SQL. Never invent rows, product names, branches, or amounts that are not in the sample.
- Do not extrapolate to company-wide totals unless the query explicitly returns a single total row.`;

  const userMsg = `User question:\n${q}\n\nRow count: ${rowCount}\n${rowsPreview}\n\nSQL (context only, truncated):\n${safeSql}`;

  const completion = await openai.chat.completions.create({
    model: model || "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
    temperature: 0.15,
    max_tokens: 450,
  });
  const content = completion.choices[0]?.message?.content?.trim();
  return content || null;
}

/**
 * Detect if a follow-up question is analytical (about existing data) rather than a new DB query.
 * Returns true when the user is asking to analyze/discuss the previously fetched result.
 */
function isFollowUpQuestion(question) {
  const q = String(question || "").toLowerCase().trim();
  // Strong follow-up signals
  const followUpPhrases = [
    /^(what|why|how|which|who|where|when)\b/,
    /\b(above|previous|this data|these results?|the results?|that data|shown above|you just|you generated|just fetched|last query)\b/,
    /\b(analyze|analysis|analyse|explain|summarize|summarise|what do you think|opinion|insight|interpret|comment|review|evaluate)\b/,
    /\b(based on (this|that|above|the|these))\b/,
    /\b(from (this|the|above|these) (data|result|table|numbers?))\b/,
    /\b(can you (tell|explain|say|describe|give))\b/,
    /\b(overall|trend|pattern|observation)\b/,
    /^(so |and |but |also |now |tell me)\b/,
    /\?$/,
  ];
  // Strong NEW-query signals — if present, it's not a follow-up
  const newQuerySignals = [
    /\b(show me|get me|fetch|load|list|find|give me|display)\b.*\b(from|in|for|between|last|this|today|yesterday|week|month|year)\b/,
    /\b(top \d+|sum of|count of|total sales|purchase order|sales report)\b/,
    /\b(today'?s?|yesterday'?s?|this (week|month|year)|last (week|month|\d+ days?))\b.*\b(order|sale|invoice|purchase|stock)\b/,
  ];
  // If it has new-query signals, treat as new query
  for (const sig of newQuerySignals) {
    if (sig.test(q)) return false;
  }
  // If it has follow-up signals, treat as follow-up
  for (const pat of followUpPhrases) {
    if (pat.test(q)) return true;
  }
  // Short questions (< 8 words) without table/date references are likely follow-up
  const wordCount = q.split(/\s+/).length;
  if (wordCount < 8 && !/\b(invoice|purchase|sales|stock|order|branch|product|customer|vendor)\b/.test(q)) {
    return true;
  }
  return false;
}

/**
 * Short structural warnings for follow-up analysis (repeated labels, etc.).
 * @param {object[]} rows
 * @param {number} maxHints
 * @returns {string}
 */
function buildFollowUpDataQualityNotes(rows, maxHints = 4) {
  if (!Array.isArray(rows) || rows.length < 10) return "";
  const first = rows[0];
  if (!first || typeof first !== "object") return "";
  const keys = Object.keys(first).slice(0, 16);
  const hints = [];
  for (const k of keys) {
    const strSet = new Set();
    for (const r of rows) {
      const v = r[k];
      if (v == null || (typeof v === "string" && !v.trim())) continue;
      strSet.add(String(v).trim());
      if (strSet.size > 1) break;
    }
    if (strSet.size === 1 && rows.length >= 10) {
      const only = [...strSet][0].slice(0, 140);
      hints.push(
        `Column "${k}" has a single repeated value (${only}${only.length >= 140 ? "…" : ""}) across ${rows.length} rows — this is usually line-level grain or a faulty query (not “${rows.length} branches”).`
      );
    }
    if (hints.length >= maxHints) break;
  }
  if (!hints.length) return "";
  return "\nStructural notes (trust these):\n" + hints.join("\n") + "\n";
}

function ordinalSuffix(n) {
  const v = Number(n);
  const j = v % 10;
  const k = v % 100;
  if (j === 1 && k !== 11) return "st";
  if (j === 2 && k !== 12) return "nd";
  if (j === 3 && k !== 13) return "rd";
  return "th";
}

function parseMetricCell(val) {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  const n = parseFloat(String(val == null ? "" : val).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Pick the main numeric ranking column (e.g. TotalSales).
 * @param {object[]} rows
 * @returns {string|null}
 */
function pickRankMetricColumn(rows) {
  if (!rows.length || typeof rows[0] !== "object") return null;
  const keys = Object.keys(rows[0]);
  const nameScore = (k) => {
    const low = k.toLowerCase();
    if (/total|sales|amount|revenue|net|qty|quantity|count|value|sum/i.test(low)) return 2;
    return 1;
  };
  let best = null;
  let bestScore = -Infinity;
  for (const k of keys) {
    const nums = rows.map((r) => parseMetricCell(r[k])).filter((x) => Number.isFinite(x));
    if (nums.length < Math.max(1, Math.floor(rows.length * 0.7))) continue;
    const mx = Math.max.apply(null, nums);
    const pref = nameScore(k) * 1e15 + mx;
    if (pref > bestScore) {
      bestScore = pref;
      best = k;
    }
  }
  return best;
}

/**
 * Pick a label column for rank answers (ProductName, etc.).
 * @param {object[]} rows
 * @param {string} valueKey
 * @returns {string|null}
 */
function pickLabelColumnForRank(rows, valueKey) {
  if (!rows.length || typeof rows[0] !== "object") return null;
  const keys = Object.keys(rows[0]).filter((k) => k !== valueKey);
  const prefer = keys.find((k) => /name|product|label|title|branch|alias|description|sku|item/i.test(k));
  if (prefer) return prefer;
  const strKey = keys.find((k) =>
    rows.some((r) => {
      const v = r[k];
      return typeof v === "string" && v.trim() && Number.isNaN(parseMetricCell(v));
    })
  );
  return strKey || keys[0] || null;
}

/**
 * Detect 1-based rank in a “top-N by metric” table, or tail = lowest in set.
 * @param {string} question
 * @returns {{ tail: boolean, pos?: number } | null}
 */
function detectRankFollowUp(question) {
  const q = String(question || "").toLowerCase().trim();
  if (!q) return null;

  const wantsLow =
    ((/\b(bottom|worst|lowest|smallest|least|tail|last)\b/.test(q) && !/\btop\b/.test(q)) ||
      /\blast\s+(one|product|row|item|entry)\b/.test(q) ||
      /\bwhich\s+(is\s+)?(the\s+)?(worst|lowest|smallest)\b/.test(q)) &&
    !/\bfirst\b|\btop\b|\b1\s*st\b|\b#\s*1\b/.test(q);
  if (wantsLow) return { tail: true };

  let n = null;
  const ordWords = [
    ["first", 1],
    ["second", 2],
    ["third", 3],
    ["fourth", 4],
    ["fifth", 5],
    ["sixth", 6],
    ["seventh", 7],
    ["eighth", 8],
    ["ninth", 9],
    ["tenth", 10],
  ];
  for (const [w, num] of ordWords) {
    if (new RegExp(`\\b${w}\\b`).test(q)) {
      n = num;
      break;
    }
  }
  const mOrd = q.match(/\b(\d{1,2})\s*(st|nd|rd|th)\b/);
  if (mOrd) n = Math.min(100, Math.max(1, parseInt(mOrd[1], 10)));
  const mHash = q.match(/\b#\s*(\d{1,3})\b/);
  if (mHash) n = Math.min(100, Math.max(1, parseInt(mHash[1], 10)));
  const mRank = q.match(/\brank\s*[#:]?\s*(\d{1,3})\b|\b(?:position|number)\s*[#:]?\s*(\d{1,3})\b/);
  if (mRank) n = Math.min(100, Math.max(1, parseInt(mRank[1] || mRank[2], 10)));

  const wantsTopOne =
    (/\btop\b/.test(q) || /\bfirst\b/.test(q) || /\b(best|highest)(\s+rated|\s+selling|\s+performing)?\b/.test(q) || /\b#\s*1\b/.test(q) || /\b1\s*st\b/.test(q)) &&
    !/\b(top|bottom)\s+\d+\b/.test(q);
  if (n == null && (wantsTopOne || /\bwhich\s+is\s+the\s+top\b/.test(q) || /\bwho\s+(is\s+)?(the\s+)?top\b/.test(q))) {
    n = 1;
  }

  if (n != null && n >= 1) return { tail: false, pos: n };
  return null;
}

/**
 * Answer “which is 5th / top / bottom …” from the current grid without calling the LLM.
 * @param {string} question
 * @param {object[]} rows
 * @returns {string|null}
 */
function tryDeterministicRankFollowUp(question, rows) {
  const spec = detectRankFollowUp(question);
  if (!spec) return null;
  const cap = 500;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > cap) return null;

  const valueKey = pickRankMetricColumn(rows);
  if (!valueKey) return null;
  const labelKey = pickLabelColumnForRank(rows, valueKey);
  if (!labelKey) return null;

  const sorted = [...rows].sort((a, b) => parseMetricCell(b[valueKey]) - parseMetricCell(a[valueKey]));
  let idx;
  if (spec.tail) idx = sorted.length - 1;
  else idx = (spec.pos || 1) - 1;

  if (idx < 0 || idx >= sorted.length) {
    return (
      `This table only has ${sorted.length} row(s), so there is no ${spec.pos}${ordinalSuffix(spec.pos)} position by column ${valueKey}.`
    );
  }
  const row = sorted[idx];
  const lab = row[labelKey] != null ? String(row[labelKey]) : "(no label)";
  const val = row[valueKey];

  if (spec.tail) {
    return (
      `Lowest in this table by ${valueKey} (among ${sorted.length} row(s)): "${lab}" — ${valueKey} = ${val}.\n` +
      `(Sorted by ${valueKey} descending; this is the smallest value in this result set.)`
    );
  }
  return (
    `The ${spec.pos}${ordinalSuffix(spec.pos)} product by ${valueKey} (highest first among ${sorted.length} rows) is "${lab}" with ${valueKey} = ${val}.\n` +
    `(Ranking uses numeric sort on ${valueKey}, not necessarily the UI row order.)`
  );
}

/**
 * Analyze an already-fetched result set using AI — no SQL generated, just insight.
 * @param {{ apiKey:string, model?:string, question:string, previousQuestion:string, previousSQL:string, data:object[] }} opts
 * @returns {Promise<string>}
 */
async function analyzeDataResult({ apiKey, model, question, previousQuestion, previousSQL, data }) {
  const rows = Array.isArray(data) ? data : [];

  const deterministic = tryDeterministicRankFollowUp(question, rows);
  if (deterministic) return deterministic;

  const openai = new OpenAI({ apiKey });
  const dq = buildFollowUpDataQualityNotes(rows);
  const tableJson =
    rows.length === 0
      ? ""
      : rows.length <= 60
        ? JSON.stringify(rows)
        : JSON.stringify(rows.slice(0, 40));
  const preview =
    rows.length === 0
      ? "No rows were returned by the previous query."
      : `${rows.length} row(s) returned.${dq}\n${
          rows.length <= 60 ? "Full table JSON:\n" : "Sample (first 40 rows) JSON:\n"
        }${tableJson.slice(0, 12000)}`;

  const system = `You are an intelligent ERP business analytics assistant. The user previously ran a database query.
They are now asking ONE new follow-up question about those results.

CRITICAL:
- Read the Follow-up line first. Answer ONLY that question — do not repeat a canned “top 3 summary” if the user asked for a specific rank (e.g. 5th), a comparison, or an explanation.
- If they ask for the Nth row by a metric, use the JSON: sort rows by that numeric column descending and report the Nth label and value.
- Use ONLY the data provided. Cite exact names and numbers from the JSON.
- If the same branch/label repeats on many rows, say the result grain may be wrong (missing DISTINCT/GROUP BY).
- If you cannot answer from the data, say so and tell them to run a new question in the main AI Query box.
- Never invent entities or figures. Do NOT output SQL.
- Keep under 200 words.`;

  const userMsg = [
    `Follow-up (answer this only): ${String(question).slice(0, 1200)}`,
    "",
    `Original question: ${String(previousQuestion || "").slice(0, 500)}`,
    previousSQL ? `SQL that ran: ${String(previousSQL).slice(0, 800)}` : "",
    `\nData:\n${preview}`,
  ].filter(Boolean).join("\n");

  const completion = await openai.chat.completions.create({
    model: model || "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
    temperature: 0.55,
    max_tokens: 600,
  });
  return completion.choices[0]?.message?.content?.trim() || "I could not generate an analysis.";
}

// ================================================
// INTENT CLASSIFIER
// classifyQueryIntent(question) -> { type, chartPolicy, description, ... }
// Detects: trend | top_n | breakdown | kpi | aov | period_dashboard | generic
// ================================================
function classifyQueryIntent(question) {
  var q = String(question || "").toLowerCase();
  function has(re) { return re.test(q); }

  /** True when the user asks to slice by entity (branch, product, …), not just a calendar window. */
  var asksGroupedDimension =
    has(/\b(by branch|by category|by dept|by department|by product|by customer|by vendor|by supplier|by region|by store|by outlet|by salesperson|by rep)\b/) ||
    has(/\b(breakdown|distribution|split)\b/) ||
    has(/\bby\s+(branch|category|department|dept|product|vendor|customer|region|store|outlet)\b/);

  /** True when the time axis is the grouping dimension (month-on-month, per day, …). */
  var asksTimelineGroup =
    has(/\b(by month|by day|by week|by year|by quarter)\b/) ||
    has(/\b(per month|per day|per week)\b/) ||
    has(/\b(each month|each day)\b/) ||
    has(/\b(monthly|daily|weekly|yearly|annual)\b/);

  // KPI / single aggregate (calendar phrases like "this month" are OK — they scope time, not group rows)
  if (
    has(/\b(total|sum|overall|grand total|aggregate)\b/) &&
    has(/\b(sales?|revenue|amount|purchase|invoice|transaction|quantity|qty|units?)\b/) &&
    !asksGroupedDimension &&
    !asksTimelineGroup &&
    !has(/\b(trend|over time|time.?series)\b/) &&
    !has(/\b(top\s*\d+|ranking|rank by|highest|best performing|most sold|most popular|largest|leading)\b/)
  ) {
    return { type: "kpi", chartPolicy: "kpi_card",
      description: "Single aggregate KPI -- total/sum without dimension grouping" };
  }

  // Trend / time-series
  if (
    has(/\b(trend|monthly|daily|weekly|yearly|annual|over time|time.?series|month.?wise|day.?wise|week.?wise|per month|per day|per week)\b/) ||
    has(/\b(by month|by day|by week|by year|by quarter|month on month|mom|yoy)\b/)
  ) {
    return { type: "trend", chartPolicy: "line",
      description: "Time-series trend -- needs date/period label + at least one metric",
      requiredLabel: /date|month|day|week|year|period|saledate|salemonth/i, minRows: 2 };
  }

  // Top N / ranking (name aligned with deterministic pipeline: top_n)
  if (has(/\b(top\s*\d+|highest|best performing|most sold|most popular|largest|leading|rank by|ranking)\b/)) {
    return { type: "top_n", chartPolicy: "bar",
      description: "Ranking -- top N entities by a metric", minRows: 1 };
  }

  // Average Order Value
  if (
    has(/\b(average order value|aov|avg order|average basket|average transaction|avg transaction)\b/) ||
    (has(/\b(average|avg)\b/) && has(/\b(order|invoice|basket|transaction)\b/) && has(/\b(value|amount|size|total)\b/))
  ) {
    return { type: "aov", chartPolicy: "bar",
      description: "Average Order Value -- avg per group or overall" };
  }

  // Distribution / grouped breakdown (before broad period_dashboard so "breakdown … this month" stays a breakdown)
  if (asksGroupedDimension && !asksTimelineGroup && !has(/\b(trend|over time|time.?series)\b/)) {
    return { type: "breakdown", chartPolicy: "bar",
      description: "Distribution -- grouped breakdown by a dimension", minRows: 1 };
  }

  // Period dashboard — time-scoped exploration without an explicit entity dimension
  if (
    has(/\b(today|mtd|ytd|qtd|this month|this year|this quarter|last \d+ months?|last 6|last six|yesterday)\b/) &&
    has(/\b(sales?|revenue|invoice|transaction)\b/)
  ) {
    return { type: "period_dashboard", chartPolicy: "line",
      description: "Period-scoped sales dashboard with trend + breakdowns" };
  }

  // Generic
  return { type: "generic", chartPolicy: "auto",
    description: "General query -- chart type auto-detected from result shape" };
}

// validateResultContract(intent, rows) -> { passed, issues[], warnings[] }
// Checks that query results match the expected shape for the detected intent.
function validateResultContract(intent, rows) {
  if (!intent || intent.type === "generic" || !Array.isArray(rows)) {
    return { passed: true, issues: [], warnings: [] };
  }
  var issues = [];
  var warnings = [];

  if (rows.length === 0) {
    warnings.push("Query returned 0 rows -- chart will be empty. Try a wider date range or remove filters.");
    return { passed: true, issues: issues, warnings: warnings };
  }

  var keys = Object.keys(rows[0]);

  // Must have at least one numeric column
  var numericKeys = keys.filter(function(k) {
    var v = rows[0][k];
    return typeof v === "number" ||
      (v !== null && v !== "" && !isNaN(parseFloat(String(v))) && isFinite(parseFloat(String(v))));
  });
  if (numericKeys.length === 0) {
    issues.push("No numeric/metric column found -- chart would show no data. Regenerating with metric requirement.");
  }

  // Trend checks
  if (intent.type === "trend") {
    var labelRe = intent.requiredLabel || /date|month|day|week|year|period|saledate|salemonth/i;
    var hasDateLabel = keys.some(function(k) { return labelRe.test(k); });
    if (!hasDateLabel) {
      issues.push(
        "Trend query must have a date/time label column (e.g. SaleDate, SaleMonth). " +
        "Regenerating to include time-based grouping."
      );
    }
    if (rows.length < 2) {
      warnings.push(
        "Trend has only " + rows.length + " data point(s) -- not enough for a trend line. " +
        "Consider widening the date range."
      );
    }
    // Single-period dominance check
    if (rows.length >= 4 && numericKeys.length > 0) {
      var nk = numericKeys[0];
      var values = rows.map(function(r) { return Math.abs(parseFloat(String(r[nk] != null ? r[nk] : 0)) || 0); });
      var total = values.reduce(function(s, v) { return s + v; }, 0);
      var maxVal = Math.max.apply(null, values);
      if (total > 0 && maxVal / total > 0.98) {
        warnings.push(
          "One period accounts for 98%+ of the total -- possible date filter mismatch or data gap. " +
          "Verify the trend query covers the expected range."
        );
      }
    }
  }

  // AOV check
  if (intent.type === "aov") {
    var hasAvgCol = keys.some(function(k) { return /avg|average|aov|mean/i.test(k); });
    if (!hasAvgCol) {
      issues.push(
        "AOV query should return an AVG column (e.g. AvgOrderValue). " +
        "Found: " + keys.slice(0, 6).join(", ") + ". Regenerating with explicit AVG instruction."
      );
    }
  }

  // Negative-only totals check
  if (numericKeys.length > 0 && rows.length > 2) {
    var nk0 = numericKeys[0];
    var allNeg = rows.every(function(r) {
      return (parseFloat(String(r[nk0] != null ? r[nk0] : 0)) || 0) < 0;
    });
    if (allNeg) {
      warnings.push(
        "All metric values are negative -- this may indicate a returns/credits view. " +
        "Check you are querying the correct view for sales (not returns)."
      );
    }
  }

  return { passed: issues.length === 0, issues: issues, warnings: warnings };
}

// tagColumns(rows) -> { [colName]: "money"|"count"|"ratio"|"date"|"id"|"text" }
// Assigns semantic metric tags for deterministic formatting.
function tagColumns(rows) {
  if (!rows || !rows.length) return {};
  var keys = Object.keys(rows[0]);
  var tags = {};
  keys.forEach(function(k) {
    // Date
    if (/date|dt$|\bday\b|month$|year$|period$|created|modified|saledate|salemonth|invoicedt/i.test(k)) {
      tags[k] = "date"; return;
    }
    // ID / code
    if (/(\bid$|^id\b|_id$|code$|no$|num$|number$)/i.test(k)) {
      tags[k] = "id"; return;
    }
    // Ratio / percentage
    if (/pct$|percent|ratio|rate$|share$|growth$|margin/i.test(k)) {
      tags[k] = "ratio"; return;
    }
    // Count / quantity
    if (/count$|qty$|quantity$|invoicescount|invoicecount|orderscount|transactioncount|txcount|rowcount|units?$|billscount/i.test(k)) {
      tags[k] = "count"; return;
    }
    // Numeric check on first 5 rows
    var samples = rows.slice(0, 5).map(function(r) { return r[k]; });
    var isNumeric = samples.some(function(v) {
      return typeof v === "number" ||
        (v !== null && v !== "" && !isNaN(parseFloat(String(v))) && isFinite(parseFloat(String(v))));
    });
    if (isNumeric) {
      tags[k] = /amount|net|sales?|revenue|total|value|cost|price|avg|average|aov|profit|earning/i.test(k)
        ? "money" : "count";
    } else {
      tags[k] = "text";
    }
  });
  return tags;
}

/**
 * Drop LLM drill suggestions that are off-domain or unsafe for the adaptive SQL engine.
 * Keeps suggestions aligned with dbo.VwAISalesData unless the user was clearly in purchase/stock.
 */
function filterDrillDownSuggestionsVerified({ question, tableHint, suggestions }) {
  const q = String(question || "").toLowerCase().trim();
  const hint = String(tableHint || "").toLowerCase();
  const salesish =
    !hint ||
    hint.includes("vwaisalesdata") ||
    hint.includes("sales") ||
    /\b(sales|revenue|invoice|branch|product|customer|mtd|ytd|today)\b/.test(q);
  const purchaseish =
    /\b(pur_report|purxns|supplier|vendor|purchase)\b/.test(hint) ||
    /\b(purchase|vendor|supplier|procurement|po)\b/.test(q);
  const stockish =
    hint.includes("stock") ||
    hint.includes("inventory") ||
    /\b(stock|inventory|sku on hand|closing stock)\b/.test(q);

  const out = [];
  const seen = new Set();
  for (const s of suggestions || []) {
    const t = String(s || "").trim();
    if (!t || t.length > 160) continue;
    const low = t.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    if (low === q) continue;

    if (salesish && !purchaseish && !stockish) {
      if (/\b(low stock|out of stock|reorder point|warehouse bin)\b/i.test(t)) continue;
      if (/\b(purchase order|vendor ledger|accounts payable)\b/i.test(t)) continue;
      if (/\b(hr\b|payroll|employee attendance)\b/i.test(t)) continue;
    }
    if (!purchaseish && /\btop\s+\d+\s+vendors?\b/i.test(t) && !/\bpurchase\b/i.test(t)) continue;
    if (!stockish && /\b(stock on hand|closing inventory|warehouse stock)\b/i.test(t)) continue;

    out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Generate 3-5 contextual drill-down / follow-up query suggestions after a successful result.
 * Returns a plain string array; never throws.
 */
async function generateDrillDownSuggestions({ apiKey, model, question, data, intentType }) {
  const openai = new OpenAI({ apiKey });
  const rowCount = Array.isArray(data) ? data.length : 0;
  const cols = rowCount > 0 ? Object.keys(data[0]) : [];
  const sample = rowCount > 0 ? JSON.stringify(data.slice(0, 5)).slice(0, 800) : "(no data returned)";

  const system = `You are an ERP analytics assistant for Microsoft SQL Server / retail apparel data.
Generate exactly 3-5 short follow-up NATURAL LANGUAGE questions the user could run next.

Hard rules:
- Return ONLY a raw JSON array of strings — no prose, no markdown, no backticks.
- Each string must be a complete question (max 14 words).
- Every question MUST be answerable with T-SQL using the same domain as typical answers:
  sales → dbo.VwAISalesData (InvoiceDt, SaleNetAmount) plus joins to dbo.VwMstItems (product names),
  dbo.VwAIBranch (branch names), dbo.VwAICustomerDetails, dbo.VwAISalesPerson when needed.
- Prefer SaleNetAmount for revenue (not quantity-only) unless the user asked for units.
- Date filters must use SQL Server patterns (e.g. last 7 days, this month, YTD) — never vague "recently" without a period.
- Vary intent: at least one drill-down dimension, one comparison, one trend/time question.
- Do NOT repeat the original question. Do NOT suggest purchase/vendor/stock questions unless the original question or columns clearly involve purchases or stock.`;

  const userMsg = `Original question: "${String(question).slice(0, 400)}"
Intent: ${intentType || "generic"}
Result columns: ${cols.join(", ")}
Sample rows: ${sample}

Generate 3-5 follow-up questions as a JSON array.`;

  try {
    const completion = await openai.chat.completions.create({
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      temperature: 0.35,
      max_tokens: 300,
    });
    const raw = (completion.choices[0]?.message?.content || "").trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr)
      ? arr.filter((s) => typeof s === "string" && s.trim()).slice(0, 5)
      : [];
  } catch (_) {
    return [];
  }
}

/**
 * LangGraph-style 3-shot SQL generation pipeline:
 *
 *   Call 1 — Table selector  : GPT picks 1–4 relevant views from the full registry
 *   Call 2 — Schema fetch    : query INFORMATION_SCHEMA for only those views (tight context)
 *   Call 3 — SQL generator   : generate T-SQL using the focused schema (reuses nlToSelectSql)
 *   Call 4 — SQL checker     : review & auto-fix the generated SQL
 *
 * Returns { sql, selectedTables, focusedSchema }
 * Never throws for steps 1/4 failures — falls back gracefully.
 *
 * @param {{ apiKey: string, model?: string, question: string, pool: object, registry: Array }} opts
 */
/** Races a promise against a ms-bounded timeout; on timeout resolves with fallbackValue. */
function withStepTimeout(promise, ms, fallbackValue, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[pipeline] ${label} timed out after ${ms}ms — using fallback`);
      resolve(fallbackValue);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function nlToSelectSqlPipeline({ apiKey, model, question, pool, registry }) {
  const openai = new OpenAI({ apiKey });
  const mdl = model || "gpt-4o-mini";
  const t0 = Date.now();

  // ── Step 1: Table selector (4 s budget — optional, falls back to defaults) ──
  // Each entry in tableList includes the routingHint so the selector sees keywords
  const tableList = registry
    .map((r) => `- ${r.key}: ${r.defaultTable} — ${r.label}${r.routingHint ? `  [keywords: ${r.routingHint}]` : ""}`)
    .join("\n");

  const selectorCall = openai.chat.completions.create({
    model: mdl,
    messages: [
      {
        role: "system",
        content: `You are a database routing agent for a retail ERP system (Microsoft SQL Server, fashion/apparel business).
Given a user question, return the 1–4 most relevant table keys needed to answer it.

Return ONLY a raw JSON array of keys. No prose, no markdown, no backticks.

ROUTING RULES — pick the BEST match per domain:

SALES revenue/amount/trend:
  - Simple totals or trends by date/branch/supplier/category → "mb_powerbi_sls_report"
  - Detailed line-item sales with returns, GST, bill count → "mb_powerbi_slsxns_report"
  - Sales via AI view (InvoiceId, BranchId, CustomerId, SalesPersonId) → "sales"
  - Sales by article/fabric/concept → "mb_powerbi_sls_article_report"
  - Supplier-wise monthly MIS sales → "mb_powerbi_mis_supplier_sls_data"
  - Bill count / footfall only → "mb_powerbi_sls_billcount"

PURCHASE inward/procurement:
  - Purchase quantity by supplier/branch/category → "mb_powerbi_pur_report"
  - Purchase with cost value, GST, returns (PrtQty) → "mb_powerbi_purxns_report"
  - Purchase quantity + cost summary → "mb_powerbi_pur_qty_with_cost"
  - Purchase by supplier with full article attributes → "mb_powerbi_supplier_pur_report"
  - Purchase returns only → "mb_powerbi_prt_report"

STOCK inventory:
  - Current stock on hand (simple StockQty by branch/item) → "mb_powerbi_stock_report"
  - Stock value + GIT (goods in transit) → "mb_powerbi_cbs_with_git"
  - Stock by ItemId+BranchId (AI view) → "stock"

STOCK TRANSFERS:
  - Transfers sent out (StoQty) → "mb_powerbi_sto_report"
  - Transfers received (StiQty) → "mb_powerbi_sti_report"

APPROVALS:
  - Approval transactions (AppQty) → "mb_powerbi_app_report"
  - Approval returns → "mb_powerbi_apr_report"

SUPPLIERS / VENDORS:
  - Vendor details (GSTIN, PAN, credit, MSME) → "mb_powerbi_vendor_master"
  - Supplier address/alias simple → "vw_ai_supplier"

PRODUCTS / ITEMS:
  - Item master (MRP, cost, HSN, color, size, fabric, department, category) → "vw_mst_items"
  - Product master with style attributes (silhouette, dupatta, neckline) → "mb_powerbi_product_master"

BRANCHES:
  - Branch names, city, state, active status → "branches" or "mb_powerbi_branch_list"
  - Add "sales"/"mb_powerbi_sls_report" if amounts by branch needed

CUSTOMERS:
  - Customer details, birthday, credit → "customers"

SALESPERSON:
  - Salesperson name/performance → "vw_ai_salesperson" + "sales" for amounts

CATEGORY / DEPARTMENT hierarchy:
  - Category master → "mb_powerbi_category_master"
  - Sales by category → "mb_powerbi_sls_report"

KPI / ANALYTICS (multi-view):
  - Average order value → "sales" + "branches"
  - Sell-through rate → "mb_powerbi_pur_report" + "mb_powerbi_sls_report"
  - Gross margin → "mb_powerbi_sls_report"
  - Stock turn → "mb_powerbi_cbs_with_git" + "mb_powerbi_sls_report"
  - Zero-sales branches → "branches" + "mb_powerbi_sls_report"

Available tables (key: view — description [keywords]):
${tableList}`,
      },
      { role: "user", content: question },
    ],
    temperature: 0,
    max_tokens: 120,
  }).then((c) => {
    const raw = (c.choices[0]?.message?.content || "").trim();
    const match = raw.match(/\[[\s\S]*?\]/);
    return match ? JSON.parse(match[0]) : [];
  });

  let selectedKeys = [];
  try {
    const raw = await withStepTimeout(selectorCall, 4000, [], "Step1/table-selector");
    const validKeys = new Set(registry.map((r) => r.key));
    selectedKeys = (Array.isArray(raw) ? raw : []).filter(
      (k) => typeof k === "string" && validKeys.has(k)
    );
  } catch (selectorErr) {
    console.warn("[pipeline] table selector error:", String(selectorErr.message || selectorErr));
  }

  if (!selectedKeys.length) {
    selectedKeys = ["sales", "vw_mst_items", "branches"];
    console.log("[pipeline] selector returned no valid keys — using defaults");
  }
  console.log(`[pipeline] Step1 done in ${Date.now() - t0}ms — tables: ${selectedKeys.join(", ")}`);

  // ── Step 2: Fetch focused schema (only selected tables, 3 s budget) ─────────
  const focusedRegistry = registry.filter((r) => selectedKeys.includes(r.key));
  let focusedSchema = "";
  try {
    const schemaPromise = buildSchemaDocFromDb(pool, focusedRegistry, { maxTables: 6 });
    focusedSchema = await withStepTimeout(
      schemaPromise, 3000,
      focusedRegistry.map((r) => `${r.defaultTable} — ${r.label}`).join("\n"),
      "Step2/schema-fetch"
    );
  } catch (schemaErr) {
    console.warn("[pipeline] schema introspection failed:", String(schemaErr.message || schemaErr));
    focusedSchema = focusedRegistry.map((r) => `${r.defaultTable} — ${r.label}`).join("\n");
  }
  console.log(`[pipeline] Step2 done in ${Date.now() - t0}ms`);

  // ── Step 3: Generate SQL using focused schema (critical path — no timeout) ──
  const sqlText = await nlToSelectSql({
    apiKey,
    model: mdl,
    question,
    schemaCatalog: focusedSchema,
  });
  console.log(`[pipeline] Step3/SQL-gen done in ${Date.now() - t0}ms`);

  let safeSql;
  try {
    safeSql = finalizeGeneratedSelectSql(
      sqlText,
      buildAiValidationContext({ domain: inferAiDomain(question), registry: focusedRegistry })
    );
  } catch (valErr) {
    console.warn("[pipeline] Step3b/validation failed:", valErr.message);
    throw valErr;
  }

  // ── Step 4: SQL checker — runs concurrently; result available for retries ───
  // We do NOT await this here — index.js receives checkerPromise and awaits it
  // only if the initial DB query fails with a retryable error. This way Step 4
  // adds zero latency to the happy path.
  const checkerPromise = withStepTimeout(
    openai.chat.completions.create({
      model: mdl,
      messages: [
        {
          role: "system",
          content: `You are a Microsoft SQL Server T-SQL code reviewer for read-only ERP analytics.
Review the SQL query below and fix any issues. Output ONLY the corrected SQL — no prose, no markdown fences.
If the SQL is already correct, output it unchanged.

Fix rules (in priority order):
1. Date arithmetic: NEVER subtract/add integers from dates. Must use DATEADD(day,-N,CAST(GETDATE() AS DATE)).
2. ORDER BY in subqueries: remove ORDER BY from derived tables/subqueries unless they also have TOP or OFFSET/FETCH.
3. Invented column names: replace any column not listed in the schema below with the nearest valid column.
4. Ambiguous aliases: only qualify column with a table alias if that alias is declared in FROM/JOIN.
5. No SQL comments (-- or /* */). No semicolons at end.
6. Never change the query intent — only fix syntax and column name issues.

Valid schema (ONLY these columns exist):\n${focusedSchema}`,
        },
        { role: "user", content: `Review and fix if needed:\n${safeSql}` },
      ],
      temperature: 0,
      max_tokens: 1200,
    }).then((c) => {
      const raw = (c.choices[0]?.message?.content || "").trim();
      if (!raw) return safeSql;
      try {
        const extracted = extractSqlFromLlmText(raw);
        const fixed = fixCommonTsqlMistakes(extracted);
        const checked = assertSafeSelectSql(fixed);
        return finalizeGeneratedSelectSql(
          checked,
          buildAiValidationContext({ domain: inferAiDomain(question), registry: focusedRegistry })
        );
      } catch (_) {
        return safeSql; // checker produced invalid SQL — use validated Step 3
      }
    }),
    5000,       // 5 s budget — if checker is slow, fall back to Step 3 result
    safeSql,        "Step4/sql-checker"
  );

  // Return immediately with Step 3 SQL — checkerPromise resolves in background.
  // index.js can await checkerPromise before the first DB attempt if it wants,
  // or use it only as a retry source.
  return { sql: safeSql, checkerPromise, selectedTables: selectedKeys, focusedSchema };
}

function enforceTopLimit(sql, maxRows = 1000) {
  const s = String(sql || "").trim();
  const upper = s.toUpperCase();

  // Skip pure single-aggregate queries — they always return 1 row
  const isPureAggregate =
    /^\s*SELECT\s+(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(s) &&
    !/\bGROUP\s+BY\b/i.test(s);
  if (isPureAggregate) return s;

  // Already has TOP — check value
  const topParens = s.match(/^SELECT\s+TOP\s*\(\s*(\d+)\s*\)/i);
  const topBare = !topParens && s.match(/^SELECT\s+TOP\s+(\d+)\b/i);
  const topMatch = topParens || topBare;
  if (topMatch) {
    const n = parseInt(topMatch[1], 10);
    if (n <= maxRows) return s; // already within limit
    // Cap it
    return topParens
      ? s.replace(/^(SELECT\s+TOP\s*\()\s*\d+\s*(\))/i, `$1${maxRows}$2`)
      : s.replace(/^(SELECT\s+TOP\s+)\d+/i, `$1${maxRows}`);
  }

  // No TOP — inject one right after SELECT
  return s.replace(/^SELECT\s+/i, `SELECT TOP (${maxRows}) `);
}

module.exports = {
  buildSchemaCatalog,
  extractSqlFromLlmText,
  assertSafeSelectSql,
  stripTsSqlComments,
  fixCommonTsqlMistakes,
  nlToSelectSql,
  nlToSelectSqlPipeline,
  inferAiDomain,
  buildAiValidationContext,
  finalizeGeneratedSelectSql,
  adaptiveSummaryEnabled,
  summarizeAdaptiveResult,
  isFollowUpQuestion,
  analyzeDataResult,
  classifyQueryIntent,
  validateResultContract,
  tagColumns,
  enforceTopLimit,
  generateDrillDownSuggestions,
  filterDrillDownSuggestionsVerified,
};
