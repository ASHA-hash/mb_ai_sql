import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";
import AIQuery from "./pages/AIQuery";
import Analytics from "./pages/Analytics";
import Admin from "./pages/Admin";
import RAGPanel from "./pages/RAGPanel";
import Data from "./pages/Data";
import Explorer from "./pages/Explorer";
import Schedule from "./pages/Schedule";
import Settings from "./pages/Settings";

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen"><div className="spinner w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Public marketing home; signed-in users skip straight to the app shell. */
function LandingGate() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--color-bg)" }}>
        <div className="spinner w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
      </div>
    );
  }
  if (user) return <Navigate to="/dashboard" replace />;
  return <Landing />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingGate />} />
          <Route path="/login" element={<Login />} />
          <Route element={<PrivateRoute><Layout /></PrivateRoute>}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/ai-query"  element={<AIQuery />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/rag"       element={<RAGPanel />} />
            <Route path="/data"      element={<Data />} />
            <Route path="/explorer"  element={<Explorer />} />
            <Route path="/schedule"  element={<Schedule />} />
            <Route path="/settings"  element={<Settings />} />
            <Route path="/admin"     element={<Admin />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
