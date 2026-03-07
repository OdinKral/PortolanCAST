# MechDraw AI Plugin — Design Specification

**Status:** Phase X — Future (not yet scheduled)
**Author:** PortolanCAST
**Date:** 2026-02-24
**Related:** PortolanCAST Plugin Loader API (Phase 4B), `plugins.js`, `static/js/plugins/`

---

## Summary

MechDraw is a proposed PortolanCAST plugin that converts natural-language duct layout
descriptions into Fabric.js objects on the canvas. The user types a prompt like
"run a 24×12 duct from the AHU northeast 40 feet, then branch left 20 feet" and
MechDraw generates the corresponding Path/Group objects with HVAC markupType metadata.

This spec covers the architecture, integration points, deferred decisions, and security
constraints. It does not commit to a timeline. Implementation requires:

1. A working Ollama instance with a vision-capable model (e.g. llava:7b or mistrall3:8b)
2. A structured output schema stable enough to parse reliably
3. At least one completed review of the PortolanCAST coordinate system

---

## Problem Statement

HVAC and mechanical engineers frequently sketch duct layouts on existing architectural
drawings. Current PortolanCAST tools require hand-drawing each duct segment individually.
MechDraw would let a user describe a duct run in plain language, optionally anchored to
visible features in the drawing, and have the tool generate parametric Fabric.js objects.

**Target user story:**
> "I want to say 'run a 24×12 rectangular duct from grid intersection A-3 northeast
> 30 feet, then turn east 15 feet to the diffuser at A-5' and have it appear on the canvas
> without me measuring and clicking."

---

## Input Modes

### Mode 1: Text Prompt (required for v1)

The user types a natural-language description in the plugin panel's text input.
MechDraw parses the prompt using an Ollama LLM with a structured output prompt
that extracts:

```json
{
  "segments": [
    {
      "type": "duct_rect",
      "width_in": 24,
      "height_in": 12,
      "start": {"x": 0, "y": 0},
      "end": {"x": 500, "y": 0},
      "label": "Supply Duct — 24×12"
    }
  ],
  "anchors": []
}
```

Coordinates are in **canvas pixel space** (BASE_DPI=150, same as all other tools).
The plugin must convert real-world dimensions to pixels using the document's
`ScaleManager` (via `app.scale`).

### Mode 2: Prompt + Floor Plan Image (deferred — v2+)

The user provides both a text prompt AND an image crop from the current PDF view.
Ollama's vision endpoint (`/api/generate` with `images: [base64]`) receives the crop
so the model can spatially anchor the duct run to visible features (grid lines, walls,
equipment labels).

**Deferred reason:** Vision model output is less deterministic. Requires a calibration
strategy and more robust error handling before production use.

---

## Output: Fabric.js Objects

MechDraw injects PortolanCAST-compatible Fabric.js objects directly onto the active
canvas page. Each duct segment becomes one or more Fabric objects:

### Rectangular Duct → `fabric.Rect`

```javascript
new fabric.Rect({
    left: segment.start.x,
    top:  segment.start.y,
    width:  pixelLength,
    height: pixelWidth,
    fill: 'transparent',
    stroke: '#1565C0',
    strokeWidth: 2,
    angle: angleDegrees,
    // PortolanCAST required metadata
    markupType:   'change',    // HVAC additions = change intent by default
    markupStatus: 'open',
    markupNote:   segment.label,
    markupAuthor: 'MechDraw',
    markupTimestamp: new Date().toISOString(),
})
```

### Duct Run with Label → `fabric.Group`

Complex runs (bends, branches) are grouped with a companion IText label showing
duct size (e.g., "24×12"). The group's `markupType` follows PortolanCAST conventions.

### Object Injection

Objects are injected using `canvas.stampDefaults(obj)` (applied after construction,
per PortolanCAST convention) followed by `canvas.fabricCanvas.add(obj)`. The plugin
must call `canvas.onContentChange()` after injection to trigger auto-save.

---

## Integration: PluginLoader API

MechDraw registers via the existing PluginLoader (Phase 4B):

```javascript
// In static/js/plugins/mechdraw.js
const MechDraw = {
    name: 'mechdraw',
    tabLabel: 'MechDraw',

    onReady(app) {
        this._app = app;
        this._renderPanel();
    },

    onDocumentLoaded(docId) {
        this._currentDocId = docId;
    },

    // Called by toolbar.js when user presses Generate
    async generate(prompt) {
        const scale = this._app.scale;
        const resp  = await fetch('/api/mechdraw/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, doc_id: this._currentDocId }),
        });
        const { segments } = await resp.json();
        for (const seg of segments) {
            this._placeSegment(seg, scale);
        }
        this._app.canvas.onContentChange();
    },

    _placeSegment(seg, scale) { /* ... */ },
    _renderPanel() { /* inject panel HTML */ },
};

// Register on load
if (window.plugins) {
    window.plugins.register(MechDraw);
}
```

**Lifecycle hooks used:**
- `onReady` — panel render, store `app` reference
- `onDocumentLoaded` — reset prompt, update doc_id

**Lifecycle hooks NOT used (yet):**
- `onPageChanged` — not needed; segments target the active page
- `onMarkupSelected` — not applicable

---

## Backend: `/api/mechdraw/generate`

New FastAPI endpoint in `main.py`:

```python
@app.post("/api/mechdraw/generate")
async def mechdraw_generate(doc_id: int, request: Request):
    """
    Convert a natural-language duct layout prompt to Fabric.js segment descriptors.

    Calls Ollama with a structured output prompt. Returns an array of segment
    objects that the frontend converts to Fabric canvas objects.

    Security:
        - doc_id validated against DB (document must exist)
        - prompt is passed to Ollama only (never eval'd or executed)
        - Response is JSON-parsed; malformed output returns empty segments
    """
    body = await request.json()
    prompt = str(body.get("prompt", ""))[:1000]   # SECURITY: cap length
    ...
```

