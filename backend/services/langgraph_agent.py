"""
LangGraph SQL agent — Python port of ai-langchain-query.js.

StateGraph nodes:
  pre_flight_gate → retrieve_context → resolve_intent → discover_column_values
  → generate_sql → check_sql → execute_sql → [error_recovery ×3] → generate_answer

Key accuracy features:
  • Schema loaded from db_tables_views_columns.json (exact column names, no hallucination)
  • Semantic mapping injection (business term → exact column)
  • Value sampling before SQL gen (prevents hallucinated WHERE values)
  • Compliance guard (blocks/repairs illegal column names)
  • Self-healing retry loop (up to 3 attempts on SQL error)
  • Multi-turn conversation context
  • RAG memory (similar past Q→SQL pairs injected)
"""
from __future__ import annotations

import os
import re
import json
import asyncio
from pathlib import Path
from typing import Any, Optional, Annotated
from datetime import datetime, date

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import StateGraph, END, START
from langgraph.graph.message import add_messages
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "../../.env"))

_BASE = Path(__file__).parent.parent.parent
_META = _BASE / "metadata"

# ── Schema cache ──────────────────────────────────────────────────────────────
_SCHEMA: dict = {}
_SEMANTIC_MAPPING: dict = {}
_GOLDEN_QUERIES: list = []

def _load_schema() -> dict:
    global _SCHEMA
    if _SCHEMA:
        return _SCHEMA
    try:
        raw = json.loads((_META / "db_tables_views_columns.json").read_text())
        views = raw.get("views", {})
        tables = raw.get("tables", {})
        _SCHEMA = {**views, **tables}
    except Exception as e:
        print(f"[langgraph] schema load failed: {e}")
        _SCHEMA = {}
    return _SCHEMA


def _load_semantic_mapping() -> dict:
    global _SEMANTIC_MAPPING
    if _SEMANTIC_MAPPING:
        return _SEMANTIC_MAPPING
    try:
        _SEMANTIC_MAPPING = json.loads((_META / "semantic-mapping-layer.json").read_text())
    except Exception:
        _SEMANTIC_MAPPING = {"prompt_injection": ""}
    return _SEMANTIC_MAPPING


def _get_semantic_mapping_prompt() -> str:
    return _load_semantic_mapping().get("prompt_injection", "")


def _load_golden_queries() -> list:
    global _GOLDEN_QUERIES
    if _GOLDEN_QUERIES:
        return _GOLDEN_QUERIES
    try:
        _GOLDEN_QUERIES = json.loads((_META / "golden_queries.json").read_text())
    except Exception:
        _GOLDEN_QUERIES = []
    return _GOLDEN_QUERIES


