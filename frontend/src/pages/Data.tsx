import { useEffect, useMemo, useState } from "react";
import { connector, datasets, type ConnectorDataset } from "../lib/api";
import { formatNum } from "../lib/utils";

function DataTable({ rows, maxHeight = "480px" }: { rows: Record<string, unknown>[]; maxHeight?: string }) {
  if (!rows.length) return <p className="text-sm text-slate-500">No rows.</p>;
  const cols = Object.keys(rows[0]);
  return (
    <div className="overflow-auto rounded-xl border border-slate-200" style={{ maxHeight }}>
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-50">
          <tr>
            {cols.map(c => (
              <th key={c} className="text-left px-3 py-2 font-semibold text-slate-600 whitespace-nowrap border-b">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-100 hover:bg-slate-50/80">
              {cols.map(c => (
                <td key={c} className="px-3 py-1.5 whitespace-nowrap text-slate-700">
                  {r[c] == null ? "" : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const DATASET_GROUPS: { label: string; keys: RegExp }[] = [
  { label: "🎯 Core AI Views", keys: /^(sales|stock|customers|branches|vw_ai_salesperson|vw_ai_supplier|vw_mst_items|vw_aimst_items)$/ },
  { label: "💰 Sales & Revenue", keys: /^mb_powerbi_sls|mb_powerbi_slsxns|mb_powerbi_sls_billcount|mb_powerbi_mis_supplier/ },
  { label: "📦 Purchase", keys: /^mb_powerbi_pur/ },
  { label: "📊 Stock & Inventory", keys: /^mb_powerbi_stock|mb_powerbi_cbs/ },
  { label: "🔄 Stock Transfers", keys: /^mb_powerbi_st[io]/ },
  { label: "✅ Approvals", keys: /^mb_powerbi_ap/ },
  { label: "📋 Master Data", keys: /^mb_powerbi_(branch_list|category_master|product_master|vendor_master)|^vw_mst_branch_entry$/ },
];

export default function Data() {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof connector.config>> | null>(null);
  const [dataset, setDataset] = useState("");
  const [limit, setLimit] = useState("500");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [tablePage, setTablePage] = useState(0);

  const PAGE = 500;

  useEffect(() => {
    connector.config()
      .then(d => {
        setConfig(d);
        if (d.datasets?.length) setDataset(d.datasets[0].key);
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

  const pageRows = useMemo(() => {
    const start = tablePage * PAGE;
    return rows.slice(start, start + PAGE);
  }, [rows, tablePage]);

  async function loadDataset() {
    setLoading(true);
    setError("");
    setRows([]);
    setMeta({});
    setTablePage(0);
    try {
      const { data, headers } = await datasets.fetch(dataset, { limit });
      setRows(data);
      setMeta(headers);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const rowCountHdr = meta["x-erp-row-count"];
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE));

  return (
    <div className="section-enter space-y-5">
      <div>
        <h2 className="text-xl font-bold" style={{ color: "var(--text-strong)" }}>📊 Load Dataset</h2>
        <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>
          Pick a registry dataset and row cap — data loads from SQL Server views.
        </p>
      </div>

      {error && (
        <div className="card p-4 text-sm text-red-700 border-l-4 border-red-500 whitespace-pre-wrap">{error}</div>
      )}

      <div className="card p-5 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5">
              Dataset
              <span className="font-normal ml-2" style={{ color: "var(--text-soft)" }}>
                ({(config?.datasets || []).length} available)
              </span>
            </label>
            <select value={dataset} onChange={e => setDataset(e.target.value)} className="input-base">
              {grouped.groups.map(g => (
                <optgroup key={g.label} label={g.label}>
                  {g.items.map((d: ConnectorDataset) => (
                    <option key={d.key} value={d.key} disabled={d.accessDenied}>
                      {d.accessDenied ? "⛔ " : ""}
                      {d.shortName || d.key}
                      {d.accessDenied ? " (no SELECT)" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
              {grouped.ungrouped.length > 0 && (
                <optgroup label="Other">
                  {grouped.ungrouped.map((d: ConnectorDataset) => (
                    <option key={d.key} value={d.key} disabled={d.accessDenied}>
                      {d.shortName || d.key}
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
          </div>
        </div>

        {f.date?.enabled && (
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Date filters from the Sheets connector are not wired in the Python API yet — loads TOP rows from the view.
          </p>
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

      {rows.length > 0 && (
        <div className="card p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-slate-700">
              {formatNum(rows.length)} rows
              {rowCountHdr ? ` (server: ${rowCountHdr})` : ""}
            </p>
            {totalPages > 1 && (
              <div className="flex items-center gap-2 text-sm">
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={tablePage <= 0}
                  onClick={() => setTablePage(p => p - 1)}
                >
                  ← Prev
                </button>
                <span className="text-slate-500">
                  Page {tablePage + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={tablePage >= totalPages - 1}
                  onClick={() => setTablePage(p => p + 1)}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
          <DataTable rows={pageRows} />
        </div>
      )}
    </div>
  );
}
