/**
 * Auth context — stores the logged-in user and token, provides login/logout.
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { auth as authApi, setToken, getToken, type User } from "./api";

interface AuthContextType {
  user:    User | null;
  token:   string | null;
  loading: boolean;
  login:   (email: string, password: string) => Promise<void>;
  logout:  () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,    setUser]    = useState<User | null>(null);
  const [token,   setTok]     = useState<string | null>(getToken());
  const [loading, setLoading] = useState(true);

  // On mount: verify existing token
  useEffect(() => {
    if (!token) { setLoading(false); return; }
    authApi.me()
      .then(u => setUser(u))
      .catch(() => { setToken(null); setTok(null); })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    setToken(res.token);
    setTok(res.token);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setTok(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
