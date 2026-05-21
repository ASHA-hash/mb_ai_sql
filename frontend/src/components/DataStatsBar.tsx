import { formatINRAuto, formatNum } from "../lib/utils";
import {
  distinctColumnCount,
  distinctXnNoCount,
  getMasterDatasetHint,
  pickCanonicalQtyKey,
  pickCanonicalRevenueKey,
  rowsLookLikeAppReportLines,
  rowsLookLikeBranchMaster,
  rowsLookLikeCustomerMaster,
  rowsLookLikeItemMasterCatalog,
  rowsLookLikeStockSnapshot,
} from "../lib/dataRowHelpers";

const KPI_GRADIENT = "kpi-purple";

interface Card {
  icon: string;
  val: string;
  lbl: string;
  sub?: string;
}

function KpiCards({ cards, hint }: { cards: Card[]; hint?: string }) {
  return (
    <div>
      <div className="grid-stats mb-2">
        {cards.map(c => (
          <div key={c.lbl} className={`kpi-card ${KPI_GRADIENT} fade-in`}>
            <span className="kpi-icon">{c.icon}</span>
            <div className="kpi-val" style={{ position: "relative", zIndex: 1 }}>{c.val}</div>
            <div className="kpi-lbl" style={{ position: "relative", zIndex: 1 }}>{c.lbl}</div>
            {c.sub ? (
              <div style={{ position: "relative", zIndex: 1, marginTop: 8, fontSize: 11, opacity: 0.85 }}>
                {c.sub}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {hint ? (
        <p className="text-[11px] mb-4" style={{ color: "var(--text-muted)" }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function isNumericCol(rows: Record<string, unknown>[], key: string): boolean {
  const slice = rows.slice(0, Math.min(rows.length, 20));
  let valid = 0;
  let total = 0;
  for (const r of slice) {
    const v = r[key];
    if (v === null || v === undefined || v === "") continue;
    total++;
    if (!Number.isNaN(parseFloat(String(v))) && Number.isFinite(Number(v))) valid++;
  }
  return total > 0 && valid / total >= 0.75;
}

function looksLikeId(rows: Record<string, unknown>[], key: string): boolean {
  if (/id$|_id$|branchid|itemid|customerid/i.test(key)) return true;
  const vals = rows.map(r => r[key]).filter(v => v != null && v !== undefined);
  if (!vals.every(v => Number.isInteger(Number(v)))) return false;
  return /^(id|sno|rowid|seq)$/i.test(key);
}

export default function DataStatsBar({
  rows,
  datasetKey,
  masterOnly,
}: {
  rows: Record<string, unknown>[];
  datasetKey: string;
  masterOnly: boolean;
}) {
  if (!rows.length) return null;

  if (rowsLookLikeCustomerMaster(rows) || datasetKey === "customers") {
    const mobileKey = Object.keys(rows[0]).find(k => /^contactmobile$/i.test(k));
    const emailKey = Object.keys(rows[0]).find(k => /^contactemail$/i.test(k));
    const activeKey = Object.keys(rows[0]).find(k => /^activestatus$/i.test(k));
    let withMobile = 0;
    let withEmail = 0;
    let activeCount = 0;
    let creditPositive = 0;
    for (const r of rows) {
      if (mobileKey && String(r[mobileKey] || "").trim()) withMobile++;
      if (emailKey && String(r[emailKey] || "").trim()) withEmail++;
      if (activeKey) {
        const a = r[activeKey];
        if (a === true || a === 1 || String(a).toLowerCase() === "true") activeCount++;
      }
      const cl = parseFloat(String(r.CreditLimit ?? r.creditlimit));
      if (Number.isFinite(cl) && cl > 0) creditPositive++;
    }
    const branches = distinctColumnCount(rows, /^branchname$/i);
    const cards: Card[] = [
      { icon: "👥", val: rows.length.toLocaleString("en-IN"), lbl: "Customers in load", sub: "Master list sample (TOP cap)" },
      { icon: "📱", val: withMobile.toLocaleString("en-IN"), lbl: "With mobile", sub: withEmail ? `${withEmail} with email` : "" },
    ];
    if (activeKey) cards.push({ icon: "✓", val: activeCount.toLocaleString("en-IN"), lbl: "ActiveStatus true", sub: "In this slice only" });
    if (branches != null) {
      cards.push({
        icon: "🏪",
        val: branches.toLocaleString("en-IN"),
        lbl: "Distinct BranchName",
        sub: `${creditPositive} with CreditLimit > 0`,
      });
    }
    return <KpiCards cards={cards} hint={getMasterDatasetHint(datasetKey)} />;
  }

  if (rowsLookLikeBranchMaster(rows) || datasetKey === "branches") {
    const states = distinctColumnCount(rows, /^state$/i);
    const cities = distinctColumnCount(rows, /^city$/i);
    const cards: Card[] = [
      {
        icon: "🏪",
        val: rows.length.toLocaleString("en-IN"),
        lbl: "Branches loaded",
        sub: rows.length <= 500 ? "Likely full branch master" : "TOP slice only",
      },
    ];
    if (states != null) cards.push({ icon: "🗺️", val: states.toLocaleString("en-IN"), lbl: "Distinct State" });
    if (cities != null) {
      cards.push({ icon: "📍", val: cities.toLocaleString("en-IN"), lbl: "Distinct City", sub: "PinCode is postal text, not a metric" });
    }
    return <KpiCards cards={cards} hint={getMasterDatasetHint(datasetKey)} />;
  }

  const catalogMaster = masterOnly || rowsLookLikeItemMasterCatalog(rows);
  if (masterOnly || catalogMaster) {
    const keys = Object.keys(rows[0]);
    const colPreview = keys.length > 8 ? `${keys.slice(0, 8).join(", ")}… (+${keys.length - 8})` : keys.join(", ");
    return (
      <div className="mb-4 fade-in" style={{
        padding: "12px 16px",
        borderRadius: 12,
        background: "var(--surface2)",
        border: "1px solid var(--border)",
        fontSize: 13,
        color: "var(--text-muted)",
      }}>
        <strong style={{ color: "var(--text-strong)" }}>{rows.length.toLocaleString()} reference row(s)</strong>
        {catalogMaster && !masterOnly ? " · item catalog detected" : ""}
        <span style={{ display: "block", marginTop: 4, fontSize: 11, fontFamily: "monospace" }}>{colPreview}</span>
        <span style={{ display: "block", marginTop: 6, fontSize: 12 }}>{getMasterDatasetHint(datasetKey)}</span>
      </div>
    );
  }

  if (rowsLookLikeAppReportLines(rows)) {
    const revKey = pickCanonicalRevenueKey(rows) || "MrpValue";
    const qtyKey = pickCanonicalQtyKey(rows) || "AppQty";
    let sumRev = 0;
    let sumQty = 0;
    for (const r of rows) {
      sumRev += parseFloat(String(r[revKey])) || 0;
      sumQty += parseFloat(String(r[qtyKey])) || 0;
    }
    const distinctBills = distinctXnNoCount(rows);
    const cards: Card[] = [
      { icon: "📈", val: formatINRAuto(sumRev), lbl: `Sum ${revKey}`, sub: `${rows.length} approval lines in this load` },
      { icon: "📦", val: Number(sumQty).toLocaleString("en-IN"), lbl: `Sum ${qtyKey}`, sub: "Units on loaded lines" },
    ];
    if (distinctBills != null) {
      cards.push({
        icon: "🏆",
        val: Number(distinctBills).toLocaleString("en-IN"),
        lbl: "Distinct bills (XnNo)",
        sub: "Unique invoice numbers in slice",
      });
    }
    return (
      <KpiCards
        cards={cards}
        hint={`Totals are for the ${rows.length.toLocaleString()} loaded lines only (newest in your date window), not full-period MTD/YTD. Primary revenue metric is MrpValue.`}
      />
    );
  }

  if (rowsLookLikeStockSnapshot(rows) || datasetKey === "stock") {
    const qtyKey = pickCanonicalQtyKey(rows) || "StockQty";
    let sumQty = 0;
    let posQtyRows = 0;
    for (const r of rows) {
      const q = parseFloat(String(r[qtyKey])) || 0;
      sumQty += q;
      if (q > 0) posQtyRows++;
    }
    const distinctItems = distinctColumnCount(rows, /^itemid$/i);
    const distinctBranches = distinctColumnCount(rows, /^branchid$/i);
    const cards: Card[] = [
      {
        icon: "📦",
        val: Number(sumQty).toLocaleString("en-IN", { maximumFractionDigits: 2 }),
        lbl: `Sum ${qtyKey} (loaded slice)`,
        sub: `${rows.length.toLocaleString()} item×branch rows — not full inventory`,
      },
    ];
    if (distinctItems != null) {
      cards.push({ icon: "🏷️", val: Number(distinctItems).toLocaleString("en-IN"), lbl: "Distinct ItemId", sub: "In this load only" });
    }
    if (distinctBranches != null) {
      cards.push({
        icon: "🏪",
        val: Number(distinctBranches).toLocaleString("en-IN"),
        lbl: "Distinct BranchId",
        sub: `${posQtyRows.toLocaleString()} rows with qty > 0`,
      });
    }
    return <KpiCards cards={cards} hint={getMasterDatasetHint("stock")} />;
  }

  const keys = Object.keys(rows[0]);
  const numericKeys = keys
    .filter(k => isNumericCol(rows, k) && !looksLikeId(rows, k))
    .filter(k => !/pincode|zip|mobile|phone/i.test(k))
    .slice(0, 4);
  if (!numericKeys.length) return null;

  const stats = numericKeys.map(k => {
    const vals = rows.map(r => parseFloat(String(r[k]))).filter(v => !Number.isNaN(v));
    const sum = vals.reduce((a, b) => a + b, 0);
    return { key: k, sum, count: vals.length, avg: sum / vals.length };
  });

  return (
    <div className="grid-stats mb-4">
      {stats.map((s, i) => (
        <div key={s.key} className={`kpi-card ${KPI_GRADIENT} fade-in`}>
          <span className="kpi-icon">{["📈", "💰", "📦", "🏆"][i % 4]}</span>
          <div className="kpi-val" style={{ position: "relative", zIndex: 1 }}>
            {/amount|revenue|mrp|net|sale/i.test(s.key) ? formatINRAuto(s.sum) : formatNum(s.sum)}
          </div>
          <div className="kpi-lbl" style={{ position: "relative", zIndex: 1 }}>{s.key}</div>
          <div style={{ position: "relative", zIndex: 1, marginTop: 10, display: "flex", alignItems: "center", gap: 12, fontSize: 11, opacity: 0.8 }}>
            <span>avg {formatNum(s.avg)}</span>
            <span>·</span>
            <span>{s.count} rows</span>
          </div>
        </div>
      ))}
    </div>
  );
}
