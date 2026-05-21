import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { schema, type SchemaColumn, type SchemaObject } from "../lib/api";

function dtBadgeClass(dt: string) {
  const d = (dt || "").toLowerCase();
  if (/int|decimal|numeric|float|real|money/.test(d)) return "explorer-type-pill is-num";
  if (/date|time/.test(d)) return "explorer-type-pill is-date";
  if (/char|varchar|text|nchar|nvarchar/.test(d)) return "explorer-type-pill is-text";
  return "explorer-type-pill is-other";
}

function ObjectCard({
  obj,
  type,
  cols,
  expanded,
  onToggle,
  onPreview,
  onAskAI,
}: {
  obj: SchemaObject;
  type: string;
  cols: Record<string, SchemaColumn[]>;
  expanded: Record<string, boolean>;
  onToggle: (schema: string, name: string) => void;
  onPreview: (schema: string, name: string) => void;
  onAskAI: (table: string, label: string) => void;
}) {
  const key = `${obj.schema}.${obj.name}`;
  const isOpen = !!expanded[key];
  const colList = cols[key];

  return (
    <div className="card mb-2 overflow-hidden">
      <div
        className="explorer-object-head flex items-center gap-3 px-4 py-3 cursor-pointer"
        onClick={() => onToggle(obj.schema, obj.name)}
        onKeyDown={e => e.key === "Enter" && onToggle(obj.schema, obj.name)}
        role="button"
        tabIndex={0}
      >
        <span className="text-base">{type === "VIEW" ? "📋" : "🗂"}</span>
        <span className="flex-1 font-medium text-sm text-slate-700 min-w-0 truncate" title={obj.name}>
          {obj.name}
        </span>
        <span className={`badge shrink-0 ${type === "VIEW" ? "bg-blue-100 text-blue-600" : "bg-rose-100 text-rose-600"}`}>
          {type}
        </span>
        <span className={`text-slate-500 text-xs transition-transform duration-200 shrink-0 ${isOpen ? "rotate-90" : ""}`}>
          ▶
        </span>
      </div>
      {isOpen && (
        <div className="explorer-schema-panel">
          {!colList ? (
            <div className="text-slate-500 text-xs px-4 py-3">Loading columns…</div>
          ) : colList.length === 0 ? (
            <p className="text-slate-500 text-xs px-4 py-3">No columns found.</p>
          ) : (
            <>
              <div className="explorer-schema-scroll mb-3 px-4">
                <table className="explorer-schema-table">
                  <thead>
                    <tr>
                      <th>Column</th>
                      <th>Type</th>
                      <th>Null</th>
                    </tr>
                  </thead>
                  <tbody>
                    {colList.map(c => {
                      const nullable = String(c.is_nullable || "").toUpperCase() === "YES";
                      return (
                        <tr key={c.column_name}>
                          <td className="explorer-cell-name">{c.column_name}</td>
                          <td>
                            <span className={dtBadgeClass(c.data_type)} title={c.data_type}>
                              {c.data_type}
                            </span>
                          </td>
                          <td>
                            <span className={`explorer-null-pill ${nullable ? "is-opt" : "is-req"}`}>
                              {nullable ? "Optional" : "Required"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex gap-2 flex-wrap px-4 pb-4">
                <button type="button" onClick={() => onPreview(obj.schema, obj.name)} className="btn-primary text-xs px-3 py-1.5">
                  📥 Preview 15 rows
                </button>
                <button type="button" onClick={() => onAskAI(`${obj.schema}.${obj.name}`, obj.name)} className="btn-ghost text-xs px-3 py-1.5">
                  ✨ Ask AI about this
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Explorer() {
  const navigate = useNavigate();
  const [objects, setObjects] = useState<{ tables: SchemaObject[]; views: SchemaObject[] } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [cols, setCols] = useState<Record<string, SchemaColumn[]>>({});
  const [filter, setFilter] = useState("");
  const [typeFilter, setType] = useState<"all" | "views" | "tables">("all");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState<{
    key: string | null;
    data: Record<string, unknown>[] | null;
    loading: boolean;
  }>({ key: null, data: null, loading: false });

  useEffect(() => {
    setLoading(true);
    schema.objects()
      .then(d => setObjects({ tables: d.tables || [], views: d.views || [] }))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function toggleObj(sch: string, name: string) {
    const key = `${sch}.${name}`;
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
    if (!cols[key]) {
      try {
        const data = await schema.columns(sch, name);
        setCols(prev => ({ ...prev, [key]: data }));
      } catch {
        setCols(prev => ({ ...prev, [key]: [] }));
      }
    }
  }

  async function loadPreview(sch: string, name: string) {
    const key = `${sch}.${name}`;
    setPreview({ key, data: null, loading: true });
    try {
      const data = await schema.preview(sch, name, 15);
      setPreview({ key, data, loading: false });
    } catch {
      setPreview({ key, data: [], loading: false });
    }
  }

  function askAI(table: string, label: string) {
    sessionStorage.setItem("erp_ai_context", JSON.stringify({ table, label }));
    navigate("/ai-query");
  }

  const q = filter.toLowerCase();
  const views = (objects?.views || []).filter(o => !q || o.name.toLowerCase().includes(q));
  const tables = (objects?.tables || []).filter(o => !q || o.name.toLowerCase().includes(q));

  return (
    <div className="section-enter space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-800">Database Explorer</h2>
        <p className="text-sm text-slate-500 mt-0.5">Browse tables and views in your ERP database.</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Search tables & views…"
          className="input-base flex-1"
        />
        <div className="flex gap-2">
          {(["all", "views", "tables"] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`flex-1 sm:flex-none px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                typeFilter === t ? "btn-primary" : "btn-ghost"
              }`}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-sm text-slate-400">Loading schema…</p>}
      {err && <div className="card p-4 text-sm text-red-700">{err}</div>}

      {objects && (
        <div className="space-y-5">
          {typeFilter !== "tables" && views.length > 0 && (
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                📋 Views ({views.length})
              </p>
              {views.map(v => (
                <ObjectCard
                  key={`${v.schema}.${v.name}`}
                  obj={v}
                  type="VIEW"
                  cols={cols}
                  expanded={expanded}
                  onToggle={toggleObj}
                  onPreview={loadPreview}
                  onAskAI={askAI}
                />
              ))}
            </div>
          )}
          {typeFilter !== "views" && tables.length > 0 && (
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                🗂 Tables ({tables.length})
              </p>
              {tables.map(t => (
                <ObjectCard
                  key={`${t.schema}.${t.name}`}
                  obj={t}
                  type="TABLE"
                  cols={cols}
                  expanded={expanded}
                  onToggle={toggleObj}
                  onPreview={loadPreview}
                  onAskAI={askAI}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {preview.key && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-sm"
          onClick={() => setPreview({ key: null, data: null, loading: false })}
        >
          <div className="card w-full max-w-5xl p-6 max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-base text-slate-800">Preview: {preview.key}</h3>
              <button
                type="button"
                onClick={() => setPreview({ key: null, data: null, loading: false })}
                className="text-slate-400 hover:text-slate-700 text-xl"
              >
                ✕
              </button>
            </div>
            {preview.loading ? (
              <p className="text-slate-400 py-6">Loading…</p>
            ) : preview.data && preview.data.length > 0 ? (
              <div className="overflow-auto max-h-[420px]">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      {Object.keys(preview.data[0]).map(c => (
                        <th key={c} className="text-left px-2 py-1 border-b font-semibold">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.map((r, i) => (
                      <tr key={i}>
                        {Object.keys(preview.data![0]).map(c => (
                          <td key={c} className="px-2 py-1 whitespace-nowrap border-b border-slate-100">
                            {r[c] == null ? "" : String(r[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-slate-500">No preview rows.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
