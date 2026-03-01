"""
PortolanCAST — Phase 2 Calibration Spike

Purpose:
    Verifies that the 150 DPI coordinate system used throughout PortolanCAST
    is internally consistent and correctly maps Fabric.js pixel coordinates
    to PDF points (and thus to real-world units at any drawing scale).

    Run this before starting Phase 2 measurement tools. If all assertions
    pass, the coordinate system is safe to build measurement logic on.

Coordinate system summary:
    - PDF points:     1 pt = 1/72 inch (PyMuPDF standard)
    - Fabric pixels:  stored at BASE_DPI (150). 1 pixel = 1/150 inch (unscaled)
    - Scale factor:   Fabric px → PDF pts: multiply by (72 / 150) = 0.48
    - Inverse:        PDF pts → Fabric px: multiply by (150 / 72) ≈ 2.0833

Drawing scale (title block scale, not screen DPI):
    - "1/4" = 1'-0"": 0.25 paper inches represent 12 paper inches (1 real foot)
    - At 150 DPI: 0.25 * 150 = 37.5 Fabric pixels per real foot
    - Formula: pixelsPerRealUnit = BASE_DPI * paperInchesPerRealUnit

Usage:
    cd /mnt/c/Users/User1/ClaudeProjects/PortolanCAST
    venv/bin/python spike_calibration.py

Author: PortolanCAST
Version: 0.1.0
Date: 2026-02-22
"""

import sys

import fitz  # PyMuPDF

# =============================================================================
# CONSTANTS
# =============================================================================

# Our rendering resolution (must match BASE_DPI in canvas.js)
RENDER_DPI = 150.0

# PDF resolution (always 72 in the PDF specification)
PDF_DPI = 72.0

# Conversion factor: Fabric pixel → PDF points
FABRIC_PX_TO_PDF_PT = PDF_DPI / RENDER_DPI  # 0.48

# Conversion factor: PDF points → Fabric pixels
PDF_PT_TO_FABRIC_PX = RENDER_DPI / PDF_DPI  # 2.0833...

# Known page sizes in PDF points (width × height at 72 DPI)
PAGE_SIZES_PT = {
    "letter":  (612.0,  792.0),   # 8.5" × 11"
    "tabloid": (792.0,  1224.0),  # 11" × 17"
    "arch_d":  (1728.0, 2592.0),  # 24" × 36"
}

# =============================================================================
# VERIFICATION
# =============================================================================

