"""
PortolanCAST — DWG Converter & DXF Repair Tool

Purpose:
    Standalone converter that transforms DWG files into clean, ezdxf-parseable
    DXF files. Wraps LibreDWG's dwg2dxf.exe for the binary conversion, then
    repairs the output by extracting raw entities from the DXF text and
    rebuilding a structurally valid DXF using ezdxf.

    This is necessary because LibreDWG's DXF output for old DWG formats
    (especially AC1006/R10) can have malformed BLOCKS sections that crash
    ezdxf's parser. The repair step bypasses this by reading the ENTITIES
    section as raw text and reconstructing them in a fresh document.

    Pipeline:
        DWG → LibreDWG dwg2dxf.exe → raw DXF → text parse → ezdxf rebuild → clean DXF

Usage:
    # As a module (called by PortolanCAST upload route)
    from dwg_converter import convert_and_repair
    clean_dxf_path = convert_and_repair("path/to/file.dwg")

    # As a CLI tool
    python3 dwg_converter.py input.dwg [-o output.dxf] [--verbose]

Security assumptions:
    - Input files come from local user upload (not remote)
    - LibreDWG .exe is a trusted local binary
    - subprocess called with list args (no shell injection)
    - Temporary files created in system temp dir, cleaned up on completion

Threat model:
    - Malformed DWG could cause LibreDWG to crash → caught by subprocess timeout
    - Enormous DWG could exhaust memory during DXF text parsing → entity count cap
    - Path traversal in filenames → sanitized by caller (upload route uses UUIDs)

Author: PortolanCAST
Version: 0.1.0
Date: 2026-03-30
"""

import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Maximum entities to extract — prevents memory exhaustion on huge files
MAX_ENTITIES = 100_000

# LibreDWG binary location (Windows .exe called from WSL2)
_LIBREDWG_DIR = Path.home() / ".local" / "libredwg"
_DWG2DXF_EXE = _LIBREDWG_DIR / "dwg2dxf.exe"


# =============================================================================
# DWG → RAW DXF (LibreDWG)
# =============================================================================

def _find_converter() -> Optional[Path]:
    """
    Locate the dwg2dxf converter binary.

    Checks:
      1. ~/.local/libredwg/dwg2dxf.exe (our installed Windows binary)
      2. ODA File Converter paths
      3. System PATH (dwg2dxf on Linux)

    Returns:
        Path to the converter or None.
    """
    # Our installed LibreDWG Windows binary
    if _DWG2DXF_EXE.exists():
        return _DWG2DXF_EXE

    # ODA File Converter (Windows)
    for oda_path in [
        Path("/mnt/c/Program Files/ODA/ODAFileConverter/ODAFileConverter.exe"),
        Path("/mnt/c/Program Files (x86)/ODA/ODAFileConverter/ODAFileConverter.exe"),
    ]:
        if oda_path.exists():
            return oda_path

    # System-installed dwg2dxf (Linux)
    system = shutil.which("dwg2dxf")
    if system:
        return Path(system)

    return None


def _wsl_to_windows_path(linux_path: str) -> str:
    """
    Convert a WSL Linux path to a Windows path for .exe interop.

    /mnt/c/Users/User1/file.dwg → C:\\Users\\User1\\file.dwg
    /home/user/file.dwg → \\\\wsl$\\Ubuntu\\home\\user\\file.dwg

    The .exe needs Windows-style paths to find files.
    """
    p = Path(linux_path).resolve()
    path_str = str(p)

    # /mnt/c/... → C:\...
    mnt_match = re.match(r'^/mnt/([a-zA-Z])/(.*)', path_str)
    if mnt_match:
        drive = mnt_match.group(1).upper()
        rest = mnt_match.group(2).replace('/', '\\')
        return f"{drive}:\\{rest}"

    # Native WSL path → UNC path (may not work for all .exe)
    # Safer: copy to /mnt/c/Users/.../temp first
    return path_str


