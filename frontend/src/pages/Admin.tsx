import { useState, useEffect } from "react";
import { admin as adminApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import { CheckCircle, XCircle, RefreshCw } from "lucide-react";

type Status = Record<string, unknown> & {
  postgres?: boolean;
  mssql?: boolean;
  rag?: { total: number };
  config?: Record<string, string>;
  env?: Record<string, boolean>;
};

export default function Admin() {
  const { user } = useAuth();
  const [status,   setStatus]   = useState<Status | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [tab,      setTab]      = useState<"status" | "settings">("status");
  const [saving,   setSaving]   = useState<string | null>(null);
  const [editVals, setEditVals] = useState<Record<string, string>>({});
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    adminApi.status().then(s => setStatus(s as Status)).catch(() => {});
    adminApi.getSettings().then(r => {
      setSettings(r.settings);
      setEditVals(r.settings);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const saveSetting = async (key: string) => {
    setSaving(key);
    try {
      await adminApi.updateSetting(key, editVals[key]);
      setSettings(prev => ({ ...prev, [key]: editVals[key] }));
    } catch(e) {
      alert((e as Error).message);
    }
    setSaving(null);
  };

  const refresh = async () => {
    setLoading(true);
    const s = await adminApi.status().catch(() => null);
    if (s) setStatus(s as Status);
    setLoading(false);
  };

  if (user?.role !== "admin") {
    return (
      <div className="section-enter p-10 rounded-xl font-medium" style={{ color: "var(--accent-bad)" }}>
        Admin access required.
      </div>
    );
  }

  const IMPORTANT_KEYS = [
    "OPENAI_MODEL", "ANTHROPIC_MODEL", "SALES_AI_TABLE", "ANALYTICS_BASE_TABLE",
    "SALES_ANALYTICS_AMOUNT_COLUMN", "SALES_FILTER_DATE_COLUMN", "SALES_ANALYTICS_INVOICE_COLUMN",
    "NLQ_FAST_PATH", "ADAPTIVE_INTENT_STEP",
    "COGNITIVE_COLUMN_DISCOVERY", "LANGGRAPH_LLM_SQL_CHECK", "DATASET_HARD_CAP", "DATASET_PAGE_MAX",
  ];

  return (
    <div className="section-enter space-y-6 text-slate-800">
      <div className="home-section-label">Administration</div>
      <p className="text-sm -mt-2" style={{ color: "var(--text-muted)" }}>
        System status and runtime settings (PostgreSQL <code className="mono text-xs">erp_runtime_config</code>).
      </p>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {(["status", "settings"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="chip"
            style={
              tab === t
                ? { borderColor: "var(--brand)", color: "var(--brand)", background: "var(--brand-soft)", fontWeight: 700 }
                : { fontWeight: 400 }
            }
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Status tab */}
      {tab === "status" && (
        <div>
          <div className="flex gap-2 mb-5">
            <button type="button" onClick={refresh} disabled={loading} className="btn-ghost flex items-center gap-2 text-sm">
              <RefreshCw size={14} className={loading ? "spin" : ""} style={{ display: "inline-block" }} />
              Refresh
            </button>
          </div>

          {status && (
            <div className="flex flex-col gap-3 max-w-lg">
              {[
                { label: "PostgreSQL (RBAC/Config)", ok: status.postgres },
                { label: "SQL Server (ERP data)", ok: status.mssql },
              ].map((item) => (
                <div
                  key={item.label}
                  className="stat-card-enhanced flex items-center justify-between relative"
                  style={{ padding: "14px 18px" }}
                >
                  <span className="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                    {item.label}
                  </span>
                  {item.ok ? <CheckCircle size={18} color="var(--accent-good)" /> : <XCircle size={18} color="var(--accent-bad)" />}
                </div>
              ))}

              {status.rag && (
                <div className="stat-card-enhanced relative" style={{ padding: "14px 18px" }}>
                  <div className="text-sm font-semibold mb-1" style={{ color: "var(--text-strong)" }}>
                    RAG Memory
                  </div>
                  <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {status.rag.total} total entries
                  </div>
                </div>
              )}

              {status.env && (
                <div className="stat-card-enhanced relative overflow-hidden" style={{ padding: "14px 18px" }}>
                  <div className="text-sm font-bold mb-2" style={{ color: "var(--text-strong)" }}>
                    Environment Keys
                  </div>
                  {Object.entries(status.env).map(([k, v]) => (
                    <div key={k} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
                        {k.replace(/_/g, " ").replace("KEY SET", "key").replace("URL SET", "URL")}
                      </span>
                      {v
                        ? <CheckCircle size={14} color="#22c55e" />
                        : <XCircle    size={14} color="#ef4444" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Settings tab */}
      {tab === "settings" && (
        <div>
          <p className="text-sm mb-4" style={{ color: "var(--text-muted)" }}>
            Changes take effect immediately (stored in PostgreSQL).
          </p>
          <div className="flex flex-col gap-3 max-w-2xl">
            {IMPORTANT_KEYS.filter((k) => k in editVals).map((key) => (
              <div key={key} className="stat-card-enhanced flex gap-3 items-center relative" style={{ padding: "12px 16px" }}>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>
                    {key}
                  </div>
                  <input
                    className="input-base"
                    value={editVals[key] ?? ""}
                    onChange={(e) => setEditVals((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                </div>
                <button
                  type="button"
                  className="btn-primary flex-shrink-0 text-xs"
                  onClick={() => saveSetting(key)}
                  disabled={saving === key || editVals[key] === settings[key]}
                >
                  {saving === key ? "Saving…" : "Save"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
