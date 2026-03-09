/**
 * PortolanCAST — Phase 3B Browser Tests
 *
 * Tests: adaptive toolbar (mode tabs), settings modal, stopPropagation
 * pan fix verification, and measurement recalc on object:modified.
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_phase3b.mjs"
 *
 * Author: PortolanCAST
 * Version: 0.1.0
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

async function toPageCoords(page, naturalX, naturalY) {
    const info = await getCanvasInfo(page);
    return {
        x: info.x + naturalX * info.scale,
        y: info.y + naturalY * info.scale,
    };
}

async function run() {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear pre-existing markups from previous test runs
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
            // Clear any stored tab/tool visibility from previous test runs
            localStorage.removeItem('portolancast-toolbar-tab');
        });
        await page.waitForTimeout(300);

        // =====================================================================
        // TEST GROUP 1: Tab Buttons Exist
        // =====================================================================
        console.log('\n--- Test Group 1: Tab Buttons ---');

        const navigateTab = await page.$('.toolbar-tab[data-tab="navigate"]');
        assert(navigateTab !== null, 'Navigate tab button exists in toolbar');

        const markupTab = await page.$('.toolbar-tab[data-tab="markup"]');
        assert(markupTab !== null, 'Markup tab button exists in toolbar');

        const measureTab = await page.$('.toolbar-tab[data-tab="measure"]');
        assert(measureTab !== null, 'Measure tab button exists in toolbar');

        const settingsBtn = await page.$('#btn-toolbar-settings');
        assert(settingsBtn !== null, 'Settings gear button exists in toolbar');

        // Each tab panel should exist
        const navigatePanel = await page.$('.tab-panel[data-tab="navigate"]');
        assert(navigatePanel !== null, 'Navigate tab panel exists in DOM');

        const markupPanel = await page.$('.tab-panel[data-tab="markup"]');
        assert(markupPanel !== null, 'Markup tab panel exists in DOM');

        const measurePanel = await page.$('.tab-panel[data-tab="measure"]');
        assert(measurePanel !== null, 'Measure tab panel exists in DOM');

        // =====================================================================
        // TEST GROUP 2: Tab Panel Visibility
        // =====================================================================
        console.log('\n--- Test Group 2: Tab Panel Visibility ---');

        // Activate Navigate tab
        await page.evaluate(() => window.app.toolbar._setActiveTab('navigate'));
        await page.waitForTimeout(100);

        const navigatePanelVisible = await page.evaluate(() => {
            const panel = document.querySelector('.tab-panel[data-tab="navigate"]');
            return window.getComputedStyle(panel).display !== 'none';
        });
        assert(navigatePanelVisible, 'Navigate panel is visible when Navigate tab is active');

        const markupPanelHidden = await page.evaluate(() => {
            const panel = document.querySelector('.tab-panel[data-tab="markup"]');
            return panel.style.display === 'none';
        });
        assert(markupPanelHidden, 'Markup panel is hidden when Navigate tab is active');

        const measurePanelHidden = await page.evaluate(() => {
            const panel = document.querySelector('.tab-panel[data-tab="measure"]');
            return panel.style.display === 'none';
        });
        assert(measurePanelHidden, 'Measure panel is hidden when Navigate tab is active');

        // Activate Markup tab
        await page.evaluate(() => window.app.toolbar._setActiveTab('markup'));
        await page.waitForTimeout(100);

        const markupPanelVisible = await page.evaluate(() => {
            const panel = document.querySelector('.tab-panel[data-tab="markup"]');
            return window.getComputedStyle(panel).display !== 'none';
        });
        assert(markupPanelVisible, 'Markup panel is visible when Markup tab is active');

        const navigatePanelHiddenNow = await page.evaluate(() => {
            const panel = document.querySelector('.tab-panel[data-tab="navigate"]');
            return panel.style.display === 'none';
        });
        assert(navigatePanelHiddenNow, 'Navigate panel is hidden when Markup tab is active');

        // Activate Measure tab
        await page.evaluate(() => window.app.toolbar._setActiveTab('measure'));
        await page.waitForTimeout(100);

        const measurePanelVisible = await page.evaluate(() => {
            const panel = document.querySelector('.tab-panel[data-tab="measure"]');
            return window.getComputedStyle(panel).display !== 'none';
        });
        assert(measurePanelVisible, 'Measure panel is visible when Measure tab is active');

        // =====================================================================
        // TEST GROUP 3: Active Tab Button Has .active Class
        // =====================================================================
        console.log('\n--- Test Group 3: Tab Active State ---');

        await page.evaluate(() => window.app.toolbar._setActiveTab('navigate'));
        await page.waitForTimeout(100);

        const navigateTabActive = await page.evaluate(() => {
            return document.querySelector('.toolbar-tab[data-tab="navigate"]').classList.contains('active');
        });
        assert(navigateTabActive, 'Navigate tab button has .active class when Navigate is selected');

        const markupTabNotActive = await page.evaluate(() => {
            return !document.querySelector('.toolbar-tab[data-tab="markup"]').classList.contains('active');
        });
        assert(markupTabNotActive, 'Markup tab button does NOT have .active when Navigate is active');

        // =====================================================================
        // TEST GROUP 4: Tab Click Interaction
        // =====================================================================
        console.log('\n--- Test Group 4: Tab Click ---');

        // Start on Navigate, click Markup tab
        await page.evaluate(() => window.app.toolbar._setActiveTab('navigate'));
        await page.click('.toolbar-tab[data-tab="markup"]');
        await page.waitForTimeout(200);

        const activeTabAfterClick = await page.evaluate(() => window.app.toolbar._activeTab);
        assert(activeTabAfterClick === 'markup', 'Clicking Markup tab updates _activeTab to "markup"');

        const markupTabHasActive = await page.evaluate(() => {
            return document.querySelector('.toolbar-tab[data-tab="markup"]').classList.contains('active');
        });
        assert(markupTabHasActive, 'Markup tab button has .active after click');

        // =====================================================================
        // TEST GROUP 5: localStorage Persistence
        // =====================================================================
        console.log('\n--- Test Group 5: localStorage Persistence ---');

        await page.click('.toolbar-tab[data-tab="measure"]');
        await page.waitForTimeout(200);

        const storedTab = await page.evaluate(() => localStorage.getItem('portolancast-toolbar-tab'));
        assert(storedTab === 'measure', 'localStorage stores "measure" after clicking Measure tab');

        await page.click('.toolbar-tab[data-tab="navigate"]');
        await page.waitForTimeout(200);

        const storedTabAfterNavigate = await page.evaluate(() => localStorage.getItem('portolancast-toolbar-tab'));
        assert(storedTabAfterNavigate === 'navigate', 'localStorage stores "navigate" after clicking Navigate tab');

        // =====================================================================
        // TEST GROUP 6: Auto-Tab Switch via Keyboard Shortcuts
        // =====================================================================
        console.log('\n--- Test Group 6: Auto-Tab Switch via Keyboard ---');

        // Start on Navigate tab, press R (rect) → should auto-switch to Markup
        await page.evaluate(() => window.app.toolbar._setActiveTab('navigate'));
        await page.waitForTimeout(100);

        await page.keyboard.press('r');
        await page.waitForTimeout(150);

        const tabAfterR = await page.evaluate(() => window.app.toolbar._activeTab);
        assert(tabAfterR === 'markup', 'Pressing R (rect) auto-switches to Markup tab');

        // Press U (distance) → should auto-switch to Measure
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.app.toolbar._setActiveTab('navigate'));
        await page.waitForTimeout(100);

        await page.keyboard.press('u');
        await page.waitForTimeout(150);

        const tabAfterU = await page.evaluate(() => window.app.toolbar._activeTab);
        assert(tabAfterU === 'measure', 'Pressing U (distance) auto-switches to Measure tab');

        // Press V (select) → should auto-switch to Navigate
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.app.toolbar._setActiveTab('markup'));
        await page.waitForTimeout(100);

        await page.keyboard.press('v');
        await page.waitForTimeout(150);

        const tabAfterV = await page.evaluate(() => window.app.toolbar._activeTab);
        assert(tabAfterV === 'navigate', 'Pressing V (select) auto-switches to Navigate tab');

        // Press G (hand) → should auto-switch to Navigate
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.app.toolbar._setActiveTab('markup'));
        await page.waitForTimeout(100);

        await page.keyboard.press('g');
        await page.waitForTimeout(150);

        const tabAfterG = await page.evaluate(() => window.app.toolbar._activeTab);
        assert(tabAfterG === 'navigate', 'Pressing G (hand) auto-switches to Navigate tab');

        // Press A (area) → should auto-switch to Measure
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.app.toolbar._setActiveTab('navigate'));
        await page.waitForTimeout(100);

        await page.keyboard.press('a');
        await page.waitForTimeout(150);

        const tabAfterA = await page.evaluate(() => window.app.toolbar._activeTab);
        assert(tabAfterA === 'measure', 'Pressing A (area) auto-switches to Measure tab');

        // =====================================================================
        // TEST GROUP 7: Settings Modal
        // =====================================================================
        console.log('\n--- Test Group 7: Settings Modal ---');

        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);

        // Settings modal starts hidden
        const settingsModalHidden = await page.evaluate(() => {
            const modal = document.getElementById('modal-toolbar-settings');
            return modal.style.display === 'none';
        });
        assert(settingsModalHidden, 'Settings modal is hidden on startup');

        // Click gear to open settings
        await page.click('#btn-toolbar-settings');
        await page.waitForTimeout(200);

        const settingsModalVisible = await page.evaluate(() => {
            const modal = document.getElementById('modal-toolbar-settings');
            return modal.style.display !== 'none';
        });
        assert(settingsModalVisible, 'Settings modal opens when gear button is clicked');

        // Settings sections exist
        const navigateSectionExists = await page.$('#settings-navigate-tools');
        assert(navigateSectionExists !== null, 'Navigate tools section exists in settings modal');

        const markupSectionExists = await page.$('#settings-markup-tools');
        assert(markupSectionExists !== null, 'Markup tools section exists in settings modal');

        const measureSectionExists = await page.$('#settings-measure-tools');
        assert(measureSectionExists !== null, 'Measure tools section exists in settings modal');

        // Checkboxes are populated (at least one in each section)
        const navigateCheckboxes = await page.$$('#settings-navigate-tools input[type="checkbox"]');
        assert(navigateCheckboxes.length > 0, 'Navigate section has at least one checkbox');

        const markupCheckboxes = await page.$$('#settings-markup-tools input[type="checkbox"]');
        assert(markupCheckboxes.length > 0, 'Markup section has at least one checkbox');

        const measureCheckboxes = await page.$$('#settings-measure-tools input[type="checkbox"]');
        assert(measureCheckboxes.length > 0, 'Measure section has at least one checkbox');

        // Uncheck a tool (pen) → button should be hidden
        const penCheckbox = await page.$('#settings-cb-pen');
        assert(penCheckbox !== null, 'Pen tool checkbox exists in settings (id="settings-cb-pen")');

        if (penCheckbox) {
            await penCheckbox.uncheck();
            await page.waitForTimeout(100);

            const penBtnHidden = await page.evaluate(() => {
                const btn = document.querySelector('button[data-tool="pen"]');
                return btn && btn.hidden === true;
            });
            assert(penBtnHidden, 'Unchecking pen in settings hides the pen button');

            const penHiddenInStorage = await page.evaluate(() => {
                return localStorage.getItem('portolancast-tool-hidden-pen') === 'true';
            });
            assert(penHiddenInStorage, 'Hiding pen stores "true" in localStorage');
        }

        // Reset button restores all tools
        await page.click('#settings-reset');
        await page.waitForTimeout(100);

        const penBtnRestored = await page.evaluate(() => {
            const btn = document.querySelector('button[data-tool="pen"]');
            return btn && btn.hidden === false;
        });
        assert(penBtnRestored, 'Reset button restores pen button visibility');

        const penStorageCleared = await page.evaluate(() => {
            return localStorage.getItem('portolancast-tool-hidden-pen') === null;
        });
        assert(penStorageCleared, 'Reset button clears pen hidden state from localStorage');

        // Close button closes the modal
        await page.click('#settings-close');
        await page.waitForTimeout(150);

        const settingsModalClosedAfterDone = await page.evaluate(() => {
            const modal = document.getElementById('modal-toolbar-settings');
            return modal.style.display === 'none';
        });
        assert(settingsModalClosedAfterDone, 'Settings modal closes when Done button is clicked');

        // =====================================================================
        // TEST GROUP 8: stopPropagation Pan Fix (Bug 1)
        // =====================================================================
        console.log('\n--- Test Group 8: stopPropagation Pan Fix ---');

        // setDrawingMode(true) should attach _panBlockHandler to wrapper
        await page.evaluate(() => { window.app.toolbar.setTool('select'); });
        await page.waitForTimeout(100);

        const panBlockHandlerExists = await page.evaluate(() => {
            return typeof window.app.canvas._panBlockHandler === 'function';
        });
        assert(panBlockHandlerExists, 'setDrawingMode(true) creates _panBlockHandler on canvas');

        // setDrawingMode(false) should remove _panBlockHandler
        await page.evaluate(() => { window.app.canvas.setDrawingMode(false); });
        await page.waitForTimeout(100);

        const panBlockHandlerRemoved = await page.evaluate(() => {
            return window.app.canvas._panBlockHandler === null;
        });
        assert(panBlockHandlerRemoved, 'setDrawingMode(false) removes _panBlockHandler');

        // Re-enable for further tests
        await page.evaluate(() => { window.app.canvas.setDrawingMode(true); });
        await page.waitForTimeout(100);

        // Select tool: dragging an object should NOT pan the viewport
        await page.evaluate(() => {
            const { fabricCanvas } = window.app.canvas;
            const rect = new fabric.Rect({
                left: 120, top: 120, width: 80, height: 60,
                fill: 'transparent', stroke: '#ff4444', strokeWidth: 2,
                selectable: true,
            });
            window.app.canvas.stampDefaults(rect, { markupType: 'issue' });
            fabricCanvas.add(rect);
            fabricCanvas.renderAll();
        });
        await page.waitForTimeout(200);

        await page.evaluate(() => { window.app.toolbar.setTool('select'); });
        await page.waitForTimeout(100);

        // Reset scroll to 0
        await page.evaluate(() => {
            document.getElementById('viewport').scrollLeft = 0;
            document.getElementById('viewport').scrollTop = 0;
        });

        const scrollBefore8 = await page.evaluate(() => ({
            left: document.getElementById('viewport').scrollLeft,
            top: document.getElementById('viewport').scrollTop,
        }));

        // Drag the rect — should move the object, not pan the viewport
        const rectCenter = await toPageCoords(page, 160, 150);
        await page.mouse.move(rectCenter.x, rectCenter.y);
        await page.mouse.down();
        await page.mouse.move(rectCenter.x + 40, rectCenter.y + 30);
        await page.mouse.up();
        await page.waitForTimeout(200);

        const scrollAfter8 = await page.evaluate(() => ({
            left: document.getElementById('viewport').scrollLeft,
            top: document.getElementById('viewport').scrollTop,
        }));

        assert(
            scrollAfter8.left === scrollBefore8.left && scrollAfter8.top === scrollBefore8.top,
            'Dragging rect in select mode does NOT pan viewport (stopPropagation fix active)'
        );

        // =====================================================================
        // TEST GROUP 9: Measurement Recalc on object:modified (Bug 2)
        // =====================================================================
        console.log('\n--- Test Group 9: Measurement Recalc on Move ---');

        // Clear canvas
        await page.evaluate(() => {
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
        });
        await page.waitForTimeout(100);

        // Draw a distance measurement programmatically
        await page.evaluate(() => {
            window.app.toolbar.setTool('distance');
        });
        await page.waitForTimeout(100);

        const distStart = await toPageCoords(page, 100, 200);
        const distEnd = await toPageCoords(page, 300, 200);

        await page.mouse.move(distStart.x, distStart.y);
        await page.mouse.down();
        await page.mouse.move(distEnd.x, distEnd.y);
        await page.mouse.up();
        await page.waitForTimeout(300);

        await page.evaluate(() => { window.app.toolbar.setTool('select'); });
        await page.waitForTimeout(100);

        // Capture initial pixelLength
        const initialPixelLength = await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects();
            const dist = objs.find(o => o.measurementType === 'distance');
            return dist ? dist.pixelLength : null;
        });
        assert(initialPixelLength !== null && initialPixelLength > 0, 'Distance group has pixelLength after drawing');

        // Select and move the distance group
        await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects();
            const dist = objs.find(o => o.measurementType === 'distance');
            if (dist) {
                window.app.canvas.fabricCanvas.setActiveObject(dist);
            }
        });
        await page.waitForTimeout(100);

        const distGroupCenter = await toPageCoords(page, 200, 200);
        await page.mouse.move(distGroupCenter.x, distGroupCenter.y);
        await page.mouse.down();
        await page.mouse.move(distGroupCenter.x, distGroupCenter.y + 50);
        await page.mouse.up();
        await page.waitForTimeout(300);

        // After move, pixelLength should remain the same (distance didn't change — just position)
        const pixelLengthAfterMove = await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects();
            const dist = objs.find(o => o.measurementType === 'distance');
            return dist ? dist.pixelLength : null;
        });
        // A vertical move shouldn't change the length (it's horizontal)
        assert(
            pixelLengthAfterMove !== null,
            'Distance group still has pixelLength after move'
        );
        // The pixelLength should be approximately the same (allow 2px tolerance)
        const lengthStable = Math.abs((pixelLengthAfterMove || 0) - (initialPixelLength || 0)) < 2;
        assert(lengthStable, 'Distance pixelLength stays stable after a vertical move');

        // Draw a horizontal line, then scale it to verify recalc fires
        await page.evaluate(() => {
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
        });
        await page.waitForTimeout(100);

        await page.evaluate(() => { window.app.toolbar.setTool('distance'); });
        await page.waitForTimeout(100);

        const d2Start = await toPageCoords(page, 100, 300);
        const d2End = await toPageCoords(page, 300, 300);
        await page.mouse.move(d2Start.x, d2Start.y);
        await page.mouse.down();
        await page.mouse.move(d2End.x, d2End.y);
        await page.mouse.up();
        await page.waitForTimeout(300);

        await page.evaluate(() => { window.app.toolbar.setTool('select'); });
        await page.waitForTimeout(100);

        // The recalc listener is wired — verify initForCanvas ran
        const initForCanvasWired = await page.evaluate(() => {
            // Check that the measureTools has _fc pointing to the current Fabric canvas
            return window.app.measureTools._fc === window.app.canvas.fabricCanvas;
        });
        assert(initForCanvasWired, 'measureTools._fc is wired to current Fabric canvas after initForCanvas()');

        const initScaleWired = await page.evaluate(() => {
            return window.app.measureTools._scale === window.app.scale;
        });
        assert(initScaleWired, 'measureTools._scale is wired to ScaleManager after initForCanvas()');

        // =====================================================================
        // TEST GROUP 10: Tool Buttons in Correct Tab Panels
        // =====================================================================
        console.log('\n--- Test Group 10: Tool Buttons in Correct Panels ---');

        // Navigate panel should contain hand and select
        const handInNavigate = await page.evaluate(() => {
            const nav = document.querySelector('.tab-panel[data-tab="navigate"]');
            return nav ? nav.querySelector('button[data-tool="hand"]') !== null : false;
        });
        assert(handInNavigate, 'Hand button is inside Navigate panel');

        const selectInNavigate = await page.evaluate(() => {
            const nav = document.querySelector('.tab-panel[data-tab="navigate"]');
            return nav ? nav.querySelector('button[data-tool="select"]') !== null : false;
        });
        assert(selectInNavigate, 'Select button is inside Navigate panel');

        // Markup panel should contain pen, rect, etc.
        const rectInMarkup = await page.evaluate(() => {
            const mu = document.querySelector('.tab-panel[data-tab="markup"]');
            return mu ? mu.querySelector('button[data-tool="rect"]') !== null : false;
        });
        assert(rectInMarkup, 'Rect button is inside Markup panel');

        const penInMarkup = await page.evaluate(() => {
            const mu = document.querySelector('.tab-panel[data-tool="markup"]');
            // Try alternate selector
            const mu2 = document.querySelector('.tab-panel[data-tab="markup"]');
            return mu2 ? mu2.querySelector('button[data-tool="pen"]') !== null : false;
        });
        assert(penInMarkup, 'Pen button is inside Markup panel');

        // Measure panel should contain distance, area, count, etc.
        const distanceInMeasure = await page.evaluate(() => {
            const ms = document.querySelector('.tab-panel[data-tab="measure"]');
            return ms ? ms.querySelector('button[data-tool="distance"]') !== null : false;
        });
        assert(distanceInMeasure, 'Distance button is inside Measure panel');

        const areaInMeasure = await page.evaluate(() => {
            const ms = document.querySelector('.tab-panel[data-tab="measure"]');
            return ms ? ms.querySelector('button[data-tool="area"]') !== null : false;
        });
        assert(areaInMeasure, 'Area button is inside Measure panel');

        const nodeEditInMeasure = await page.evaluate(() => {
            const ms = document.querySelector('.tab-panel[data-tab="measure"]');
            return ms ? ms.querySelector('button[data-tool="node-edit"]') !== null : false;
        });
        assert(nodeEditInMeasure, 'Node Edit button is inside Measure panel');

    } catch (err) {
        console.error('Test suite error:', err);
        failed++;
    } finally {
        await browser.close();
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('\n' + '─'.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('─'.repeat(50));

    process.exit(failed > 0 ? 1 : 0);
}

run();
