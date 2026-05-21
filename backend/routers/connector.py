"""
Connector config — parity with Node GET /api/connector-config for dataset limits and catalogue.
"""
from fastapi import APIRouter, Depends

from ..services.auth import get_current_user
from ..services import runtime_config as rc
from ..services.dataset_registry import build_catalog_entries, filter_for_role

router = APIRouter(tags=["connector"])


@router.get("/api/connector-config")
async def connector_config(current_user: dict = Depends(get_current_user)):
    """
    Row limits come from runtime config: PostgreSQL erp_runtime_config overrides .env,
    which overrides built-in defaults.
    """
    page_max = rc.get_int("DATASET_PAGE_MAX", 1000)
    hard_cap = rc.get_int("DATASET_HARD_CAP", 20000)

    datasets = filter_for_role(build_catalog_entries(), current_user.get("roleDef"))

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
