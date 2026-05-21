"""
Connector config — parity with Node GET /api/connector-config for dataset limits and catalogue.
"""
from fastapi import APIRouter, Depends

from ..services.auth import get_current_user
from ..services import runtime_config as rc
from .datasets import _load_schema

router = APIRouter(tags=["connector"])


@router.get("/api/connector-config")
async def connector_config(current_user: dict = Depends(get_current_user)):
    """
    Row limits come from runtime config: PostgreSQL erp_runtime_config overrides .env,
    which overrides built-in defaults. If PostgreSQL is unavailable at startup, only
    .env + defaults apply until PG is back.
    """
    page_max = rc.get_int("DATASET_PAGE_MAX", 1000)
    hard_cap = rc.get_int("DATASET_HARD_CAP", 20000)

    schema = _load_schema()
    datasets = []
    for view_name, view_obj in schema.items():
        if not isinstance(view_obj, dict):
            continue
        cols = view_obj.get("columns", {})
        short_object = view_name.split(".")[-1] if "." in view_name else view_name
        datasets.append({
            "key":          view_name,
            "label":        view_name,
            "objectName":   view_name,
            "shortName":    short_object,
            "accessOk":     None,
            "accessDenied": None,
            "accessMessage": None,
            "filters": {
                "date": {
                    "enabled": False,
                    "column": None,
                },
                "financialYear": {
                    "enabled": False,
                    "hint": "Configure filter columns in the Node connector metadata for full parity.",
                },
                "branch":     {"enabled": False, "column": None, "match": "equal"},
                "status":     {"enabled": False, "column": None},
                "department": {"enabled": False, "column": None, "match": "equal"},
                "category":   {"enabled": False, "column": None, "match": "equal"},
            },
            "columnCount": len(cols) if isinstance(cols, dict) else 0,
        })
    datasets.sort(key=lambda x: x["key"])

    role_def = current_user.get("roleDef") or {}
    raw_feats = role_def.get("features", [])
    if raw_feats == "*":
        features: list = ["*"]
    elif isinstance(raw_feats, list):
        features = raw_feats
    else:
        features = []

    return {
        "maxLimit":     page_max,
        "hardCap":      hard_cap,
        "defaultLimit": 500,
        "allowAll":     True,
        "datasetCount": len(datasets),
        "dateInputHint": "dd.mm.yyyy, dd-mm-yyyy, or yyyy-mm-dd",
        "datasets":     datasets,
        "limits": {
            "hardCap":      hard_cap,
            "pageMax":      page_max,
            "defaultLimit": 500,
        },
        "mirror": {
            "readEnabled":    False,
            "fallbackToLive": False,
            "snapshots":      [],
        },
        "userRole": {
            "email":    current_user.get("email"),
            "role":     current_user.get("role"),
            "features": features,
        },
    }