def _convert_with_libredwg(dwg_path: str, output_dir: str) -> str:
    """
    Convert DWG to raw DXF using LibreDWG's dwg2dxf.exe.

    The output may have structural issues (especially for old DWG versions).
    The raw DXF is the input for the repair step.

    Args:
        dwg_path: Path to the .dwg file (WSL path)
        output_dir: Directory for the output .dxf

    Returns:
        Path to the raw DXF file

    Raises:
        RuntimeError: If conversion fails or produces no output
    """
    converter = _find_converter()
    if converter is None:
        raise RuntimeError(
            "No DWG converter found. Install LibreDWG: the dwg2dxf.exe binary "
            "should be at ~/.local/libredwg/dwg2dxf.exe"
        )

    dwg = Path(dwg_path)
    dxf_name = dwg.stem + "_raw.dxf"

    # For Windows .exe, we need to work in a Windows-accessible directory
    if str(converter).endswith(".exe"):
        # Copy DWG to a Windows-accessible temp dir for .exe interop.
        # Use C:\Temp\ — avoids per-user path detection issues in WSL.
        win_temp = Path("/mnt/c/Temp/portolancast")
        win_temp.mkdir(parents=True, exist_ok=True)

        temp_dwg = win_temp / dwg.name
        temp_dxf = win_temp / dxf_name
        shutil.copy2(dwg, temp_dwg)

        win_dwg = _wsl_to_windows_path(str(temp_dwg))
        win_dxf = _wsl_to_windows_path(str(temp_dxf))

        # SECURITY: args as list, no shell injection
        result = subprocess.run(
            [str(converter), "-y", win_dwg, "-o", win_dxf],
            capture_output=True, text=True, timeout=120
        )

        # Copy result back to output_dir
        final_path = Path(output_dir) / dxf_name
        if temp_dxf.exists():
            shutil.copy2(temp_dxf, final_path)
            # Cleanup temp files
            temp_dwg.unlink(missing_ok=True)
            temp_dxf.unlink(missing_ok=True)
        else:
            temp_dwg.unlink(missing_ok=True)
            raise RuntimeError(
                f"LibreDWG produced no output. Exit code: {result.returncode}. "
                f"stderr: {result.stderr[:200]}"
            )
    else:
        # Linux native dwg2dxf
        final_path = Path(output_dir) / dxf_name
        result = subprocess.run(
            [str(converter), "-y", str(dwg), "-o", str(final_path)],
            capture_output=True, text=True, timeout=120
        )
        if not final_path.exists():
            raise RuntimeError(
                f"dwg2dxf produced no output. Exit code: {result.returncode}. "
                f"stderr: {result.stderr[:200]}"
            )

    logger.info("DWG → raw DXF: %s (%d bytes)", final_path, final_path.stat().st_size)
    return str(final_path)


# =============================================================================
# RAW DXF TEXT PARSING
# =============================================================================

