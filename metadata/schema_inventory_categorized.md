# SQL Server — tables, views & columns (categorized)

## Summary

| Field | Value |
| --- | --- |
| Database | `zRetailHQ0` |
| Schema filter | `(all user schemas)` |
| Generated | 2026-05-12 02:26 UTC |
| Distinct objects | 28 |
| Total columns | 658 |

### Columns by coarse SQL type category

- **Strings & text**: 467
- **Decimals / numeric**: 135
- **Dates & times**: 35
- **Integers**: 18
- **Bit**: 3

*Name hints* (italic under each column) are **heuristic** labels from the column name — not inferred from data.

---

## VIEW

### `dbo.VW_MB_POWERBI_APP_REPORT` (33 columns)

#### Integers

- `BillCount` — **int(10,0)** — NULL

#### Decimals / numeric

- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `CostPrice` — **numeric(16,5)** — NULL — *measure*
- `AppQty` — **numeric(38,2)** — NULL — *measure*
- `MrpValue` — **numeric(38,4)** — NULL
- `CostValue` — **numeric(38,7)** — NULL — *measure*
- `NetAmount` — **numeric(38,2)** — NULL — *measure*
- `CGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `SGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `IGSTAmount` — **numeric(38,5)** — NULL — *measure*

#### Dates & times

- `XnDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `BranchAlias` — **varchar(50)** — NOT NULL
- `Department` — **varchar(100)** — NOT NULL
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `Category` — **varchar(100)** — NOT NULL
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierCity` — **varchar(200)** — NOT NULL
- `SupplierState` — **varchar(200)** — NOT NULL
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Color` — **varchar(100)** — NOT NULL
- `Size` — **varchar(100)** — NOT NULL
- `Contrast` — **varchar(100)** — NOT NULL
- `Printtypework` — **varchar(100)** — NOT NULL
- `Fabric` — **varchar(100)** — NOT NULL
- `SubFabric` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL
- `Itemcode` — **varchar(50)** — NOT NULL — *code/ref*
- `XnId` — **varchar(40)** — NOT NULL
- `XnNo` — **varchar(15)** — NOT NULL — *code/ref*
- `XnDtMonth` — **nvarchar(30)** — NULL

### `dbo.VW_MB_POWERBI_APR_REPORT` (30 columns)

#### Integers

- `BillCount` — **int(10,0)** — NULL

#### Decimals / numeric

- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `CostPrice` — **numeric(16,5)** — NULL — *measure*
- `AppQty` — **numeric(38,2)** — NULL — *measure*
- `MrpValue` — **numeric(38,4)** — NULL
- `CostValue` — **numeric(38,7)** — NULL — *measure*
- `NetAmount` — **numeric(38,4)** — NULL — *measure*

#### Dates & times

- `XnDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `BranchAlias` — **varchar(50)** — NOT NULL
- `Department` — **varchar(100)** — NOT NULL
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `Category` — **varchar(100)** — NOT NULL
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierCity` — **varchar(200)** — NOT NULL
- `SupplierState` — **varchar(200)** — NOT NULL
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Color` — **varchar(100)** — NOT NULL
- `Size` — **varchar(100)** — NOT NULL
- `Contrast` — **varchar(100)** — NOT NULL
- `Printtypework` — **varchar(100)** — NOT NULL
- `Fabric` — **varchar(100)** — NOT NULL
- `SubFabric` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL
- `Itemcode` — **varchar(50)** — NOT NULL — *code/ref*
- `XnId` — **varchar(40)** — NOT NULL
- `XnNo` — **varchar(40)** — NOT NULL — *code/ref*
- `XnDtMonth` — **nvarchar(30)** — NULL

### `dbo.VW_MB_POWERBI_BRANCH_LIST` (11 columns)

#### Bit

- `ActiveStatus` — **bit** — NOT NULL — *flag/status*
- `IsWarehouse` — **bit** — NOT NULL

#### Strings & text

- `BranchId` — **char(3)** — NOT NULL
- `BranchName` — **varchar(200)** — NOT NULL — *description*
- `ShortName` — **varchar(50)** — NOT NULL — *description*
- `Address` — **varchar(500)** — NOT NULL
- `Locality` — **varchar(200)** — NOT NULL
- `City` — **varchar(200)** — NOT NULL
- `State` — **varchar(200)** — NOT NULL
- `Country` — **varchar(200)** — NOT NULL
- `PinCode` — **varchar(10)** — NOT NULL — *code/ref*

### `dbo.VW_MB_POWERBI_CATEGORY_MASTER` (9 columns)

#### Strings & text

- `InvSubCategoryId` — **char(15)** — NOT NULL
- `InvSubCategoryName` — **varchar(100)** — NOT NULL — *description*
- `InvSubCategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `InvCategoryId` — **char(15)** — NOT NULL
- `InvCategoryName` — **varchar(100)** — NOT NULL — *description*
- `InvCategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `InvDepartmentId` — **char(15)** — NOT NULL
- `InvDepartmentName` — **varchar(100)** — NOT NULL — *description*
- `InvDepartmentShortName` — **varchar(50)** — NOT NULL — *description*

