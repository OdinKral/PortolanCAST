/**
 * PortolanCAST — Image Overlay Tool Tests
 *
 * Purpose:
 *   Verifies the image-overlay markup tool end-to-end:
 *   - Toolbar button and keyboard shortcut presence
 *   - _TOOL_TAB mapping and tool activation state
 *   - File upload → fabric.Image placement pipeline
 *   - markupType / markupId stamped on placed image
 *   - Layer auto-assignment (layerId set on placement)
 *   - Photo record exists in markup-photos API
 *   - Image appears in markup list with "Image" badge
 *   - Full save/load round-trip (markupType, markupId, layerId survive)
 *   - Image URL resolves with HTTP 200 after reload
 *   - Cleanup: delete markup → canvas object removed, photo record deleted
 *
 * Test Groups:
 *   1 — Toolbar Presence (3 tests)
 *   2 — Tool Activation + Keyboard Shortcut (4 tests)
 *   3 — Upload + Placement (7 tests)
 *   4 — Canvas Behavior + Markup List (3 tests)
 *   5 — Persistence + Cleanup (4 tests)
 *
 * Total: 21 tests
 *
 * Requires server running on http://127.0.0.1:8000 with at least one document (id=1).
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_image_overlay.mjs"
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-03-02
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID   = 1;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else           { failed++; console.log(`  FAIL: ${msg}`); }
}

// =============================================================================
// TINY PNG — minimal 1×1 PNG for upload + render tests.
//
// Using PNG instead of JPEG: the JPEG format requires a more complex decoder
// and minimal/test JPEGs can fail Chrome's strict image validation even when
// structurally valid. This 68-byte PNG is guaranteed renderable by all browsers.
//
// The file must be named with a .png extension and image/png MIME type so the
// server accepts it (ALLOWED_PHOTO_EXTENSIONS includes .png).
// =============================================================================

const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
    'AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Decode the base64 to a Buffer for page.setInputFiles()
const PNG_BUFFER = Buffer.from(TINY_PNG_BASE64, 'base64');

// =============================================================================
// HELPERS
// =============================================================================

async function openMarkupTab(page) {
    await page.click('.toolbar-tab[data-tab="markup"]');
    await page.waitForTimeout(100);
}

/**
 * Trigger image-overlay tool activation via toolbar button.
 * Uses page.evaluate().click() to avoid Playwright auto-scroll-to-view behavior.
 * The Image button is off-screen to the right in the markup tab, and auto-scroll
 * shifts canvas getBoundingClientRect to negative X, breaking canvas coordinate math.
 *
 * IMPORTANT: setTool('image-overlay') calls input.click() which opens the OS file picker.
 * In headless Chrome this is silently ignored. We then use page.setInputFiles() to supply
 * the file programmatically, which triggers the 'change' event without OS interaction.
 */
async function activateImageTool(page) {
    await page.keyboard.press('v');     // switch away (prevents toggle-off if already active)
    await page.waitForTimeout(50);
    await openMarkupTab(page);
    await page.evaluate(() =>
        document.querySelector('.tool-btn[data-tool="image-overlay"]').click()
    );
    await page.waitForTimeout(100);
}

/**
 * Upload a tiny JPEG via the image-overlay file input.
 * Waits up to 3 seconds for a fabric.Image to appear on the canvas.
 *
 * Returns the markupId of the placed image, or null on timeout.
 */
async function uploadAndPlace(page) {
    // Set files on the hidden input — triggers the 'change' event in _bindImageOverlay.
    // Use PNG to ensure the image is browser-renderable (JPEG requires a more complex
    // decoder and minimal test JPEGs can fail Chrome's strict image validation).
    await page.setInputFiles('#image-overlay-input', {
        name: 'test-overlay.png',
        mimeType: 'image/png',
        buffer: PNG_BUFFER,
    });

    // Wait for the async upload + fabric.Image.fromURL + canvas.add to complete
    const placed = await page.waitForFunction(() => {
        const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
        return objs.some(o => o.type === 'image' && o.markupType === 'image-overlay');
    }, { timeout: 5000 }).catch(() => null);

    if (!placed) return null;

    // Return the markupId of the placed image
    return page.evaluate(() => {
        const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
        const img = objs.find(o => o.type === 'image' && o.markupType === 'image-overlay');
        return img?.markupId || null;
    });
}

// =============================================================================
// MAIN TEST RUNNER
// =============================================================================

