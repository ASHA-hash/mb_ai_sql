"""
Dataset registry — keys from metadata/dataset-access.json (parity with Node DATASET_REGISTRY).
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from . import runtime_config as rc

_META = Path(__file__).parent.parent.parent / "metadata"
_TABLE = re.compile(r"^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$")

_REGISTRY_JS = Path(__file__).parent.parent.parent / "datasets-registry.js"


def _load_registry_labels() -> dict[str, str]:
    """Labels from datasets-registry.js (parity with Node buildConnectorConfig)."""
    fallback: dict[str, str] = {
        "sales": "Sales / approval lines (APP_REPORT) — MrpValue revenue; use distinct XnNo for bills (not SUM BillCount)",
        "branches": "Branch master (VwAIBranch) — store list (~116 rows); use sales/APP_REPORT for revenue by BranchAlias",
    }
    if not _REGISTRY_JS.is_file():
        return fallback
    try:
        text = _REGISTRY_JS.read_text(encoding="utf-8")
        for m in re.finditer(r'key:\s*"([^"]+)"[\s\S]*?label:\s*"([^"]+)"', text):
            fallback[m.group(1)] = m.group(2)
    except Exception:
        pass
    return fallback


def normalize_key(name: str) -> str:
    return (name or "").strip().lower().replace(" ", "_")


def load_access() -> dict[str, Any]:
    try:
        raw = json.loads((_META / "dataset-access.json").read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _env_column(prefix: str, suffix: str) -> str | None:
    key = f"{prefix}_{suffix}"
    v = (os.getenv(key) or str(rc.get(key, "") or "")).strip()
    if v and re.match(r"^[a-zA-Z_][a-zA-Z0-9_]{0,127}$", v):
        return v
    return None


def _filter_prefix_for_key(key: str, table: str) -> str:
    short = table.split(".")[-1] if "." in table else table
    if short.upper().startswith("VW_MB_POWERBI_"):
        return short.upper().replace("VW_MB_POWERBI_", "MB_POWERBI_")
    if key == "sales":
        return "MB_POWERBI_APP_REPORT"
    return short.upper()


def resolve_table(dataset_key: str) -> tuple[str | None, dict | None]:
    """
    Returns (qualified_table, access_entry) or (None, None).
    Raises ValueError with message if denied.
    """
    access = load_access()
    by_key: dict = access.get("byKey") or {}
    nk = normalize_key(dataset_key)

    entry = by_key.get(nk)
    if not entry and nk.startswith("dbo."):
        short = nk[4:]
        entry = by_key.get(short) or by_key.get(short.replace("vw_mb_powerbi_", "mb_powerbi_"))
    if not entry:
        for ent in by_key.values():
            if isinstance(ent, dict) and normalize_key(str(ent.get("table", ""))) == nk:
                entry = ent
                break

    if not entry:
        return None, None
    if entry.get("denied"):
        raise PermissionError(entry.get("message") or f"SELECT denied for dataset: {dataset_key}")

    table = (entry.get("table") or "").strip()
    if table and _TABLE.match(table):
        return table, entry
    return None, None


def build_catalog_entries() -> list[dict]:
    """Dataset list for GET /api/connector-config (registry keys, not raw dbo names)."""
    access = load_access()
    by_key: dict = access.get("byKey") or {}
    schema: dict = {}
    try:
        raw = json.loads((_META / "db_tables_views_columns.json").read_text(encoding="utf-8"))
        schema = {**raw.get("views", {}), **raw.get("tables", {})}
    except Exception:
        pass

    out: list[dict] = []
    for key in sorted(by_key.keys()):
        ent = by_key[key]
        if not isinstance(ent, dict):
            continue
        table = (ent.get("table") or "").strip()
        if not table:
            continue
        short_object = table.split(".")[-1] if "." in table else table
        prefix = _filter_prefix_for_key(key, table)
        date_col = _env_column(prefix, "FILTER_DATE_COLUMN")
        branch_col = _env_column(prefix, "FILTER_BRANCH_DIM") or _env_column(prefix, "BRANCH_DIM")
        dept_col = _env_column(prefix, "FILTER_DEPARTMENT_DIM") or _env_column(prefix, "DEPARTMENT_DIM")
        cat_col = _env_column(prefix, "FILTER_CATEGORY_DIM") or _env_column(prefix, "CATEGORY_DIM")
        cols = {}
        for sk, sv in schema.items():
            if sk.lower() == table.lower():
                cols = (sv.get("columns") or {}) if isinstance(sv, dict) else {}
                break

        labels = _load_registry_labels()
        label = labels.get(key) or f"{short_object} ({key})"
        out.append({
            "key": key,
            "label": label,
            "objectName": table,
            "shortName": short_object,
            "accessOk": not bool(ent.get("denied")),
            "accessDenied": bool(ent.get("denied")),
            "accessMessage": ent.get("message"),
            "filters": {
                "date": {"enabled": bool(date_col), "column": date_col},
                "financialYear": {
                    "enabled": bool(date_col),
                    "hint": "Apr–Mar (India-style). Use fy=FY26 or set From/To instead.",
                },
                "branch": {"enabled": bool(branch_col), "column": branch_col, "match": "equal"},
                "status": {"enabled": False, "column": None},
                "department": {"enabled": bool(dept_col), "column": dept_col, "match": "equal"},
                "category": {"enabled": bool(cat_col), "column": cat_col, "match": "equal"},
            },
            "columnCount": len(cols) if isinstance(cols, dict) else 0,
        })
    return out


def filter_for_role(datasets: list[dict], role_def: dict | None) -> list[dict]:
    """RBAC: restrict catalogue to allowed dataset keys."""
    if not role_def:
        return datasets
    allowed = role_def.get("datasets", "*")
    if allowed == "*" or allowed is None:
        return datasets
    if not isinstance(allowed, list):
        return datasets
    allow = {normalize_key(str(x)) for x in allowed}
    return [d for d in datasets if normalize_key(d.get("key", "")) in allow]
