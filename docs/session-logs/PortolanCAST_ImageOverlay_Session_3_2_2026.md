# PortolanCAST — Image Overlay Tool Session Log
*Date: 2026-03-02 (Session 1 of the day)*
*Status at close: 22/22 image overlay tests passing. Pre-existing test failures investigated; health monitor crash fix pending.*

---

## What Was Built

### Image Overlay Tool (`image-overlay`)

A new markup tool that uploads a photo to the server and places it as a `fabric.Image` on the Fabric.js canvas with full PortolanCAST markup metadata. Image overlays are **full markups** — they appear in the markup list, properties panel (note + tags + status + entity section + photos thumbnail), Review Brief, RFI generator, and nodeCAST graph.

**Core pipeline:**
```
Toolbar "Image" button / keyboard I
        → setTool('image-overlay')
        → input.click()  [ignored in headless]
        → page.setInputFiles() triggers 'change' event
        → _bindImageOverlay() handler:
            1. setTool('select')  [one-shot — reverts immediately]
            2. input.value = ''  [reset for re-selection]
            3. markupId = crypto.randomUUID()  [pre-generated]
            4. POST /api/documents/{docId}/markup-photos  [existing endpoint]
            5. fabric.Image.fromURL(url)  [async, same-origin]
            6. scale to max 60% canvas, center at viewport
            7. img.markupId = markupId  [set BEFORE stampDefaults]
            8. stampDefaults(img, { markupType: 'image-overlay', preserveColor: true })
            9. img.set({ stroke: null, strokeWidth: 0 })
           10. fc.add(img)  → object:added → layer auto-assigned
           11. fc.setActiveObject(img)
           12. onContentChange()  [auto-save]
```

**Why pre-generate the markupId?** The photo DB record and the canvas Fabric object must share the same UUID from creation. `stampDefaults()` is fill-missing (idempotent), so setting `img.markupId` before calling it ensures the UUID never gets overwritten.

**Serialization:** Fabric.js 6's `fabric.Image` serializes `src` natively. Custom properties (`markupType`, `markupId`, `layerId`) survive round-trip via the `toObject` prototype patch in canvas.js (CUSTOM_PROPERTIES list). `loadFromJSON` reconstructs `fabric.Image` from `{ type: "image", src: "..." }` without a reviver function.

---

## Files Modified

| File | Change |
|------|--------|
| `static/js/canvas.js` | +1 line: `'image-overlay': 'transparent'` in MARKUP_COLORS |
| `templates/editor.html` | +Image button in markup toolbar, +`#image-overlay-input` hidden file input |
| `static/js/toolbar.js` | +`_TOOL_TAB` entry, +`i` keyboard shortcut, +`setTool` case, +`_bindImageOverlay()` method (~90 lines), +constructor call |
| `static/css/style.css` | +`.markup-type-badge.type-image-overlay` color rule |
| `static/js/markup-list.js` | +`'image-overlay': 'Image'` in TYPE_LABELS |
| `static/js/properties.js` | +`'image': 'Image', 'Image': 'Image'` in TYPE_LABELS |
| `run_tests.mjs` | +`'test_image_overlay.mjs'` in TEST_FILES |

**New file:** `test_image_overlay.mjs` — 22 tests across 5 groups (22/22 passing)

| Group | Tests | Coverage |
|-------|-------|---------|
| 1 — Toolbar Presence | 3 | Button exists, title mentions "image", has .icon span |
| 2 — Tool Activation + Shortcut | 4 | _TOOL_TAB maps to 'markup', file input exists, I key, .active class |
| 3 — Upload + Placement | 7 | Image placed, count+1, markupType, markupId, markupStatus, isSelected, stroke null, photo record in API |
| 4 — Canvas Behavior + Markup List | 3 | layerId set, tool reverted to 'select', "Image" badge in markup list |
| 5 — Persistence + Cleanup | 4 | Survives hard reload, markupType/markupId/layerId survive, URL HTTP 200, delete cleans canvas |

---

## Debugging Lessons — Critical

### 1. `docId` lives on `this.viewer`, not `this.canvas`

```js
// WRONG — canvas.docId is undefined
const docId = this.canvas?.docId;

// CORRECT — docId is on the PDFViewer instance
const docId = this.viewer?.docId;
```

The toolbar class has `this.viewer` (PDFViewer) and `this.canvas` (CanvasManager). The document ID comes from the viewer. Canvas is focused on rendering — it doesn't know the document ID.

### 2. `crossOrigin: 'anonymous'` breaks same-origin `fabric.Image.fromURL`

```js
// BROKEN — even though the URL is same-origin
const img = await fabric.Image.fromURL(url, { crossOrigin: 'anonymous' });
// fabric: Error loading /data/photos/abc123.jpg

// CORRECT — no option needed for same-origin StaticFiles
const img = await fabric.Image.fromURL(url);
```