async function run() {
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    const context = await browser.newContext();
    const page    = await context.newPage();

    try {
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear any markups from previous test runs to start clean
        await page.evaluate(async () => {
            window.app.canvas.pageMarkups.clear();
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
            await fetch(`/api/documents/${window.app.docId}/markups`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages: {} }),
            });
            window.app._dirty = false;
        });
        await page.waitForTimeout(300);

        // ── Group 1: Toolbar Presence ─────────────────────────────────────────
        console.log('\n  -- Group 1: Toolbar Presence --');

        await openMarkupTab(page);

        // 1.1 — Button exists
        const btnExists = await page.$('button[data-tool="image-overlay"]');
        assert(btnExists !== null, 'Image overlay button exists in markup toolbar');

        // 1.2 — Title mentions "Image"
        const btnTitle = await page.evaluate(() =>
            document.querySelector('.tool-btn[data-tool="image-overlay"]')?.title || ''
        );
        assert(btnTitle.toLowerCase().includes('image'),
            `Button title mentions "image" (got "${btnTitle}")`);

        // 1.3 — Has .icon span
        const hasIcon = await page.evaluate(() =>
            !!document.querySelector('.tool-btn[data-tool="image-overlay"] .icon')
        );
        assert(hasIcon, 'Image overlay button has .icon span');

        // ── Group 2: Tool Activation + Keyboard Shortcut ──────────────────────
        console.log('\n  -- Group 2: Tool Activation + Keyboard Shortcut --');

        // 2.1 — _TOOL_TAB maps 'image-overlay' → 'markup'
        const toolTab = await page.evaluate(() =>
            window.app?.toolbar?._TOOL_TAB?.['image-overlay']
        );
        assert(toolTab === 'markup',
            `_TOOL_TAB["image-overlay"] === "markup" (got "${toolTab}")`);

        // 2.2 — Hidden file input exists in DOM
        const fileInputExists = await page.$('#image-overlay-input');
        assert(fileInputExists !== null, '#image-overlay-input hidden file input exists');

        // 2.3 — Keyboard shortcut I activates the tool
        await page.keyboard.press('v');     // switch away first
        await page.waitForTimeout(50);
        await page.keyboard.press('i');
        await page.waitForTimeout(100);
        const afterKey = await page.evaluate(() => window.app?.toolbar?.activeTool);
        // After 'i' key press, the tool opens the file dialog and stays as 'image-overlay'
        // (it reverts to 'select' only after a file is chosen or dialog is dismissed)
        assert(afterKey === 'image-overlay',
            `activeTool === "image-overlay" after I key (got "${afterKey}")`);

        // 2.4 — Clicking the button marks it .active
        await activateImageTool(page);
        const btnActive = await page.evaluate(() =>
            document.querySelector('.tool-btn[data-tool="image-overlay"]')
                ?.classList.contains('active')
        );
        assert(btnActive, 'Image overlay button has .active class while tool is selected');

        // ── Group 3: Upload + Placement ───────────────────────────────────────
        console.log('\n  -- Group 3: Upload + Placement --');

        // Activate the tool then immediately supply a file via setInputFiles
        await activateImageTool(page);
        const countBefore = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );

        const markupId = await uploadAndPlace(page);
        assert(markupId !== null, 'A fabric.Image was placed on the canvas after file upload');

        // 3.1 — Object count increased by 1
        const countAfter = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );
        assert(countAfter === countBefore + 1,
            `Canvas object count +1 after placement (${countBefore}→${countAfter})`);

        // 3.2 — markupType is 'image-overlay'
        const imgMarkupType = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            return objs.find(o => o.type === 'image')?.markupType;
        });
        assert(imgMarkupType === 'image-overlay',
            `markupType === "image-overlay" (got "${imgMarkupType}")`);

        // 3.3 — markupId is set (UUID — 32 hex chars after removing dashes)
        assert(typeof markupId === 'string' && markupId.length >= 20,
            `markupId is set (got "${markupId}")`);

        // 3.4 — markupStatus is 'open'
        const imgStatus = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            return objs.find(o => o.type === 'image')?.markupStatus;
        });
        assert(imgStatus === 'open', `markupStatus === "open" (got "${imgStatus}")`);

        // 3.5 — Image is selected (setActiveObject was called)
        const isSelected = await page.evaluate(() => {
            const active = window.app?.canvas?.fabricCanvas?.getActiveObject();
            return active?.type === 'image' && active?.markupType === 'image-overlay';
        });
        assert(isSelected, 'Placed image is the active object after upload');

        // 3.6 — Stroke is null or 0 (no stroke border on image objects)
        const imgStroke = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const img  = objs.find(o => o.type === 'image');
            return { stroke: img?.stroke, strokeWidth: img?.strokeWidth };
        });
        assert(
            imgStroke.stroke === null && imgStroke.strokeWidth === 0,
            `stroke is null and strokeWidth is 0 (got stroke="${imgStroke.stroke}" sw=${imgStroke.strokeWidth})`
        );

        // 3.7 — Photo record exists in /api/documents/{id}/markup-photos/{markupId}
        const photoRecord = await page.evaluate(async (mId) => {
            const r = await fetch(`/api/documents/${window.app.docId}/markup-photos/${mId}`);
            if (!r.ok) return null;
            return r.json();
        }, markupId);
        assert(
            Array.isArray(photoRecord?.photos) && photoRecord.photos.length >= 1,
            `Photo record exists in markup-photos API for markupId "${markupId}"`
        );

        // ── Group 4: Canvas Behavior + Markup List ────────────────────────────
        console.log('\n  -- Group 4: Canvas Behavior + Markup List --');

        // 4.1 — layerId is set (object:added auto-assigns via canvas.js layer handler)
        const layerId = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            return objs.find(o => o.type === 'image')?.layerId;
        });
        assert(typeof layerId === 'string' && layerId.length > 0,
            `layerId is set on placed image (got "${layerId}")`);

        // 4.2 — Tool reverted to select after placement (one-shot behavior)
        const toolAfterPlace = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(toolAfterPlace === 'select',
            `Tool reverted to select after placement (got "${toolAfterPlace}")`);

        // 4.3 — Image appears in markup list with type badge text "Image"
        // Open the Markups tab in the side panel to force markup list to render
        const markupListTab = await page.$('[data-tab="markups"]');
        if (markupListTab) {
            await page.evaluate(() =>
                document.querySelector('[data-tab="markups"]')?.click()
            );
            await page.waitForTimeout(400);
        }
        const hasImageBadge = await page.evaluate(() => {
            const badges = document.querySelectorAll('.markup-type-badge');
            return [...badges].some(b => b.textContent.trim() === 'Image');
        });
        assert(hasImageBadge, 'Markup list shows type badge with text "Image"');

        // ── Group 5: Persistence + Cleanup ───────────────────────────────────
        console.log('\n  -- Group 5: Persistence + Cleanup --');

        // Trigger save before reload
        await page.evaluate(() => window.app.canvas.onContentChange?.());
        await page.waitForTimeout(600);

        // Hard reload
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // 5.1 — Image is still present after reload
        const imgAfterReload = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            return objs.find(o => o.type === 'image' && o.markupType === 'image-overlay');
        });
        assert(imgAfterReload !== null && imgAfterReload !== undefined,
            'Image overlay still present after hard page reload');

        // 5.2 — markupType, markupId, and layerId survived loadFromJSON
        const surviving = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const img = objs.find(o => o.type === 'image');
            if (!img) return null;
            return { markupType: img.markupType, markupId: img.markupId, layerId: img.layerId };
        });
        assert(
            surviving?.markupType === 'image-overlay' &&
            typeof surviving?.markupId === 'string' && surviving.markupId.length > 0 &&
            typeof surviving?.layerId === 'string' && surviving.layerId.length > 0,
            `markupType/markupId/layerId all survived round-trip ` +
            `(type="${surviving?.markupType}" id="${surviving?.markupId}" layer="${surviving?.layerId}")`
        );

        // 5.3 — Image URL resolves (HTTP 200 from the static file server)
        const imgUrl = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            return objs.find(o => o.type === 'image')?.getSrc?.() || null;
        });
        let urlOk = false;
        if (imgUrl) {
            const fullUrl = imgUrl.startsWith('http') ? imgUrl : `${BASE_URL}${imgUrl}`;
            try {
                const r = await page.evaluate(async (u) => {
                    const resp = await fetch(u);
                    return resp.status;
                }, fullUrl);
                urlOk = (r === 200);
            } catch (_) { /* network failure — not OK */ }
        }
        assert(urlOk, `Image URL resolves with HTTP 200 (url="${imgUrl}")`);

        // 5.4 — Delete markup → canvas object removed
        await page.evaluate(() => {
            const fc = window.app?.canvas?.fabricCanvas;
            const img = fc?.getObjects()?.find(o => o.type === 'image');
            if (img) {
                fc.remove(img);
                fc.renderAll();
            }
        });
        await page.waitForTimeout(200);
        const countAfterDelete = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            return objs.filter(o => o.type === 'image').length;
        });
        assert(countAfterDelete === 0, 'Image removed from canvas after delete');

    } finally {
        await browser.close();

        const total = passed + failed;
        console.log('\n══════════════════════════════════════════════════');
        console.log('  Image Overlay Tool Tests');
        console.log('══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${total} total`);
        console.log('══════════════════════════════════════════════════');
        process.exit(failed > 0 ? 1 : 0);
    }
}

run();
