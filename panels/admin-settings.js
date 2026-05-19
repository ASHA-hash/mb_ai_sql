/* ═══════════════════════════════════════════════════════════════════════════
   SYSTEM SETTINGS PANEL
   Hot-reloadable settings editor.  Reads from GET /api/admin/config,
   writes via POST /api/admin/config, resets via POST /api/admin/config/reset.
   Changes take effect immediately — no server restart except where noted.
═══════════════════════════════════════════════════════════════════════════ */

function ConfigSourceBadge({ source }) {
  const cfg = {
    override: { bg: "#d1fae5", color: "#065f46", label: "admin override" },
    env:      { bg: "#dbeafe", color: "#1e40af", label: ".env" },
    default:  { bg: "#f1f5f9", color: "#64748b", label: "default" },
  }[source] || { bg: "#f1f5f9", color: "#64748b", label: source };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "1px 7px", borderRadius: 999, fontSize: 10, fontWeight: 600,
      background: cfg.bg, color: cfg.color, lineHeight: "18px",
    }}>{cfg.label}</span>
  );
}

function ConfigRestartBadge() {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      padding: "1px 7px", borderRadius: 999, fontSize: 10, fontWeight: 600,
      background: "#fef3c7", color: "#92400e", lineHeight: "18px",
    }}>⟳ restart</span>
  );
}