FastAPI's `StaticFiles` does not set `Access-Control-Allow-Origin` headers. When `crossOrigin: 'anonymous'` is specified, the browser's CORS preflight fails — even for same-origin requests, because specifying the attribute triggers the CORS machinery. The fix is to omit `crossOrigin` entirely for same-origin static files.

**Mental model:** `crossOrigin: 'anonymous'` is only needed when the image is served from a different origin that supports CORS (e.g., a CDN with `Access-Control-Allow-Origin: *`).

### 3. Minimal JPEG fails Chrome's strict image decoder

The `TINY_JPEG_BASE64` constant in `test_photos.mjs` is a structurally valid but *malformed* 1×1 JPEG used for file storage tests. Chrome's image decoder is stricter than storage validation — it rejects the JPEG silently, leaving `fabric.Image.fromURL` with a broken image element.

```js
// WRONG — malformed minimal JPEG (passes storage, fails rendering)
const TINY_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/...';

// CORRECT — valid 1×1 PNG, renderable by all browsers
const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
    'AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
```

**Lesson:** For canvas rendering tests, always use a browser-renderable image. PNG is more forgiving than JPEG for minimal test files. Use the file with `.png` extension and `image/png` MIME type so server validation passes.

### 4. Test output format must match `run_tests.mjs` parser regex

`run_tests.mjs` parses each suite's output with: `/Results:\s*(\d+)\s*passed,\s*(\d+)\s*failed/`

Any other format (like `"22/22 passed"`) is silently ignored — the suite gets counted as 0/0 with a "no parseable results" note, but the exit code still propagates.

**Standard format (use this in all test suites):**
```js
console.log(`  Results: ${passed} passed, ${failed} failed, ${total} total`);
```

### 5. Server must restart to pick up Python changes

PortolanCAST runs without `--reload`. Python code changes (db.py, main.py, etc.) require:
```bash
kill $(pgrep -f uvicorn)
venv/bin/python3 -m uvicorn main:app --host 127.0.0.1 --port 8000 &
```

The Stage3A log ordering fix (`ORDER BY created_at DESC, id DESC` in `db.py`) was already in code from the previous session but required a server restart to take effect. After restart: 42/42 Stage3A tests passing.

---

## Pre-existing Test Failures Investigated

| Suite | Failures | Root Cause | Resolution |
|-------|---------|-----------|-----------|
| `test_stage3a.mjs` | 2 log ordering tests | `ORDER BY created_at DESC` missing `id DESC` tiebreaker; fix in db.py but server was running stale code | Kill server → restart → 42/42 ✓ |
| `test_health_monitor.mjs` | 3 → 0 (but process crash) | After restart: 18/18 tests pass. Crash caused by `waitForFunction` at line 246 (90s timeout for "Results:" in streaming dev runner output) throwing `TimeoutError` → propagates to `run().catch()` → `process.exit(1)` | Fix: wrap `waitForFunction` in try/catch |

**Health monitor crash anatomy:**
- Tests 3.4 and 3.5 check that the streaming endpoint starts and produces output → PASS (server is running, output starts quickly)
- Test 3.6 waits 90s for `"Results:"` to appear in `#health-test-output` → the dev runner spawns `node run_tests.mjs` (the full 36-suite, 1000+ test suite) which takes longer than 90s
- `waitForFunction` throws `TimeoutError` uncaught inside `try { }` block
- `finally` runs, prints results, exits
- Error re-propagates to `run().catch()` which calls `process.exit(1)` — overriding the clean exit

**Fix:** Wrap the `waitForFunction` call in a local try/catch so the `TimeoutError` is caught, converted to `hasResults = false`, and asserted normally. The error never reaches `.catch()`.

---

## Key Design Principles Applied

- **Pre-generated UUID links canvas object to photo record**: No second round-trip needed to associate them — they share the UUID from creation.
- **`stampDefaults()` is fill-missing**: Always set domain-specific properties (`markupId`, `markupType`) BEFORE calling `stampDefaults()` — it won't overwrite them.
- **One-shot tool behavior**: `setTool('select')` called immediately in the file change handler so the tool returns to select mode regardless of whether upload succeeds or fails. No "stuck in image tool" states.
- **`preserveColor: true` in `stampDefaults()`**: Prevents the stroke color from being overridden by the MARKUP_COLORS map (images don't need a stroke border). Then explicitly set `{ stroke: null, strokeWidth: 0 }` to clear any defaults.
- **No new API routes or DB schema**: The existing `POST /api/documents/{doc_id}/markup-photos` endpoint handles upload. StaticFiles serves the images. The `object:added` handler auto-assigns the layer. Zero backend changes needed.

---

*Related notes:*
- Previous session: `PortolanCAST_Stage3A_Session_3_1_2026.md`
- Next: Stage 3B (entity-manager.js + entity-modal.js) after health monitor fix
- Pipeline: `~/.claude/PIPELINES/Engineering_OpenRevu/PIPELINE.md`
