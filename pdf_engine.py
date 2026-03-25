"""
PortolanCAST — PDF Engine

Purpose:
    Wraps PyMuPDF (fitz) to provide PDF rendering, page extraction, and
    metadata retrieval. This is the server-side PDF workhorse — it renders
    pages to PNG for the viewer and will later handle annotation embedding.

Security assumptions:
    - PDF files come from user upload (local user, not remote)
    - Input paths are validated by the FastAPI layer before reaching here
    - Rendered images are stored in a temp directory with limited lifetime

Threat model:
    - Malformed PDFs could exploit parser bugs in PyMuPDF
    - Mitigation: PyMuPDF is actively maintained; we catch exceptions broadly
    - Extremely large PDFs could exhaust memory
    - Mitigation: page-at-a-time rendering, configurable DPI limits

Author: PortolanCAST
Version: 0.1.0
Date: 2026-02-15
"""

import io
import json
import math
import os
import re
import tempfile

import fitz  # PyMuPDF
from pathlib import Path
from typing import Optional

# =============================================================================
# OPTIONAL CONTENT (OCG) LAYER FILTERING
# =============================================================================

def _filter_content_stream(stream_bytes: bytes, oc_map: dict, layers_to_show: set) -> bytes:
    """
    Remove Optional Content blocks for hidden layers from a PDF content stream.

    PDF optional content syntax:
        /OC /ocXX BDC   <- start of an optional content block
        ... content ...
        EMC             <- end of optional content block

    BDC/EMC blocks can nest. We track nesting depth to find the matching EMC
    for each hidden-layer BDC. Non-OC BDC/BMC operators (used for text structure,
    artifacts, etc.) also nest correctly.

    BT/ET balance repair:
        AutoCAD/Bluebeam PDFs sometimes open a BT (Begin Text) block in
        untagged preamble content and then close it with ET *inside* an OCG
        BDC/EMC block. When we remove that OCG block, the ET disappears,
        leaving subsequent path operators inside a text block — PDF renders
        them as invisible. After discarding each hidden block we count the
        net BT/ET deficit it created (more ET than BT) and inject that many
        `ET` operators at the removal point so path drawing can resume.

    Args:
        stream_bytes:   Raw (decompressed) PDF content stream bytes.
        oc_map:         Dict of {'/ocXX': 'LayerName'} for this page's resources.
        layers_to_show: Set of layer names that should remain visible.

    Returns:
        Filtered stream bytes. Returns stream_bytes unchanged if nothing is hidden.
    """
    # Determine which OC resource names to strip
    oc_names_to_hide = {
        oc_name for oc_name, layer_name in oc_map.items()
        if layer_name not in layers_to_show
    }

    if not oc_names_to_hide:
        return stream_bytes  # Nothing to filter

    text = stream_bytes.decode('latin-1')

    # Collect all marked-content events: position + type + OC resource name.
    # Three categories:
    #   OC_BDC  — /OC /ocXX BDC (optional content block, may be hidden)
    #   BDC_ANY — any other BDC or BMC (nested non-OC marked content)
    #   EMC     — end of any marked content block
    events = []

    # Find /OC /ocXX BDC patterns first (record their ranges to avoid double-counting)
    oc_bdc_ranges = []
    for m in re.finditer(r'/OC\s+(/\w+)\s+BDC', text):
        events.append(('OC_BDC', m.start(), m.end(), m.group(1)))
        oc_bdc_ranges.append((m.start(), m.end()))

    # Find standalone BDC/BMC tokens — skip any that fall within an OC_BDC match
    # (the "BDC" in "/OC /ocXX BDC" is already captured above)
    for m in re.finditer(r'\bBDC\b|\bBMC\b', text):
        if not any(start <= m.start() < end for start, end in oc_bdc_ranges):
            events.append(('BDC_ANY', m.start(), m.end(), None))

    # Find all EMC tokens
    for m in re.finditer(r'\bEMC\b', text):
        events.append(('EMC', m.start(), m.end(), None))

    # Sort events by their position in the stream
    events.sort(key=lambda x: x[1])

    # State machine: walk events, building filtered output.
    # skip_depth > 0 = currently inside a hidden OC block; suppress output.
    result = []
    pos = 0        # Start of next text chunk to include in output
    skip_depth = 0  # Nesting depth inside hidden blocks
    bt_depth = 0   # Current BT/ET text-block depth (across kept content)

    # Pre-compile patterns for BT/ET counting inside removed blocks
    _bt_re = re.compile(r'\bBT\b')
    _et_re = re.compile(r'\bET\b')

    for ev_type, ev_start, ev_end, oc_name in events:
        if skip_depth == 0:
            if ev_type == 'OC_BDC' and oc_name in oc_names_to_hide:
                # Flush text up to here (track BT/ET in the kept segment)
                kept_chunk = text[pos:ev_start]
                bt_depth += len(_bt_re.findall(kept_chunk))
                bt_depth -= len(_et_re.findall(kept_chunk))
                result.append(kept_chunk)
                pos = ev_start  # Will advance to ev_end when depth reaches 0
                skip_depth = 1
            # else: visible OC block, generic BDC/BMC, or EMC — output normally
        else:
            # Inside a hidden block: track nesting to find the matching EMC
            if ev_type in ('OC_BDC', 'BDC_ANY'):
                skip_depth += 1
            elif ev_type == 'EMC':
                skip_depth -= 1
                if skip_depth == 0:
                    # Count BT/ET deficit inside the block we are discarding.
                    # A deficit (more ET than BT) means the block was closing
                    # a BT that was opened in untagged content before the block.
                    # Without the block's ET, path operators that follow will be
                    # silently ignored by the PDF interpreter (text mode).
                    removed_chunk = text[pos:ev_end]
                    bt_in_removed = len(_bt_re.findall(removed_chunk))
                    et_in_removed = len(_et_re.findall(removed_chunk))
                    et_deficit = et_in_removed - bt_in_removed
                    if et_deficit > 0 and bt_depth > 0:
                        # Inject the missing ET operators to restore path-drawing mode.
                        # Clamp to bt_depth so we don't emit more ET than open BT.
                        inject_count = min(et_deficit, bt_depth)
                        result.append('\nET\n' * inject_count)
                        bt_depth -= inject_count

                    # Hidden block complete: skip past this EMC, resume output
                    pos = ev_end

    # Append any remaining text after the last event
    result.append(text[pos:])

    filtered = ''.join(result)

    # Only re-encode if something was actually changed (avoid unnecessary allocation)
    if len(filtered) == len(text):
        return stream_bytes
    return filtered.encode('latin-1')