def _parse_raw_dxf(dxf_path: str) -> dict:
    """
    Parse a potentially malformed DXF file by reading it as plain text.

    Extracts the HEADER (for drawing extents, version, layers) and the
    ENTITIES section (geometry). Skips the BLOCKS section entirely — that's
    where LibreDWG's R10 output has structural issues.

    Args:
        dxf_path: Path to the raw DXF file

    Returns:
        Dict with keys:
            extmin: (x, y) drawing minimum extent
            extmax: (x, y) drawing maximum extent
            layers: list of layer name strings
            entities: list of entity dicts (type, layer, coordinates, text, etc.)
    """
    with open(dxf_path, 'r', errors='replace') as f:
        lines = f.readlines()

    # Strip trailing whitespace/newlines
    lines = [l.rstrip('\n').rstrip('\r') for l in lines]

    result = {
        "extmin": (0.0, 0.0),
        "extmax": (100.0, 100.0),
        "layers": set(),
        "entities": [],
    }

    # --- Parse HEADER section for extents ---
    i = 0
    while i < len(lines) - 1:
        if lines[i].strip() == '9' and lines[i + 1].strip() == '$EXTMIN':
            # Next group codes 10, 20 are x, y
            j = i + 2
            x, y = 0.0, 0.0
            while j < len(lines) - 1 and j < i + 12:
                code = lines[j].strip()
                val = lines[j + 1].strip()
                if code == '10':
                    x = float(val)
                elif code == '20':
                    y = float(val)
                    break
                j += 2
            result["extmin"] = (x, y)

        elif lines[i].strip() == '9' and lines[i + 1].strip() == '$EXTMAX':
            j = i + 2
            x, y = 100.0, 100.0
            while j < len(lines) - 1 and j < i + 12:
                code = lines[j].strip()
                val = lines[j + 1].strip()
                if code == '10':
                    x = float(val)
                elif code == '20':
                    y = float(val)
                    break
                j += 2
            result["extmax"] = (x, y)

        # Exit header parsing at first ENDSEC
        elif lines[i].strip() == '0' and lines[i + 1].strip() == 'ENDSEC':
            break
        i += 1

    # --- Find ENTITIES section ---
    entities_start = None
    entities_end = None
    for i in range(len(lines) - 1):
        if lines[i].strip() == '2' and lines[i + 1].strip() == 'ENTITIES':
            entities_start = i + 2
        elif entities_start and lines[i].strip() == '0' and lines[i + 1].strip() == 'ENDSEC':
            entities_end = i
            break

    if entities_start is None:
        logger.warning("No ENTITIES section found in %s", dxf_path)
        return result

    # --- Parse entities ---
    i = entities_start
    entity_count = 0

    while i < entities_end and entity_count < MAX_ENTITIES:
        # Each entity starts with group code 0 and entity type
        if lines[i].strip() != '0':
            i += 1
            continue

        entity_type = lines[i + 1].strip() if i + 1 < entities_end else ""
        if entity_type in ('ENDSEC', 'EOF'):
            break

        # Collect all group code/value pairs for this entity
        entity = {"type": entity_type, "layer": "0"}
        j = i + 2
        while j < entities_end - 1:
            code_str = lines[j].strip()
            # Next entity starts at group code 0
            if code_str == '0':
                break
            try:
                code = int(code_str)
            except ValueError:
                j += 2
                continue
            val = lines[j + 1].strip() if j + 1 < entities_end else ""

            # Map group codes to entity properties
            if code == 8:
                entity["layer"] = val
                result["layers"].add(val)
            elif code == 10:
                entity["x1"] = _safe_float(val)
            elif code == 20:
                entity["y1"] = _safe_float(val)
            elif code == 11:
                entity["x2"] = _safe_float(val)
            elif code == 21:
                entity["y2"] = _safe_float(val)
            elif code == 40:
                entity["radius"] = _safe_float(val)  # circles, arcs, text height
            elif code == 50:
                entity["start_angle"] = _safe_float(val)
            elif code == 51:
                entity["end_angle"] = _safe_float(val)
            elif code == 1:
                entity["text"] = val
            elif code == 7:
                entity["style"] = val
            elif code == 62:
                entity["color"] = _safe_int(val)
            elif code == 6:
                entity["linetype"] = val

            j += 2

        result["entities"].append(entity)
        entity_count += 1
        i = j

    result["layers"] = sorted(result["layers"])
    logger.info(
        "Parsed raw DXF: %d entities, %d layers, extents (%.1f,%.1f)→(%.1f,%.1f)",
        len(result["entities"]), len(result["layers"]),
        *result["extmin"], *result["extmax"]
    )
    return result


def _safe_float(val: str, default: float = 0.0) -> float:
    """Parse a float, returning default on failure."""
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def _safe_int(val: str, default: int = 0) -> int:
    """Parse an int, returning default on failure."""
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


