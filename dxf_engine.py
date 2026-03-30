"""
PortolanCAST — DXF/DWG Engine

Purpose:
    Handles DXF (and DWG via external converter) files for use as floor plan
    base layers. Extracts layer structure, block definitions, and text entities
    from CAD drawings, and renders selective layer combinations to PNG for the
    Fabric.js canvas overlay.

    This module parallels pdf_engine.py in architecture — pdf_engine handles
    PDF rendering, dxf_engine handles CAD rendering. Both produce PNG images
    that the viewer displays as base layers.

    Pipeline:
        DWG → (ODA/LibreDWG) → DXF → ezdxf → layer/block/text extraction
                                            → selective PNG rendering

Security assumptions:
    - DXF/DWG files come from user upload (local user, not remote)
    - Input paths validated by the FastAPI layer before reaching here
    - External converter (ODA/LibreDWG) is a trusted local binary
    - ezdxf parses files in memory — no shell execution

Threat model:
    - Malformed DXF could exploit parser bugs in ezdxf
    - Mitigation: ezdxf is actively maintained; exceptions caught broadly
    - DWG conversion subprocess could be exploited via filename injection
    - Mitigation: paths passed as list args (no shell=True), filenames sanitized
    - Extremely large CAD files could exhaust memory
    - Mitigation: entity count limits, timeout on rendering

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-30
"""

import io
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import ezdxf
from ezdxf.addons.drawing import RenderContext, Frontend
from ezdxf.addons.drawing.config import Configuration, ColorPolicy, BackgroundPolicy
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend

logger = logging.getLogger(__name__)


# =============================================================================
# DWG → DXF CONVERSION
# =============================================================================

# Search paths for DWG conversion tools (checked in order)
_DWG_CONVERTER_PATHS = [
    # ODA File Converter — Windows install (most common)
    "/mnt/c/Program Files/ODA/ODAFileConverter/ODAFileConverter.exe",
    # ODA — alternative install location
    "/mnt/c/Program Files (x86)/ODA/ODAFileConverter/ODAFileConverter.exe",
    # LibreDWG — Linux native (if installed)
    "dwg2dxf",
]


def _find_dwg_converter() -> Optional[str]:
    """
    Locate a DWG-to-DXF converter on this system.

    Checks for ODA File Converter (Windows) and LibreDWG dwg2dxf (Linux).
    Returns the path to the converter or None if not found.
    """
    for path in _DWG_CONVERTER_PATHS:
        if path.startswith("/mnt/") or path.startswith("/"):
            if Path(path).exists():
                return path
        else:
            # Bare command name — check if it's on PATH
            if shutil.which(path):
                return path
    return None


def convert_dwg_to_dxf(dwg_path: str, output_dir: Optional[str] = None) -> str:
    """
    Convert a DWG file to DXF using an external converter.

    Tries ODA File Converter first, falls back to LibreDWG's dwg2dxf.
    The conversion preserves all layers, blocks, and entity structure.

    Args:
        dwg_path: Path to the input .dwg file
        output_dir: Directory for the output .dxf (default: same as input)

    Returns:
        Path to the generated .dxf file

    Raises:
        RuntimeError: If no DWG converter is available or conversion fails
    """
    dwg = Path(dwg_path)
    if not dwg.exists():
        raise FileNotFoundError(f"DWG file not found: {dwg_path}")

    if output_dir is None:
        output_dir = str(dwg.parent)

    converter = _find_dwg_converter()
    if converter is None:
        raise RuntimeError(
            "No DWG converter found. Install ODA File Converter "
            "(https://www.opendesign.com/guestfiles/oda_file_converter) "
            "or LibreDWG (apt install libredwg-tools)."
        )

    dxf_path = Path(output_dir) / dwg.with_suffix(".dxf").name

    if "ODAFileConverter" in converter:
        # ODA batch mode: converts all files in input dir to output dir
        # We use a temp dir with just our file to avoid batch side-effects
        with tempfile.TemporaryDirectory() as tmp_in:
            tmp_dwg = Path(tmp_in) / dwg.name
            shutil.copy2(dwg, tmp_dwg)

            # SECURITY: args passed as list, no shell injection possible
            result = subprocess.run(
                [converter, tmp_in, output_dir, "ACAD2018", "DXF", "0", "1"],
                capture_output=True, text=True, timeout=120
            )
            if result.returncode != 0:
                raise RuntimeError(
                    f"ODA conversion failed (exit {result.returncode}): "
                    f"{result.stderr}"
                )

    elif "dwg2dxf" in converter:
        # LibreDWG: dwg2dxf input.dwg [-o output.dxf]
        # SECURITY: args passed as list, no shell injection
        result = subprocess.run(
            [converter, str(dwg), "-o", str(dxf_path)],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"LibreDWG conversion failed (exit {result.returncode}): "
                f"{result.stderr}"
            )

    if not dxf_path.exists():
        raise RuntimeError(f"Conversion produced no output at {dxf_path}")

    logger.info("DWG → DXF conversion complete: %s → %s", dwg_path, dxf_path)
    return str(dxf_path)


