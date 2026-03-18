"""
PortolanCAST — AI Summary Routes (ExtendedCognition Plugin backend)

Purpose:
    Generate status briefings from markup statistics using ClaudeProxy.
    Falls back to computed summary when proxy is offline.

Security assumptions:
    - Only talks to localhost:11435 (ClaudeProxy) — still localhost-only
    - AI response returned as plain text; browser renders via textContent
    - ClaudeProxy enforces its own subprocess timeout (120s)

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from config import db

router = APIRouter()


def _extract_stats(pages: dict) -> dict:
    """
    Extract markup statistics from a dict of Fabric.js page JSON objects.

    Iterates all Fabric object lists across all pages, counts by markupType
    and markupStatus, and identifies the most active pages.

    Skips area companion IText objects — these are visual labels that pair
    with polygon area measurements and should not be counted as markup annotations.

    Args:
        pages: Dict mapping page index string → Fabric JSON { objects: [...] }

    Returns:
        {
          total, byType, byStatus, measurements, pages, mostActivePages
        }
    """
    by_type = {t: 0 for t in ("issue", "question", "approval", "change", "note")}
    by_status = {"open": 0, "resolved": 0}
    measurements = {"distances": 0, "areas": 0, "counts": 0}
    total = 0
    page_counts = {}

    for page_key, fabric_json in pages.items():
        if not isinstance(fabric_json, dict):
            continue
        objects = fabric_json.get("objects", [])
        if not isinstance(objects, list):
            continue

        page_markup_count = 0

        for obj in objects:
            if not isinstance(obj, dict):
                continue

            # Skip area companion IText labels
            m_type = obj.get("measurementType")
            obj_type = obj.get("type", "")
            if m_type == "area" and obj_type in ("IText", "i-text"):
                continue

            # Count measurement tool objects separately
            if m_type == "distance":
                measurements["distances"] += 1
                page_markup_count += 1
                continue
            if m_type == "area":
                measurements["areas"] += 1
                page_markup_count += 1
                continue
            if m_type == "count":
                measurements["counts"] += 1
                page_markup_count += 1
                continue

            # Regular annotation markup
            total += 1
            page_markup_count += 1

            markup_type = obj.get("markupType", "note")
            if markup_type in by_type:
                by_type[markup_type] += 1
            else:
                by_type["note"] += 1

            status = obj.get("markupStatus", "open")
            if status == "resolved":
                by_status["resolved"] += 1
            else:
                by_status["open"] += 1

        if page_markup_count > 0:
            page_counts[page_key] = page_markup_count

    sorted_pages = sorted(page_counts.items(), key=lambda x: x[1], reverse=True)
    most_active = []
    for page_key, _ in sorted_pages[:3]:
        try:
            most_active.append(int(page_key) + 1)
        except (ValueError, TypeError):
            pass

    return {
        "total": total,
        "byType": by_type,
        "byStatus": by_status,
        "measurements": measurements,
        "pages": len(page_counts),
        "mostActivePages": most_active,
    }


def _build_prompt(stats: dict, filename: str) -> str:
    """
    Build a compact prompt for the AI to generate a status briefing.

    Args:
        stats:    Output of _extract_stats().
        filename: Document filename (for context in the briefing).

    Returns:
        A string prompt ready to pass to the AI endpoint.
    """
    by_type = stats.get("byType", {})
    by_status = stats.get("byStatus", {})
    measurements = stats.get("measurements", {})
    most_active = stats.get("mostActivePages", [])

    lines = [
        f"Document: {filename}",
        f"Total annotations: {stats.get('total', 0)} "
        f"({by_status.get('open', 0)} open, {by_status.get('resolved', 0)} resolved)",
        "Breakdown by type:",
    ]

    for t, count in by_type.items():
        if count > 0:
            lines.append(f"  - {t.capitalize()}: {count}")

    if any(v > 0 for v in measurements.values()):
        lines.append("Measurements on drawing:")
        if measurements.get("distances"):
            lines.append(f"  - Distance measurements: {measurements['distances']}")
        if measurements.get("areas"):
            lines.append(f"  - Area measurements: {measurements['areas']}")
        if measurements.get("counts"):
            lines.append(f"  - Count/quantity markers: {measurements['counts']}")

    if most_active:
        pages_str = ", ".join(str(p) for p in most_active)
        lines.append(f"Most annotated pages: {pages_str}")

    lines.append("")
    lines.append(
        "Write a concise status briefing for a project manager. "
        "Two to three sentences. No bullet points."
    )

    return "\n".join(lines)


def _build_fallback_summary(stats: dict) -> str:
    """
    Build a computed (non-AI) summary string from markup statistics.

    Used when ClaudeProxy is offline or any network error occurs.

    Args:
        stats: Output of _extract_stats().

    Returns:
        A human-readable summary sentence.
    """
    total = stats.get("total", 0)

    if total == 0:
        measurements = stats.get("measurements", {})
        if any(v > 0 for v in measurements.values()):
            m_count = sum(measurements.values())
            return f"No annotation markups on this document. {m_count} measurement(s) recorded."
        return "No markups on this document yet."

    by_status = stats.get("byStatus", {})
    by_type = stats.get("byType", {})
    open_count = by_status.get("open", 0)
    resolved_count = by_status.get("resolved", 0)

    type_parts = []
    for t in ("issue", "question", "change", "approval", "note"):
        count = by_type.get(t, 0)
        if count > 0:
            type_parts.append(f"{count} {t}{'s' if count != 1 else ''}")

    type_summary = ", ".join(type_parts) if type_parts else ""

    summary = (
        f"This document has {total} markup{'s' if total != 1 else ''} "
        f"({open_count} open, {resolved_count} resolved)"
    )
    if type_summary:
        summary += f": {type_summary}."
    else:
        summary += "."

    measurements = stats.get("measurements", {})
    m_total = sum(measurements.values())
    if m_total > 0:
        summary += f" {m_total} measurement(s) are recorded on the drawing."

    return summary


@router.post("/api/documents/{doc_id}/ai-summary")
async def ai_summary(doc_id: int, request: Request):
    """
    Generate a status briefing for all markups in a document.

    Accepts the full page markup payload, extracts statistics, then attempts
    to call ClaudeProxy for a Claude-quality narrative. Falls back to a
    computed summary if ClaudeProxy is unavailable.

    Request body:
        { "pages": { "0": {fabricJSON}, "1": {fabricJSON}, ... } }

    Response:
        { "summary": str, "stats": {...}, "mode": "ai"|"computed", "model": str|null }
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()
    pages = body.get("pages", {})
    if not isinstance(pages, dict):
        pages = {}

    stats = _extract_stats(pages)
    mode = "computed"
    summary = _build_fallback_summary(stats)
    model_name = "claude-sonnet-4-6"

    try:
        import requests as req_lib

        # Fast pre-flight check — if ClaudeProxy is offline this fails in <2s
        req_lib.get("http://127.0.0.1:11435/health", timeout=2).raise_for_status()

        prompt = _build_prompt(stats, doc["filename"])

        r = req_lib.post(
            "http://127.0.0.1:11435/v1/chat/completions",
            json={
                "model": model_name,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
            },
            timeout=60,
        )
        r.raise_for_status()

        text = (r.json()["choices"][0]["message"]["content"] or "").strip()
        if text:
            summary = text
            mode = "ai"
    except Exception:
        # Proxy offline, timeout, or requests not installed — stay on computed fallback
        pass

    return JSONResponse({
        "summary": summary,
        "stats": stats,
        "mode": mode,
        "model": model_name if mode == "ai" else None,
    })