### `dbo.VW_MB_POWERBI_CBS_WITH_GIT` (24 columns)

#### Decimals / numeric

- `CostPrice` — **numeric(16,5)** — NULL — *measure*
- `MRP` — **numeric(10,2)** — NOT NULL
- `GitQty` — **numeric(38,2)** — NULL — *measure*
- `GitCostValue` — **numeric(38,6)** — NULL — *measure*
- `StockQty` — **numeric(38,5)** — NULL — *measure*
- `CbsCostValue` — **numeric(38,6)** — NULL — *measure*
- `CbsMrpValue` — **numeric(38,6)** — NULL

#### Dates & times

- `PurInvoiceDt` — **datetime** — NOT NULL — *date-like name*

#### Strings & text

- `BranchAlias` — **varchar(50)** — NOT NULL
- `Department` — **varchar(100)** — NOT NULL
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `CategoryName` — **varchar(100)** — NOT NULL — *description*
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `Itemcode` — **varchar(50)** — NOT NULL — *code/ref*
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Color` — **varchar(100)** — NOT NULL
- `Size` — **varchar(100)** — NOT NULL
- `Contrast` — **varchar(100)** — NOT NULL
- `Printtypework` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierCity` — **varchar(200)** — NOT NULL
- `SupplierState` — **varchar(200)** — NOT NULL

### `dbo.VW_MB_POWERBI_MIS_SUPPLIER_SLS_DATA` (16 columns)

#### Integers

- `XnMemoDate_MONTH` — **int(10,0)** — NULL — *date-like name*

#### Decimals / numeric

- `NetSlsQty` — **numeric(38,2)** — NULL — *measure*
- `NetSlsCostValue` — **numeric(38,7)** — NULL — *measure*
- `NetAmount` — **numeric(38,2)** — NULL — *measure*
- `NetAmountBeforeTax` — **numeric(38,5)** — NULL — *measure*
- `MrpValue` — **numeric(38,4)** — NULL

#### Dates & times

- `XnMemoDate` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `SupplierCity` — **varchar(200)** — NOT NULL
- `SupplierState` — **varchar(200)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `Para4Name` — **varchar(100)** — NOT NULL — *description*
- `XnMemoDate_MONTHNAME` — **nvarchar(30)** — NULL — *date-like name, description*

### `dbo.VW_MB_POWERBI_PRODUCT_MASTER` (36 columns)

#### Integers

- `Para2Index` — **int(10,0)** — NOT NULL

#### Decimals / numeric

- `PurchasePrice` — **numeric(12,5)** — NOT NULL — *measure*
- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `ItemWSP` — **numeric(10,2)** — NOT NULL

#### Dates & times

- `PurDate` — **datetime** — NOT NULL — *date-like name*
- `PurInvDt` — **datetime** — NOT NULL — *date-like name*

#### Strings & text

