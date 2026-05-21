import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";

export default function Landing() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    document.body.classList.add("erp-marketing-active");
    const nav = document.getElementById("navbar");
    const onScroll = () => nav?.classList.toggle("scrolled", window.scrollY > 10);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      document.body.classList.remove("erp-marketing-active");
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  const scrollToHash = useCallback((e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const target = document.querySelector(id);
    if (target) {
      const top = target.getBoundingClientRect().top + window.scrollY - 72;
      window.scrollTo({ top, behavior: "smooth" });
    }
    setDrawerOpen(false);
  }, []);

  return (
    <>
      <nav className="navbar" id="navbar">
        <div className="container navbar-inner">
          <Link to="/" className="logo">
            <div className="logo-icon">⚡</div>
            <span>Smart ERP</span>
          </Link>
          <div className="nav-links">
            <a href="#features" onClick={(e) => scrollToHash(e, "#features")}>Features</a>
            <a href="#how-it-works" onClick={(e) => scrollToHash(e, "#how-it-works")}>How it works</a>
            <a href="#data-sources" onClick={(e) => scrollToHash(e, "#data-sources")}>Data</a>
            <Link to="/login" className="btn-nav">Open Dashboard &rarr;</Link>
          </div>
          <button
            type="button"
            className="menu-toggle"
            id="menuToggle"
            aria-label="Menu"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((o) => !o)}
          >
            <span /><span /><span />
          </button>
        </div>
      </nav>

      <div className={`mobile-drawer ${drawerOpen ? "open" : ""}`} id="mobileDrawer">
        <a href="#features" onClick={(e) => scrollToHash(e, "#features")}>✨ Features</a>
        <a href="#how-it-works" onClick={(e) => scrollToHash(e, "#how-it-works")}>⚙️ How it works</a>
        <a href="#data-sources" onClick={(e) => scrollToHash(e, "#data-sources")}>🗄️ Data Sources</a>
        <Link to="/login" className="btn-nav" onClick={() => setDrawerOpen(false)}>Open Dashboard &rarr;</Link>
      </div>

      <section className="hero">
        <div className="hero-bg-blob b1" />
        <div className="hero-bg-blob b2" />
        <div className="hero-bg-blob b3" />
        <div className="container">
          <div className="hero-grid">
            <div>
              <div className="tag animate-in">✨ AI-Powered ERP Analytics</div>
              <h1 className="hero-headline animate-in delay-1">Smart ERP Connector</h1>
              <h2 className="hero-kicker animate-in delay-2">
                Ask your data<br />
                <span className="gradient-text">anything.</span>
              </h2>
              <p className="hero-sub animate-in delay-3">
                Smart ERP connects directly to your SQL database. Type a question in plain English — get live charts, tables, and plain-language insights in seconds.
              </p>
              <div className="hero-cta animate-in delay-4">
                <Link to="/login" className="btn-primary">
                  <span>Open Dashboard</span>
                  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                </Link>
                <a href="#features" className="btn-secondary" onClick={(e) => scrollToHash(e, "#features")}>
                  <span>See features</span>
                </a>
              </div>
              <div className="hero-trust animate-in delay-5">
                <div className="hero-trust-avatars">
                  <span>A</span><span>M</span><span>S</span><span>R</span>
                </div>
                <p><strong>Live database</strong> · Real-time SQL · Zero setup</p>
              </div>
            </div>

            <div className="hero-visual animate-in delay-2">
              <div className="hero-badge">
                <div className="hero-badge-dot" />
                Live database connected
              </div>
              <div className="hero-screen">
                <div className="hero-screen-bar">
                  <div className="hero-screen-dot" style={{ background: "#ef4444" }} />
                  <div className="hero-screen-dot" style={{ background: "#f59e0b" }} />
                  <div className="hero-screen-dot" style={{ background: "#10b981" }} />
                  <span style={{ color: "rgba(255,255,255,.55)", fontSize: 12, marginLeft: 8 }}>Smart ERP · AI Query</span>
                </div>
                <div className="hero-screen-content">
                  <div className="hero-query-box">
                    <span style={{ fontSize: 16 }}>✨</span>
                    Top 10 products by sales this month
                  </div>
                  <div className="hero-chart-bars">
                    <div className="hero-bar" /><div className="hero-bar" /><div className="hero-bar" /><div className="hero-bar" />
                    <div className="hero-bar" /><div className="hero-bar" /><div className="hero-bar" />
                  </div>
                  <div className="hero-stats-row">
                    <div className="hero-stat"><strong>₹4.2L</strong>Top Product</div>
                    <div className="hero-stat"><strong>10</strong>Results</div>
                    <div className="hero-stat"><strong>0.8s</strong>Query Time</div>
                  </div>
                </div>
              </div>
              <div className="hero-badge2">
                <span>📊</span> 42 views available
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="metrics-section">
        <div className="container">
          <div className="metrics-grid">
            <div className="metric-item animate-in">
              <div className="metric-num">40+</div>
              <div className="metric-label">Database Views</div>
            </div>
            <div className="metric-item animate-in delay-1">
              <div className="metric-num">&lt;1s</div>
              <div className="metric-label">Query Response Time</div>
            </div>
            <div className="metric-item animate-in delay-2">
              <div className="metric-num">100%</div>
              <div className="metric-label">SQL Server Native</div>
            </div>
            <div className="metric-item animate-in delay-3">
              <div className="metric-num">0</div>
              <div className="metric-label">Manual SQL Required</div>
            </div>
          </div>
        </div>
      </div>

      <section className="section section-alt" id="features">
        <div className="container">
          <div className="section-header">
            <div className="tag">✦ Features</div>
            <h2>Everything your team needs<br /><span className="gradient-text">in one place</span></h2>
            <p>From natural language queries to live data exploration — Smart ERP puts your entire database at your fingertips.</p>
          </div>
          <div className="features-grid">
            <div className="feature-card animate-in">
              <div className="feature-icon" style={{ background: "linear-gradient(135deg,rgba(99,102,241,.15),rgba(139,92,246,.1))" }}>✨</div>
              <h3>AI Query Engine</h3>
              <p>Type questions in plain English. The AI generates optimized T-SQL, runs it live against your database, and explains the results in natural language.</p>
              <div className="feature-chips">
                <span className="feature-chip">GPT-4o</span>
                <span className="feature-chip">Auto-retry</span>
                <span className="feature-chip">Self-healing</span>
              </div>
            </div>
            <div className="feature-card animate-in delay-1">
              <div className="feature-icon" style={{ background: "linear-gradient(135deg,rgba(16,185,129,.15),rgba(13,148,136,.1))" }}>📊</div>
              <h3>Live Data Explorer</h3>
              <p>Browse all your database views and tables with filters, sorting, date ranges, and branch/category segmentation. Export to Excel in one click.</p>
              <div className="feature-chips">
                <span className="feature-chip">40+ views</span>
                <span className="feature-chip">Excel export</span>
                <span className="feature-chip">Deep filters</span>
              </div>
            </div>
            <div className="feature-card animate-in delay-2">
              <div className="feature-icon" style={{ background: "linear-gradient(135deg,rgba(245,158,11,.15),rgba(234,88,12,.1))" }}>📈</div>
              <h3>Smart Charts</h3>
              <p>Bar, line, and pie charts auto-generated from query results. Click any bar to drill down. Export charts as PNG for reports and presentations.</p>
              <div className="feature-chips">
                <span className="feature-chip">ECharts</span>
                <span className="feature-chip">Drill-down</span>
                <span className="feature-chip">PNG export</span>
              </div>
            </div>
            <div className="feature-card animate-in delay-1">
              <div className="feature-icon" style={{ background: "linear-gradient(135deg,rgba(219,39,119,.15),rgba(147,51,234,.1))" }}>🔄</div>
              <h3>Google Sheets Sync</h3>
              <p>Sync any dataset directly to Google Sheets on demand. Schedule automatic exports or trigger them manually from the dashboard.</p>
              <div className="feature-chips">
                <span className="feature-chip">Google API</span>
                <span className="feature-chip">Scheduled</span>
                <span className="feature-chip">On-demand</span>
              </div>
            </div>
            <div className="feature-card animate-in delay-2">
              <div className="feature-icon" style={{ background: "linear-gradient(135deg,rgba(99,102,241,.15),rgba(59,130,246,.1))" }}>🔒</div>
              <h3>Role-Based Access</h3>
              <p>Manager, viewer, and admin roles with per-feature permissions. Google SSO login ensures only authorized users can access sensitive data.</p>
              <div className="feature-chips">
                <span className="feature-chip">Google SSO</span>
                <span className="feature-chip">RBAC</span>
                <span className="feature-chip">Per-feature</span>
              </div>
            </div>
            <div className="feature-card animate-in delay-3">
              <div className="feature-icon" style={{ background: "linear-gradient(135deg,rgba(16,185,129,.15),rgba(99,102,241,.1))" }}>🌙</div>
              <h3>Dark Mode + Mobile Ready</h3>
              <p>Fully responsive across all screen sizes — phone, tablet, desktop. Persistent dark/light theme with system preference detection.</p>
              <div className="feature-chips">
                <span className="feature-chip">Dark mode</span>
                <span className="feature-chip">Responsive</span>
                <span className="feature-chip">Touch-ready</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="how-it-works">
        <div className="container">
          <div className="section-header">
            <div className="tag">⚙️ How It Works</div>
            <h2>From question to insight<br /><span className="gradient-text">in 4 steps</span></h2>
            <p>No SQL knowledge needed. Smart ERP handles the complexity so your team can focus on decisions.</p>
          </div>
          <div className="how-grid">
            <div className="how-step animate-in">
              <div className="how-num">1</div>
              <h4>Type your question</h4>
              <p>Ask anything in plain English — &quot;Show me top 10 products this month&quot; or &quot;Which branches had zero sales last week?&quot;</p>
            </div>
            <div className="how-step animate-in delay-1">
              <div className="how-num" style={{ background: "linear-gradient(135deg,#8b5cf6,#ec4899)" }}>2</div>
              <h4>AI builds the SQL</h4>
              <p>GPT-4o generates optimized T-SQL using your live schema. A semantic guard validates the query before execution.</p>
            </div>
            <div className="how-step animate-in delay-2">
              <div className="how-num" style={{ background: "linear-gradient(135deg,#ec4899,#f59e0b)" }}>3</div>
              <h4>Live results</h4>
              <p>The query runs directly against your SQL Server database in real time. Zero data copying, zero stale caches.</p>
            </div>
            <div className="how-step animate-in delay-3">
              <div className="how-num" style={{ background: "linear-gradient(135deg,#f59e0b,#10b981)" }}>4</div>
              <h4>Charts + Insights</h4>
              <p>Results appear as interactive charts and tables with a plain-English summary. Export to Excel or Google Sheets.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt" id="data-sources">
        <div className="container">
          <div className="section-header">
            <div className="tag">🗄️ Data Sources</div>
            <h2>All your ERP data,<br /><span className="gradient-text">connected and ready</span></h2>
            <p>Smart ERP reads from your existing Microsoft SQL Server views — no data migration or ETL required.</p>
          </div>
          <div className="sources-grid">
            {[
              ["💰", "Sales Data", "Invoices, transactions, revenue"],
              ["📦", "Stock & Inventory", "Quantity, reorder levels, movement"],
              ["🛒", "Purchase Reports", "Vendors, PO amounts, GRN data"],
              ["👥", "Customers", "Details, lifetime value, segments"],
              ["🏪", "Branches", "Multi-branch performance tracking"],
              ["🧑‍💼", "Salesperson", "Revenue rankings, targets"],
              ["📊", "Power BI Views", "VW_MB_POWERBI_* analytics views"],
              ["🗂️", "Item Masters", "Products, categories, articles"],
            ].map(([icon, title, desc]) => (
              <div key={String(title)} className="source-card animate-in">
                <div className="source-icon">{icon}</div>
                <h4>{title}</h4>
                <p>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="cta-section">
        <div className="container">
          <div className="cta-card">
            <h2>Ready to ask your data<br />anything?</h2>
            <p>Your dashboard is live and connected. Open it to start exploring your business data with AI.</p>
            <div className="cta-btns">
              <Link to="/login" className="btn-white">🚀 Open Dashboard</Link>
              <Link to="/login" className="btn-outline-white">✨ Try AI Query</Link>
            </div>
          </div>
        </div>
      </section>

      <footer>
        <div className="container">
          <div className="footer-inner">
            <Link to="/" className="logo" style={{ textDecoration: "none" }}>
              <div className="logo-icon" style={{ width: 30, height: 30, fontSize: 15 }}>⚡</div>
              <span style={{ fontSize: 15 }}>Smart ERP</span>
            </Link>
            <div className="footer-links">
              <Link to="/login">Dashboard</Link>
              <a href="#features" onClick={(e) => scrollToHash(e, "#features")}>Features</a>
              <span style={{ cursor: "default", opacity: 0.7 }}>Privacy</span>
              <span style={{ cursor: "default", opacity: 0.7 }}>Terms</span>
            </div>
            <p className="footer-copy">© 2026 Smart ERP. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </>
  );
}
