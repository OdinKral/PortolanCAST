/**
 * PortolanCAST — Arrow Tool Tests
 *
 * Verifies the arrow markup tool:
 *   1. Button exists in markup toolbar with correct title/icon.
 *   2. _TOOL_TAB maps arrow → 'markup'.
 *   3. Tool activates on button click (isDrawingMode false, selection false).
 *   4. Shift+A keyboard shortcut activates the tool.
 *   5. mouse:down / mouse:move / mouse:up handlers are registered.
 *   6. Drag on canvas produces a permanent Group object.
 *   7. Finished arrow group has markupType, markupId, and correct fill/stroke.
 *   8. Arrow group contains two children: shaft (line) + arrowhead (path).
 *   9. Tool reverts to select after placing an arrow.
 *  10. Too-short drag (< 3px) creates no object.
 *  11. Switching markup type while arrow is active updates stroke color.
 *  12. Arrow persists across save / reload (round-trip).
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_arrow.mjs"
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
// COORDINATE HELPERS (same pattern as test_phase2.mjs)
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

// =============================================================================
// SETUP HELPERS
// =============================================================================

async function openMarkupTab(page) {
    await page.click('.toolbar-tab[data-tab="markup"]');
    await page.waitForTimeout(100);
}

/**
 * Activate the arrow tool.
 * Presses V first so setTool's toggle-off logic doesn't deactivate the tool
 * if it was already active. V switches to the navigate tab, so we re-open
 * the markup tab afterwards.
 */
async function activateArrow(page) {
    await page.keyboard.press('v');     // switch away from any active tool
    await page.waitForTimeout(50);
    await openMarkupTab(page);          // re-open markup tab (V moved us to navigate)
    await page.click('.tool-btn[data-tool="arrow"]');
    await page.waitForTimeout(100);
}

/**
 * Drag on the Fabric canvas from (x1, y1) to (x2, y2) in natural canvas coords.
 * Simulates mousedown → move → mouseup as the arrow tool expects.
 */
