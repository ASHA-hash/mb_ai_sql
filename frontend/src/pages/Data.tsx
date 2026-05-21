import { useEffect, useMemo, useState } from "react";
import { connector, datasets, type ConnectorDataset } from "../lib/api";
import DataStatsBar from "../components/DataStatsBar";
import DataExportButtons from "../components/DataExportButtons";
import {
  datasetOptionLabel,
  filterExcludeReturnCreditRows,
  isMasterReferenceDataset,
  isSalesLikeTxnDataset,
  toDMY,
} from "../lib/dataRowHelpers";

const DATA_PAGE_SIZE = 500;
const ERP_DATASET_TIMEOUT_MS = 300_000;

const DATASET_GROUPS: { label: string; keys: RegExp }[] = [
  { label: "🎯 Core AI Views", keys: /^(sales|stock|customers|branches|vw_ai_salesperson|vw_ai_supplier|vw_mst_items|vw_aimst_items)$/ },
  { label: "💰 Sales & Revenue", keys: /^mb_powerbi_sls|mb_powerbi_slsxns|mb_powerbi_sls_billcount|mb_powerbi_mis_supplier/ },
  { label: "📦 Purchase", keys: /^mb_powerbi_pur/ },
  { label: "📊 Stock & Inventory", keys: /^mb_powerbi_stock|mb_powerbi_cbs/ },
  { label: "🔄 Stock Transfers", keys: /^mb_powerbi_st[io]/ },
  { label: "✅ Approvals", keys: /^mb_powerbi_ap/ },
  { label: "📋 Master Data", keys: /^mb_powerbi_(branch_list|category_master|product_master|vendor_master)|^vw_mst_branch_entry$/ },
];

