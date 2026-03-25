# Lessons Learned — PDF OCG Layer Support (2026-03-24)

**Session:** PortolanCAST OCG (Optional Content Group) layer implementation
**Drawing tested:** Wilson House Building Conversions PDF (KMS-WI-11, 87 pages, 12 OCG layer names)
**Engineer:** Bryan / PortolanCAST

---

## What We Built

Added OCG (Optional Content Group) layer panel to PortolanCAST:
- Backend: `get_pdf_layers()` and `render_page_with_layers()` in `pdf_engine.py`
- Route: `GET /api/documents/{id}/pdf-layers` and `hidden_layers` query param on the page render route
- Frontend: `pdf-layers.js` (`PDFLayerPanel` class), integrated into the Layers tab in `app.js`
- CSS: PDF layer rows, badge, header, divider above annotation layers

---

## Key Technical Findings

### 1. PyMuPDF 1.24.9 Does Not Render OCG Visibility Changes

**Problem:** Calling `doc.set_oc(xref, 0)`, `doc.set_layer()`, or writing OCG visibility state via `xref_set_key()` correctly updates the Python-side metadata, but `page.get_pixmap()` does not respect those changes. MuPDF caches page content at parse time.

**What we tried:**
- `set_oc(xref, state)` — updates state, ignored at render
- `set_layer(-1, basestate='ON', on=..., off=...)` — updates config, ignored at render
- `xref_set_key(cat_xref, 'OCProperties/D/OFF', ...)` — updates PDF structure, ignored at render
- `tobytes()` + reopen from buffer — forces re-parse, OCG visibility now respected... but exposed a deeper problem (see #3)

**Verified approach:** Content stream filtering (see #4) is the reliable path for this PyMuPDF version.

---

### 2. Engineering PDFs Have Wildly Inconsistent Layer Naming

**Observation (Wilson House PDF):** 12 unique layer names including `0`, `BORDER`, `MP-HOTW-SUPP-PIPE`, `Thermostat`, `Text PS`, `Text_MS`, `VALVE TAGS`, `Valve Tags`, `vALVE tAG`.

Note: Three separate OCG entries for valve tags with different capitalization — these are from different revisions or different CAD operators. The PDF has 87 OCG xrefs across the document, multiple xrefs per unique name (one per page).

**Lesson:** Never assume consistent layer naming. The `get_pdf_layers()` deduplicates by name before returning to the UI. The content stream filter compares names case-sensitively (matching the PDF's own naming).

---

### 3. The Walls Are Sometimes on the Same Layer as the Piping

**Observation:** For KMS-WI-11 (Wilson House First Floor Mechanical), the architectural floor plan room outlines are embedded **inside** the `MP-HOTW-SUPP-PIPE` content stream. This means:
- Hiding `MP-HOTW-SUPP-PIPE` also hides the room walls
- There is no way to separate them at the PDF layer level without returning to the original AutoCAD DWG

**Why this happens:** In AutoCAD, the architectural floor plan typically arrives as an xref on its own layer. During export to PDF (via Bluebeam), the engineer may have merged or reassigned layers, placing the floor plan background in the mechanical layer's content stream.

**Bryan's observation:** "the walls are sometimes on the same layer as something else in the mechanical print" — correct, and common. Don't assume engineering PDF layers map neatly to logical disciplines.

**Practical impact for PortolanCAST:** The layer panel correctly shows all 12 OCG layers and toggling works. The limitation is in the source file, not the software.

---

### 4. Content Stream Filtering Requires BT/ET Balance Repair

**Problem:** AutoCAD/Bluebeam PDFs sometimes open a `BT` (Begin Text) operator in the **untagged preamble** of a content stream (before any `BDC` marked-content block), then close it with `ET` (End Text) **inside** an OCG BDC/EMC block. When we remove that block, the `ET` disappears. Subsequent path drawing operators (`m`, `l`, `S`, `f`, `b`) are silently discarded by the PDF interpreter because it thinks we're still in text mode.

**How we found it:** The walls content block (1,542 bytes) was present in the filtered stream and the coordinates were valid, but the rendered image was blank. Inspection showed the `ET` that closed an outer `BT` was inside the `BORDER` block we were removing. The walls block executed inside an unclosed text context.

**Fix in `_filter_content_stream()`:** After discarding each hidden block, count `BT` and `ET` operators inside the removed span. If the block contained more `ET` than `BT` (i.e., it was closing an outer text block), inject that many `\nET\n` operators at the removal point. This restores path-drawing mode for subsequent content.

```python
bt_in_removed = len(_bt_re.findall(removed_chunk))
et_in_removed = len(_et_re.findall(removed_chunk))
et_deficit = et_in_removed - bt_in_removed
if et_deficit > 0 and bt_depth > 0:
    inject_count = min(et_deficit, bt_depth)
    result.append('\nET\n' * inject_count)
    bt_depth -= inject_count
```

---

### 5. Content Stream Preambles Carry Graphics State for the Whole Stream

**Observation:** In xref 2867 (the piping stream), the first 172 bytes are untagged preamble (not inside any `BDC` block). This preamble contains:
- `0.12 0 0 0.12 0 0 cm` — a coordinate scale transform (0.12x in both axes, used to map AutoCAD units to PDF points)
- A `q ... W n` clip rectangle
- Gray color state: `0.72941 0.72941 0.72941 RG/rg`
- Line width and join settings

**Why this matters:** If you use the native OCG approach (not content stream filtering), MuPDF can skip this stream entirely when its primary OCG is hidden — losing the 0.12 scale transform and making all subsequent page content render at 1:1 scale (8.3x too large, effectively off-screen).

**Fix:** Content stream filtering preserves the untagged preamble because the filter only removes content between `BDC` and `EMC` tokens. Untagged content before the first `BDC` is always passed through unchanged.

---

### 6. Form XObjects (Images) Can Be Called From Inside an OCG Block

**Observation:** The Hanger Spacing Requirements table (a 1-bit CCITTFax-encoded image, xref 2858) is invoked via `/Xop1 Do` from inside xref 2869, which is itself wrapped in `/OC /oc13 BDC ... EMC` (layer `'0'`). This means:
- The spec table is part of layer `'0'`
- It shows up in "layer 0 only" renders even though it looks unrelated to the walls
- It will be hidden when layer `'0'` is toggled off

This is another case of inconsistent PDF authoring — the engineer placed the spec table in the base architectural layer.

---

## Implementation Status

| Feature | Status |
|---------|--------|
| `GET /api/documents/{id}/pdf-layers` | ✅ Working |
| Layer panel UI (eye toggle, show all, PDF badge) | ✅ Working |
| `render_page_with_layers()` content stream filter | ✅ Working (BT/ET fixed) |
| `hidden_layers` query param on page render | ✅ Working |
| Layer names shown correctly for Wilson House | ✅ 12 layers, deduplicated |
| Piping hidden independently of walls | ❌ Not possible — same layer in this drawing |

---

## What Works Well in Practice

For the Wilson House drawing, useful layer combinations:

| Goal | Action |
|------|--------|
| Reduce text clutter | Hide `Text PS`, `Text_MS` |
| Remove title block overlays | Hide `BORDER` |
| Remove thermostat symbols | Hide `Thermostat` |
| Remove valve tag numbers | Hide `VALVE TAGS`, `Valve Tags`, `vALVE tAG` |
| Clean mechanical view | Hide text + border layers |
| Walls only | Not possible in this PDF (walls are in piping layer) |

---

## References

- PyMuPDF version: 1.24.9
- PDF spec: BDC/EMC marked content (§14.6), Optional Content Groups (§8.11), Text objects (§9.4)
- Wilson House PDF: `0c0769e0128...2025 GEO-Wilson House Building Conversions-1.pdf`
- Modified files: `pdf_engine.py`, `routes/documents.py`, `static/js/pdf-layers.js`, `static/js/pdf-viewer.js`, `static/js/app.js`, `static/css/style.css`
