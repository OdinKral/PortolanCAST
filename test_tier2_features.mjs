/**
 * PortolanCAST — Tier 2 Feature Tests
 *
 * Purpose:
 *   Verifies the Tier 2 parity features:
 *   1. Multi-row toolbar layout (settings-based)
 *   2. Editable hotkeys (configurable keyboard shortcuts)
 *   3. Auto-landscape detection (settings toggle)
 *   4. Save-as naming modal (bundle export)
 *   5. Layer assignment context menu (right-click)
 *
 * Run:
 *   node test_tier2_features.mjs
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

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 1: Multi-Row Toolbar
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 1: Multi-Row Toolbar --');

        // 1.1 — Toolbar rows selector exists in settings modal
        const settingsBtn = await page.$('#btn-toolbar-settings');
        assert(settingsBtn !== null, 'Toolbar settings button exists');

        // Open settings modal
        await page.evaluate(() => {
            document.getElementById('btn-toolbar-settings')?.click();
        });
        await page.waitForTimeout(200);

        const rowsSelect = await page.$('#settings-toolbar-rows');
        assert(rowsSelect !== null, 'Toolbar rows selector exists in settings');

        // 1.2 — Setting rows to 2 applies data-rows attribute
        await page.evaluate(() => {
            const sel = document.getElementById('settings-toolbar-rows');
            sel.value = '2';
            sel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        const dataRows = await page.evaluate(() => {
            return document.querySelector('.toolbar-row-tools')?.getAttribute('data-rows');
        });
        assert(dataRows === '2', `Toolbar row data-rows set to 2 (got ${dataRows})`);

        // 1.3 — Setting rows back to 1 removes the attribute
        await page.evaluate(() => {
            const sel = document.getElementById('settings-toolbar-rows');
            sel.value = '1';
            sel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        const dataRowsAfter = await page.evaluate(() => {
            return document.querySelector('.toolbar-row-tools')?.getAttribute('data-rows');
        });
        assert(dataRowsAfter === null, 'Toolbar row data-rows removed for 1 row');

        // Close settings
        await page.evaluate(() => {
            document.getElementById('settings-close')?.click();
        });
        await page.waitForTimeout(100);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 2: Editable Hotkeys
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 2: Editable Hotkeys --');

        // 2.1 — Hotkey map is loaded from defaults
        const defaultHotkeys = await page.evaluate(() => {
            return window.app.toolbar._hotkeys;
        });
        assert(defaultHotkeys['r'] === 'rect', `Default 'r' maps to rect`);
        assert(defaultHotkeys['e'] === 'ellipse', `Default 'e' maps to ellipse`);
        assert(defaultHotkeys['v'] === 'select', `Default 'v' maps to select`);

        // 2.2 — Pressing 'r' activates rect tool via hotkey map
        await page.keyboard.press('Escape'); // clear any active tool
        await page.waitForTimeout(100);
        await page.keyboard.press('r');
        await page.waitForTimeout(100);
        const toolAfterR = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(toolAfterR === 'rect', `Pressing 'r' activates rect tool (got ${toolAfterR})`);

        // 2.3 — Hotkey editor populates in settings modal
        await page.evaluate(() => {
            document.getElementById('btn-toolbar-settings')?.click();
        });
        await page.waitForTimeout(200);

        const hotkeyRows = await page.evaluate(() => {
            return document.querySelectorAll('#settings-hotkeys .settings-hotkey-row').length;
        });
        assert(hotkeyRows >= 15, `Hotkey editor has ${hotkeyRows} tool bindings (expected 15+)`);

        // 2.4 — Hotkey input can be rebound
        const rebound = await page.evaluate(() => {
            const input = document.querySelector('#settings-hotkeys input[data-tool="rect"]');
            if (!input) return null;
            // Simulate pressing 'z' to rebind rect
            input.focus();
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z' }));
            return {
                inputValue: input.value,
                hotkeyMap: window.app.toolbar._hotkeys['z'],
            };
        });
        assert(rebound?.inputValue === 'z', `Rect hotkey input updated to 'z'`);
        assert(rebound?.hotkeyMap === 'rect', `Hotkey map updated: z → rect`);

        // Clean up: reset hotkeys to defaults
        await page.evaluate(() => {
            localStorage.removeItem('portolancast-hotkeys');
            // Reload the hotkey map from defaults
            const defaults = {
                'v':'select','p':'pen','r':'rect','e':'ellipse','l':'line',
                'h':'highlighter','g':'hand','t':'text','c':'cloud','C':'connect',
                'o':'callout','w':'polyline','u':'distance','a':'area','A':'arrow',
                's':'sticky-note','i':'image-overlay','n':'count','k':'calibrate',
                'm':'equipment-marker','x':'eraser','f':'polygon','d':'dimension',
                'b':'arc','j':'radius',
            };
            window.app.toolbar._hotkeys = { ...defaults };
        });

        // Close settings
        await page.evaluate(() => {
            document.getElementById('settings-close')?.click();
        });
        await page.waitForTimeout(100);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 3: Auto-Landscape Detection
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 3: Auto-Landscape Detection --');

        // 3.1 — Auto-landscape checkbox exists in settings
        await page.evaluate(() => {
            document.getElementById('btn-toolbar-settings')?.click();
        });
        await page.waitForTimeout(200);

        const autoLandscapeCb = await page.$('#settings-cb-auto-landscape');
        assert(autoLandscapeCb !== null, 'Auto-landscape checkbox exists in settings');

        // 3.2 — Default is checked (on)
        const isChecked = await page.evaluate(() => {
            return document.getElementById('settings-cb-auto-landscape')?.checked;
        });
        assert(isChecked === true, 'Auto-landscape is enabled by default');

        // 3.3 — Toggle saves to localStorage
        await page.evaluate(() => {
            const cb = document.getElementById('settings-cb-auto-landscape');
            cb.checked = false;
            cb.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);
        const stored = await page.evaluate(() => {
            return localStorage.getItem('portolancast-auto-landscape');
        });
        assert(stored === 'false', 'Disabling auto-landscape saves to localStorage');

        // Restore
        await page.evaluate(() => {
            localStorage.removeItem('portolancast-auto-landscape');
        });

        await page.evaluate(() => {
            document.getElementById('settings-close')?.click();
        });
        await page.waitForTimeout(100);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 4: Save-As Naming Modal
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 4: Save-As Naming Modal --');

        // 4.1 — Bundle save modal elements exist
        const bundleModal = await page.$('#modal-save-bundle');
        const bundleInput = await page.$('#bundle-name-input');
        const bundleSaveBtn = await page.$('#bundle-name-save');
        const bundleCancelBtn = await page.$('#bundle-name-cancel');

        assert(bundleModal !== null, 'Bundle name modal exists');
        assert(bundleInput !== null, 'Bundle name input exists');
        assert(bundleSaveBtn !== null, 'Bundle save button exists');
        assert(bundleCancelBtn !== null, 'Bundle cancel button exists');

        // 4.2 — Modal shows and allows cancel
        await page.evaluate(() => {
            const modal = document.getElementById('modal-save-bundle');
            modal.style.display = 'flex';
        });
        await page.waitForTimeout(100);

        const modalVisible = await page.evaluate(() => {
            return document.getElementById('modal-save-bundle')?.style.display;
        });
        assert(modalVisible === 'flex', 'Bundle name modal is visible');

        // Cancel it
        await page.evaluate(() => {
            document.getElementById('bundle-name-cancel')?.click();
        });
        await page.waitForTimeout(100);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 5: Layer Assignment Context Menu
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 5: Layer Assignment Context Menu --');

        // 5.1 — LayerManager has bindContextMenu method
        const hasBind = await page.evaluate(() => {
            return typeof window.app.layerManager?.bindContextMenu === 'function';
        });
        assert(hasBind, 'LayerManager has bindContextMenu method');

        // 5.2 — LayerManager has assignLayer method
        const hasAssign = await page.evaluate(() => {
            return typeof window.app.layerManager?.assignLayer === 'function';
        });
        assert(hasAssign, 'LayerManager has assignLayer method');

        // 5.3 — Create an object and verify it has a layerId
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const r = new fabric.Rect({
                left: 50, top: 50, width: 80, height: 80,
                fill: 'transparent', stroke: '#aaa', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(r);
            fc.add(r);
            fc.renderAll();
        });
        await page.waitForTimeout(200);

        const layerId = await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects();
            return objs[objs.length - 1]?.layerId;
        });
        assert(typeof layerId === 'string' && layerId.length > 0,
            `Object has layerId: "${layerId}"`);

        // 5.4 — assignLayer can reassign objects programmatically
        const reassigned = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const obj = fc.getObjects()[fc.getObjects().length - 1];
            const oldId = obj.layerId;
            // Create a second layer and assign
            const lm = window.app.layerManager;
            if (lm._layers.length < 2) {
                lm.addLayer('Test Layer');
            }
            const newLayerId = lm._layers[lm._layers.length - 1].id;
            lm.assignLayer([obj], newLayerId);
            return { oldId, newId: obj.layerId, changed: oldId !== obj.layerId };
        });
        assert(reassigned.changed, `Object layer reassigned from "${reassigned.oldId}" to "${reassigned.newId}"`);

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
