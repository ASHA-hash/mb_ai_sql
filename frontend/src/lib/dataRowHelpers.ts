/** Row-shape helpers for Load Dataset KPI cards (parity with Node shared-core). */

export const MASTER_REFERENCE_DATASET_KEYS = new Set([
  "branches", "customers", "stock", "vw_ai_salesperson", "vw_ai_supplier",
  "vw_mst_items", "vw_aimst_items", "mb_powerbi_branch_list",
  "mb_powerbi_category_master", "mb_powerbi_product_master", "mb_powerbi_vendor_master",
]);

export function isMasterReferenceDataset(datasetKey: string): boolean {
  return MASTER_REFERENCE_DATASET_KEYS.has(String(datasetKey || "").toLowerCase().trim());
}

export function toDMY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

export function getMasterDatasetHint(datasetKey: string): string {
  const dk = String(datasetKey || "").toLowerCase().trim();
  if (dk === "vw_ai_salesperson") {
    return "Salesperson master — IDs and names only. ShortName is often an internal code (e.g. 116), not revenue. For sales by person use sales or mb_powerbi_sls_data_without_itemid.";
  }
  if (dk === "vw_mst_items" || dk === "vw_aimst_items" || dk === "mb_powerbi_product_master") {
    return "Item catalog — do not sum Itemcode, ArticleNo, or unit prices (ItemMRP/WSP/EXP). Each row is one SKU. Use stock or sales datasets for inventory value or revenue.";
  }
  if (dk === "stock") {
    return "Stock snapshot (ItemId x BranchId). SUM(StockQty) on loaded rows is not total company inventory. Use mb_powerbi_stock_report for valued stock or load more rows.";
  }
  if (dk === "customers") {
    return "Customer master — one row per customer. CreditLimit is per account (often 0 in ERP); do not SUM across loaded rows. No date column — TOP 500 is a sample, not “newest customers”.";
  }
  if (dk === "branches") {
    return "Branch master — one row per store. No date column; a full load lists every branch (often ~100–120). Use sales / APP_REPORT for revenue by BranchAlias.";
  }
  if (dk === "vw_ai_supplier") {
    return "Reference master — browse and export; use sales/stock/purchase datasets for amounts and quantities.";
  }
  return "Reference master list — not transactional totals.";
}

export function rowsLookLikeBranchMaster(rows: Record<string, unknown>[]): boolean {
  if (!rows?.length || !rows[0]) return false;
  const keys = new Set(Object.keys(rows[0]).map(x => x.toLowerCase()));
  return keys.has("branchid") && keys.has("branchname") && keys.size <= 12;
}

export function rowsLookLikeCustomerMaster(rows: Record<string, unknown>[]): boolean {
  if (!rows?.length || !rows[0]) return false;
  const keys = new Set(Object.keys(rows[0]).map(x => x.toLowerCase()));
  return keys.has("customerid") &&
    (keys.has("customerfirstname") || keys.has("contactmobile") || keys.has("creditlimit"));
}

export function rowsLookLikeStockSnapshot(rows: Record<string, unknown>[]): boolean {
  if (!rows?.length || !rows[0]) return false;
  const keys = new Set(Object.keys(rows[0]).map(x => x.toLowerCase()));
  return keys.has("stockqty") && keys.has("branchid") && keys.has("itemid") && keys.size <= 6;
}

export function rowsLookLikeAppReportLines(rows: Record<string, unknown>[]): boolean {
  if (!rows?.length || !rows[0]) return false;
  const keys = new Set(Object.keys(rows[0]).map(x => x.toLowerCase()));
  return keys.has("mrpvalue") && keys.has("appqty") && (keys.has("xnno") || keys.has("xndt"));
}

export function rowsLookLikeItemMasterCatalog(rows: Record<string, unknown>[]): boolean {
  if (!rows?.length || !rows[0]) return false;
  const keys = new Set(Object.keys(rows[0]).map(x => x.toLowerCase()));
  return keys.has("itemcode") && keys.has("itemmrp") && (keys.has("description") || keys.has("articleno"));
}

