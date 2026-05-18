/* ═══════════════════════════════════════════════
   SETTINGS PANEL
═══════════════════════════════════════════════ */
function SettingsPanel({ auth }) {
  const [apiUrl,        setApiUrl]        = useState(getApiBase());
  const [driveFolderId, setDriveFolderId] = useState(getDriveFolderId());
  const [saved,         setSaved]         = useState(false);
  const [testStatus,    setTestStatus]    = useState(null); // null | "testing" | "ok" | error string

  // Only admin can change the Client ID; viewers/managers can see Drive status
  const isAdmin = auth.role === "admin";

  function save() {
    localStorage.setItem("erp_api_base", apiUrl.trim().replace(/\/+$/, ""));
    localStorage.setItem(DRIVE_FOLDER_ID_KEY, driveFolderId.trim());
    setSaved(true);
    setTestStatus(null);
    setTimeout(() => setSaved(false), 2500);
  }

  async function testDrive() {
    setTestStatus("testing");
    try {
      // Just request a token — if the popup works, we're good
      await getDriveAccessToken();
      setTestStatus("ok");
    } catch (e) {
      setTestStatus(String(e.message || e));
    }
  }

  const driveReady = true;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-800">⚙ Settings</h2>
        <p className="text-sm text-slate-500 mt-0.5">Configure API connection and view session info.</p>
      </div>
      <div className="card p-5 space-y-3">
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1.5">API base URL</label>
          <input type="text" value={apiUrl} onChange={e => setApiUrl(e.target.value)} className="input-base font-mono text-sm" />
          <p className="text-xs text-slate-400 mt-1.5">Changes apply after saving and reloading.</p>
        </div>
        <button onClick={save} className="btn-primary">{saved ? "✓ Saved" : "Save"}</button>
      </div>

      {/* ── Google Drive (per-user OAuth) ──────────────────────────── */}
      <div className="card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-slate-700">☁ Google Drive</p>
          <span className={`badge ${driveReady ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
            {driveReady ? "✓ Configured" : "Not configured"}
          </span>
        </div>

        {/* How it works — always visible */}
        <div className="rounded-xl bg-indigo-50 border border-indigo-100 px-4 py-3 space-y-1">
          <p className="text-xs font-bold text-indigo-700">How it works for users (Managers & Viewers)</p>
          <p className="text-xs text-indigo-600 leading-relaxed">
            When a Manager or Viewer clicks <strong>"☁ My Drive CSV"</strong> or <strong>"☁ My Drive Excel"</strong>,
            a Google sign-in popup opens. They sign in with <strong>their own Google account</strong> and the
            file saves directly to <strong>their personal Google Drive</strong>.
            No separate login or setup is needed for each user.
          </p>
        </div>

        {/* Admin-only: Client ID setup */}
        {isAdmin && (
          <>
            {/* ── CRITICAL WARNING: App Publishing ── */}
            {driveReady && (
              <div className="rounded-xl border-2 border-amber-400 bg-amber-50 px-4 py-3 space-y-2">
                <p className="text-xs font-bold text-amber-800">⚠️ If managers/viewers get "Access blocked" — fix this first</p>
                <p className="text-xs text-amber-700 leading-relaxed">
                  Your OAuth app is in <strong>Testing mode</strong> by default. Only your own Gmail can sign in.
                  Managers and viewers are blocked until you do one of these:
                </p>
                <div className="space-y-2 text-xs text-amber-800">
                  <div className="rounded-lg bg-white border border-amber-200 px-3 py-2">
                    <p className="font-bold text-amber-900 mb-1">Option A — Add each user as a Test User (quick fix)</p>
                    <ol className="list-decimal list-inside space-y-1 text-amber-700">
                      <li>Go to <strong>console.cloud.google.com</strong> → APIs &amp; Services → <strong>OAuth consent screen</strong></li>
                      <li>Scroll down to <strong>Test users</strong> section</li>
                      <li>Click <strong>+ Add users</strong> → add every manager/viewer's Gmail address</li>
                      <li>Save — they can now sign in immediately</li>
                    </ol>
                  </div>
                  <div className="rounded-lg bg-white border border-amber-200 px-3 py-2">
                    <p className="font-bold text-amber-900 mb-1">Option B — Publish the app (best for teams, recommended)</p>
                    <ol className="list-decimal list-inside space-y-1 text-amber-700">
                      <li>Go to <strong>console.cloud.google.com</strong> → APIs &amp; Services → <strong>OAuth consent screen</strong></li>
                      <li>Click <strong>Publish App</strong> → Confirm</li>
                      <li>Since this is an internal company tool, Google does <em>not</em> require verification for <code className="bg-amber-100 px-0.5 rounded font-mono">drive.file</code> scope</li>
                      <li>All Google accounts can now sign in — no list needed</li>
                    </ol>
                  </div>
                </div>
                <p className="text-[10px] text-amber-600">
                  If you see <strong>redirect_uri_mismatch</strong>: add the exact JavaScript origins and redirect URIs listed in the checklist below (especially <code className="bg-amber-100 px-0.5 rounded">postmessage</code>). That is different from &quot;Testing&quot; / test users.
                </p>
              </div>
            )}

            <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-xs text-slate-700 space-y-2">
              <p className="font-bold text-slate-800">Initial setup checklist:</p>
              <ol className="list-decimal list-inside space-y-1.5 text-slate-600">
                <li>Google Cloud Console → APIs &amp; Services → Library → Enable <strong>Google Drive API</strong> ✓</li>
                <li>Credentials → your OAuth 2.0 Client ID → type <strong>Web application</strong><br/>
                  <span className="ml-4 text-slate-500 block mt-1">Authorised JavaScript origins (scheme + host only):</span>
                  <code className="block ml-6 mt-0.5 bg-slate-200 px-2 py-1 rounded font-mono text-[11px] w-fit">{DRIVE_OAUTH_PRIMARY_ORIGIN}</code>
                  <span className="ml-4 text-slate-500 block mt-2">Authorised redirect URIs — add <strong>four</strong> separate entries (copy each line):</span>
                  <code className="block ml-6 mt-1 bg-slate-200 px-2 py-1 rounded font-mono text-[11px] whitespace-pre">postmessage{"\n"}{DRIVE_OAUTH_PRIMARY_ORIGIN}{"\n"}{DRIVE_OAUTH_PRIMARY_ORIGIN + "/"}{"\n"}{DRIVE_OAUTH_PRIMARY_ORIGIN + "/dashboard.html"}</code>
                </li>
                <li>OAuth consent screen → <strong>Publish App</strong> (so all team members can sign in)</li>
                <li>OAuth Web Client ID is fixed in this file — it must be the same client you configure in Google Cloud.</li>
              </ol>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">
                Google OAuth Client ID <span className="font-normal text-slate-400">(fixed in app — matches Google Cloud Web client)</span>
              </label>
              <div className="input-base font-mono text-[11px] bg-slate-50 text-slate-600 cursor-default select-all break-all">
                {DEFAULT_DRIVE_CLIENT_ID}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">
                Default Drive folder ID <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                type="text"
                value={driveFolderId}
                onChange={e => setDriveFolderId(e.target.value)}
                placeholder="Leave blank → saves to root of user's My Drive"
                className="input-base font-mono text-xs"
              />
              <p className="text-xs text-slate-400 mt-1">
                Folder ID = last part of the Drive folder URL: drive.google.com/drive/folders/<strong>THIS_PART</strong>
              </p>
            </div>

            <div className="flex gap-2 flex-wrap">
              <button onClick={save} className="btn-primary">{saved ? "✓ Saved" : "Save"}</button>
              {driveReady && (
                <button onClick={testDrive} disabled={testStatus === "testing"} className="btn-ghost">
                  {testStatus === "testing" ? "Testing…" : "Test Drive connection"}
                </button>
              )}
            </div>

            {testStatus === "ok" && (
              <p className="text-xs text-emerald-600 font-semibold">✅ Your Drive connection works. Now publish the app so managers/viewers can also sign in (see warning above).</p>
            )}
            {testStatus && testStatus !== "ok" && testStatus !== "testing" && (
              <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 space-y-1.5">
                <p className="font-semibold">❌ Connection failed:</p>
                <p>{testStatus}</p>
                {(testStatus.includes("redirect_uri_mismatch") || testStatus.includes("invalid_client") || testStatus.includes("invalid")) && (
                  <div className="text-red-700 space-y-1 whitespace-pre-wrap font-mono text-[10px] leading-relaxed bg-white/80 rounded-lg p-2 border border-red-100">
                    {driveOAuthConsoleHintHtml()}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Non-admin: just show status */}
        {!isAdmin && driveReady && (
          <p className="text-xs text-emerald-600">
            ✅ Google Drive is configured. Click "☁ My Drive CSV" or "☁ My Drive Excel" on any result to save to your personal Drive.
          </p>
        )}
        {!isAdmin && !driveReady && (
          <p className="text-xs text-amber-600">
            ⚠️ Google Drive has not been configured yet. Ask your admin to set it up in Settings.
          </p>
        )}
      </div>

      <div className="card p-5 space-y-3">
        <p className="font-semibold text-slate-700">Session info</p>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-20 flex-shrink-0 text-xs">Name</span>
            <span className="font-medium text-slate-800">{auth.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-20 flex-shrink-0 text-xs">Email</span>
            <span className="text-slate-600">{auth.email}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-20 flex-shrink-0 text-xs">Role</span>
            <span className={`badge ${ROLE_COLORS_LIGHT[auth.role] || "bg-slate-100 text-slate-700"}`}>{auth.role}</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-slate-500 w-20 flex-shrink-0 text-xs mt-0.5">Features</span>
            <div className="flex flex-wrap gap-1">{(auth.features || []).map(f => <span key={f} className="badge bg-slate-100 text-slate-600">{f}</span>)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
