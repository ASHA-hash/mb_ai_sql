"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "dashboard-full-from-git.html"), "utf8").split(/\r?\n/);

let body = src.slice(10562, 10796).join("\n"); // Dashboard function through closing brace
body = body.replace(/function Dashboard/, "function PageLayout");

const preamble = `const NAV_ITEMS = [
  { key: "home",      label: "Home",       icon: "🏠", href: "/dashboard.html", feature: null },
  { key: "analytics", label: "Analytics",  icon: "📈", href: "/analytics.html", feature: "data" },
  { key: "ai",        label: "AI Query",   icon: "✨", href: "/ai-query.html",  feature: "ai" },
  { key: "data",      label: "Data",       icon: "📊", href: "/data.html",      feature: "data" },
  { key: "explorer",  label: "Explorer",   icon: "🔎", href: "/explorer.html",  feature: "explorer" },
  { key: "rag",       label: "RAG Memory", icon: "🧠", href: "/rag.html",       feature: "ai" },
  { key: "schedule",  label: "Schedule",   icon: "⏱", href: "/schedule.html",  feature: "schedule" },
  { key: "admin",     label: "Admin",      icon: "🔑", href: "/admin.html",     feature: "admin" },
  { key: "settings",  label: "Settings",   icon: "⚙", href: "/settings.html",  feature: null },
];

const ERP_PAGE = (typeof window !== "undefined" && window.__ERP_PAGE__) || "home";

function readAiContextFromSession() {
  try {
    const raw = sessionStorage.getItem("erp_ai_context");
    if (!raw) return null;
    sessionStorage.removeItem("erp_ai_context");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function renderPagePanel(auth) {
  switch (ERP_PAGE) {
    case "home":
      return (
        <HomePanel
          auth={auth}
          onNavigate={(key) => {
            const item = NAV_ITEMS.find((n) => n.key === key);
            if (item?.href) window.location.href = item.href;
          }}
        />
      );
    case "analytics":
      return <AnalyticsPanel auth={auth} />;
    case "ai":
      return <AIQueryPanel auth={auth} initialContext={readAiContextFromSession()} />;
    case "data":
      return <DataPanel auth={auth} />;
    case "explorer":
      return (
        <ExplorerPanel
          auth={auth}
          onAskAI={(table, label) => {
            try {
              sessionStorage.setItem("erp_ai_context", JSON.stringify({ table, label }));
            } catch (_) {}
            window.location.href = "/ai-query.html";
          }}
        />
      );
    case "rag":
      return <RagPanel auth={auth} />;
    case "schedule":
      return <SchedulePanel />;
    case "admin":
      return <AdminPanel auth={auth} />;
    case "settings":
      return <SettingsPanel auth={auth} />;
    default:
      return <HomePanel auth={auth} onNavigate={() => {}} />;
  }
}

`;

// Strip single-page state: section, mountedSections, aiContext, navigate, handleAskAI, panel()
body = body
  .replace(
    /const \[section,setSection\][^\n]+\n/,
    ""
  )
  .replace(
    /const \[mountedSections,setMountedSections\][^\n]+\n/,
    ""
  )
  .replace(/const \[aiContext,setAiContext\][^\n]+\n/, "")
  .replace(/useEffect\(\(\)=>\{\s*setMountedSections[\s\S]*?\},\[section\]\);\n\n/, "")
  .replace(/useEffect\(\(\)=>\{ try\{window\.location\.hash=section;\}catch\(_\)\{\} \},\[section\]\);\n\n/, "")
  .replace(/function handleAskAI\(table,label\)\{ setAiContext\(\{table,label\}\); setSection\("ai"\); \}\n/, "")
  .replace(/function navigate\(key\)\{ setSection\(key\); setDrawer\(false\); try\{contentRef\.current\?\.scrollTo\(\{top:0,behavior:"smooth"\}\);\}catch\(_\)\{\} \}\n\n/, "")
  .replace(/const currentNav = NAV_ITEMS\.find\(n=>n\.key===section\);/, "const currentNav = NAV_ITEMS.find(n=>n.key===ERP_PAGE) || NAV_ITEMS[0];")
  .replace(
    /if \(!auth\.token\|\|!features\.includes\("data"\)\) return;/,
    'if (!auth.token || ERP_PAGE !== "analytics" || !features.includes("data")) return;'
  );

// Side nav: buttons -> anchor links
body = body.replace(
  /visibleNav\.map\(n=>\(\s*<button key=\{n\.key\} onClick=\{\(\)=>navigate\(n\.key\)\}/,
  'visibleNav.map(n=>(\n            <a key={n.key} href={n.href}'
);
body = body.replace(
  /\$\{section===n\.key\?"nav-active":"text-slate-500"\}/,
  '${ERP_PAGE===n.key?"nav-active":"text-slate-500"}'
);
body = body.replace(
  /className=\{\`nav-item sidebar-item w-full flex items-center gap-3 py-2\.5 text-sm font-medium \$\{open/,
  'className={`nav-item sidebar-item w-full flex items-center gap-3 py-2.5 text-sm font-medium no-underline ${open'
);
body = body.replace(/<\/button>\)\)/, "</a>))");

// Replace panel() block with single render
body = body.replace(
  /function panel\(key, el\) \{[\s\S]*?\}\n\n  function relogin/,
  "function relogin"
);
body = body.replace(
  /\{panel\("home"[\s\S]*?\{panel\("settings"[^}]+\}\)\}/,
  "{renderPagePanel(auth)}"
);

const appStart = src.findIndex((l) => l.startsWith("function App("));
const appEnd = src.findIndex((l, i) => i > appStart && l.startsWith("_root.render"));
if (appStart < 0 || appEnd < 0) {
  throw new Error("Could not locate App() in dashboard source");
}
let app = src.slice(appStart, appEnd + 1).join("\n");
app = app.replace(
  /return <Dashboard auth=\{auth\} onLogout=\{handleLogout\}\/>;/,
  "return <PageLayout auth={auth} onLogout={handleLogout} />;"
);

let out = `${preamble}${body}\n\n${app}\n\nconst _root = ReactDOM.createRoot(document.getElementById("root"));\n_root.render(<App/>);\n`;
out = out.replace(/<\/?html>\s*$/gim, "").trimEnd() + "\n";
fs.writeFileSync(path.join(ROOT, "assets", "page-shell.jsx"), out, "utf8");
console.log("Wrote assets/page-shell.jsx", out.split("\n").length, "lines");
