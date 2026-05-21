import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

const API_BASE_KEY = "erp_api_base";

export default function Settings() {
  const { user } = useAuth();
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem(API_BASE_KEY) || "");
  const [saved, setSaved] = useState(false);
  const isAdmin = user?.role === "admin";
  const features = user?.roleDef?.features;
  const featureList = features === "*" ? ["*"] : Array.isArray(features) ? features : [];

  function save() {
    const trimmed = apiUrl.trim().replace(/\/+$/, "");
    if (trimmed) localStorage.setItem(API_BASE_KEY, trimmed);
    else localStorage.removeItem(API_BASE_KEY);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="section-enter space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-800">⚙ Settings</h2>
        <p className="text-sm text-slate-500 mt-0.5">API URL override and session — system limits are in Admin.</p>
      </div>

      {isAdmin && (
        <div className="card p-4" style={{ borderLeft: "4px solid #6366f1", background: "rgba(99,102,241,0.06)" }}>
          <p className="text-sm font-bold text-indigo-900">Data row limit, AI pipeline, analytics tables</p>
          <p className="text-xs text-indigo-800 mt-1 leading-relaxed">
            Use <strong>Admin → System Settings</strong>. Saves to PostgreSQL when configured; otherwise .env defaults
            apply.
          </p>
          <Link to="/admin?tab=settings" className="btn-primary inline-block mt-3 text-sm no-underline">
            Open Admin → System Settings
          </Link>
        </div>
      )}

      <div className="card p-5 space-y-3">
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1.5">API base URL (optional override)</label>
          <input
            type="text"
            value={apiUrl}
            onChange={e => setApiUrl(e.target.value)}
            placeholder="Leave blank to use Vite proxy / same origin"
            className="input-base font-mono text-sm"
          />
          <p className="text-xs text-slate-400 mt-1.5">
            Dev default: Vite proxies <code className="text-[10px]">/api</code> to port 8000. Set only if you host API
            elsewhere.
          </p>
        </div>
        <button type="button" onClick={save} className="btn-primary">
          {saved ? "✓ Saved" : "Save"}
        </button>
      </div>

      <div className="card p-5 space-y-3">
        <p className="font-semibold text-slate-700">☁ Google Drive exports</p>
        <p className="text-sm text-slate-500">
          Drive CSV/Excel from query results is configured in the Node dashboard and Sheets add-on. This React shell uses
          the Python API for data and AI.
        </p>
      </div>

      <div className="card p-5 space-y-3">
        <p className="font-semibold text-slate-700">Session info</p>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-20 flex-shrink-0 text-xs">Name</span>
            <span className="font-medium text-slate-800">{user?.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-20 flex-shrink-0 text-xs">Email</span>
            <span className="text-slate-600">{user?.email}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 w-20 flex-shrink-0 text-xs">Role</span>
            <span className="badge bg-slate-100 text-slate-700">{user?.role}</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-slate-500 w-20 flex-shrink-0 text-xs mt-0.5">Features</span>
            <div className="flex flex-wrap gap-1">
              {featureList.map(f => (
                <span key={f} className="badge bg-slate-100 text-slate-600">
                  {f}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
