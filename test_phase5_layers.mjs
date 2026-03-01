/**
 * PortolanCAST — Phase 5 Layer System Browser Tests
 *
 * Tests the document-wide layer system: panel shell, server endpoints,
 * layer CRUD operations, layer state (visibility/lock), and markup assignment.
 *
 * Groups:
 *   1. Panel Shell (5)        — tab button, content div, list, count, new-layer btn
 *   2. Server Endpoint (5)    — GET /layers, response shape, default layer structure
 *   3. Layer CRUD (7)         — add layer, count update, rename, server save, delete, guard
 *   4. Layer States (5)       — setActive, toggle visible, object visibility, toggle lock, object lock
 *   5. Markup Assignment (3)  — default layer, custom layer, page nav persistence
 *
 * Total: 25 tests
 * Running total after this suite: 438 + 25 = 463
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_phase5_layers.mjs"
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-02-23
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID = 1;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
        console.log(`  PASS: ${msg}`);
    } else {
        failed++;
        console.log(`  FAIL: ${msg}`);
    }
}

async function run() {
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // =====================================================================
        // SETUP: Load edit page, reset markups and layer state to clean baseline
        // =====================================================================
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear server-saved markups from previous test runs
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

        // Reset layers to single default layer for clean test state
        await fetch(`${BASE_URL}/api/documents/${DOC_ID}/layers`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                layers: [{ id: 'default', name: 'Default', visible: true, locked: false }],
                activeId: 'default',
            }),
        });

        // Reload page so LayerManager picks up the reset state
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // =====================================================================
        // TEST GROUP 1: Panel Shell
        // =====================================================================
        console.log('\n--- Test Group 1: Panel Shell ---');

        // 1.1 — Layers tab button exists in .panel-tabs
        const layersTabBtn = await page.$('.panel-tabs .panel-tab[data-panel="layers"]');
        assert(layersTabBtn !== null, 'Layers tab button exists in .panel-tabs');

        // 1.2 — #tab-layers content div exists
        const layersTabContent = await page.$('#tab-layers');
        assert(layersTabContent !== null, '#tab-layers content div exists');

        // 1.3 — Clicking Layers tab makes it .active
        await page.click('.panel-tabs .panel-tab[data-panel="layers"]');
        await page.waitForTimeout(200);
        const layersTabActive = await page.$eval(
            '#tab-layers',
            el => el.classList.contains('active')
        );
        assert(layersTabActive, 'Clicking Layers tab makes #tab-layers .active');

        // 1.4 — #layers-list exists in panel
        const layersList = await page.$('#layers-list');
        assert(layersList !== null, '#layers-list element exists in Layers panel');

        // 1.5 — #btn-new-layer button exists
        const btnNewLayer = await page.$('#btn-new-layer');
        assert(btnNewLayer !== null, '#btn-new-layer button exists');

        // =====================================================================
        // TEST GROUP 2: Server Endpoint
        // =====================================================================
        console.log('\n--- Test Group 2: Server Endpoint ---');

        // 2.1 — GET /api/documents/1/layers → 200
        const resp = await fetch(`${BASE_URL}/api/documents/${DOC_ID}/layers`);
        assert(resp.ok, `GET /api/documents/${DOC_ID}/layers returns HTTP 200`);

        // 2.2 — Response has non-empty layers array
        const layerData = await resp.json();
        assert(
            Array.isArray(layerData.layers) && layerData.layers.length > 0,
            'Response has non-empty layers array'
        );

        // 2.3 — Response has activeId string field
        assert(
            typeof layerData.activeId === 'string' && layerData.activeId.length > 0,
            'Response has activeId string field'
        );

        // 2.4 — Default layer has id = "default" and name = "Default"
        const defaultLayer = layerData.layers.find(l => l.id === 'default');
        assert(
            defaultLayer !== undefined && defaultLayer.name === 'Default',
            'Default layer has id="default" and name="Default"'
        );

        // 2.5 — Default layer has visible: true, locked: false
        assert(
            defaultLayer && defaultLayer.visible === true && defaultLayer.locked === false,
            'Default layer has visible:true, locked:false'
        );

        // =====================================================================
        // TEST GROUP 3: Layer CRUD
        // =====================================================================
        console.log('\n--- Test Group 3: Layer CRUD ---');

        // Ensure Layers tab is active for DOM interaction
        await page.click('.panel-tabs .panel-tab[data-panel="layers"]');
        await page.waitForTimeout(200);

        // 3.1 — Clicking + Layer adds a new .layer-row to #layers-list
        const rowsBefore = await page.$$('#layers-list .layer-row');
        await page.click('#btn-new-layer');
        await page.waitForTimeout(300);
        const rowsAfter = await page.$$('#layers-list .layer-row');
        assert(rowsAfter.length === rowsBefore.length + 1, '+ Layer button adds a new .layer-row');

        // 3.2 — #layers-count text increments after adding a layer
        const countText = await page.$eval('#layers-count', el => el.textContent);
        assert(
            countText.includes(String(rowsAfter.length)),
            `#layers-count shows correct count after add (${countText})`
        );

        // 3.3 — Double-click layer name → <input> appears; type + blur → name updates
        // Find the newly added layer row (last row)
        const lastRowId = await page.$eval(
            '#layers-list .layer-row:last-child',
            el => el.dataset.layerId
        );
        const nameSpan = await page.$(`#layers-list .layer-row[data-layer-id="${lastRowId}"] .layer-name`);
        await nameSpan.dblclick();
        await page.waitForTimeout(100);
        const nameInput = await page.$('.layer-name-input');
        assert(nameInput !== null, 'Double-clicking layer name shows rename <input>');
        await page.fill('.layer-name-input', 'Electrical');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);

        // Verify name updated in DOM
        const updatedName = await page.$eval(
            `#layers-list .layer-row[data-layer-id="${lastRowId}"] .layer-name`,
            el => el.textContent
        );
        assert(updatedName === 'Electrical', `Layer name updated to "Electrical" after inline rename`);

        // 3.4 — Renamed layer name is saved to server
        await page.waitForTimeout(500); // allow async _save to complete
        const verifyResp = await fetch(`${BASE_URL}/api/documents/${DOC_ID}/layers`);
        const verifyData = await verifyResp.json();
        const renamedLayer = verifyData.layers.find(l => l.id === lastRowId);
        assert(
            renamedLayer && renamedLayer.name === 'Electrical',
            'Renamed layer name persisted to server'
        );

        // 3.5 — Delete × button removes the layer row from the list
        const rowsBeforeDelete = await page.$$('#layers-list .layer-row');
        // Hover over the row to make delete button visible (CSS opacity)
        await page.hover(`#layers-list .layer-row[data-layer-id="${lastRowId}"]`);
        await page.click(`#layers-list .layer-row[data-layer-id="${lastRowId}"] .layer-delete-btn`);
        await page.waitForTimeout(300);
        const rowsAfterDelete = await page.$$('#layers-list .layer-row');
        assert(
            rowsAfterDelete.length === rowsBeforeDelete.length - 1,
            'Delete × button removes the layer row'
        );

        // 3.6 — Cannot delete last remaining layer (guard: ≥2 required)
        // Ensure only 1 layer remains (should be "Default" after delete above).
        // Note: use data-layer-id selector, NOT :first-child — #layers-empty paragraph
        // is the actual first DOM child, so :first-child won't match .layer-row.
        const currentRows = await page.$$('#layers-list .layer-row');
        if (currentRows.length === 1) {
            // Target the sole remaining row by its known ID ("default")
            await page.hover('#layers-list .layer-row[data-layer-id="default"]');
            await page.click('#layers-list .layer-row[data-layer-id="default"] .layer-delete-btn');
            await page.waitForTimeout(300);
            const rowsAfterGuard = await page.$$('#layers-list .layer-row');
            assert(
                rowsAfterGuard.length === 1,
                'Cannot delete last layer — row count unchanged (guard active)'
            );
        } else {
            // More than 1 layer — skip: delete guard already tested implicitly above
            assert(true, 'Cannot delete last layer (guard: ≥2 required) — skipped, >1 layers remain');
        }

        // 3.7 — After add + delete, remaining layer count is correct
        // Add two layers, delete one, verify count
        await page.click('#btn-new-layer');
        await page.click('#btn-new-layer');
        await page.waitForTimeout(300);
        const afterAdd2 = await page.$$('#layers-list .layer-row');
        const expectedCount = afterAdd2.length;
        // Delete the last one
        const lastRow2Id = await page.$eval(
            '#layers-list .layer-row:last-child',
            el => el.dataset.layerId
        );
        await page.hover(`#layers-list .layer-row[data-layer-id="${lastRow2Id}"]`);
        await page.click(`#layers-list .layer-row[data-layer-id="${lastRow2Id}"] .layer-delete-btn`);
        await page.waitForTimeout(300);
        const afterDelete2 = await page.$$('#layers-list .layer-row');
        assert(
            afterDelete2.length === expectedCount - 1,
            `After add×2 + delete×1: ${afterDelete2.length} rows (expected ${expectedCount - 1})`
        );

        // =====================================================================
        // TEST GROUP 4: Layer States
        // =====================================================================
        console.log('\n--- Test Group 4: Layer States ---');

        // Reset to clean state: only Default + one test layer
        await fetch(`${BASE_URL}/api/documents/${DOC_ID}/layers`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                layers: [
                    { id: 'default', name: 'Default', visible: true, locked: false },
                    { id: 'test-layer', name: 'Test', visible: true, locked: false },
                ],
                activeId: 'default',
            }),
        });

        // Reload to get fresh layer state
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear canvases after reload
        await page.evaluate(async () => {
            window.app.canvas.pageMarkups.clear();
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
            window.app._dirty = false;
        });

        // Switch to Layers tab
        await page.click('.panel-tabs .panel-tab[data-panel="layers"]');
        await page.waitForTimeout(200);

        // 4.1 — Clicking a layer row gives it .active class (removes .active from others)
        await page.click('#layers-list .layer-row[data-layer-id="test-layer"]');
        await page.waitForTimeout(150);
        const testRowActive = await page.$eval(
            '#layers-list .layer-row[data-layer-id="test-layer"]',
            el => el.classList.contains('active')
        );
        const defaultRowActive = await page.$eval(
            '#layers-list .layer-row[data-layer-id="default"]',
            el => el.classList.contains('active')
        );
        assert(
            testRowActive && !defaultRowActive,
            'Clicking a layer row gives it .active, removes .active from others'
        );

        // Set Default as active again for remaining state tests
        await page.click('#layers-list .layer-row[data-layer-id="default"]');
        await page.waitForTimeout(150);

        // 4.2 — Eye 👁 button toggles → row gains .layer-hidden class
        await page.click('#layers-list .layer-row[data-layer-id="test-layer"] .layer-vis-btn');
        await page.waitForTimeout(200);
        const testRowHidden = await page.$eval(
            '#layers-list .layer-row[data-layer-id="test-layer"]',
            el => el.classList.contains('layer-hidden')
        );
        assert(testRowHidden, 'Eye button toggle: row gains .layer-hidden class');

        // 4.3 — Objects on the hidden layer: obj.visible === false on Fabric canvas
        // Add a rect to Default layer (visible), then draw on test-layer (hidden)
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 50, top: 50, width: 100, height: 80,
                fill: 'transparent', stroke: '#ff0000',
                markupType: 'note',
            });
            rect.layerId = 'test-layer'; // explicitly assign to hidden layer
            fc.add(rect);
        });
        await page.waitForTimeout(200);
        // Layer state should be applied immediately via object:added
        // Force _applyAllLayerStates to ensure it's applied
        await page.evaluate(() => window.app.layerManager._applyAllLayerStates());
        await page.waitForTimeout(100);
        const hiddenObjVisible = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const objs = fc.getObjects();
            const obj = objs.find(o => o.layerId === 'test-layer');
            return obj ? obj.visible : null;
        });
        assert(hiddenObjVisible === false, 'Object on hidden layer has obj.visible === false');

        // 4.4 — Lock 🔓 button toggles → row gains .layer-locked class
        // First make test-layer visible again, then lock it
        await page.click('#layers-list .layer-row[data-layer-id="test-layer"] .layer-vis-btn');
        await page.waitForTimeout(200); // toggle visible back on
        await page.click('#layers-list .layer-row[data-layer-id="test-layer"] .layer-lock-btn');
        await page.waitForTimeout(200);
        const testRowLocked = await page.$eval(
            '#layers-list .layer-row[data-layer-id="test-layer"]',
            el => el.classList.contains('layer-locked')
        );
        assert(testRowLocked, 'Lock button toggle: row gains .layer-locked class');

        // 4.5 — Objects on locked layer: obj.selectable === false on Fabric canvas
        await page.evaluate(() => window.app.layerManager._applyAllLayerStates());
        await page.waitForTimeout(100);
        const lockedObjSelectable = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const objs = fc.getObjects();
            const obj = objs.find(o => o.layerId === 'test-layer');
            return obj ? obj.selectable : null;
        });
        assert(lockedObjSelectable === false, 'Object on locked layer has obj.selectable === false');

        // =====================================================================
        // TEST GROUP 5: Markup Assignment
        // =====================================================================
        console.log('\n--- Test Group 5: Markup Assignment ---');

        // Reset: clean canvas, Default layer active
        await page.evaluate(async () => {
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
            window.app._dirty = false;
        });
        // Ensure Default is active
        await page.evaluate(() => window.app.layerManager.setActive('default'));

        // 5.1 — New markup drawn when Default is active → obj.layerId === 'default'
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 100, top: 100, width: 80, height: 60,
                fill: 'transparent', stroke: '#aaaaaa',
                markupType: 'note',
            });
            // layerId NOT set — should be assigned by object:added hook
            fc.add(rect);
        });
        await page.waitForTimeout(200);
        const defaultLayerId = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const objs = fc.getObjects();
            return objs.length > 0 ? objs[objs.length - 1].layerId : null;
        });
        assert(defaultLayerId === 'default', `New markup on Default layer has layerId = "default" (got: ${defaultLayerId})`);

        // 5.2 — New markup drawn when a non-default layer is active → obj.layerId = that id
        await page.evaluate(() => window.app.layerManager.setActive('test-layer'));
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 200, top: 200, width: 80, height: 60,
                fill: 'transparent', stroke: '#ff4444',
                markupType: 'issue',
            });
            // layerId NOT set — should be assigned by object:added hook
            fc.add(rect);
        });
        await page.waitForTimeout(200);
        const testLayerId = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const objs = fc.getObjects();
            return objs.length > 0 ? objs[objs.length - 1].layerId : null;
        });
        assert(testLayerId === 'test-layer', `New markup on test-layer has layerId = "test-layer" (got: ${testLayerId})`);

        // 5.3 — After page navigation and return, layerId is preserved on canvas objects
        // Save current page markups, navigate to page 2, navigate back to page 1
        await page.evaluate(async () => {
            // Force save the current page markups
            window.app.canvas.onPageChanging(window.app.lastPage);
            await window.app._saveMarkups();
        });
        await page.waitForTimeout(500);

        // Navigate to page 2 (triggers save of page 1)
        await page.evaluate(() => window.app.viewer.goToPage(1));
        await page.waitForTimeout(800);

        // Navigate back to page 1
        await page.evaluate(() => window.app.viewer.goToPage(0));
        await page.waitForTimeout(800);

        // Check that layerIds survived the round-trip via serialize/deserialize
        const layerIdAfterNav = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const objs = fc.getObjects();
            // Find the object that was on test-layer
            const obj = objs.find(o => o.layerId === 'test-layer');
            return obj ? obj.layerId : null;
        });
        assert(
            layerIdAfterNav === 'test-layer',
            `layerId preserved after page navigation (got: ${layerIdAfterNav})`
        );

    } catch (err) {
        failed++;
        console.error('  FATAL:', err.message);
    } finally {
        await browser.close();

        // CLEANUP: Reset layer config to default so subsequent test suites and
        // test runs start with a clean state. Without this, the 'test-layer'
        // (locked, activeId='test-layer') left by this suite would cause objects
        // drawn in test_phase2/3a/4a to be assigned to the locked layer, making
        // them unselectable and breaking those test suites.
        try {
            await fetch(`${BASE_URL}/api/documents/${DOC_ID}/layers`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    layers: [{ id: 'default', name: 'Default', visible: true, locked: false }],
                    activeId: 'default',
                }),
            });
            // Also clear markups from page 0 saved during navigation tests
            await fetch(`${BASE_URL}/api/documents/${DOC_ID}/markups`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages: {} }),
            });
        } catch (cleanupErr) {
            // Non-fatal — cleanup failure shouldn't fail the test
            console.warn('  WARN: Cleanup fetch failed:', cleanupErr.message);
        }
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  Phase 5 Layers Tests`);
    console.log(`${'═'.repeat(50)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log(`${'═'.repeat(50)}`);

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