# =============================================================================
# DXF RECONSTRUCTION (ezdxf)
# =============================================================================

def _rebuild_dxf(parsed: dict, output_path: str) -> str:
    """
    Rebuild a clean, ezdxf-parseable DXF from extracted raw entity data.

    Creates a fresh R2010 DXF document, adds layers, then reconstructs each
    entity from the parsed group code data. The resulting file is guaranteed
    to be parseable by ezdxf and renderable by dxf_engine.

    Args:
        parsed: Dict from _parse_raw_dxf() with entities, layers, extents
        output_path: Where to save the clean DXF

    Returns:
        Path to the clean DXF file
    """
    import ezdxf

    doc = ezdxf.new('R2010')
    msp = doc.modelspace()

    # Set drawing extents from original
    doc.header['$EXTMIN'] = (*parsed["extmin"], 0.0)
    doc.header['$EXTMAX'] = (*parsed["extmax"], 0.0)

    # Create layers from the original drawing
    # Use distinct colors so layers are visually distinguishable
    layer_colors = [7, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 30, 40, 50]
    for idx, layer_name in enumerate(parsed["layers"]):
        if layer_name == "0":
            continue  # Layer 0 always exists
        color = layer_colors[idx % len(layer_colors)]
        doc.layers.add(layer_name, color=color)

    # Reconstruct entities
    stats = {"LINE": 0, "CIRCLE": 0, "ARC": 0, "TEXT": 0, "POINT": 0,
             "SOLID": 0, "INSERT": 0, "POLYLINE": 0, "other": 0}

    for ent in parsed["entities"]:
        etype = ent["type"]
        layer = ent.get("layer", "0")
        attribs = {"layer": layer}

        # Optional color override (entity-level color vs layer color)
        if "color" in ent:
            attribs["color"] = ent["color"]

        try:
            if etype == "LINE":
                x1 = ent.get("x1", 0)
                y1 = ent.get("y1", 0)
                x2 = ent.get("x2", 0)
                y2 = ent.get("y2", 0)
                msp.add_line((x1, y1), (x2, y2), dxfattribs=attribs)
                stats["LINE"] += 1

            elif etype == "CIRCLE":
                cx = ent.get("x1", 0)
                cy = ent.get("y1", 0)
                r = ent.get("radius", 1)
                msp.add_circle((cx, cy), radius=r, dxfattribs=attribs)
                stats["CIRCLE"] += 1

            elif etype == "ARC":
                cx = ent.get("x1", 0)
                cy = ent.get("y1", 0)
                r = ent.get("radius", 1)
                sa = ent.get("start_angle", 0)
                ea = ent.get("end_angle", 360)
                msp.add_arc((cx, cy), radius=r, start_angle=sa, end_angle=ea,
                            dxfattribs=attribs)
                stats["ARC"] += 1

            elif etype == "TEXT":
                text = ent.get("text", "")
                if text:
                    x = ent.get("x1", 0)
                    y = ent.get("y1", 0)
                    height = ent.get("radius", 0.1)  # group code 40 = text height
                    attribs["height"] = max(height, 0.01)
                    msp.add_text(text, dxfattribs=attribs).set_placement((x, y))
                    stats["TEXT"] += 1

            elif etype == "POINT":
                x = ent.get("x1", 0)
                y = ent.get("y1", 0)
                msp.add_point((x, y), dxfattribs=attribs)
                stats["POINT"] += 1

            elif etype == "SOLID":
                # SOLID uses corners at 10/20, 11/21, 12/22, 13/23
                # Simplified: draw as a filled polygon approximation (4 lines)
                x1 = ent.get("x1", 0)
                y1 = ent.get("y1", 0)
                x2 = ent.get("x2", 0)
                y2 = ent.get("y2", 0)
                msp.add_line((x1, y1), (x2, y2), dxfattribs=attribs)
                stats["SOLID"] += 1

            elif etype == "POLYLINE":
                # Polylines are complex (vertices follow as separate entities).
                # In our raw parsing they're just markers. Skip for now —
                # the VERTEX entities that follow have coordinate data.
                stats["POLYLINE"] += 1

            elif etype == "VERTEX":
                # Vertex of a polyline — draw as a point to preserve location
                x = ent.get("x1", 0)
                y = ent.get("y1", 0)
                msp.add_point((x, y), dxfattribs=attribs)

            elif etype == "INSERT":
                # Block insertion — we don't have the block definitions (they
                # were in the corrupt BLOCKS section), so mark the location
                x = ent.get("x1", 0)
                y = ent.get("y1", 0)
                # Draw a small cross to mark the insertion point
                s = 0.2  # cross size
                msp.add_line((x - s, y), (x + s, y), dxfattribs=attribs)
                msp.add_line((x, y - s), (x, y + s), dxfattribs=attribs)
                stats["INSERT"] += 1

            else:
                stats["other"] += 1

        except Exception as e:
            logger.debug("Skipped entity %s: %s", etype, e)
            stats["other"] += 1

    doc.saveas(output_path)

    total = sum(stats.values())
    logger.info(
        "Rebuilt clean DXF: %d entities → %s. Saved to %s",
        total, dict(stats), output_path
    )
    return output_path