# =============================================================================
# CONFIGURATION
# =============================================================================

# Default rendering DPI — 150 is good balance of quality vs. speed
# Construction drawings at 150 DPI are readable; 300 DPI for print quality
DEFAULT_DPI = 150

# Maximum DPI to prevent memory exhaustion on large-format sheets
# A 30x42 sheet at 300 DPI = 9000x12600 pixels = ~340MB uncompressed
MAX_DPI = 300


# =============================================================================
# PDF ENGINE
# =============================================================================

class PDFEngine:
    """
    Server-side PDF rendering and manipulation engine.

    Uses PyMuPDF to render individual pages to PNG images for the browser
    viewer. Designed for page-at-a-time rendering to keep memory bounded.

    Attributes:
        None — stateless utility class. Each method takes a file path.

    Usage:
        engine = PDFEngine()
        info = engine.get_pdf_info("/path/to/drawing.pdf")
        png_bytes = engine.render_page("/path/to/drawing.pdf", page=0, dpi=150)
    """

    def get_pdf_info(self, pdf_path: str) -> dict:
        """
        Extract metadata from a PDF file.

        Args:
            pdf_path: Absolute path to the PDF file.

        Returns:
            Dict with keys: page_count, file_size, title, author,
            page_sizes (list of [width, height] in points).

        Raises:
            FileNotFoundError: If pdf_path doesn't exist.
            ValueError: If file is not a valid PDF.
        """
        path = Path(pdf_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")

        try:
            doc = fitz.open(str(path))
        except Exception as e:
            raise ValueError(f"Cannot open PDF: {e}")

        try:
            info = {
                "page_count": doc.page_count,
                "file_size": path.stat().st_size,
                "title": doc.metadata.get("title", ""),
                "author": doc.metadata.get("author", ""),
                "page_sizes": []
            }

            for page in doc:
                rect = page.rect
                # rect is in points (1 point = 1/72 inch)
                info["page_sizes"].append({
                    "width": round(rect.width, 2),
                    "height": round(rect.height, 2),
                    # Human-readable size for UI display
                    "width_inches": round(rect.width / 72, 1),
                    "height_inches": round(rect.height / 72, 1),
                })

            return info
        finally:
            doc.close()

    def render_page(self, pdf_path: str, page_number: int,
                    dpi: int = DEFAULT_DPI, rotate: int = 0) -> bytes:
        """
        Render a single PDF page to PNG bytes.

        Uses PyMuPDF's pixmap rendering. The result is a PNG image
        suitable for display in an <img> tag or on a canvas.

        Args:
            pdf_path: Absolute path to the PDF file.
            page_number: Zero-indexed page number.
            dpi: Rendering resolution. Higher = sharper but slower/larger.
                 Clamped to MAX_DPI to prevent memory issues.
            rotate: Additional clockwise rotation in degrees (0, 90, 180, 270).
                    Composed into the rendering matrix via prerotate() so the
                    resulting PNG has the correct swapped dimensions — no
                    client-side CSS transform required.

        Returns:
            PNG image as bytes.

        Raises:
            FileNotFoundError: If pdf_path doesn't exist.
            IndexError: If page_number is out of range.
            ValueError: If file is not a valid PDF.
        """
        path = Path(pdf_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")

        # SECURITY: Clamp DPI to prevent memory exhaustion
        dpi = min(max(dpi, 72), MAX_DPI)

        # SECURITY: Only allow the four cardinal rotations to prevent arbitrary
        # matrix manipulation from a spoofed query parameter.
        rotate = rotate if rotate in (0, 90, 180, 270) else 0

        try:
            doc = fitz.open(str(path))
        except Exception as e:
            raise ValueError(f"Cannot open PDF: {e}")

        try:
            if page_number < 0 or page_number >= doc.page_count:
                raise IndexError(
                    f"Page {page_number} out of range "
                    f"(document has {doc.page_count} pages)"
                )

            page = doc[page_number]

            # Zoom factor: DPI / 72 (PDF points are 1/72 inch).
            # prerotate() composes the rotation into the same matrix so PyMuPDF
            # handles both scaling and rotation in one render pass.
            # For 90°/270°, the resulting pixmap's width/height are swapped.
            zoom = dpi / 72.0
            matrix = fitz.Matrix(zoom, zoom).prerotate(rotate)

            # Render to pixmap (RGBA), then convert to PNG
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            png_bytes = pixmap.tobytes("png")

            return png_bytes
        finally:
            doc.close()

    def render_thumbnail(self, pdf_path: str, page_number: int,
                         max_width: int = 200) -> bytes:
        """
        Render a small thumbnail of a PDF page for the page navigation panel.

        Uses a fixed max width and calculates DPI to fit.

        Args:
            pdf_path: Absolute path to the PDF file.
            page_number: Zero-indexed page number.
            max_width: Maximum thumbnail width in pixels.

        Returns:
            PNG image as bytes (small, ~10-50KB typically).
        """
        path = Path(pdf_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")

        try:
            doc = fitz.open(str(path))
        except Exception as e:
            raise ValueError(f"Cannot open PDF: {e}")

        try:
            if page_number < 0 or page_number >= doc.page_count:
                raise IndexError(f"Page {page_number} out of range")

            page = doc[page_number]
            rect = page.rect

            # Calculate zoom to fit max_width
            zoom = max_width / rect.width
            matrix = fitz.Matrix(zoom, zoom)

            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            return pixmap.tobytes("png")
        finally:
            doc.close()

    # =========================================================================
    # OCG LAYER SUPPORT
    # =========================================================================

    def get_pdf_layers(self, pdf_path: str) -> list:
        """
        Get the Optional Content Group (OCG) layers from a PDF.

        OCGs are the PDF equivalent of CAD layers. Engineering drawings from
        AutoCAD/Bluebeam typically carry named OCGs for each discipline layer
        (walls, piping, electrical, text, etc.).

        Args:
            pdf_path: Absolute path to the PDF file.

        Returns:
            List of {'name': str, 'on': bool} dicts, sorted by name.
            Returns [] if the PDF has no OCG layers.

        Raises:
            FileNotFoundError: If pdf_path doesn't exist.
            ValueError: If file is not a valid PDF.
        """
        path = Path(pdf_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")

        try:
            doc = fitz.open(str(path))
        except Exception as e:
            raise ValueError(f"Cannot open PDF: {e}")

        try:
            ocgs = doc.get_ocgs()
            if not ocgs:
                return []

            # Deduplicate by name — some PDFs register the same layer under
            # multiple xrefs (e.g., one for each page reference).
            seen: dict = {}
            for xref, info in ocgs.items():
                name = info.get('name', f'Layer_{xref}')
                if name not in seen:
                    seen[name] = {'name': name, 'on': info.get('on', True)}

            return sorted(seen.values(), key=lambda x: x['name'])
        finally:
            doc.close()

    def _build_oc_map_for_page(self, doc, page) -> dict:
        """
        Build a mapping from page-local OC resource name to layer name.

        Each PDF page has a /Resources/Properties dict that maps short names
        (e.g., /oc10) to OCG xrefs. This lets content streams reference layers
        compactly. We resolve these to human-readable layer names.

        Args:
            doc:  Open fitz.Document.
            page: fitz.Page object.

        Returns:
            Dict like {'/oc10': 'MP-HOTW-SUPP-PIPE', '/oc13': '0', ...}.
            Returns {} if no OCG properties found on this page.
        """
        ocgs = doc.get_ocgs()  # {xref: {'name': ..., 'on': ...}}
        if not ocgs:
            return {}

        xref_to_name = {xref: info.get('name', '') for xref, info in ocgs.items()}
        oc_map: dict = {}

        try:
            # Read the full page xref object as a string.
            # Typical form includes: /Properties <</oc10 2859 0 R /oc12 2861 0 R ...>>
            xref_str = doc.xref_object(page.xref)

            # Find the Properties subdictionary.
            # It won't contain nested dicts so a simple non-greedy match works.
            props_match = re.search(r'/Properties\s*<<([^>]*)>>', xref_str)
            if not props_match:
                # Resources may be an indirect reference — fall back to xref_get_key
                try:
                    props_str = doc.xref_get_key(page.xref, 'Resources/Properties')
                    props_match_fb = re.search(r'<<([^>]*)>>', props_str)
                    if props_match_fb:
                        props_str = props_match_fb.group(1)
                    else:
                        props_str = props_str
                except Exception:
                    return {}
            else:
                props_str = props_match.group(1)

            # Parse entries like: /oc10 2859 0 R
            # Note: property names in the PDF dict have a leading slash
            for m in re.finditer(r'(/\w+)\s+(\d+)\s+0\s+R', props_str):
                oc_local = m.group(1)   # e.g., /oc10
                ref_xref = int(m.group(2))
                if ref_xref in xref_to_name:
                    oc_map[oc_local] = xref_to_name[ref_xref]

        except Exception:
            pass  # Parse error — return whatever we managed to collect

        return oc_map

    def render_page_with_layers(self, pdf_path: str, page_number: int,
                                hidden_layers: list,
                                dpi: int = DEFAULT_DPI,
                                rotate: int = 0) -> bytes:
        """
        Render a PDF page with specified OCG layers hidden.

        Strategy: Native OCG visibility via set_layer() + save-to-buffer-and-reopen.

        PyMuPDF 1.24.9's get_pixmap() ignores set_layer() calls made to an
        already-open document because MuPDF's C layer caches the page content
        at open time. The workaround is to:
          1. Set the OCG visibility state in the document metadata.
          2. Serialize the whole document to an in-memory bytes buffer.
          3. Reopen a fresh fitz.Document from that buffer.
          4. Render — MuPDF now reads the OCG state from the fresh parse.

        Fall-through: if the PDF has no OCG table (no layers) this path is a
        no-op and the page renders normally.

        Args:
            pdf_path:      Absolute path to the PDF file.
            page_number:   Zero-indexed page number.
            hidden_layers: List of layer names to suppress (e.g. ['BORDER', 'Text PS']).
                           Pass [] to render all layers (falls back to render_page).
            dpi:           Rendering resolution (72-300, default 150).
            rotate:        Clockwise rotation in degrees (0, 90, 180, 270).

        Returns:
            PNG image as bytes.

        Raises:
            FileNotFoundError: If pdf_path doesn't exist.
            IndexError:        If page_number is out of range.
            ValueError:        If file is not a valid PDF.
        """
        if not hidden_layers:
            # No filtering needed — delegate to the standard renderer
            return self.render_page(pdf_path, page_number, dpi=dpi, rotate=rotate)

        path = Path(pdf_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")

        # SECURITY: Clamp inputs (same as render_page)
        dpi = min(max(dpi, 72), MAX_DPI)
        rotate = rotate if rotate in (0, 90, 180, 270) else 0

        try:
            try:
                doc = fitz.open(str(path))
            except Exception as e:
                raise ValueError(f"Cannot open PDF: {e}")

            if page_number < 0 or page_number >= doc.page_count:
                raise IndexError(
                    f"Page {page_number} out of range "
                    f"(document has {doc.page_count} pages)"
                )

            page = doc[page_number]

            # Build OC resource map: {'/ocXX': 'LayerName'} for this page.
            # The map is page-local: each page's /Resources/Properties dict
            # assigns short names like /oc10 to global OCG xrefs.
            oc_map = self._build_oc_map_for_page(doc, page)

            if oc_map:
                hidden_set = set(hidden_layers)
                layers_to_show = {
                    name for name in oc_map.values()
                    if name not in hidden_set
                }

                # Filter each content stream for this page.
                # _filter_content_stream removes BDC/EMC blocks for hidden layers
                # while preserving untagged preamble content (scale transforms,
                # clip paths, etc.) and repairing BT/ET balance after removals.
                for xref in page.get_contents():
                    raw = doc.xref_stream(xref)
                    filtered = _filter_content_stream(raw, oc_map, layers_to_show)
                    if filtered is not raw:
                        doc.update_stream(xref, filtered)

            # Render from the in-memory modified document.
            # doc.close() (in finally) without doc.save() discards all changes —
            # the original PDF file on disk is never touched.
            zoom = dpi / 72.0
            matrix = fitz.Matrix(zoom, zoom).prerotate(rotate)
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            return pixmap.tobytes("png")

        finally:
            doc.close()

    # =========================================================================
    # PDF EXPORT WITH ANNOTATIONS
    # =========================================================================

    def export_with_annotations(self, pdf_path: str,
                                markups_by_page: dict) -> bytes:
        """
        Create a PDF with Fabric.js markups drawn as native PDF shapes.

        Opens the original PDF, iterates pages that have markups, converts
        each Fabric.js object from pixel coordinates (at BASE_DPI 150) to
        PDF points (1/72 inch), and draws them using PyMuPDF's Shape API.
        Returns the annotated PDF as bytes for download.

        Coordinate mapping:
            Fabric pixel at 150 DPI → PDF points: multiply by (72 / 150) = 0.48
            Origin is top-left for both Fabric.js and PyMuPDF — no Y-flip needed.

        Args:
            pdf_path: Absolute path to the original PDF file.
            markups_by_page: Dict of { page_number (int or str): fabric_json }.
                             fabric_json has an 'objects' list from Fabric.js toJSON().

        Returns:
            bytes — The annotated PDF file content.

        Raises:
            FileNotFoundError: If pdf_path doesn't exist.
            ValueError: If file is not a valid PDF.
        """
        path = Path(pdf_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")

        try:
            doc = fitz.open(str(path))
        except Exception as e:
            raise ValueError(f"Cannot open PDF: {e}")

        try:
            # DPI conversion: Fabric uses 150 DPI pixels, PDF uses 72 DPI points
            scale = 72.0 / DEFAULT_DPI

            for page_str, fabric_json in markups_by_page.items():
                try:
                    page_num = int(page_str)
                except (ValueError, TypeError):
                    continue

                if page_num < 0 or page_num >= doc.page_count:
                    continue

                # Parse fabric_json if it's a string
                if isinstance(fabric_json, str):
                    try:
                        fabric_json = json.loads(fabric_json)
                    except json.JSONDecodeError:
                        continue

                objects = fabric_json.get('objects', [])
                if not objects:
                    continue

                page = doc[page_num]
                shape = page.new_shape()

                for obj in objects:
                    self._draw_fabric_object(shape, obj, scale)

                # Commit all shapes drawn on this page
                shape.commit()

            # Save to bytes in memory
            output = io.BytesIO()
            doc.save(output)
            return output.getvalue()

        finally:
            doc.close()

    def _draw_fabric_object(self, shape, obj: dict, scale: float):
        """
        Draw a single Fabric.js object onto a PyMuPDF Shape.

        Dispatches by Fabric type to the appropriate drawing method.
        Handles coordinate scaling from Fabric pixels to PDF points.

        Args:
            shape: PyMuPDF Shape instance (from page.new_shape()).
            obj: Fabric.js object dict from toJSON() output.
            scale: Coordinate scale factor (72/150 for BASE_DPI=150).
        """
        obj_type = obj.get('type', '')

        # Parse visual properties shared across types
        stroke_color = self._hex_to_rgb(obj.get('stroke'))
        fill_color = self._hex_to_rgb(obj.get('fill'))
        stroke_width = max(0.5, (obj.get('strokeWidth', 2) or 2) * scale)
        opacity = obj.get('opacity', 1.0)

        # Transparent fill means no fill in PDF
        fill_str = obj.get('fill', '')
        has_fill = fill_str and fill_str != 'transparent'

        if obj_type in ('Rect', 'rect'):
            self._draw_rect(shape, obj, scale, stroke_color, fill_color,
                            stroke_width, opacity, has_fill)

        elif obj_type in ('Ellipse', 'ellipse'):
            self._draw_ellipse(shape, obj, scale, stroke_color, fill_color,
                               stroke_width)

        elif obj_type in ('Line', 'line'):
            self._draw_line(shape, obj, scale, stroke_color, stroke_width)

        elif obj_type in ('Path', 'path'):
            self._draw_path(shape, obj, scale, stroke_color, stroke_width)

        elif obj_type in ('IText', 'i-text', 'Textbox', 'textbox'):
            self._draw_text(shape, obj, scale, stroke_color, fill_color)

        elif obj_type in ('Polygon', 'polygon'):
            # Area measurement polygon — may also appear as standalone shape markup
            self._draw_polygon(shape, obj, scale, stroke_color, fill_color,
                               stroke_width, opacity)

        elif obj_type in ('Group', 'group'):
            # Route by semantic type: measurements get specialized rendering,
            # callouts and other groups use the generic child-dispatch path.
            measurement_type = obj.get('measurementType', '')
            if measurement_type == 'distance':
                # Distance group: Line + IText label — generic group dispatch works fine
                self._draw_group(shape, obj, scale)
            elif measurement_type == 'count':
                # Count group: Circle + IText number — generic group dispatch works fine
                self._draw_group(shape, obj, scale)
            else:
                # Callout or other groups — draw child objects individually
                self._draw_group(shape, obj, scale)

    def _draw_rect(self, shape, obj, scale, stroke_color, fill_color,
                   stroke_width, opacity, has_fill):
        """
        Draw a rectangle (shape or highlighter) as a PDF rect.

        Highlighters have fill + opacity 0.25, no stroke.
        Shape rects have stroke, no fill.

        Args:
            shape: PyMuPDF Shape.
            obj: Fabric Rect object dict.
            scale: DPI scale factor.
            stroke_color: RGB tuple or None.
            fill_color: RGB tuple or None.
            stroke_width: Scaled stroke width.
            opacity: Fabric opacity value.
            has_fill: Whether the rect has a non-transparent fill.
        """
        left = obj.get('left', 0) * scale
        top = obj.get('top', 0) * scale
        width = obj.get('width', 0) * scale * obj.get('scaleX', 1)
        height = obj.get('height', 0) * scale * obj.get('scaleY', 1)

        rect = fitz.Rect(left, top, left + width, top + height)

        is_highlighter = has_fill and opacity < 1.0 and not obj.get('stroke')

        if is_highlighter:
            # Highlighter: filled semi-transparent rect
            shape.draw_rect(rect)
            shape.finish(
                color=None,
                fill=fill_color,
                fill_opacity=opacity,
                width=0,
            )
        else:
            # Shape rect: stroke only
            shape.draw_rect(rect)
            shape.finish(
                color=stroke_color,
                fill=None,
                width=stroke_width,
            )

    def _draw_ellipse(self, shape, obj, scale, stroke_color, fill_color,
                      stroke_width):
        """
        Draw an ellipse using PyMuPDF's draw_oval with a bounding rect.

        Args:
            shape: PyMuPDF Shape.
            obj: Fabric Ellipse object dict.
            scale: DPI scale factor.
            stroke_color: RGB tuple.
            stroke_width: Scaled stroke width.
        """
        left = obj.get('left', 0) * scale
        top = obj.get('top', 0) * scale
        rx = obj.get('rx', 0) * scale * obj.get('scaleX', 1)
        ry = obj.get('ry', 0) * scale * obj.get('scaleY', 1)

        # Fabric's left/top is the top-left of the bounding box
        rect = fitz.Rect(left, top, left + 2 * rx, top + 2 * ry)

        shape.draw_oval(rect)
        shape.finish(
            color=stroke_color,
            fill=None,
            width=stroke_width,
        )

    def _draw_line(self, shape, obj, scale, stroke_color, stroke_width):
        """
        Draw a straight line between two points.

        Fabric Line stores x1, y1, x2, y2 relative to object left/top.
        The actual line endpoints in canvas coords are computed from these.

        Args:
            shape: PyMuPDF Shape.
            obj: Fabric Line object dict.
            scale: DPI scale factor.
            stroke_color: RGB tuple.
            stroke_width: Scaled stroke width.
        """
        x1 = obj.get('x1', 0)
        y1 = obj.get('y1', 0)
        x2 = obj.get('x2', 0)
        y2 = obj.get('y2', 0)
        left = obj.get('left', 0)
        top = obj.get('top', 0)

        # Fabric Line coords are relative to object center (left/top is center)
        # Convert to absolute coords: left + x1 + width/2, etc.
        width = obj.get('width', abs(x2 - x1))
        height = obj.get('height', abs(y2 - y1))

        # Absolute pixel coords for line endpoints
        abs_x1 = (left + x1 + width / 2) * scale
        abs_y1 = (top + y1 + height / 2) * scale
        abs_x2 = (left + x2 + width / 2) * scale
        abs_y2 = (top + y2 + height / 2) * scale

        p1 = fitz.Point(abs_x1, abs_y1)
        p2 = fitz.Point(abs_x2, abs_y2)

        shape.draw_line(p1, p2)
        shape.finish(
            color=stroke_color,
            width=stroke_width,
        )

    def _draw_path(self, shape, obj, scale, stroke_color, stroke_width):
        """
        Draw a Fabric.js Path (pen strokes or cloud shapes) as line segments.

        Fabric stores paths as arrays of command arrays, e.g.:
            [["M", x, y], ["Q", cx, cy, x, y], ["L", x, y], ...]

        We approximate curves with line segments for PyMuPDF compatibility.
        SVG arc commands (A) from clouds are approximated as lines to endpoints.

        Args:
            shape: PyMuPDF Shape.
            obj: Fabric Path object dict.
            scale: DPI scale factor.
            stroke_color: RGB tuple.
            stroke_width: Scaled stroke width.
        """
        path_data = obj.get('path', [])
        if not path_data:
            return

        left = obj.get('left', 0)
        top = obj.get('top', 0)

        # Fabric Path objects have pathOffset (center of bounding box)
        # and left/top is the actual position. The path coordinates are
        # relative to the pathOffset center point.
        offset_x = 0
        offset_y = 0
        path_offset = obj.get('pathOffset', {})
        if path_offset:
            offset_x = path_offset.get('x', 0)
            offset_y = path_offset.get('y', 0)

        def to_pdf(px, py):
            """Convert Fabric path-local coords to absolute PDF points."""
            abs_x = (left + px - offset_x) * scale
            abs_y = (top + py - offset_y) * scale
            return fitz.Point(abs_x, abs_y)

        current = fitz.Point(0, 0)
        first_point = None
        started = False

        for cmd in path_data:
            if not cmd or len(cmd) < 1:
                continue

            op = cmd[0]

            if op == 'M' and len(cmd) >= 3:
                # Move to — start a new subpath
                current = to_pdf(cmd[1], cmd[2])
                first_point = current
                started = False

            elif op == 'L' and len(cmd) >= 3:
                # Line to
                end = to_pdf(cmd[1], cmd[2])
                shape.draw_line(current, end)
                current = end

            elif op == 'Q' and len(cmd) >= 5:
                # Quadratic bezier — approximate with line to endpoint
                end = to_pdf(cmd[3], cmd[4])
                shape.draw_line(current, end)
                current = end

            elif op == 'C' and len(cmd) >= 7:
                # Cubic bezier — approximate with line to endpoint
                end = to_pdf(cmd[5], cmd[6])
                shape.draw_line(current, end)
                current = end

            elif op == 'A' and len(cmd) >= 8:
                # SVG arc — approximate with line to endpoint
                end = to_pdf(cmd[6], cmd[7])
                shape.draw_line(current, end)
                current = end

            elif op == 'Z' or op == 'z':
                # Close path — draw line back to start
                if first_point:
                    shape.draw_line(current, first_point)
                    current = first_point

        shape.finish(
            color=stroke_color,
            fill=None,
            width=stroke_width,
        )

    def _draw_polygon(self, shape, obj, scale, stroke_color, fill_color,
                      stroke_width, opacity, has_fill=False):
        """
        Draw a Fabric.js Polygon (area measurement polygon) as a PDF polygon.

        Fabric stores polygon vertex coordinates in the 'points' array as
        {x, y} objects relative to the polygon's top-left origin. The polygon's
        'left' and 'top' give the top-left of its bounding box.

        Area measurement polygons have a subtle fill (low opacity teal) and
        a solid stroke. Generic polygon markups use stroke only.

        Args:
            shape: PyMuPDF Shape.
            obj: Fabric Polygon object dict.
            scale: DPI scale factor.
            stroke_color: RGB tuple.
            fill_color: RGB tuple or None.
            stroke_width: Scaled stroke width.
            opacity: Object opacity.
            has_fill: Whether to render the fill.
        """
        points_raw = obj.get('points', [])
        if len(points_raw) < 3:
            return

        left = obj.get('left', 0)
        top = obj.get('top', 0)

        # Fabric Polygon: points are stored relative to the polygon object's
        # own local coordinate system. The polygon's pathOffset centers the
        # shape's bounding box. We need to convert to absolute canvas coords.
        # Compute bounding box to find the offset.
        xs = [p.get('x', 0) for p in points_raw]
        ys = [p.get('y', 0) for p in points_raw]
        min_x = min(xs)
        min_y = min(ys)

        # Absolute canvas coords for each vertex (scale applied)
        pdf_points = []
        for p in points_raw:
            abs_x = (left + p.get('x', 0) - min_x) * scale
            abs_y = (top + p.get('y', 0) - min_y) * scale
            pdf_points.append(fitz.Point(abs_x, abs_y))

        # draw_polyline connects all points; we close manually with draw_line
        for i in range(len(pdf_points) - 1):
            shape.draw_line(pdf_points[i], pdf_points[i + 1])
        # Close the polygon
        shape.draw_line(pdf_points[-1], pdf_points[0])

        # Area measurement: subtle fill + solid stroke
        is_measurement = obj.get('measurementType') == 'area'
        if is_measurement and fill_color:
            shape.finish(
                color=stroke_color,
                fill=fill_color,
                fill_opacity=min(opacity, 0.15),  # very subtle in PDF too
                width=stroke_width,
            )
        else:
            shape.finish(
                color=stroke_color,
                fill=None,
                width=stroke_width,
            )

    def _draw_text(self, shape, obj, scale, stroke_color, fill_color):
        """
        Draw text annotation using PyMuPDF's insert_text.

        Fabric IText uses 'fill' for text color (not stroke).
        Font size is scaled from Fabric pixels to PDF points.

        Args:
            shape: PyMuPDF Shape.
            obj: Fabric IText/Textbox object dict.
            scale: DPI scale factor.
            stroke_color: RGB tuple (unused for text — fill_color is the text color).
            fill_color: RGB tuple for text color.
        """
        text = obj.get('text', '')
        if not text.strip():
            return

        left = obj.get('left', 0) * scale
        top = obj.get('top', 0) * scale
        font_size = (obj.get('fontSize', 16) or 16) * scale * obj.get('scaleY', 1)

        # Text color comes from 'fill' in Fabric (not stroke)
        text_color = fill_color if fill_color else stroke_color
        if not text_color:
            text_color = (0, 0, 0)  # fallback to black

        # PyMuPDF insert_text expects the baseline position
        # Add font_size offset to approximate baseline from Fabric's top-left
        point = fitz.Point(left, top + font_size)

        shape.insert_text(
            point,
            text,
            fontsize=font_size,
            color=text_color,
        )

    def _draw_group(self, shape, obj, scale):
        """
        Draw a Fabric.js Group by iterating its child objects.

        Groups (e.g. callouts) contain child objects with coordinates
        relative to the group's center. We offset children by the group's
        left/top before drawing.

        Args:
            shape: PyMuPDF Shape.
            obj: Fabric Group object dict.
            scale: DPI scale factor.
        """
        children = obj.get('objects', [])
        if not children:
            return

        group_left = obj.get('left', 0)
        group_top = obj.get('top', 0)
        # Group width/height for computing child absolute positions
        group_w = obj.get('width', 0)
        group_h = obj.get('height', 0)

        for child in children:
            # Child coords in Fabric groups are relative to group center.
            # Offset them to get absolute canvas coords.
            child_copy = dict(child)
            child_copy['left'] = group_left + child.get('left', 0) + group_w / 2
            child_copy['top'] = group_top + child.get('top', 0) + group_h / 2
            self._draw_fabric_object(shape, child_copy, scale)

    # =========================================================================
    # COLOR CONVERSION HELPERS
    # =========================================================================

    @staticmethod
    def _hex_to_rgb(hex_str: str):
        """
        Convert a CSS hex color string to an RGB tuple (0-1 floats) for PyMuPDF.

        Handles #rgb, #rrggbb, and named color fallback (returns gray).
        Returns None if input is None/empty/transparent.

        Args:
            hex_str: CSS color string like '#ff4444' or '#abc'.

        Returns:
            Tuple of (r, g, b) floats in 0-1 range, or None.
        """
        if not hex_str or hex_str == 'transparent':
            return None

        if not hex_str.startswith('#'):
            # Named colors or rgb() — use sensible fallback
            if 'rgb' in hex_str:
                match = re.match(r'rgb\((\d+),\s*(\d+),\s*(\d+)\)', hex_str)
                if match:
                    r = int(match.group(1)) / 255.0
                    g = int(match.group(2)) / 255.0
                    b = int(match.group(3)) / 255.0
                    return (r, g, b)
            return (0.5, 0.5, 0.5)  # gray fallback for unknown named colors

        hex_str = hex_str.lstrip('#')

        # Expand #rgb to #rrggbb
        if len(hex_str) == 3:
            hex_str = hex_str[0] * 2 + hex_str[1] * 2 + hex_str[2] * 2

        if len(hex_str) != 6:
            return (0.5, 0.5, 0.5)  # invalid hex

        try:
            r = int(hex_str[0:2], 16) / 255.0
            g = int(hex_str[2:4], 16) / 255.0
            b = int(hex_str[4:6], 16) / 255.0
            return (r, g, b)
        except ValueError:
            return (0.5, 0.5, 0.5)

    # =========================================================================
    # BLANK DOCUMENT CREATION
    # =========================================================================

    def create_blank_document(self, page_count: int,
                              width_pts: float, height_pts: float) -> bytes:
        """
        Create a new blank PDF document with N white pages.

        Uses PyMuPDF's empty-document constructor. Each page is plain white
        with no content. Useful for sketch pads, notes, and template creation.

        Args:
            page_count: Number of blank pages (1–50 enforced by caller).
            width_pts: Page width in PDF points (1 pt = 1/72 inch).
            height_pts: Page height in PDF points.

        Returns:
            bytes — The new PDF file content (ready to write to disk).
        """
        # fitz.open() with no args creates an empty in-memory document
        doc = fitz.open()
        for _ in range(page_count):
            doc.new_page(width=width_pts, height=height_pts)

        output = io.BytesIO()
        doc.save(output)
        doc.close()
        return output.getvalue()

    def add_blank_page(self, filepath: str,
                       width_pts: float = 612.0,
                       height_pts: float = 792.0) -> int:
        """
        Append a blank white page to an existing PDF document.

        Always appends at the END of the document. Inserting in the middle
        would shift page indices and break saved markup references in the DB.

        The file is overwritten in-place using incremental=False so the saved
        markups (which reference zero-indexed page numbers) remain valid for
        all existing pages — only the new last page is added.

        Args:
            filepath: Absolute path to the PDF to modify (overwritten).
            width_pts: Page width in PDF points. Default: Letter width (8.5").
            height_pts: Page height in PDF points. Default: Letter height (11").

        Returns:
            int — New total page count after insertion.

        Raises:
            FileNotFoundError: If filepath doesn't exist.
            ValueError: If file is not a valid PDF.
        """
        path = Path(filepath)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {filepath}")

        try:
            doc = fitz.open(str(path))
        except Exception as e:
            raise ValueError(f"Cannot open PDF: {e}")

        try:
            # pno=-1 appends at end (PyMuPDF convention)
            doc.new_page(pno=-1, width=width_pts, height=height_pts)
            new_count = doc.page_count

            # PyMuPDF cannot save to the same path it opened with incremental=False.
            # Write to a sibling temp file first, then atomically replace the original.
            # os.replace is atomic on POSIX and same-filesystem Windows.
            tmp_path = None
            try:
                fd, tmp_path = tempfile.mkstemp(
                    suffix='.pdf', dir=str(path.parent)
                )
                os.close(fd)
                doc.save(tmp_path)
                doc.close()
                os.replace(tmp_path, str(path))
                return new_count
            except Exception:
                if tmp_path and os.path.exists(tmp_path):
                    os.unlink(tmp_path)
                raise
        except Exception:
            # Only close if we didn't already close it above
            try:
                doc.close()
            except Exception:
                pass
            raise

    def get_page_text(self, pdf_path: str, page_number: int) -> str:
        """
        Extract text content from a PDF page (if available).

        Useful for searchable PDFs. Scanned drawings will return empty
        strings — use extract_text() for the full structured result with
        word counts, method info, and optional OCR fallback.

        Args:
            pdf_path: Absolute path to the PDF file.
            page_number: Zero-indexed page number.

        Returns:
            Extracted text as string. May be empty for scanned documents.
        """
        result = self.extract_text(pdf_path, page_number, use_ocr=False)
        return result['text']

    def extract_text(self, pdf_path: str, page_number: int,
                     use_ocr: bool = False) -> dict:
        """
        Extract text from a PDF page with rich metadata about the result.

        Strategy (two-tier):
          1. Native text layer — PyMuPDF page.get_text('blocks'). Fast, zero
             extra deps. Works for born-digital PDFs (reports, specs, drawings
             created in CAD tools). Returns empty for scanned image PDFs.
          2. OCR fallback (use_ocr=True) — renders the page at 200 DPI to a
             PIL Image and passes it to pytesseract. Only attempted when the
             native layer is empty AND use_ocr is True AND pytesseract+tesseract
             are installed. Gracefully disabled otherwise.

        Security:
          - Rendering DPI is capped at MAX_DPI to prevent memory exhaustion.
          - pdf_path is validated against filesystem before opening.

        Args:
            pdf_path:    Absolute path to the PDF file.
            page_number: Zero-indexed page number.
            use_ocr:     If True and native text is empty, attempt Tesseract OCR.

        Returns:
            Dict with keys:
              text           (str)  — extracted text, whitespace-normalised
              word_count     (int)  — approximate word count
              char_count     (int)  — character count (excluding whitespace)
              has_native_text (bool) — whether native text layer had content
              method         (str)  — 'native' | 'ocr' | 'none'
              ocr_available  (bool) — whether Tesseract is usable
              page           (int)  — the page number (echo-back)
        """
        # --- probe OCR availability once (cheap, cached by Python import sys) ---
        ocr_available = self._ocr_available()

        path = Path(pdf_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")

        try:
            doc = fitz.open(str(path))
        except Exception as e:
            raise ValueError(f"Cannot open PDF: {e}")

        try:
            if page_number < 0 or page_number >= doc.page_count:
                raise IndexError(f"Page {page_number} out of range")

            page = doc[page_number]

            # ── Tier 1: native text layer ─────────────────────────────────────
            # 'blocks' mode returns a list of text blocks with bounding boxes;
            # joining block text is more reliable than 'text' mode which can
            # lose inter-column spacing on multi-column layouts.
            native_text = ' '.join(
                b[4]                          # block text is field index 4
                for b in page.get_text('blocks')
                if b[6] == 0                  # type 0 = text (not image blocks)
            ).strip()

            has_native = bool(native_text)

            if has_native:
                text = native_text
                method = 'native'
            elif use_ocr and ocr_available:
                # ── Tier 2: Tesseract OCR ─────────────────────────────────────
                # Render the page at a sensible DPI, convert to PIL Image,
                # run pytesseract. 200 DPI is a good balance of accuracy vs speed
                # for typical engineering drawings (fine detail but not huge).
                OCR_DPI = min(200, MAX_DPI)
                zoom = OCR_DPI / 72.0
                matrix = fitz.Matrix(zoom, zoom)
                pixmap = page.get_pixmap(matrix=matrix, alpha=False)

                import pytesseract
                from PIL import Image

                # Convert PyMuPDF pixmap → PIL Image without writing to disk
                img = Image.frombytes("RGB", [pixmap.width, pixmap.height],
                                      pixmap.samples)
                text = pytesseract.image_to_string(img).strip()
                method = 'ocr'
            else:
                text = ''
                method = 'none'

            # Normalise whitespace — multiple newlines → single, tabs → space
            text = re.sub(r'\n{3,}', '\n\n', text)
            text = re.sub(r'\t', ' ', text)

            words = [w for w in text.split() if w]
            chars = len(text.replace(' ', '').replace('\n', ''))

            return {
                'text': text,
                'word_count': len(words),
                'char_count': chars,
                'has_native_text': has_native,
                'method': method,
                'ocr_available': ocr_available,
                'page': page_number,
            }
        finally:
            doc.close()

    @staticmethod
    def _ocr_available() -> bool:
        """
        Check whether pytesseract and tesseract binary are both usable.

        Cached via a module-level flag after the first call so we don't
        re-probe on every request.

        Returns:
            True if OCR can be attempted; False otherwise.
        """
        # Module-level cache — set on first call
        if not hasattr(PDFEngine, '_ocr_checked'):
            try:
                import pytesseract
                # get_tesseract_version() probes the binary; raises if missing
                pytesseract.get_tesseract_version()
                PDFEngine._ocr_checked = True
                PDFEngine._ocr_is_available = True
            except Exception:
                PDFEngine._ocr_checked = True
                PDFEngine._ocr_is_available = False
        return PDFEngine._ocr_is_available
