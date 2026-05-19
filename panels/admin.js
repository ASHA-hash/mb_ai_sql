/* ═══════════════════════════════════════════════
   ADMIN PANEL  (tabbed: Users/Roles | System Settings)
═══════════════════════════════════════════════ */
const ADMIN_TABS = [
  { key: "users",    label: "👤 Users & Roles" },
  { key: "settings", label: "⚙️ System Settings" },
];

function AdminPanel({ auth }) {
  const initialTab = (() => {
    try {
      const t = new URLSearchParams(window.location.search).get("tab");
      return t === "settings" ? "settings" : "users";
    } catch { return "users"; }
  })();
  const [activeTab, setActiveTab]   = useState(initialTab);
  const [users, setUsers]           = useState([]);
  const [roles, setRoles]           = useState({});
  const [storageInfo, setStorageInfo] = useState(null); // { mode, bootstrapped }
  const [loading, setLoading]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [msg, setMsg]               = useState(null);
  const [showAdd, setShowAdd]       = useState(false);
  const [pwdModal, setPwdModal]     = useState(null);
  const [newUser, setNewUser]       = useState({ email: "", name: "", role: "viewer", password: "" });
  const [semanticText, setSemanticText]   = useState("");
  const [semanticSaving, setSemanticSaving] = useState(false);

  async function fetchUsers() {
    setLoading(true);
    try {
      const d = await apiFetch("/api/admin/users", { token: auth.token });
      setUsers(d.users || []);
      setRoles(d.roles || {});
      if (d.storageMode || d.storageBackend) {
        const mode = d.storageMode || (d.storageBackend === "postgresql" ? "pg" : "file");
        setStorageInfo({
          mode,
          bootstrapped: d.bootstrapped,
          databaseConfigured: !!d.databaseConfigured,
        });
      }
    } catch (e) { setMsg({ type: "error", text: e.message }); }
    finally { setLoading(false); }
  }

  useEffect(() => { fetchUsers(); }, []);

  async function fetchSemanticDictionary() {
    try {
      const d = await apiFetch("/api/admin/semantic-dictionary", { token: auth.token });
      setSemanticText(JSON.stringify(d, null, 2));
    } catch (e) {
      setMsg({ type: "error", text: `Semantic dictionary load failed: ${e.message}` });
    }
  }

  useEffect(() => { fetchSemanticDictionary(); }, []);

  async function saveUsers(updated) {
    setSaving(true); setMsg(null);
    try {
      await apiFetch("/api/admin/users", { method: "POST", token: auth.token,
        body: { users: updated.map(u => ({ email: u.email, role: u.role, name: u.name || "" })) } });
      setUsers(updated);
      setMsg({ type: "ok", text: "Users saved." });
    } catch (e) { setMsg({ type: "error", text: e.message }); }
    finally { setSaving(false); }
  }

  function changeRole(email, role) { setUsers(prev => prev.map(u => u.email === email ? { ...u, role } : u)); }

  async function deleteUser(email) {
    if (!confirm(`Remove user ${email}?`)) return;
    await saveUsers(users.filter(u => u.email !== email));
  }

  async function addUser(e) {
    e.preventDefault();
    if (!newUser.email || !newUser.role || !newUser.password) { setMsg({ type: "error", text: "Email, role, and password are required." }); return; }
    const createdEmail = newUser.email.trim();
    setSaving(true); setMsg(null);
    try {
      const updated = [...users, { email: createdEmail, name: newUser.name, role: newUser.role }];
      await apiFetch("/api/admin/users", { method: "POST", token: auth.token,
        body: { users: updated.map(u => ({ email: u.email, role: u.role, name: u.name || "" })) } });
      await apiFetch(`/api/admin/users/${encodeURIComponent(createdEmail)}/set-password`, {
        method: "POST", token: auth.token, body: { newPassword: newUser.password } });
      setUsers(updated); setShowAdd(false);
      setNewUser({ email: "", name: "", role: "viewer", password: "" });
      setMsg({ type: "ok", text: `User ${createdEmail} created.` });
    } catch (e) { setMsg({ type: "error", text: e.message }); }
    finally { setSaving(false); }
  }

  async function resetPassword(targetEmail, newPwd) {
    if (!newPwd || newPwd.length < 8) { setMsg({ type: "error", text: "Password must be at least 8 chars." }); return; }
    try {
      await apiFetch(`/api/admin/users/${encodeURIComponent(targetEmail)}/set-password`, {
        method: "POST", token: auth.token, body: { newPassword: newPwd } });
      setPwdModal(null);
      setMsg({ type: "ok", text: `Password reset for ${targetEmail}.` });
    } catch (e) { setMsg({ type: "error", text: e.message }); }
  }

  async function saveSemanticDictionary() {
    setSemanticSaving(true);
    try {
      const parsed = JSON.parse(semanticText || "{}");
      await apiFetch("/api/admin/semantic-dictionary", {
        method: "POST",
        token: auth.token,
        body: parsed,
      });
      setMsg({ type: "ok", text: "Semantic dictionary saved." });
    } catch (e) {
      setMsg({ type: "error", text: `Semantic dictionary save failed: ${e.message}` });
    } finally {
      setSemanticSaving(false);
    }
  }

  const roleKeys = Object.keys(roles);

  return (
    <div className="space-y-5">
      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, borderBottom: "2px solid var(--border-card,#e2e8f0)", paddingBottom: 0 }}>
        {ADMIN_TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: "8px 18px",
              fontWeight: activeTab === t.key ? 700 : 500,
              fontSize: 13,
              border: "none",
              borderBottom: activeTab === t.key ? "2px solid #6366f1" : "2px solid transparent",
              marginBottom: -2,
              background: "transparent",
              color: activeTab === t.key ? "#6366f1" : "var(--text-muted,#64748b)",
              cursor: "pointer",
              borderRadius: "6px 6px 0 0",
              transition: "color 0.15s",
            }}
          >{t.label}</button>
        ))}
      </div>

      {/* System Settings tab */}
      {activeTab === "settings" && <SystemSettingsPanel auth={auth} />}

      {/* Users & Roles tab */}
      {activeTab === "users" && <>
      <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 className="text-xl font-bold text-slate-800">🔑 User Management</h2>
          <p className="text-sm text-slate-500 mt-0.5">Manage login credentials and roles.</p>
          {storageInfo && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6,
              padding: "2px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600,
              background: storageInfo.mode === "pg" ? "#d1fae5" : "#fef3c7",
              color: storageInfo.mode === "pg" ? "#065f46" : "#92400e",
            }}>
              {storageInfo.mode === "pg"
                ? "🐘 PostgreSQL — users & passwords persist across deploys"
                : "⚠️ File mode — set DATABASE_URL on Render so users are not reset on redeploy"}
            </span>
          )}
        </div>
        <button onClick={() => setShowAdd(!showAdd)} className="btn-primary">+ Add user</button>
      </div>

      {msg && <Alert type={msg.type} msg={msg.text} onClose={() => setMsg(null)} />}

      {storageInfo && storageInfo.mode !== "pg" && (
        <div className="card p-4" style={{ borderLeft: "4px solid #f59e0b", background: "#fffbeb" }}>
          <p className="text-sm font-bold text-amber-900">Users reset on redeploy without PostgreSQL</p>
          <p className="text-xs text-amber-800 mt-1 leading-relaxed">
            On Render, link a Postgres database to this web service so <code className="text-[10px]">DATABASE_URL</code> is set.
            Add users and passwords here once — they are stored in <code className="text-[10px]">erp_rbac_users</code> and survive redeploys.
            <code className="text-[10px]">users-config.json</code> is only used for the very first bootstrap.
          </p>
        </div>
      )}

      {showAdd && (
        <form onSubmit={addUser} className="card p-5 space-y-3 fade-in" style={{borderTop:'3px solid #6366f1'}}>
          <p className="text-sm font-bold text-slate-700">New user</p>
          <div className="grid-2col">
            <div><label className="block text-xs font-semibold text-slate-500 mb-1.5">Email</label>
              <input type="email" required value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} className="input-base" placeholder="user@company.com" /></div>
            <div><label className="block text-xs font-semibold text-slate-500 mb-1.5">Name</label>
              <input type="text" value={newUser.name} onChange={e => setNewUser({...newUser, name: e.target.value})} className="input-base" placeholder="Full name" /></div>
            <div><label className="block text-xs font-semibold text-slate-500 mb-1.5">Role</label>
              <select value={newUser.role} onChange={e => setNewUser({...newUser, role: e.target.value})} className="input-base">
                {roleKeys.map(r => <option key={r} value={r}>{r}</option>)}</select></div>
            <div><label className="block text-xs font-semibold text-slate-500 mb-1.5">Password</label>
              <input type="password" required value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} className="input-base" placeholder="Min 8 chars" /></div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="btn-primary">{saving ? "Creating…" : "Create user"}</button>
            <button type="button" onClick={() => setShowAdd(false)} className="btn-ghost">Cancel</button>
          </div>
        </form>
      )}

      {loading
        ? <div className="flex items-center gap-2.5 text-slate-400 text-sm py-6"><Spinner/>Loading users…</div>
        : (
          <div className="card overflow-hidden">
            <div className="table-scroll">
            <table className="w-full text-sm" style={{minWidth:560}}>
              <thead>
                <tr className="text-xs text-slate-400 font-semibold uppercase tracking-wide border-b border-slate-100 bg-slate-50/80">
                  <th className="text-left px-5 py-3.5">Name / Email</th>
                  <th className="text-left px-5 py-3.5">Role</th>
                  <th className="text-left px-5 py-3.5">Features</th>
                  <th className="text-left px-5 py-3.5">Password</th>
                  <th className="px-5 py-3.5"></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => {
                  const rf = roles[u.role]?.features || [];
                  return (
                    <tr key={u.email} className="border-b border-slate-50 hover:bg-slate-50/70 transition-colors last:border-0">
                      <td className="px-5 py-3.5">
                        <p className="font-semibold text-slate-800">{u.name || "—"}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{u.email}</p>
                      </td>
                      <td className="px-5 py-3.5">
                        <select value={u.role} onChange={e => changeRole(u.email, e.target.value)}
                          className="border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                          {roleKeys.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex flex-wrap gap-1">
                          {rf.map(feat => <span key={feat} className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{feat}</span>)}
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`badge ${u.passwordHash ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                          {u.passwordHash ? "Set" : "Not set"}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => setPwdModal({ email: u.email })} className="btn-ghost text-xs px-2.5 py-1.5">Reset pwd</button>
                          {u.email !== auth.email && (
                            <button onClick={() => deleteUser(u.email)}
                              className="text-xs px-2.5 py-1.5 bg-red-50 hover:bg-red-100 rounded-lg text-red-600 border border-red-100 transition-colors">Remove</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>{/* end table-scroll */}
            <div className="px-5 py-3.5 border-t border-slate-100 flex justify-end bg-slate-50/50">
              <button onClick={() => saveUsers(users)} disabled={saving} className="btn-primary">
                {saving ? "Saving…" : "Save role changes"}
              </button>
            </div>
          </div>
        )
      }

      <RoleInfo roles={roles} />
      <div className="card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-slate-700">Semantic Dictionary Governance</p>
          <div className="flex items-center gap-2">
            <button onClick={fetchSemanticDictionary} className="btn-ghost text-xs">Reload</button>
            <button onClick={saveSemanticDictionary} disabled={semanticSaving} className="btn-primary text-xs">
              {semanticSaving ? "Saving…" : "Save dictionary"}
            </button>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Edit metric/dimension mappings used by deterministic AI planning and SQL templates.
        </p>
        <textarea
          value={semanticText}
          onChange={e => setSemanticText(e.target.value)}
          rows={16}
          className="input-base font-mono text-xs"
          placeholder='{"metrics":{},"dimensions":{}}'
        />
      </div>
      {pwdModal && <ResetPwdModal email={pwdModal.email} onConfirm={resetPassword} onClose={() => setPwdModal(null)} />}
      </>}{/* end users tab */}
    </div>
  );
}

function RoleInfo({ roles }) {
  return (
    <div className="card p-5">
      <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Role definitions</p>
      <div className="grid gap-3" style={{gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))'}}>
        {Object.entries(roles).map(([role, def]) => (
          <div key={role} className="bg-slate-50 rounded-xl p-4 border border-slate-100">
            <span className={`badge mb-2 ${ROLE_COLORS_LIGHT[role] || "bg-slate-100 text-slate-700"}`}>{role}</span>
            <p className="text-xs text-slate-500 mb-2">Datasets: {def.datasets === "*" ? "All" : (def.datasets || []).join(", ")}</p>
            <div className="flex flex-wrap gap-1">
              {(def.features || []).map(f => <span key={f} className="text-xs bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded-lg">{f}</span>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResetPwdModal({ email, onConfirm, onClose }) {
  const [pwd, setPwd] = useState("");
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="card w-full max-w-sm p-6 fade-in">
        <h3 className="font-bold text-base mb-0.5 text-slate-800">Reset password</h3>
        <p className="text-xs text-slate-400 mb-4">{email}</p>
        <input type="password" value={pwd} onChange={e => setPwd(e.target.value)}
          placeholder="New password (min 8 chars)"
          className="input-base mb-4" />
        <div className="flex gap-2">
          <button onClick={() => onConfirm(email, pwd)} className="btn-primary flex-1 justify-center">Reset</button>
          <button onClick={onClose} className="btn-ghost flex-1">Cancel</button>
        </div>
      </div>
    </div>
  );
}