- `ItemId` — **varchar(100)** — NOT NULL
- `Itemcode` — **varchar(50)** — NOT NULL — *code/ref*
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `SubCategoryName` — **varchar(100)** — NOT NULL — *description*
- `SubCategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Colour` — **varchar(100)** — NOT NULL
- `size` — **varchar(100)** — NOT NULL
- `Contrast` — **varchar(100)** — NOT NULL
- `Printypework` — **varchar(100)** — NOT NULL
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierUID` — **varchar(50)** — NOT NULL
- `FabricShortName` — **varchar(50)** — NOT NULL — *description*
- `SubFabricShortName` — **varchar(50)** — NOT NULL — *description*
- `Property` — **varchar(100)** — NOT NULL
- `Collection` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL
- `SubConceptShortName` — **varchar(50)** — NOT NULL — *description*
- `Dupatta` — **varchar(100)** — NOT NULL
- `DupattaShortName` — **varchar(50)** — NOT NULL — *description*
- `Silhoutte` — **varchar(100)** — NOT NULL
- `Bottom` — **varchar(100)** — NOT NULL
- `NECKLINE` — **varchar(100)** — NOT NULL
- `SleeveType` — **varchar(100)** — NOT NULL
- `Look` — **varchar(100)** — NOT NULL
- `INVENTORYTYPE` — **varchar(100)** — NOT NULL
- `PurInvNo` — **varchar(50)** — NOT NULL — *code/ref*
- `PurChallanNo` — **varchar(50)** — NOT NULL — *code/ref*

### `dbo.VW_MB_POWERBI_PRT_REPORT` (23 columns)

#### Integers

- `Para2Index` — **int(10,0)** — NOT NULL

#### Decimals / numeric

- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `PrtQty` — **numeric(10,2)** — NOT NULL — *measure*

#### Dates & times

- `PurReturnDt` — **date** — NOT NULL — *date-like name*
- `PurInvoiceDt` — **datetime** — NOT NULL — *date-like name*

#### Strings & text

- `PurReturnId` — **varchar(40)** — NOT NULL
- `PurInvoiceNo` — **varchar(50)** — NOT NULL — *code/ref*
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `BranchAlias` — **varchar(50)** — NOT NULL
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierCity` — **varchar(200)** — NOT NULL
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Para1Name` — **varchar(100)** — NOT NULL — *description*
- `Para2Name` — **varchar(100)** — NOT NULL — *description*
- `Fabric` — **varchar(100)** — NOT NULL
- `SubFabric` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL
- `ItemId` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `Para3Name` — **varchar(100)** — NOT NULL — *description*
- `Para4Name` — **varchar(100)** — NOT NULL — *description*

### `dbo.VW_MB_POWERBI_PURXNS_REPORT` (50 columns)

#### Decimals / numeric

- `CostPrice` — **numeric(16,5)** — NULL — *measure*
- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `PurQty` — **numeric(38,2)** — NULL — *measure*
- `PurCostValue` — **numeric(38,7)** — NULL — *measure*
- `PurNetAmount` — **numeric(38,7)** — NULL — *measure*
- `PurMrpValue` — **numeric(38,4)** — NULL
- `PurCGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `PurSGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `PurIGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `PrtQty` — **numeric(38,2)** — NULL — *measure*
- `PrtCostValue` — **numeric(38,7)** — NULL — *measure*
- `PrtNetAmount` — **numeric(38,7)** — NULL — *measure*
- `PrtMrpValue` — **numeric(38,4)** — NULL
- `PrtCGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `PrtSGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `PrtIGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `NetPurQty` — **numeric(38,2)** — NULL — *measure*
- `NetPurCost` — **numeric(38,7)** — NULL — *measure*
- `NetPurNetAmount` — **numeric(38,7)** — NULL — *measure*
- `NetPurCGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `NetPurSGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `NetPurIGSTAmount` — **numeric(38,5)** — NULL — *measure*

#### Dates & times

- `XnDt` — **date** — NOT NULL — *date-like name*
- `PurInvDate` — **datetime** — NOT NULL — *date-like name*
- `PurChallanDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `BranchAlias` — **varchar(50)** — NOT NULL
- `DepartmentName` — **varchar(100)** — NOT NULL — *description*
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `CategoryName` — **varchar(100)** — NOT NULL — *description*
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierCity` — **varchar(200)** — NOT NULL
- `SupplierState` — **varchar(200)** — NOT NULL
- `PurRefNo1` — **varchar(50)** — NOT NULL — *code/ref*
- `PurRefNo2` — **varchar(50)** — NOT NULL — *code/ref*
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Color` — **varchar(100)** — NOT NULL
- `Size` — **varchar(100)** — NOT NULL
- `Contrast` — **varchar(100)** — NOT NULL
- `Printtypework` — **varchar(100)** — NOT NULL
- `XnType` — **varchar(3)** — NOT NULL
- `XnId` — **varchar(40)** — NOT NULL
- `PurInvNo` — **varchar(50)** — NOT NULL — *code/ref*
- `PurChallanNo` — **varchar(50)** — NOT NULL — *code/ref*
- `ItemCode` — **varchar(50)** — NOT NULL — *code/ref*
- `Fabric` — **varchar(100)** — NOT NULL
- `SubFabric` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL

### `dbo.VW_MB_POWERBI_PUR_QTY_WITH_COST` (7 columns)

#### Decimals / numeric

- `PurQty` — **numeric(38,2)** — NULL — *measure*
- `PurCost` — **numeric(38,4)** — NULL — *measure*

#### Dates & times

- `PurchaseDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `BranchAlias` — **varchar(50)** — NOT NULL
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*

### `dbo.VW_MB_POWERBI_PUR_REPORT` (23 columns)

#### Integers

- `Para2Index` — **int(10,0)** — NOT NULL

#### Decimals / numeric

- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `PurQty` — **numeric(10,2)** — NOT NULL — *measure*

#### Dates & times

- `PurchaseDt` — **date** — NOT NULL — *date-like name*
- `PurInvoiceDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `PurchaseId` — **varchar(40)** — NOT NULL
- `PurInvoiceNo` — **varchar(40)** — NOT NULL — *code/ref*
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `BranchAlias` — **varchar(50)** — NOT NULL
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierCity` — **varchar(200)** — NOT NULL
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Para1Name` — **varchar(100)** — NOT NULL — *description*
- `Para2Name` — **varchar(100)** — NOT NULL — *description*
- `Fabric` — **varchar(100)** — NOT NULL
- `SubFabric` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL
- `ItemId` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `Para3Name` — **varchar(100)** — NOT NULL — *description*
- `Para4Name` — **varchar(100)** — NOT NULL — *description*

