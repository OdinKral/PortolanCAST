"""
PortolanCAST — Report Generation Routes (Review Brief, RFI, Obsidian Export)

Purpose:
    Generate Markdown-formatted reports from live canvas data: review briefs,
    RFI documents, and Obsidian-compatible ZIP exports. All reports work from
    the live browser state (sent in the request body) so they reflect unsaved changes.

Security assumptions:
    - All user text treated as plain text, never HTML
    - Markdown returned as plain text; browser renders via DOM (no innerHTML)
    - ZIP bytes returned in-memory — no temp files written to disk

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-15
"""

import io
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, JSONResponse

from config import db
from routes.search import _parse_tags, _extract_markup_entries

router = APIRouter()


def _generate_review_brief(doc: dict, pages: dict) -> str:
    """
    Generate a Markdown-formatted review brief for a document.

    Groups annotation markups by type (issue → question → change → note → approval),
    open items listed before resolved within each group.

    Args:
        doc:   Document record dict from db.get_document().
        pages: Dict mapping page index string → Fabric JSON { objects: [...] }.

    Returns:
        Markdown string.
    """
    entries = _extract_markup_entries(pages)
    filename = doc.get("filename", "Untitled")
    date_str = datetime.utcnow().strftime("%B %d, %Y")

    total = len(entries)
    open_count = sum(1 for e in entries if e["markup_status"] != "resolved")

    lines = [
        f"# Review Brief — {filename}",
        f"{date_str}   {open_count} open / {total} total",
        "---",
    ]

    if total == 0:
        lines.append("*No annotation markups on this document yet.*")
        return "\n".join(lines)

    TYPE_ORDER = ("issue", "question", "change", "note", "approval")
    TYPE_TITLES = {
        "issue":    "Issues",
        "question": "Questions",
        "change":   "Change Requests",
        "note":     "Notes",
        "approval": "Approvals",
    }

    for mtype in TYPE_ORDER:
        type_entries = [e for e in entries if e["markup_type"] == mtype]
        if not type_entries:
            continue

        lines.append(f"## {TYPE_TITLES[mtype]}  ({len(type_entries)})")

        open_group     = [e for e in type_entries if e["markup_status"] != "resolved"]
        resolved_group = [e for e in type_entries if e["markup_status"] == "resolved"]

        for group_label, group in [("Open", open_group), ("Resolved", resolved_group)]:
            if not group:
                continue
            lines.append(f"### {group_label}")
            for e in group:
                page_disp = e["page_num"] + 1
                note = e["markup_note"] if e["markup_note"] else "(no note)"
                entry_line = f"- p.{page_disp} {e['shape_label']} — {note}"
                if e["markup_author"]:
                    entry_line += f"  [by {e['markup_author']}]"
                lines.append(entry_line)

    # Build tag index
    tag_index: dict = {}
    for e in entries:
        for tag in _parse_tags(e["markup_note"]):
            if tag not in tag_index:
                tag_index[tag] = []
            note_preview = e["markup_note"][:70].rstrip()
            if len(e["markup_note"]) > 70:
                note_preview += "…"
            tag_index[tag].append(
                f"p.{e['page_num'] + 1} {e['shape_label']} — {note_preview}"
            )

    if tag_index:
        lines.append("## Tag Index")
        for tag in sorted(tag_index.keys()):
            refs = tag_index[tag]
            lines.append(f"### #{tag}  ({len(refs)})")
            for ref in refs:
                lines.append(f"- {ref}")

    return "\n".join(lines)


