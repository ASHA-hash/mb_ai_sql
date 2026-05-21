/** Formatting and utility helpers. */

/** Node fmtRupeeAuto — Lakhs/Crores for large values; plain ₹ for avg bill etc. */
export function formatINRAuto(value: number | null | undefined): string {
  const x = parseFloat(String(value));
  if (isNaN(x) || !Number.isFinite(x)) return "—";
  if (x >= 1e7) return `₹${(x / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (x >= 1e5) return `₹${(x / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
  if (x >= 1000) return `₹${Math.round(x).toLocaleString("en-IN")}`;
  return `₹${Math.round(x).toLocaleString("en-IN")}`;
}

export function formatINR(value: number | null | undefined, decimals = 2): string {
  if (value == null || isNaN(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7)  return `${sign}₹${(abs / 1e7).toFixed(decimals)}Cr`;
  if (abs >= 1e5)  return `${sign}₹${(abs / 1e5).toFixed(decimals)}L`;
  return `${sign}₹${abs.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export function formatNum(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return "—";
  return value.toLocaleString("en-IN");
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function cn(...classes: (string | false | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

export function truncate(str: string, maxLen = 80): string {
  return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
}

export function getConfidenceBadge(c: "high" | "medium" | "low") {
  return {
    high:   { label: "High confidence",   color: "#16a34a" },
    medium: { label: "Medium confidence", color: "#d97706" },
    low:    { label: "Low confidence",    color: "#dc2626" },
  }[c] ?? { label: c, color: "#6b7280" };
}