### `dbo.VW_MB_POWERBI_SLSXNS_REPORT` (41 columns)

#### Integers

- `BillCount` — **int(10,0)** — NULL

#### Decimals / numeric

- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `CostPrice` — **numeric(16,5)** — NULL — *measure*
- `SlsQty` — **numeric(38,2)** — NULL — *measure*
- `SlsMrpValue` — **numeric(38,4)** — NULL
- `SlsCostValue` — **numeric(38,7)** — NULL — *measure*
- `SlsNetAmount` — **numeric(38,2)** — NULL — *measure*
- `SlrQty` — **numeric(38,2)** — NULL — *measure*
- `SlrMrpValue` — **numeric(38,4)** — NULL
- `SlrCostValue` — **numeric(38,7)** — NULL — *measure*
- `SlrNetAmount` — **numeric(38,2)** — NULL — *measure*
- `NetSlsQty` — **numeric(38,2)** — NULL — *measure*
- `NetSlsMrpValue` — **numeric(38,4)** — NULL — *measure*
- `NetSlsCostValue` — **numeric(38,7)** — NULL — *measure*
- `NetSlsNetAmount` — **numeric(38,2)** — NULL — *measure*
- `CGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `SGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `IGSTAmount` — **numeric(38,5)** — NULL — *measure*

#### Dates & times

- `XnDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `BranchAlias` — **varchar(50)** — NOT NULL
- `Department` — **varchar(100)** — NOT NULL
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `Category` — **varchar(100)** — NOT NULL
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierCity` — **varchar(200)** — NOT NULL
- `SupplierState` — **varchar(200)** — NOT NULL
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Color` — **varchar(100)** — NOT NULL
- `Size` — **varchar(100)** — NOT NULL
- `Contrast` — **varchar(100)** — NOT NULL
- `Printtypework` — **varchar(100)** — NOT NULL
- `Fabric` — **varchar(100)** — NOT NULL
- `SubFabric` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL
- `Itemcode` — **varchar(50)** — NOT NULL — *code/ref*
- `XnId` — **varchar(40)** — NOT NULL
- `XnNo` — **varchar(40)** — NOT NULL — *code/ref*
- `XnDtMonth` — **nvarchar(30)** — NULL

### `dbo.VW_MB_POWERBI_SLS_ARTICLE_REPORT` (10 columns)

#### Decimals / numeric

- `ArticleMRP` — **numeric(10,2)** — NOT NULL
- `NetSlsQty` — **numeric(38,2)** — NULL — *measure*
- `NetAmount` — **numeric(38,2)** — NULL — *measure*
- `NetSlsCostValue` — **numeric(38,7)** — NULL — *measure*

#### Dates & times

- `XnMemoDate` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Fabric` — **varchar(100)** — NOT NULL
- `SubFabric` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL

### `dbo.VW_MB_POWERBI_SLS_BILLCOUNT` (3 columns)

#### Integers

- `BillCount` — **int(10,0)** — NULL

#### Dates & times

- `CashmemoDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `BranchId` — **char(3)** — NOT NULL

### `dbo.VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID` (32 columns)

#### Decimals / numeric

- `SalesQuantity` — **numeric(10,2)** — NOT NULL — *measure*
- `SalesCost` — **numeric(12,5)** — NOT NULL — *measure*
- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `NetAmountBeforeTax` — **numeric(32,5)** — NULL — *measure*
- `SalesNetAmount` — **numeric(10,2)** — NOT NULL — *measure*

#### Dates & times

- `CashmemoDt` — **date** — NOT NULL — *date-like name*
- `CreatedOn` — **datetime** — NOT NULL

#### Strings & text

- `BranchAlias` — **varchar(50)** — NOT NULL
- `BranchName` — **varchar(200)** — NOT NULL — *description*
- `BranchCity` — **varchar(200)** — NOT NULL
- `BranchState` — **varchar(200)** — NOT NULL
- `BranchRegion` — **varchar(20)** — NOT NULL
- `CountryRegion` — **varchar(200)** — NOT NULL
- `BranchAreaManager` — **varchar(30)** — NOT NULL
- `CashmemoNo` — **varchar(15)** — NOT NULL — *code/ref*
- `CustomerMobileNumber` — **varchar(50)** — NOT NULL — *code/ref*
- `CustomerName` — **varchar(201)** — NOT NULL — *description*
- `CustomerId` — **char(15)** — NOT NULL
- `SalesPersonName` — **varchar(30)** — NOT NULL — *description*
- `SalespersonEmpId` — **varchar(30)** — NOT NULL
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierCity` — **varchar(200)** — NOT NULL
- `SupplierState` — **varchar(200)** — NOT NULL
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `ColourName` — **varchar(100)** — NOT NULL — *description*
- `ContrastName` — **varchar(100)** — NOT NULL — *description*
- `SizeName` — **varchar(100)** — NOT NULL — *description*
- `PrintTypeWork` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL

