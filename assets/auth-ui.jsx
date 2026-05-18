function LoginPage({ onLogin }) {
  const [email,          setEmail]          = useState("");
  const [password,       setPassword]       = useState("");
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState("");
  const [showPwd,        setShowPwd]        = useState(false);

  async function handleEmailLogin(e) {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      const data = await apiFetch("/api/auth/login", { method: "POST", body: { email, password } });
      const session = { token: data.token, email: data.email, role: data.role, name: data.name, features: data.features, firstRun: data.firstRun };
      saveAuth(session); onLogin(session);
    } catch (err) {
      const code = err.data?.error;
      let hint = "";
      if (code === "unknown_user")  hint = " This email isn't in the user list. Ask an admin to add you.";
      else if (code === "wrong_password") hint = " Wrong password. Default is Admin@1234 if no password has been set.";
      setError((err.message || "Login failed.") + hint);
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4"
      style={{background:'var(--bg)', minHeight:'100vh'}}>

      <div className="w-full max-w-sm fade-in">
        {/* Logo / header */}
        <div className="text-center mb-7">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-3"
            style={{background:'linear-gradient(135deg,#6366f1,#8b5cf6)',boxShadow:'0 6px 20px rgba(99,102,241,0.3)'}}>
            <span className="text-white font-black text-2xl leading-none">✦</span>
          </div>
          <h1 className="text-2xl font-black tracking-tight" style={{color:'var(--text-strong)'}}>Smart ERP</h1>
          <p className="text-sm mt-1" style={{color:'var(--text-muted)'}}>Business Intelligence Dashboard</p>
        </div>

        {/* Login card */}
        <div className="rounded-2xl border p-7"
          style={{background:'var(--surface)', borderColor:'var(--border)', boxShadow:'var(--card-shadow, 0 4px 24px rgba(0,0,0,0.07))'}}>

          <p className="text-sm font-semibold mb-5 text-center" style={{color:'var(--text-muted)'}}>Sign in with email</p>

          <form onSubmit={handleEmailLogin} className="space-y-3 fade-in">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{color:'var(--text-muted)'}}>Email address</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus autoComplete="email"
                className="input-base" placeholder="you@company.com"/>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{color:'var(--text-muted)'}}>Password</label>
              <div className="relative">
                <input type={showPwd?"text":"password"} value={password} onChange={e => setPassword(e.target.value)} required
                  autoComplete="current-password" className="input-base pr-14" placeholder="••••••••"/>
                <button type="button" onClick={() => setShowPwd(v=>!v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600 transition-colors">
                  {showPwd?"Hide":"Show"}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
              {loading ? <><Spinner size={14} color="white"/><span>Signing in…</span></> : "Sign in"}
            </button>
          </form>

          {/* Error message */}
          {error && (
            <div className="mt-4 rounded-xl px-3 py-2.5 text-xs text-red-700 flex items-start gap-2 bg-red-50 border border-red-200">
              <span className="flex-shrink-0 mt-0.5">⚠️</span>
              <span className="flex-1">{error}</span>
              <button onClick={() => setError("")} className="opacity-50 hover:opacity-100 flex-shrink-0">✕</button>
            </div>
          )}
        </div>

        <p className="text-center text-xs mt-5 leading-relaxed" style={{color:'var(--text-muted)'}}>
          Smart ERP · Secure business intelligence
        </p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   CHANGE PASSWORD MODAL
═══════════════════════════════════════════════ */
function ChangePasswordModal({ auth, onClose }) {
  const [cur, setCur]   = useState("");
  const [nw, setNw]     = useState("");
  const [nw2, setNw2]   = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg]   = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (nw !== nw2) { setMsg({ type: "error", text: "New passwords do not match." }); return; }
    if (nw.length < 8) { setMsg({ type: "error", text: "Password must be at least 8 characters." }); return; }
    setLoading(true); setMsg(null);
    try {
      await apiFetch("/api/auth/change-password", { method: "POST", token: auth.token, body: { currentPassword: cur, newPassword: nw } });
      setMsg({ type: "ok", text: "Password changed! Please log in again." });
      setTimeout(onClose, 2000);
    } catch (err) { setMsg({ type: "error", text: err.message }); }
    finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="card w-full max-w-sm p-6 fade-in">
        <h2 className="font-bold text-base mb-1 text-slate-800">Change Password</h2>
        <p className="text-xs text-slate-400 mb-5">Update your account password.</p>
        <form onSubmit={submit} className="space-y-3">
          {[["Current password", cur, setCur], ["New password", nw, setNw], ["Confirm new password", nw2, setNw2]].map(([label, val, set]) => (
            <div key={label}>
              <label className="block text-xs font-semibold text-slate-500 mb-1">{label}</label>
              <input type="password" value={val} onChange={e => set(e.target.value)} required className="input-base" />
            </div>
          ))}
          {msg && <Alert type={msg.type} msg={msg.text} />}
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={loading} className="btn-primary flex-1 justify-center">
              {loading ? <><Spinner size={14} color="white"/>Saving…</> : "Change password"}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}


