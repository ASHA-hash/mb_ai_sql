/* ═══════════════════════════════════════════════
   EXPLORER PANEL
═══════════════════════════════════════════════ */
function ExplorerPanel({ auth, onAskAI }) {
  const [objects, setObjects]   = useState(null);
  const [expanded, setExpanded] = useState({});
  const [cols, setCols]         = useState({});
  const [filter, setFilter]     = useState("");
  const [typeFilter, setType]   = useState("all");
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState("");
  const [preview, setPreview]   = useState({ key: null, data: null, loading: false });

  useEffect(() => {
    setLoading(true);
    apiFetch("/api/schema/objects", { token: auth.token })
      .then(d => setObjects(d)).catch(e => setErr(e.message)).finally(() => setLoading(false));
  }, []);

  async function toggleObj(schema, name) {
    const key = `${schema}.${name}`;
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
    if (!cols[key]) {
      try {
        const data = await apiFetch(`/api/schema/columns/${encodeURIComponent(schema)}/${encodeURIComponent(name)}`, { token: auth.token });
        setCols(prev => ({ ...prev, [key]: data }));
      } catch { setCols(prev => ({ ...prev, [key]: [] })); }
    }
  }

  async function loadPreview(schema, name) {
    const key = `${schema}.${name}`;
    setPreview({ key, data: null, loading: true });
    try {
      const data = await apiFetch(`/api/schema/preview/${encodeURIComponent(schema)}/${encodeURIComponent(name)}?limit=15`, { token: auth.token });
      setPreview({ key, data, loading: false });
    } catch { setPreview({ key, data: [], loading: false }); }
  }

  function dtBadgeClass(dt) {
    const d = (dt || "").toLowerCase();
    if (/int|decimal|numeric|float|real|money/.test(d)) return "explorer-type-pill is-num";
    if (/date|time/.test(d)) return "explorer-type-pill is-date";
    if (/char|varchar|text|nchar|nvarchar/.test(d)) return "explorer-type-pill is-text";
    return "explorer-type-pill is-other";
  }

  const q = filter.toLowerCase();
  const views  = (objects?.views  || []).filter(o => !q || o.name.toLowerCase().includes(q));
  const tables = (objects?.tables || []).filter(o => !q || o.name.toLowerCase().includes(q));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-800">Database Explorer</h2>
        <p className="text-sm text-slate-500 mt-0.5">Browse tables and views in your ERP database.</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search tables & views…" className="input-base flex-1" />
        <div className="flex gap-2">
          {["all","views","tables"].map(t => (
            <button key={t} onClick={() => setType(t)}
              className={`flex-1 sm:flex-none px-4 py-2 rounded-xl text-xs font-semibold transition-all ${typeFilter === t ? "btn-primary" : "btn-ghost"}`}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="flex items-center gap-2.5 text-slate-400 text-sm"><Spinner/>Loading schema…</div>}
      {err && <Alert type="error" msg={err} />}

      {objects && (
        <div className="space-y-5">
          {typeFilter !== "tables" && views.length > 0 && (
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">📋 Views ({views.length})</p>
              {views.map(v => <ObjectCard key={`${v.schema}.${v.name}`} obj={v} type="VIEW" auth={auth} cols={cols} expanded={expanded} onToggle={toggleObj} onPreview={loadPreview} onAskAI={onAskAI} dtBadgeClass={dtBadgeClass} />)}
            </div>
          )}
          {typeFilter !== "views" && tables.length > 0 && (
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">🗂 Tables ({tables.length})</p>
              {tables.map(t => <ObjectCard key={`${t.schema}.${t.name}`} obj={t} type="TABLE" auth={auth} cols={cols} expanded={expanded} onToggle={toggleObj} onPreview={loadPreview} onAskAI={onAskAI} dtBadgeClass={dtBadgeClass} />)}
            </div>
          )}
        </div>
      )}

      {preview.key && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={() => setPreview({ key:null, data:null, loading:false })}>
          <div className="card w-full max-w-5xl p-6 fade-in max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-base text-slate-800">Preview: {preview.key}</h3>
              <button onClick={() => setPreview({ key:null, data:null, loading:false })} className="text-slate-400 hover:text-slate-700 text-xl">✕</button>
            </div>
            {preview.loading
              ? <div className="flex items-center gap-2.5 text-slate-400 py-6"><Spinner/>Loading…</div>
              : <>
                  <DataTable rows={preview.data} maxHeight="420px" />
                  {preview.data && preview.data.length > 1 && <SmartChart rows={preview.data} label={`Preview: ${preview.key}`} />}
                </>
            }
          </div>
        </div>
      )}
    </div>
  );
}

function ObjectCard({ obj, type, auth, cols, expanded, onToggle, onPreview, onAskAI, dtBadgeClass }) {
  const key = `${obj.schema}.${obj.name}`;
  const isOpen = !!expanded[key];
  const colList = cols[key];
  return (
    <div className="card mb-2 overflow-hidden">
      <div className="explorer-object-head flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={() => onToggle(obj.schema, obj.name)}>
        <span className="text-base">{type === "VIEW" ? "📋" : "🗂"}</span>
        <span className="flex-1 font-medium text-sm text-slate-700 min-w-0 truncate" title={obj.name}>{obj.name}</span>
        <span className={`badge shrink-0 ${type === "VIEW" ? "bg-blue-100 text-blue-600" : "bg-rose-100 text-rose-600"}`}>{type}</span>
        <span className={`text-slate-500 text-xs transition-transform duration-200 shrink-0 ${isOpen ? "rotate-90" : ""}`}>▶</span>
      </div>
      {isOpen && (
        <div className="explorer-schema-panel">
          {!colList
            ? <div className="flex items-center gap-2 text-slate-500 text-xs"><Spinner size={12}/>Loading columns…</div>
            : colList.length === 0
              ? <p className="text-slate-500 text-xs">No columns found.</p>
              : (
                <>
                  <div className="explorer-schema-scroll mb-3">
                    <table className="explorer-schema-table">
                      <colgroup>
                        <col className="explorer-col-name" />
                        <col className="explorer-col-type" />
                        <col className="explorer-col-null" />
                      </colgroup>
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
                                <span className={dtBadgeClass(c.data_type)} title={c.data_type}>{c.data_type}</span>
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
                  <div className="flex gap-2 flex-wrap">
                    <button onClick={() => onPreview(obj.schema, obj.name)} className="btn-primary text-xs px-3 py-1.5">📥 Preview 15 rows</button>
                    <button onClick={() => onAskAI(`${obj.schema}.${obj.name}`, obj.name)} className="btn-ghost text-xs px-3 py-1.5">✨ Ask AI about this</button>
                  </div>
                </>
              )
          }
        </div>
      )}
    </div>
  );
}
