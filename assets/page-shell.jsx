const NAV_ITEMS = [
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

function PageLayout({ auth, onLogout }) {
        const [showChangePwd,setChangePwd]       = useState(auth.firstRun);
  const [sidebarOpen,setSidebar]           = useState(true);
  const [drawerOpen,setDrawer]             = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const { mobile,tablet,desktop }          = useBreakpoint();
  const [theme,toggleTheme]               = useTheme();
  const contentRef = useRef(null);

  useEffect(() => {
    const onExpired = () => setSessionExpired(true);
    window.addEventListener("erp-session-expired", onExpired);
    return () => window.removeEventListener("erp-session-expired", onExpired);
  }, []);

    useEffect(()=>{ if(tablet) setSidebar(false); if(desktop) setSidebar(true); },[tablet,desktop]);
        const features   = auth.features||[];
  const featKey    = features.join(",");
  const visibleNav = NAV_ITEMS.filter(n=>!n.feature||features.includes(n.feature));
  const currentNav = NAV_ITEMS.find(n=>n.key===ERP_PAGE) || NAV_ITEMS[0];
  const avatarLetter = (auth.name||auth.email||"?")[0].toUpperCase();

  useEffect(()=>{
    if (!auth.token || ERP_PAGE !== "analytics" || !features.includes("data")) return;
    const ric = window.requestIdleCallback||(cb=>setTimeout(cb,400));
    const id = ric(()=>prefetchAnalyticsCriticalDefault(auth.token),{timeout:4000});
    return ()=>{ try{ typeof window.cancelIdleCallback==="function"?window.cancelIdleCallback(id):clearTimeout(id); }catch(_){} };
  },[auth.token,featKey]);

  const showDesktopSidebar = !mobile;

  function SideNav({ open }) {
    return (
      <aside className={`sidebar-shell ${open?"w-60":"w-[4.25rem]"} flex-shrink-0 flex flex-col transition-all duration-200 overflow-hidden`}>
        <div className={`sidebar-brand h-16 flex items-center gap-3 flex-shrink-0 ${open?"px-4":"px-3 justify-center"}`}>
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-black text-base flex-shrink-0"
            style={{background:"linear-gradient(145deg,#8b5cf6,#7c3aed)",boxShadow:"0 4px 14px rgba(124,58,237,0.4)"}}>&#10022;</div>
          {open&&(
            <div>
              <p className="sidebar-brand-title">Smart ERP</p>
              <p className="sidebar-brand-sub">Data Dashboard</p>
            </div>
          )}
        </div>
        <nav className="sidebar-nav-wrap flex-1 overflow-y-auto">
          {visibleNav.map(n=>(
            <a key={n.key} href={n.href}
              onMouseEnter={()=>{ if(n.key==="analytics") prefetchAnalyticsCriticalDefault(auth.token); }}
              className={`nav-item sidebar-item w-full flex items-center gap-3 py-2.5 text-sm font-medium no-underline ${open?"px-4":"px-0 justify-center"} ${ERP_PAGE===n.key?"nav-active":"text-slate-500"}`}
              title={!open?n.label:undefined}>
              <span className="text-base flex-shrink-0">{n.icon}</span>
              {open&&<span>{n.label}</span>}
            </a>
          ))}
        </nav>
        <div className="flex-shrink-0 p-3">
          {open?(
            <div className="sidebar-user-card">
              <div className="flex items-center gap-2.5 mb-2">
                <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 font-bold text-sm text-white"
                  style={{background:"rgba(255,255,255,0.22)",border:"2px solid rgba(255,255,255,0.35)"}}>{avatarLetter}</div>
                <div className="min-w-0">
                  <p className="sidebar-user-name truncate">{auth.name}</p>
                  <p className="sidebar-user-email truncate">{auth.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-1 mb-2.5">
                <span className="badge" style={{background:"rgba(255,255,255,0.22)",color:"#fff",border:"none"}}>{auth.role}</span>
              </div>
              <div className="flex gap-1.5">
                <button type="button" onClick={()=>setChangePwd(true)} className="sidebar-user-action" title="Change password">&#128274;</button>
                <button type="button" onClick={()=>{clearAuth();onLogout();}} className="sidebar-user-action is-danger" title="Sign out">Sign out</button>
              </div>
            </div>
          ):(
            <button type="button" onClick={()=>{clearAuth();onLogout();}} className="w-full py-2 text-lg text-slate-400 hover:text-red-500 transition-colors" title="Logout">&rarr;</button>
          )}
        </div>
      </aside>
    );
  }

  function relogin() {
    setSessionExpired(false);
    try {
      localStorage.removeItem("erp_session");
    } catch (_) {
      /* ignore */
    }
    clearAuth();
    onLogout();
  }

  return (
    <div className="flex flex-col min-h-0 h-[100dvh] max-h-[100dvh] overflow-hidden" style={{background:"var(--bg-app)"}}>
      {sessionExpired && (
        <div
          role="alert"
          className="flex-shrink-0 flex flex-wrap items-center justify-center gap-3 px-4 py-3 text-center z-[100]"
          style={{
            background: "linear-gradient(90deg,#7f1d1d,#991b1b)",
            color: "#fecaca",
            borderBottom: "1px solid rgba(0,0,0,0.2)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
          }}
        >
          <span className="text-sm font-semibold" style={{ color: "#fff" }}>
            Your session has expired. Please log out and sign in again to continue.
          </span>
          <button
            type="button"
            onClick={relogin}
            className="text-sm font-bold px-4 py-2 rounded-lg border-0 cursor-pointer"
            style={{ background: "#fff", color: "#991b1b" }}
          >
            Log in again
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">

      {/* Mobile drawer */}
      {mobile&&drawerOpen&&(
        <div className="fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={()=>setDrawer(false)}/>
          <div className="relative z-10"><SideNav open={true}/></div>
        </div>
      )}

      {/* Desktop sidebar */}
      {showDesktopSidebar&&<SideNav open={sidebarOpen}/>}

      {/* Main */}
      <main ref={contentRef} className="flex-1 overflow-y-auto flex flex-col min-w-0">

        {/* Top bar */}
        <header className="app-header flex items-center gap-3 sticky top-0 z-20 flex-shrink-0 px-6 py-4"
          style={{paddingLeft:"max(24px,env(safe-area-inset-left,0px))",paddingRight:"max(24px,env(safe-area-inset-right,0px))"}}>
          <button onClick={()=>mobile?setDrawer(true):setSidebar(s=>!s)}
            className="text-slate-400 hover:text-slate-700 transition-colors p-2.5 rounded-xl hover:bg-slate-100 flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect y="2" width="16" height="1.5" rx="0.75"/><rect y="7.25" width="16" height="1.5" rx="0.75"/><rect y="12.5" width="16" height="1.5" rx="0.75"/>
            </svg>
          </button>
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <span className="text-lg flex-shrink-0" aria-hidden>{currentNav?.icon}</span>
            <h1 className="app-header-title truncate">{currentNav?.label}</h1>
          </div>
          <button onClick={toggleTheme} className="theme-toggle flex-shrink-0" title="Toggle theme">
            {theme==="dark"
              ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>}
          </button>
        </header>

        <div className="flex-1 min-h-0 app-main-padding fade-in">
          {renderPagePanel(auth)}
        </div>
      </main>

      </div>

      {showChangePwd&&(
        <ChangePasswordModal auth={auth} onClose={()=>setChangePwd(false)}/>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════
   APP ROOT
════════════════════════════════════════════════════ */
function App() {
  const [auth, setAuth] = useState(()=>{
    try {
      const s = localStorage.getItem("erp_session");
      if (s) { const p=JSON.parse(s); if(p&&p.token) return p; }
    } catch(_){}
    return null;
  });

  function handleLogin(session) {
    try { localStorage.setItem("erp_session",JSON.stringify(session)); } catch(_){}
    setAuth(session);
  }

  function handleLogout() {
    clearAuth();
    try {
      localStorage.removeItem("erp_session");
    } catch (_) {
      /* ignore */
    }
    setAuth(null);
  }

  if (!auth) return <LoginPage onLogin={handleLogin}/>;
  return <PageLayout auth={auth} onLogout={handleLogout}/>;
}

const _root = ReactDOM.createRoot(document.getElementById("root"));
_root.render(<App/>);