### `dbo.VW_MB_POWERBI_SLS_REPORT` (24 columns)

#### Integers

- `Para2Index` — **int(10,0)** — NOT NULL

#### Decimals / numeric

- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `NetSlsQty` — **numeric(38,2)** — NULL — *measure*
- `NetAmount` — **numeric(38,2)** — NULL — *measure*
- `NetSlsCostValue` — **numeric(38,7)** — NULL — *measure*
- `SlsExtCostValue` — **numeric(38,7)** — NULL — *measure*

#### Dates & times

- `XnMemoDate` — **date** — NOT NULL — *date-like name*
- `PurDate` — **datetime** — NOT NULL — *date-like name*

#### Strings & text

- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `BranchAlias` — **varchar(50)** — NOT NULL
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierCity` — **varchar(200)** — NOT NULL
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Para1Name` — **varchar(100)** — NOT NULL — *description*
- `Para2Name` — **varchar(100)** — NOT NULL — *description*
- `Fabric` — **varchar(100)** — NOT NULL
- `SubFabric` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL
- `ItemId` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `Para3Name` — **varchar(100)** — NOT NULL — *description*
- `Para4Name` — **varchar(100)** — NOT NULL — *description*

### `dbo.VW_MB_POWERBI_STI_REPORT` (36 columns)

#### Integers

- `BillCount` — **int(10,0)** — NULL

#### Decimals / numeric

- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `CostPrice` — **numeric(16,5)** — NULL — *measure*
- `StiQty` — **numeric(38,2)** — NULL — *measure*
- `MrpValue` — **numeric(38,4)** — NULL
- `CostValue` — **numeric(38,7)** — NULL — *measure*
- `NetAmount` — **numeric(38,2)** — NULL — *measure*
- `CGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `SGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `IGSTAmount` — **numeric(38,5)** — NULL — *measure*

#### Dates & times

- `XnDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `SourceBranchAlias` — **varchar(50)** — NOT NULL
- `SourceBranchId` — **char(3)** — NOT NULL
- `TargetBranchAlias` — **varchar(50)** — NOT NULL
- `TargetBranchId` — **char(3)** — NOT NULL
- `Department` — **varchar(100)** — NOT NULL
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `Category` — **varchar(100)** — NOT NULL
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierCity` — **varchar(200)** — NOT NULL
- `SupplierState` — **varchar(200)** — NOT NULL
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Color` — **varchar(100)** — NOT NULL
- `Size` — **varchar(100)** — NOT NULL
- `Contrast` — **varchar(100)** — NOT NULL
- `Printtypework` — **varchar(100)** — NOT NULL
- `Fabric` — **varchar(100)** — NOT NULL
- `SubFabric` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL
- `Itemcode` — **varchar(50)** — NOT NULL — *code/ref*
- `XnId` — **varchar(40)** — NOT NULL
- `XnNo` — **varchar(15)** — NOT NULL — *code/ref*
- `XnDtMonth` — **nvarchar(30)** — NULL

### `dbo.VW_MB_POWERBI_STOCK_REPORT` (20 columns)

#### Integers

- `Para2Index` — **int(10,0)** — NOT NULL

#### Decimals / numeric

- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `StockQty` — **numeric(12,5)** — NOT NULL — *measure*

#### Dates & times

- `PurInvoiceDt` — **datetime** — NOT NULL — *date-like name*

#### Strings & text

- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `BranchAlias` — **varchar(50)** — NOT NULL
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierCity` — **varchar(200)** — NOT NULL
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Para1Name` — **varchar(100)** — NOT NULL — *description*
- `Para2Name` — **varchar(100)** — NOT NULL — *description*
- `Fabric` — **varchar(100)** — NOT NULL
- `SubFabric` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL
- `ItemId` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `Para3Name` — **varchar(100)** — NOT NULL — *description*
- `Para4Name` — **varchar(100)** — NOT NULL — *description*

### `dbo.VW_MB_POWERBI_STO_REPORT` (36 columns)

#### Integers

- `BillCount` — **int(10,0)** — NULL

#### Decimals / numeric

- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `CostPrice` — **numeric(16,5)** — NULL — *measure*
- `StoQty` — **numeric(38,2)** — NULL — *measure*
- `MrpValue` — **numeric(38,4)** — NULL
- `CostValue` — **numeric(38,7)** — NULL — *measure*
- `NetAmount` — **numeric(38,2)** — NULL — *measure*
- `CGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `SGSTAmount` — **numeric(38,5)** — NULL — *measure*
- `IGSTAmount` — **numeric(38,5)** — NULL — *measure*

#### Dates & times

