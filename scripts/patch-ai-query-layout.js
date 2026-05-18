#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const p = path.join(__dirname, "..", "panels", "ai-query.js");
let s = fs.readFileSync(p, "utf8");

s = s.replace(/\n\s*\{false && loading &&[\s\S]*?\n\s*\}\)\n/g, "\n");
s = s.replace(/\n\s*\{false && chatMessages\.length > 0 &&[\s\S]*?\n\s*\}\)\n\s*(?=\{result &&)/, "\n");

s = s.replace(
  /(\{loading && \([\s\S]*?<\/p>\n)\s*<\/motion\.div>\n\s*\)\}\n\s*<\/motion\.div>/,
  "$1            </motion.div>\n          )}\n        </motion.div>"
);

s = s.replace(
  /(\{loading && \([\s\S]*?<\/p>\n)\s*<\/motion\.motion\.div>/,
  "$1            </motion.div>\n          )}"
);

// Fix: loading closes with motion.div but wrapper should be div
s = s.replace(
  /<div className="card p-4 fade-in" style=\{\{ borderLeft: "4px solid #6366f1" \}\}>[\s\S]*?Processing request"…[\s\S]*?<\/motion\.motion\.div>/,
  (block) => block.replace(/<\/motion\.motion\.div>$/, "</motion.div>")
);

s = s.replace(
  /(<div className="card p-4 fade-in" style=\{\{ borderLeft: "4px solid #6366f1" \}\}>[\s\S]*?Processing request"…\n\s*)<\/motion\.motion\.div>/,
  "$1</motion.div>"
);

// Simpler fix for current-turn wrapper
s = s.replace(
  /(\{AI_PROGRESS_STEPS\[aiProgress\.step\]\?\.label \|\| "Processing request"\}…\n\s*)<\/motion\.div>\n\s*\)\}\n\s*<\/motion\.motion\.motion\.div>/,
  "$1            </motion.div>\n          )}\n        </motion.div>"
);

s = s.replace(
  /(\{AI_PROGRESS_STEPS\[aiProgress\.step\]\?\.label \|\| "Processing request"\}…\n\s*)<\/motion\.div>\n\s*\)\}\n\s*<\/motion\.div>\n\s*\)\}/,
  "$1            </motion.div>\n          )}\n        </motion.div>\n      )}"
);

// History card: motion.div -> div
s = s.replace(
  /(<div key=\{msg\.id\} className="rounded-xl border[\s\S]*?<\/motion\.div>\n\s*\)\)\}\n\s*<\/motion\.div>\n\s*\)\}/,
  (block) =>
    block
      .replace(/<motion\.motion\.div className="flex items-center/g, '<div className="flex items-center')
      .replace(/<\/motion\.div>\n            <\/motion\.div>/, "</div>\n            </div>")
);

s = s.replace(
  '              <motion.div className="flex items-center gap-3 px-4 py-2 border-t"',
  '              <div className="flex items-center gap-3 px-4 py-2 border-t"'
);
s = s.replace(
  /(<QuestionBubble text=\{msg\.question\} ts=\{msg\.ts\} \/>[\s\S]*?Restore ↩\n                <\/button>\n              )<\/motion\.div>\n            <\/motion\.div>/,
  "$1</motion.div>\n            </motion.div>"
);

s = s.replace(
  /Restore ↩\n                <\/button>\n              <\/motion\.div>\n            <\/motion\.div>\n          \)\)\}/,
  "Restore ↩\n                </button>\n              </motion.div>\n            </motion.div>\n          ))}"
);

s = s.replace(
  "Restore ↩\n                </button>\n              </motion.div>\n            </motion.div>\n          ))}",
  "Restore ↩\n                </button>\n              </div>\n            </div>\n          ))}"
);

s = s.replace(
  /(\{chatMessages\.length > 0 && \([\s\S]*?\)\)\}\n\s*)<\/motion\.motion\.div>\n\s*\)\}/,
  "$1        </motion.div>\n      )}"
);

s = s.replace("        </motion.div>\n      )}\n\n      {/* ── SQL Template", "        </div>\n      )}\n\n      {/* ── SQL Template");

fs.writeFileSync(p, s);
console.log("done");
