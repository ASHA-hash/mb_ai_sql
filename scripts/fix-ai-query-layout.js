#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const panelPath = path.join(__dirname, "..", "panels", "ai-query.js");
const kpiChunk = fs.readFileSync(path.join(__dirname, "_git-sales-dashboard-chunk.txt"), "utf8");
const gitLines = fs.readFileSync(path.join(__dirname, "..", "dashboard-full-from-git.html"), "utf8").split(/\r?\n/);
const clarificationBlock = gitLines.slice(7873, 7958).join("\n");

let panel = fs.readFileSync(panelPath, "utf8");

const loadingOk = [
  "          {loading && (",
  '            <div className="card p-4 fade-in" style={{ borderLeft: "4px solid #6366f1" }}>',
  '              <motion.div className="flex items-center justify-between gap-3 mb-2">',
].join("\n");

// div-only loading block
const loading = [
  "          {loading && (",
  '            <div className="card p-4 fade-in" style={{ borderLeft: "4px solid #6366f1" }}>',
  '              <motion.div className="flex items-center justify-between gap-3 mb-2">',
].join("\n");

const LOADING = `          {loading && (
            <div className="card p-4 fade-in" style={{ borderLeft: "4px solid #6366f1" }}>
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-sm font-semibold text-slate-700">Running AI query…</p>
                <p className="text-xs font-semibold text-indigo-600">{aiProgress.pct}%</p>
              </div>
              <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "rgba(99,102,241,0.14)" }}>
                <motion.div
                  className="h-full rounded-full transition-all"
                  style={{ width: \`\${aiProgress.pct}%\`, background: "linear-gradient(90deg,#6366f1,#8b5cf6)" }}
                />
              </div>
              <p className="text-xs mt-2.5" style={{ color: "var(--text-muted)" }}>
                {AI_PROGRESS_STEPS[aiProgress.step]?.label || "Processing request"}…
              </p>
            </div>
          )}`;

panel = panel.replace(
  /\{loading && \([\s\S]*?\{AI_PROGRESS_STEPS\[aiProgress\.step\]\?\.label \|\| "Processing request"\}…[\s\S]*?\)\}/,
  LOADING
);

// Fix outer current-turn wrapper close
panel = panel.replace(
  /(\{AI_PROGRESS_STEPS\[aiProgress\.step\]\?\.label \|\| "Processing request"\}…[\s\S]*?<\/div>\s*\)\}\s*)<\/motion\.div>\s*\)\}/,
  "$1        </motion.div>\n      )}"
);

// If still broken, fix line by line
panel = panel.replace('              </motion.div>\n              <motion.div className="w-full h-2', '              </motion.div>\n              <motion.div className="w-full h-2');

// Insert clarification after error alert if missing
if (!panel.includes("clarificationUi.message")) {
  panel = panel.replace(
    '{error && <Alert type="error" msg={error} onClose={() => setError("")} />}',
    '{error && <Alert type="error" msg={error} onClose={() => setError("")} />}\n\n' + clarificationBlock
  );
}

// Insert KPI chunk after summary block (before Provenance intent badge)
const marker = "          {/* ── Provenance + Intent badge ──────────────────────────────── */}";
if (!panel.includes("StatsBar rows={result.data}")) {
  panel = panel.replace(marker, kpiChunk + "\n\n" + marker);
}

// Fix result closing: follow-up ends with </div></motion.div>)}  -> </motion.div></motion.div>)}
panel = panel.replace(
  /(\{\/\* ── Follow-up conversation[\s\S]*?Clear conversation[\s\S]*?<\/button>\s*\)\}\s*<\/motion.div>\s*)<\/motion.div>\s*\)\}/,
  "$1        </motion.div>\n      )}"
);

// History block
const historyBlock = `
      {chatMessages.length > 0 && (
        <motion.div className="space-y-2 mt-4">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Earlier in this session</p>
          {[...chatMessages].reverse().map(msg => (
            <motion.div key={msg.id} className="rounded-xl border overflow-hidden fade-in"
              style={{ background: "var(--bg-card,#fff)", borderColor: "var(--border,#e2e8f0)" }}>
              <QuestionBubble text={msg.question} ts={msg.ts} />
              <motion.div className="flex items-center gap-3 px-4 py-2 border-t" style={{ borderColor: "var(--border,#e2e8f0)" }}>
                <span className="text-xs flex-1" style={{ color: "var(--text-muted,#64748b)" }}>
                  {msg.result?.summary
                    ? (() => { const t = stripMarkdown(msg.result.summary); return t.length > 120 ? t.slice(0, 117) + "…" : t; })()
                    : msg.result?.data?.length
                      ? \`\${msg.result.data.length} row(s) returned\`
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
              </motion.div>
            </motion.div>
          ))}
        </motion.div>
      )}
`;

// Remove old history and insert after result block
const historyRe = /\s*\{chatMessages\.length > 0 && \([\s\S]*?Earlier in this session[\s\S]*?\)\}\s*\n/;
panel = panel.replace(historyRe, "\n");

const sqlTplMarker = "      {/* ── SQL Templates section ──────────────────────────────────────── */}";
if (!panel.includes("Earlier in this session")) {
  panel = panel.replace(sqlTplMarker, historyBlock + "\n" + sqlTplMarker);
}

// Fix current turn wrapper: should close with </motion.div> not </motion.div> for outer - check (activeQuestion
panel = panel.replace(
  /(\{\/\* Current turn[\s\S]*?LOADING_PLACEHOLDER)/,
  ""
);

// Fix motion.div in current turn outer - line 768 opens div, 787 should close div
panel = panel.replace(
  /(\(activeQuestion \|\| loading\) && \([\s\S]*?<\/div>\s*\)\}\s*)<\/motion\.div>\s*\)\}/,
  "$1      )}"
);

// Simpler fix for 787: after loading block ends with )}  we have </motion.div> )}  - should be </motion.div> )}
panel = panel.replace(
  /(\{AI_PROGRESS_STEPS\[aiProgress\.step\]\?\.label \|\| "Processing request"\}…\n              <\/p>\n            <\/div>\n          \)\}\n        )<\/motion\.div>(\n      \)\})/,
  "$1</div>$2"
);

fs.writeFileSync(panelPath, panel);
console.log("fixed", panelPath);
console.log("StatsBar:", panel.includes("StatsBar"));
console.log("Earlier:", panel.includes("Earlier in this session"));
console.log("clarification:", panel.includes("clarificationUi.message"));