- `XnDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `SourceBranchAlias` — **varchar(50)** — NOT NULL
- `SourceBranchId` — **char(3)** — NOT NULL
- `TargetBranchAlias` — **varchar(50)** — NOT NULL
- `TargetBranchId` — **char(3)** — NOT NULL
- `Department` — **varchar(100)** — NOT NULL
- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `Category` — **varchar(100)** — NOT NULL
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierCity` — **varchar(200)** — NOT NULL
- `SupplierState` — **varchar(200)** — NOT NULL
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Color` — **varchar(100)** — NOT NULL
- `Size` — **varchar(100)** — NOT NULL
- `Contrast` — **varchar(100)** — NOT NULL
- `Printtypework` — **varchar(100)** — NOT NULL
- `Fabric` — **varchar(100)** — NOT NULL
- `SubFabric` — **varchar(100)** — NOT NULL
- `Property` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL
- `Itemcode` — **varchar(50)** — NOT NULL — *code/ref*
- `XnId` — **varchar(40)** — NOT NULL
- `XnNo` — **varchar(15)** — NOT NULL — *code/ref*
- `XnDtMonth` — **nvarchar(30)** — NULL

### `dbo.VW_MB_POWERBI_SUPPLIER_PUR_REPORT` (39 columns)

#### Integers

- `Para2Index` — **int(10,0)** — NOT NULL

#### Decimals / numeric

- `PurchasePrice` — **numeric(10,2)** — NOT NULL — *measure*
- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `ItemWSP` — **numeric(10,2)** — NOT NULL
- `PurQty` — **numeric(10,2)** — NOT NULL — *measure*

#### Dates & times

- `PurDate` — **date** — NOT NULL — *date-like name*
- `PurInvDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `DepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `CategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `SubCategoryName` — **varchar(100)** — NOT NULL — *description*
- `SubCategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Colour` — **varchar(100)** — NOT NULL
- `size` — **varchar(100)** — NOT NULL
- `Contrast` — **varchar(100)** — NOT NULL
- `Printypework` — **varchar(100)** — NOT NULL
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `SupplierUID` — **varchar(50)** — NOT NULL
- `BranchAlias` — **varchar(50)** — NOT NULL
- `FabricShortName` — **varchar(50)** — NOT NULL — *description*
- `SubFabricShortName` — **varchar(50)** — NOT NULL — *description*
- `Property` — **varchar(100)** — NOT NULL
- `Collection` — **varchar(100)** — NOT NULL
- `Concept` — **varchar(100)** — NOT NULL
- `SubConceptShortName` — **varchar(50)** — NOT NULL — *description*
- `Dupatta` — **varchar(100)** — NOT NULL
- `DupattaShortName` — **varchar(50)** — NOT NULL — *description*
- `Silhoutte` — **varchar(100)** — NOT NULL
- `Bottom` — **varchar(100)** — NOT NULL
- `NECKLINE` — **varchar(100)** — NOT NULL
- `SleeveType` — **varchar(100)** — NOT NULL
- `Look` — **varchar(100)** — NOT NULL
- `INVENTORYTYPE` — **varchar(100)** — NOT NULL
- `PurInvNo` — **varchar(40)** — NOT NULL — *code/ref*
- `PurRefNo1` — **varchar(50)** — NOT NULL — *code/ref*
- `PurRefNo2` — **varchar(50)** — NOT NULL — *code/ref*
- `PurChallanNo` — **varchar(40)** — NOT NULL — *code/ref*
- `ItemId` — **varchar(100)** — NOT NULL

### `dbo.VW_MB_POWERBI_VENDOR_MASTER` (48 columns)

#### Integers

- `GstClassification` — **int(10,0)** — NOT NULL
- `MSMEBizType` — **int(10,0)** — NOT NULL
- `MSMECategory` — **int(10,0)** — NOT NULL

#### Decimals / numeric

- `CreditDays` — **numeric(3,0)** — NOT NULL
- `CreditLimit` — **numeric(12,2)** — NOT NULL
- `DiscountPercentage` — **numeric(10,2)** — NOT NULL
- `FreightPercentage` — **numeric(10,2)** — NOT NULL
- `MarginPercentage` — **numeric(10,2)** — NOT NULL
- `MarkupEXP` — **numeric(10,2)** — NOT NULL
- `MarkupMRP` — **numeric(10,2)** — NOT NULL
- `MarkupWSP` — **numeric(10,2)** — NOT NULL
- `TdsPercentage` — **numeric(10,5)** — NOT NULL

#### Dates & times

