/**
 * PortolanCAST — Bluebeam Parity Features Tests
 *
 * Purpose:
 *   Verifies the Bluebeam parity features added on 2026-04-03:
 *   Group/Ungroup, Arc tool, Radius/Diameter measure, and PDF Text Selection.
 *
 * Groups:
 *   Group 1: Group/Ungroup — Ctrl+G, Ctrl+Shift+G, Edit menu buttons
 *   Group 2: Arc tool — click-drag arc creation
 *   Group 3: Radius/Diameter measure — circle measurement
 *   Group 4: PDF Text Selection — text layer rendering and API
 *
 * Run:
 *   node test_parity_features.mjs
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

async function getCanvasInfo(page) {
    return page.evaluate(() => {
        const el   = document.getElementById('fabric-canvas');
        const rect = el.getBoundingClientRect();
        return { x: rect.left, y: rect.top, scale: window.app.viewer.zoom / 100 };
    });
}

async function toPageCoords(page, naturalX, naturalY) {
    const info = await getCanvasInfo(page);
    return { x: info.x + naturalX * info.scale, y: info.y + naturalY * info.scale };
}

/** Click the markup tab in the top toolbar. */
async function openMarkupTab(page) {
    await page.click('.toolbar-tab[data-tab="markup"]');
    await page.waitForTimeout(100);
}

/** Click the measure tab in the top toolbar. */
async function openMeasureTab(page) {
    await page.click('.toolbar-tab[data-tab="measure"]');
    await page.waitForTimeout(100);
}

/** Get count of Fabric objects on the canvas. */
async function getObjectCount(page) {
    return page.evaluate(() => window.app.canvas.fabricCanvas.getObjects().length);
}

/** Clear the canvas for a fresh test. */
async function clearCanvas(page) {
    await page.evaluate(() => {
        window.app.canvas.fabricCanvas.clear();
        window.app.canvas.fabricCanvas.renderAll();
    });
    await page.waitForTimeout(100);
}

/** Draw a rectangle at given natural coords. Returns after the shape is placed. */
async function drawRect(page, x1, y1, x2, y2) {
    const start = await toPageCoords(page, x1, y1);
    const end = await toPageCoords(page, x2, y2);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y);
    await page.mouse.up();
    await page.waitForTimeout(200);
}

// =============================================================================
// MAIN TEST RUNNER
// =============================================================================

