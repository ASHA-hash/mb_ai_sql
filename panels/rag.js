/* ═══════════════════════════════════════════════
   RAG MEMORY PANEL
═══════════════════════════════════════════════ */
function RagPanel({ auth }) {
  const api = getApiBase();
  const tok = auth.token;
  /** Only Manager and Admin may add, edit, verify, delete RAG examples, glossary, schema index, and starter pack (API enforces when RBAC is on). */
  const canTrainAi = auth?.role === "admin" || auth?.role === "manager";
  const [stats,    setStats]    = useState(null);
  const [examples, setExamples] = useState([]);
  const [glossary, setGlossary] = useState([]);
  const [tab,      setTab]      = useState("examples");
  const [loading,  setLoading]  = useState(false);
  const [busy,     setBusy]     = useState(false);
  const [msg,      setMsg]      = useState(null);
  const [exQ,  setExQ]  = useState("");
  const [exSQL,setExSQL]= useState("");
  const [exN,  setExN]  = useState("");
  const [gTerm,setGTerm]= useState("");
  const [gDef, setGDef] = useState("");

  function flash(type, text) { setMsg({type,text}); setTimeout(()=>setMsg(null),3500); }

  async function apiFetch(path, opts={}) {
    const h = {"Content-Type":"application/json"};
    if (tok) h["Authorization"]=`Bearer ${tok}`;
    const r = await fetch(`${api}${path}`,{...opts,headers:{...h,...(opts.headers||{})}});
    const raw = await r.text();
    let j = null;
    try {
      j = raw ? JSON.parse(raw) : {};
    } catch {
      const snippet = raw.replace(/\s+/g," ").trim().slice(0,160);
      throw new Error(
        r.status === 404
          ? `Not found (${path}) — is the API running the latest code? ${snippet}`
          : `Server returned non-JSON (${r.status}). ${snippet}`
      );
    }
    if (!r.ok||!j.ok) throw new Error(j.error||j.message||`HTTP ${r.status}`);
    return j;
  }

  async function load() {
    setLoading(true);
    try {
      const [st,ex,gl] = await Promise.all([
        apiFetch("/api/rag/stats"),
        apiFetch("/api/rag/examples"),
        apiFetch("/api/rag/glossary"),
      ]);
      setStats(st.stats);
      setExamples((ex.examples||[]).map(e => ({
        ...e,
        metadata: e.metadata || {
          question: e.question || "",
          sql: e.sql || "",
          note: e.note || "",
          autoSaved: !!e.autoSaved,
          verified: !!e.verified,
        },
      })));
      setGlossary(gl.terms||[]);
    } catch(e){flash("err",e.message);}
    finally{setLoading(false);}
  }

  useEffect(()=>{load();},[]);

  const [seeding,    setSeeding]    = React.useState(false);
  // pagination
  const PAGE_SIZE = 10;
  const [exPage,     setExPage]     = React.useState(1);
  // filter
  const [exFilter,   setExFilter]   = React.useState("all"); // all | verified | auto | manual
  // search
  const [exSearch,   setExSearch]   = React.useState("");
  // edit modal
  const [editModal,  setEditModal]  = React.useState(null); // null | { id, question, sql, note }
  const [editQ,      setEditQ]      = React.useState("");
  const [editSQL,    setEditSQL]    = React.useState("");
  const [editNote,   setEditNote]   = React.useState("");
  const [editSaving, setEditSaving] = React.useState(false);

  async function seedStarterExamples() {
    if (!canTrainAi) { flash("err", "Only Manager or Admin can load the starter pack."); return; }
    if(!confirm(`Load 25 predefined SQL examples into RAG Memory?\n\nThese cover: MTD/YTD/QTD sales, branch rankings, customer counts, category breakdown, stock, salesperson, trends, and more.\n\nExisting examples with the same question will be skipped.`)) return;
    setSeeding(true);
    try {
      const j = await apiFetch("/api/rag/seed-examples",{method:"POST",body:JSON.stringify({replace:false})});
      flash("ok",`✓ Loaded ${j.added} examples (${j.skipped} already existed). AI is now pre-trained!`);
      await load();
    } catch(e){flash("err","Seed failed: "+e.message);}
    finally{setSeeding(false);}
  }

  async function thumbsUp(id) {
    if (!canTrainAi) { flash("err", "Only Manager or Admin can verify examples."); return; }
    try {
      await apiFetch(`/api/rag/example/${id}/thumbs-up`,{method:"POST"});
      setExamples(p => p.map(e => e.id===id ? {...e, metadata:{...e.metadata, verified:true}} : e));
      flash("ok","✅ Marked as verified — AI will prioritise this example.");
    } catch(e){flash("err",e.message);}
  }

  async function thumbsDown(id) {
    if (!canTrainAi) { flash("err", "Only Manager or Admin can remove examples."); return; }
    if(!confirm("Remove this example? The AI will no longer use it as a reference.")) return;
    try {
      await apiFetch(`/api/rag/example/${id}/thumbs-down`,{method:"POST"});
      setExamples(p => p.filter(e => e.id!==id));
      flash("ok","Example removed from RAG memory.");
    } catch(e){flash("err",e.message);}
  }

  function openEditModal(ex) {
    if (!canTrainAi) { flash("err", "Only Manager or Admin can edit examples."); return; }
    setEditModal(ex);
    setEditQ(ex.metadata?.question || "");
    setEditSQL(ex.metadata?.sql || "");
    setEditNote(ex.metadata?.note || "");
  }

  async function saveEdit() {
    if (!canTrainAi) { flash("err", "Only Manager or Admin can save example edits."); return; }
    if(!editQ.trim()||!editSQL.trim()) return flash("err","Question and SQL are required.");
    setEditSaving(true);
    try {
      const j = await apiFetch(`/api/rag/example/${editModal.id}`,{
        method:"PUT",
        body:JSON.stringify({question:editQ,sql:editSQL,note:editNote})
      });
      setExamples(p => p.map(e => e.id===editModal.id
        ? {...e, metadata:{...e.metadata, question:editQ, sql:editSQL, note:editNote}}
        : e));
      flash("ok","Example updated ✓ — AI re-embedded with new SQL.");
      setEditModal(null);
    } catch(e){flash("err",e.message);}
    finally{setEditSaving(false);}
  }

  async function deleteExample(id) {
    if (!canTrainAi) return;
    if(!confirm("Remove this example from RAG memory?")) return;
    setBusy(true);
    try {
      await apiFetch(`/api/rag/example/${id}`,{method:"DELETE"});
      setExamples(p=>p.filter(e=>e.id!==id));
      flash("ok","Example removed.");
    } catch(e){flash("err",e.message);}
    finally{setBusy(false);}
  }

  async function addExample() {
    if (!canTrainAi) { flash("err", "Only Manager or Admin can add examples."); return; }
    if(!exQ.trim()||!exSQL.trim()) return flash("err","Question and SQL are required.");
    setBusy(true);
    try {
      await apiFetch("/api/rag/example",{method:"POST",body:JSON.stringify({question:exQ,sql:exSQL,note:exN})});
      flash("ok","Example saved to RAG memory ✓");
      setExQ(""); setExSQL(""); setExN(""); await load();
    } catch(e){flash("err",e.message);}
    finally{setBusy(false);}
  }

  async function deleteGlossary(id) {
    if (!canTrainAi) { flash("err", "Only Manager or Admin can delete glossary terms."); return; }
    if(!confirm("Remove this term?")) return;
    setBusy(true);
    try {
      await apiFetch(`/api/rag/glossary/${id}`,{method:"DELETE"});
      setGlossary(p=>p.filter(g=>g.id!==id));
      flash("ok","Term removed.");
    } catch(e){flash("err",e.message);}
    finally{setBusy(false);}
  }

  async function addGlossary() {
    if (!canTrainAi) { flash("err", "Only Manager or Admin can add glossary terms."); return; }
    if(!gTerm.trim()||!gDef.trim()) return flash("err","Term and definition are required.");
    setBusy(true);
    try {
      await apiFetch("/api/rag/glossary",{method:"POST",body:JSON.stringify({term:gTerm,definition:gDef})});
      flash("ok",`"${gTerm}" added to glossary ✓`);
      setGTerm(""); setGDef(""); await load();
    } catch(e){flash("err",e.message);}
    finally{setBusy(false);}
  }

  async function reindexSchema() {
    if (!canTrainAi) { flash("err", "Only Manager or Admin can re-index schema."); return; }
    if(!confirm("Re-index all schema views? This calls OpenAI embeddings and takes 30-60s.")) return;
    setBusy(true);
    try {
      const j = await apiFetch("/api/rag/index-schema",{method:"POST"});
      flash("ok",`Schema re-indexed ✓ — ${j.stats?.byType?.schema||0} views`);
      setStats(j.stats);
    } catch(e){flash("err",e.message);}
    finally{setBusy(false);}
  }

  const TABS=[
    {key:"examples",label:`📚 Examples (${stats?.byType?.example||0})`},
    {key:"glossary",label:`📖 Glossary (${stats?.byType?.glossary||0})`},
    {key:"schema",  label:`🗄 Schema (${stats?.byType?.schema||0})`},
  ];
  const [showRagGuide, setShowRagGuide] = useState(false);

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold" style={{color:'var(--text-strong)'}}>🧠 RAG Memory</h2>
          <p className="text-sm mt-0.5" style={{color:'var(--text-muted)'}}>Semantic memory that makes every AI query more accurate. Successful queries auto-save here. Add glossary terms to ground the AI in your business language.</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => setShowRagGuide(v => !v)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: showRagGuide ? '#4f46e5' : '#eef2ff',
              border: '1.5px solid #c7d2fe', borderRadius: 100, padding: '6px 14px',
              fontSize: 12, fontWeight: 700,
              color: showRagGuide ? '#fff' : '#4f46e5',
              cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.15s',
            }}
          >
            {showRagGuide ? '✕ Hide Guide' : '💡 How it works'}
          </button>
          <a
            href="/rag-guide.html"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: '#eef2ff', border: '1.5px solid #c7d2fe',
              borderRadius: 100, padding: '6px 14px',
              fontSize: 12, fontWeight: 700, color: '#4f46e5',
              textDecoration: 'none', whiteSpace: 'nowrap',
            }}
            title="Open full enterprise guide in a new tab"
          >
            📖 Full Guide ↗
          </a>
        </div>
      </div>

      {!canTrainAi && (
        <div
          className="rounded-xl px-4 py-3 text-sm"
          style={{
            background: "var(--brand-soft)",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
          }}
        >
          <strong style={{ color: "var(--text-strong)" }}>View only.</strong>{" "}
          Adding examples, glossary terms, verifying with thumbs up, editing SQL, loading the starter pack, and re-indexing schema are limited to{" "}
          <strong>Manager</strong> and <strong>Admin</strong>. You can still browse everything here.
        </div>
      )}

      {/* ── Inline RAG explainer ─────────────────────────────────────────── */}
      {showRagGuide && (
        <div style={{
          background: 'linear-gradient(135deg,#f0f4ff 0%,#fafbff 100%)',
          border: '1.5px solid #c7d2fe', borderRadius: 16, padding: '20px 24px',
          animation: 'fadeIn 0.2s ease',
        }}>
          <p style={{fontSize:13, fontWeight:800, color:'#1e1b4b', marginBottom:12}}>
            🧠 What is RAG Memory? — Plain English Explanation
          </p>

          {/* Open Book vs Closed Book */}
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16}}>
            <div style={{background:'#fff0f0', border:'1px solid #fca5a5', borderRadius:10, padding:'12px 14px'}}>
              <p style={{fontSize:11, fontWeight:800, color:'#dc2626', marginBottom:5}}>❌ Without RAG — Closed-Book Test</p>
              <p style={{fontSize:12, color:'#7f1d1d', lineHeight:1.5}}>The AI can only remember what it was trained on months ago. If you ask "MTD Sales for Branch Delhi" — it guesses which table and column to use and often gets it wrong.</p>
            </div>
            <div style={{background:'#f0fdf4', border:'1px solid #86efac', borderRadius:10, padding:'12px 14px'}}>
              <p style={{fontSize:11, fontWeight:800, color:'#16a34a', marginBottom:5}}>✅ With RAG — Open-Book Test</p>
              <p style={{fontSize:12, color:'#14532d', lineHeight:1.5}}>Before answering, the AI quickly looks up <strong>your</strong> database schema, glossary terms, and past successful queries — then writes the correct SQL using exact column names.</p>
            </div>
          </div>

          {/* 4-step flow */}
          <p style={{fontSize:11, fontWeight:800, color:'#374151', marginBottom:8, textTransform:'uppercase', letterSpacing:'.06em'}}>What happens when you ask a question:</p>
          <div style={{display:'flex', gap:0, marginBottom:14}}>
            {[
              {n:'1', label:'You ask', text:'e.g. "Top 5 branches by net sales MTD"', color:'#6366f1'},
              {n:'2', label:'RAG searches', text:'Finds relevant views, columns & past queries from memory', color:'#7c3aed'},
              {n:'3', label:'Context attached', text:'AI receives: your question + relevant schema + glossary', color:'#8b5cf6'},
              {n:'4', label:'Accurate SQL', text:'AI writes correct SQL using exact column names from your DB', color:'#10b981'},
            ].map((s,i,arr) => (
              <div key={s.n} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', position:'relative'}}>
                {i < arr.length-1 && (
                  <div style={{position:'absolute', top:16, left:'calc(50% + 20px)', right:'-calc(50% - 20px)', width:'calc(100% - 40px)', height:2, background:'linear-gradient(90deg,'+s.color+','+arr[i+1].color+')', zIndex:0}}/>
                )}
                <div style={{width:32, height:32, borderRadius:'50%', background:s.color, color:'#fff', fontSize:13, fontWeight:900, display:'flex', alignItems:'center', justifyContent:'center', zIndex:1, flexShrink:0}}>{s.n}</div>
                <p style={{fontSize:11, fontWeight:700, color:s.color, marginTop:6, marginBottom:2, textAlign:'center'}}>{s.label}</p>
                <p style={{fontSize:10, color:'#64748b', textAlign:'center', lineHeight:1.4}}>{s.text}</p>
              </div>
            ))}
          </div>

          {/* 3 memory stores */}
          <p style={{fontSize:11, fontWeight:800, color:'#374151', marginBottom:8, textTransform:'uppercase', letterSpacing:'.06em'}}>The 3 memory stores — what to add:</p>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:12}}>
            {[
              {icon:'🗄', label:'Schema', color:'#f59e0b', desc:'28 database views — automatically indexed. No action needed.'},
              {icon:'📖', label:'Glossary', color:'#10b981', desc:'Add terms like "MTD", "Net Sales", "LY". The AI uses your definitions.'},
              {icon:'📚', label:'Examples', color:'#6366f1', desc:'Past successful queries auto-save here. Add manual ones to teach the AI.'},
            ].map(s => (
              <div key={s.label} style={{background:'white', border:'1px solid #e2e8f0', borderRadius:10, padding:'10px 12px'}}>
                <div style={{fontSize:18, marginBottom:4}}>{s.icon}</div>
                <p style={{fontSize:11, fontWeight:700, color:s.color, marginBottom:3}}>{s.label}</p>
                <p style={{fontSize:11, color:'#64748b', lineHeight:1.4}}>{s.desc}</p>
              </div>
            ))}
          </div>

          <p style={{fontSize:11, color:'#6366f1', fontWeight:600, background:'#eef2ff', borderRadius:8, padding:'8px 12px', margin:0}}>
            💡 <strong>Quick start:</strong> Go to the 📖 Glossary tab below → click the quick-add chips (MTD, YTD, QTD, Net Sales, Branch) → your AI queries will immediately improve.
          </p>
        </div>
      )}

      {msg && (
        <div className={`rounded-xl px-4 py-3 text-sm font-medium ${msg.type==="ok"?"bg-emerald-50 text-emerald-700 border border-emerald-200":"bg-red-50 text-red-700 border border-red-200"}`}>
          {msg.type==="ok"?"✓ ":"⛔ "}{msg.text}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-3 gap-3">
          {[
            {label:"Query Examples",val:stats.byType?.example||0,icon:"📚",color:"#6366f1"},
            {label:"Glossary Terms",val:stats.byType?.glossary||0,icon:"📖",color:"#10b981"},
            {label:"Schema Chunks", val:stats.byType?.schema||0, icon:"🗄",color:"#f59e0b"},
          ].map(s=>(
            <div key={s.label} className="card p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
                style={{background:s.color+"18",border:`1px solid ${s.color}30`}}>{s.icon}</div>
              <div>
                <p className="text-2xl font-black" style={{color:s.color}}>{s.val}</p>
                <p className="text-xs text-slate-500">{s.label}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{display:'flex',gap:4,borderBottom:'1px solid var(--border)',flexWrap:'wrap'}}>
        {TABS.map(t=>(
          <button key={t.key} onClick={()=>setTab(t.key)}
            style={{padding:'8px 16px',fontSize:13,fontWeight:600,borderRadius:'8px 8px 0 0',
              cursor:'pointer',border:'none',transition:'background .15s,color .15s',
              background: tab===t.key ? 'var(--brand-soft)' : 'transparent',
              color: tab===t.key ? 'var(--brand)' : 'var(--text-muted)',
              borderBottom: tab===t.key ? '2px solid var(--brand)' : '2px solid transparent'
            }}>
            {t.label}
          </button>
        ))}
        <div className="flex-1"/>
        <button onClick={load} disabled={loading} className="btn-ghost text-xs px-3 py-1.5 mb-1">
          {loading?"⟳":"↺ Refresh"}
        </button>
      </div>

      {tab==="examples" && (
        <div className="space-y-4">

          {/* ── Starter Pack banner ── */}
          {examples.length < 5 ? (
            <div style={{background:'var(--brand-soft)',border:'1.5px solid var(--brand-glow)',borderRadius:16,padding:'16px 18px',display:'flex',alignItems:'center',gap:14}}>
              <div style={{fontSize:28,flexShrink:0}}>🚀</div>
              <div style={{flex:1}}>
                <p style={{fontWeight:800,color:'var(--text-strong)',fontSize:13.5,marginBottom:3}}>Load 25 pre-built examples — instant accuracy boost</p>
                <p style={{fontSize:12,color:'var(--text-muted)',margin:0}}>MTD/YTD/QTD, branch rankings, customer counts, stock, trends — all verified SQL using your exact views.</p>
              </div>
              {canTrainAi ? (
                <button onClick={seedStarterExamples} disabled={seeding}
                  style={{background:seeding?'var(--text-soft)':'var(--brand)',color:'#fff',border:'none',borderRadius:10,padding:'9px 16px',fontSize:13,fontWeight:700,cursor:seeding?'wait':'pointer',flexShrink:0,whiteSpace:'nowrap'}}>
                  {seeding?'⟳ Loading…':'📥 Load Starter Pack'}
                </button>
              ) : (
                <span style={{fontSize:12,color:'var(--text-muted)',fontWeight:600,flexShrink:0}}>Manager / Admin only</span>
              )}
            </div>
          ) : (
            <div style={{display:'flex',alignItems:'center',gap:8,justifyContent:'flex-end'}}>
              {canTrainAi && (
                <button onClick={seedStarterExamples} disabled={seeding}
                  style={{background:'var(--bg-muted)',border:'1.5px solid var(--border)',borderRadius:8,padding:'5px 12px',fontSize:12,fontWeight:700,color:'var(--text-muted)',cursor:seeding?'wait':'pointer'}}>
                  {seeding?'⟳ Loading…':'📥 Load Starter Pack'}
                </button>
              )}
            </div>
          )}

          {/* ── Add example form ── */}
          {canTrainAi && (
          <div className="card p-5 space-y-3">
            <p className="font-semibold text-slate-700 text-sm">➕ Add Query Example</p>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Question (natural language)</label>
              <input className="input-base text-sm" placeholder="e.g. Top 10 products by net sales this month" value={exQ} onChange={e=>setExQ(e.target.value)}/>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">SQL</label>
              <textarea className="input-base text-xs font-mono" rows={4} placeholder="SELECT TOP 10 ..." value={exSQL} onChange={e=>setExSQL(e.target.value)} style={{resize:"vertical"}}/>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Note (optional)</label>
              <input className="input-base text-sm" placeholder="e.g. Use SaleNetAmount for revenue" value={exN} onChange={e=>setExN(e.target.value)}/>
            </div>
            <button onClick={addExample} disabled={busy} className="btn-primary text-sm">{busy?"Saving…":"Save to Memory"}</button>
          </div>
          )}

          {/* ── Search + filter bar ── */}
          {examples.length > 0 && (
            <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
              <input
                className="input-base text-sm"
                style={{flex:1,minWidth:180,maxWidth:320}}
                placeholder="🔍 Search examples…"
                value={exSearch}
                onChange={e=>{setExSearch(e.target.value);setExPage(1);}}
              />
              {[
                {key:"all",    label:"All"},
                {key:"verified",label:"✅ Verified"},
                {key:"auto",   label:"⚡ Auto-saved"},
                {key:"manual", label:"✏️ Manual"},
              ].map(f=>(
                <button key={f.key} onClick={()=>{setExFilter(f.key);setExPage(1);}}
                  style={{
                    padding:'5px 12px', borderRadius:100, fontSize:12, fontWeight:700,
                    border: exFilter===f.key ? '1.5px solid var(--brand)' : '1.5px solid var(--border)',
                    background: exFilter===f.key ? 'var(--brand-soft)' : 'var(--bg-muted)',
                    color: exFilter===f.key ? 'var(--brand)' : 'var(--text-muted)',
                    cursor:'pointer'
                  }}>{f.label}</button>
              ))}
            </div>
          )}

          {/* ── List ── */}
          {loading ? (
            <p className="text-slate-400 text-sm text-center py-6">Loading…</p>
          ) : (() => {
            // Filter
            let filtered = examples.filter(ex => {
              const m = ex.metadata || {};
              if (exFilter==="verified" && !m.verified)     return false;
              if (exFilter==="auto"     && !m.autoSaved)    return false;
              if (exFilter==="manual"   && m.autoSaved)     return false;
              if (exSearch.trim()) {
                const s = exSearch.toLowerCase();
                if (!(String(m.question||"").toLowerCase().includes(s) ||
                      String(m.sql||"").toLowerCase().includes(s) ||
                      String(m.note||"").toLowerCase().includes(s))) return false;
              }
              return true;
            });
            const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
            const safePage   = Math.min(exPage, totalPages);
            const page       = filtered.slice((safePage-1)*PAGE_SIZE, safePage*PAGE_SIZE);

            return filtered.length===0 ? (
              <div className="card p-8 text-center">
                <p className="text-4xl mb-2">📭</p>
                <p className="text-slate-500 text-sm">
                  {examples.length===0
                    ? "No examples yet. Run a query in AI Query — successful results auto-save here."
                    : "No examples match your filter or search."}
                </p>
              </div>
            ) : (
              <div>
                {/* count + pagination top */}
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                  <p style={{fontSize:12,color:'var(--text-muted)',fontWeight:600}}>
                    {filtered.length} example{filtered.length!==1?"s":""} &nbsp;·&nbsp;
                    Page {safePage} of {totalPages}
                  </p>
                  <div style={{display:'flex',gap:6}}>
                    <button onClick={()=>setExPage(p=>Math.max(1,p-1))} disabled={safePage<=1}
                      style={{padding:'4px 10px',borderRadius:7,border:'1.5px solid var(--border)',background:'var(--bg-muted)',fontSize:12,fontWeight:700,color:safePage<=1?'var(--text-soft)':'var(--text)',cursor:safePage<=1?'default':'pointer'}}>‹ Prev</button>
                    {Array.from({length:Math.min(totalPages,5)},(_,i)=>{
                      const p = totalPages<=5 ? i+1 :
                        safePage<=3 ? i+1 :
                        safePage>=totalPages-2 ? totalPages-4+i : safePage-2+i;
                      return (
                        <button key={p} onClick={()=>setExPage(p)}
                          style={{padding:'4px 9px',borderRadius:7,fontSize:12,fontWeight:700,
                            border: p===safePage?'1.5px solid var(--brand)':'1.5px solid var(--border)',
                            background: p===safePage?'var(--brand-soft)':'var(--bg-muted)',
                            color: p===safePage?'var(--brand)':'var(--text)',cursor:'pointer'}}>{p}</button>
                      );
                    })}
                    <button onClick={()=>setExPage(p=>Math.min(totalPages,p+1))} disabled={safePage>=totalPages}
                      style={{padding:'4px 10px',borderRadius:7,border:'1.5px solid var(--border)',background:'var(--bg-muted)',fontSize:12,fontWeight:700,color:safePage>=totalPages?'var(--text-soft)':'var(--text)',cursor:safePage>=totalPages?'default':'pointer'}}>Next ›</button>
                  </div>
                </div>

                {/* Example cards */}
                <div className="space-y-3">
                  {page.map(ex => {
                    const m = ex.metadata || {};
                    return (
                      <div key={ex.id} style={{
                        background:'var(--bg-surface)',
                        border: m.verified ? '1.5px solid #22c55e' : '1px solid var(--border)',
                        borderRadius:16, padding:'14px 16px',
                        boxShadow: m.verified ? '0 0 0 3px rgba(34,197,94,0.1)' : 'var(--shadow-sm)'
                      }}>
                        {/* Header row */}
                        <div style={{display:'flex',alignItems:'flex-start',gap:10,marginBottom:8}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap',marginBottom:4}}>
                              {m.verified && (
                                <span style={{background:'rgba(34,197,94,0.15)',color:'#4ade80',fontSize:11,fontWeight:800,borderRadius:100,padding:'2px 8px'}}>✅ Verified</span>
                              )}
                              {m.autoSaved && !m.verified && (
                                <span style={{background:'var(--brand-soft)',color:'var(--brand)',fontSize:11,fontWeight:700,borderRadius:100,padding:'2px 8px'}}>⚡ auto</span>
                              )}
                              {!m.autoSaved && !m.verified && (
                                <span style={{background:'rgba(234,179,8,0.15)',color:'#fbbf24',fontSize:11,fontWeight:700,borderRadius:100,padding:'2px 8px'}}>✏️ manual</span>
                              )}
                              <p style={{fontSize:13.5,fontWeight:700,color:'var(--text-strong)',margin:0}}>{m.question}</p>
                            </div>
                          </div>
                          {/* Action buttons */}
                          {canTrainAi && (
                          <div style={{display:'flex',gap:5,flexShrink:0}}>
                            <button
                              onClick={()=>thumbsUp(ex.id)}
                              disabled={m.verified}
                              title={m.verified?"Already verified":"Mark as correct — AI will prefer this"}
                              style={{width:32,height:32,borderRadius:8,border:'1.5px solid',
                                borderColor:m.verified?'#22c55e':'var(--border)',
                                background:m.verified?'rgba(34,197,94,0.1)':'var(--bg-muted)',
                                fontSize:16,cursor:m.verified?'default':'pointer',
                                display:'flex',alignItems:'center',justifyContent:'center'}}>👍</button>
                            <button
                              onClick={()=>openEditModal({id:ex.id, metadata:m})}
                              title="Edit this example"
                              style={{width:32,height:32,borderRadius:8,border:'1.5px solid var(--border)',
                                background:'var(--bg-muted)',fontSize:15,cursor:'pointer',
                                display:'flex',alignItems:'center',justifyContent:'center'}}>✏️</button>
                            <button
                              onClick={()=>thumbsDown(ex.id)}
                              title="Remove — wrong SQL, AI should not use this"
                              style={{width:32,height:32,borderRadius:8,border:'1.5px solid rgba(248,113,113,0.4)',
                                background:'rgba(248,113,113,0.1)',fontSize:16,cursor:'pointer',
                                display:'flex',alignItems:'center',justifyContent:'center'}}>👎</button>
                          </div>
                          )}
                        </div>

                        {/* SQL block */}
                        <pre style={{
                          fontSize:11.5,fontFamily:'Consolas,monospace',color:'var(--text)',
                          background:'var(--bg-surface-2)',borderRadius:10,padding:'10px 12px',
                          overflowX:'auto',whiteSpace:'pre-wrap',maxHeight:90,margin:'0 0 6px',
                          border:'1px solid var(--border-soft)'
                        }}>{m.sql}</pre>

                        {/* Note + date */}
                        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
                          {m.note ? (
                            <p style={{fontSize:11.5,color:'var(--text-muted)',fontStyle:'italic',margin:0}}>💬 {m.note}</p>
                          ) : <span/>}
                          <p style={{fontSize:11,color:'var(--text-soft)',margin:0,flexShrink:0}}>
                            {ex.updatedAt
                              ? `Updated ${new Date(ex.updatedAt).toLocaleDateString()}`
                              : new Date(ex.addedAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Pagination bottom */}
                {totalPages > 1 && (
                  <div style={{display:'flex',justifyContent:'center',gap:6,marginTop:14}}>
                    <button onClick={()=>setExPage(p=>Math.max(1,p-1))} disabled={safePage<=1}
                      style={{padding:'5px 14px',borderRadius:8,border:'1.5px solid var(--border)',background:'var(--bg-muted)',fontSize:12,fontWeight:700,color:safePage<=1?'var(--text-soft)':'var(--text)',cursor:safePage<=1?'default':'pointer'}}>‹ Previous</button>
                    <span style={{padding:'5px 12px',fontSize:12,color:'var(--text-muted)',fontWeight:600}}>
                      {safePage} / {totalPages}
                    </span>
                    <button onClick={()=>setExPage(p=>Math.min(totalPages,p+1))} disabled={safePage>=totalPages}
                      style={{padding:'5px 14px',borderRadius:8,border:'1.5px solid var(--border)',background:'var(--bg-muted)',fontSize:12,fontWeight:700,color:safePage>=totalPages?'var(--text-soft)':'var(--text)',cursor:safePage>=totalPages?'default':'pointer'}}>Next ›</button>
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── Edit Modal ── */}
          {canTrainAi && editModal && (
            <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.65)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
              <div style={{background:'var(--bg-surface)',borderRadius:20,padding:28,width:'100%',maxWidth:640,boxShadow:'var(--shadow-lg)',maxHeight:'90vh',overflowY:'auto',border:'1px solid var(--border)'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:20}}>
                  <div>
                    <p style={{fontSize:16,fontWeight:800,color:'var(--text-strong)',margin:0}}>✏️ Edit RAG Example</p>
                    <p style={{fontSize:12,color:'var(--text-muted)',margin:'3px 0 0'}}>Fix the SQL or refine the question. The AI will re-embed with the updated version.</p>
                  </div>
                  <button onClick={()=>setEditModal(null)}
                    style={{width:32,height:32,borderRadius:8,border:'1px solid var(--border)',background:'var(--bg-muted)',fontSize:18,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--text-muted)'}}>✕</button>
                </div>

                <div style={{display:'flex',flexDirection:'column',gap:14}}>
                  <div>
                    <label style={{display:'block',fontSize:11.5,fontWeight:700,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'.05em',marginBottom:5}}>Question (natural language)</label>
                    <input
                      style={{width:'100%',padding:'9px 12px',border:'1.5px solid var(--border)',borderRadius:10,fontSize:13.5,color:'var(--text-strong)',background:'var(--bg-input)',outline:'none',boxSizing:'border-box'}}
                      value={editQ} onChange={e=>setEditQ(e.target.value)}
                      placeholder="What is MTD net sales by branch?"
                    />
                  </div>
                  <div>
                    <label style={{display:'block',fontSize:11.5,fontWeight:700,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'.05em',marginBottom:5}}>SQL Query</label>
                    <textarea
                      style={{width:'100%',padding:'9px 12px',border:'1.5px solid var(--border)',borderRadius:10,fontSize:12,fontFamily:'Consolas,monospace',color:'var(--text-strong)',background:'var(--bg-input)',outline:'none',resize:'vertical',minHeight:160,boxSizing:'border-box'}}
                      value={editSQL} onChange={e=>setEditSQL(e.target.value)}
                      placeholder="SELECT TOP 5 ..."
                    />
                  </div>
                  <div>
                    <label style={{display:'block',fontSize:11.5,fontWeight:700,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'.05em',marginBottom:5}}>Note (optional)</label>
                    <input
                      style={{width:'100%',padding:'9px 12px',border:'1.5px solid var(--border)',borderRadius:10,fontSize:13.5,color:'var(--text-strong)',background:'var(--bg-input)',outline:'none',boxSizing:'border-box'}}
                      value={editNote} onChange={e=>setEditNote(e.target.value)}
                      placeholder="e.g. Always use SaleNetAmount, JOIN VwAIBranch for branch name"
                    />
                  </div>

                  <div style={{display:'flex',gap:10,marginTop:4}}>
                    <button onClick={saveEdit} disabled={editSaving}
                      style={{flex:1,padding:'10px 0',borderRadius:10,border:'none',
                        background:editSaving?'var(--text-soft)':'var(--brand)',color:'#fff',
                        fontSize:14,fontWeight:700,cursor:editSaving?'wait':'pointer'}}>
                      {editSaving?'⟳ Saving & Re-embedding…':'💾 Save Changes'}
                    </button>
                    <button onClick={()=>setEditModal(null)}
                      style={{padding:'10px 20px',borderRadius:10,border:'1.5px solid var(--border)',
                        background:'var(--bg-muted)',fontSize:14,fontWeight:700,color:'var(--text-muted)',cursor:'pointer'}}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab==="glossary" && (
        <div className="space-y-4">
          {canTrainAi && (
          <>
          <div className="card p-5 space-y-3">
            <p className="font-semibold text-slate-700 text-sm">➕ Add Business Term</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Term</label>
                <input className="input-base text-sm" placeholder="e.g. Net Sales" value={gTerm} onChange={e=>setGTerm(e.target.value)}/>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Definition</label>
                <input className="input-base text-sm" placeholder="e.g. SaleNetAmount column" value={gDef} onChange={e=>setGDef(e.target.value)}/>
              </div>
            </div>
            <button onClick={addGlossary} disabled={busy} className="btn-primary text-sm">{busy?"Saving…":"Add Term"}</button>
          </div>

          <div className="card p-4">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Quick-add starters</p>
            <div className="flex flex-wrap gap-2">
              {[
                ["Net Sales","SaleNetAmount column on VwAISalesData (post-discount revenue)"],
                ["MTD","Month to date — 1st of current month to today"],
                ["YTD","Year to date — April 1 of current Indian FY to today"],
                ["QTD","Quarter to date — start of current Indian fiscal quarter to today"],
                ["Branch","Physical store; BranchId on VwAI* views, BranchAlias on PowerBI views"],
              ].map(([t,d])=>(
                <button key={t} onClick={()=>{setGTerm(t);setGDef(d);}}
                  className="badge bg-indigo-50 text-indigo-700 cursor-pointer hover:bg-indigo-100 transition-colors">{t}</button>
              ))}
            </div>
          </div>
          </>
          )}

          {loading?<p className="text-slate-400 text-sm text-center py-6">Loading…</p>:
           glossary.length===0?(
            <div className="card p-8 text-center">
              <p className="text-4xl mb-2">📖</p>
              <p className="text-slate-500 text-sm">
                {canTrainAi
                  ? "No glossary terms yet. Add your business vocabulary above."
                  : "No glossary terms yet. Managers and Admins can add business vocabulary."}
              </p>
            </div>
          ):(
            <div className="space-y-2">
              {glossary.map(g=>(
                <div key={g.id} className="card p-4 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold text-slate-800 text-sm">{g.term}</span>
                    <span className="text-slate-400 mx-2">—</span>
                    <span className="text-slate-600 text-sm">{g.definition}</span>
                  </div>
                  {canTrainAi && (
                  <button onClick={()=>deleteGlossary(g.id)} disabled={busy}
                    className="text-slate-300 hover:text-red-500 transition-colors text-lg flex-shrink-0" title="Remove">✕</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab==="schema" && (
        <div className="space-y-4">
          <div className="card p-5">
            <p className="text-sm text-slate-600 mb-4">All database views are indexed as semantic chunks. The AI retrieves the most relevant views for each question automatically. Re-index whenever your schema changes.</p>
            {canTrainAi ? (
            <button onClick={reindexSchema} disabled={busy} className="btn-primary text-sm">
              {busy?"Indexing…":"🗄 Re-index Schema Views"}
            </button>
            ) : (
            <p className="text-xs text-slate-500">Re-indexing is available to Manager and Admin only.</p>
            )}
          </div>
          {(stats?.byType?.schema||0)>0&&(
            <div className="card p-4">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Indexed views</p>
              <p className="text-2xl font-black text-amber-500">{stats.byType.schema}</p>
              <p className="text-xs text-slate-500">views indexed as searchable embeddings</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