def _generate_rfi_document(
    doc: dict,
    pages: dict,
    filters: dict,
    header: dict,
) -> str:
    """
    Generate a Markdown-formatted RFI (Request for Information) document.

    Unlike the Review Brief (which groups by type), an RFI is a numbered list
    of discrete items submitted to a specific party.

    Args:
        doc:     Document record dict.
        pages:   Dict mapping page index string → Fabric JSON.
        filters: { types: [...], tags: [...], statuses: [...] }
        header:  { rfi_no, project, drawing, to, from }

    Returns:
        Markdown string.
    """
    entries = _extract_markup_entries(pages)
    filename = doc.get("filename", "Untitled")
    date_str = datetime.utcnow().strftime("%B %d, %Y")

    # --- Apply filters ---
    allowed_types    = set(filters.get("types", []))
    allowed_tags     = set(t.lstrip("#").lower() for t in filters.get("tags", []))
    allowed_statuses = set(filters.get("statuses", []))

    def _entry_passes(e: dict) -> bool:
        """Return True if the entry should be included in the RFI."""
        if allowed_types and e["markup_type"] not in allowed_types:
            return False
        if allowed_statuses and e["markup_status"] not in allowed_statuses:
            return False
        if allowed_tags:
            entry_tags = set(_parse_tags(e["markup_note"]))
            if not entry_tags.intersection(allowed_tags):
                return False
        return True

    filtered = [e for e in entries if _entry_passes(e)]

    # --- RFI header block ---
    rfi_no   = header.get("rfi_no",  "").strip() or "—"
    project  = header.get("project", "").strip() or "—"
    drawing  = header.get("drawing", "").strip() or "—"
    to_party = header.get("to",      "").strip() or "—"
    fr_party = header.get("from",    "").strip() or "—"

    lines = [
        f"# RFI {rfi_no} — {filename}",
        "",
        f"**Date:** {date_str}",
        f"**Project:** {project}",
        f"**Drawing:** {drawing}",
        f"**To:** {to_party}",
        f"**From:** {fr_party}",
        f"**Items:** {len(filtered)}",
        "",
        "---",
        "",
    ]

    if not filtered:
        lines.append("*No markups match the selected filters.*")
        return "\n".join(lines)

    # --- Numbered items ---
    for i, e in enumerate(filtered, start=1):
        pg  = e["page_num"] + 1
        shp = e["shape_label"]
        typ = e["markup_type"].capitalize()
        sts = e["markup_status"].capitalize()
        note = e["markup_note"] or "—"
        author = e.get("markup_author", "")

        lines.append(f"## Item {i} — {typ} (p.{pg} {shp})")
        lines.append("")
        lines.append(f"**Location:** Page {pg}, {shp}")
        lines.append(f"**Status:** {sts}")
        if author:
            lines.append(f"**Submitted by:** {author}")
        lines.append("")
        lines.append(f"**Description:**")
        lines.append(note)
        lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


@router.post("/api/documents/{doc_id}/review-brief")
async def review_brief(doc_id: int, request: Request):
    """
    Generate and return a Markdown review brief from live canvas data.

    Request body:
        { "pages": { "0": {fabricJSON}, "1": {fabricJSON}, ... } }

    Returns:
        { "markdown": str, "total": int, "open": int, "resolved": int }
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()
    pages = body.get("pages", {})
    if not isinstance(pages, dict):
        pages = {}

    md = _generate_review_brief(doc, pages)

    entries = _extract_markup_entries(pages)
    total = len(entries)
    open_count = sum(1 for e in entries if e["markup_status"] != "resolved")

    return JSONResponse({
        "markdown": md,
        "total":    total,
        "open":     open_count,
        "resolved": total - open_count,
    })


@router.post("/api/documents/{doc_id}/generate-rfi")
async def generate_rfi(doc_id: int, request: Request):
    """
    Generate and return a Markdown RFI document from live canvas data.

    Request body:
        {
          "pages":   { "0": {fabricJSON}, ... },
          "filters": { "types": [...], "tags": [...], "statuses": [...] },
          "header":  { "rfi_no": str, "project": str, ... }
        }

    Returns:
        { "markdown": str, "item_count": int }
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()
    pages   = body.get("pages",   {})
    filters = body.get("filters", {})
    header  = body.get("header",  {})

    if not isinstance(pages,   dict): pages   = {}
    if not isinstance(filters, dict): filters = {}
    if not isinstance(header,  dict): header  = {}

    md = _generate_rfi_document(doc, pages, filters, header)

    item_count = sum(1 for line in md.splitlines() if line.startswith("## Item "))

    return JSONResponse({"markdown": md, "item_count": item_count})