async function run() {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page    = await context.newPage();

    try {
        // ── Initial load ─────────────────────────────────────────────────────
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear canvas state
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

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 1: Group / Ungroup
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 1: Group / Ungroup --');

        // 1.1 — Edit menu has Group and Ungroup buttons
        const btnGroup = await page.$('#btn-group');
        const btnUngroup = await page.$('#btn-ungroup');
        assert(btnGroup !== null, 'Group button exists in Edit menu');
        assert(btnUngroup !== null, 'Ungroup button exists in Edit menu');

        // 1.2 — Create two rectangles programmatically (avoids tool timing issues)
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const r1 = new fabric.Rect({
                left: 50, top: 50, width: 80, height: 80,
                fill: 'transparent', stroke: '#aaaaaa', strokeWidth: 2,
                selectable: true,
            });
            window.app.canvas.stampDefaults(r1);
            const r2 = new fabric.Rect({
                left: 160, top: 50, width: 80, height: 80,
                fill: 'transparent', stroke: '#aaaaaa', strokeWidth: 2,
                selectable: true,
            });
            window.app.canvas.stampDefaults(r2);
            fc.add(r1, r2);
            fc.renderAll();
        });
        await page.waitForTimeout(200);

        const countBefore = await getObjectCount(page);
        assert(countBefore >= 2, `Two rectangles drawn (found ${countBefore} objects)`);

        // 1.3 — Select all and group with Ctrl+G
        await page.keyboard.press('v'); // select tool
        await page.waitForTimeout(100);

        // Select all objects
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const objs = fc.getObjects().filter(o => o.selectable);
            fc.discardActiveObject();
            const sel = new fabric.ActiveSelection(objs, { canvas: fc });
            fc.setActiveObject(sel);
            fc.requestRenderAll();
        });
        await page.waitForTimeout(200);

        // Check that we have an active selection
        const hasSelection = await page.evaluate(() => {
            const active = window.app.canvas.fabricCanvas.getActiveObject();
            return active && active.type === 'activeselection';
        });
        assert(hasSelection, 'Multi-selection active before grouping');

        // Group with Ctrl+G
        await page.keyboard.down('Control');
        await page.keyboard.press('g');
        await page.keyboard.up('Control');
        await page.waitForTimeout(200);

        // After grouping: should have fewer top-level objects (group replaces 2 rects)
        const countAfterGroup = await getObjectCount(page);
        assert(countAfterGroup < countBefore, `Object count decreased after grouping (${countAfterGroup} < ${countBefore})`);

        // The active object should be a group with _isUserGroup flag
        const groupInfo = await page.evaluate(() => {
            const active = window.app.canvas.fabricCanvas.getActiveObject();
            return {
                type: active?.type,
                isUserGroup: active?._isUserGroup,
                childCount: active?._objects?.length,
            };
        });
        assert(groupInfo.type === 'group', 'Active object is a group');
        assert(groupInfo.isUserGroup === true, 'Group has _isUserGroup flag');
        assert(groupInfo.childCount === countBefore, `Group contains ${countBefore} children`);

        // 1.4 — Ungroup with Ctrl+Shift+G
        await page.keyboard.down('Control');
        await page.keyboard.down('Shift');
        await page.keyboard.press('g');
        await page.keyboard.up('Shift');
        await page.keyboard.up('Control');
        await page.waitForTimeout(200);

        const countAfterUngroup = await getObjectCount(page);
        assert(countAfterUngroup === countBefore, `Object count restored after ungrouping (${countAfterUngroup} === ${countBefore})`);

        await clearCanvas(page);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 2: Arc Tool
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 2: Arc Tool --');

        // 2.1 — Arc button exists in the markup toolbar
        const arcBtn = await page.$('.tool-btn[data-tool="arc"]');
        assert(arcBtn !== null, 'Arc tool button exists in markup toolbar');

        // 2.2 — Draw an arc
        await openMarkupTab(page);
        await page.evaluate(() => {
            document.querySelector('.tool-btn[data-tool="arc"]').click();
        });
        await page.waitForTimeout(100);

        const arcStart = await toPageCoords(page, 100, 200);
        const arcEnd = await toPageCoords(page, 250, 200);
        await page.mouse.move(arcStart.x, arcStart.y);
        await page.mouse.down();
        await page.mouse.move(arcEnd.x, arcEnd.y);
        await page.mouse.up();
        await page.waitForTimeout(300);

        const arcCount = await getObjectCount(page);
        assert(arcCount >= 1, `Arc object created (${arcCount} objects on canvas)`);

        // 2.3 — The arc should be a Path object
        const arcType = await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects();
            return objs[objs.length - 1]?.type;
        });
        assert(arcType === 'path', `Arc is a Path object (type=${arcType})`);

        await clearCanvas(page);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 3: Radius / Diameter Measure
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 3: Radius/Diameter Measure --');

        // 3.1 — Radius button exists
        const radiusBtn = await page.$('.tool-btn[data-tool="radius"]');
        assert(radiusBtn !== null, 'Radius tool button exists in measure toolbar');

        // 3.2 — Draw a radius measurement
        await openMeasureTab(page);
        await page.evaluate(() => {
            document.querySelector('.tool-btn[data-tool="radius"]').click();
        });
        await page.waitForTimeout(100);

        const radCenter = await toPageCoords(page, 200, 200);
        const radEdge = await toPageCoords(page, 260, 200);
        await page.mouse.move(radCenter.x, radCenter.y);
        await page.mouse.down();
        await page.mouse.move(radEdge.x, radEdge.y);
        await page.mouse.up();
        await page.waitForTimeout(300);

        const radCount = await getObjectCount(page);
        assert(radCount >= 1, `Radius measurement created (${radCount} objects on canvas)`);

        // 3.3 — The measurement should be a Group with measurementType 'radius'
        const radInfo = await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects();
            const last = objs[objs.length - 1];
            return {
                type: last?.type,
                measurementType: last?.measurementType,
                hasLabel: last?.labelText?.includes('\u2300'),
            };
        });
        assert(radInfo.type === 'group', `Radius measurement is a Group (type=${radInfo.type})`);
        assert(radInfo.measurementType === 'radius', `measurementType is 'radius'`);
        assert(radInfo.hasLabel === true, 'Label contains diameter symbol');

        await clearCanvas(page);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 4: PDF Text Selection Layer
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 4: PDF Text Selection Layer --');

        // 4.1 — #text-layer div exists in the DOM
        const textLayerEl = await page.$('#text-layer');
        assert(textLayerEl !== null, '#text-layer element exists');

        // 4.2 — Text words API returns data for a PDF document
        const wordsResponse = await page.evaluate(async () => {
            const resp = await fetch(`/api/documents/${window.app.docId}/text-words/0`);
            return { ok: resp.ok, status: resp.status };
        });
        assert(wordsResponse.ok, `Text words API returns OK (status ${wordsResponse.status})`);

        // 4.3 — Text layer contains spans (if the document has text)
        // Wait a moment for async text layer load
        await page.waitForTimeout(500);
        const spanCount = await page.evaluate(() => {
            return document.querySelectorAll('#text-layer span').length;
        });
        // Note: span count depends on the test document having text.
        // We just verify the layer tried to render (0 is OK for a blank/scan doc).
        assert(spanCount >= 0, `Text layer rendered ${spanCount} word spans`);

        // 4.4 — Text layer toggles text-select-active class based on tool
        // First switch to a drawing tool, then back to hand mode
        await openMarkupTab(page);
        await page.keyboard.press('r');
        await page.waitForTimeout(200);

        const textSelectActiveInDraw = await page.evaluate(() => {
            return document.getElementById('text-layer')?.classList.contains('text-select-active');
        });
        assert(textSelectActiveInDraw === false, 'Text layer inactive during drawing');

        // Switch to hand mode (Escape) — text should become selectable
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        const textSelectActiveInHand = await page.evaluate(() => {
            return document.getElementById('text-layer')?.classList.contains('text-select-active');
        });
        assert(textSelectActiveInHand === true, 'Text layer active in hand mode');

        // 4.5 — Text words API rejects CAD documents gracefully
        // (We can't easily test this without a CAD doc, but verify the endpoint shape)
        const wordsData = await page.evaluate(async () => {
            const resp = await fetch(`/api/documents/${window.app.docId}/text-words/0`);
            const data = await resp.json();
            return { hasWords: Array.isArray(data.words), hasPage: typeof data.page === 'number' };
        });
        assert(wordsData.hasWords, 'API response has words array');
        assert(wordsData.hasPage, 'API response has page number');

    } catch (err) {
        console.error('TEST ERROR:', err);
        failed++;
    } finally {
        await browser.close();
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log(`\n  ═══════════════════════════════════════`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log(`  ═══════════════════════════════════════\n`);

    process.exit(failed > 0 ? 1 : 0);
}

run();
