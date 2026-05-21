import { useState, useEffect } from "react";
import { rag as ragApi } from "../lib/api";
import { Plus, Trash2, Search } from "lucide-react";

interface RagEntry {
  id:       string;
  text:     string;
  metadata: Record<string, string>;
  addedAt?: string;
}

export default function RAGPanel() {
  const [stats,     setStats]     = useState<{ total: number; byType: Record<string, number> } | null>(null);
  const [examples,  setExamples]  = useState<RagEntry[]>([]);
  const [glossary,  setGlossary]  = useState<RagEntry[]>([]);
  const [tab,       setTab]       = useState<"examples" | "glossary">("examples");
  const [adding,    setAdding]    = useState(false);
  const [newQ,      setNewQ]      = useState("");
  const [newSQL,    setNewSQL]    = useState("");
  const [newTerm,   setNewTerm]   = useState("");
  const [newDef,    setNewDef]    = useState("");
  const [searchQ,   setSearchQ]   = useState("");
  const [searchRes, setSearchRes] = useState<RagEntry[]>([]);
  const [loading,   setLoading]   = useState(false);

  const reload = async () => {
    const [s, e, g] = await Promise.all([ragApi.stats(), ragApi.listExamples(), ragApi.listGlossary()]);
    setStats(s);
    setExamples((e as { examples: RagEntry[] }).examples);
    setGlossary((g as { glossary: RagEntry[] }).glossary);
  };

  useEffect(() => { reload(); }, []);

  const addExample = async () => {
    if (!newQ.trim() || !newSQL.trim()) return;
    setLoading(true);
    await ragApi.addExample(newQ.trim(), newSQL.trim());
    setNewQ(""); setNewSQL(""); setAdding(false);
    await reload();
    setLoading(false);
  };

  const addGlossary = async () => {
    if (!newTerm.trim() || !newDef.trim()) return;
    setLoading(true);
    await ragApi.addGlossary(newTerm.trim(), newDef.trim());
    setNewTerm(""); setNewDef(""); setAdding(false);
    await reload();
    setLoading(false);
  };

  const removeEntry = async (id: string) => {
    await ragApi.delete(id);
    await reload();
  };

  const doSearch = async () => {
    if (!searchQ.trim()) return;
    const res = await ragApi.search(searchQ.trim(), 6, tab === "examples" ? "example" : "glossary") as {
      results: Array<RagEntry & { score: number }>;
    };
    setSearchRes(res.results);
  };

  const entries = tab === "examples" ? examples : glossary;
  const filtered = searchRes.length > 0
    ? searchRes
    : entries;

  return (
    <div style={{ padding: 32 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>RAG Memory</h1>
      <p style={{ color: "var(--color-muted)", fontSize: 13, marginBottom: 24 }}>
        Curated Q→SQL examples and glossary terms that improve AI query accuracy.
      </p>

      {/* Stats */}
      {stats && (
        <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
          {[
            { label: "Total entries", val: stats.total },
            { label: "Examples",      val: stats.byType["example"] ?? 0 },
            { label: "Glossary",      val: stats.byType["glossary"] ?? 0 },
            { label: "Schema chunks", val: stats.byType["schema"] ?? 0 },
          ].map(s => (
            <div key={s.label} style={{
              background: "var(--color-surface)", border: "1px solid var(--color-border)",
              borderRadius: 10, padding: "12px 18px",
            }}>
              <div style={{ fontSize: 11, color: "var(--color-muted)", marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{s.val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs + controls */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["examples", "glossary"] as const).map(t => (
          <button key={t} onClick={() => { setTab(t); setSearchRes([]); }}
            style={{
              padding: "5px 14px", borderRadius: 8, fontSize: 12, fontWeight: tab === t ? 700 : 400,
              background: tab === t ? "#6366f1" : "var(--color-surface)",
              color: tab === t ? "#fff" : "var(--color-muted)",
              border: `1px solid ${tab === t ? "#6366f1" : "var(--color-border)"}`, cursor: "pointer",
            }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}

        <div style={{ flex: 1 }} />

        {/* Search */}
        <div style={{ display: "flex", gap: 6 }}>
          <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
            onKeyDown={e => e.key === "Enter" && doSearch()}
            placeholder="Semantic search…"
            style={{
              padding: "5px 12px", borderRadius: 8, fontSize: 12,
              background: "var(--color-surface)", border: "1px solid var(--color-border)",
              color: "var(--color-text)", width: 200,
            }} />
          <button onClick={doSearch} style={{
            padding: "5px 10px", borderRadius: 8, border: "1px solid var(--color-border)",
            background: "var(--color-surface)", cursor: "pointer", color: "var(--color-muted)",
            display: "flex", alignItems: "center",
          }}>
            <Search size={13} />
          </button>
        </div>

        <button onClick={() => setAdding(!adding)} style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "5px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600,
          background: "#6366f1", color: "#fff", border: "none", cursor: "pointer",
        }}>
          <Plus size={13} /> Add
        </button>
      </div>

      {/* Add form */}
      {adding && (
        <div style={{
          background: "var(--color-surface)", border: "1px solid var(--color-border)",
          borderRadius: 10, padding: 20, marginBottom: 16,
        }}>
          {tab === "examples" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input value={newQ} onChange={e => setNewQ(e.target.value)} placeholder="Question"
                style={{ padding: "8px 12px", borderRadius: 8, background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)", fontSize: 13 }} />
              <textarea value={newSQL} onChange={e => setNewSQL(e.target.value)} placeholder="SQL" rows={3}
                style={{ padding: "8px 12px", borderRadius: 8, background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)", fontSize: 12, fontFamily: "monospace", resize: "vertical" }} />
              <button onClick={addExample} disabled={loading} style={{
                padding: "7px 16px", borderRadius: 8, background: "#6366f1", color: "#fff",
                border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", alignSelf: "flex-start",
              }}>
                {loading ? "Saving…" : "Save Example"}
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 10 }}>
              <input value={newTerm} onChange={e => setNewTerm(e.target.value)} placeholder="Term" style={{ flex: 1, padding: "8px 12px", borderRadius: 8, background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)", fontSize: 13 }} />
              <input value={newDef} onChange={e => setNewDef(e.target.value)} placeholder="Definition" style={{ flex: 2, padding: "8px 12px", borderRadius: 8, background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)", fontSize: 13 }} />
              <button onClick={addGlossary} disabled={loading} style={{
                padding: "7px 16px", borderRadius: 8, background: "#6366f1", color: "#fff",
                border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>
                {loading ? "…" : "Save"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Entry list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map(entry => (
          <div key={entry.id} style={{
            background: "var(--color-surface)", border: "1px solid var(--color-border)",
            borderRadius: 10, padding: "12px 16px",
            display: "flex", gap: 10, alignItems: "flex-start",
          }}>
            <div style={{ flex: 1 }}>
              {tab === "examples" ? (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                    {entry.metadata.question}
                  </div>
                  <pre style={{ fontSize: 11, color: "#a5b4fc", margin: 0, overflow: "hidden", maxHeight: 60 }}>
                    {entry.metadata.sql?.slice(0, 200)}
                  </pre>
                  {entry.metadata.note && (
                    <div style={{ fontSize: 11, color: "var(--color-muted)", marginTop: 4 }}>
                      {entry.metadata.note}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <span style={{ fontWeight: 600, color: "#e0e7ff" }}>{entry.metadata.term}</span>
                  <span style={{ color: "var(--color-muted)", marginLeft: 8, fontSize: 13 }}>
                    {entry.metadata.definition}
                  </span>
                </>
              )}
            </div>
            <button onClick={() => removeEntry(entry.id)} style={{
              padding: 4, background: "none", border: "none", cursor: "pointer", color: "var(--color-muted)",
            }}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ color: "var(--color-muted)", fontSize: 13, padding: "20px 0" }}>
            No entries found.
          </div>
        )}
      </div>
    </div>
  );
}