# ── LLM factory ──────────────────────────────────────────────────────────────
def _make_llm(provider: str = "openai", temperature: float = 0.0):
    from . import runtime_config as rc
    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(
            model=rc.get("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
            temperature=temperature,
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY"),
            max_tokens=4096,
        )
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(
        model=rc.get("OPENAI_MODEL", "gpt-4o-mini"),
        temperature=temperature,
        openai_api_key=os.getenv("OPENAI_API_KEY"),
    )


# ── Schema formatting ─────────────────────────────────────────────────────────
def _format_schema(view_names: list[str]) -> str:
    schema = _load_schema()
    lines = []
    for vn in view_names:
        obj = schema.get(vn)
        if not obj:
            continue
        cols = obj.get("columns", {}) if isinstance(obj, dict) else {}
        lines.append(f"\n{vn}:")
        for col_name, col_info in cols.items():
            dt = col_info.get("data_type", "varchar") if isinstance(col_info, dict) else "unknown"
            nullable = col_info.get("is_nullable", True) if isinstance(col_info, dict) else True
            lines.append(f"  {col_name} ({dt}{', nullable' if nullable else ''})")
    return "\n".join(lines) if lines else "(no schema available)"


def _get_all_view_names() -> list[str]:
    return list(_load_schema().keys())


# ── SQL helpers ───────────────────────────────────────────────────────────────
def _extract_sql(text: str) -> str:
    if not text:
        return ""
    m = re.search(r"```(?:sql)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    idx = text.upper().find("SELECT")
    if idx >= 0:
        return re.sub(r";+\s*$", "", text[idx:]).strip()
    return text.strip()


_ILLEGAL_COLUMNS = {
    "SaleNetAmount": "MrpValue",
    "NetSlsNetAmount": "MrpValue",
    "NetSalesAmount": "MrpValue",
    "Quantity": "AppQty",
    "Qty": "AppQty",
    "InvoiceNo": "XnNo",
    "InvoiceDt": "XnDt",
    "CashmemoDt": "XnDt",
    "SaleDate": "XnDt",
    "BranchId": "BranchAlias",
    "BranchName": "BranchAlias",
    "Colour": "Color",
    "SizeName": "Size",
}


def _remap_legacy_columns(sql: str) -> str:
    for old, new in _ILLEGAL_COLUMNS.items():
        sql = re.sub(rf"\b{re.escape(old)}\b", new, sql)
    return sql


def _enforce_top_limit(sql: str, limit: int = 1000) -> str:
    if not re.search(r"\bTOP\s+\d+\b", sql, re.IGNORECASE):
        sql = re.sub(r"\bSELECT\b", f"SELECT TOP {limit}", sql, count=1, flags=re.IGNORECASE)
    return sql


def _get_sales_table() -> str:
    from . import runtime_config as rc
    import os
    return (
        (os.getenv("ANALYTICS_BASE_TABLE") or "").strip()
        or str(rc.get("ANALYTICS_BASE_TABLE", "")).strip()
        or str(rc.get("SALES_AI_TABLE", "dbo.VW_MB_POWERBI_SLS_REPORT")).strip()
        or "dbo.VW_MB_POWERBI_SLS_REPORT"
    )


def _infer_domain(question: str) -> str:
    q = question.lower()
    if any(w in q for w in ["purchase", "supplier", "vendor", "po ", "grn", "bought", "prt", "pur return"]):
        return "purchase"
    if re.search(r"\bpurchase\s+returns?\b", q):
        return "purchase"
    if any(w in q for w in ["stock", "inventory", "item", "article", "sku"]):
        return "stock"
    if any(w in q for w in ["customer", "client", "loyalty", "member"]):
        return "customer"
    return "sales"


def _select_views_for_question(question: str) -> list[str]:
    """Simple heuristic: pick relevant views based on domain keywords."""
    domain = _infer_domain(question)
    from . import runtime_config as rc
    if domain == "purchase":
        q = question.lower()
        if re.search(r"\breturns?\b", q):
            return [
                "dbo.VW_MB_POWERBI_PRT_REPORT",
                "dbo.VW_MB_POWERBI_PURXNS_REPORT",
                "dbo.VW_MB_POWERBI_PUR_REPORT",
            ]
        return [
            "dbo.VW_MB_POWERBI_PUR_REPORT",
            "dbo.VW_MB_POWERBI_PURXNS_REPORT",
            "dbo.VW_MB_POWERBI_VENDOR_MASTER",
        ]
    if domain == "stock":
        return [
            "dbo.VW_MB_POWERBI_STOCK_REPORT",
            rc.get("STOCK_VIEW", "dbo.VwAIStockData"),
        ]
    if domain == "customer":
        return [
            rc.get("CUSTOMER_VIEW", "dbo.VwAICustomerDetails"),
        ]
    # sales default — rollup first (matches Analytics), line facts second
    primary = _get_sales_table()
    return [
        primary,
        "dbo.VW_MB_POWERBI_SLSXNS_REPORT",
        rc.get("SALES_AI_TABLE", "dbo.VW_MB_POWERBI_APP_REPORT"),
        rc.get("SALES_VIEW", "dbo.VwAISalesData"),
    ]


# ── State definition ──────────────────────────────────────────────────────────
from typing import TypedDict


def _last(a, b):
    return b if b is not None else a


def _append(a, b):
    return (a or []) + (b or [])


class AgentState(TypedDict, total=False):
    # Inputs
    ai_provider:           str
    question:              str
    original_question:     str
    adaptive_enrichment:   str
    date_context:          str
    table_hint:            str
    user_date_range:       Optional[dict]
    conversation_history:  list[dict]

    # Schema
    top_views:             list[str]
    schema_text:           str

    # SQL lifecycle
    generated_sql:         str
    checked_sql:           str
    execution_result:      Optional[dict]
    retry_count:           int
    retry_errors:          list[str]
    system_observations:   list[str]
    zero_rows_retried:     bool

    # RAG
    rag_context:           str

    # Intent
    query_intent:          Optional[dict]

    # Column value discovery
    column_discovery_text: str
    live_column_samples:   dict
    sql_validation_failed: bool

    # Pre-flight
    next_step:             str
    target_view:           str
    clarity_score:         float
    fast_path_sql:         str
    clarification_message: str

    # Output
    final_answer:          str
    final_data:            list
    final_sql:             str
    confidence:            str
    confidence_note:       str

    # Trace
    node_log:              list[str]


# ── NODE: pre_flight_gate ─────────────────────────────────────────────────────
async def pre_flight_gate(state: AgentState) -> AgentState:
    print("[langgraph] node: pre_flight_gate")
    question = state.get("question", "")
    table_hint = state.get("table_hint", "")

    # Determine target view
    target_views = _select_views_for_question(question)
    if table_hint:
        schema = _load_schema()
        for key in schema:
            if table_hint.lower() in key.lower():
                target_views = [key] + [v for v in target_views if v != key]
                break

    schema_text = _format_schema(target_views[:3])

    return {
        **state,
        "next_step":     "CONTINUE",
        "top_views":     target_views,
        "target_view":   target_views[0] if target_views else _get_sales_table(),
        "schema_text":   schema_text,
        "clarity_score": 1.0,
        "node_log":      (state.get("node_log") or []) + ["pre_flight_gate"],
    }


# ── NODE: retrieve_context ────────────────────────────────────────────────────
async def retrieve_context(state: AgentState) -> AgentState:
    print("[langgraph] node: retrieve_context (RAG)")
    question = state.get("question", "")

    try:
        from . import rag_store
        examples  = await rag_store.search(question, 5, {"type": "example"})
        glossary  = await rag_store.search(question, 4, {"type": "glossary"})

        rel_examples = [r for r in examples if r["score"] >= 0.65]
        rel_glossary = [r for r in glossary  if r["score"] >= 0.60]

        ctx = ""
        if rel_examples:
            ctx += "═══ SIMILAR PAST QUERIES — follow these exact patterns ═══\n"
            for ex in rel_examples:
                ctx += f"Q: {ex['metadata'].get('question', '')}\n"
                ctx += f"SQL:\n{ex['metadata'].get('sql', '')}\n"
                if ex["metadata"].get("note"):
                    ctx += f"Note: {ex['metadata']['note']}\n"
                ctx += "\n"
        if rel_glossary:
            ctx += "═══ BUSINESS GLOSSARY ═══\n"
            for g in rel_glossary:
                ctx += f"• {g['metadata'].get('term', '')}: {g['metadata'].get('definition', '')}\n"
            ctx += "\n"

        print(f"[langgraph] RAG: {len(rel_examples)} examples, {len(rel_glossary)} glossary entries")
        return {
            **state,
            "rag_context": ctx.strip(),
            "node_log": (state.get("node_log") or []) + [f"retrieve_context:{len(rel_examples)}ex"],
        }
    except Exception as e:
        print(f"[langgraph] RAG retrieve error (non-fatal): {e}")
        return {**state, "rag_context": "", "node_log": (state.get("node_log") or []) + ["retrieve_context:skipped"]}


# ── NODE: resolve_intent ──────────────────────────────────────────────────────
async def resolve_intent(state: AgentState) -> AgentState:
    from . import runtime_config as rc
    if not rc.get_bool("ADAPTIVE_INTENT_STEP", False):
        return {**state, "query_intent": None, "node_log": (state.get("node_log") or []) + ["resolve_intent:off"]}

    print("[langgraph] node: resolve_intent")
    provider = state.get("ai_provider", "openai")

    system_prompt = f"""You are an ERP query intent analyser.
Given a natural language question, extract a structured intent as JSON.

Return ONLY valid JSON:
{{
  "metric_intent": "sales|purchase|stock|customer|generic",
  "time_period": "today|yesterday|mtd|qtd|ytd|custom|none",
  "dimensions": ["BranchAlias","Department"],
  "filters": {{"BranchAlias": "DELHI"}},
  "aggregation": "sum|count|avg|list",
  "top_n": 10,
  "sort": "desc|asc",
  "notes": "any special instructions"
}}

Schema context:
{state.get('schema_text', '')}
"""
    user_prompt = f"Question: {state.get('question', '')}"
    if state.get("original_question"):
        user_prompt += f"\nOriginal: {state['original_question']}"

    try:
        llm = _make_llm(provider)
        response = await llm.ainvoke([SystemMessage(content=system_prompt), HumanMessage(content=user_prompt)])
        text = response.content
        # Extract JSON
        m = re.search(r"\{[\s\S]*\}", text)
        intent = json.loads(m.group(0)) if m else None
        if intent:
            print(f"[langgraph] intent: {intent.get('metric_intent')} / {intent.get('time_period')}")
        return {
            **state,
            "query_intent": intent,
            "node_log": (state.get("node_log") or []) + ["resolve_intent"],
        }
    except Exception as e:
        print(f"[langgraph] resolve_intent failed (non-fatal): {e}")
        return {**state, "query_intent": None, "node_log": (state.get("node_log") or []) + ["resolve_intent:error"]}


# ── NODE: discover_column_values ──────────────────────────────────────────────
async def discover_column_values(state: AgentState) -> AgentState:
    from . import runtime_config as rc
    q = (state.get("original_question") or state.get("question") or "").lower()
    if _infer_domain(q) == "purchase":
        return {**state, "column_discovery_text": "", "node_log": (state.get("node_log") or []) + ["discover_column_values:skip_purchase"]}
    if not rc.get_bool("COGNITIVE_COLUMN_DISCOVERY", False):
        return {**state, "column_discovery_text": "", "node_log": (state.get("node_log") or []) + ["discover_column_values:off"]}

    print("[langgraph] node: discover_column_values")
    question = state.get("original_question") or state.get("question", "")
    target_view = state.get("target_view", _get_sales_table())

    # Extract potential filter values from the question
    samples: dict[str, list] = {}
    discovery_lines = []

    # Try to sample values from SQL Server for key dimension columns
    dimension_cols = []
    schema = _load_schema()
    view_obj = schema.get(target_view, {})
    if isinstance(view_obj, dict):
        cols = view_obj.get("columns", {})
        for col_name, col_info in cols.items():
            dt = col_info.get("data_type", "") if isinstance(col_info, dict) else ""
            if dt in ("varchar", "nvarchar", "char") and any(
                kw in col_name.lower() for kw in ["branch", "dept", "department", "category", "city", "region", "name"]
            ):
                dimension_cols.append(col_name)

    if dimension_cols:
        try:
            from .db_mssql import execute_query
            timeout_ms = rc.get_int("DB_REQUEST_TIMEOUT_MS", 30000)
            for col in dimension_cols[:4]:  # Limit to 4 cols to keep latency low
                try:
                    rows = await asyncio.wait_for(
                        execute_query(
                            f"SELECT DISTINCT TOP 20 [{col}] FROM {target_view} WHERE [{col}] IS NOT NULL ORDER BY [{col}]"
                        ),
                        timeout=min(timeout_ms / 1000, 5.0),
                    )
                    vals = [str(r.get(col, "")) for r in rows if r.get(col)]
                    if vals:
                        samples[col] = vals
                        discovery_lines.append(f"• {col} values: {', '.join(vals[:10])}")
                except Exception:
                    pass
        except Exception as e:
            print(f"[langgraph] column sampling failed (non-fatal): {e}")

    # Build correction block for typos in the question
    correction_lines = []
    for col, vals in samples.items():
        for word in re.findall(r"\b[A-Za-z]{3,}\b", question):
            # Simple fuzzy match — if word is close to a value, inject correction
            for v in vals:
                if (word.lower() in v.lower() or v.lower() in word.lower()) and word.lower() != v.lower():
                    correction_lines.append(f"  NOTE: '{word}' in question likely refers to '{v}' in column {col}")

    text_parts = []
    if discovery_lines:
        text_parts.append("[LIVE COLUMN VALUES — use these exact values in WHERE clauses]\n" + "\n".join(discovery_lines))
    if correction_lines:
        text_parts.append("[VALUE CORRECTIONS]\n" + "\n".join(correction_lines))

    discovery_text = "\n\n".join(text_parts)
    print(f"[langgraph] column discovery: {len(samples)} columns sampled")

    return {
        **state,
        "live_column_samples":   samples,
        "column_discovery_text": discovery_text,
        "node_log": (state.get("node_log") or []) + [f"discover_column_values:{len(samples)}"],
    }


# ── Date helpers ──────────────────────────────────────────────────────────────
def _build_date_range_clause(user_date_range: Optional[dict]) -> str:
    if not user_date_range:
        return ""
    from_ = user_date_range.get("from")
    to_   = user_date_range.get("to")
    if not from_ and not to_:
        return ""
    if from_ and to_:
        part = f"date range {from_} to {to_} (inclusive)"
    elif from_:
        part = f"date range from {from_} onwards"
    else:
        part = f"date range up to {to_}"
    return f"\n[USER DATE RANGE — apply in WHERE on the date column]\n{part}"


def _build_conversation_context(history: list[dict]) -> str:
    if not history:
        return ""
    lines = ["[CONVERSATION HISTORY — multi-turn context, last 3 turns]"]
    for h in history[-3:]:
        lines.append(f"Q: {h.get('question', '')}")
        if h.get("sql"):
            lines.append(f"SQL: {h['sql'][:400]}")
        if h.get("summary"):
            lines.append(f"Summary: {h['summary']}")
        lines.append("")
    return "\n".join(lines)


# ── NODE: generate_sql ────────────────────────────────────────────────────────
async def generate_sql(state: AgentState) -> AgentState:
    print("[langgraph] node: generate_sql")
    provider = state.get("ai_provider", "openai")

    # Build the composite prompt sections
    schema_section       = f"[SCHEMA — ONLY use columns listed here]\n{state.get('schema_text', '')}"
    semantic_section     = f"\n\n[MANDATORY COLUMN RULES — semantic mapping]\n{_get_semantic_mapping_prompt()}" if _get_semantic_mapping_prompt() else ""
    rag_section          = f"\n\n[RAG MEMORY — follow these patterns exactly]\n{state['rag_context']}" if state.get("rag_context") else ""
    discovery_section    = f"\n\n{state['column_discovery_text']}" if state.get("column_discovery_text") else ""
    date_section         = _build_date_range_clause(state.get("user_date_range"))
    conv_section         = f"\n\n{_build_conversation_context(state.get('conversation_history', []))}" if state.get("conversation_history") else ""
    adaptive_section     = f"\n\n{state['adaptive_enrichment']}" if state.get("adaptive_enrichment") else ""
    retry_guidance       = ""
    if state.get("retry_count", 0) > 0 and state.get("retry_errors"):
        retry_guidance = "\n\n══ PRIOR FAILURES — fix before retrying ══\n" + "\n".join(state["retry_errors"])

    # Intent section
    intent_section = ""
    intent = state.get("query_intent")
    if intent:
        intent_section = f"\n\n[STRUCTURED INTENT — follow this plan]\n{json.dumps(intent, indent=2)}"

    domain = _infer_domain(state.get("original_question") or state.get("question", ""))
    domain_rules = ""
    if domain == "purchase":
        domain_rules = """
- Purchase amount: NetPurNetAmount on PURXNS; return qty: PrtQty on PRT_REPORT; return date: PurReturnDt
- Purchase returns by supplier: dbo.VW_MB_POWERBI_PRT_REPORT, GROUP BY SupplierName, filter PurReturnDt for period
- Do NOT use MrpValue, XnNo, or APP_REPORT for purchase-return questions
"""
    else:
        rollup = _get_sales_table()
        domain_rules = f"""
- Period sales KPIs (today / MTD / how many sales / total sales): prefer {rollup} with NetSlsNetAmount and XnDt (same as Analytics).
- Bill count today on {rollup}: use COUNT(*) (or SUM(BillCount) on SLSXNS_REPORT). Do NOT use COUNT(DISTINCT XnNo) alone for "sales today".
- dbo.VW_MB_POWERBI_APP_REPORT is line-level (MrpValue, AppQty) — use for staff/product breakdowns, not period totals when rollup exists.
- On APP_REPORT only: MrpValue for revenue, AppQty for qty, XnNo for invoice id, XnDt for date.
"""

    system_prompt = f"""You are an expert Microsoft SQL Server (T-SQL) query writer for a retail ERP system.

Rules:
- Output ONLY valid T-SQL — no explanation, no markdown fences, no semicolons
- Use ONLY columns that appear in the schema below
- For branch use BranchAlias (NOT BranchId, BranchName)
{domain_rules}
- Always add TOP 1000 unless user asked for specific count
- Use NOLOCK hints: FROM table WITH (NOLOCK)
- Use GETDATE() for current date, DATEADD/DATEDIFF for date math
- Indian fiscal year starts April 1

Today's date: {datetime.utcnow().strftime('%Y-%m-%d')} (UTC)
{state.get('date_context', '')}
"""

    user_prompt = (
        schema_section
        + semantic_section
        + adaptive_section
        + discovery_section
        + intent_section
        + rag_section
        + date_section
        + conv_section
        + f"\n\n[ORIGINAL QUESTION]\n{state.get('original_question') or state.get('question', '')}"
        + f"\n\n[NORMALIZED QUESTION]\n{state.get('question', '')}"
        + retry_guidance
    )

    try:
        llm = _make_llm(provider, temperature=0.0)
        response = await llm.ainvoke([SystemMessage(content=system_prompt), HumanMessage(content=user_prompt)])
        sql = _extract_sql(response.content)
        sql = _remap_legacy_columns(sql)
        sql = _enforce_top_limit(sql)
        print(f"[langgraph] generated SQL: {sql[:160]}")
        return {
            **state,
            "generated_sql":       sql,
            "sql_validation_failed": False,
            "node_log": (state.get("node_log") or []) + ["generate_sql"],
        }
    except Exception as e:
        print(f"[langgraph] generate_sql error: {e}")
        return {
            **state,
            "generated_sql":       "",
            "sql_validation_failed": True,
            "node_log": (state.get("node_log") or []) + ["generate_sql:error"],
        }


# ── NODE: check_sql ───────────────────────────────────────────────────────────
async def check_sql(state: AgentState) -> AgentState:
    print("[langgraph] node: check_sql")
    from . import runtime_config as rc

    raw_sql = _remap_legacy_columns(state.get("generated_sql", ""))

    # Quick structural checks
    issues = []
    if not raw_sql.strip():
        issues.append("SQL is empty")
    elif not re.search(r"\bSELECT\b", raw_sql, re.IGNORECASE):
        issues.append("SQL does not contain SELECT")

    # Check for illegal columns still present
    for bad_col in _ILLEGAL_COLUMNS:
        if re.search(rf"\b{re.escape(bad_col)}\b", raw_sql, re.IGNORECASE):
            issues.append(f"Illegal column '{bad_col}' — use '{_ILLEGAL_COLUMNS[bad_col]}'")

    if issues:
        attempt = (state.get("retry_count") or 0) + 1
        if attempt > 3:
            return {**state, "checked_sql": raw_sql, "sql_validation_failed": True,
                    "node_log": (state.get("node_log") or []) + ["check_sql:gave_up"]}
        obs = f"[SQL Validation Failed] {'; '.join(issues)}"
        return {
            **state,
            "generated_sql":       raw_sql,
            "checked_sql":         raw_sql,
            "sql_validation_failed": True,
            "retry_count":         attempt,
            "execution_result":    {"error": "; ".join(issues), "validation_only": True},
            "system_observations": (state.get("system_observations") or []) + [obs],
            "node_log": (state.get("node_log") or []) + ["check_sql:fail"],
        }

    # Optional LLM review
    llm_check_enabled = rc.get_bool("LANGGRAPH_LLM_SQL_CHECK", False)
    if not llm_check_enabled:
        return {
            **state,
            "checked_sql": raw_sql,
            "sql_validation_failed": False,
            "node_log": (state.get("node_log") or []) + ["check_sql:ok"],
        }

    provider = state.get("ai_provider", "openai")
    system_prompt = """You are a T-SQL reviewer for Microsoft SQL Server.
Fix definite bugs only — preserve user intent.
Rules: fix invalid column names, missing GROUP BY, invalid date math.
Do NOT change: FROM/JOIN targets, TOP N values, valid JOIN conditions.
Output ONLY the corrected SQL — no explanation, no markdown."""

    user_prompt = f"[SCHEMA]\n{state.get('schema_text', '')}\n\n[SQL TO REVIEW]\n{raw_sql}"

    try:
        llm = _make_llm(provider, temperature=0.0)
        response = await llm.ainvoke([SystemMessage(content=system_prompt), HumanMessage(content=user_prompt)])
        checked = _remap_legacy_columns(_extract_sql(response.content) or raw_sql)
        changed = checked != raw_sql
        print(f"[langgraph] check_sql LLM changed={changed}")
        return {
            **state,
            "checked_sql": checked,
            "sql_validation_failed": False,
            "node_log": (state.get("node_log") or []) + [f"check_sql:llm_{'changed' if changed else 'ok'}"],
        }
    except Exception as e:
        print(f"[langgraph] check_sql LLM error (non-fatal): {e}")
        return {
            **state,
            "checked_sql": raw_sql,
            "sql_validation_failed": False,
            "node_log": (state.get("node_log") or []) + ["check_sql:llm_error_fallback"],
        }


# ── NODE: execute_sql ─────────────────────────────────────────────────────────
async def execute_sql(state: AgentState) -> AgentState:
    print("[langgraph] node: execute_sql")
    sql = state.get("checked_sql") or state.get("generated_sql", "")

    if not sql:
        return {
            **state,
            "execution_result": {"error": "No SQL to execute", "data": [], "row_count": 0},
            "final_sql":        None,
            "final_data":       [],
            "node_log": (state.get("node_log") or []) + ["execute_sql:no_sql"],
        }

    try:
        from .db_mssql import execute_query
        from . import runtime_config as rc
        timeout_s = rc.get_int("DB_REQUEST_TIMEOUT_MS", 120000) / 1000

        rows = await asyncio.wait_for(execute_query(sql), timeout=timeout_s)

        # Serialize non-JSON-safe types
        clean_rows = []
        for row in rows:
            clean_row = {}
            for k, v in row.items():
                if isinstance(v, (date, datetime)):
                    clean_row[k] = v.isoformat()
                elif isinstance(v, float) and (v != v):  # NaN
                    clean_row[k] = None
                else:
                    clean_row[k] = v
            clean_rows.append(clean_row)

        print(f"[langgraph] execute_sql: {len(clean_rows)} rows")
        return {
            **state,
            "execution_result": {"error": None, "data": clean_rows, "row_count": len(clean_rows)},
            "final_sql":        sql,
            "final_data":       clean_rows,
            "node_log": (state.get("node_log") or []) + [f"execute_sql:{len(clean_rows)}rows"],
        }
    except asyncio.TimeoutError:
        err = "Query timed out — try a more specific question or smaller date range"
        return {
            **state,
            "execution_result": {"error": err, "data": [], "row_count": 0},
            "final_sql":        None,
            "final_data":       [],
            "node_log": (state.get("node_log") or []) + ["execute_sql:timeout"],
        }
    except Exception as e:
        err = str(e)
        print(f"[langgraph] execute_sql error: {err}")
        return {
            **state,
            "execution_result": {"error": err, "data": [], "row_count": 0, "failed_sql": sql},
            "final_sql":        None,
            "final_data":       [],
            "node_log": (state.get("node_log") or []) + ["execute_sql:error"],
        }


# ── NODE: error_recovery ──────────────────────────────────────────────────────
async def error_recovery(state: AgentState) -> AgentState:
    err_msg    = (state.get("execution_result") or {}).get("error", "unknown error")
    failed_sql = (state.get("execution_result") or {}).get("failed_sql") or state.get("checked_sql") or state.get("generated_sql", "")
    attempt    = (state.get("retry_count") or 0) + 1
    print(f"[langgraph] node: error_recovery attempt {attempt} — {err_msg[:100]}")

    # Build observation
    obs = (
        f"[System Observation — Attempt {attempt}/3]\n"
        f"SQL Error: {err_msg}\n"
        f"Failed SQL:\n{failed_sql}\n"
        f"Fix the column names, table names, or syntax and try again."
    )

    # Column-specific fix hints
    m = re.search(r"Invalid column name\s+'?(\w+)'?", err_msg, re.IGNORECASE)
    if m:
        bad_col = m.group(1)
        fix = _ILLEGAL_COLUMNS.get(bad_col)
        if fix:
            obs += f"\nCRITICAL: Replace '{bad_col}' with '{fix}' — it does not exist."

    return {
        **state,
        "generated_sql":       failed_sql,
        "checked_sql":         failed_sql,
        "sql_validation_failed": False,
        "execution_result":    {},
        "retry_count":         attempt,
        "retry_errors":        (state.get("retry_errors") or []) + [f"Attempt {attempt}: {err_msg}"],
        "system_observations": (state.get("system_observations") or []) + [obs],
        "node_log": (state.get("node_log") or []) + [f"error_recovery:{attempt}"],
    }


# ── NODE: generate_answer ─────────────────────────────────────────────────────
async def generate_answer(state: AgentState) -> AgentState:
    print("[langgraph] node: generate_answer")
    provider = state.get("ai_provider", "openai")

    exec_result = state.get("execution_result") or {}
    error = exec_result.get("error")
    data  = state.get("final_data") or exec_result.get("data") or []
    sql   = state.get("final_sql") or state.get("checked_sql") or ""
    question = state.get("original_question") or state.get("question", "")

    if error and not data:
        if state.get("clarification_message"):
            return {
                **state,
                "final_answer": state["clarification_message"],
                "confidence":   "low",
                "node_log": (state.get("node_log") or []) + ["generate_answer:clarification"],
            }
        return {
            **state,
            "final_answer": f"I encountered an error: {error}. Please rephrase your question or check the date range.",
            "confidence":   "low",
            "confidence_note": f"error: {error[:200]}",
            "node_log": (state.get("node_log") or []) + ["generate_answer:error"],
        }

    row_count = len(data)
    if row_count == 0:
        return {
            **state,
            "final_answer": "No data found for your query. Try broadening the date range or check the filter values.",
            "confidence":   "medium",
            "confidence_note": "zero_rows",
            "node_log": (state.get("node_log") or []) + ["generate_answer:zero_rows"],
        }

    # Format a data preview for the LLM
    preview_rows = data[:5]
    preview_text = json.dumps(preview_rows, default=str, indent=2)

    system_prompt = """You are a helpful ERP data analyst assistant.
Given the user's question, the SQL that was executed, and the resulting data, write a concise natural-language answer.

Rules:
- Be specific with numbers (format large numbers with commas, use ₹ for amounts)
- For amounts, convert to Lakhs if >1,00,000 (e.g. ₹12.5L)
- Mention the top results if it's a ranking question
- Keep the answer under 150 words
- Do not re-state the question
- Do not mention SQL or technical details
"""
    user_prompt = f"""Question: {question}

SQL used:
{sql}

Results ({row_count} rows total, first 5 shown):
{preview_text}

Write a concise answer based on this data."""

    try:
        llm = _make_llm(provider, temperature=0.1)
        response = await llm.ainvoke([SystemMessage(content=system_prompt), HumanMessage(content=user_prompt)])
        answer = response.content.strip()
        confidence = "high" if row_count > 0 else "medium"
        return {
            **state,
            "final_answer":   answer,
            "confidence":     confidence,
            "confidence_note": f"{row_count} rows",
            "node_log": (state.get("node_log") or []) + ["generate_answer"],
        }
    except Exception as e:
        # Fallback: simple text summary
        print(f"[langgraph] generate_answer LLM error (non-fatal): {e}")
        answer = f"Found {row_count} record(s). Top result: {json.dumps(data[0], default=str)}" if data else "No results found."
        return {
            **state,
            "final_answer":   answer,
            "confidence":     "medium",
            "confidence_note": f"llm_answer_error:{row_count}rows",
            "node_log": (state.get("node_log") or []) + ["generate_answer:fallback"],
        }


# ── Edge routing ──────────────────────────────────────────────────────────────
def route_after_check_sql(state: AgentState) -> str:
    if state.get("sql_validation_failed") and (state.get("retry_count") or 0) < 3:
        return "generate_sql"
    return "execute_sql"


def route_after_execute_sql(state: AgentState) -> str:
    exec_result = state.get("execution_result") or {}
    if exec_result.get("error") and not exec_result.get("validation_only"):
        if (state.get("retry_count") or 0) < 3:
            return "error_recovery"
    return "generate_answer"


def route_after_error_recovery(state: AgentState) -> str:
    return "generate_sql"


# ── Graph assembly ────────────────────────────────────────────────────────────
def _build_graph():
    g = StateGraph(AgentState)

    g.add_node("pre_flight_gate",         pre_flight_gate)
    g.add_node("retrieve_context",        retrieve_context)
    g.add_node("resolve_intent",          resolve_intent)
    g.add_node("discover_column_values",  discover_column_values)
    g.add_node("generate_sql",            generate_sql)
    g.add_node("check_sql",               check_sql)
    g.add_node("execute_sql",             execute_sql)
    g.add_node("error_recovery",          error_recovery)
    g.add_node("generate_answer",         generate_answer)

    g.add_edge(START,                    "pre_flight_gate")
    g.add_edge("pre_flight_gate",        "retrieve_context")
    g.add_edge("retrieve_context",       "resolve_intent")
    g.add_edge("resolve_intent",         "discover_column_values")
    g.add_edge("discover_column_values", "generate_sql")

    g.add_conditional_edges(
        "check_sql",
        route_after_check_sql,
        {"generate_sql": "generate_sql", "execute_sql": "execute_sql"},
    )
    g.add_conditional_edges(
        "execute_sql",
        route_after_execute_sql,
        {"error_recovery": "error_recovery", "generate_answer": "generate_answer"},
    )
    g.add_conditional_edges(
        "error_recovery",
        route_after_error_recovery,
        {"generate_sql": "generate_sql"},
    )

    g.add_edge("generate_sql",   "check_sql")
    g.add_edge("generate_answer", END)

    return g.compile()


_graph = None


def get_graph():
    global _graph
    if _graph is None:
        _graph = _build_graph()
    return _graph


# ── Public entry point ────────────────────────────────────────────────────────
def _clean_rows(rows: list[dict]) -> list[dict]:
    clean_rows = []
    for row in rows:
        clean_row = {}
        for k, v in row.items():
            if isinstance(v, (date, datetime)):
                clean_row[k] = v.isoformat()
            else:
                clean_row[k] = v
        clean_rows.append(clean_row)
    return clean_rows


async def _run_fast_path(
    question: str,
    user_date_range: dict | None,
    *,
    allow_agent_fallback: bool = False,
) -> Optional[dict]:
    from .query_fast_path import (
        execute_fast_path_sql,
        get_cached_result,
        normalize_question,
        prepare_exec_sql,
        resolve_fast_path_sql,
        set_cached_result,
        summarize_answer,
    )
    from . import runtime_config as rc

    nq = normalize_question(question)
    cached = get_cached_result(nq)
    if cached:
        print(f"[langgraph] fast_path cache hit: {nq[:60]}")
        return cached

    hit = resolve_fast_path_sql(question, user_date_range)
    if not hit:
        return None
    sql_raw, source = hit
    sql = prepare_exec_sql(sql_raw)
    timeout_s = min(rc.get_int("QUERY_FAST_PATH_TIMEOUT_MS", 180000) / 1000, 180.0)

    try:
        rows, sql = await execute_fast_path_sql(sql_raw, source, question, timeout_s)
        clean_rows = _clean_rows(rows)
        from .query_fast_path import shape_chart_rows
        chart_rows = shape_chart_rows(source, clean_rows)
        answer = summarize_answer(question, clean_rows, source)
        print(f"[langgraph] fast_path ({source}): {len(clean_rows)} rows")
        payload = {
            "answer":          answer,
            "sql":             sql,
            "data":            chart_rows,
            "row_count":       len(chart_rows),
            "confidence":      "high" if clean_rows else "medium",
            "confidence_note": f"fast_path:{source}",
            "node_log":        [f"fast_path:{source}"],
            "intent":          None,
            "retry_count":     0,
            "mode":            "fast_path",
        }
        set_cached_result(nq, payload)
        return payload
    except asyncio.TimeoutError:
        err = (
            f"Verified SQL timed out after {int(timeout_s)}s. "
            "Purchase/line-level views are heavy on this server — try again (results cache for 5 min) "
            "or use Analytics for sales MTD/QTD."
        )
        print(f"[langgraph] fast_path timeout ({source})")
    except Exception as e:
        err = f"Verified SQL failed: {e}"
        print(f"[langgraph] fast_path error ({source}): {e}")

    if allow_agent_fallback:
        return None
    return {
        "answer":          err,
        "sql":             sql,
        "data":            [],
        "row_count":       0,
        "confidence":      "low",
        "confidence_note": f"fast_path_error:{source}",
        "node_log":        [f"fast_path_failed:{source}"],
        "intent":          None,
        "retry_count":     0,
        "mode":            "fast_path_error",
    }


async def run_query(
    question:             str,
    ai_provider:          str = "openai",
    conversation_history: list[dict] | None = None,
    user_date_range:      dict | None = None,
    table_hint:           str = "",
    date_context:         str = "",
    adaptive_enrichment:  str = "",
) -> dict:
    """
    Run the LangGraph SQL agent and return a result dict.
    """
    fp = await _run_fast_path(question, user_date_range, allow_agent_fallback=False)
    if fp is not None:
        return fp

    graph = get_graph()

    initial_state: AgentState = {
        "ai_provider":           ai_provider,
        "question":              question,
        "original_question":     question,
        "adaptive_enrichment":   adaptive_enrichment,
        "date_context":          date_context,
        "table_hint":            table_hint,
        "user_date_range":       user_date_range or {},
        "conversation_history":  (conversation_history or [])[-3:],
        "top_views":             [],
        "schema_text":           "",
        "generated_sql":         "",
        "checked_sql":           "",
        "execution_result":      None,
        "retry_count":           0,
        "retry_errors":          [],
        "system_observations":   [],
        "zero_rows_retried":     False,
        "rag_context":           "",
        "query_intent":          None,
        "column_discovery_text": "",
        "live_column_samples":   {},
        "sql_validation_failed": False,
        "next_step":             "CONTINUE",
        "target_view":           "",
        "clarity_score":         1.0,
        "fast_path_sql":         "",
        "clarification_message": "",
        "final_answer":          "",
        "final_data":            [],
        "final_sql":             "",
        "confidence":            "medium",
        "confidence_note":       "",
        "node_log":              [],
    }

    try:
        result = await graph.ainvoke(initial_state)
        return {
            "answer":      result.get("final_answer", ""),
            "sql":         result.get("final_sql", ""),
            "data":        result.get("final_data", []),
            "row_count":   len(result.get("final_data", [])),
            "confidence":  result.get("confidence", "medium"),
            "confidence_note": result.get("confidence_note", ""),
            "node_log":    result.get("node_log", []),
            "intent":      result.get("query_intent"),
            "retry_count": result.get("retry_count", 0),
            "mode":        "langgraph",
        }
    except Exception as e:
        print(f"[langgraph] run_query error: {e}")
        import traceback
        traceback.print_exc()
        return {
            "answer":     f"Query engine error: {e}",
            "sql":        "",
            "data":       [],
            "row_count":  0,
            "confidence": "low",
            "error":      str(e),
        }
