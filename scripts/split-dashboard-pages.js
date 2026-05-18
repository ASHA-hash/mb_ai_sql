"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SOURCE =
  process.env.DASHBOARD_SOURCE ||
  path.join(ROOT, "dashboard-full-from-git.html");
const raw = fs.readFileSync(SOURCE, "utf8");
const lines = raw.split(/\r?\n/);

function slice1(start, end) {
  return lines.slice(start - 1, end).join("\n");
}

const assetsDir = path.join(ROOT, "assets");
const panelsDir = path.join(ROOT, "panels");
fs.mkdirSync(assetsDir, { recursive: true });

const styleMatch = raw.match(/<style>([\s\S]*?)<\/style>/);
if (styleMatch) {
  fs.writeFileSync(path.join(assetsDir, "dashboard.css"), styleMatch[1].trim() + "\n", "utf8");
}

fs.writeFileSync(path.join(assetsDir, "shared-core.jsx"), slice1(1047, 4792) + "\n", "utf8");
fs.writeFileSync(path.join(panelsDir, "home.js"), "/* Home + sales period */\n" + slice1(4793, 5851) + "\n", "utf8");
fs.writeFileSync(path.join(assetsDir, "auth-ui.jsx"), slice1(5852, 5985) + "\n", "utf8");

const HEAD = (title, page, panelScripts) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>
<meta name="google-site-verification" content="kSH7dmadOjytmB2_PAXoYomb-d8YnogWchpgnpEuELE"/>
<title>Smart ERP · ${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%237c3aed'/%3E%3Ctext x='16' y='23' text-anchor='middle' font-size='20' fill='white'%3E✦%3C/text%3E%3C/svg%3E" type="image/svg+xml"/>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.2/babel.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<script>
  (function () {
    try {
      var saved = localStorage.getItem('erp_theme');
      var sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', saved || (sysDark ? 'dark' : 'light'));
    } catch (e) {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  })();
</script>
<link rel="stylesheet" href="/assets/dashboard.css"/>
<script>tailwind.config = {theme:{extend:{colors:{brand:'#7c3aed',brandDark:'#6d28d9'}}}}</script>
</head>
<body class="text-slate-800" style="background:var(--bg-app,#f0f2f5)">
<div id="root"></div>
<script>window.__ERP_PAGE__ = "${page}";</script>
<script type="text/babel" src="/assets/shared-core.jsx"></script>
<script type="text/babel" src="/assets/auth-ui.jsx"></script>
${panelScripts}
<script type="text/babel" src="/assets/page-shell.jsx"></script>
</body>
</html>
`;

const PAGES = [
  { file: "dashboard.html", page: "home", title: "Home", panels: ["panels/home.js"] },
  { file: "analytics.html", page: "analytics", title: "Analytics", panels: ["panels/analytics.js"] },
  { file: "ai-query.html", page: "ai", title: "AI Query", panels: ["panels/ai-query.js"] },
  { file: "data.html", page: "data", title: "Data", panels: ["panels/data.js"] },
  { file: "explorer.html", page: "explorer", title: "Explorer", panels: ["panels/explorer.js"] },
  { file: "rag.html", page: "rag", title: "RAG Memory", panels: ["panels/rag.js"] },
  { file: "schedule.html", page: "schedule", title: "Schedule", panels: ["panels/schedule.js"] },
  { file: "admin.html", page: "admin", title: "Admin", panels: ["panels/admin.js"] },
  { file: "settings.html", page: "settings", title: "Settings", panels: ["panels/settings.js"] },
];

const HASH_REDIRECT = `<script>
(function () {
  var map = { analytics: "/analytics.html", ai: "/ai-query.html", data: "/data.html", explorer: "/explorer.html", rag: "/rag.html", schedule: "/schedule.html", admin: "/admin.html", settings: "/settings.html" };
  var h = (location.hash || "").replace(/^#/, "").trim();
  if (h && map[h]) location.replace(map[h]);
})();
</script>`;

for (const p of PAGES) {
  const panelScripts = p.panels.map((src) => `<script type="text/babel" src="/${src}"></script>`).join("\n");
  const extra = p.page === "home" ? HASH_REDIRECT : "";
  fs.writeFileSync(path.join(ROOT, p.file), HEAD(p.title, p.page, panelScripts).replace("</body>", `${extra}\n</body>`), "utf8");
}

console.log("Extracted assets + generated", PAGES.length, "HTML pages.");
