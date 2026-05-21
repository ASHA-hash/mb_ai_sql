"""Date ranges, India FY clipping, and cross-filter SQL fragments for analytics."""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from typing import Any, Optional


def financial_year_to_iso_range(fy_raw: str) -> Optional[dict[str, str]]:
    """FY26 → 2025-04-01 .. 2026-03-31 (India Apr–Mar)."""
    s = re.sub(r"^FY\s*", "", str(fy_raw or "").strip(), flags=re.I).upper()
    if not s:
        return None
    try:
        num = int(s)
    except ValueError:
        return None
    if 1900 <= num <= 2100:
        end_year = num
    elif 0 <= num <= 99:
        end_year = 2000 + num
    else:
        return None
    start_year = end_year - 1
    return {"from": f"{start_year}-04-01", "to": f"{end_year}-03-31"}


def _today() -> date:
    return datetime.utcnow().date()


def period_chip_range(period: str, custom_from: str = "", custom_to: str = "") -> dict[str, str]:
    """Calendar from/to (ISO) for a period chip before FY clip."""
    t = _today()
    if period == "custom" and custom_from and custom_to:
        return {"from": custom_from[:10], "to": custom_to[:10]}
    if period == "today":
        d = t.isoformat()
        return {"from": d, "to": d}
    if period == "yesterday":
        y = (t - timedelta(days=1)).isoformat()
        return {"from": y, "to": y}
    if period == "mtd":
        return {"from": date(t.year, t.month, 1).isoformat(), "to": t.isoformat()}
    if period == "qtd":
        m = t.month
        if 4 <= m <= 6:
            qs = date(t.year, 4, 1)
        elif 7 <= m <= 9:
            qs = date(t.year, 7, 1)
        elif 10 <= m <= 12:
            qs = date(t.year, 10, 1)
        else:
            qs = date(t.year - 1, 1, 1)
        return {"from": qs.isoformat(), "to": t.isoformat()}
    if period == "ytd":
        fy = t.year if t.month >= 4 else t.year - 1
        return {"from": date(fy, 4, 1).isoformat(), "to": t.isoformat()}
    if period in ("last_30d", "last30"):
        return {"from": (t - timedelta(days=30)).isoformat(), "to": t.isoformat()}
    if period in ("last_90d", "last90"):
        return {"from": (t - timedelta(days=90)).isoformat(), "to": t.isoformat()}
    if period in ("6m", "last_6m"):
        return {"from": (t - timedelta(days=183)).isoformat(), "to": t.isoformat()}
    if period in ("last_180d", "last180"):
        return {"from": (t - timedelta(days=180)).isoformat(), "to": t.isoformat()}
    if period == "last7":
        return {"from": (t - timedelta(days=7)).isoformat(), "to": t.isoformat()}
    return {"from": (t - timedelta(days=30)).isoformat(), "to": t.isoformat()}


def intersect_range(
    chip: dict[str, str], fy_raw: str
) -> tuple[dict[str, str], Optional[str], Optional[str]]:
    """Narrow chip range to FY window; returns (range, fy_label, fy_note)."""
    if not fy_raw or not str(fy_raw).strip():
        return chip, None, None
    fy = financial_year_to_iso_range(fy_raw)
    if not fy:
        return chip, None, "Invalid FY — using chip range only."
    cf, ct = chip["from"], chip["to"]
    ff, ft = fy["from"], fy["to"]
    start = max(cf, ff)
    end = min(ct, ft)
    if start > end:
        return chip, None, "FY does not overlap this period — chip range only."
    lbl = str(fy_raw).strip().upper()
    if not lbl.startswith("FY"):
        lbl = f"FY{lbl.replace('FY', '')}"
    return {"from": start, "to": end}, lbl, None


def range_to_where(dc: str, rng: dict[str, str], trend_month: str = "") -> str:
    d = f"CAST([{dc}] AS DATE)"
    if trend_month and re.match(r"^\d{4}-\d{2}$", trend_month.strip()):
        y, mo = trend_month.strip().split("-")
        last = (date(int(y), int(mo) + 1, 1) - timedelta(days=1)).day if int(mo) < 12 else 31
        from_m = f"{y}-{mo}-01"
        to_m = f"{y}-{mo}-{last:02d}"
        return f"{d} >= CAST('{from_m}' AS DATE) AND {d} <= CAST('{to_m}' AS DATE)"
    return f"{d} >= CAST('{rng['from']}' AS DATE) AND {d} <= CAST('{rng['to']}' AS DATE)"


def cross_filter_clause(cross_filter: dict[str, Any], allowed: list[str]) -> str:
    parts = []
    for col, val in (cross_filter or {}).items():
        c = re.sub(r"[^a-zA-Z0-9_]", "", str(col))
        if not c or c not in allowed:
            continue
        v = str(val or "").strip().replace("'", "''")
        if not v:
            continue
        parts.append(f"CAST([{c}] AS NVARCHAR(500)) = N'{v}'")
    return (" AND " + " AND ".join(parts)) if parts else ""


def parse_cross_filter_json(raw: Optional[str]) -> dict[str, str]:
    if not raw:
        return {}
    try:
        obj = json.loads(raw) if isinstance(raw, str) else raw
        if isinstance(obj, dict):
            return {str(k): str(v) for k, v in obj.items() if v}
    except Exception:
        pass
    return {}