export function distinctColumnCount(rows: Record<string, unknown>[], colPattern: RegExp): number | null {
  const key = Object.keys(rows[0] || {}).find(k => colPattern.test(k));
  if (!key) return null;
  const s = new Set<string>();
  for (const r of rows) {
    const v = r[key];
    if (v != null && String(v).trim()) s.add(String(v).trim());
  }
  return s.size;
}

export function distinctXnNoCount(rows: Record<string, unknown>[]): number | null {
  const xnKey = Object.keys(rows[0] || {}).find(k => /^xnno$/i.test(k));
  if (!xnKey) return null;
  const s = new Set<string>();
  for (const r of rows) {
    const v = r[xnKey];
    if (v != null && String(v).trim()) s.add(String(v).trim());
  }
  return s.size;
}

export function pickCanonicalRevenueKey(rows: Record<string, unknown>[]): string | null {
  const order = ["MrpValue", "metric_value", "NetSlsNetAmount", "SaleNetAmount", "NetAmount", "SalesAmount"];
  const keys = new Set(Object.keys(rows[0] || {}));
  for (const k of order) {
    if (keys.has(k)) return k;
    const found = [...keys].find(x => x.toLowerCase() === k.toLowerCase());
    if (found) return found;
  }
  return null;
}

export function pickCanonicalQtyKey(rows: Record<string, unknown>[]): string | null {
  const order = ["AppQty", "NetSlsQty", "SlsQty", "StockQty", "Quantity"];
  const keys = new Set(Object.keys(rows[0] || {}));
  for (const k of order) {
    if (keys.has(k)) return k;
    const found = [...keys].find(x => x.toLowerCase() === k.toLowerCase());
    if (found) return found;
  }
  return null;
}

export function isSalesLikeTxnDataset(datasetKey: string, sampleRow: Record<string, unknown> | null): boolean {
  const dk = String(datasetKey || "").toLowerCase().trim();
  if (isMasterReferenceDataset(dk)) return false;
  if (dk === "sales") return true;
  if (/mb_powerbi_.*_(sls|sales|cashmemo|bill|xns|article|mis_supplier)/i.test(dk)) return true;
  if (/(?:^|_)(sales|sls)(?:_|$)/.test(dk) || /\bsales_|\b_sales\b/.test(dk)) return true;
  if (/slsxns|invoice|cashmemo|billcount|purxns|pur_report|pur_qty|sto_|sti_|app_|apr_/.test(dk)) return true;
  if (!sampleRow) return false;
  const keys = Object.keys(sampleRow);
  const hasAmt = keys.some(k => /amount|revenue|mrpvalue|netsls|salenet/i.test(k));
  const hasQty = keys.some(k => /qty|quantity|appqty/i.test(k));
  return hasAmt && hasQty;
}

export function filterExcludeReturnCreditRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!rows.length) return rows;
  return rows.filter(r => {
    const amtKeys = Object.keys(r).filter(k =>
      /salenetamount|netslsnetamount|netamount|saleamountbeforetax|purnetamount|pur.?net/i.test(k),
    );
    const qtyKeys = Object.keys(r).filter(k =>
      /^quantity$/i.test(k) || /slsqty|netslsqty|purqty|prtqty/i.test(k),
    );
    let hasNegQty = false;
    let hasNegAmt = false;
    for (const k of qtyKeys) {
      const q = Number(r[k]);
      if (Number.isFinite(q) && q < 0) hasNegQty = true;
    }
    for (const k of amtKeys) {
      const n = Number(r[k]);
      if (Number.isFinite(n) && n < 0) hasNegAmt = true;
    }
    return !hasNegQty && !hasNegAmt;
  });
}

export function datasetOptionLabel(d: { shortName?: string; objectName?: string; label?: string; key: string }): string {
  const shortLabel = d.shortName || d.objectName?.split(".").pop() || d.key;
  const cols = d.label?.includes("—") ? d.label.split("—").slice(1).join("—").trim() : "";
  const tail = cols ? ` — ${cols.slice(0, 60)}${cols.length > 60 ? "…" : ""}` : "";
  return `${shortLabel}${tail}`;
}
