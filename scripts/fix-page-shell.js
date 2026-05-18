"use strict";

const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "assets", "page-shell.jsx");
const raw = fs.readFileSync(file);
let s =
  raw[0] === 0xff && raw[1] === 0xfe
    ? raw.toString("utf16le")
    : raw.includes(0)
      ? raw.toString("utf16le")
      : raw.toString("utf8");

s = s.replace(
  /<button key=\{n\.key\} onClick=\{\(\)=>navigate\(n\.key\)\}/g,
  "<a key={n.key} href={n.href}"
);
s = s.replace(/\$\{section===n\.key/g, "${ERP_PAGE===n.key");
s = s.replace(
  /nav-item sidebar-item w-full flex items-center gap-3 py-2\.5 text-sm font-medium \$\{/g,
  "nav-item sidebar-item w-full flex items-center gap-3 py-2.5 text-sm font-medium no-underline ${"
);
s = s.replace(/<\/button>\)\)/g, "</a>))");
s = s.replace(/function panel\(key, el\) \{[\s\S]*?\}\n\n  function relogin/, "function relogin");
s = s.replace(
  /\{panel\("home"[\s\S]*?\{panel\("settings"[^}]+\}\)\}/,
  '<motion.div className="flex-1 min-h-0 app-main-padding fade-in">{renderPagePanel(auth)}</motion.div>'
);
s = s.replace(/<div className="flex-1 min-h-0">\s*\{renderPagePanel/g, '<motion.div className="flex-1 min-h-0 app-main-padding fade-in">{renderPagePanel');
s = s.replace(/motion\.div/g, "motion.div"); // keep div fix below
s = s.replace(/<motion\.motion\.div/g, "<motion.div");
s = s.replace(/motion\.motion\./g, "");

fs.writeFileSync(file, s, "utf8");
console.log("fixed utf8", {
  hasPanelFn: /function panel/.test(s),
  hasRender: s.includes("renderPagePanel(auth)"),
  hasAnchor: s.includes("href={n.href}"),
});