**Ollama call pattern:**

```python
system_prompt = """
You are a mechanical engineering assistant. Convert duct layout descriptions
to JSON segment arrays. Output ONLY valid JSON — no prose, no markdown.

Schema for each segment:
{
  "type": "duct_rect",       // always "duct_rect" for now
  "width_in": <number>,      // duct width in inches
  "height_in": <number>,     // duct height in inches
  "start_real": {"x": <ft>, "y": <ft>},   // start in real-world feet
  "end_real":   {"x": <ft>, "y": <ft>},   // end in real-world feet
  "label": "<string>"
}
"""
```

Coordinate conversion (real feet → canvas pixels):

```python
def feet_to_pixels(feet: float, paper_inches_per_unit: float, render_dpi: float = 150.0) -> float:
    # paper_inches_per_unit: from document scale setting
    # RENDER_DPI: the rendering constant (always 150 in PortolanCAST)
    return feet * render_dpi * paper_inches_per_unit
```

---

## Coordinate Strategy

All generated objects must respect the PortolanCAST coordinate system:

| Concept | Value |
|---------|-------|
| Render DPI | 150 px/inch |
| Scale setting | `paper_inches_per_unit` from DB |
| Canvas origin | top-left (0,0) |
| Zoom | applied via `Fabric.setZoom(scale)` — objects are in natural coords |

The plugin should read scale from `app.scale.getScale()` (returns `{pixels_per_unit}`),
then multiply real-world distances by `pixels_per_unit` to get canvas pixel values.

**Example:** At 1/4" = 1ft scale, `paper_inches_per_unit = 0.25`.
`pixels_per_unit = 150 × 0.25 = 37.5 px/ft`
A 40ft duct → `40 × 37.5 = 1500 px`

---

## Security Constraints

Per PortolanCAST's cybernetic security framework:

1. **Prompt length limit:** cap at 1000 chars server-side (prevent oversized Ollama calls)
2. **Output validation:** JSON-parse the LLM response; catch exceptions; return `{segments: []}`
   on any parse failure rather than propagating the error
3. **Coordinate bounds:** clamp generated coordinates to `[0, page_width_px × 2]` —
   discard segments outside reasonable canvas bounds
4. **No code execution:** LLM output is never eval'd. Only the JSON segment schema
   is consumed; all other fields are ignored.
5. **SECURITY comment on Ollama call:**
   ```python
   # SECURITY: prompt goes to local Ollama only (127.0.0.1:11434)
   # Never send user prompts to external APIs without explicit consent
   ```

---

## Panel UI (Conceptual)

```
┌─────────────────────────────────────────────┐
│  MechDraw AI                                │
├─────────────────────────────────────────────┤
│  Describe the duct layout:                  │
│  ┌─────────────────────────────────────┐   │
│  │ 24x12 supply duct from AHU north 40 │   │
│  │ ft, branch east 20 ft to grille     │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  Start position:  [ x: 0  y: 0  ] (canvas) │
│                                             │
│  [ Generate ]  [ Clear ]                   │
│                                             │
│  ⚠ Uses local Ollama (llava:7b or similar) │
└─────────────────────────────────────────────┘
```

---

## Open Questions (Deferred)

1. **Model selection:** Which Ollama model produces the most reliable structured JSON?
   Candidates: `mistral:7b`, `llama3:8b`, `llava:7b` (vision). Needs benchmarking.

2. **Anchor detection:** How does the user specify "start at grid A-3"? Options:
   a. Click-to-anchor before typing (user clicks canvas, plugin captures coordinates)
   b. OCR grid labels from the PDF page image and resolve semantically
   c. Require explicit pixel coordinates in the prompt (least magical)

3. **Undo integration:** Should MechDraw-generated objects participate in
   PortolanCAST's canvas undo/redo stack? They are Fabric objects so they can,
   but the history entry should group all segments from one generation as one undo step.

4. **Multi-floor plans:** When the document has multiple pages, MechDraw should
   scope generation to the current page only. Cross-page duct runs are out of scope.

5. **Fitting/equipment symbols:** How to represent AHUs, diffusers, VAV boxes?
   Could use SVG Paths stored as templates, or plain Rect with IText labels.

---

## Integration Checklist (Before Implementation)

- [ ] Confirm Ollama model produces stable JSON output for 10+ test prompts
- [ ] Add `/api/mechdraw/generate` route to PIPELINE.md as Phase X
- [ ] Design start-anchor UI (click-to-set origin point)
- [ ] Write unit tests for `feet_to_pixels()` conversion
- [ ] Write browser tests: prompt → segments → canvas objects count
- [ ] Add `mechdraw` to `plugins.js` HOOK_MAP if new hooks needed
- [ ] Performance test: measure Ollama round-trip latency at 7B/13B model sizes

---

## References

- PortolanCAST Plugin Loader API: `static/js/plugins.js`
- PortolanCAST EC Plugin (reference implementation): `static/js/plugins/extended-cognition.js`
- PortolanCAST ScaleManager: `static/js/scale.js`
- Canvas coordinate strategy: `static/js/canvas.js` (BASE_DPI constant)
- Ollama API docs: `http://127.0.0.1:11434/api/generate` (local)
- HVAC duct sizing reference: SMACNA HVAC Duct Construction Standards
- Portolan charts (name origin): Medieval maritime navigation charts (1200s–1600s),
  the first technically precise maps — an apt metaphor for PortolanCAST's purpose.
