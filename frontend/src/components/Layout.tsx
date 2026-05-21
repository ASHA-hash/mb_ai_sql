import { useEffect, useState, useMemo } from "react";
import { Outlet, NavLink, useNavigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/useTheme";

type NavItem = {
  to: string;
  key: string;
  label: string;
  icon: string;
  feature: string | null;
};

type NavSection = {
  id: string;
  label: string;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    id: "main",
    label: "Overview",
    items: [
      { to: "/dashboard", key: "home", label: "Home", icon: "\u{1F3E0}", feature: null },
      { to: "/analytics", key: "analytics", label: "Analytics", icon: "\u{1F4C8}", feature: "data" },
      { to: "/ai-query", key: "ai", label: "AI Query", icon: "✨", feature: "ai" },
    ],
  },
  {
    id: "data",
    label: "Data",
    items: [
      { to: "/data", key: "data", label: "Data", icon: "\u{1F4CA}", feature: "data" },
      { to: "/explorer", key: "explorer", label: "Explorer", icon: "\u{1F50E}", feature: "explorer" },
    ],
  },
  {
    id: "ai",
    label: "Intelligence",
    items: [{ to: "/rag", key: "rag", label: "RAG Memory", icon: "\u{1F9E0}", feature: "ai" }],
  },
  {
    id: "ops",
    label: "Operations",
    items: [{ to: "/schedule", key: "schedule", label: "Schedule", icon: "⏱", feature: "schedule" }],
  },
  {
    id: "system",
    label: "System",
    items: [
      { to: "/admin", key: "admin", label: "Admin", icon: "\u{1F511}", feature: "admin" },
      { to: "/settings", key: "settings", label: "Settings", icon: "⚙", feature: null },
    ],
  },
];

const ALL_NAV: NavItem[] = NAV_SECTIONS.flatMap(s => s.items);

function hasFeature(features: string[] | "*" | undefined, f: string | null): boolean {
  if (!f) return true;
  if (!features) return true;
  if (features === "*") return true;
  return features.includes(f);
}

