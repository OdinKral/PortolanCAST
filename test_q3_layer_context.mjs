/**
 * PortolanCAST — Q3 Layer Assignment Context Menu Tests
 *
 * Tests that right-clicking on a markup or measurement object on the canvas
 * shows a context menu listing all available layers, and that clicking a layer
 * item correctly re-assigns the object's layerId and applies layer state.
 *
 * Covers:
 *   - Menu appearance (element in DOM, header, layer items, current indicator)
 *   - Single-object assignment via right-click
 *   - Multi-object assignment when a selection is active
 *   - Empty-canvas right-click → no menu
 *   - Dismiss via Escape key and via click outside
 *   - Auto-save triggered (onContentChange callback fired)
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_q3_layer_context.mjs"
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID = 1;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else           { failed++; console.log(`  FAIL: ${msg}`); }
}

/** Dispatch a contextmenu MouseEvent on the Fabric canvas wrapper at the given
 *  canvas-space coordinates (natural, pre-zoom coords). Zoom must be 100%. */
async function rightClickAt(page, canvasX, canvasY) {
    return page.evaluate(({ cx, cy }) => {
        const wrapper = window.app.canvas.fabricCanvas.wrapperEl;
        const upper = wrapper.querySelector('.upper-canvas') || wrapper.querySelector('canvas');
        const rect = upper.getBoundingClientRect();
        // At zoom=100%, canvas internal coord === display pixel offset from canvas origin
        const clientX = rect.left + cx;
        const clientY = rect.top  + cy;
        wrapper.dispatchEvent(new MouseEvent('contextmenu', {
            clientX, clientY, bubbles: true, cancelable: true,
        }));
        return { clientX, clientY };
    }, { cx: canvasX, cy: canvasY });
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);

        // Start clean
        await page.evaluate(() => {
            window.app.canvas.pageMarkups.clear();
            window.app.canvas.fabricCanvas.clear();
            window.app.viewer.setZoom(100);
        });

        // ── Test 1: Add a second layer so the menu is meaningful ─────────────
        console.log('\n  -- Group 1: Setup --');

        const layerSetup = await page.evaluate(() => {
            window.app.layerManager.addLayer();
            const layers = window.app.layerManager._layers;
            return {
                count: layers.length,
                ids: layers.map(l => l.id),
                names: layers.map(l => l.name),
            };
        });
        assert(layerSetup.count >= 2, `At least 2 layers exist (got ${layerSetup.count})`);

        // ── Test 2-5: Menu structure ──────────────────────────────────────────
        console.log('\n  -- Group 2: Menu Structure --');

        // Create a rect at (100, 100) assigned to 'default'
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const r = new fabric.Rect({
                left: 100, top: 100, width: 80, height: 60,
                fill: 'transparent', stroke: '#aaaaaa', strokeWidth: 2,
                selectable: true,
            });
            window.app.canvas.stampDefaults(r, { markupType: 'note' });
            r.layerId = 'default';
            fc.add(r);
            fc.renderAll();
        });

        // Right-click at center of the rect (140, 130)
        await rightClickAt(page, 140, 130);
        await page.waitForTimeout(150);

        const menuPresent = await page.evaluate(() => !!document.getElementById('layer-context-menu'));
        assert(menuPresent, 'Context menu appears in DOM after right-clicking on object');

        const menuHeader = await page.evaluate(() => {
            const h = document.querySelector('.ctx-menu-header');
            return h ? h.textContent.trim() : null;
        });
        assert(
            menuHeader && menuHeader.includes('Assign'),
            `Menu header contains "Assign" (got "${menuHeader}")`
        );

        const itemCount = await page.evaluate(() =>
            document.querySelectorAll('.ctx-menu-item').length
        );
        assert(
            itemCount === layerSetup.count,
            `Menu has one item per layer (expected ${layerSetup.count}, got ${itemCount})`
        );

        const currentMarked = await page.evaluate(() => {
            // The 'default' layer item should have class 'current'
            const items = document.querySelectorAll('.ctx-menu-item');
            for (const item of items) {
                if (item.dataset.layerId === 'default' && item.classList.contains('current')) {
                    return true;
                }
            }
            return false;
        });
        assert(currentMarked, "Current layer ('default') item has 'current' class");

        // Close the menu before next test
        await page.evaluate(() => window.app.layerManager._hideContextMenu());

        // ── Test 6: Right-click on empty area shows no menu ───────────────────
        console.log('\n  -- Group 3: Empty-Canvas Right-Click --');

        // Right-click far from any object (400, 400)
        await rightClickAt(page, 400, 400);
        await page.waitForTimeout(100);

        const emptyMenuPresent = await page.evaluate(() =>
            !!document.getElementById('layer-context-menu')
        );
        assert(!emptyMenuPresent, 'No context menu when right-clicking empty canvas');

        // ── Test 7-8: Layer assignment ────────────────────────────────────────
        console.log('\n  -- Group 4: Single-Object Assignment --');

        // Record the second layer's ID for assignment
        const secondLayerId = layerSetup.ids.find(id => id !== 'default');
        assert(!!secondLayerId, `Second layer ID found (${secondLayerId})`);

        // Track whether onContentChange was fired
        await page.evaluate(() => {
            window._contentChangeFired = 0;
            const origCC = window.app.canvas.onContentChange;
            window.app.canvas.onContentChange = () => {
                window._contentChangeFired++;
                if (origCC) origCC();
            };
        });

        // Right-click the rect and click the second layer item
        await rightClickAt(page, 140, 130);
        await page.waitForTimeout(150);

        await page.evaluate((targetId) => {
            const item = document.querySelector(`.ctx-menu-item[data-layer-id="${targetId}"]`);
            if (item) item.click();
        }, secondLayerId);
        await page.waitForTimeout(150);

        const objLayerId = await page.evaluate(() => {
            const objects = window.app.canvas.fabricCanvas.getObjects();
            const markup = objects.find(o => o.markupType);
            return markup ? markup.layerId : null;
        });
        assert(
            objLayerId === secondLayerId,
            `Object layerId updated to second layer after menu click (got "${objLayerId}")`
        );

        const menuGone = await page.evaluate(() => !document.getElementById('layer-context-menu'));
        assert(menuGone, 'Context menu dismissed after layer selection');

        const contentChangeFired = await page.evaluate(() => window._contentChangeFired);
        assert(contentChangeFired > 0, `onContentChange fired after assignment (count=${contentChangeFired})`);

        // ── Test 9-11: Multi-selection assignment ─────────────────────────────
        console.log('\n  -- Group 5: Multi-Selection Assignment --');

        // Create a second rect and select both
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const r2 = new fabric.Rect({
                left: 220, top: 100, width: 80, height: 60,
                fill: 'transparent', stroke: '#ff4444', strokeWidth: 2,
                selectable: true,
            });
            window.app.canvas.stampDefaults(r2, { markupType: 'issue' });
            r2.layerId = 'default';
            fc.add(r2);

            // Select all selectable objects (makes ActiveSelection)
            const objs = fc.getObjects().filter(o => o.selectable);
            if (objs.length >= 2) {
                const sel = new fabric.ActiveSelection(objs, { canvas: fc });
                fc.setActiveObject(sel);
                fc.renderAll();
            }
        });
        await page.waitForTimeout(150);

        const selectionCount = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getActiveObjects().length
        );
        assert(selectionCount >= 2, `ActiveSelection has ${selectionCount} objects (expected ≥2)`);

        // Right-click on first rect — should target the whole selection
        await rightClickAt(page, 140, 130);
        await page.waitForTimeout(150);

        const multiHeader = await page.evaluate(() => {
            const h = document.querySelector('.ctx-menu-header');
            return h ? h.textContent.trim() : null;
        });
        assert(
            multiHeader && multiHeader.includes('objects'),
            `Multi-selection header mentions "objects" (got "${multiHeader}")`
        );

        // Assign both to 'default' layer (reset)
        await page.evaluate(() => {
            const item = document.querySelector('.ctx-menu-item[data-layer-id="default"]');
            if (item) item.click();
        });
        await page.waitForTimeout(150);

        const allOnDefault = await page.evaluate(() => {
            const objects = window.app.canvas.fabricCanvas.getObjects()
                .filter(o => o.markupType);
            return objects.every(o => o.layerId === 'default');
        });
        assert(allOnDefault, 'All selected objects re-assigned to default layer');

        // ── Test 12: Escape key dismisses menu ───────────────────────────────
        console.log('\n  -- Group 6: Dismiss Behavior --');

        await rightClickAt(page, 140, 130);
        await page.waitForTimeout(100);

        const menuBeforeEsc = await page.evaluate(() => !!document.getElementById('layer-context-menu'));
        assert(menuBeforeEsc, 'Menu visible before Escape');

        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', bubbles: true, cancelable: true,
            }));
        });
        await page.waitForTimeout(100);

        const menuAfterEsc = await page.evaluate(() => !!document.getElementById('layer-context-menu'));
        assert(!menuAfterEsc, 'Escape key dismisses context menu');

        // ── Test 13: Click outside dismisses menu ────────────────────────────
        await rightClickAt(page, 140, 130);
        await page.waitForTimeout(200); // wait for setTimeout(0) dismiss-bind

        const menuBeforeOut = await page.evaluate(() => !!document.getElementById('layer-context-menu'));
        assert(menuBeforeOut, 'Menu visible before outside click');

        await page.evaluate(() => {
            // Mousedown outside the menu — triggers the dismiss listener
            document.dispatchEvent(new MouseEvent('mousedown', {
                clientX: 5, clientY: 5, bubbles: true,
            }));
        });
        await page.waitForTimeout(100);

        const menuAfterOut = await page.evaluate(() => !!document.getElementById('layer-context-menu'));
        assert(!menuAfterOut, 'Click outside dismisses context menu');

    } finally {
        // Restore clean state
        await page.evaluate(() => {
            try {
                window.app.layerManager._hideContextMenu();
                window.app.canvas.fabricCanvas.clear();
                window.app.canvas.pageMarkups.clear();
                window.app.viewer.setZoom(100);
                // Remove extra test layer — keep only 'default'
                const extra = window.app.layerManager._layers
                    .filter(l => l.id !== 'default')
                    .map(l => l.id);
                for (const id of extra) window.app.layerManager.deleteLayer(id);
            } catch (_) {}
        }).catch(() => {});
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
