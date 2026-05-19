/* ═══════════════════════════════════════════════
   DATA PANEL
═══════════════════════════════════════════════ */
const DATA_PAGE_SIZE = 500; // rows per table page

function DataPanel({ auth }) {
  const [config, setConfig]     = useState(null);
  const [dataset, setDataset]   = useState("");
  const [limit, setLimit]       = useState("500"); // "500" (default) or "all"
  const [fySelect, setFy]       = useState("");
  const [dateFrom, setFrom]     = useState("");
  const [dateTo, setTo]         = useState("");
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState(null);
  const [loadMeta, setLoadMeta] = useState(null);
  const [error, setError]       = useState("");
  const [includeReturns, setIncludeReturns] = useState(false);
  const [tablePage, setTablePage] = useState(0); // 0-based page index for table display

  useEffect(() => {
    setIncludeReturns(false);
    setTablePage(0); // reset to first page on dataset change
  }, [dataset]);

  useEffect(() => {
    apiFetch("/api/connector-config", { token: auth.token })
      .then(d => {
        setConfig(d);
        if (d.datasets?.length) setDataset(d.datasets[0].key);
        // Default to recent window so sales dataset doesn't open on old return-only slices.
        const n = new Date();
        const s = new Date(n);
        s.setMonth(s.getMonth() - 6);
        s.setDate(1);
        setFrom(toDMY(s));
        setTo(toDMY(n));
      })
      .catch(e => setError(e.message));
  }, []);

  const ds = config?.datasets?.find(d => d.key === dataset);
  const f  = ds?.filters || {};

  const salesTxnMode = useMemo(() => {
    const row0 = Array.isArray(result) && result.length ? result[0] : null;
    return isSalesLikeTxnDataset(dataset, row0);
  }, [dataset, result]);

  const masterOnly = useMemo(() => isMasterReferenceDataset(dataset), [dataset]);

  const displayRows = useMemo(() => {
    const rows = Array.isArray(result) ? result : [];
    if (!salesTxnMode || includeReturns) return rows;
    return filterExcludeReturnCreditRows(rows);
  }, [result, salesTxnMode, includeReturns]);

  const hardCap = config?.hardCap ?? 20000;

  async function loadDataset() {
    setLoading(true); setError(""); setResult(null); setLoadMeta(null); setTablePage(0);
    const params = new URLSearchParams({ limit });
    if (f.financialYear?.enabled && fySelect) {
      params.set("fy", fySelect);
    } else if (f.date?.enabled && dateFrom && dateTo) {
      params.set("from", dateFrom);
      params.set("to", dateTo);
    }
    try {
      const { data, headers } = await apiFetch(`/api/dataset/${encodeURIComponent(dataset)}?${params}`, {
        token: auth.token,
        returnHeaders: true,
        timeoutMs: ERP_DATASET_TIMEOUT_MS,
      });
      setResult(data);
      setLoadMeta(headers);
      if (
        Array.isArray(data) && data.length > 0 && !includeReturns &&
        isSalesLikeTxnDataset(dataset, data[0])
      ) {
        const hasPositive = data.some((r) => {
          const qtyKs = Object.keys(r).filter(k => /^quantity$/i.test(k) || /slsqty|netslsqty|purqty|netpurqty/i.test(k));
          const amtKs = Object.keys(r).filter(k => /salenetamount|netslsnetamount|netamount|purnetamount|pur.?net/i.test(k));
          const posQty = qtyKs.some(k => { const q = Number(r[k]); return Number.isFinite(q) && q > 0; });
          const posAmt = amtKs.some(k => { const n = Number(r[k]); return Number.isFinite(n) && n > 0; });
          return posQty || posAmt;
        });
        if (!hasPositive) setIncludeReturns(true);
      }
    } catch (err) {
      let m = err.message || String(err);
      if (err.data && typeof err.data.hint === "string" && err.data.hint.trim()) {
        m += "\n\n" + err.data.hint.trim();
      }
      setError(m);
    }
    finally { setLoading(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold" style={{color:'var(--text-strong)'}}>📊 Load Dataset</h2>
        <p className="text-sm mt-0.5" style={{color:'var(--text-muted)'}}>Pick a predefined dataset, set date range / FY and row cap — data comes from registry views/tables.</p>
      </div>

      {error && <Alert type="error" msg={error} onClose={() => setError("")} />}

      <div className="card p-5 space-y-3">
        <div className="grid-2col">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5">Dataset
              <span style={{fontWeight:400,color:'var(--text-soft)',marginLeft:6}}>({(config?.datasets||[]).length} views available)</span>
            </label>
            {(() => {
              const all = config?.datasets || [];
              // Group datasets by category based on key/label patterns
              const groups = [
                { label: "🎯 Core AI Views",      keys: /^(sales|stock|customers|branches|vw_ai_salesperson|vw_ai_supplier|vw_mst_items|vw_aimst_items)$/ },
                { label: "💰 Sales & Revenue",    keys: /^mb_powerbi_sls|mb_powerbi_slsxns|mb_powerbi_sls_billcount|mb_powerbi_mis_supplier/ },
                { label: "📦 Purchase",           keys: /^mb_powerbi_pur/ },
                { label: "📊 Stock & Inventory",  keys: /^mb_powerbi_stock|mb_powerbi_cbs/ },
                { label: "🔄 Stock Transfers",    keys: /^mb_powerbi_st[io]/ },
                { label: "✅ Approvals",           keys: /^mb_powerbi_ap/ },
                { label: "📋 Master Data",        keys: /^mb_powerbi_(branch_list|category_master|product_master|vendor_master)|^vw_mst_branch_entry$/ },
              ];
              const grouped = groups.map(g => ({
                ...g,
                items: all.filter(d => g.keys.test(d.key)),
              })).filter(g => g.items.length > 0);
              const ungrouped = all.filter(d => !groups.some(g => g.keys.test(d.key)));
              return (
                <select value={dataset} onChange={e => setDataset(e.target.value)} className="input-base" size={1}>
                  {grouped.map(g => (
                    <optgroup key={g.label} label={g.label}>
                      {g.items.map(d => {
                        const shortLabel = d.shortName || d.objectName.split('.').pop();
                        const cols = d.label.includes('—') ? d.label.split('—')[1].trim() : '';
                        const denied = d.accessDenied === true;
                        const label = `${denied ? '⛔ ' : ''}${shortLabel}${cols ? ' — ' + cols.slice(0,60) + (cols.length>60?'…':'') : ''}${denied ? ' (no SELECT)' : ''}`;
                        return (
                          <option key={d.key} value={d.key} disabled={denied} title={denied ? (d.accessMessage || 'SELECT permission denied') : `Registry key: ${d.key}`}>
                            {label}
                          </option>
                        );
                      })}
                    </optgroup>
                  ))}
                  {ungrouped.length > 0 && (
                    <optgroup label="Other">
                      {ungrouped.map(d => {
                        const denied = d.accessDenied === true;
                        return (
                          <option key={d.key} value={d.key} disabled={denied} title={denied ? (d.accessMessage || 'SELECT permission denied') : ''}>
                            {denied ? '⛔ ' : ''}{d.shortName || d.key}{denied ? ' (no SELECT)' : ''}
                          </option>
                        );
                      })}
                    </optgroup>
                  )}
                </select>
              );
            })()}
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
                ⚠️ "All rows" loads up to <strong>{Number(hardCap).toLocaleString()}</strong> rows (server cap). To raise or lower this limit, go to <strong>Admin → System Settings → Dataset hard cap</strong> — takes effect immediately, no restart needed.
              </p>
            )}
            {parseInt(limit) >= 2000 && limit !== "all" && (
              <p className="text-[11px] text-slate-400 mt-1">Large load — may take a moment.</p>
            )}
            <p className="text-[10px] mt-1" style={{color:'var(--text-muted)'}}>
              {f.date?.enabled
                ? <>With a date column configured for this dataset, the API returns <strong>newest rows first</strong>, then applies your row cap.</>
                : dataset === 'stock'
                  ? <>No date column on this snapshot — TOP rows are an arbitrary slice of current stock (ItemId×BranchId).</>
                  : dataset === 'customers' || dataset === 'branches'
                    ? <>No date column on this master — TOP rows are a sample, not sorted by CreatedOn unless the server adds ORDER BY.</>
                    : <>No date filter on this dataset — row order is server-defined; use row cap or export for larger samples.</>}
            </p>
          </div>
        </div>

        {f.financialYear?.enabled && (
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5">Financial year (Apr–Mar)</label>
            <select value={fySelect} onChange={e => setFy(e.target.value)} className="input-base">
              <option value="">— Use date range below —</option>
              {["FY23","FY24","FY25","FY26","FY27"].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        )}
        {f.date?.enabled && !fySelect && (
          <>
            <div style={{display:'flex', gap:6, flexWrap:'wrap', marginBottom:4}}>
              {[
                {label:'Today', fn: () => { const t=new Date(); const s=toDMY(t); setFrom(s); setTo(s); }},
                {label:'MTD',   fn: () => { const n=new Date(); setFrom(toDMY(new Date(n.getFullYear(),n.getMonth(),1))); setTo(toDMY(n)); }},
                {label:'YTD',   fn: () => { const n=new Date(); const fy=n.getMonth()>=3?n.getFullYear():n.getFullYear()-1; setFrom(toDMY(new Date(fy,3,1))); setTo(toDMY(n)); }},
                {label:'Last 6M', fn: () => { const n=new Date(); const s=new Date(n); s.setMonth(s.getMonth()-6); s.setDate(1); setFrom(toDMY(s)); setTo(toDMY(n)); }},
              ].map(({label, fn}) => (
                <button key={label} onClick={fn} style={{
                  padding:'3px 10px', borderRadius:8, border:'1px solid var(--border)',
                  background:'var(--surface2)', color:'var(--text-muted)',
                  fontSize:11, fontWeight:700, cursor:'pointer',
                }}>{label}</button>
              ))}
            </div>
            <div className="grid-2col">
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{color:'var(--text-muted)'}}>From</label>
                <input type="date"
                  value={dateFrom ? dateFrom.split('.').reverse().join('-') : ''}
                  onChange={e => {
                    const iso = e.target.value;
                    if (iso) { const p = iso.split('-'); setFrom(`${p[2]}.${p[1]}.${p[0]}`); }
                    else setFrom('');
                  }}
                  className="input-base"
                  style={{colorScheme: 'auto'}}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{color:'var(--text-muted)'}}>To</label>
                <input type="date"
                  value={dateTo ? dateTo.split('.').reverse().join('-') : ''}
                  onChange={e => {
                    const iso = e.target.value;
                    if (iso) { const p = iso.split('-'); setTo(`${p[2]}.${p[1]}.${p[0]}`); }
                    else setTo('');
                  }}
                  className="input-base"
                  style={{colorScheme: 'auto'}}
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{color:'var(--text-muted)'}}>Calendar (month quick pick)</label>
              <input
                type="month"
                className="input-base"
                onChange={e => {
                  const v = e.target.value;
                  if (!v) return;
                  const [yy, mm] = v.split('-').map(Number);
                  if (!yy || !mm) return;
                  const start = new Date(yy, mm - 1, 1);
                  const end = new Date(yy, mm, 0);
                  setFrom(toDMY(start));
                  setTo(toDMY(end));
                }}
              />
            </div>
          </>
        )}

        <button onClick={loadDataset} disabled={loading || !dataset} className="btn-primary w-full justify-center">
          {loading ? <><Spinner size={14} color="white"/>Loading…</> : "Load into view"}
        </button>
      </div>

      {salesTxnMode && (
        <div className="card p-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold" style={{color:'var(--text-strong)'}}>Transaction Mode</p>
            <p className="text-xs" style={{color:'var(--text-muted)'}}>
              Default is net-positive lines only. Enable returns / credits when you need refund or purchase-return analysis.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm" style={{color:'var(--text-strong)', cursor:'pointer'}}>
            <input
              type="checkbox"
              checked={includeReturns}
              onChange={(e) => setIncludeReturns(e.target.checked)}
            />
            Include returns / credits
          </label>
        </div>
      )}

      {result && Array.isArray(result) && (
        <div className="fade-in space-y-4">
          {loadMeta?.rowsCapped && (
            <div style={{
              padding:'8px 14px', borderRadius:10, fontSize:12, fontWeight:600,
              background:'rgba(245,158,11,0.12)', border:'1px solid rgba(245,158,11,0.35)',
              color:'#92400e',
            }}>
              ⚠️ Showing <strong>{Number(loadMeta.rowCount || result.length).toLocaleString()}</strong> rows — server limit reached
              ({Number(loadMeta.hardCap || hardCap).toLocaleString()} max). The database view may have more rows — narrow the date range, or raise the cap in <strong>Admin → System Settings → Dataset hard cap</strong>.
            </div>
          )}
          {!includeReturns && salesTxnMode && displayRows.length === 0 && (
            <div style={{
              padding:'8px 14px', borderRadius:10, fontSize:12, fontWeight:600,
              background:'rgba(59,130,246,0.10)', border:'1px solid rgba(59,130,246,0.30)',
              color:'#1e3a8a'
            }}>
              No positive sales rows found in this slice. Enable <strong>Include returns / credits</strong> or adjust date range.
            </div>
          )}
          {/* Negative-value notice if returns/credits exist */}
          {includeReturns && salesTxnMode && displayRows.some(r => Object.values(r).some(v => parseFloat(v) < 0)) && (
            <div style={{
              padding:'8px 14px', borderRadius:10, fontSize:12, fontWeight:600,
              background:'rgba(245,158,11,0.1)', border:'1px solid rgba(245,158,11,0.3)',
              color:'#92400e', display:'flex', alignItems:'center', gap:8,
            }}>
              ⚠️ This dataset includes <strong>return / credit transactions</strong> (negative Quantity or Amount). These are real transactions — refunds, cancellations, or stock returns.
            </div>
          )}

          {/* Stats — master lists show row count only (no fake ₹ KPIs on names) */}
          {displayRows.length > 0 && <StatsBar rows={displayRows} masterOnly={masterOnly} datasetKey={dataset} />}

          {/* Chart — skip reference masters / item catalog (Itemcode & unit prices are not chart metrics) */}
          {displayRows.length > 1 && !masterOnly && !rowsLookLikeItemMasterCatalog(displayRows) && !rowsLookLikeStockSnapshot(displayRows) && !rowsLookLikeCustomerMaster(displayRows) && !rowsLookLikeBranchMaster(displayRows) && (
            <SmartChart rows={displayRows} label={`${dataset} — Chart`} />
          )}

          {/* Table with pagination */}
          {(() => {
            const totalRows  = displayRows.length;
            const totalPages = Math.max(1, Math.ceil(totalRows / DATA_PAGE_SIZE));
            const safePage   = Math.min(tablePage, totalPages - 1);
            const pageStart  = safePage * DATA_PAGE_SIZE;
            const pageEnd    = Math.min(pageStart + DATA_PAGE_SIZE, totalRows);
            const pageRows   = displayRows.slice(pageStart, pageEnd);
            const needsPager = totalRows > DATA_PAGE_SIZE;
            return (
              <div>
                {/* Row count + export row */}
                <div className="flex items-center justify-between mb-2.5 flex-wrap gap-2">
                  <p className="text-xs font-semibold" style={{color:'var(--text-muted)'}}>
                    {totalRows.toLocaleString()} row(s) — {dataset}
                    {needsPager && (
                      <span style={{marginLeft:8, fontWeight:400}}>
                        · showing {(pageStart+1).toLocaleString()}–{pageEnd.toLocaleString()}
                      </span>
                    )}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <DriveSaveBtn
                      label="☁ Drive CSV"
                      filename={`${dataset}.csv`}
                      mimeType="text/csv"
                      buildBlob={() => {
                        const rows = displayRows || [];
                        if (!rows.length) return new Blob([""], { type: "text/csv" });
                        const h = Object.keys(rows[0]);
                        const lines = [h.join(","), ...rows.map(r => h.map(k => {
                          const v = String(r[k] ?? "").replace(/"/g, '""');
                          return v.includes(",") || v.includes("\n") || v.includes('"') ? `"${v}"` : v;
                        }).join(","))];
                        return new Blob([lines.join("\n")], { type: "text/csv" });
                      }}
                    />
                    <DriveXLSXBtn rows={displayRows} filename={`${dataset}.xlsx`} sheetName={dataset} />
                    <ExportXLSX rows={displayRows} filename={`${dataset}.xlsx`} sheetName={dataset} />
                    <ExportCSV rows={displayRows} filename={`${dataset}.csv`} />
                  </div>
                </div>

                {/* Pagination bar — only when more than one page */}
                {needsPager && (
                  <div className="flex items-center gap-2 mb-2 flex-wrap" style={{fontSize:12}}>
                    <button
                      disabled={safePage === 0}
                      onClick={() => setTablePage(0)}
                      style={{
                        padding:'3px 10px', borderRadius:6, border:'1px solid var(--border)',
                        background:'var(--surface2)', color:'var(--text-muted)',
                        cursor: safePage === 0 ? 'not-allowed' : 'pointer', fontWeight:600, opacity: safePage === 0 ? 0.4 : 1,
                      }}
                    >⟨⟨ First</button>
                    <button
                      disabled={safePage === 0}
                      onClick={() => setTablePage(p => Math.max(0, p - 1))}
                      style={{
                        padding:'3px 10px', borderRadius:6, border:'1px solid var(--border)',
                        background:'var(--surface2)', color:'var(--text-muted)',
                        cursor: safePage === 0 ? 'not-allowed' : 'pointer', fontWeight:600, opacity: safePage === 0 ? 0.4 : 1,
                      }}
                    >‹ Prev</button>

                    {/* Page number pills */}
                    {Array.from({ length: totalPages }, (_, i) => i).filter(i =>
                      i === 0 || i === totalPages - 1 || Math.abs(i - safePage) <= 2
                    ).reduce((acc, i, idx, arr) => {
                      if (idx > 0 && i - arr[idx - 1] > 1) acc.push('…');
                      acc.push(i);
                      return acc;
                    }, []).map((item, idx) =>
                      item === '…'
                        ? <span key={`gap-${idx}`} style={{color:'var(--text-muted)', padding:'0 4px'}}>…</span>
                        : <button key={item} onClick={() => setTablePage(item)} style={{
                            padding:'3px 10px', borderRadius:6,
                            border: item === safePage ? '1px solid var(--brand)' : '1px solid var(--border)',
                            background: item === safePage ? 'var(--brand)' : 'var(--surface2)',
                            color: item === safePage ? '#fff' : 'var(--text-muted)',
                            fontWeight:700, cursor:'pointer',
                          }}>{item + 1}</button>
                    )}

                    <button
                      disabled={safePage >= totalPages - 1}
                      onClick={() => setTablePage(p => Math.min(totalPages - 1, p + 1))}
                      style={{
                        padding:'3px 10px', borderRadius:6, border:'1px solid var(--border)',
                        background:'var(--surface2)', color:'var(--text-muted)',
                        cursor: safePage >= totalPages-1 ? 'not-allowed' : 'pointer', fontWeight:600,
                        opacity: safePage >= totalPages-1 ? 0.4 : 1,
                      }}
                    >Next ›</button>
                    <button
                      disabled={safePage >= totalPages - 1}
                      onClick={() => setTablePage(totalPages - 1)}
                      style={{
                        padding:'3px 10px', borderRadius:6, border:'1px solid var(--border)',
                        background:'var(--surface2)', color:'var(--text-muted)',
                        cursor: safePage >= totalPages-1 ? 'not-allowed' : 'pointer', fontWeight:600,
                        opacity: safePage >= totalPages-1 ? 0.4 : 1,
                      }}
                    >Last ⟩⟩</button>

                    <span style={{color:'var(--text-muted)', marginLeft:4}}>
                      Page {safePage + 1} of {totalPages} &nbsp;·&nbsp; {totalRows.toLocaleString()} total rows
                    </span>
                  </div>
                )}

                <DataTable rows={pageRows} />
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
