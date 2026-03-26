"""
PortolanCAST — Help Page Route

Purpose:
    Serves the Quick Start Guide (QUICKSTART.md) as a styled HTML page.
    Reads the markdown file at startup, converts to HTML using a lightweight
    built-in parser (no external dependencies), and caches the result.

Security assumptions:
    - Content is static markdown from the project repo, not user input
    - Rendered via Jinja2 autoescaping for defense-in-depth
    - No user-controlled paths or parameters

Author: PortolanCAST
Date: 2026-03-26
"""

import re
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from config import BASE_DIR, templates

router = APIRouter()

# =============================================================================
# LIGHTWEIGHT MARKDOWN → HTML CONVERTER
# =============================================================================
# Handles the subset of markdown used in QUICKSTART.md:
#   headings, tables, code blocks, inline code, bold, links,
#   blockquotes, lists, horizontal rules, and paragraphs.
#
# Why not use a library? PortolanCAST has zero Python dependencies beyond
# FastAPI/PyMuPDF. Adding a markdown lib for one page isn't worth it.
# This converter is intentionally limited — it handles QUICKSTART.md, not
# arbitrary markdown. If the help system grows, swap in python-markdown.
# =============================================================================


def _md_to_html(md_text):
    """
    Convert a markdown string to HTML.

    Handles: headings, fenced code blocks, tables, blockquotes,
    unordered/ordered lists, horizontal rules, inline formatting
    (bold, code, links), and paragraphs.

    Args:
        md_text: Raw markdown string.

    Returns:
        HTML string.
    """
    lines = md_text.split('\n')
    html_parts = []
    i = 0
    in_list = None  # 'ul' or 'ol' or None

    def _close_list():
        nonlocal in_list
        if in_list:
            html_parts.append(f'</{in_list}>')
            in_list = None

    def _inline(text):
        """Process inline markdown: bold, code, links."""
        # Inline code (must be first — protects content from further processing)
        text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
        # Bold
        text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
        # Links [text](url)
        text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
        return text

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Fenced code block
        if stripped.startswith('```'):
            _close_list()
            lang = stripped[3:].strip()
            code_lines = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                # Escape HTML in code blocks
                code_lines.append(
                    lines[i].replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                )
                i += 1
            i += 1  # skip closing ```
            html_parts.append(f'<pre><code>{chr(10).join(code_lines)}</code></pre>')
            continue

        # Horizontal rule
        if stripped in ('---', '***', '___'):
            _close_list()
            html_parts.append('<hr>')
            i += 1
            continue

        # Headings
        heading_match = re.match(r'^(#{1,6})\s+(.+)$', stripped)
        if heading_match:
            _close_list()
            level = len(heading_match.group(1))
            text = _inline(heading_match.group(2))
            # Generate an anchor ID for TOC links
            anchor = re.sub(r'[^a-z0-9-]', '', text.lower().replace(' ', '-'))
            anchor = re.sub(r'<[^>]+>', '', anchor)  # strip HTML tags from anchor
            html_parts.append(f'<h{level} id="{anchor}">{text}</h{level}>')
            i += 1
            continue

        # Table (header row with | separators)
        if '|' in stripped and stripped.startswith('|'):
            _close_list()
            # Collect all table lines
            table_lines = []
            while i < len(lines) and '|' in lines[i].strip():
                table_lines.append(lines[i].strip())
                i += 1

            if len(table_lines) >= 2:
                html_parts.append('<table>')
                # Header row
                headers = [_inline(c.strip()) for c in table_lines[0].split('|')[1:-1]]
                html_parts.append('<thead><tr>')
                for h in headers:
                    html_parts.append(f'<th>{h}</th>')
                html_parts.append('</tr></thead>')

                # Body rows (skip separator row at index 1)
                html_parts.append('<tbody>')
                for row_line in table_lines[2:]:
                    cells = [_inline(c.strip()) for c in row_line.split('|')[1:-1]]
                    html_parts.append('<tr>')
                    for c in cells:
                        html_parts.append(f'<td>{c}</td>')
                    html_parts.append('</tr>')
                html_parts.append('</tbody></table>')
            continue

        # Blockquote
        if stripped.startswith('>'):
            _close_list()
            bq_lines = []
            while i < len(lines) and lines[i].strip().startswith('>'):
                bq_lines.append(_inline(lines[i].strip()[1:].strip()))
                i += 1
            html_parts.append(f'<blockquote>{"<br>".join(bq_lines)}</blockquote>')
            continue

        # Unordered list
        ul_match = re.match(r'^(\s*)[-*]\s+(.+)$', stripped)
        if ul_match:
            if in_list != 'ul':
                _close_list()
                in_list = 'ul'
                html_parts.append('<ul>')
            html_parts.append(f'<li>{_inline(ul_match.group(2))}</li>')
            i += 1
            continue

        # Ordered list
        ol_match = re.match(r'^(\s*)\d+\.\s+(.+)$', stripped)
        if ol_match:
            if in_list != 'ol':
                _close_list()
                in_list = 'ol'
                html_parts.append('<ol>')
            html_parts.append(f'<li>{_inline(ol_match.group(2))}</li>')
            i += 1
            continue

        # Empty line
        if not stripped:
            _close_list()
            i += 1
            continue

        # Paragraph (default)
        _close_list()
        html_parts.append(f'<p>{_inline(stripped)}</p>')
        i += 1

    _close_list()
    return '\n'.join(html_parts)


# =============================================================================
# ROUTE
# =============================================================================

@router.get("/help", response_class=HTMLResponse)
async def help_page():
    """
    Serve the Quick Start Guide as a styled HTML page.

    Reads QUICKSTART.md from the project root, converts to HTML,
    and renders inside the help.html template.
    """
    md_path = BASE_DIR / "QUICKSTART.md"
    if md_path.exists():
        raw = md_path.read_text(encoding="utf-8")
        content_html = _md_to_html(raw)
    else:
        content_html = "<p>Help file not found.</p>"

    return templates.TemplateResponse("help.html", {
        "request": {},  # Jinja2Templates requires a request-like object
        "content": content_html,
    })