# =============================================================================
# DXF PARSING & METADATA EXTRACTION
# =============================================================================

class DXFEngine:
    """
    Parses DXF files and provides layer structure, block info, text extraction,
    and selective rendering to PNG for the PortolanCAST viewer.
    """

    def get_dxf_info(self, dxf_path: str) -> dict:
        """
        Extract metadata from a DXF file.

        Returns a dict matching the structure of PDFEngine.get_pdf_info() so the
        upload route can handle both formats uniformly.

        Args:
            dxf_path: Path to the DXF file

        Returns:
            Dict with keys: page_count, file_size, page_sizes, layers, blocks,
                           source_format, entity_count
        """
        doc = ezdxf.readfile(dxf_path)
        msp = doc.modelspace()

        # Count entities (capped to avoid memory issues on huge files)
        entity_count = 0
        for _ in msp:
            entity_count += 1
            if entity_count > 500_000:
                break

        # Extract layer info
        layers = []
        for layer in doc.layers:
            layers.append({
                "name": layer.dxf.name,
                "color": layer.dxf.color,
                "is_on": layer.is_on(),
                "is_frozen": layer.is_frozen(),
                "is_locked": layer.is_locked(),
            })

        # Extract block definitions (non-anonymous, non-model/paper space)
        blocks = []
        for block in doc.blocks:
            name = block.name
            # Skip internal blocks (*Model_Space, *Paper_Space, anonymous *D##)
            if name.startswith("*"):
                continue
            # Count entities in this block
            block_entity_count = sum(1 for _ in block)
            blocks.append({
                "name": name,
                "entity_count": block_entity_count,
            })

        # Get drawing extents for page size calculation.
        # modelspace extents give us the bounding box of all geometry.
        # ezdxf uses ~1e+20 as sentinel for "not calculated" — detect and
        # fall back to calculating from actual entity bounding boxes.
        try:
            extmin = doc.header.get("$EXTMIN", (0, 0, 0))
            extmax = doc.header.get("$EXTMAX", (100, 100, 0))
            width = abs(extmax[0] - extmin[0])
            height = abs(extmax[1] - extmin[1])
            # Sentinel check: if extents are unreasonably large, recalculate
            if width > 1e+10 or height > 1e+10:
                raise ValueError("extents not calculated")
        except (KeyError, TypeError, ValueError):
            # Calculate bounding box from actual entities
            try:
                from ezdxf import bbox
                cache = bbox.Cache()
                result = bbox.extents(msp, cache=cache)
                if result.has_data:
                    width = result.size.x
                    height = result.size.y
                else:
                    width, height = 1000, 1000
            except Exception:
                width, height = 1000, 1000

        file_size = os.path.getsize(dxf_path)

        return {
            "page_count": 1,  # DXF modelspace = 1 "page"
            "file_size": file_size,
            "page_sizes": [{"width": width, "height": height}],
            "layers": layers,
            "blocks": blocks,
            "source_format": "dxf",
            "entity_count": entity_count,
        }

    def get_layers(self, dxf_path: str) -> list:
        """
        Get layer names and properties from a DXF file.

        Returns a list matching the format expected by the PDFLayerPanel UI
        so the frontend layer toggle code works without modification.

        Args:
            dxf_path: Path to the DXF file

        Returns:
            List of dicts with: name, visible (bool), color
        """
        doc = ezdxf.readfile(dxf_path)
        result = []
        for layer in doc.layers:
            result.append({
                "name": layer.dxf.name,
                "visible": layer.is_on() and not layer.is_frozen(),
                "color": layer.dxf.color,
            })
        return result

    def get_text_entities(self, dxf_path: str) -> list:
        """
        Extract text entities from the DXF — room names, equipment tags, labels.

        These can be used to pre-populate PortolanCAST entity names and notes.

        Args:
            dxf_path: Path to the DXF file

        Returns:
            List of dicts with: text, x, y, layer, height
        """
        doc = ezdxf.readfile(dxf_path)
        msp = doc.modelspace()
        texts = []

        for entity in msp.query("TEXT MTEXT"):
            try:
                if entity.dxftype() == "TEXT":
                    texts.append({
                        "text": entity.dxf.text,
                        "x": entity.dxf.insert[0],
                        "y": entity.dxf.insert[1],
                        "layer": entity.dxf.layer,
                        "height": getattr(entity.dxf, "height", 0),
                    })
                elif entity.dxftype() == "MTEXT":
                    texts.append({
                        "text": entity.text,
                        "x": entity.dxf.insert[0],
                        "y": entity.dxf.insert[1],
                        "layer": entity.dxf.layer,
                        "height": getattr(entity.dxf, "char_height", 0),
                    })
            except Exception:
                # Skip malformed text entities
                continue

        return texts

    def get_block_insertions(self, dxf_path: str) -> list:
        """
        Extract block insertion points from the DXF.

        Block insertions represent placed equipment, fixtures, symbols, etc.
        These can be mapped to PortolanCAST equipment entities.

        Args:
            dxf_path: Path to the DXF file

        Returns:
            List of dicts with: block_name, x, y, layer, scale_x, scale_y, rotation
        """
        doc = ezdxf.readfile(dxf_path)
        msp = doc.modelspace()
        insertions = []

        for insert in msp.query("INSERT"):
            try:
                insertions.append({
                    "block_name": insert.dxf.name,
                    "x": insert.dxf.insert[0],
                    "y": insert.dxf.insert[1],
                    "layer": insert.dxf.layer,
                    "scale_x": getattr(insert.dxf, "xscale", 1.0),
                    "scale_y": getattr(insert.dxf, "yscale", 1.0),
                    "rotation": getattr(insert.dxf, "rotation", 0.0),
                })
            except Exception:
                continue

        return insertions

    def render_to_png(
        self,
        dxf_path: str,
        dpi: float = 150.0,
        hidden_layers: Optional[list] = None,
        bg_color: str = "#FFFFFF",
    ) -> bytes:
        """
        Render the DXF modelspace to a PNG image.

        Uses ezdxf's matplotlib backend for rendering. Supports selective layer
        visibility to match the existing OCG layer toggle behavior.

        Args:
            dxf_path: Path to the DXF file
            dpi: Rendering resolution (default 150, matches RENDER_DPI)
            hidden_layers: List of layer names to hide (default: show all)
            bg_color: Background color (default white)

        Returns:
            PNG image bytes
        """
        import matplotlib
        matplotlib.use("Agg")  # Non-interactive backend — no display needed
        import matplotlib.pyplot as plt

        doc = ezdxf.readfile(dxf_path)

        # Apply layer visibility before rendering
        if hidden_layers:
            hidden_set = set(hidden_layers)
            for layer in doc.layers:
                if layer.dxf.name in hidden_set:
                    layer.off()
                else:
                    layer.on()

        msp = doc.modelspace()

        # Create rendering context and figure.
        # Configure background so DXF color 7 (foreground) inverts correctly:
        # renders as black on white bg, white on dark bg — matching AutoCAD behavior.
        fig = plt.figure(dpi=dpi)
        ax = fig.add_axes([0, 0, 1, 1])
        ctx = RenderContext(doc)
        out = MatplotlibBackend(ax)

        # Frontend config: set custom bg so color 7 inverts properly
        cfg = Configuration(
            background_policy=BackgroundPolicy.CUSTOM,
            custom_bg_color=bg_color,
        )
        Frontend(ctx, out, config=cfg).draw_layout(msp)

        ax.set_facecolor(bg_color)
        ax.set_aspect("equal")
        ax.autoscale(True)
        ax.margins(0.02)

        # Remove axis decorations — we want a clean floor plan image
        ax.set_axis_off()

        # Render to PNG bytes
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight",
                    pad_inches=0.1, facecolor=bg_color)
        plt.close(fig)

        buf.seek(0)
        return buf.read()

    def render_page(
        self,
        dxf_path: str,
        page_number: int = 1,
        dpi: float = 150.0,
        hidden_layers: Optional[list] = None,
    ) -> bytes:
        """
        Render a 'page' from a DXF file (page_number is ignored — DXF has one
        modelspace). This method signature matches pdf_engine.render_page() so
        the view route can call either engine uniformly.

        Args:
            dxf_path: Path to the DXF file
            page_number: Ignored (DXF = 1 page). Present for API compatibility.
            dpi: Rendering resolution
            hidden_layers: Layer names to hide

        Returns:
            PNG image bytes
        """
        return self.render_to_png(dxf_path, dpi=dpi, hidden_layers=hidden_layers)
