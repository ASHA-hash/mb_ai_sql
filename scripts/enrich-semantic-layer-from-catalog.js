#!/usr/bin/env node
"use strict";
/**
 * Suggest per-view role columns from db_tables_views_columns.json
 * (dry-run report — does not overwrite semantic-layer.json unless --write).
 *
 *   node scripts/enrich-semantic-layer-from-catalog.js
 *   node scripts/enrich-semantic-layer-from-catalog.js --write
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CATALOG = path.join(ROOT, "metadata", "db_tables_views_columns.json");
const LAYER = path.join(ROOT, "metadata", "semantic-layer.json");

const ROLE_PICK = {
  date: ["XnDt", "CashmemoDt", "InvoiceDt", "PurDate"],
  amount: ["NetSlsNetAmount", "MrpValue", "SalesNetAmount", "NetPurNetAmount"],
  qty: ["NetSlsQty", "AppQty", "SalesQuantity", "PurQty"],
  branch: ["BranchAlias", "BranchName"],
  staff: ["SalesPersonName"],
};

function pick(cols, candidates) {
  const set = new Set(cols);
  for (const c of candidates) if (set.has(c)) return c;
  return null;
}

function main() {
  const write = process.argv.includes("--write");
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  const layer = JSON.parse(fs.readFileSync(LAYER, "utf8"));
  let updated = 0;

  for (const [viewName, def] of Object.entries(catalog.views || {})) {
    const cols = Object.keys(def.columns || {});
    const block = layer[viewName] || {};
    const roles = {
      dateColumn: pick(cols, ROLE_PICK.date),
      revenueColumn: pick(cols, ROLE_PICK.amount),
      branchColumn: pick(cols, ROLE_PICK.branch),
    };
    if (cols.includes("SalesPersonName")) {
      roles.staffColumn = "SalesPersonName";
    }
    const changed =
      roles.dateColumn !== block.dateColumn ||
      roles.revenueColumn !== block.revenueColumn ||
      roles.branchColumn !== block.branchColumn;

    if (changed && write) {
      layer[viewName] = { ...block, ...roles };
      updated++;
    } else if (changed) {
      console.log(viewName, roles);
    }
  }

  if (write) {
    fs.writeFileSync(LAYER, JSON.stringify(layer, null, 2) + "\n", "utf8");
    console.log(`Updated ${updated} view blocks in semantic-layer.json`);
  } else {
    console.log("Dry run — use --write to persist role columns on view blocks");
  }
}

main();