- `CreatedOn` — **datetime** — NOT NULL
- `GstEffectiveDt` — **date** — NOT NULL — *date-like name*
- `MSMERegDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `PartyId` — **char(15)** — NOT NULL
- `PartyName` — **varchar(150)** — NOT NULL — *description*
- `ShortName` — **varchar(50)** — NOT NULL — *description*
- `PartyAlias` — **varchar(100)** — NOT NULL
- `Address` — **varchar(500)** — NOT NULL
- `ExtAddress` — **varchar(1532)** — NULL
- `BusinessName` — **varchar(150)** — NOT NULL — *description*
- `Locality` — **varchar(200)** — NOT NULL
- `LocalityCity` — **varchar(402)** — NOT NULL
- `LocalityGroup` — **varchar(50)** — NOT NULL
- `PinCode` — **varchar(10)** — NOT NULL — *code/ref*
- `District` — **varchar(200)** — NOT NULL
- `City` — **varchar(200)** — NOT NULL
- `State` — **varchar(200)** — NOT NULL
- `Country` — **varchar(200)** — NOT NULL
- `ContactEmail1` — **varchar(50)** — NOT NULL
- `ContactEmail2` — **varchar(50)** — NOT NULL
- `ContactPhone1` — **varchar(50)** — NOT NULL
- `ContactPhone2` — **varchar(50)** — NOT NULL
- `ContactWebsite` — **varchar(50)** — NOT NULL
- `GstClassificationStr` — **varchar(18)** — NOT NULL
- `GstStateCode` — **varchar(20)** — NOT NULL — *code/ref*
- `IntlGLNNo` — **varchar(50)** — NOT NULL — *code/ref*
- `LocalityId` — **char(15)** — NOT NULL
- `MSMEBizTypeStr` — **varchar(16)** — NOT NULL
- `MSMECategoryStr` — **varchar(13)** — NOT NULL
- `MSMERegNo` — **varchar(50)** — NOT NULL — *code/ref*
- `PartyGroupName` — **varchar(100)** — NOT NULL — *description*
- `TaxGSTINNo` — **varchar(50)** — NOT NULL — *code/ref*
- `TaxPanNo` — **varchar(50)** — NOT NULL — *code/ref*
- `TdsFullName` — **varchar(203)** — NOT NULL — *description*
- `TdsId` — **char(15)** — NOT NULL
- `TdsName` — **varchar(100)** — NOT NULL — *description*

### `dbo.VwAIBranch` (9 columns)

#### Strings & text

- `BranchId` — **char(3)** — NOT NULL
- `BranchName` — **varchar(200)** — NOT NULL — *description*
- `BranchShortName` — **varchar(50)** — NOT NULL — *description*
- `Address` — **varchar(500)** — NOT NULL
- `Locality` — **varchar(200)** — NOT NULL
- `PinCode` — **varchar(10)** — NOT NULL — *code/ref*
- `City` — **varchar(200)** — NOT NULL
- `State` — **varchar(200)** — NOT NULL
- `Country` — **varchar(200)** — NOT NULL

### `dbo.VwAICustomerDetails` (21 columns)

#### Bit

- `ActiveStatus` — **bit** — NOT NULL — *flag/status*

#### Decimals / numeric

- `CreditLimit` — **numeric(12,2)** — NOT NULL

#### Dates & times

- `BirthdayDt` — **datetime** — NOT NULL — *date-like name*
- `AnniversaryDt` — **datetime** — NOT NULL — *date-like name*
- `CreatedOn` — **datetime** — NOT NULL
- `LastUpdate` — **datetime** — NOT NULL — *date-like name*

#### Strings & text

- `CustomerId` — **varchar(19)** — NOT NULL
- `CustomerFirstName` — **varchar(150)** — NOT NULL — *description*
- `CustomerLastName` — **varchar(100)** — NOT NULL — *description*
- `CustomerTitle` — **varchar(50)** — NOT NULL — *description*
- `ContactMobile` — **varchar(50)** — NOT NULL
- `ContactEmail` — **varchar(50)** — NOT NULL
- `Address` — **varchar(500)** — NOT NULL
- `Address2` — **varchar(500)** — NOT NULL
- `Locality` — **varchar(200)** — NULL
- `City` — **varchar(200)** — NULL
- `State` — **varchar(200)** — NULL
- `Country` — **varchar(200)** — NULL
- `PinCode` — **varchar(10)** — NULL — *code/ref*
- `CustomerGroupName` — **varchar(100)** — NULL — *description*
- `BranchName` — **varchar(200)** — NULL — *description*

### `dbo.VwAISalesData` (12 columns)

#### Decimals / numeric

- `SalesPrice` — **numeric(10,2)** — NOT NULL — *measure*
- `Quantity` — **numeric(12,2)** — NULL — *measure*
- `SaleAmountBeforeTax` — **numeric(15,5)** — NULL — *measure*
- `TaxAmount` — **numeric(16,5)** — NULL — *measure*
- `SaleNetAmount` — **numeric(12,2)** — NULL — *measure*

#### Dates & times

- `InvoiceDt` — **date** — NOT NULL — *date-like name*

#### Strings & text

- `InvoiceId` — **varchar(40)** — NOT NULL
- `InvoiceNo` — **varchar(40)** — NOT NULL — *code/ref*
- `BranchId` — **char(3)** — NOT NULL
- `CustomerId` — **varchar(19)** — NOT NULL
- `ItemId` — **varchar(100)** — NOT NULL
- `SalesPersonId` — **char(15)** — NOT NULL

### `dbo.VwAISalesPerson` (3 columns)

#### Strings & text

- `SalesPersonId` — **char(15)** — NOT NULL
- `SalesPersonName` — **varchar(30)** — NOT NULL — *description*
- `SalesPersonShortName` — **varchar(30)** — NOT NULL — *description*

### `dbo.VwAIStockData` (3 columns)

#### Decimals / numeric

- `StockQty` — **numeric(38,5)** — NULL — *measure*

#### Strings & text

- `ItemId` — **varchar(100)** — NOT NULL
- `BranchId` — **char(3)** — NOT NULL

### `dbo.VwAISupplier` (10 columns)

#### Strings & text

- `PurPartyId` — **char(15)** — NOT NULL
- `PartyName` — **varchar(150)** — NOT NULL — *description*
- `ShortName` — **varchar(50)** — NOT NULL — *description*
- `PartyAlias` — **varchar(100)** — NOT NULL
- `Address` — **varchar(500)** — NOT NULL
- `Locality` — **varchar(200)** — NOT NULL
- `PinCode` — **varchar(10)** — NOT NULL — *code/ref*
- `City` — **varchar(200)** — NOT NULL
- `State` — **varchar(200)** — NOT NULL
- `Country` — **varchar(200)** — NOT NULL

### `dbo.VwMstItems` (49 columns)

#### Integers

- `UomType` — **int(10,0)** — NOT NULL
- `GstClassification` — **int(10,0)** — NOT NULL

#### Decimals / numeric

- `ItemMRP` — **numeric(10,2)** — NOT NULL
- `ItemWSP` — **numeric(10,2)** — NOT NULL
- `ItemEXP` — **numeric(10,2)** — NOT NULL
- `PurchasePrice` — **numeric(12,5)** — NOT NULL — *measure*
- `CodingType` — **numeric(1,0)** — NOT NULL
- `ArticleStockType` — **numeric(1,0)** — NOT NULL

#### Dates & times

- `PurInvoiceDt` — **datetime** — NOT NULL — *date-like name*

#### Strings & text

- `Itemcode` — **varchar(50)** — NOT NULL — *code/ref*
- `ItemId` — **varchar(100)** — NOT NULL
- `SKU` — **varchar(500)** — NOT NULL
- `ArticleId` — **char(15)** — NOT NULL
- `ArticleNo` — **varchar(100)** — NOT NULL — *code/ref*
- `Description` — **varchar(100)** — NOT NULL — *description*
- `ExtDescription` — **varchar(500)** — NOT NULL — *description*
- `ArticleShortName` — **varchar(50)** — NOT NULL — *description*
- `UomId` — **char(15)** — NOT NULL
- `UomName` — **varchar(20)** — NOT NULL — *description*
- `GstUQC` — **varchar(50)** — NOT NULL
- `InvDepartmentId` — **char(15)** — NOT NULL
- `InvDepartmentName` — **varchar(100)** — NOT NULL — *description*
- `InvDepartmentShortName` — **varchar(50)** — NOT NULL — *description*
- `InvCategoryId` — **char(15)** — NOT NULL
- `InvCategoryName` — **varchar(100)** — NOT NULL — *description*
- `InvCategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `InvSubCategoryId` — **char(15)** — NOT NULL
- `InvSubCategoryName` — **varchar(100)** — NOT NULL — *description*
- `InvSubCategoryShortName` — **varchar(50)** — NOT NULL — *description*
- `Para1Id` — **char(15)** — NOT NULL
- `Para1Name` — **varchar(100)** — NOT NULL — *description*
- `Para1ShortName` — **varchar(50)** — NOT NULL — *description*
- `Para2Id` — **char(15)** — NOT NULL
- `Para2Name` — **varchar(100)** — NOT NULL — *description*
- `Para2ShortName` — **varchar(50)** — NOT NULL — *description*
- `Para3Id` — **char(15)** — NOT NULL
- `Para3Name` — **varchar(100)** — NOT NULL — *description*
- `Para3ShortName` — **varchar(50)** — NOT NULL — *description*
- `Para4Id` — **char(15)** — NOT NULL
- `Para4Name` — **varchar(100)** — NOT NULL — *description*
- `Para4ShortName` — **varchar(50)** — NOT NULL — *description*
- `ExtCategoryName` — **varchar(306)** — NOT NULL — *description*
- `PurPartyId` — **char(15)** — NOT NULL
- `SupplierName` — **varchar(150)** — NOT NULL — *description*
- `SupplierShortName` — **varchar(50)** — NOT NULL — *description*
- `SupplierAlias` — **varchar(100)** — NOT NULL
- `HSNCode` — **varchar(50)** — NOT NULL — *code/ref*
- `PurInvoiceNo` — **varchar(50)** — NOT NULL — *code/ref*
- `PurchaseId` — **varchar(40)** — NOT NULL

---

*End of report.*
