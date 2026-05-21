/* ═══════════════════════════════════════════════
   AI QUERY PANEL
═══════════════════════════════════════════════ */

/**
 * Lightweight markdown → safe HTML converter.
 * Handles the patterns the AI answer actually uses:
 *   ## Heading, **bold**, *italic*, - bullet list, numbered list, blank-line paragraphs.
 * Does NOT use any external library — pure regex, XSS-safe (no script tags allowed through).
 */
function renderMarkdown(text) {
  if (!text) return "";
  let s = String(text);

  // Strip any script tags just in case
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Normalise line endings
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // ── Block-level elements (process before inline so we don't double-escape) ──

  // Headings: ## Heading → <h3>, ### Heading → <h4>
  s = s.replace(/^### (.+)$/gm, "<h4 style='margin:10px 0 4px;font-size:13px;font-weight:700;color:#0f172a'>$1</h4>");
  s = s.replace(/^## (.+)$/gm,  "<h3 style='margin:12px 0 5px;font-size:14px;font-weight:700;color:#0f172a'>$1</h3>");
  s = s.replace(/^# (.+)$/gm,   "<h3 style='margin:12px 0 5px;font-size:15px;font-weight:700;color:#0f172a'>$1</h3>");

  // Horizontal rule
  s = s.replace(/^---+$/gm, "<hr style='border:none;border-top:1px solid #e2e8f0;margin:8px 0'/>");

  // Bullet lists: collect consecutive - / * lines into <ul>
  s = s.replace(/((?:^[ \t]*[-*] .+\n?)+)/gm, (block) => {
    const items = block.trim().split("\n").map(line =>
      "<li style='margin:2px 0'>" + line.replace(/^[ \t]*[-*] /, "").trim() + "</li>"
    ).join("");
    return "<ul style='margin:6px 0 6px 18px;padding:0;list-style:disc'>" + items + "</ul>\n";
  });

  // Numbered lists: 1. item
  s = s.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split("\n").map(line =>
      "<li style='margin:2px 0'>" + line.replace(/^[ \t]*\d+\. /, "").trim() + "</li>"
    ).join("");
    return "<ol style='margin:6px 0 6px 18px;padding:0'>" + items + "</ol>\n";
  });

  // Blank-line paragraph breaks → </p><p>
  s = s.replace(/\n{2,}/g, "</p><p style='margin:6px 0'>");

  // ── Inline elements ──
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
  s = s.replace(/`([^`]+)`/g, "<code style='background:#f1f5f9;padding:1px 4px;border-radius:3px;font-size:11px'>$1</code>");

  // Remaining single newlines → <br> (inside paragraphs)
  s = s.replace(/\n/g, "<br/>");

  return `<p style='margin:0'>${s}</p>`;
}

/** Strip markdown syntax for plain-text previews (chat history snippets). */
function stripMarkdown(text) {
  if (!text) return "";
  return String(text)
    .replace(/#{1,4} /g, "")
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-*] /gm, "")
    .replace(/^\d+\. /gm, "")
    .replace(/\n+/g, " ")
    .trim();
}

/** User question chip — used for the active turn and archived turns. */
function QuestionBubble({ text, ts }) {
  if (!text) return null;
  return (
    <div
      className="rounded-xl border overflow-hidden fade-in"
      style={{ background: "var(--bg-card,#fff)", borderColor: "var(--border,#e2e8f0)" }}
    >
      <div
        className="flex items-center gap-2 px-4 py-2.5"
        style={{ background: "var(--bg-muted,#f8fafc)", borderBottom: "1px solid var(--border,#e2e8f0)" }}
      >
        <span className="text-sm flex-shrink-0">✨</span>
        <p className="text-sm font-semibold flex-1 leading-snug" style={{ color: "var(--text,#0f172a)" }}>
          {text}
        </p>
        {ts ? (
          <span className="text-xs flex-shrink-0" style={{ color: "var(--text-muted,#94a3b8)" }}>
            {new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AIQueryPanel({ auth, initialContext }) {
  const AI_PROGRESS_STEPS = [
    { label: "Understanding your question", atMs: 0 },
    { label: "Building SQL from prompt", atMs: 900 },
    { label: "Running query on database", atMs: 2500 },
    { label: "Validating result + formatting", atMs: 5200 },
    { label: "Preparing chart + answer", atMs: 8200 },
  ];

  const [question, setQuestion]       = useState("");
  const [context, setContext]         = useState(initialContext || null);
  const [loading, setLoading]         = useState(false);
  const [aiProgress, setAiProgress]   = useState({ step: 0, pct: 8, startedAt: 0 });
  const [result, setResult]           = useState(null);       // last DB result
  const [error, setError]             = useState("");
  const [clarificationUi, setClarificationUi] = useState(null);
  const [totals, setTotals]           = useState(false);
  const [showSQL, setShowSQL]         = useState(false);
  const [history, setHistory]         = useState([]);  // server-side — loaded in useEffect below
  const [queryFromDate, setQueryFromDate] = useState("");
  const [queryToDate, setQueryToDate] = useState("");
  const [queryMode, setQueryMode]     = useState(() => { try { return localStorage.getItem("erp_ai_mode") || "langgraph"; } catch { return "langgraph"; } });
  const [aiProvider, setAiProvider]   = useState(() => { try { return localStorage.getItem("erp_ai_provider") || "openai"; } catch { return "openai"; } });
  // Dynamic suggestions — loaded from RAG store, fall back to static list
  const { suggestions: dynamicSuggestions } = useDynamicSuggestions(auth?.token);
  /* Sales dashboard (intent) UI */
  const [sdDrill, setSdDrill] = useState({});
  const [sdBarAxis, setSdBarAxis] = useState("vertical");

  // Follow-up conversation state
  const [followUp, setFollowUp]       = useState("");         // current follow-up input
  const [followLoading, setFollowLoad]= useState(false);
  const [conversation, setConversation] = useState([]);       // [{ role: "user"|"ai", text }]
  const followEndRef = React.useRef(null);

  // Persistent chat history — completed queries accumulate here
  const [chatMessages, setChatMessages] = useState([]);       // [{ id, question, result, ts }]
  const [activeQuestion, setActiveQuestion] = useState(""); // current turn (shown above answer)
  const chatBottomRef = React.useRef(null);

  /* ── Inline feedback (👍/👎) on AI query results ── */
  const [feedbackStatus,  setFeedbackStatus]  = useState(null);  // null | 'good' | 'bad' | 'correcting'
  const [correctedSql,    setCorrectedSql]    = useState('');
  const [exportPoll, setExportPoll] = useState(null);
  const [exportDownloading, setExportDownloading] = useState(false);

  async function pollExportJob(jobId) {
    const data = await apiFetch(`/api/query/export-async/${encodeURIComponent(jobId)}`, {
      token: auth.token,
    });
    const job = data?.job;
    if (!job) return null;
    setExportPoll({
      status: job.status,
      rowCount: job.rowCount,
      maxRows: job.maxRows,
      error: job.error,
      downloadUrl: job.downloadUrl,
    });
    return job;
  }

  async function downloadExportCsv(jobId) {
    const path = `/api/query/export-async/${encodeURIComponent(jobId)}/download`;
    setExportDownloading(true);
    try {
      const base = getApiBase();
      const headers = { "ngrok-skip-browser-warning": "true" };
      if (auth?.token) headers["Authorization"] = `Bearer ${auth.token}`;
      const k = getApiKey();
      if (k) headers["X-API-Key"] = k;
      const res = await fetch(base + path, { headers });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          msg = j.message || j.error || msg;
        } catch (_) { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `erp_export_${jobId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExportDownloading(false);
    }
  }

  useEffect(() => {
    const jobId = result?.mode === "async_export" ? result?.asyncExport?.jobId : null;
    if (!jobId || !auth?.token) {
      setExportPoll(null);
      return;
    }
    let cancelled = false;
    let timer;
    async function tick() {
      try {
        const job = await pollExportJob(jobId);
        if (cancelled || !job) return;
        if (job.status === "completed" || job.status === "failed") return;
        timer = setTimeout(tick, 3000);
      } catch (_) {
        if (!cancelled) timer = setTimeout(tick, 5000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [result?.mode, result?.asyncExport?.jobId, auth?.token]);

  const [feedbackError, setFeedbackError] = useState('');

  async function sendFeedback(correct, correction) {
    const q   = result?._question || question;
    const sql = result?.sql || result?.generatedSql || '';
    if (!q) return;
    setFeedbackError('');
    try {
      await apiFetch('/api/rag/feedback', {
        method: 'POST',
        token: auth?.token,
        body: {
          question: q, sql, correct,
          correctedSql: correction || undefined,
          note: `Feedback from ${userEmail || 'user'} on ${new Date().toISOString().slice(0,10)}`,
        },
      });
      if (correct) {
        setFeedbackStatus('good');
      } else if (correction) {
        setFeedbackStatus('good');
        setCorrectedSql('');
      } else {
        setFeedbackStatus('correcting');
      }
    } catch (e) {
      setFeedbackError(e.message || 'Feedback could not be saved');
      console.warn('[feedback]', e.message);
    }
  }

  /* ── SQL Templates: server-side storage (shared across all users/devices) ── */
  const [sqlTemplates,    setSqlTemplates]    = useState([]);
  const [tplsLoading,     setTplsLoading]     = useState(true);
  const [tplsError,       setTplsError]       = useState('');
  const [showTplModal,    setShowTplModal]     = useState(false);
  const [tplName,         setTplName]         = useState('');
  const [tplSql,          setTplSql]          = useState('');
  const [tplDesc,         setTplDesc]         = useState('');
  const [tplEditId,       setTplEditId]       = useState(null); // null = new, string id = edit existing
  const [tplSaving,       setTplSaving]       = useState(false);
  /** Only Manager and Admin may create/edit/delete shared SQL templates (server enforces when RBAC is on). */
  const canTrainAi = auth?.role === "admin" || auth?.role === "manager";

  /* Load AI query history from server (replaces localStorage) */
  useEffect(() => {
    if (!auth?.token) return;
    apiFetch('/api/ai/history', { token: auth.token })
      .then(d => { if (Array.isArray(d)) setHistory(d); })
      .catch(() => {
        // Graceful fallback: migrate any existing localStorage history to server
        try {
          const local = JSON.parse(localStorage.getItem("erp_ai_history") || "[]");
          if (local.length) {
            setHistory(local);
            // Migrate each entry to server
            local.forEach(q => apiFetch('/api/ai/history', { method: 'POST', token: auth.token, body: { query: q } }).catch(() => {}));
            localStorage.removeItem("erp_ai_history");
          }
        } catch {}
      });
  }, [auth?.token]);

  /* Load templates from server (re-fetch when auth token changes) */
  useEffect(() => {
    let cancelled = false;
    setTplsLoading(true);
    setTplsError('');
    apiFetch('/api/sql-templates', { token: auth?.token })
      .then((raw) => {
        if (cancelled) return;
        let list = [];
        if (raw != null && typeof raw === 'object' && Array.isArray(raw.templates)) {
          list = raw.templates;
        } else if (Array.isArray(raw)) {
          list = raw;
        }
        setSqlTemplates(list);
      })
      .catch((e) => {
        if (!cancelled) setTplsError(e && e.message ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setTplsLoading(false);
      });
    return () => { cancelled = true; };
  }, [auth?.token]);

  function openNewTplModal() {
    if (!canTrainAi) return;
    setTplName(''); setTplSql(''); setTplDesc(''); setTplEditId(null);
    setShowTplModal(true);
  }

  function openEditTplModal(tpl) {
    if (!canTrainAi) return;
    if (!tpl) return;
    setTplName(tpl.name); setTplSql(tpl.sql); setTplDesc(tpl.desc || '');
    setTplEditId(tpl.id); setShowTplModal(true);
  }

  async function saveTplModal() {
    if (!canTrainAi) return;
    if (!tplName.trim() || !tplSql.trim()) return;
    setTplSaving(true);
    try {
      if (tplEditId) {
        const d = await apiFetch(`/api/sql-templates/${tplEditId}`, {
          method: 'PUT', token: auth.token, body: { name: tplName.trim(), sql: tplSql.trim(), desc: tplDesc.trim() },
        });
        const updated = d != null && typeof d === 'object' ? d.template : null;
        if (!updated || !updated.id) throw new Error('Invalid server response (missing template)');
        setSqlTemplates((prev) => prev.map((t) => (t.id === tplEditId ? updated : t)));
      } else {
        const d = await apiFetch('/api/sql-templates', {
          method: 'POST', token: auth.token, body: { name: tplName.trim(), sql: tplSql.trim(), desc: tplDesc.trim() },
        });
        const created = d != null && typeof d === 'object' ? d.template : null;
        if (!created || !created.id) throw new Error('Invalid server response (missing template)');
        setSqlTemplates((prev) => [created, ...prev]);
      }
      setShowTplModal(false);
    } catch (e) { setTplsError('Save failed: ' + e.message); }
    finally { setTplSaving(false); }
  }

  async function deleteTpl(tpl) {
    if (!canTrainAi) return;
    if (!window.confirm(`Delete template "${tpl.name}"?`)) return;
    try {
      await apiFetch(`/api/sql-templates/${tpl.id}`, { method: 'DELETE', token: auth.token });
      setSqlTemplates(prev => prev.filter(t => t.id !== tpl.id));
    } catch (e) { setTplsError('Delete failed: ' + e.message); }
  }

  /* Run a saved SQL template as if typed in the AI query box */
  async function runSqlTemplate(tpl) {
    setQuestion(tpl.name);
    if (result) {
      const snap = result;
      setChatMessages(prev => [...prev, { id: snap._ts || Date.now(), question: snap._question || tpl.name, result: snap, ts: snap._ts || Date.now() }]);
    }
    setResult(null); setError(''); setConversation([]);
    setLoading(true);
    const abortCtl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let _timeoutId;
    if (abortCtl) {
      _timeoutId = setTimeout(() => abortCtl.abort(), AI_QUERY_CLIENT_TIMEOUT_MS);
    }
    try {
      const body = { question: tpl.name, rawSql: tpl.sql };
      if (totals) body.includeTotals = true;
      const data = await apiFetch('/api/query/adaptive', {
        method: 'POST', token: auth.token, body,
        signal: abortCtl ? abortCtl.signal : undefined,
      });
      if (data?.clarificationNeeded) { setError(data.clarificationQuestion || 'Needs clarification.'); return; }
      setResult({ ...data, _question: tpl.name, _ts: Date.now(), _confidence: 'high', _isSqlTemplate: true });
      addHistory(tpl.name);
    } catch (err) {
      setError(err.name === 'AbortError' ? 'Query timed out. Try a narrower date range.' : err.message);
    } finally {
      if (_timeoutId) clearTimeout(_timeoutId);
      setAiProgress(prev => ({ ...prev, pct: 100 }));
      setLoading(false);
    }
  }

  /* Save the current result's SQL as a new template */
  function saveCurrentSqlAsTemplate() {
    if (!canTrainAi) return;
    const sql = result?.sql || result?.generatedSql || '';
    if (!sql) return;
    setTplName(result?._question || '');
    setTplSql(sql);
    setTplDesc('');
    setTplEditId(null);
    setShowTplModal(true);
  }

  useEffect(() => { if (initialContext) setContext(initialContext); }, [initialContext?.table]);

  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    setAiProgress({ step: 0, pct: 8, startedAt });
    const t = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      let step = 0;
      for (let i = AI_PROGRESS_STEPS.length - 1; i >= 0; i--) {
        if (elapsed >= AI_PROGRESS_STEPS[i].atMs) { step = i; break; }
      }
      const pct = Math.min(92, Math.max(8, Math.floor(8 + (elapsed / 55000) * 84)));
      setAiProgress(prev => (prev.step === step && prev.pct === pct ? prev : { ...prev, step, pct }));
    }, 220);
    return () => clearInterval(t);
  }, [loading]);

  // Auto-scroll conversation to bottom when new messages arrive
  useEffect(() => {
    if (followEndRef.current) followEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [conversation]);

  // Auto-scroll to new result when it arrives
  useEffect(() => {
    if (result && chatBottomRef.current) chatBottomRef.current.scrollIntoView({ behavior: "smooth" });
  }, [result]);

  function addHistory(q) {
    // Optimistic local update
    setHistory(prev => [q, ...prev.filter(x => x !== q)].slice(0, 20));
    // Persist to server (per-user, cross-device)
    apiFetch('/api/ai/history', { method: 'POST', token: auth?.token, body: { query: q } }).catch(() => {});
  }

  // Run a brand-new SQL query (optional tableHintOverride from suggestion chips)
  async function run(q, tableHintOverride) {
    q = (q || question).trim();
    if (!q) { setError("Enter a question first."); return; }
    setAiProgress({ step: 0, pct: 8, startedAt: Date.now() });
    setActiveQuestion(q);
    // Archive completed turn before starting a new one (keep prior Q, not the new text)
    if (result?._question) {
      const snap = result;
      setChatMessages(prev => [
        ...prev,
        {
          id: snap._ts || Date.now(),
          question: snap._question,
          result: snap,
          ts: snap._ts || Date.now(),
        },
      ]);
    }
    setLoading(true); setError(""); setClarificationUi(null); setResult(null); setConversation([]); setFeedbackStatus(null); setCorrectedSql(''); setFeedbackError('');
    const abortCtl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const _timeoutId = abortCtl
      ? setTimeout(() => abortCtl.abort(), AI_QUERY_CLIENT_TIMEOUT_MS)
      : null;

    function augmentQuestionWithPickerDates(qStr) {
      const q0 = String(qStr || "").trim();
      if (!q0) return q0;
      if (parseFromToDateRange(q0)) return q0;
      const from = normalizeDateToDMY(queryFromDate);
      const to = normalizeDateToDMY(queryToDate);
      if (!from || !to) return q0;
      return (
        `${q0} Limit results to transaction dates from ${from} through ${to} inclusive ` +
        `(dd.mm.yyyy; use InvoiceDt on dbo.VwAISalesData or the date column listed for the chosen view).`
      );
    }

    const qForApi = augmentQuestionWithPickerDates(q);

    try {
      const sig = abortCtl ? abortCtl.signal : undefined;
      // Single deterministic pipeline: no mode branching in UI.
      const salesIntent = detectSalesDashboardIntent(q);
      if (salesIntent) {
        const cfg = await apiFetch("/api/connector-config", { token: auth.token, signal: sig });
        const salesDataset = (cfg?.datasets || []).find(d =>
          /sales|invoice|vwai/i.test(d.key) || /sales|invoice/i.test(d.objectName)
        ) || cfg?.datasets?.[0];
        if (!salesDataset) throw new Error("Sales dataset is not configured.");

        const explicitRange = parseFromToDateRange(q);
        const fromManual = normalizeDateToDMY(queryFromDate);
        const toManual = normalizeDateToDMY(queryToDate);
        const range = (fromManual && toManual)
          ? { from: fromManual, to: toManual }
          : (explicitRange || getPeriodRange(salesIntent === "custom" ? "today" : salesIntent));

        const params = new URLSearchParams({ limit: '2000', from: range.from, to: range.to });
        const flatPromise = apiFetch(
          `/api/dataset/${encodeURIComponent(salesDataset.key)}?${params}`,
          { token: auth.token, signal: sig, timeoutMs: ERP_DATASET_TIMEOUT_MS }
        ).then(d => Array.isArray(d) ? d : []).catch(() => []);

        const analyticsPromise = fetchSalesAnalyticsForPeriod({
          token: auth.token,
          period: salesIntent,
          fromDMY: range.from,
          toDMY: range.to,
          loadPhase: 'widgets',
          signal: sig,
        }).catch(() => null);

        const [dataRows, analytics] = await Promise.all([flatPromise, analyticsPromise]);

        const keys = dataRows.length ? Object.keys(dataRows[0]) : [];
        const preferred = ['MrpValue', 'SaleNetAmount', 'NetAmount', 'Amount', 'SalesAmount', 'Revenue', 'Total', 'Value'];
        const valueCol = preferred.find(p => keys.some(k => k.toLowerCase() === p.toLowerCase()))
          || keys.find(k => /amount|net|sale|revenue|total|value|mrp/i.test(k) && isNumericCol(dataRows, k))
          || keys.find(k => isNumericCol(dataRows, k))
          || 'MrpValue';
        const dateCol = keys.find(k => /^xndt$/i.test(k))
          || keys.find(k => /invoicedt|xndt|date|dt|day|created/i.test(k))
          || null;

        const k = analytics?.kpi || {};
        const w = analytics?.widgets || {};
        const branchAiRows = w.byBranch?.rows || [];
        const deptAiRows = w.byDepartment?.rows || [];
        const catAiRows = w.byCategory?.rows || [];
        const trendAiRows = w.byTrend?.rows || [];
        const kpiTotal = parseFloat(k.totalSales) || 0;
        const kpiTxCount = parseInt(String(k.txnCount), 10) || 0;

        setSdDrill({});
        setSdBarAxis("vertical");
        setResult({
          _question: q,
          _ts: Date.now(),
          rowCount: dataRows.length,
          data: dataRows,
          // Provenance for sales dashboard path
          intentType: 'period_dashboard',
          intentDescription: `Period-scoped sales dashboard (${salesIntent?.toUpperCase()})`,
          chartPolicy: 'line',
          dataSource: 'full_aggregate',
          contractPassed: true,
          contractIssues: [],
          contractWarnings: [],
          columnTags: {},
          salesDashboard: {
            period: salesIntent,
            from: range.from,
            to: range.to,
            valueCol,
            dateCol,
            branchAiRows,
            deptAiRows,
            catAiRows,
            trendAiRows,
            kpiTotal,
            kpiTxCount,
          },
          summary: `Showing ${(salesIntent === 'custom' ? 'CUSTOM RANGE' : salesIntent.toUpperCase())} sales — Branch, Department ✨, Category ✨ charts below.`,
          sql: null,
        });
        addHistory(q);
        return;
      }

      const body = { question: qForApi };
      const th = tableHintOverride || context?.table;
      if (th) body.tableHint = th;
      if (totals) body.includeTotals = true;
      // Pass picker dates as structured fields so the agentic engine gets them as userDateRange
      if (queryFromDate) body.fromDate = queryFromDate;
      if (queryToDate)   body.toDate   = queryToDate;
      if (queryMode === "langgraph") body.forceMode = "langgraph";
      body.provider = aiProvider; // "openai" | "claude"

      // Pass last 3 completed Q→SQL pairs so the intent compiler has multi-turn context
      const recentHistory = chatMessages.slice(-3).map(m => ({
        question: m.question,
        sql: m.result?.sql || "",
        summary: m.result?.answer || m.result?.interpretation || "",
      }));
      if (recentHistory.length > 0) body.conversationHistory = recentHistory;

      const data = await apiFetch("/api/query/adaptive", {
        method: "POST",
        token: auth.token,
        body,
        signal: abortCtl ? abortCtl.signal : undefined,
      });

      if (data?.clarificationNeeded) {
        // [] is truthy in JS — explicitly fall through to clarificationOptions when suggestedOptions is empty
        const rawChips =
          (Array.isArray(data.suggestedOptions) && data.suggestedOptions.length ? data.suggestedOptions : null) ||
          (Array.isArray(data.clarificationOptions) && data.clarificationOptions.length ? data.clarificationOptions : null) ||
          [];
        setClarificationUi({
          message: data.clarificationQuestion || "I need more details to answer that query.",
          chips: rawChips,
          picker: data.dimensionPicker || null,
          uiType: data.uiType || "SUGGESTION_CHIPS",
          originalQuestion: q,  // preserve original question so chips can refine it
        });
        setError("");
        return;
      }
      setClarificationUi(null);
      const normalizedResult = {
        ...data,
        _question: q,
        _ts: Date.now(),
        _confidence: data?._confidence || data?.confidence || "high",
        _confidenceNote: data?._confidenceNote || data?.confidenceNote || "",
        _retryCount: Number.isFinite(Number(data?.retryCount)) ? Number(data.retryCount) : 0,
      };
      setResult(normalizedResult);
      addHistory(q);
    } catch (err) {
      const name = err && err.name;
      if (name === "AbortError") {
        setError(
          `Query timed out after ${Math.round(AI_QUERY_CLIENT_TIMEOUT_MS / 1000)}s. ` +
            "Use summaries (e.g. supplier-wise category mix this month), a shorter date range, or ask to export raw rows as CSV."
        );
      } else {
        setError(err.message);
      }
    }
    finally {
      if (_timeoutId) clearTimeout(_timeoutId);
      setAiProgress(prev => ({ ...prev, pct: 100 }));
      setLoading(false);
    }
  }

  // Send a follow-up analytical question about the existing result
  async function sendFollowUp() {
    const q = followUp.trim();
    if (!q || !result) return;
    setFollowUp("");
    setConversation(prev => [...prev, { role: "user", text: q }]);
    setFollowLoad(true);
    try {
      const body = {
        question: q,
        contextData: {
          previousQuestion: result._question || "",
          previousSQL:      result.sql || "",
          data:             result.data || [],
        },
      };
      const resp = await apiFetch("/api/query/adaptive", { method: "POST", token: auth.token, body });
      // Server returns { type: "analysis", answer } for follow-ups
      const answer = resp.answer || resp.summary || JSON.stringify(resp);
      setConversation(prev => [...prev, { role: "ai", text: answer }]);
    } catch (err) {
      setConversation(prev => [...prev, { role: "ai", text: "⚠️ " + err.message }]);
    } finally { setFollowLoad(false); }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-800">✨ AI Query</h2>
          <p className="text-sm text-slate-500 mt-0.5">Ask in plain English — AI builds T-SQL, runs it, and charts the results.</p>
        </div>
        {(chatMessages.length > 0 || result) && (
          <button
            type="button"
            onClick={() => { setChatMessages([]); setResult(null); setActiveQuestion(""); setConversation([]); setError(""); setClarificationUi(null); setFeedbackStatus(null); }}
            className="btn-ghost text-xs py-1.5 px-3 flex-shrink-0"
            title="Clear all chat history"
          >
            🗑 Clear chat
          </button>
        )}
      </div>

      {context && (
        <div className="flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-sm text-indigo-700 fade-in">
          <span>🔍 Context: <strong>{context.label}</strong></span>
          <button onClick={() => setContext(null)} className="ml-auto text-indigo-400 hover:text-indigo-700">✕</button>
        </div>
      )}

      <div className="card p-5 space-y-3">
        <textarea value={question} onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => { if (e.ctrlKey && e.key === "Enter") run(); }}
          rows={3} placeholder="e.g. Top 10 products by total sales this month…"
          className="input-base resize-none font-mono text-sm leading-relaxed" />

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-slate-500">Mode:</span>
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
            <button
              onClick={() => { setQueryMode("deterministic"); try { localStorage.setItem("erp_ai_mode","deterministic"); } catch {} }}
              className={`px-3 py-1.5 transition-colors ${queryMode === "deterministic" ? "bg-indigo-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
            >⚡ Deterministic</button>
            <button
              onClick={() => { setQueryMode("langgraph"); try { localStorage.setItem("erp_ai_mode","langgraph"); } catch {} }}
              className={`px-3 py-1.5 border-l border-slate-200 transition-colors ${queryMode === "langgraph" ? "bg-violet-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
            >🦜 Adaptive Agent</button>
          </div>
          <span className="text-xs text-slate-400">
            {queryMode === "langgraph"
              ? "Schema RAG → business dictionary → intent plan → SQL → self-healing retry (AskYourDatabase-style)"
              : "Fast templates for common KPIs — use Adaptive Agent for free-form plain English"}
          </span>
        </div>

        {/* ── AI Provider toggle ─────────────────────────────────────── */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-slate-500">AI:</span>
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
            <button
              onClick={() => { setAiProvider("openai"); try { localStorage.setItem("erp_ai_provider","openai"); } catch {} }}
              title="OpenAI GPT-5"
              className={`px-3 py-1.5 flex items-center gap-1 transition-colors ${aiProvider === "openai" ? "bg-emerald-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
            ><span>⚙️</span> GPT-5</button>
            <button
              onClick={() => { setAiProvider("claude"); try { localStorage.setItem("erp_ai_provider","claude"); } catch {} }}
              title="Claude Sonnet 4.6 by Anthropic"
              className={`px-3 py-1.5 border-l border-slate-200 flex items-center gap-1 transition-colors ${aiProvider === "claude" ? "bg-orange-500 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
            ><span>🔶</span> Claude</button>
          </div>
          <span className="text-xs text-slate-400">
            {aiProvider === "claude"
              ? "Claude Sonnet 4.6 (Anthropic) — extended reasoning, very high accuracy"
              : "OpenAI GPT-5 — fast, reliable, context-aware"}
          </span>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-500">From</span>
            <input
              type="date"
              value={queryFromDate}
              onChange={e => setQueryFromDate(e.target.value)}
              className="input-base text-xs"
              title="From date (optional)"
            />
            <span className="text-xs font-semibold text-slate-500">To</span>
            <input
              type="date"
              value={queryToDate}
              onChange={e => setQueryToDate(e.target.value)}
              className="input-base text-xs"
              title="To date (optional)"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
            <input type="checkbox" checked={totals} onChange={e => setTotals(e.target.checked)} className="rounded accent-indigo-600" />
            Add totals row
          </label>
          <button onClick={() => run()} disabled={loading} className="btn-primary justify-center sm:justify-start">
            {loading ? <><Spinner size={14} color="white"/>{AI_PROGRESS_STEPS[aiProgress.step]?.label || "Running…"}</> : "✨ Ask AI"}
          </button>
        </div>
      </div>

      {error && <Alert type="error" msg={error} onClose={() => setError("")} />}

      {clarificationUi && (
        <div
          className="rounded-xl border p-4 mb-4"
          style={{ borderColor: "var(--brand,#6366f1)", background: "rgba(99,102,241,0.04)" }}
        >
          <div className="flex items-start gap-2 mb-3">
            <span className="text-lg">🤔</span>
            <p className="text-sm font-semibold leading-relaxed" style={{ color: "var(--text,#0f172a)" }}
              dangerouslySetInnerHTML={{ __html:
                (clarificationUi.message || "").replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
              }}
            />
          </div>
          {clarificationUi.chips.length > 0 && (
            <p className="text-xs mb-2 font-medium" style={{ color: 'var(--text-muted,#64748b)' }}>
              👆 Click a button below to run that query instantly:
            </p>
          )}
          {clarificationUi.chips.length === 0 && (
            <p className="text-xs mb-2" style={{ color: 'var(--text-muted,#64748b)' }}>
              ✏️ Type your specific question in the box above and click <strong>✨ Ask AI</strong>.
            </p>
          )}
          {clarificationUi.picker && Array.isArray(clarificationUi.picker.options) && (
            <div className="flex flex-wrap gap-2 mb-2">
              {clarificationUi.picker.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className="text-xs font-semibold px-3 py-2 rounded-lg border"
                  style={{ borderColor: "var(--brand,#6366f1)", color: "var(--brand,#6366f1)" }}
                  onClick={() => {
                    const base = clarificationUi.originalQuestion || question.trim() || "sales";
                    const qNext = `${base} for ${opt}`.replace(/\s+/g, " ").trim();
                    setQuestion(qNext);
                    setClarificationUi(null);
                    run(qNext);
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {(clarificationUi.chips || []).map((chip, i) => {
              const label = chip.label || chip.term || String(chip);
              const text = chip.text || chip.term || label;
              return (
                <button
                  key={chip.id || i}
                  type="button"
                  className="text-xs font-semibold px-4 py-2 rounded-lg transition-all hover:opacity-90 active:scale-95"
                  style={{
                    background: "var(--brand,#6366f1)",
                    color: "#fff",
                    boxShadow: "0 1px 4px rgba(99,102,241,0.3)",
                    border: "none",
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    const orig = clarificationUi.originalQuestion || "";
                    const refined = orig ? `${orig} — ${text}` : text;
                    setQuestion(refined);
                    setClarificationUi(null);
                    run(refined);
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              className="text-xs px-2 py-1 rounded"
              style={{ color: 'var(--text-muted,#64748b)', cursor: 'pointer', background: 'transparent', border: 'none' }}
              onClick={() => setClarificationUi(null)}
            >
              Dismiss ✕
            </button>
          </div>
        </div>
      )}

      {/* Current turn: question → loading → answer (session history is below) */}
      {(activeQuestion || loading) && (
        <div className="space-y-3">
          {activeQuestion ? <QuestionBubble text={activeQuestion} ts={result?._ts} /> : null}
          {loading && (
            <div className="card p-4 fade-in" style={{ borderLeft: "4px solid #6366f1" }}>
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-sm font-semibold text-slate-700">Running AI query…</p>
                <p className="text-xs font-semibold text-indigo-600">{aiProgress.pct}%</p>
              </div>
              <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "rgba(99,102,241,0.14)" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${aiProgress.pct}%`, background: "linear-gradient(90deg,#6366f1,#8b5cf6)" }}
                />
              </div>
              <p className="text-xs mt-2.5" style={{ color: "var(--text-muted)" }}>
                {AI_PROGRESS_STEPS[aiProgress.step]?.label || "Processing request"}…
              </p>
            </div>
          )}
        </div>
      )}
      {result && (
        <div className="space-y-4 fade-in" ref={chatBottomRef}>

          {/* Plain-English answer first */}
          {result.summary && (
            <div className="card p-4" style={{
              borderLeft: `4px solid ${
                result._confidence === 'low'    ? '#ef4444' :
                result._confidence === 'medium' ? '#f59e0b' : '#10b981'
              }`
            }}>
              {/* Header row: label + confidence badge + re-run button */}
              <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:6, flexWrap:'wrap'}}>
                <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wide" style={{margin:0}}>Plain-English Answer</p>
                {result._confidence && (
                  <span style={{
                    fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20,
                    background: result._confidence === 'low'    ? '#fee2e2' :
                                result._confidence === 'medium' ? '#fef9c3' : '#dcfce7',
                    color:      result._confidence === 'low'    ? '#dc2626' :
                                result._confidence === 'medium' ? '#ca8a04' : '#16a34a',
                  }}>
                    {result._confidence === 'high' ? '✅ Verified' :
                     result._confidence === 'medium' ? '⚠️ Check numbers' : '❌ Low confidence'}
                  </span>
                )}
                {result._confidenceNote && (
                  <span style={{fontSize:11, color:'var(--text-muted)', fontStyle:'italic'}}>
                    {result._confidenceNote}
                  </span>
                )}
                {Number(result._retryCount || 0) > 0 && (
                  <span style={{
                    fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20,
                    background:'#e0f2fe', color:'#0369a1',
                  }}>
                    🔁 {result._retryCount} retry{result._retryCount > 1 ? 'ies' : ''}
                  </span>
                )}
                <button
                  style={{
                    marginLeft:'auto', fontSize:11, padding:'3px 10px', borderRadius:8,
                    border:'1px solid var(--border)', background:'var(--surface2)',
                    color:'var(--text-muted)', cursor:'pointer', fontWeight:600,
                  }}
                  onClick={() => run(result._question)}
                  title="Re-run the same query to verify consistency"
                >
                  🔄 Re-verify
                </button>
              </div>
              <div
                className="text-sm text-slate-700 leading-relaxed"
                style={{ lineHeight: '1.65' }}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(localizeWesternUnitsToIndian(result.summary)) }}
              />
              <p className="text-[11px] mt-2" style={{color:'var(--text-muted)'}}>
                Monetary display unit is Lakhs (value ÷ 10^5) for amount/value fields.
              </p>
              {Array.isArray(result.interpretation?.chips) && result.interpretation.chips.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5" title="How the deterministic engine read your question">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 shrink-0">Interpreted</span>
                  {result.interpretation.chips.map((chip, i) => (
                    <span
                      key={i}
                      className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-600"
                    >{chip}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── KPI stat cards — ALWAYS first, regardless of query type ── */}
          {result.data && result.data.length > 0 && <StatsBar rows={result.data} />}

          {result.salesDashboard && (() => {
            const dash = result.salesDashboard;
            const allRows = Array.isArray(result.data) ? result.data : [];
            const { valueCol, dateCol, period, branchAiRows: dashBranchAiRows, deptAiRows: dashDeptRows, catAiRows: dashCatRows, trendAiRows: dashTrendAiRows } = dash;

            const drill = sdDrill;
            const barAxis = sdBarAxis;
            const drillRows = allRows.filter(r => {
              return Object.entries(drill).every(([k, v]) => String(r[k] ?? '') === String(v));
            });
            const sourceRows = drillRows.length ? drillRows : allRows;

            const pillStyle = (on) => ({
              fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999, border: 'none',
              background: on ? 'var(--brand,#2563eb)' : 'var(--bg-muted,#f1f5f9)',
              color: on ? '#fff' : 'var(--text-muted,#64748b)', cursor: 'pointer'
            });

            const clickFilter = (col) => (p) => {
              const label = String(p?.name ?? '').trim();
              if (!label) return;
              setSdDrill((dr) => {
                const next = { ...dr };
                if (next[col] === label) delete next[col];
                else next[col] = label;
                return next;
              });
            };

            // Branch chart rows — prefer AI full-range rows, fallback to sampled flat rows
            const branchRows = (() => {
              if (dashBranchAiRows?.length) {
                const labelCol = pickAILabelCol(dashBranchAiRows, 'branch');
                const valCol   = pickAIValueCol(dashBranchAiRows);
                return dashBranchAiRows
                  .map(r => ({ label: String(r[labelCol] ?? ''), _v: parseFloat(r[valCol]) || 0 }))
                  .filter(r => r.label && !isJunkGroupKey(r.label) && r._v > 0)
                  .sort((a, b) => b._v - a._v).slice(0, 30)
                  .map(r => ({ label: r.label, SaleNetAmount: r._v }));
              }
              const branchOpt = GROUP_OPTIONS.find(g => g.key === 'branch');
              const branchCol = valueCol ? resolveGroupCol(sourceRows, branchOpt) : null;
              return (branchCol && valueCol)
                ? aggregateBy(sourceRows, branchCol, valueCol).slice(0, 20).map(r => ({ label: r.label, [valueCol]: r.value }))
                : [];
            })();

            // Trend rows (prefer AI full-period trend, fallback to sampled flat rows)
            const dateRows = (() => {
              if (period === "today") return [];
              if (dashTrendAiRows?.length) {
                const keys = Object.keys(dashTrendAiRows[0]);
                const labelCol = keys.find(k => /date|month|day|saledate|salemonth/i.test(k)) || keys[0];
                const salesCol = keys.find(k => /totalsales|saleamount|salenetamount|netsales/i.test(k))
                  || keys.find(k => /sales|amount|net|revenue/i.test(k) && !/count/i.test(k))
                  || keys[1];
                const invoiceCountCol = keys.find(k => /invoicecount|invoice.*count/i.test(k));
                const customerCountCol = keys.find(k => /customercount|customer.*count/i.test(k));
                if (!labelCol || !salesCol) return [];
                return dashTrendAiRows
                  .filter(r => r[labelCol] != null)
                  .map(r => {
                    const row = { label: String(r[labelCol]), TotalSales: parseFloat(r[salesCol]) || 0 };
                    if (invoiceCountCol) row.InvoiceCount = parseFloat(r[invoiceCountCol]) || 0;
                    if (customerCountCol) row.CustomerCount = parseFloat(r[customerCountCol]) || 0;
                    return row;
                  });
              }
              if (!valueCol || !dateCol) return [];
              return (period === "mtd" || period === "custom"
                ? aggregateByDate(sourceRows, dateCol, valueCol).map(r => ({ label: r.label, [valueCol]: r.value }))
                : aggregateByMonth(sourceRows, dateCol, valueCol).map(r => ({ label: r.label, [valueCol]: r.value })));
            })();

            const trendValueCols = dateRows.length > 0
              ? (dateRows[0]?.TotalSales != null
                ? [
                    'TotalSales',
                    ...(dateRows[0]?.InvoiceCount != null ? ['InvoiceCount'] : []),
                    ...(dateRows[0]?.CustomerCount != null ? ['CustomerCount'] : []),
                  ]
                : [valueCol])
              : [];

            // Dept AI rows
            const deptChartRows = (() => {
              if (!dashDeptRows?.length) return [];
              const labelCol = pickAILabelCol(dashDeptRows, 'dept');
              const valCol   = pickAIValueCol(dashDeptRows);
              return dashDeptRows
                .map(r => ({ label: String(r[labelCol] ?? ''), _v: parseFloat(r[valCol]) || 0 }))
                .filter(r => r.label && !isJunkGroupKey(r.label) && r._v > 0)
                .sort((a, b) => b._v - a._v).slice(0, 20)
                .map(r => ({ label: r.label, SaleNetAmount: r._v }));
            })();

            // Cat AI rows
            const catChartRows = (() => {
              if (!dashCatRows?.length) return [];
              const labelCol = pickAILabelCol(dashCatRows, 'cat');
              const valCol   = pickAIValueCol(dashCatRows);
              return dashCatRows
                .map(r => ({ label: String(r[labelCol] ?? ''), _v: parseFloat(r[valCol]) || 0 }))
                .filter(r => r.label && !isJunkGroupKey(r.label) && r._v > 0)
                .sort((a, b) => b._v - a._v).slice(0, 20)
                .map(r => ({ label: r.label, SaleNetAmount: r._v }));
            })();

            const noFlatData = !valueCol || allRows.length === 0;
            const hasAny = branchRows.length > 0 || deptChartRows.length > 0 || catChartRows.length > 0 || dateRows.length > 0;

            if (!hasAny && noFlatData) return (
              <div className="card p-4" style={{ borderLeft:'4px solid #2563eb' }}>
                <p className="text-sm font-bold mb-1" style={{color:'var(--text-strong)'}}>Sales Dashboard View ({dash.from} → {dash.to})</p>
                <p className="text-sm py-3 text-center" style={{color:'var(--text-muted)'}}>No sales data for this period ({dash.from} → {dash.to})</p>
              </div>
            );

            return (
              <div className="card p-4 space-y-4" style={{ borderLeft:'4px solid #2563eb' }}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-sm font-bold" style={{color:'var(--text-strong)'}}>Sales Dashboard View ({dash.from} → {dash.to})</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button style={pillStyle(barAxis === "auto")} onClick={() => setSdBarAxis("auto")}>Axis: Auto</button>
                    <button style={pillStyle(barAxis === "vertical")} onClick={() => setSdBarAxis("vertical")}>Cat on X</button>
                    <button style={pillStyle(barAxis === "horizontal")} onClick={() => setSdBarAxis("horizontal")}>Cat on Y</button>
                    {Object.keys(drill).length > 0 && (
                      <button style={pillStyle(true)} onClick={() => setSdDrill({})}>Clear filters ✕</button>
                    )}
                  </div>
                </div>

                {/* Trend chart — non-Today periods */}
                {dateRows.length > 0 && (
                  <ChartWithToggle
                    rows={dateRows}
                    labelCol="label"
                    valueCols={trendValueCols}
                    title={trendValueCols.includes('CustomerCount')
                      ? 'Trend — Sales, Invoice Count & Customer Count'
                      : trendValueCols.includes('InvoiceCount')
                        ? 'Trend — Sales & Invoice Count'
                        : 'Trend'}
                    icon="📅"
                  />
                )}

                {/* Branch chart */}
                {branchRows.length > 0 && (
                  <ChartWithToggle
                    rows={branchRows}
                    labelCol="label"
                    valueCols={pickChartValueCols(branchRows, valueCol)}
                    title="Sales by Branch"
                    icon="🏬"
                  />
                )}

                {/* Dept chart — from AI rows */}
                {deptChartRows.length > 0 && (
                  <ChartWithToggle
                    rows={deptChartRows}
                    labelCol="label"
                    valueCols={['SaleNetAmount']}
                    title="Sales by Department ✨"
                    icon="🏢"
                  />
                )}

                {/* Category chart — from AI rows */}
                {catChartRows.length > 0 && (
                  <ChartWithToggle
                    rows={catChartRows}
                    labelCol="label"
                    valueCols={['SaleNetAmount']}
                    title="Sales by Category ✨"
                    icon="🏷️"
                  />
                )}

                {!hasAny && (
                  <p className="text-sm py-3 text-center" style={{color:'var(--text-muted)'}}>
                    No sales data for this period ({dash.from} → {dash.to})
                  </p>
                )}
              </div>
            );
          })()}

          {/* ── Provenance + Intent badge ──────────────────────────────── */}
          {(result.intentType || result.dataSource) && (() => {
            const intentColors = {
              trend:            { bg: '#eff6ff', border: '#bfdbfe', color: '#1d4ed8', icon: '📈' },
              ranking:          { bg: '#f0fdf4', border: '#bbf7d0', color: '#15803d', icon: '🏆' },
              top_n:            { bg: '#f0fdf4', border: '#bbf7d0', color: '#15803d', icon: '🏆' },
              breakdown:        { bg: '#fdf4ff', border: '#e9d5ff', color: '#7e22ce', icon: '📊' },
              distribution:     { bg: '#fdf4ff', border: '#e9d5ff', color: '#7e22ce', icon: '📊' },
              kpi:              { bg: '#fff7ed', border: '#fed7aa', color: '#c2410c', icon: '🎯' },
              aov:              { bg: '#fefce8', border: '#fde68a', color: '#92400e', icon: '🧾' },
              period_dashboard: { bg: '#f0fdfa', border: '#99f6e4', color: '#0f766e', icon: '📅' },
              generic:          { bg: '#f8fafc', border: '#e2e8f0', color: '#475569', icon: '🔍' },
            };
            const c = intentColors[result.intentType] || intentColors.generic;
            const sourceLabel = result.dataSource === 'full_aggregate' ? '✅ Full aggregate' : '⚠️ Sample fallback';
            return (
              <div style={{
                display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
                padding: '7px 12px', borderRadius: 10,
                background: c.bg, border: `1px solid ${c.border}`,
              }}>
                <span style={{ fontSize: 13 }}>{c.icon}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: c.color, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Intent: {result.intentType || 'generic'}
                </span>
                {result.intentDescription && (
                  <span style={{ fontSize: 11, color: '#64748b' }}>— {result.intentDescription}</span>
                )}
                <span style={{
                  marginLeft: 'auto', fontSize: 11, fontWeight: 600,
                  color: result.dataSource === 'full_aggregate' ? '#059669' : '#d97706',
                }}>
                  {sourceLabel}
                </span>
                {result.chartPolicy && result.chartPolicy !== 'auto' && (
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>
                    · Chart: {result.chartPolicy}
                  </span>
                )}
              </div>
            );
          })()}

          {/* ── Contract validation warnings ───────────────────────────── */}
          {result.contractWarnings && result.contractWarnings.length > 0 && (
            <div style={{
              borderRadius: 10, border: '1px solid #fde68a', background: '#fffbeb',
              padding: '10px 14px',
            }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>⚠️ Data Quality Notice</p>
              {result.contractWarnings.map((w, i) => (
                <p key={i} style={{ fontSize: 12, color: '#78350f', marginBottom: 2 }}>• {w}</p>
              ))}
            </div>
          )}

          {/* ── Contract hard-fail (chart blocked) ────────────────────── */}
          {result.contractPassed === false && result.contractIssues && result.contractIssues.length > 0 && (
            <div style={{
              borderRadius: 10, border: '1px solid #fca5a5', background: '#fef2f2',
              padding: '10px 14px',
            }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: '#b91c1c', marginBottom: 4 }}>
                ❌ Chart blocked — result doesn't match expected format
              </p>
              {result.contractIssues.map((issue, i) => (
                <p key={i} style={{ fontSize: 12, color: '#7f1d1d', marginBottom: 2 }}>• {issue}</p>
              ))}
              <p style={{ fontSize: 11, color: '#b91c1c', marginTop: 6 }}>
                The data table is still shown below. Try rephrasing your question or check the SQL.
              </p>
            </div>
          )}

          {/* ── Auto-retry badges ──────────────────────────────────────── */}
          {result.retried && !result.contractRetried && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <span>⚡ Auto-corrected SQL error — query was retried and succeeded.</span>
            </div>
          )}
          {result.contractRetried && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              <span>✅ Output contract enforced — query was auto-regenerated to match the expected format.</span>
            </div>
          )}

          {/* ── Agentic provenance badge ───────────────────────────────── */}
          {result._agenticTurns && (
            <div style={{
              display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
              padding: '7px 12px', borderRadius: 10,
              background: '#f0fdf4', border: '1px solid #86efac',
            }}>
              <span style={{ fontSize: 13 }}>🤖</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#15803d', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Agentic Mode
              </span>
              <span style={{ fontSize: 11, color: '#64748b' }}>
                — AI explored your live schema in {result._agenticTurns} turn{result._agenticTurns !== 1 ? 's' : ''}
              </span>
              {result._agenticTools && result._agenticTools.length > 0 && (() => {
                const toolCounts = result._agenticTools.reduce((acc, t) => {
                  const name = (t.name || t.function?.name || t).replace(/_/g, ' ');
                  acc[name] = (acc[name] || 0) + 1;
                  return acc;
                }, {});
                return (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#15803d', fontWeight: 600 }}>
                    {Object.entries(toolCounts).map(([name, count]) =>
                      count > 1 ? `${name} ×${count}` : name
                    ).join(' · ')}
                  </span>
                );
              })()}
            </div>
          )}

          {/* ── Background CSV export ──────────────────────────────────── */}
          {result.mode === "async_export" && result.asyncExport && (() => {
            const jobId = result.asyncExport.jobId;
            const st = exportPoll?.status || result.asyncExport.status || "queued";
            const statusLabel = { queued: "Queued", running: "Writing CSV…", completed: "Ready", failed: "Failed" }[st] || st;
            const ready = st === "completed";
            const failed = st === "failed";
            return (
            <div className="card p-4 border-l-4" style={{ borderLeftColor: "#2563eb", background: "#eff6ff" }}>
              <p className="text-sm font-bold text-blue-900 mb-1">Background export</p>
              <p className="text-xs text-blue-800 mb-2">
                {result.summary || "Large raw extracts run outside the chat timeout."}{" "}
                Up to {(result.asyncExport.maxRows || exportPoll?.maxRows || 0).toLocaleString("en-IN")} rows.
              </p>
              <p className="text-xs text-slate-600 mb-2">
                Status: <span className="font-semibold">{statusLabel}</span>
                {exportPoll?.rowCount > 0 ? ` · ${exportPoll.rowCount.toLocaleString("en-IN")} rows written` : ""}
                {failed && exportPoll?.error ? ` — ${exportPoll.error}` : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-ghost text-xs py-1 px-3"
                  onClick={() => pollExportJob(jobId).catch((e) => setError(e.message))}>
                  Refresh status
                </button>
                <button type="button" className="btn-primary text-xs py-1 px-3"
                  disabled={!ready || exportDownloading}
                  onClick={() => downloadExportCsv(jobId).catch((e) => setError(e.message))}>
                  {exportDownloading ? "Downloading…" : ready ? "Download CSV" : "Download when ready"}
                </button>
              </div>
            </div>
            );
          })()}

          {/* ── RAG verified fast path ─────────────────────────────────── */}
          {result.mode === "rag_verified" && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8,
              padding: '7px 12px', borderRadius: 10,
              background: '#ecfdf5', border: '1px solid #6ee7b7',
            }}>
              <span style={{ fontSize: 13 }}>✅</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#047857', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                RAG verified SQL
              </span>
              <span style={{ fontSize: 11, color: '#64748b' }}>
                — ran approved example directly (no AI generation)
                {result.ragMatch ? ` · ${result.ragMatch} match` : ""}
              </span>
            </div>
          )}

          {/* ── LangGraph provenance badge ─────────────────────────────── */}
          {(result.mode === "langgraph" || result.mode === "deterministic_langgraph_fallback" || (result._langchainNodes && result._langchainNodes.length > 0)) && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8,
              padding: '7px 12px', borderRadius: 10,
              background: '#faf5ff', border: '1px solid #c4b5fd',
            }}>
              <span style={{ fontSize: 13 }}>🦜</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {result.mode === "langgraph" ? "Adaptive Agent" : "Adaptive Fallback"}
              </span>
              <span style={{ fontSize: 11, color: '#64748b' }}>
                {result.mode === "langgraph"
                  ? "— schema RAG → intent → SQL → execution with auto-retry"
                  : `— ${(result._langchainNodes || []).length} node${(result._langchainNodes || []).length !== 1 ? 's' : ''} executed`}
                {(result._langchainRetries > 0) && ` · ${result._langchainRetries} retry${result._langchainRetries !== 1 ? 's' : ''}`}
              </span>
              {result.confidence && (
                <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600,
                  color: result.confidence === 'high' ? '#16a34a' : result.confidence === 'medium' ? '#d97706' : '#dc2626' }}>
                  {result.confidence === 'high' ? '✅' : result.confidence === 'medium' ? '⚠️' : '❌'} {result.confidence} confidence
                </span>
              )}
            </div>
          )}

          {/* Chart — only if data is chartable and contract passed */}
          {result.data && result.data.length > 1 && !result.salesDashboard && result.contractPassed !== false && (
            <SmartChart
              key={`ai-result-${result._ts || 0}`}
              rows={result.data}
              label="AI Result Chart"
              chartPolicyHint={result.chartPolicy}
              columnTags={result.columnTags}
            />
          )}

          {/* SQL toggle */}
          {result.sql && (
            <div>
              <button onClick={() => setShowSQL(!showSQL)} className="btn-ghost text-xs flex items-center gap-1.5">
                {showSQL ? "▼" : "▶"} {showSQL ? "Hide" : "Show"} generated SQL
              </button>
              {showSQL && (
                <div className="mt-2 rounded-xl overflow-hidden fade-in" style={{background:'#0f172a'}}>
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
                    <p className="text-xs font-semibold text-slate-400">Generated SQL</p>
                    <CopyBtn text={result.sql} />
                  </div>
                  <pre className="text-xs text-emerald-400 p-4 overflow-auto leading-relaxed">{result.sql}</pre>
                </div>
              )}
            </div>
          )}

          {/* Zero-rows guidance */}
          {result.data && result.data.length === 0 && !(() => {
            const sd = result.salesDashboard;
            if (!sd) return false;
            return !!(sd.branchAiRows?.length || sd.deptAiRows?.length || sd.catAiRows?.length || sd.trendAiRows?.length || sd.kpiTotal > 0);
          })() && (
            <div style={{
              padding:'14px 16px', borderRadius:12, border:'1px solid #fde68a',
              background:'#fffbeb', display:'flex', flexDirection:'column', gap:8,
            }}>
              <p style={{fontWeight:700, fontSize:13, color:'#92400e', margin:0}}>⚠️ No data returned</p>
              <p style={{fontSize:12, color:'#78350f', margin:0}}>Common reasons and fixes:</p>
              <ul style={{fontSize:12, color:'#78350f', margin:0, paddingLeft:18, lineHeight:1.7}}>
                <li><strong>Date range too narrow</strong> — try widening the From/To dates, or remove the date filter</li>
                <li><strong>Filter value mismatch</strong> — branch/category names are case-sensitive in the DB (e.g. "SAREES" not "Sarees")</li>
                <li><strong>Wrong time period</strong> — "this week" or "this month" may have no transactions yet</li>
                <li><strong>Try rephrasing</strong> — e.g. "total sales last 30 days" instead of "this month"</li>
              </ul>
              <button
                onClick={() => run(result._question)}
                style={{
                  alignSelf:'flex-start', fontSize:12, padding:'5px 14px', borderRadius:8,
                  border:'1px solid #d97706', background:'#fef3c7',
                  color:'#92400e', cursor:'pointer', fontWeight:700,
                }}
              >
                🔄 Retry with different wording
              </button>
            </div>
          )}

          {/* Data table */}
          {result.data && result.data.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2.5 flex-wrap gap-2">
                <p className="text-xs font-semibold text-slate-500">{result.rowCount ?? result.data.length} row(s) returned</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <DriveSaveBtn
                    label="☁ Drive CSV"
                    filename="ai_result.csv"
                    mimeType="text/csv"
                    buildBlob={() => {
                      const rows = result.data || [];
                      if (!rows.length) return new Blob([""], { type: "text/csv" });
                      const h = Object.keys(rows[0]);
                      const lines = [h.join(","), ...rows.map(r => h.map(k => {
                        const v = String(r[k] ?? "").replace(/"/g, '""');
                        return v.includes(",") || v.includes("\n") || v.includes('"') ? `"${v}"` : v;
                      }).join(","))];
                      return new Blob([lines.join("\n")], { type: "text/csv" });
                    }}
                  />
                  <DriveXLSXBtn rows={result.data} filename="ai_result.xlsx" sheetName="AI Result" />
                  <ExportXLSX rows={result.data} filename="ai_result.xlsx" sheetName="AI Result" />
                  <ExportCSV rows={result.data} filename="ai_result.csv" />
                </div>
              </div>
              <DataTable rows={result.data} />
            </div>
          )}

          {/* ── Follow-up conversation ─────────────────────────────── */}
          <div className="card p-4 space-y-3" style={{borderLeft:'4px solid #6366f1'}}>
            <p className="text-xs font-bold text-indigo-500 uppercase tracking-wide">💬 Ask about this data</p>
            <p className="text-xs text-slate-500">
              Explains or interprets only the <strong>rows in the table above</strong> — it does not run new SQL.
              For rankings, different date ranges, or fixes to a bad result, use <strong>✨ Ask AI</strong> above again.
            </p>

            {/* Chat thread */}
            {conversation.length > 0 && (
              <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                {conversation.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-indigo-600 text-white rounded-br-md"
                        : "bg-slate-100 text-slate-800 rounded-bl-md"
                    }`}>
                      {msg.role === "ai" && <span className="text-xs font-semibold text-indigo-500 block mb-0.5">AI Analysis</span>}
                      {msg.role === "ai"
                        ? <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }} />
                        : msg.text}
                    </div>
                  </div>
                ))}
                {followLoading && (
                  <div className="flex justify-start">
                    <div className="bg-slate-100 rounded-2xl rounded-bl-md px-4 py-3 text-sm text-slate-500 flex items-center gap-2">
                      <Spinner size={12} color="#6366f1" /> Thinking…
                    </div>
                  </div>
                )}
                <div ref={followEndRef} />
              </div>
            )}

            {/* Follow-up input */}
            <div className="flex gap-2">
              <input
                value={followUp}
                onChange={e => setFollowUp(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFollowUp(); } }}
                placeholder="e.g. What does this table show? Any duplicate labels?"
                className="input-base text-sm flex-1 py-2"
                disabled={followLoading}
              />
              <button
                onClick={sendFollowUp}
                disabled={followLoading || !followUp.trim()}
                className="btn-primary px-4 py-2 text-sm"
                title="Send follow-up (Enter)"
              >
                {followLoading ? <Spinner size={13} color="white" /> : "Send"}
              </button>
            </div>

            {conversation.length > 0 && (
              <button onClick={() => setConversation([])} className="btn-ghost text-xs text-slate-400">
                Clear conversation
              </button>
            )}
          </div>
        </div>
      )}


      {chatMessages.length > 0 && (
        <div className="space-y-2 mt-4">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Earlier in this session</p>
          {[...chatMessages].reverse().map(msg => (
            <div key={msg.id} className="rounded-xl border overflow-hidden fade-in"
              style={{ background: "var(--bg-card,#fff)", borderColor: "var(--border,#e2e8f0)" }}>
              <QuestionBubble text={msg.question} ts={msg.ts} />
              <div className="flex items-center gap-3 px-4 py-2 border-t" style={{ borderColor: "var(--border,#e2e8f0)" }}>
                <span className="text-xs flex-1" style={{ color: "var(--text-muted,#64748b)" }}>
                  {msg.result?.summary
                    ? (() => { const t = stripMarkdown(msg.result.summary); return t.length > 120 ? t.slice(0, 117) + "…" : t; })()
                    : msg.result?.data?.length
                      ? `${msg.result.data.length} row(s) returned`
                      : "Completed"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const prev = msg.result;
                    if (result) {
                      setChatMessages(msgs => msgs.map(m => (m.id === msg.id ? { ...m, result } : m)));
                    } else {
                      setChatMessages(msgs => msgs.filter(m => m.id !== msg.id));
                    }
                    setActiveQuestion(msg.question);
                    setResult(prev);
                    setConversation([]);
                    setFeedbackStatus(null);
                  }}
                  className="text-xs font-medium flex-shrink-0"
                  style={{ color: "#6366f1", background: "none", border: "none", cursor: "pointer", padding: "2px 6px", borderRadius: 6 }}
                >
                  Restore ↩
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── SQL Templates section ──────────────────────────────────────── */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <p className="text-xs font-bold text-slate-700 uppercase tracking-wider">📋 Saved SQL Queries</p>
            <a
              href="/rag-guide.html"
              target="_blank"
              rel="noopener noreferrer"
              title="How to use SQL Templates &amp; RAG Memory — opens guide"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 18, height: 18, borderRadius: '50%',
                background: '#e0e7ff', color: '#4f46e5',
                fontSize: 11, fontWeight: 800, textDecoration: 'none', flexShrink: 0,
              }}
            >?</a>
          </div>
          {canTrainAi ? (
            <button
              type="button"
              onClick={openNewTplModal}
              className="btn-ghost text-xs py-1 px-3"
              title="Create a new named SQL template"
            >+ New Template</button>
          ) : (
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide" title="Ask a Manager or Admin to edit saved queries">
              View-only
            </span>
          )}
        </div>

        {tplsError && (
          <p className="text-xs text-red-500 mb-2">⚠ {tplsError}</p>
        )}
        {tplsLoading ? (
          <p className="text-xs text-slate-400 italic">Loading saved queries…</p>
        ) : sqlTemplates.length === 0 ? (
          <p className="text-xs text-slate-400 italic">
            No saved queries yet.{' '}
            {canTrainAi ? (
              <>
                <button type="button" className="text-indigo-500 underline" onClick={openNewTplModal}>
                  Create one
                </button>{' '}
                — paste your SQL + give it a name, and it appears here as a one-click chip.
              </>
            ) : (
              <>Managers and Admins can create shared templates.</>
            )}
            <span className="block mt-1 text-slate-300">Templates are shared across all users and devices.</span>
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {sqlTemplates.map((tpl) => (
              <div key={tpl.id} className="flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 overflow-hidden">
                <button
                  type="button"
                  title={tpl.desc || tpl.sql.slice(0, 120)}
                  onClick={() => runSqlTemplate(tpl)}
                  style={{
                    fontSize: 12, fontWeight: 600, color: '#3730a3',
                    padding: '4px 12px', background: 'transparent', border: 'none', cursor: 'pointer',
                  }}
                >
                  {tpl.name.length > 40 ? tpl.name.slice(0, 37) + '…' : tpl.name}
                </button>
                {canTrainAi && (
                  <>
                    <button
                      type="button"
                      title="Edit template"
                      onClick={(e) => { e.stopPropagation(); openEditTplModal(tpl); }}
                      style={{ fontSize: 11, padding: '2px 6px 2px 0', background: 'none', border: 'none', cursor: 'pointer', color: '#6366f1' }}
                    >✏️</button>
                    <button
                      type="button"
                      title="Delete template"
                      onClick={(e) => { e.stopPropagation(); deleteTpl(tpl); }}
                      style={{ fontSize: 11, padding: '2px 8px 2px 0', background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}
                    >✕</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Show "Save current result as template" when SQL is available */}
        {canTrainAi && result && (result.sql || result.generatedSql) && (
          <button
            type="button"
            onClick={saveCurrentSqlAsTemplate}
            className="mt-3 text-xs text-indigo-600 font-medium underline hover:text-indigo-800"
          >
            💾 Save this query's SQL as a template
          </button>
        )}

        {/* ── Inline feedback (👍/👎) — trains AI from this result ── */}
        {result && !loading && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
            {feedbackError ? (
              <p className="text-xs text-red-600 mb-2">{feedbackError}</p>
            ) : null}
            {feedbackStatus === 'good' ? (
              <p className="text-xs text-emerald-600 font-medium">
                ✅ Thanks!{(result?.sql || result?.generatedSql) ? ' AI has learned from this SQL.' : ' Feedback recorded.'}
              </p>
            ) : feedbackStatus === 'correcting' ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-600">Paste the correct SQL below so the AI learns from it:</p>
                <textarea
                  className="input-base text-xs font-mono w-full"
                  rows={4}
                  placeholder="SELECT ... FROM dbo.VW_MB_POWERBI_SLSXNS_REPORT ..."
                  value={correctedSql}
                  onChange={e => setCorrectedSql(e.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => sendFeedback(false, correctedSql)}
                    disabled={!correctedSql.trim()}
                    className="btn-primary text-xs px-3 py-1"
                    style={{ fontSize: 11 }}
                  >
                    Save Correction
                  </button>
                  <button
                    type="button"
                    onClick={() => setFeedbackStatus(null)}
                    className="text-xs text-slate-500 underline"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">Was this answer correct?</span>
                <button
                  type="button"
                  onClick={() => sendFeedback(true)}
                  className="text-xs font-medium px-2 py-1 rounded-md hover:bg-emerald-50 text-emerald-700 border border-emerald-200"
                  title="Correct — AI will remember this"
                >
                  👍 Yes
                </button>
                <button
                  type="button"
                  onClick={() => sendFeedback(false)}
                  className="text-xs font-medium px-2 py-1 rounded-md hover:bg-red-50 text-red-600 border border-red-200"
                  title="Wrong — teach the AI the correct SQL"
                >
                  👎 No, fix it
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── SQL Template modal ─────────────────────────────────────────── */}
      {showTplModal && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center"
          style={{ background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)' }}
          onClick={() => setShowTplModal(false)}
        >
          <div
            className="card p-5 space-y-3 w-full max-w-lg mx-4"
            style={{ borderRadius: 18 }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ background: 'linear-gradient(135deg,#4f46e5,#7c3aed)', borderRadius: 12, padding: '14px 18px', marginBottom: 8 }}>
              <h3 className="text-white font-bold text-sm">{tplEditId !== null ? '✏️ Edit SQL Template' : '📋 New SQL Template'}</h3>
              <p className="text-indigo-200 text-xs mt-1">Give it a name and paste your SQL. Click the chip to run it instantly.</p>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Template Name *</label>
              <input
                type="text"
                value={tplName}
                onChange={e => setTplName(e.target.value)}
                placeholder="e.g. Top 5 Purchase Orders"
                className="input-base text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">SQL Query *</label>
              <textarea
                value={tplSql}
                onChange={e => setTplSql(e.target.value)}
                placeholder={"SELECT TOP 5\n  InvoiceNo, BranchAlias, SaleNetAmount\nFROM dbo.VwAISalesData\nORDER BY SaleNetAmount DESC"}
                rows={7}
                className="input-base font-mono text-xs resize-y"
                spellCheck={false}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1 block">Description (optional)</label>
              <input
                type="text"
                value={tplDesc}
                onChange={e => setTplDesc(e.target.value)}
                placeholder="Short description shown on hover"
                className="input-base text-sm"
              />
            </div>

            <div className="flex gap-2 justify-end pt-1">
              <button type="button" onClick={() => setShowTplModal(false)} className="btn-ghost text-xs py-2 px-4">Cancel</button>
              <button
                type="button"
                onClick={saveTplModal}
                disabled={!tplName.trim() || !tplSql.trim() || tplSaving}
                className="btn-primary text-xs py-2 px-5"
              >
                {tplSaving ? 'Saving…' : tplEditId !== null ? 'Update' : 'Save Template'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Suggestions — live from RAG store, falls back to static list */}
      <div>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2.5">
          💡 Suggestions
          {dynamicSuggestions.some(s => s.rag) && (
            <span className="ml-2 text-[9px] font-semibold text-indigo-400 uppercase tracking-wider">✦ AI-Learned</span>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {dynamicSuggestions.map(s => {
            const text = s.q || s;
            return (
              <button key={text} type="button" onClick={() => { setQuestion(text); run(text, s.hint); }} className="chip">
                {text.length > 50 ? text.slice(0, 47) + "…" : text}
              </button>
            );
          })}
        </div>
      </div>

      {history.length > 0 && (
        <div>
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2.5">🕐 Recent</p>
          <div className="flex flex-wrap gap-2">
            {history.map(h => (
              <button key={h} onClick={() => { setQuestion(h); run(h); }} className="chip max-w-xs overflow-hidden text-ellipsis whitespace-nowrap">
                {h.length > 55 ? h.slice(0, 52) + "…" : h}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
