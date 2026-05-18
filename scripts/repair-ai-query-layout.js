#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const panelPath = path.join(__dirname, "..", "panels", "ai-query.js");
const gitHtml = path.join(__dirname, "..", "dashboard-full-from-git.html");

let panel = fs.readFileSync(panelPath, "utf8");
const gitLines = fs.readFileSync(gitHtml, "utf8").split(/\r?\n/);

// dashboard-full-from-git.html is 1-indexed in editor; slice [7959, 8154] => lines 7960-8154
const gitChunk = gitLines.slice(7959, 8154).join("\n");

const errorBlock = `
      {error && <Alert type="error" msg={error} onClose={() => setError("")} />}
`;

// Extract clarification from panel if still present, else from git
let clarStart = panel.indexOf("{clarificationUi &&");
let clarEnd = panel.indexOf("{/* Summary */}");
let clarificationBlock = "";
if (clarStart >= 0 && clarEnd > clarStart) {
  clarificationBlock = panel.slice(clarStart, clarEnd);
} else {
  const gs = gitLines.findIndex((l) => l.includes("{clarificationUi &&"));
  const ge = gitLines.findIndex((l) => l.includes("{result &&"));
  if (gs >= 0 && ge > gs) clarificationBlock = gitLines.slice(gs, ge).join("\n");
}

const currentTurn = `
      {/* ── Current turn: question → loading → answer (above session history) ── */}
      {(activeQuestion || loading || result) && (
        <div className="space-y-3">
          {activeQuestion ? <QuestionBubble text={activeQuestion} ts={result?._ts} /> : null}
          {loading && (
            <div className="card p-4 fade-in" style={{ borderLeft: "4px solid #6366f1" }}>
              <motion.div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-sm font-semibold text-slate-700">Running AI query…</p>
                <p className="text-xs font-semibold text-indigo-600">{aiProgress.pct}%</p>
              </motion.div>
              <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "rgba(99,102,241,0.14)" }}>
                <motion.div
                  className="h-full rounded-full transition-all"
                  style={{ width: \`\${aiProgress.pct}%\`, background: "linear-gradient(90deg,#6366f1,#8b5cf6)" }}
                />
              </motion.div>
              <p className="text-xs mt-2.5" style={{ color: "var(--text-muted)" }}>
                {AI_PROGRESS_STEPS[aiProgress.step]?.label || "Processing request"}…
              </p>
            </motion.div>
          )}
        </motion.div>
      )}

`;

const resultOpen = `
      {result && (
        <motion.div className="space-y-4 fade-in" ref={chatBottomRef} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
`;

// gitChunk: result && + StatsBar + salesDashboard — strip duplicate result wrapper
const gitBody = gitChunk
  .replace(/^\s*\{result && \(\s*$/, "")
  .replace(/^\s*<div className="space-y-4 fade-in">\s*$/, "");

const orphanRe = /\s*<\/p>\s*\)\}\s*<\/div>\s*\);\s*\}\)\(\)\}\s*\n\s*\n/;
const summaryIdx = panel.search("{/* Summary */}");
if (summaryIdx < 0) {
  console.error("Summary marker not found");
  process.exit(1);
}

const beforeSummary = panel.slice(0, panel.indexOf("</motion.div>", panel.indexOf("Ask AI")));
const cardClose = panel.indexOf("      </motion.div>\n", panel.indexOf('className="card p-5'));
const headEnd = panel.indexOf("      </motion.div>\n", panel.lastIndexOf("✨ Ask AI", cardClose));
const head = panel.slice(0, headEnd + "      </motion.div>\n".length).replace(orphanRe, "\n");

const tailFromSummary = panel.slice(summaryIdx);
const tailCloseIdx = tailFromSummary.lastIndexOf("\n      )}\n\n      {/* ── SQL Templates");
if (tailCloseIdx < 0) {
  console.error("result close before SQL Templates not found");
  process.exit(1);
}
const resultInner = tailFromSummary.slice(0, tailCloseIdx);
const afterResult = tailFromSummary.slice(tailCloseIdx);

// After plain-English summary block, inject StatsBar + sales dashboard from git
const summaryEnd = resultInner.indexOf("{/* ── Provenance + Intent badge");
const kpiBlock = gitBody.split("{/* Summary */")[0].trim();

let reorderedInner = resultInner;
if (summaryEnd > 0 && kpiBlock) {
  const summaryPart = resultInner.slice(0, summaryEnd);
  const restPart = resultInner.slice(summaryEnd);
  reorderedInner = summaryPart + "\n\n" + kpiBlock + "\n\n" + restPart;
}

const historyBlock = `
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
              </div>
            </motion.div>
          ))}
        </motion.div>
      )}
`;

// Remove duplicate history if present
let tail = afterResult.replace(
  /\s*\{chatMessages\.length > 0 &&[\s\S]*?Earlier in this session[\s\S]*?\}\)\s*\n/,
  "\n"
);

panel =
  head +
  errorBlock +
  clarificationBlock +
  currentTurn +
  resultOpen +
  reorderedInner +
  "\n        </motion.div>\n      )}" +
  historyBlock +
  tail;

if (!panel.includes("function QuestionBubble")) {
  console.error("QuestionBubble missing — merge manually");
}

fs.writeFileSync(panelPath, panel);
console.log("repaired", panelPath);