def run_spike():
    """
    Execute all calibration checks and print a summary.

    Raises:
        AssertionError: On any coordinate math inconsistency.
        SystemExit:     On pass/fail summary.
    """
    passed = 0
    failed = 0

    def check(name, value, expected, tolerance=0.01):
        nonlocal passed, failed
        if abs(value - expected) <= tolerance:
            print(f"  ✓ {name}: {value:.4f} (expected {expected})")
            passed += 1
        else:
            print(f"  ✗ {name}: {value:.4f} (expected {expected}) ← MISMATCH")
            failed += 1

    # -------------------------------------------------------------------------
    # Section 1: Pixel ↔ Point conversion constants
    # -------------------------------------------------------------------------
    print("\n=== Section 1: Conversion Constants ===")

    check("PDF_DPI / RENDER_DPI (should be 0.48)",
          FABRIC_PX_TO_PDF_PT, 0.48)

    check("RENDER_DPI / PDF_DPI (should be 2.0833)",
          PDF_PT_TO_FABRIC_PX, 2.0833, tolerance=0.001)

    # -------------------------------------------------------------------------
    # Section 2: Known page sizes — Fabric pixels at 150 DPI
    # -------------------------------------------------------------------------
    print("\n=== Section 2: Page Size Pixel Dimensions ===")
    print("  (Fabric pixel = PDF point * PDF_PT_TO_FABRIC_PX)")

    # Letter (612 × 792 pt) at 150 DPI
    w_px = PAGE_SIZES_PT["letter"][0] * PDF_PT_TO_FABRIC_PX
    h_px = PAGE_SIZES_PT["letter"][1] * PDF_PT_TO_FABRIC_PX
    check("Letter width  in Fabric px (should be 1275)", w_px, 1275.0)
    check("Letter height in Fabric px (should be 1650)", h_px, 1650.0)

    # Tabloid (792 × 1224 pt) at 150 DPI
    w_px = PAGE_SIZES_PT["tabloid"][0] * PDF_PT_TO_FABRIC_PX
    h_px = PAGE_SIZES_PT["tabloid"][1] * PDF_PT_TO_FABRIC_PX
    check("Tabloid width  in Fabric px (should be 1650)", w_px, 1650.0)
    check("Tabloid height in Fabric px (should be 2550)", h_px, 2550.0)

    # -------------------------------------------------------------------------
    # Section 3: Round-trip fidelity — Fabric px → PDF pts → Fabric px
    # -------------------------------------------------------------------------
    print("\n=== Section 3: Round-Trip Conversion ===")

    test_distances_px = [150.0, 37.5, 1275.0, 612.0]
    for px in test_distances_px:
        pts = px * FABRIC_PX_TO_PDF_PT
        px_back = pts * PDF_PT_TO_FABRIC_PX
        check(f"{px:.1f}px → {pts:.4f}pt → back to {px_back:.4f}px",
              px_back, px, tolerance=0.001)

    # -------------------------------------------------------------------------
    # Section 4: PyMuPDF rendered page dimensions match the math
    # -------------------------------------------------------------------------
    print("\n=== Section 4: PyMuPDF Render Verification ===")
    print("  (Creating blank pages and rendering to verify pixel dims)")

    for size_name, (w_pt, h_pt) in PAGE_SIZES_PT.items():
        doc = fitz.open()
        page = doc.new_page(width=w_pt, height=h_pt)
        zoom = RENDER_DPI / PDF_DPI
        pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        doc.close()

        expected_w = round(w_pt * zoom)
        expected_h = round(h_pt * zoom)

        check(f"{size_name} rendered width  ({expected_w}px expected)",
              float(pixmap.width), float(expected_w), tolerance=1.0)
        check(f"{size_name} rendered height ({expected_h}px expected)",
              float(pixmap.height), float(expected_h), tolerance=1.0)

    # -------------------------------------------------------------------------
    # Section 5: Drawing scale conversions (for Phase 2 measurement tools)
    # -------------------------------------------------------------------------
    print("\n=== Section 5: Drawing Scale Conversions ===")
    print("  (pixels per real-world foot at common architectural scales)")
    print(f"  Formula: pixelsPerFoot = RENDER_DPI ({RENDER_DPI}) × paperInchesPerFoot")

    # Common architectural scales: paperInchesPerFoot = scale_numerator / 12
    scales = [
        ("1/8\" = 1'-0\"",  0.125),   # 1:96  — small mechanical/electrical
        ("3/32\" = 1'-0\"", 0.09375), # 1:128 — site plans
        ("3/16\" = 1'-0\"", 0.1875),  # 1:64
        ("1/4\" = 1'-0\"",  0.25),    # 1:48  — most common floor plan scale
        ("3/8\" = 1'-0\"",  0.375),   # 1:32
        ("1/2\" = 1'-0\"",  0.5),     # 1:24  — enlarged plans
        ("1\" = 1'-0\"",    1.0),     # 1:12  — detail drawings
    ]

    for name, paper_inches_per_foot in scales:
        pixels_per_foot = RENDER_DPI * paper_inches_per_foot
        # A 10-foot span at this scale:
        pixels_10ft = pixels_per_foot * 10.0
        pdf_pts_10ft = pixels_10ft * FABRIC_PX_TO_PDF_PT
        paper_inches_10ft = pdf_pts_10ft / PDF_DPI
        print(f"  {name:18s} → {pixels_per_foot:7.3f} px/ft | "
              f"10ft = {pixels_10ft:7.2f}px = {paper_inches_10ft:.3f}\" on paper")
        passed += 1  # informational rows always pass

    # -------------------------------------------------------------------------
    # Summary
    # -------------------------------------------------------------------------
    print(f"\n{'='*50}")
    print(f"  Results: {passed} passed, {failed} failed")
    print(f"{'='*50}\n")

    if failed > 0:
        print("CALIBRATION FAILED — do not proceed to Phase 2 until fixed.\n")
        sys.exit(1)
    else:
        print("CALIBRATION PASSED — coordinate system verified.")
        print("Phase 2 measurement tools may use these constants:\n")
        print(f"  RENDER_DPI         = {RENDER_DPI}")
        print(f"  PDF_DPI            = {PDF_DPI}")
        print(f"  FABRIC_PX_TO_PDF_PT = {FABRIC_PX_TO_PDF_PT:.4f}  (px * this = pts)")
        print(f"  PDF_PT_TO_FABRIC_PX = {PDF_PT_TO_FABRIC_PX:.6f}  (pts * this = px)")
        print(f"  pixelsPerInch       = {RENDER_DPI}  (unscaled measurement)")
        print(f"  pixelsPerFoot       = RENDER_DPI × paperInchesPerFoot\n")
        sys.exit(0)


if __name__ == "__main__":
    run_spike()