# =============================================================================
# POLYLINE RECONSTRUCTION
# =============================================================================

def _reconstruct_polylines(parsed: dict) -> list:
    """
    Convert POLYLINE/VERTEX/SEQEND sequences into line segments.

    In DXF, a polyline is a POLYLINE entity followed by VERTEX entities
    (each with x,y coordinates) and terminated by SEQEND. We convert these
    into individual LINE entities that ezdxf can handle cleanly.

    Args:
        parsed: Dict from _parse_raw_dxf()

    Returns:
        List of LINE entity dicts to add to the entities list
    """
    extra_lines = []
    i = 0
    entities = parsed["entities"]

    while i < len(entities):
        ent = entities[i]

        if ent["type"] == "POLYLINE":
            layer = ent.get("layer", "0")
            color = ent.get("color")
            vertices = []

            # Collect subsequent VERTEX entities until SEQEND
            j = i + 1
            while j < len(entities):
                if entities[j]["type"] == "VERTEX":
                    vx = entities[j].get("x1", 0)
                    vy = entities[j].get("y1", 0)
                    vertices.append((vx, vy))
                elif entities[j]["type"] == "SEQEND":
                    j += 1
                    break
                else:
                    break
                j += 1

            # Convert vertex chain to line segments
            for k in range(len(vertices) - 1):
                line = {
                    "type": "LINE",
                    "layer": layer,
                    "x1": vertices[k][0],
                    "y1": vertices[k][1],
                    "x2": vertices[k + 1][0],
                    "y2": vertices[k + 1][1],
                }
                if color is not None:
                    line["color"] = color
                extra_lines.append(line)

            i = j
        else:
            i += 1

    return extra_lines


# =============================================================================
# PUBLIC API
# =============================================================================