function DataTable({ rows, maxHeight = "520px" }: { rows: Record<string, unknown>[]; maxHeight?: string }) {
  if (!rows.length) return <p className="text-sm text-slate-500">No rows.</p>;
  const cols = Object.keys(rows[0]);
  return (
    <div className="overflow-auto table-scroll rounded-xl border border-slate-200" style={{ maxHeight }}>
      <table className="data-table">
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(c => (
                <td key={c} title={r[c] == null ? "" : String(r[c])}>
                  {r[c] == null ? <span className="text-slate-300">—</span> : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Data() {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof connector.config>> | null>(null);
  const [dataset, setDataset] = useState("");
  const [limit, setLimit] = useState("500");
  const [fySelect, setFy] = useState("");
  const [dateFrom, setFrom] = useState("");
  const [dateTo, setTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loadMeta, setLoadMeta] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [includeReturns, setIncludeReturns] = useState(false);
  const [tablePage, setTablePage] = useState(0);

  useEffect(() => {
    setIncludeReturns(false);
    setTablePage(0);
  }, [dataset]);

  useEffect(() => {
    connector.config()
      .then(d => {
        setConfig(d);
        const preferred = d.datasets?.find(x => x.key === "branches") ?? d.datasets?.[0];
        if (preferred) setDataset(preferred.key);
        const n = new Date();
        const s = new Date(n);
        s.setMonth(s.getMonth() - 6);
        s.setDate(1);
        setFrom(toDMY(s));
        setTo(toDMY(n));
      })
      .catch(e => setError(e.message));
  }, []);

  const hardCap = config?.hardCap ?? 20000;
  const ds = config?.datasets?.find((d: ConnectorDataset) => d.key === dataset);
  const f = ds?.filters || {};

  const grouped = useMemo(() => {
    const all = config?.datasets || [];
    const groups = DATASET_GROUPS.map(g => ({
      ...g,
      items: all.filter(d => g.keys.test(d.key)),
    })).filter(g => g.items.length > 0);
    const ungrouped = all.filter(d => !DATASET_GROUPS.some(g => g.keys.test(d.key)));
    return { groups, ungrouped };
  }, [config]);

  const salesTxnMode = useMemo(() => {
    const row0 = rows.length ? rows[0] : null;
    return isSalesLikeTxnDataset(dataset, row0);
  }, [dataset, rows]);

  const masterOnly = useMemo(() => isMasterReferenceDataset(dataset), [dataset]);

  const displayRows = useMemo(() => {
    if (!salesTxnMode || includeReturns) return rows;
    return filterExcludeReturnCreditRows(rows);
  }, [rows, salesTxnMode, includeReturns]);

  const loadMetaParsed = useMemo(() => ({
    rowCount: loadMeta["x-erp-row-count"],
    hardCap: loadMeta["x-erp-hard-cap"] || String(hardCap),
    rowsCapped: loadMeta["x-erp-rows-capped"] === "1",
  }), [loadMeta, hardCap]);

  async function loadDataset() {
    setLoading(true);
    setError("");
    setRows([]);
    setLoadMeta({});
    setTablePage(0);
    const params: Record<string, string> = { limit };
    if (f.financialYear?.enabled && fySelect) {
      params.fy = fySelect;
    } else if (f.date?.enabled && dateFrom && dateTo) {
      params.from = dateFrom;
      params.to = dateTo;
    }
    try {
      const { data, headers } = await datasets.fetch(dataset, params, ERP_DATASET_TIMEOUT_MS);
      setRows(data);
      setLoadMeta(headers);
      if (
        data.length > 0 && !includeReturns &&
        isSalesLikeTxnDataset(dataset, data[0])
      ) {
        const hasPositive = data.some(r => {
          const qtyKs = Object.keys(r).filter(k => /^quantity$/i.test(k) || /slsqty|netslsqty|purqty/i.test(k));
          const amtKs = Object.keys(r).filter(k => /salenetamount|netslsnetamount|netamount|mrpvalue/i.test(k));
          const posQty = qtyKs.some(k => { const q = Number(r[k]); return Number.isFinite(q) && q > 0; });
          const posAmt = amtKs.some(k => { const n = Number(r[k]); return Number.isFinite(n) && n > 0; });
          return posQty || posAmt;
        });
        if (!hasPositive) setIncludeReturns(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const totalRows = displayRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / DATA_PAGE_SIZE));
  const safePage = Math.min(tablePage, totalPages - 1);
  const pageStart = safePage * DATA_PAGE_SIZE;
  const pageEnd = Math.min(pageStart + DATA_PAGE_SIZE, totalRows);
  const pageRows = displayRows.slice(pageStart, pageEnd);
  const needsPager = totalRows > DATA_PAGE_SIZE;

  const rowsHint =
    f.date?.enabled
      ? <>With a date column configured for this dataset, the API returns <strong>newest rows first</strong>, then applies your row cap.</>
      : dataset === "stock"
        ? <>No date column on this snapshot — TOP rows are an arbitrary slice of current stock (ItemId×BranchId).</>
        : dataset === "customers" || dataset === "branches"
          ? <>No date column on this master — TOP rows are a sample, not sorted by CreatedOn unless the server adds ORDER BY.</>
          : <>No date filter on this dataset — row order is server-defined; use row cap or export for larger samples.</>;

  return (
    <div className="section-enter space-y-5">
      <div>
        <h2 className="text-xl font-bold" style={{ color: "var(--text-strong)" }}>📊 Load Dataset</h2>
        <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>
          Pick a predefined dataset, set date range / FY and row cap — data comes from registry views/tables.
        </p>
      </div>

      {error && (
        <div className="card p-4 text-sm text-red-700 border-l-4 border-red-500 whitespace-pre-wrap">{error}</div>
      )}

      <div className="card p-5 space-y-3">
        <div className="grid-2col">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5">
              Dataset
              <span style={{ fontWeight: 400, color: "var(--text-soft)", marginLeft: 6 }}>
                ({(config?.datasets || []).length} views available)
              </span>
            </label>
            <select value={dataset} onChange={e => setDataset(e.target.value)} className="input-base">
              {grouped.groups.map(g => (
                <optgroup key={g.label} label={g.label}>
                  {g.items.map((d: ConnectorDataset) => (
                    <option
                      key={d.key}
                      value={d.key}
                      disabled={d.accessDenied}
                      title={d.accessDenied ? d.accessMessage : `Registry key: ${d.key}`}
                    >
                      {d.accessDenied ? "⛔ " : ""}
                      {datasetOptionLabel(d)}
                      {d.accessDenied ? " (no SELECT)" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
              {grouped.ungrouped.length > 0 && (
                <optgroup label="Other">
                  {grouped.ungrouped.map((d: ConnectorDataset) => (
                    <option key={d.key} value={d.key} disabled={d.accessDenied}>
                      {d.accessDenied ? "⛔ " : ""}
                      {datasetOptionLabel(d)}
                      {d.accessDenied ? " (no SELECT)" : ""}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5">Rows</label>
            <select value={limit} onChange={e => setLimit(e.target.value)} className="input-base">
              <option value="100">100</option>
              <option value="500">500 (default)</option>
              <option value="1000">1,000</option>
              <option value="2000">2,000</option>
              <option value="5000">5,000</option>
              <option value="all">All rows (max {Number(hardCap).toLocaleString()})</option>
            </select>
            {limit === "all" && (
              <p className="text-[11px] text-amber-600 mt-1 font-medium">
                ⚠️ &quot;All rows&quot; loads up to <strong>{Number(hardCap).toLocaleString()}</strong> rows (server cap). To raise or lower this limit, go to <strong>Admin → System Settings → Dataset hard cap</strong> — takes effect immediately, no restart needed.
              </p>
            )}
            {parseInt(limit, 10) >= 2000 && limit !== "all" && (
              <p className="text-[11px] text-slate-400 mt-1">Large load — may take a moment.</p>
            )}
            <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
              {rowsHint}
            </p>
          </div>
        </div>

        {f.financialYear?.enabled && (
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5">Financial year (Apr–Mar)</label>
            <select value={fySelect} onChange={e => setFy(e.target.value)} className="input-base">
              <option value="">— Use date range below —</option>
              {["FY23", "FY24", "FY25", "FY26", "FY27"].map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        )}

        {f.date?.enabled && !fySelect && (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
              {[
                { label: "Today", fn: () => { const t = new Date(); const s = toDMY(t); setFrom(s); setTo(s); } },
                { label: "MTD", fn: () => { const n = new Date(); setFrom(toDMY(new Date(n.getFullYear(), n.getMonth(), 1))); setTo(toDMY(n)); } },
                { label: "YTD", fn: () => {
                  const n = new Date();
                  const fy = n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1;
                  setFrom(toDMY(new Date(fy, 3, 1)));
                  setTo(toDMY(n));
                } },
                { label: "Last 6M", fn: () => {
                  const n = new Date();
                  const s = new Date(n);
                  s.setMonth(s.getMonth() - 6);
                  s.setDate(1);
                  setFrom(toDMY(s));
                  setTo(toDMY(n));
                } },
              ].map(({ label, fn }) => (
                <button
                  key={label}
                  type="button"
                  onClick={fn}
                  style={{
                    padding: "3px 10px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--surface2)",
                    color: "var(--text-muted)",
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid-2col">
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: "var(--text-muted)" }}>From</label>
                <input
                  type="date"
                  className="input-base"
                  value={dateFrom ? dateFrom.split(".").reverse().join("-") : ""}
                  onChange={e => {
                    const iso = e.target.value;
                    if (iso) {
                      const p = iso.split("-");
                      setFrom(`${p[2]}.${p[1]}.${p[0]}`);
                    } else setFrom("");
                  }}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: "var(--text-muted)" }}>To</label>
                <input
                  type="date"
                  className="input-base"
                  value={dateTo ? dateTo.split(".").reverse().join("-") : ""}
                  onChange={e => {
                    const iso = e.target.value;
                    if (iso) {
                      const p = iso.split("-");
                      setTo(`${p[2]}.${p[1]}.${p[0]}`);
                    } else setTo("");
                  }}
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: "var(--text-muted)" }}>Calendar (month quick pick)</label>
              <input
                type="month"
                className="input-base"
                onChange={e => {
                  const v = e.target.value;
                  if (!v) return;
                  const [yy, mm] = v.split("-").map(Number);
                  if (!yy || !mm) return;
                  const start = new Date(yy, mm - 1, 1);
                  const end = new Date(yy, mm, 0);
                  setFrom(toDMY(start));
                  setTo(toDMY(end));
                }}
              />
            </div>
            <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              Date filters are sent to the API when configured for this dataset (Python backend may apply them on a future update).
            </p>
          </>
        )}

        <button
          type="button"
          onClick={loadDataset}
          disabled={loading || !dataset}
          className="btn-primary w-full justify-center"
        >
          {loading ? "Loading…" : "Load into view"}
        </button>
      </div>

      {salesTxnMode && rows.length > 0 && (
        <div className="card p-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>Transaction Mode</p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Default is net-positive lines only. Enable returns / credits when you need refund or purchase-return analysis.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: "var(--text-strong)" }}>
            <input
              type="checkbox"
              checked={includeReturns}
              onChange={e => setIncludeReturns(e.target.checked)}
            />
            Include returns / credits
          </label>
        </div>
      )}

      {displayRows.length > 0 && (
        <div className="fade-in space-y-4">
          {loadMetaParsed.rowsCapped && (
            <div style={{
              padding: "8px 14px",
              borderRadius: 10,
              fontSize: 12,
              fontWeight: 600,
              background: "rgba(245,158,11,0.12)",
              border: "1px solid rgba(245,158,11,0.35)",
              color: "#92400e",
            }}>
              ⚠️ Showing <strong>{Number(loadMetaParsed.rowCount || totalRows).toLocaleString()}</strong> rows — server limit reached
              ({Number(loadMetaParsed.hardCap).toLocaleString()} max). Narrow the date range or raise the cap in <strong>Admin → System Settings → Dataset hard cap</strong>.
            </div>
          )}

          {!includeReturns && salesTxnMode && displayRows.length === 0 && rows.length > 0 && (
            <div style={{
              padding: "8px 14px",
              borderRadius: 10,
              fontSize: 12,
              fontWeight: 600,
              background: "rgba(59,130,246,0.10)",
              border: "1px solid rgba(59,130,246,0.30)",
              color: "#1e3a8a",
            }}>
              No positive sales rows found in this slice. Enable <strong>Include returns / credits</strong> or adjust date range.
            </div>
          )}

          <DataStatsBar rows={displayRows} datasetKey={dataset} masterOnly={masterOnly} />

          <div>
            <div className="flex items-center justify-between mb-2.5 flex-wrap gap-2">
              <p className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>
                {totalRows.toLocaleString()} row(s) — {dataset}
                {needsPager && (
                  <span style={{ marginLeft: 8, fontWeight: 400 }}>
                    · showing {(pageStart + 1).toLocaleString()}–{pageEnd.toLocaleString()}
                  </span>
                )}
              </p>
              <DataExportButtons rows={displayRows} datasetKey={dataset} />
            </div>

            {needsPager && (
              <div className="flex items-center gap-2 mb-2 flex-wrap" style={{ fontSize: 12 }}>
                <button
                  type="button"
                  disabled={safePage === 0}
                  onClick={() => setTablePage(0)}
                  className="btn-ghost text-xs"
                  style={{ opacity: safePage === 0 ? 0.4 : 1 }}
                >
                  ⟨⟨ First
                </button>
                <button
                  type="button"
                  disabled={safePage === 0}
                  onClick={() => setTablePage(p => Math.max(0, p - 1))}
                  className="btn-ghost text-xs"
                  style={{ opacity: safePage === 0 ? 0.4 : 1 }}
                >
                  ‹ Prev
                </button>
                <span style={{ color: "var(--text-muted)" }}>
                  Page {safePage + 1} of {totalPages} · {totalRows.toLocaleString()} total rows
                </span>
                <button
                  type="button"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setTablePage(p => Math.min(totalPages - 1, p + 1))}
                  className="btn-ghost text-xs"
                  style={{ opacity: safePage >= totalPages - 1 ? 0.4 : 1 }}
                >
                  Next ›
                </button>
                <button
                  type="button"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setTablePage(totalPages - 1)}
                  className="btn-ghost text-xs"
                  style={{ opacity: safePage >= totalPages - 1 ? 0.4 : 1 }}
                >
                  Last ⟩⟩
                </button>
              </div>
            )}

            <DataTable rows={pageRows} />
          </div>
        </div>
      )}
    </div>
  );
}
