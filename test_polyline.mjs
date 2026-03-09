/**
 * PortolanCAST — Polyline Tool Tests
 *
 * Verifies the polyline markup tool:
 *   1. Button exists in markup toolbar tab.
 *   2. Tool activates on button click.
 *   3. W keyboard shortcut activates the tool.
 *   4. _TOOL_TAB maps polyline → 'markup'.
 *   5. mouse:down / move / dblclick handlers are registered.
 *   6. Clicking the canvas accumulates vertices; temp preview objects appear.
 *   7. Double-click finalises the polyline as a permanent Fabric object.
 *   8. Finished polyline has correct type, markupType, markupId, fill, stroke.
 *   9. Tool reverts to select after finishing.
 *  10. Min 2 unique points required — 1-point dblclick creates no object.
 *  11. Escape during construction cancels without leaving orphan objects.
 *  12. Polyline persists across save / reload (round-trip).
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_polyline.mjs"
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
// COORDINATE HELPERS
// =============================================================================

/**
 * Return the position and zoom scale of the Fabric canvas element so we can
 * convert natural canvas coords (matching Fabric's getPointer output) into
 * page/screen coords that Playwright's page.mouse API requires.
 */
async function getCanvasInfo(page) {
    return page.evaluate(() => {
        const el = document.getElementById('fabric-canvas');
        const rect = el.getBoundingClientRect();
        return {
            x: rect.left,
            y: rect.top,
            scale: window.app.viewer.zoom / 100,
        };
    });
}

/**
 * Convert a point in natural Fabric canvas coordinates (the coord space used
 * by getPointer / the markup tool internals) to page-level screen coordinates.
 */
async function toPageCoords(page, naturalX, naturalY) {
    const info = await getCanvasInfo(page);
    return {
        x: info.x + naturalX * info.scale,
        y: info.y + naturalY * info.scale,
    };
}

// =============================================================================
// SETUP HELPERS
// =============================================================================

/** Click the Markup tab so polyline button is in the DOM and visible. */
async function openMarkupTab(page) {
    await page.click('.toolbar-tab[data-tab="markup"]');
    await page.waitForTimeout(100);
}

/**
 * Activate the polyline tool via its toolbar button.
 * Always presses V first to avoid the toggle-off behavior in setTool():
 * if polyline is already the active tool, clicking the button would
 * deactivate it rather than re-initialise it.
 */
/**
 * Activate the polyline tool via its toolbar button.
 * Presses V first to avoid the toggle-off behavior in setTool() — if polyline
 * is already active, clicking the button deactivates it. V also switches to
 * the navigate tab, so we re-open the markup tab afterwards.
 */
async function activatePolyline(page) {
    await page.keyboard.press('v');   // switch away (prevents toggle-off); moves to navigate tab
    await page.waitForTimeout(50);
    await openMarkupTab(page);        // re-open markup tab so polyline button is visible
    await page.click('.tool-btn[data-tool="polyline"]');
    await page.waitForTimeout(100);
}

// =============================================================================
// MAIN TEST RUNNER
// =============================================================================

