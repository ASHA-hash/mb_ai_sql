import { useEffect, useState, useCallback } from "react";

const THEME_KEY = "erp_theme";

export function getInitialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches)
      return "dark";
  } catch { /* ignore */ }
  return "light";
}

/** Syncs `data-theme` on <html> — same localStorage key as Node dashboard (`erp_theme`). */
export function useTheme(): ["light" | "dark", () => void] {
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("erp-theme-change", { detail: { theme } }));
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return [theme, toggle];
}

/** Call once before React render (see main.tsx). */
export function applyThemeFromStorage() {
  const t = getInitialTheme();
  document.documentElement.setAttribute("data-theme", t);
}