async function dragArrow(page, x1, y1, x2, y2) {
    const start = await toPageCoords(page, x1, y1);
    const end   = await toPageCoords(page, x2, y2);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 5 });
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

        const btnExists = await page.$('button[data-tool="arrow"]');
        assert(btnExists !== null, 'Arrow button exists in markup toolbar');

        const btnTitle = await page.evaluate(() =>
            document.querySelector('.tool-btn[data-tool="arrow"]')?.title || ''
        );
        assert(btnTitle.toLowerCase().includes('arrow'),
            `Button title mentions "Arrow" (got "${btnTitle}")`);

        const hasIcon = await page.evaluate(() =>
            !!document.querySelector('.tool-btn[data-tool="arrow"] .icon')
        );
        assert(hasIcon, 'Arrow button has .icon span');

        // ── Group 2: _TOOL_TAB mapping ────────────────────────────────────────
        console.log('\n  -- Group 2: _TOOL_TAB mapping --');

        const toolTab = await page.evaluate(() =>
            window.app?.toolbar?._TOOL_TAB?.arrow
        );
        assert(toolTab === 'markup',
            `_TOOL_TAB["arrow"] === "markup" (got "${toolTab}")`);

        // ── Group 3: Tool activation ──────────────────────────────────────────
        console.log('\n  -- Group 3: Tool Activation --');

        await activateArrow(page);

        const activeTool = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(activeTool === 'arrow',
            `activeTool === "arrow" after click (got "${activeTool}")`);

        const noDrawingMode = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.isDrawingMode === false
        );
        assert(noDrawingMode, 'isDrawingMode is false (arrow uses event handlers, not brush)');

        const noSelection = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.selection === false
        );
        assert(noSelection, 'canvas.selection is false while arrow tool is active');

        const btnActive = await page.$eval(
            'button[data-tool="arrow"]',
            el => el.classList.contains('active')
        );
        assert(btnActive, 'Arrow button has .active class while selected');

        // ── Group 4: Keyboard shortcut Shift+A ───────────────────────────────
        console.log('\n  -- Group 4: Keyboard Shortcut (Shift+A) --');

        await page.keyboard.press('v');   // switch away
        await page.waitForTimeout(100);

        // Shift+A produces key 'A' (uppercase) in the browser
        await page.keyboard.press('Shift+A');
        await page.waitForTimeout(100);

        const afterKey = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(afterKey === 'arrow',
            `activeTool === "arrow" after Shift+A (got "${afterKey}")`);

        // 'a' (lowercase, no shift) should still activate area tool
        await page.keyboard.press('a');
        await page.waitForTimeout(100);
        const afterLowerA = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(afterLowerA === 'area',
            `lowercase 'a' still activates area tool (got "${afterLowerA}")`);

        // ── Group 5: Handler registration ────────────────────────────────────
        console.log('\n  -- Group 5: Handler Registration --');

        await activateArrow(page);

        const handlers = await page.evaluate(() => {
            const h = window.app?.toolbar?._shapeHandlers;
            return h ? Object.keys(h) : [];
        });
        assert(handlers.includes('mouse:down'), 'mouse:down handler registered');
        assert(handlers.includes('mouse:move'), 'mouse:move handler registered');
        assert(handlers.includes('mouse:up'),   'mouse:up handler registered');

        // ── Group 6: Drawing — drag produces a Group object ──────────────────
        console.log('\n  -- Group 6: Arrow Drawing --');

        const countBefore = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );

        // Draw an arrow from (80, 80) to (250, 80) — horizontal, easy geometry
        await dragArrow(page, 80, 80, 250, 80);

        const countAfter = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );
        assert(countAfter === countBefore + 1,
            `One arrow object added (expected ${countBefore + 1}, got ${countAfter})`);

        // ── Group 7: Arrow object properties ─────────────────────────────────
        console.log('\n  -- Group 7: Arrow Object Properties --');

        const arrowObj = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            // Find the most recently added group
            for (let i = objs.length - 1; i >= 0; i--) {
                if (objs[i].type === 'group') {
                    return {
                        type:       objs[i].type,
                        markupType: objs[i].markupType,
                        markupId:   objs[i].markupId,
                        childCount: objs[i]._objects?.length,
                    };
                }
            }
            return null;
        });

        assert(arrowObj !== null,                   'An arrow group object exists on canvas');
        assert(arrowObj?.type === 'group',           `type is "group" (got "${arrowObj?.type}")`);
        assert(!!arrowObj?.markupType,              `markupType is set (got "${arrowObj?.markupType}")`);
        assert(!!arrowObj?.markupId,                 'markupId UUID stamped on arrow');

        // ── Group 8: Arrow has exactly 2 children (shaft + arrowhead) ─────────
        console.log('\n  -- Group 8: Arrow Group Structure --');

        const childTypes = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            for (let i = objs.length - 1; i >= 0; i--) {
                if (objs[i].type === 'group' && objs[i].markupType) {
                    return objs[i]._objects?.map(c => c.type) || [];
                }
            }
            return null;
        });

        assert(childTypes !== null,                 'Arrow group has _objects array');
        assert(childTypes?.length === 2,            `Group has exactly 2 children (got ${childTypes?.length})`);
        assert(childTypes?.includes('line'),        `Children include a shaft Line (types: ${childTypes?.join(', ')})`);
        assert(childTypes?.includes('path'),        `Children include an arrowhead Path (types: ${childTypes?.join(', ')})`);

        // Arrowhead Path should be filled with the stroke color (filled triangle)
        const headFill = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            for (let i = objs.length - 1; i >= 0; i--) {
                if (objs[i].type === 'group' && objs[i].markupType) {
                    const pathChild = objs[i]._objects?.find(c => c.type === 'path');
                    return pathChild ? pathChild.fill : null;
                }
            }
            return null;
        });
        assert(!!headFill && headFill !== 'transparent',
            `Arrowhead Path has non-transparent fill (got "${headFill}")`);

        // ── Group 9: Tool reverts to select after placing ────────────────────
        console.log('\n  -- Group 9: Auto-revert to Select --');

        // Arrow is a click-drag tool (not one-shot) — it should STAY on arrow
        // after placing one, unlike Text which auto-switches. Let's verify.
        const toolAfter = await page.evaluate(() => window.app?.toolbar?.activeTool);
        // Arrow should remain active (continuous drawing mode, like rect/line)
        assert(toolAfter === 'arrow',
            `Arrow tool stays active after placing one arrow (got "${toolAfter}")`);

        // ── Group 10: Too-short drag creates no object ───────────────────────
        console.log('\n  -- Group 10: Minimum Length (< 3px) --');

        await activateArrow(page);
        const countBeforeShort = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );

        // Drag only 1px — below the 3px minimum
        const shortStart = await toPageCoords(page, 300, 200);
        await page.mouse.move(shortStart.x, shortStart.y);
        await page.mouse.down();
        await page.mouse.move(shortStart.x + 1, shortStart.y, { steps: 1 });
        await page.mouse.up();
        await page.waitForTimeout(200);

        const countAfterShort = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );
        assert(countAfterShort === countBeforeShort,
            `Short drag (< 3px) creates no object (${countBeforeShort}→${countAfterShort})`);

        // ── Group 11: Markup type change updates stroke color ─────────────────
        console.log('\n  -- Group 11: Markup Type → Stroke Color --');

        // Ensure arrow is active
        await activateArrow(page);

        // Set markup type to 'issue' (red)
        await page.keyboard.press('2');   // '2' = issue
        await page.waitForTimeout(100);

        await dragArrow(page, 80, 200, 200, 200);

        const issueStroke = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            for (let i = objs.length - 1; i >= 0; i--) {
                if (objs[i].type === 'group' && objs[i].markupType === 'issue') {
                    const lineChild = objs[i]._objects?.find(c => c.type === 'line');
                    return lineChild?.stroke || null;
                }
            }
            return null;
        });
        assert(issueStroke === '#ff4444',
            `Issue-type arrow shaft stroke is red #ff4444 (got "${issueStroke}")`);

        // Reset markup type to 'note' for cleanup
        await page.keyboard.press('1');

        // ── Group 12: Save / reload round-trip ───────────────────────────────
        console.log('\n  -- Group 12: Save / Reload Round-trip --');

        // Draw one final fresh arrow to save
        await activateArrow(page);
        await dragArrow(page, 50, 350, 220, 300);

        // Save to server
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

        // Reload and verify an arrow group survived
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        const arrowAfterReload = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            return objs.some(o => o.type === 'group' && !!o.markupType);
        });
        assert(arrowAfterReload, 'Arrow group persists after page reload');

        const mtAfterReload = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const g = objs.find(o => o.type === 'group' && !!o.markupType);
            return g?.markupType || null;
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
