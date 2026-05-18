#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const p = path.join(__dirname, "..", "panels", "ai-query.js");
const lines = fs.readFileSync(p, "utf8").split("\n");

const replacement = [
  "          {activeQuestion ? <QuestionBubble text={activeQuestion} ts={result?._ts} /> : null}",
  "          {loading && (",
  '            <motion.div className="card p-4 fade-in" style={{ borderLeft: "4px solid #6366f1" }}>',
  '              <motion.div className="flex items-center justify-between gap-3 mb-2">',
  '                <p className="text-sm font-semibold text-slate-700">Running AI query…</p>',
  '                <p className="text-xs font-semibold text-indigo-600">{aiProgress.pct}%</p>',
  "              </motion.div>",
  '              <motion.div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "rgba(99,102,241,0.14)" }}>',
  "                <motion.div",
  '                  className="h-full rounded-full transition-all"',
  '                  style={{ width: `${aiProgress.pct}%`, background: "linear-gradient(90deg,#6366f1,#8b5cf6)" }}',
  "                />",
  "              </motion.div>",
  '              <p className="text-xs mt-2.5" style={{ color: "var(--text-muted)" }}>',
  '                {AI_PROGRESS_STEPS[aiProgress.step]?.label || "Processing request"}…',
  "              </p>",
  "            </motion.div>",
  "          )}",
  "        </motion.div>",
  "      )}",
];

// Use HTML div tags (not motion) for loading card
const rep = [
  "          {activeQuestion ? <QuestionBubble text={activeQuestion} ts={result?._ts} /> : null}",
  "          {loading && (",
  '            <motion.div className="card p-4 fade-in" style={{ borderLeft: "4px solid #6366f1" }}>',
].join("\n");

const D = "div";
const loadingBlock = [
  "          {activeQuestion ? <QuestionBubble text={activeQuestion} ts={result?._ts} /> : null}",
  "          {loading && (",
  `            <${D} className="card p-4 fade-in" style={{ borderLeft: "4px solid #6366f1" }}>`,
  `              <${D} className="flex items-center justify-between gap-3 mb-2">`,
  '                <p className="text-sm font-semibold text-slate-700">Running AI query…</p>',
  '                <p className="text-xs font-semibold text-indigo-600">{aiProgress.pct}%</p>',
  `              </${D}>`,
  `              <${D} className="w-full h-2 rounded-full overflow-hidden" style={{ background: "rgba(99,102,241,0.14)" }}>`,
  `                <${D}`,
  '                  className="h-full rounded-full transition-all"',
  '                  style={{ width: `${aiProgress.pct}%`, background: "linear-gradient(90deg,#6366f1,#8b5cf6)" }}',
  "                />",
  `              </${D}>`,
  '              <p className="text-xs mt-2.5" style={{ color: "var(--text-muted)" }}>',
  '                {AI_PROGRESS_STEPS[aiProgress.step]?.label || "Processing request"}…',
  "              </p>",
  `            </${D}>`,
  "          )}",
  `        </${D}>`,
  "      )}",
];

// Find start: line with activeQuestion ? <QuestionBubble inside current turn
const start = lines.findIndex((l, i) => i > 840 && l.includes("activeQuestion ? <QuestionBubble"));
const end = lines.findIndex((l, i) => i > start && l.trim() === "{result && (");
if (start < 0 || end < 0) {
  console.error("markers not found", start, end);
  process.exit(1);
}

lines.splice(start, end - start, ...loadingBlock);

// Fix result close: motion.div open at {result && (
const closeIdx = lines.findIndex((l, i) => i > 1400 && l.trim() === "</div>" && lines[i + 1]?.trim() === ")}");
// Find follow-up end - line 1487 area
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes("Clear conversation") && lines[i + 4]?.trim() === ")}") {
    // expect structure: </div> followup, </div> result inner, )} 
    break;
  }
}

// Replace `        </div>\n      )}` before chatMessages with motion.div close
const histIdx = lines.findIndex((l) => l.includes("Earlier in this session"));
if (histIdx > 0) {
  for (let i = histIdx - 1; i >= histIdx - 5; i--) {
    if (lines[i].trim() === ")}") {
      // line before )} should be </motion.div> for result wrapper
      if (lines[i - 1].trim() === "</motion.div>") {
        lines[i - 1] = "        </motion.div>";
      }
      break;
    }
  }
}

// More reliable: find `{result && (` and matching close before Earlier
const resultStart = lines.findIndex((l) => l.trim() === "{result && (");
let depth = 0;
let resultEnd = -1;
for (let i = resultStart; i < lines.length; i++) {
  const t = lines[i];
  if (t.includes("{result && (")) depth++;
  if (t.trim() === ")}") {
    depth--;
    if (depth === 0) {
      resultEnd = i;
      break;
    }
  }
}
// Actually result block closes with `      )}` only once at top level - search backwards from history
let j = histIdx - 1;
while (j > resultStart && lines[j].trim() !== ")}") j--;
if (j > resultStart && lines[j - 1].trim() === "</motion.div>") {
  lines[j - 1] = "        </motion.div>";
  console.log("fixed result close at line", j);
}

fs.writeFileSync(p, lines.join("\n"));
console.log("patched current turn", start, end, "->", loadingBlock.length, "lines");