@router.post("/api/documents/{doc_id}/export-obsidian")
async def export_obsidian(doc_id: int, request: Request):
    """
    Export all markup annotations as an Obsidian-compatible ZIP of Markdown files.

    Each markup becomes one atomic Markdown note with YAML frontmatter
    so the notes are immediately queryable via Obsidian Dataview.

    Request body:
        { "pages": { "0": {fabricJSON}, "1": {fabricJSON}, ... } }

    Returns:
        ZIP file as application/zip with Content-Disposition attachment.
    """
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    body = await request.json()
    pages = body.get("pages", {})
    if not isinstance(pages, dict):
        pages = {}

    doc_stem = Path(doc["filename"]).stem

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for page_key, fabric_json in pages.items():
            if not isinstance(fabric_json, dict):
                continue

            try:
                page_num_0 = int(page_key)
            except (ValueError, TypeError):
                continue

            page_num_1 = page_num_0 + 1

            objects = fabric_json.get("objects", [])
            if not isinstance(objects, list):
                continue

            for obj in objects:
                if not isinstance(obj, dict):
                    continue

                markup_type = obj.get("markupType", "")
                if not markup_type:
                    continue
                measurement_type = obj.get("measurementType", "")
                if measurement_type in ("distance", "area", "count"):
                    continue
                obj_type = obj.get("type", "")
                if measurement_type == "area" and obj_type in ("IText", "i-text"):
                    continue

                markup_id     = obj.get("markupId", "")
                markup_status = obj.get("markupStatus", "open")
                markup_note   = obj.get("markupNote", "") or ""
                markup_author = obj.get("markupAuthor", "") or ""

                tags = _parse_tags(markup_note)

                source_url = (
                    f"http://127.0.0.1:8000/edit/{doc_id}"
                    f"?page={page_num_1}"
                    + (f"&select={markup_id}" if markup_id else "")
                )

                def yaml_str(s: str) -> str:
                    """Quote a string value if it contains YAML special chars."""
                    s = str(s)
                    if any(c in s for c in (':', '#', '[', ']', '{', '}', ',', '|', '>', '"', "'")):
                        return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
                    return s if s else '""'

                tag_list = (
                    "\n" + "".join(f"  - {doc_stem}/{t}\n" for t in tags)
                    if tags else " []\n"
                )

                frontmatter = (
                    "---\n"
                    f"markupId: {yaml_str(markup_id)}\n"
                    f"type: {yaml_str(markup_type)}\n"
                    f"status: {yaml_str(markup_status)}\n"
                    f"tags:{tag_list}"
                    f"document: {yaml_str(doc['filename'])}\n"
                    f"page: {page_num_1}\n"
                    f"author: {yaml_str(markup_author)}\n"
                    f"source: {yaml_str(source_url)}\n"
                    "---\n"
                )

                body_parts = []
                if markup_note:
                    body_parts.append(markup_note.strip())
                if tags:
                    wikilinks = "  ".join(f"[[{t}]]" for t in tags)
                    body_parts.append(wikilinks)

                note_body = "\n\n".join(body_parts) + "\n" if body_parts else "\n"

                file_id = markup_id if markup_id else f"nouid-{obj_type}"
                zip_path = f"{doc_stem}/page-{page_num_1}/{markup_type}-{file_id}.md"

                zf.writestr(zip_path, frontmatter + note_body)

    buf.seek(0)
    safe_stem = doc_stem.replace(" ", "_")
    filename  = f"{safe_stem}_obsidian.zip"

    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