async function run() {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page    = await context.newPage();

    try {
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear any markups left by previous test runs
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

        // ── Group 1: Toolbar presence ─────────────────────────────────────────
        console.log('\n  -- Group 1: Toolbar Button --');

        await openMarkupTab(page);

        const btnExists = await page.$('button[data-tool="polyline"]');
        assert(btnExists !== null, 'Polyline button exists in markup toolbar');

        const btnTitle = await page.evaluate(() =>
            document.querySelector('.tool-btn[data-tool="polyline"]')?.title || ''
        );
        assert(btnTitle.toLowerCase().includes('polyline'),
            `Button title mentions "Polyline" (got "${btnTitle}")`);

        const hasIcon = await page.evaluate(() =>
            !!document.querySelector('.tool-btn[data-tool="polyline"] .icon')
        );
        assert(hasIcon, 'Polyline button has .icon span');

        // ── Group 2: _TOOL_TAB mapping ────────────────────────────────────────
        console.log('\n  -- Group 2: _TOOL_TAB mapping --');

        const toolTab = await page.evaluate(() =>
            window.app?.toolbar?._TOOL_TAB?.polyline
        );
        assert(toolTab === 'markup',
            `_TOOL_TAB["polyline"] === "markup" (got "${toolTab}")`);

        // ── Group 3: Tool activation ──────────────────────────────────────────
        console.log('\n  -- Group 3: Tool Activation --');

        await activatePolyline(page);

        const activeTool = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(activeTool === 'polyline',
            `activeTool === "polyline" after button click (got "${activeTool}")`);

        // Polyline uses mouse event handlers, not Fabric's drawing brush mode
        const noDrawingMode = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.isDrawingMode === false
        );
        assert(noDrawingMode, 'isDrawingMode is false (polyline uses event handlers)');

        const noSelection = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.selection === false
        );
        assert(noSelection, 'canvas.selection is false while polyline is active');

        // Button should be highlighted active
        const btnActive = await page.$eval(
            'button[data-tool="polyline"]',
            el => el.classList.contains('active')
        );
        assert(btnActive, 'Polyline button has .active class while tool is selected');

        // ── Group 4: Keyboard shortcut W ─────────────────────────────────────
        console.log('\n  -- Group 4: Keyboard Shortcut (W) --');

        // Switch away first
        await page.keyboard.press('v');
        await page.waitForTimeout(100);
        const beforeKey = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(beforeKey === 'select', 'Switched to select before testing W');

        await page.keyboard.press('w');
        await page.waitForTimeout(100);
        const afterKey = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(afterKey === 'polyline',
            `activeTool === "polyline" after W key (got "${afterKey}")`);

        // ── Group 5: Handler registration ────────────────────────────────────
        console.log('\n  -- Group 5: Handler Registration --');

        const handlers = await page.evaluate(() => {
            const h = window.app?.toolbar?._shapeHandlers;
            return h ? Object.keys(h) : [];
        });
        assert(handlers.includes('mouse:down'),     'mouse:down handler registered');
        assert(handlers.includes('mouse:move'),     'mouse:move handler registered');
        assert(handlers.includes('mouse:dblclick'), 'mouse:dblclick handler registered');

        // ── Group 6: Drawing — vertices accumulate, preview appears ───────────
        console.log('\n  -- Group 6: Drawing Interaction --');

        await activatePolyline(page);

        const countBefore = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );

        // Click 3 points in natural canvas coords
        const p1 = await toPageCoords(page, 100, 100);
        const p2 = await toPageCoords(page, 200, 150);
        const p3 = await toPageCoords(page, 300, 100);
        const pEnd = await toPageCoords(page, 350, 100);

        await page.mouse.click(p1.x, p1.y);
        await page.waitForTimeout(120);
        await page.mouse.click(p2.x, p2.y);
        await page.waitForTimeout(120);
        await page.mouse.click(p3.x, p3.y);
        await page.waitForTimeout(120);

        // During construction, temp objects (rubberBand + previewPolyline) are on canvas
        const countDuring = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );
        assert(countDuring > countBefore,
            `Temp objects appear during construction (${countBefore}→${countDuring})`);

        // Double-click to finalise
        await page.mouse.dblclick(pEnd.x, pEnd.y);
        await page.waitForTimeout(400);

        // After finalisation: exactly one new permanent object (temp objects removed)
        const countAfter = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );
        assert(countAfter === countBefore + 1,
            `One permanent polyline added (expected ${countBefore + 1}, got ${countAfter})`);

        // ── Group 7: Finished polyline properties ─────────────────────────────
        console.log('\n  -- Group 7: Polyline Object Properties --');

        const polyObj = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            for (let i = objs.length - 1; i >= 0; i--) {
                if (objs[i].type === 'polyline') {
                    return {
                        type:       objs[i].type,
                        markupType: objs[i].markupType,
                        markupId:   objs[i].markupId,
                        fill:       objs[i].fill,
                        stroke:     objs[i].stroke,
                        points:     objs[i].points?.length,
                    };
                }
            }
            return null;
        });

        assert(polyObj !== null,                    'A polyline object exists on canvas');
        assert(polyObj?.type === 'polyline',         `type is "polyline" (got "${polyObj?.type}")`);
        assert(!!polyObj?.markupType,               `markupType is set (got "${polyObj?.markupType}")`);
        assert(!!polyObj?.markupId,                  'markupId UUID stamped on polyline');
        assert(polyObj?.fill === 'transparent',      'fill is transparent (open path)');
        assert(!!polyObj?.stroke,                    `stroke color set (got "${polyObj?.stroke}")`);
        assert((polyObj?.points ?? 0) >= 2,
            `At least 2 points in polyline (got ${polyObj?.points})`);

        // Tool should revert to select automatically
        const toolAfterFinish = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(toolAfterFinish === 'select',
            `Tool reverts to select after finishing (got "${toolAfterFinish}")`);

        // ── Group 8: Lone double-click creates no object ──────────────────────
        // Fabric fires mouse:down TWICE for a dblclick (once per physical click).
        // A lone dblclick with no prior single clicks = 2 mouse:downs → pop() → 1 vertex.
        // 1 vertex < 2 minimum → should abort without creating any object.
        //
        // Note: 1 prior single click + dblclick = 3 mouse:downs → pop → 2 vertices =
        // a valid single-segment polyline (this is correct and intentional behaviour).
        console.log('\n  -- Group 8: Lone Double-click Creates No Object --');

        await activatePolyline(page);
        const countBeforeAbort = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );

        // Double-click alone (no prior single clicks) — after two mouse:downs + pop = 1 vertex → abort
        const singlePt = await toPageCoords(page, 150, 250);
        await page.mouse.dblclick(singlePt.x, singlePt.y);
        await page.waitForTimeout(300);

        const countAfterAbort = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );
        assert(countAfterAbort === countBeforeAbort,
            `Lone double-click creates no object (${countBeforeAbort}→${countAfterAbort})`);

        // ── Group 9: Escape cancels in-progress construction ─────────────────
        console.log('\n  -- Group 9: Escape Cancels Construction --');

        await activatePolyline(page);
        const countBeforeEsc = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );

        // Start drawing 2 points
        const esc1 = await toPageCoords(page, 50, 350);
        const esc2 = await toPageCoords(page, 150, 400);
        await page.mouse.click(esc1.x, esc1.y);
        await page.waitForTimeout(120);
        await page.mouse.click(esc2.x, esc2.y);
        await page.waitForTimeout(120);

        const countDuringEsc = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );
        assert(countDuringEsc > countBeforeEsc,
            `Temp objects present before Escape (${countBeforeEsc}→${countDuringEsc})`);

        // Escape should cancel
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        const countAfterEsc = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );
        assert(countAfterEsc === countBeforeEsc,
            `Escape removes temp objects (expected ${countBeforeEsc}, got ${countAfterEsc})`);

        const toolAfterEsc = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(toolAfterEsc === null || toolAfterEsc === 'select',
            `Tool deactivated after Escape (got "${toolAfterEsc}")`);

        // ── Group 10: Save / reload round-trip ───────────────────────────────
        console.log('\n  -- Group 10: Save / Reload Round-trip --');

        // Draw a fresh polyline
        await activatePolyline(page);
        const rt1 = await toPageCoords(page, 80,  300);
        const rt2 = await toPageCoords(page, 180, 350);
        const rt3 = await toPageCoords(page, 280, 300);
        const rtEnd = await toPageCoords(page, 380, 300);

        await page.mouse.click(rt1.x, rt1.y);
        await page.waitForTimeout(120);
        await page.mouse.click(rt2.x, rt2.y);
        await page.waitForTimeout(120);
        await page.mouse.click(rt3.x, rt3.y);
        await page.waitForTimeout(120);
        await page.mouse.dblclick(rtEnd.x, rtEnd.y);
        await page.waitForTimeout(400);

        // Save current canvas state to server
        await page.evaluate(async () => {
            const fc  = window.app.canvas.fabricCanvas;
            const json = fc.toJSON();
            await fetch(`/api/documents/${window.app.docId}/markups`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ page: 0, markups: json }),
            });
        });
        await page.waitForTimeout(300);

        // Reload and verify polyline is still there
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        const polyAfterReload = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            return objs.some(o => o.type === 'polyline');
        });
        assert(polyAfterReload, 'Polyline persists after page reload');

        const mtAfterReload = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const poly = objs.find(o => o.type === 'polyline');
            return poly?.markupType || null;
        });
        assert(!!mtAfterReload,
            `markupType preserved after reload (got "${mtAfterReload}")`);

    } finally {
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
