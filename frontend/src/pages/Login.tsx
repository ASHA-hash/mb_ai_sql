import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email.trim(), password);
      navigate("/dashboard", { replace: true });
    } catch (err: unknown) {
      setError((err as Error).message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="login-page min-h-[100dvh] flex items-center justify-center px-4 py-8 fade-in overflow-y-auto"
      style={{ background: "var(--bg-app)" }}
    >
      <div className="card w-full max-w-[400px] p-8 soft-pop">
        <div className="text-center mb-8">
          <div
            className="inline-flex w-11 h-11 rounded-xl items-center justify-center text-white font-black text-lg mb-3"
            style={{
              background: "linear-gradient(145deg,#8b5cf6,#7c3aed)",
              boxShadow: "0 4px 14px rgba(124,58,237,0.4)",
            }}
          >
            &#10022;
          </div>
          <div className="sidebar-brand-title text-lg">Smart ERP</div>
          <div className="sidebar-brand-sub mt-1">Sign in to your dashboard</div>
        </div>

        <p className="text-sm font-semibold text-center mb-5" style={{ color: "var(--text-muted)" }}>
          Sign in with email
        </p>

        {error && (
          <div
            className="rounded-xl px-3 py-2.5 mb-4 text-sm font-medium flex items-start gap-2"
            style={{
              background: "rgba(239,68,68,0.12)",
              border: "1px solid rgba(239,68,68,0.35)",
              color: "var(--accent-bad)",
            }}
          >
            <span className="flex-shrink-0">&#x26A0;&#xFE0F;</span>
            <span className="flex-1">{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: "var(--text-muted)" }}>
              Email address
            </label>
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              className="input-base login-input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: "var(--text-muted)" }}>
              Password
            </label>
            <div className="relative">
              <input
                type={showPwd ? "text" : "password"}
                required
                autoComplete="current-password"
                className="input-base login-input pr-16"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter your password"
                aria-label="Password"
              />
              <button
                type="button"
                onClick={() => setShowPwd(v => !v)}
                className="login-pwd-toggle"
                tabIndex={-1}
                aria-label={showPwd ? "Hide password" : "Show password"}
              >
                {showPwd ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: "var(--text-soft)" }}>
              Use your <strong>registered Gmail</strong> from <code className="text-[10px]">users-config.json</code>.
              Password is stored in <strong>PostgreSQL</strong> (not generic Admin@1234 unless your admin set that).
              Role <strong>admin</strong> unlocks the Admin tab and all features.
            </p>
          </div>

          <button type="submit" disabled={loading} className="btn-primary w-full justify-center mt-1">
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="text-center mt-6">
          <Link to="/" className="text-sm font-medium no-underline hover:underline" style={{ color: "var(--text-muted)" }}>
            &#x2190; Back to product overview
          </Link>
        </div>
      </div>
    </div>
  );
}