def convert_and_repair(dwg_path: str, output_path: Optional[str] = None,
                       verbose: bool = False) -> str:
    """
    Convert a DWG file to a clean, ezdxf-parseable DXF.

    Full pipeline:
      1. DWG → raw DXF via LibreDWG
      2. Try ezdxf.readfile() — if it works, the DXF is already clean
      3. If ezdxf fails, parse raw DXF text and rebuild a clean document
      4. Reconstruct polylines from VERTEX chains
      5. Save clean DXF

    Args:
        dwg_path: Path to the input .dwg file
        output_path: Path for the output .dxf (default: same dir, same name)
        verbose: If True, print progress to stdout

    Returns:
        Path to the clean DXF file

    Raises:
        FileNotFoundError: If the DWG file doesn't exist
        RuntimeError: If conversion fails entirely
    """
    dwg = Path(dwg_path)
    if not dwg.exists():
        raise FileNotFoundError(f"DWG file not found: {dwg_path}")

    if output_path is None:
        output_path = str(dwg.with_suffix(".dxf"))

    if verbose:
        print(f"Converting: {dwg.name}")

    # Step 1: DWG → raw DXF
    with tempfile.TemporaryDirectory() as tmp_dir:
        if verbose:
            print("  Step 1: DWG → raw DXF (LibreDWG)...")
        raw_dxf = _convert_with_libredwg(str(dwg), tmp_dir)

        # Step 2: Try direct ezdxf parse (works for newer DWG formats)
        try:
            import ezdxf
            doc = ezdxf.readfile(raw_dxf)
            # If we get here, the DXF is already valid — just save it
            doc.saveas(output_path)
            if verbose:
                print(f"  Direct parse succeeded — clean DXF at {output_path}")
            return output_path
        except Exception as e:
            if verbose:
                print(f"  Direct parse failed ({type(e).__name__}), entering repair mode...")
            logger.info("Direct ezdxf parse failed, repairing: %s", e)

        # Step 3: Parse raw DXF text
        if verbose:
            print("  Step 2: Parsing raw DXF text...")
        parsed = _parse_raw_dxf(raw_dxf)

        if verbose:
            print(f"    Found {len(parsed['entities'])} entities, "
                  f"{len(parsed['layers'])} layers")
            # Count by type
            from collections import Counter
            counts = Counter(e["type"] for e in parsed["entities"])
            for etype, count in counts.most_common():
                print(f"      {etype}: {count}")

        # Step 4: Reconstruct polylines into line segments
        extra_lines = _reconstruct_polylines(parsed)
        if extra_lines:
            parsed["entities"].extend(extra_lines)
            if verbose:
                print(f"    Reconstructed {len(extra_lines)} line segments "
                      f"from polyline vertices")

        # Step 5: Rebuild clean DXF
        if verbose:
            print("  Step 3: Rebuilding clean DXF...")
        _rebuild_dxf(parsed, output_path)

    if verbose:
        out_size = Path(output_path).stat().st_size
        print(f"  Done: {output_path} ({out_size:,} bytes)")

    return output_path


def is_converter_available() -> bool:
    """Check if a DWG converter binary is available on this system."""
    return _find_converter() is not None


def get_converter_info() -> dict:
    """
    Get information about the available DWG converter.

    Returns:
        Dict with 'available' bool, 'path' str, 'type' str
    """
    converter = _find_converter()
    if converter is None:
        return {"available": False, "path": None, "type": None}

    if "ODAFileConverter" in str(converter):
        ctype = "oda"
    elif "dwg2dxf" in str(converter):
        ctype = "libredwg"
    else:
        ctype = "unknown"

    return {"available": True, "path": str(converter), "type": ctype}


# =============================================================================
# CLI ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(
        description="Convert DWG files to clean, ezdxf-parseable DXF",
        epilog="Part of PortolanCAST — https://github.com/OdinKral/PortolanCAST"
    )
    parser.add_argument("input", help="Input .dwg file path")
    parser.add_argument("-o", "--output", help="Output .dxf file path (default: same name)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Show progress")
    parser.add_argument("--info", action="store_true", help="Show converter info and exit")

    args = parser.parse_args()

    if args.info:
        info = get_converter_info()
        print(f"Converter available: {info['available']}")
        if info['available']:
            print(f"  Type: {info['type']}")
            print(f"  Path: {info['path']}")
        sys.exit(0)

    # Set up logging for verbose mode
    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)

    try:
        result = convert_and_repair(args.input, args.output, verbose=True)
        print(f"\nSuccess: {result}")
    except Exception as e:
        print(f"\nError: {e}", file=sys.stderr)
        sys.exit(1)