function resolveCurrentNav(pathname: string, items: NavItem[]): NavItem | undefined {
  const sorted = [...items].sort((a, b) => b.to.length - a.to.length);
  return (
    sorted.find(n => pathname === n.to || (n.to !== "/dashboard" && pathname.startsWith(n.to))) ??
    items.find(n => n.key === "home")
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, toggleTheme] = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    const q = window.matchMedia("(max-width: 639px)");
    const set = () => {
      const m = q.matches;
      setMobile(m);
      if (m) setSidebarOpen(false);
      else setDrawerOpen(false);
    };
    set();
    q.addEventListener("change", set);
    return () => q.removeEventListener("change", set);
  }, []);

  const visibleSections = useMemo(() => {
    const feats = user?.roleDef?.features;
    return NAV_SECTIONS.map(sec => ({
      ...sec,
      items: sec.items.filter(n => hasFeature(feats, n.feature)),
    })).filter(sec => sec.items.length > 0);
  }, [user?.roleDef?.features]);

  const visibleNav = useMemo(() => visibleSections.flatMap(s => s.items), [visibleSections]);

  const currentNav = resolveCurrentNav(location.pathname, visibleNav.length ? visibleNav : ALL_NAV);

  const avatarLetter = (user?.name || user?.email || "?")[0].toUpperCase();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  function SideNav({ open }: { open: boolean }) {
    return (
      <aside
        className={`sidebar-shell sidebar-enhanced ${open ? "w-60" : "w-[4.25rem]"} flex-shrink-0 flex flex-col transition-all duration-200 overflow-hidden`}
      >
        <div
          className={`sidebar-brand h-16 flex items-center gap-3 flex-shrink-0 ${open ? "px-4" : "px-3 justify-center"}`}
        >
          <div className="sidebar-logo-mark">&#10022;</div>
          {open && (
            <div className="min-w-0 flex-1">
              <p className="sidebar-brand-title">Smart ERP</p>
              <p className="sidebar-brand-sub">Data Dashboard</p>
            </div>
          )}
          {!mobile && (
            <button
              type="button"
              onClick={() => setSidebarOpen(s => !s)}
              className={`sidebar-collapse-btn ${open ? "" : "is-collapsed"}`}
              title={open ? "Collapse sidebar" : "Expand sidebar"}
              aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d={open ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5"} />
              </svg>
            </button>
          )}
        </div>

        <nav className="sidebar-nav-wrap flex-1 overflow-y-auto overflow-x-hidden">
          {visibleSections.map((sec, si) => (
            <div key={sec.id} className="sidebar-nav-section">
              {open && <p className="sidebar-nav-label">{sec.label}</p>}
              {!open && si > 0 && <div className="sidebar-nav-divider" aria-hidden />}
              {sec.items.map(n => (
                <NavLink
                  key={n.key}
                  to={n.to}
                  end={n.to === "/dashboard"}
                  onClick={() => mobile && setDrawerOpen(false)}
                  className={({ isActive }) =>
                    `nav-item sidebar-item w-full flex items-center gap-3 py-2.5 text-sm font-medium no-underline ${
                      open ? "px-3 mx-2" : "px-0 justify-center mx-auto"
                    } ${isActive ? "nav-active" : ""}`
                  }
                  title={!open ? n.label : undefined}
                >
                  <span className="nav-icon-wrap" aria-hidden>
                    <span className="text-base leading-none">{n.icon}</span>
                  </span>
                  {open && <span className="truncate">{n.label}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {open && (
          <div className="px-4 pb-2 flex-shrink-0">
            <span className="sidebar-version-pill">Python API v2</span>
          </div>
        )}

        <div className="flex-shrink-0 p-3">
          {open ? (
            <div className="sidebar-user-card">
              <div className="flex items-center gap-2.5 mb-2">
                <div className="sidebar-avatar">{avatarLetter}</div>
                <div className="min-w-0">
                  <p className="sidebar-user-name truncate">{user?.name || "User"}</p>
                  <p className="sidebar-user-email truncate">{user?.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-1 mb-2.5">
                <span className="badge sidebar-role-badge">{user?.role}</span>
              </div>
              <div className="flex gap-1.5">
                <Link to="/settings" className="sidebar-user-action flex-1 no-underline text-center" title="Settings">
                  &#x2699;
                </Link>
                <button type="button" onClick={handleLogout} className="sidebar-user-action is-danger flex-1" title="Sign out">
                  Sign out
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Link to="/settings" className="text-lg opacity-70 hover:opacity-100" title="Settings">
                &#x2699;
              </Link>
              <button
                type="button"
                onClick={handleLogout}
                className="w-full py-2 text-lg text-slate-400 hover:text-red-500 transition-colors"
                title="Logout"
              >
                &rarr;
              </button>
            </div>
          )}
        </div>
      </aside>
    );
  }

  return (
    <div className="flex flex-col min-h-0 h-[100dvh] max-h-[100dvh] overflow-hidden" style={{ background: "var(--bg-app)" }}>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {mobile && drawerOpen && (
          <div className="fixed inset-0 z-40 flex">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
            <div className="relative z-10 shadow-2xl">
              <SideNav open={true} />
            </div>
          </div>
        )}

        {!mobile && <SideNav open={sidebarOpen} />}

        <main
          className={
            location.pathname === "/ai-query"
              ? "flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden"
              : "flex-1 overflow-y-auto flex flex-col min-w-0"
          }
        >
          <header
            className="app-header flex items-center gap-3 sticky top-0 z-20 flex-shrink-0 px-6 py-4"
            style={{
              paddingLeft: "max(24px,env(safe-area-inset-left,0px))",
              paddingRight: "max(24px,env(safe-area-inset-right,0px))",
            }}
          >
            <button
              type="button"
              onClick={() => (mobile ? setDrawerOpen(true) : setSidebarOpen(s => !s))}
              className="text-slate-400 hover:text-slate-700 transition-colors p-2.5 rounded-xl hover:bg-slate-100 flex-shrink-0"
              aria-label="Toggle menu"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <rect y="2" width="16" height="1.5" rx="0.75" />
                <rect y="7.25" width="16" height="1.5" rx="0.75" />
                <rect y="12.5" width="16" height="1.5" rx="0.75" />
              </svg>
            </button>
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <span className="app-header-icon" aria-hidden>
                {currentNav?.icon}
              </span>
              <div className="min-w-0">
                <h1 className="app-header-title truncate">{currentNav?.label}</h1>
                {currentNav && (
                  <p className="app-header-sub truncate hidden sm:block">
                    Smart ERP &middot; {user?.role ?? "user"}
                  </p>
                )}
              </div>
            </div>
            <button type="button" onClick={toggleTheme} className="theme-toggle flex-shrink-0" title="Toggle theme">
              {theme === "dark" ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
                </svg>
              )}
            </button>
          </header>

          <div
            className={
              location.pathname === "/ai-query"
                ? "flex-1 min-h-0 app-main-ai-query fade-in"
                : "flex-1 min-h-0 app-main-padding fade-in"
            }
          >
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