/** Stable top-level row — must not be defined inside the parent or inputs lose focus on each keystroke. */
function ConfigSettingRow({ s, dirtyValue, isDirty, onChange, onDiscard, onReset }) {
  const val = dirtyValue != null ? dirtyValue : String(s.value ?? "");
  const isOverride = s.source === "override";
  const displaySource = isDirty ? "override" : s.source;

  function renderInput() {
    if (s.type === "toggle") {
      const on = val === "1" || val === "true";
      return (
        <button
          type="button"
          onClick={() => onChange(s.key, on ? "0" : "1")}
          style={{
            position: "relative", display: "inline-flex", alignItems: "center",
            width: 44, height: 24, borderRadius: 999, border: "none",
            background: on ? "#6366f1" : "#cbd5e1",
            cursor: "pointer", transition: "background 0.2s", flexShrink: 0,
          }}
          aria-label={on ? "Enabled" : "Disabled"}
        >
          <span style={{
            position: "absolute",
            left: on ? 22 : 2, width: 20, height: 20,
            borderRadius: "50%", background: "#fff",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
            transition: "left 0.2s",
          }} />
        </button>
      );
    }
    if (s.type === "select") {
      return (
        <select
          value={val}
          onChange={e => onChange(s.key, e.target.value)}
          className="input-base"
          style={{ maxWidth: 160, fontSize: 13 }}
        >
          {(s.options || []).map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );
    }
    if (s.type === "number") {
      return (
        <input
          type="text"
          inputMode="numeric"
          value={val}
          onChange={e => onChange(s.key, e.target.value.replace(/[^\d]/g, ""))}
          onBlur={() => {
            if (!val.trim()) return;
            let n = parseInt(val, 10);
            if (!Number.isFinite(n)) return;
            if (s.min != null) n = Math.max(s.min, n);
            if (s.max != null) n = Math.min(s.max, n);
            if (String(n) !== val) onChange(s.key, String(n));
          }}
          className="input-base"
          style={{ maxWidth: 160, fontSize: 13 }}
          placeholder={s.min != null && s.max != null ? `${s.min}–${s.max}` : "number"}
          aria-label={s.label || s.key}
        />
      );
    }
    if (s.type === "password") {
      return (
        <input
          type="password"
          value={val}
          onChange={e => onChange(s.key, e.target.value)}
          className="input-base"
          style={{ maxWidth: 280, fontSize: 13 }}
          autoComplete="new-password"
          placeholder="••••••••"
        />
      );
    }
    return (
      <input
        type="text"
        value={val}
        onChange={e => onChange(s.key, e.target.value)}
        className="input-base"
        style={{ maxWidth: 320, fontSize: 13 }}
      />
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "6px 12px",
        padding: "14px 0",
        borderBottom: "1px solid var(--border-card, #e2e8f0)",
        background: isDirty ? "rgba(99,102,241,0.04)" : "transparent",
        borderRadius: isDirty ? 6 : 0,
        paddingLeft: isDirty ? 8 : 0,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-primary,#1e293b)" }}>
            {s.label || s.key}
          </span>
          <ConfigSourceBadge source={displaySource} />
          {s.requiresRestart && <ConfigRestartBadge />}
          {isDirty && (
            <span style={{
              padding: "1px 7px", borderRadius: 999, fontSize: 10, fontWeight: 700,
              background: "#ede9fe", color: "#5b21b6", lineHeight: "18px",
            }}>unsaved</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted,#64748b)", marginBottom: 6, lineHeight: 1.4 }}>
          {s.description}
          {(s.min != null && s.max != null) && (
            <span style={{ marginLeft: 6, color: "#94a3b8" }}>
              ({s.min.toLocaleString()} – {s.max.toLocaleString()})
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {renderInput()}
          {(isOverride || isDirty) && (
            <button
              type="button"
              onClick={() => (isDirty ? onDiscard(s.key) : onReset(s.key))}
              style={{
                fontSize: 11, padding: "3px 10px", borderRadius: 6,
                background: "transparent", border: "1px solid #cbd5e1",
                color: "#64748b", cursor: "pointer", whiteSpace: "nowrap",
              }}
              title={isDirty ? "Discard unsaved change" : "Reset to default"}
            >
              {isDirty ? "✕ discard" : "↺ reset"}
            </button>
          )}
        </div>
      </div>
      <div style={{ fontSize: 10, color: "#94a3b8", fontFamily: "monospace", whiteSpace: "nowrap", paddingTop: 2 }}>
        {s.key}
      </div>
    </div>
  );
}

function SystemSettingsPanel({ auth }) {
  const [settings, setSettings]         = useState([]);
  const [storageBackend, setStorage]    = useState(null);   // "postgresql" | "file"
  const [dirty, setDirty]               = useState({});     // key → edited value
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [msg, setMsg]                   = useState(null);
  const [searchQ, setSearchQ]           = useState("");
  const [expandedGroups, setExpandedGroups] = useState({
    dataset: true, ai: true, analytics: true, security: true, performance: false,
  });
  const [importing, setImporting] = useState(false);

  /* ── Load manifest ──────────────────────────────────────────────────── */
  async function loadSettings() {
    setLoading(true);
    try {
      const d = await apiFetch("/api/admin/config", { token: auth.token });
      setSettings(d.settings || []);
      setStorage(d.storageBackend || null);
    } catch (e) {
      setMsg({ type: "error", text: `Failed to load settings: ${e.message}` });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadSettings(); }, []);

  /* ── Helpers ────────────────────────────────────────────────────────── */
  function markDirty(key, val) {
    setDirty(prev => ({ ...prev, [key]: String(val) }));
  }

  function discardDirtyKey(key) {
    setDirty(prev => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  const hasDirty = Object.keys(dirty).length > 0;

  /* ── Save changed keys ──────────────────────────────────────────────── */
  async function saveChanges() {
    if (!hasDirty) return;
    setSaving(true); setMsg(null);
    try {
      const dirtyKeys = Object.keys(dirty);
      const pairs = {};
      for (const [k, v] of Object.entries(dirty)) pairs[k] = v;
      await apiFetch("/api/admin/config", {
        method: "POST",
        token: auth.token,
        body: { settings: pairs },
      });
      await loadSettings();
      setDirty({});
      const needsRestart = settings.filter(s => dirtyKeys.includes(s.key) && s.requiresRestart);
      const warn = needsRestart.length
        ? ` ⚠ ${needsRestart.map(s => s.key).join(", ")} require a server restart.`
        : "";
      setMsg({ type: "ok", text: `Settings saved.${warn}` });
    } catch (e) {
      setMsg({ type: "error", text: `Save failed: ${e.message}` });
    } finally {
      setSaving(false);
    }
  }

  /* ── Reset single key to env/default ───────────────────────────────── */
  async function importFromEnv(force) {
    if (force && !confirm("Overwrite existing admin overrides with values from the server environment (.env / Render env vars)?")) {
      return;
    }
    setImporting(true);
    setMsg(null);
    try {
      let d;
      try {
        d = await apiFetch("/api/admin/config/import-env", {
          method: "POST",
          token: auth.token,
          body: { force: !!force },
        });
      } catch (e) {
        if (!String(e.message || "").includes("404")) throw e;
        d = await apiFetch("/api/admin/config", {
          method: "POST",
          token: auth.token,
          body: { action: "import-env", force: !!force },
        });
      }
      await loadSettings();
      setDirty({});
      setMsg({
        type: "ok",
        text: `Imported ${d.imported || 0} setting(s) from environment into ${d.storageBackend === "postgresql" ? "PostgreSQL" : "file store"}.`,
      });
    } catch (e) {
      setMsg({ type: "error", text: `Import failed: ${e.message}` });
    } finally {
      setImporting(false);
    }
  }

  async function resetKey(key) {
    try {
      await apiFetch("/api/admin/config/reset", {
        method: "POST",
        token: auth.token,
        body: { key },
      });
      setDirty(prev => { const n = { ...prev }; delete n[key]; return n; });
      await loadSettings();
      setMsg({ type: "ok", text: `${key} reset to default.` });
    } catch (e) {
      setMsg({ type: "error", text: `Reset failed: ${e.message}` });
    }
  }

  /* ── Group settings ─────────────────────────────────────────────────── */
  const GROUP_META = {
    dataset:     { label: "Dataset",     icon: "🗄️",  desc: "Row limits and page size for the Data tab (DATASET_HARD_CAP applies immediately)." },
    ai:          { label: "AI / NLQ",    icon: "✨",   desc: "Model selection, fast-path, intent pipeline toggles." },
    analytics:   { label: "Analytics",  icon: "📈",   desc: "Caching, NOLOCK, warmup and table overrides." },
    security:    { label: "Security",   icon: "🔐",   desc: "Default password for users without a hash (per-user passwords in Users tab)." },
    performance: { label: "Performance",icon: "⚡",   desc: "DB pool, timeouts. Most require server restart." },
  };

  const q = searchQ.trim().toLowerCase();
  const filtered = q
    ? settings.filter(s =>
        s.key.toLowerCase().includes(q) ||
        (s.label || "").toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q)
      )
    : settings;

  const byGroup = {};
  for (const s of filtered) {
    const g = s.group || "other";
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(s);
  }

  /* ── Toggle collapse ────────────────────────────────────────────────── */
  function toggleGroup(g) {
    setExpandedGroups(prev => ({ ...prev, [g]: !prev[g] }));
  }

  /* ── Render ─────────────────────────────────────────────────────────── */
  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 200, gap: 12 }}>
        <div className="spinner-sm" />
        <span style={{ color: "var(--text-muted,#64748b)", fontSize: 14 }}>Loading settings…</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 className="text-xl font-bold text-slate-800">⚙️ System Settings</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Hot-reloadable configuration — changes take effect immediately unless marked ⟳ restart.
          </p>
          {storageBackend && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6,
              padding: "2px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600,
              background: storageBackend === "postgresql" ? "#d1fae5" : "#fef3c7",
              color: storageBackend === "postgresql" ? "#065f46" : "#92400e",
            }}>
              {storageBackend === "postgresql" ? "🐘 PostgreSQL — persists across deploys" : "📄 File store — settings reset on redeploy"}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {hasDirty && (
            <span style={{ fontSize: 12, color: "#6366f1", fontWeight: 600 }}>
              {Object.keys(dirty).length} unsaved change{Object.keys(dirty).length !== 1 ? "s" : ""}
            </span>
          )}
          <button
            onClick={saveChanges}
            disabled={!hasDirty || saving}
            className="btn-primary"
            style={{ opacity: hasDirty ? 1 : 0.4 }}
          >
            {saving ? "Saving…" : "💾 Save Changes"}
          </button>
          <button
            onClick={loadSettings}
            className="btn-secondary"
            title="Reload settings from server"
          >
            ↺ Reload
          </button>
          <button
            type="button"
            onClick={() => importFromEnv(false)}
            disabled={importing}
            className="btn-secondary"
            title="Copy server environment into database (skips keys already overridden)"
          >
            {importing ? "Importing…" : "⬇ Import from env"}
          </button>
        </div>
      </div>

      {storageBackend !== "postgresql" && (
        <div className="card p-4" style={{ borderLeft: "4px solid #f59e0b", background: "#fffbeb" }}>
          <p className="text-sm font-bold text-amber-900">Persist settings across redeploys</p>
          <p className="text-xs text-amber-800 mt-1 leading-relaxed">
            Link <strong>PostgreSQL</strong> on Render and set <code className="text-[10px]">DATABASE_URL</code> on this service.
            Then click <strong>Import from env</strong> once — row limits, AI options, and view names are saved in
            <code className="text-[10px]"> erp_runtime_config</code>. API keys remain in Render env only (not shown here).
          </p>
        </div>
      )}

      {msg && <Alert type={msg.type} msg={msg.text} onClose={() => setMsg(null)} />}

      {/* Search */}
      <div style={{ position: "relative", maxWidth: 380 }}>
        <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: 14 }}>🔍</span>
        <input
          type="text"
          placeholder="Search settings…"
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
          className="input-base"
          style={{ paddingLeft: 32, fontSize: 13 }}
        />
      </div>

      {/* Groups */}
      {Object.entries(GROUP_META).map(([groupKey, meta]) => {
        const groupSettings = byGroup[groupKey];
        if (!groupSettings || groupSettings.length === 0) return null;
        const expanded = expandedGroups[groupKey] !== false;
        const overrideCount = groupSettings.filter(s => s.source === "override" || s.key in dirty).length;

        return (
          <div
            key={groupKey}
            className="card"
            style={{ overflow: "hidden", borderTop: "3px solid #6366f1" }}
          >
            {/* Group header */}
            <button
              type="button"
              onClick={() => toggleGroup(groupKey)}
              style={{
                width: "100%", display: "flex", alignItems: "center",
                justifyContent: "space-between", padding: "14px 18px",
                background: "transparent", border: "none", cursor: "pointer",
                textAlign: "left",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 18 }}>{meta.icon}</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-primary,#1e293b)" }}>
                    {meta.label}
                    {overrideCount > 0 && (
                      <span style={{
                        marginLeft: 8, padding: "1px 8px", borderRadius: 999,
                        background: "#ede9fe", color: "#5b21b6", fontSize: 11, fontWeight: 700,
                      }}>{overrideCount} custom</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted,#64748b)" }}>{meta.desc}</div>
                </div>
              </div>
              <span style={{ color: "#94a3b8", fontSize: 16, transition: "transform 0.2s", transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}>▾</span>
            </button>

            {/* Settings rows */}
            {expanded && (
              <div style={{ padding: "0 18px 14px 18px" }}>
                {groupSettings.map(s => (
                  <ConfigSettingRow
                    key={s.key}
                    s={s}
                    dirtyValue={s.key in dirty ? dirty[s.key] : null}
                    isDirty={s.key in dirty}
                    onChange={markDirty}
                    onDiscard={discardDirtyKey}
                    onReset={resetKey}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Empty state */}
      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted,#64748b)" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
          <p>No settings match "{searchQ}"</p>
        </div>
      )}

      {/* Legend */}
      <div className="card p-4" style={{ borderTop: "3px solid #e2e8f0" }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted,#64748b)", marginBottom: 8 }}>LEGEND</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 24px", fontSize: 11, color: "var(--text-muted,#64748b)" }}>
          <span><span style={{ background: "#d1fae5", color: "#065f46", padding: "1px 6px", borderRadius: 999, fontWeight: 700 }}>admin override</span> — saved via this panel, takes priority over .env</span>
          <span><span style={{ background: "#dbeafe", color: "#1e40af", padding: "1px 6px", borderRadius: 999, fontWeight: 700 }}>.env</span> — set in environment file, no override saved yet</span>
          <span><span style={{ background: "#f1f5f9", color: "#64748b", padding: "1px 6px", borderRadius: 999, fontWeight: 700 }}>default</span> — built-in default, no .env or override</span>
          <span><span style={{ background: "#fef3c7", color: "#92400e", padding: "1px 6px", borderRadius: 999, fontWeight: 700 }}>⟳ restart</span> — change needs server restart to apply</span>
        </div>
      </div>
    </div>
  );
}
