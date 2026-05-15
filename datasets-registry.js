/**
 * Whitelist: dataset key → dbo table/view (matches zRetailHQ0 discovery).
 * filterPrefix drives env vars:
 *   {PREFIX}_FILTER_DATE_COLUMN, _BRANCH_, _STATUS_, _DEPARTMENT_, _CATEGORY_
 * Optional: {PREFIX}_FILTER_BRANCH_MATCH=like (same for DEPARTMENT, CATEGORY) for contains-style match.
 * skipDateParamsIfNoColumn: if true and _FILTER_DATE_COLUMN is unset, ?from/&to/&fy date filters are ignored (no 400).
 * ignoreEnvDateColumn: if true, never use {PREFIX}_FILTER_DATE_COLUMN (snapshot / master views with no time column).
 *   Prevents broken env like STOCK_FILTER_DATE_COLUMN on dbo.VwAIStockData. Use dated stock via mb_powerbi_stock_report etc.
 * API query: ?from=&to= (yyyy-mm-dd or dd.mm.yyyy), ?fy=FY26 (India Apr–Mar), ?branch=&department=&category=
 * envOverride: optional process.env key that replaces defaultTable (e.g. SALES_VIEW).
 * routingHint: keywords that help the LLM table-selector pick this view.
 */
module.exports.DATASET_REGISTRY = [
  // ── AI-Optimised core views ──────────────────────────────────────────────
  {
    key: "sales",
    defaultTable: "dbo.VwAISalesData",
    envOverride: "SALES_VIEW",
    label: "Sales transactions (VwAISalesData) — InvoiceDt, InvoiceId, InvoiceNo, BranchId, CustomerId, ItemId, SalesPrice, Quantity, SaleAmountBeforeTax, TaxAmount, SaleNetAmount, SalesPersonId",
    filterPrefix: "SALES",
    routingHint: "sales revenue invoice SaleNetAmount quantity footfall customer purchase history salesperson avg order value aov period comparison trend today yesterday",
  },
  {
    key: "stock",
    defaultTable: "dbo.VwAIStockData",
    envOverride: "STOCK_VIEW",
    label: "Stock on hand (VwAIStockData) — ItemId, BranchId, StockQty",
    filterPrefix: "STOCK",
    routingHint: "current stock on hand inventory quantity available branch item",
    skipDateParamsIfNoColumn: true,
    ignoreEnvDateColumn: true,
  },
  {
    key: "customers",
    defaultTable: "dbo.VwAICustomerDetails",
    envOverride: "CUSTOMER_VIEW",
    label: "Customer master (VwAICustomerDetails) — CustomerId, CustomerFirstName, CustomerLastName, ContactMobile, ContactEmail, City, State, CustomerGroupName, BranchName, BirthdayDt, AnniversaryDt, CreditLimit, ActiveStatus",
    filterPrefix: "CUSTOMERS",
    routingHint: "customer buyer client name mobile email city birthday anniversary credit limit top customers loyal",
    skipDateParamsIfNoColumn: true,
    ignoreEnvDateColumn: true,
  },
  {
    key: "branches",
    defaultTable: "dbo.VwAIBranch",
    envOverride: "BRANCH_VIEW",
    label: "Branch master (VwAIBranch) — BranchId, BranchName, BranchShortName, Address, Locality, PinCode, City, State, Country",
    filterPrefix: "BRANCHES",
    routingHint: "branch store outlet location city state active warehouse BranchId BranchName zero sales",
    skipDateParamsIfNoColumn: true,
  },
  {
    key: "vw_ai_salesperson",
    defaultTable: "dbo.VwAISalesPerson",
    label: "Salesperson master (VwAISalesPerson) — SalesPersonId, SalesPersonName, SalesPersonShortName",
    filterPrefix: "VW_AI_SALESPERSON",
    routingHint: "salesperson sales rep agent performance name who sold",
    skipDateParamsIfNoColumn: true,
  },
  {
    key: "vw_ai_supplier",
    defaultTable: "dbo.VwAISupplier",
    label: "Supplier master (VwAISupplier) — PurPartyId, PartyName, ShortName, PartyAlias, Address, Locality, PinCode, City, State, Country",
    filterPrefix: "VW_AI_SUPPLIER",
    routingHint: "supplier vendor name alias city state address details",
    skipDateParamsIfNoColumn: true,
  },
  {
    key: "vw_mst_items",
    defaultTable: "dbo.VwMstItems",
    label: "Item master (VwMstItems) — ItemId, Itemcode, ArticleNo, Description, ArticleShortName, ItemMRP, ItemWSP, ItemEXP, PurchasePrice, InvDepartmentName, InvCategoryName, InvSubCategoryName, SupplierName, SupplierAlias, Para1Name(Color), Para2Name(Size), Para3Name(Fabric), Para4Name(Property/Fit), HSNCode, GstClassification",
    filterPrefix: "VW_MST_ITEMS",
    routingHint: "product item article MRP cost price description department category color size fabric property HSN GST supplier item master",
    skipDateParamsIfNoColumn: true,
  },
  {
    key: "vw_aimst_items",
    defaultTable: "dbo.VwAIMstItems",
    label: "Item master alternate view (VwAIMstItems)",
    filterPrefix: "VW_AIMST_ITEMS",
    routingHint: "product item master alternate",
    skipDateParamsIfNoColumn: true,
  },

  // ── Power BI Sales views ─────────────────────────────────────────────────
  {
    key: "mb_powerbi_sls_report",
    defaultTable: "dbo.VW_MB_POWERBI_SLS_REPORT",
    label: "PBI Sales Report (VW_MB_POWERBI_SLS_REPORT) — XnMemoDate, DepartmentShortName, CategoryShortName, BranchAlias, SupplierAlias, SupplierName, ArticleNo, Para1Name(Color), Para2Name(Size), Fabric, SubFabric, Concept, ItemMRP, Property, NetSlsQty, NetAmount, NetSlsCostValue, SlsExtCostValue",
    filterPrefix: "MB_POWERBI_SLS_REPORT",
    routingHint: "sales revenue net amount by branch department category supplier article concept fabric date trend monthly daily NetAmount NetSlsQty cost value",
  },
  {
    key: "mb_powerbi_slsxns_report",
    defaultTable: "dbo.VW_MB_POWERBI_SLSXNS_REPORT",
    label: "PBI Sales Transactions (VW_MB_POWERBI_SLSXNS_REPORT) — BranchAlias, DepartmentShortName, CategoryShortName, SupplierName, SupplierAlias, ArticleNo, Color, Size, Fabric, Concept, ItemMRP, CostPrice, XnDt, XnDtMonth, SlsQty, SlsMrpValue, SlsCostValue, SlsNetAmount, SlrQty(returns), SlrNetAmount, NetSlsQty, NetSlsNetAmount, NetSlsCostValue, CGSTAmount, SGSTAmount, IGSTAmount, BillCount",
    filterPrefix: "MB_POWERBI_SLSXNS_REPORT",
    routingHint: "sales transactions xns returns SlrQty gross sales net sales bill count GST CGST SGST IGST detailed line item",
  },
  {
    key: "mb_powerbi_sls_billcount",
    defaultTable: "dbo.VW_MB_POWERBI_SLS_BILLCOUNT",
    label: "PBI Bill Count (VW_MB_POWERBI_SLS_BILLCOUNT) — BranchId, CashmemoDt, BillCount",
    filterPrefix: "MB_POWERBI_SLS_BILLCOUNT",
    routingHint: "bill count footfall invoices bills per day average bill value",
  },
  {
    key: "mb_powerbi_sls_article_report",
    defaultTable: "dbo.VW_MB_POWERBI_SLS_ARTICLE_REPORT",
    label: "PBI Sales by Article (VW_MB_POWERBI_SLS_ARTICLE_REPORT) — CategoryShortName, ArticleNo, XnMemoDate, Fabric, SubFabric, ArticleMRP, Concept, NetSlsQty, NetAmount, NetSlsCostValue",
    filterPrefix: "MB_POWERBI_SLS_ARTICLE_REPORT",
    routingHint: "sales by article fabric concept category date article level NetAmount NetSlsQty",
  },
  {
    key: "mb_powerbi_mis_supplier_sls_data",
    defaultTable: "dbo.VW_MB_POWERBI_MIS_SUPPLIER_SLS_DATA",
    label: "PBI MIS Supplier Sales (VW_MB_POWERBI_MIS_SUPPLIER_SLS_DATA) — XnMemoDate_MONTH, SupplierName, SupplierAlias, DepartmentShortName, CategoryShortName, NetSlsQty, NetSlsCostValue, NetAmount, NetAmountBeforeTax, MrpValue",
    filterPrefix: "MB_POWERBI_MIS_SUPPLIER_SLS_DATA",
    routingHint: "supplier sales MIS monthly supplier-wise performance sell-through MrpValue NetAmount",
  },

  // ── Power BI Purchase views ──────────────────────────────────────────────
  {
    key: "mb_powerbi_pur_report",
    defaultTable: "dbo.VW_MB_POWERBI_PUR_REPORT",
    label: "PBI Purchase Report (VW_MB_POWERBI_PUR_REPORT) — PurchaseDt, PurInvoiceDt, PurInvoiceNo, DepartmentShortName, CategoryShortName, BranchAlias, SupplierAlias, SupplierName, ArticleNo, Para1Name(Color), Para2Name(Size), Fabric, SubFabric, Concept, ItemMRP, Property, PurQty",
    filterPrefix: "MB_POWERBI_PUR_REPORT",
    routingHint: "purchase buying procurement inward quantity PurQty supplier branch department category article",
  },
  {
    key: "mb_powerbi_purxns_report",
    defaultTable: "dbo.VW_MB_POWERBI_PURXNS_REPORT",
    label: "PBI Purchase Transactions (VW_MB_POWERBI_PURXNS_REPORT) — BranchAlias, DepartmentShortName, CategoryShortName, SupplierName, SupplierAlias, ArticleNo, Color, Size, XnDt, PurInvDate, PurInvNo, CostPrice, ItemMRP, PurQty, PurCostValue, PurNetAmount, PurMrpValue, PurCGSTAmount, PurSGSTAmount, PurIGSTAmount, PrtQty(returns), PrtCostValue, PrtNetAmount, NetPurQty, NetPurCost, NetPurNetAmount",
    filterPrefix: "MB_POWERBI_PURXNS_REPORT",
    routingHint: "purchase transactions xns returns PrtQty net purchase cost value GST CGST SGST IGST invoice challan detailed",
  },
  {
    key: "mb_powerbi_prt_report",
    defaultTable: "dbo.VW_MB_POWERBI_PRT_REPORT",
    label: "PBI Purchase Returns (VW_MB_POWERBI_PRT_REPORT) — PurReturnDt, PurInvoiceDt, PurInvoiceNo, DepartmentShortName, CategoryShortName, BranchAlias, SupplierAlias, SupplierName, ArticleNo, ItemMRP, PrtQty",
    filterPrefix: "MB_POWERBI_PRT_REPORT",
    routingHint: "purchase return PRT return to supplier return quantity PrtQty",
  },
  {
    key: "mb_powerbi_pur_qty_with_cost",
    defaultTable: "dbo.VW_MB_POWERBI_PUR_QTY_WITH_COST",
    label: "PBI Purchase Qty with Cost (VW_MB_POWERBI_PUR_QTY_WITH_COST) — PurchaseDt, DepartmentShortName, BranchAlias, SupplierAlias, CategoryShortName, PurQty, PurCost",
    filterPrefix: "MB_POWERBI_PUR_QTY_WITH_COST",
    routingHint: "purchase cost PurCost quantity PurQty department branch supplier",
  },
  {
    key: "mb_powerbi_supplier_pur_report",
    defaultTable: "dbo.VW_MB_POWERBI_SUPPLIER_PUR_REPORT",
    label: "PBI Supplier Purchase Report (VW_MB_POWERBI_SUPPLIER_PUR_REPORT) — DepartmentShortName, CategoryShortName, ArticleNo, SupplierName, SupplierAlias, BranchAlias, PurDate, PurchasePrice, ItemMRP, ItemWSP, PurQty, Color, Size, Fabric, Concept, Silhoutte, Dupatta",
    filterPrefix: "MB_POWERBI_SUPPLIER_PUR_REPORT",
    routingHint: "supplier purchase articles bought from supplier PurQty PurchasePrice WSP MRP style attributes silhouette dupatta",
  },

  // ── Power BI Stock views ─────────────────────────────────────────────────
  {
    key: "mb_powerbi_stock_report",
    defaultTable: "dbo.VW_MB_POWERBI_STOCK_REPORT",
    label: "PBI Stock Report (VW_MB_POWERBI_STOCK_REPORT) — DepartmentShortName, CategoryShortName, BranchAlias, SupplierAlias, SupplierName, ArticleNo, Para1Name(Color), Para2Name(Size), Fabric, SubFabric, Concept, ItemMRP, Property, PurInvoiceDt, StockQty",
    filterPrefix: "MB_POWERBI_STOCK_REPORT",
    routingHint: "stock inventory current quantity StockQty branch department category article age old stock",
  },
  {
    key: "mb_powerbi_cbs_with_git",
    defaultTable: "dbo.VW_MB_POWERBI_CBS_WITH_GIT",
    label: "PBI CBS + GIT Stock (VW_MB_POWERBI_CBS_WITH_GIT) — BranchAlias, DepartmentShortName, CategoryShortName, ArticleNo, Color, Size, CostPrice, MRP, SupplierName, SupplierAlias, PurInvoiceDt, GitQty(in-transit), StockQty, CbsCostValue, CbsMrpValue",
    filterPrefix: "MB_POWERBI_CBS_WITH_GIT",
    routingHint: "CBS stock GIT goods in transit GitQty StockQty CbsCostValue CbsMrpValue total stock value cost MRP",
  },

  // ── Power BI Stock Transfer views ────────────────────────────────────────
  {
    key: "mb_powerbi_sti_report",
    defaultTable: "dbo.VW_MB_POWERBI_STI_REPORT",
    label: "PBI Stock Transfer In (VW_MB_POWERBI_STI_REPORT) — SourceBranchAlias, SourceBranchId, TargetBranchAlias, TargetBranchId, DepartmentShortName, CategoryShortName, SupplierName, ArticleNo, Color, Size, XnDt, StiQty, MrpValue, CostValue, NetAmount, CGSTAmount, SGSTAmount, IGSTAmount",
    filterPrefix: "MB_POWERBI_STI_REPORT",
    routingHint: "stock transfer in STI received transfer StiQty source target branch",
  },
  {
    key: "mb_powerbi_sto_report",
    defaultTable: "dbo.VW_MB_POWERBI_STO_REPORT",
    label: "PBI Stock Transfer Out (VW_MB_POWERBI_STO_REPORT) — SourceBranchAlias, SourceBranchId, TargetBranchAlias, TargetBranchId, DepartmentShortName, CategoryShortName, SupplierName, ArticleNo, Color, Size, XnDt, StoQty, MrpValue, CostValue, NetAmount, CGSTAmount, SGSTAmount, IGSTAmount",
    filterPrefix: "MB_POWERBI_STO_REPORT",
    routingHint: "stock transfer out STO sent dispatch StoQty source target branch",
  },

  // ── Power BI Approval views ──────────────────────────────────────────────
  {
    key: "mb_powerbi_app_report",
    defaultTable: "dbo.VW_MB_POWERBI_APP_REPORT",
    label: "PBI Approval Report (VW_MB_POWERBI_APP_REPORT) — BranchAlias, DepartmentShortName, CategoryShortName, SupplierName, SupplierAlias, ArticleNo, Color, Size, ItemMRP, CostPrice, XnDt, AppQty, MrpValue, CostValue, NetAmount, CGSTAmount, SGSTAmount, IGSTAmount, BillCount",
    filterPrefix: "MB_POWERBI_APP_REPORT",
    routingHint: "approval APP AppQty approval quantity value supplier branch",
  },
  {
    key: "mb_powerbi_apr_report",
    defaultTable: "dbo.VW_MB_POWERBI_APR_REPORT",
    label: "PBI Approval Return Report (VW_MB_POWERBI_APR_REPORT) — BranchAlias, DepartmentShortName, CategoryShortName, SupplierName, SupplierAlias, ArticleNo, Color, Size, ItemMRP, CostPrice, XnDt, AppQty, MrpValue, CostValue, NetAmount, BillCount",
    filterPrefix: "MB_POWERBI_APR_REPORT",
    routingHint: "approval return APR approval return quantity supplier branch",
  },

  // ── Power BI Master / Reference views ───────────────────────────────────
  {
    key: "mb_powerbi_branch_list",
    defaultTable: "dbo.VW_MB_POWERBI_BRANCH_LIST",
    label: "PBI Branch List (VW_MB_POWERBI_BRANCH_LIST) — BranchId, BranchName, ShortName, Address, Locality, City, State, Country, PinCode, ActiveStatus, IsWarehouse",
    filterPrefix: "MB_POWERBI_BRANCH_LIST",
    routingHint: "branch list store outlet active inactive warehouse city state",
    skipDateParamsIfNoColumn: true,
  },
  {
    key: "mb_powerbi_category_master",
    defaultTable: "dbo.VW_MB_POWERBI_CATEGORY_MASTER",
    label: "PBI Category Master (VW_MB_POWERBI_CATEGORY_MASTER) — InvSubCategoryId, InvSubCategoryName, InvSubCategoryShortName, InvCategoryId, InvCategoryName, InvCategoryShortName, InvDepartmentId, InvDepartmentName, InvDepartmentShortName",
    filterPrefix: "MB_POWERBI_CATEGORY_MASTER",
    routingHint: "category department sub-category master list hierarchy",
    skipDateParamsIfNoColumn: true,
  },
  {
    key: "mb_powerbi_product_master",
    defaultTable: "dbo.VW_MB_POWERBI_PRODUCT_MASTER",
    label: "PBI Product Master (VW_MB_POWERBI_PRODUCT_MASTER) — ItemId, Itemcode, ArticleNo, DepartmentShortName, CategoryShortName, Colour(Color), size(Size), SupplierName, SupplierAlias, FabricShortName, SubFabricShortName, Property, Collection, Concept, Dupatta, Silhoutte, Bottom, NECKLINE, SleeveType, Look, PurchasePrice, ItemMRP, ItemWSP",
    filterPrefix: "MB_POWERBI_PRODUCT_MASTER",
    routingHint: "product master article attributes silhouette neckline sleeve dupatta collection concept fabric color size MRP WSP purchase price",
    skipDateParamsIfNoColumn: true,
  },
  {
    key: "mb_powerbi_vendor_master",
    defaultTable: "dbo.VW_MB_POWERBI_VENDOR_MASTER",
    label: "PBI Vendor Master (VW_MB_POWERBI_VENDOR_MASTER) — PartyId, PartyName, ShortName, PartyAlias, Address, City, State, TaxGSTINNo, TaxPanNo, CreditDays, CreditLimit, DiscountPercentage, MarginPercentage, MSMEBizType, MSMECategory, GstClassification, ContactEmail1, ContactPhone1",
    filterPrefix: "MB_POWERBI_VENDOR_MASTER",
    routingHint: "vendor supplier GSTIN PAN credit days credit limit discount MSME state city contact details",
    skipDateParamsIfNoColumn: true,
  },

  // ── Master tables ────────────────────────────────────────────────────────
  {
    key: "salesperson",
    defaultTable: "dbo.MstSalesPerson",
    envOverride: "SALESPERSON_TABLE",
    label: "Salesperson master table (MstSalesPerson)",
    filterPrefix: "SALESPERSON",
    routingHint: "salesperson master table",
    skipDateParamsIfNoColumn: true,
  },
  {
    key: "stock_units",
    defaultTable: "dbo.MstStockUnit",
    envOverride: "STOCK_TABLE",
    label: "Stock units master table (MstStockUnit)",
    filterPrefix: "STOCK_UNITS",
    routingHint: "stock unit master UOM",
    skipDateParamsIfNoColumn: true,
  },
  {
    key: "vw_mst_branch_entry",
    defaultTable: "dbo.VwMstBranchEntry",
    label: "Branch entry master (VwMstBranchEntry)",
    filterPrefix: "VW_MST_BRANCH_ENTRY",
    routingHint: "branch entry master",
    skipDateParamsIfNoColumn: true,
  },
];

module.exports.DATASET_KEYS = module.exports.DATASET_REGISTRY.map((r) => r.key);
