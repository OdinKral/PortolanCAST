/**
 * PortolanCAST — Phase 2 Measurement Tools Browser Test
 *
 * Tests: distance ruler, area polygon, count markers, scale calibration.
 * 36+ tests organized by tool, verifying creation, metadata, properties panel,
 * markup list display, and calibration modal behavior.
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_phase2.mjs"
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-02-22
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

/**
 * Get the Fabric canvas element position on screen for coordinate conversion.
 * Returns { x, y, scale } where x,y is the canvas top-left in page coords.
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
 * Convert natural Fabric coordinates to page (mouse event) coordinates.
 * Needed because Playwright mouse events use page/screen coords.
 */
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
        });
        await page.waitForTimeout(300);

        // =====================================================================
        // TEST GROUP 1: Tool Buttons Exist
        // =====================================================================
        console.log('\n--- Test Group 1: Measurement Tool Buttons ---');

        const distBtn = await page.$('button[data-tool="distance"]');
        assert(distBtn !== null, 'Distance button exists in toolbar');

        const areaBtn = await page.$('button[data-tool="area"]');
        assert(areaBtn !== null, 'Area button exists in toolbar');

        const countBtn = await page.$('button[data-tool="count"]');
        assert(countBtn !== null, 'Count button exists in toolbar');

        const calibBtn = await page.$('button[data-tool="calibrate"]');
        assert(calibBtn !== null, 'Calibrate button exists in toolbar');

        // =====================================================================
        // TEST GROUP 2: Distance Tool
        // =====================================================================
        console.log('\n--- Test Group 2: Distance Tool ---');

        // Activate via keyboard shortcut U
        await page.keyboard.press('u');
        await page.waitForTimeout(100);
        let activeTool = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeTool === 'distance', 'U key activates distance tool');

        // Verify button is highlighted active
        let isActive = await page.$eval(
            'button[data-tool="distance"]',
            el => el.classList.contains('active')
        );
        assert(isActive, 'Distance button shows active state');

        // Draw a distance measurement via mouse drag
        // Use natural coords that will produce a clear line
        const startNat = { x: 100, y: 100 };
        const endNat   = { x: 400, y: 100 };  // horizontal line, 300px natural length

        const startPage = await toPageCoords(page, startNat.x, startNat.y);
        const endPage   = await toPageCoords(page, endNat.x, endNat.y);

        await page.mouse.move(startPage.x, startPage.y);
        await page.mouse.down();
        await page.mouse.move(endPage.x, endPage.y, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(300);

        // Check that a Group was created on canvas
        const distObj = await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects();
            return objs.find(o => o.measurementType === 'distance') || null;
        });
        assert(distObj !== null, 'Distance measurement creates object on canvas');

        // Check measurementType and pixelLength
        if (distObj) {
            const mType = await page.evaluate(() => {
                const obj = window.app.canvas.fabricCanvas.getObjects()
                    .find(o => o.measurementType === 'distance');
                return obj ? obj.measurementType : null;
            });
            assert(mType === 'distance', 'Distance object has measurementType="distance"');

            const pLen = await page.evaluate(() => {
                const obj = window.app.canvas.fabricCanvas.getObjects()
                    .find(o => o.measurementType === 'distance');
                return obj ? obj.pixelLength : null;
            });
            assert(pLen !== null && pLen > 0, 'Distance object has pixelLength > 0');

            // For a horizontal 300px line at fit-to-width zoom, length should be ~300px
            // (allow ±50px tolerance for zoom and event precision)
            assert(pLen > 200 && pLen < 450, `pixelLength reasonable (${pLen?.toFixed(1)} px)`);
        }

        // Check labelText is set
        const labelText = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()
                .find(o => o.measurementType === 'distance');
            return obj ? obj.labelText : null;
        });
        assert(typeof labelText === 'string' && labelText.length > 0, 'Distance has labelText baked at creation');

        // Check markupTimestamp set (provenance)
        const hasTimestamp = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()
                .find(o => o.measurementType === 'distance');
            return obj ? !!obj.markupTimestamp : false;
        });
        assert(hasTimestamp, 'Distance measurement has markupTimestamp');

        // Select the object and check properties panel
        await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()
                .find(o => o.measurementType === 'distance');
            if (obj) {
                window.app.canvas.fabricCanvas.setActiveObject(obj);
                window.app.canvas.fabricCanvas.renderAll();
            }
        });
        await page.waitForTimeout(200);

        // measurement-props should be visible
        const measurePropsVisible = await page.$eval(
            '#measurement-props',
            el => el.style.display !== 'none'
        );
        assert(measurePropsVisible, 'Measurement props panel shows when distance selected');

        // measure-value should have content
        const measureValueText = await page.$eval('#measure-value', el => el.textContent);
        assert(measureValueText && measureValueText !== '—', `Measurement value displayed: "${measureValueText}"`);

        // markup-semantic-props should be hidden (type/status/note not shown)
        const semanticHidden = await page.$eval(
            '#markup-semantic-props',
            el => el.style.display === 'none'
        );
        assert(semanticHidden, 'Semantic markup fields hidden for distance measurement');

        // =====================================================================
        // TEST GROUP 3: Distance persists across page navigation
        // =====================================================================
        console.log('\n--- Test Group 3: Distance Persistence ---');

        // Save current count of objects
        const objsBefore = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );

        // Undo removes the measurement
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(300);

        const objsAfterUndo = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );
        assert(objsAfterUndo < objsBefore, 'Ctrl+Z removes distance measurement');

        // Redo restores it
        await page.keyboard.press('Control+y');
        await page.waitForTimeout(300);

        const objsAfterRedo = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );
        assert(objsAfterRedo === objsBefore, 'Ctrl+Y restores distance measurement');

        // =====================================================================
        // TEST GROUP 4: Distance appears in Markup List
        // =====================================================================
        console.log('\n--- Test Group 4: Distance in Markup List ---');

        // Switch to Markups tab and refresh
        await page.click('button[data-panel="markups"]');
        await page.waitForTimeout(300);

        // Check for a row with type-distance class
        const distRow = await page.$('.markup-type-badge.type-distance');
        assert(distRow !== null, 'Distance measurement appears in markup list with type-distance badge');

        // =====================================================================
        // TEST GROUP 5: Clear canvas, test Area Tool
        // =====================================================================
        console.log('\n--- Test Group 5: Area Tool ---');

        // Clear canvas for area tests
        await page.evaluate(async () => {
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
        });
        await page.waitForTimeout(200);

        // Activate area tool via keyboard shortcut A
        await page.keyboard.press('a');
        await page.waitForTimeout(100);

        activeTool = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeTool === 'area', 'A key activates area tool');

        isActive = await page.$eval(
            'button[data-tool="area"]',
            el => el.classList.contains('active')
        );
        assert(isActive, 'Area button shows active state');

        // Draw a triangle: 3 clicks + double-click to close
        // Use a triangle in natural coords: (150, 80), (300, 250), (50, 250)
        const v1 = await toPageCoords(page, 150, 80);
        const v2 = await toPageCoords(page, 300, 250);
        const v3 = await toPageCoords(page, 50, 250);

        // Click vertices
        await page.mouse.click(v1.x, v1.y);
        await page.waitForTimeout(150);
        await page.mouse.click(v2.x, v2.y);
        await page.waitForTimeout(150);
        await page.mouse.click(v3.x, v3.y);
        await page.waitForTimeout(150);

        // Double-click at last vertex position to close
        await page.mouse.dblclick(v3.x + 5, v3.y + 5);
        await page.waitForTimeout(400);

        // Check for a Polygon with measurementType='area'
        const areaObj = await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects();
            return objs.find(o => o.measurementType === 'area') ? true : false;
        });
        assert(areaObj, 'Area tool creates an object with measurementType="area"');

        // Check pixelArea is set
        const pixelArea = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()
                .find(o => o.measurementType === 'area' && o.type === 'polygon');
            return obj ? obj.pixelArea : null;
        });
        assert(pixelArea !== null && pixelArea > 0, `Area polygon has pixelArea > 0 (${pixelArea?.toFixed(0)} sq px)`);

        // Check label was created (separate IText at centroid)
        const areaLabelCount = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects()
                .filter(o => o.measurementType === 'area').length
        );
        assert(areaLabelCount >= 2, `Area creates polygon + label (found ${areaLabelCount} area objects)`);

        // Select the polygon and check properties panel
        await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()
                .find(o => o.measurementType === 'area' && o.type === 'polygon');
            if (obj) {
                window.app.canvas.fabricCanvas.setActiveObject(obj);
                window.app.canvas.fabricCanvas.renderAll();
            }
        });
        await page.waitForTimeout(200);

        const areaPropsVisible = await page.$eval(
            '#measurement-props',
            el => el.style.display !== 'none'
        );
        assert(areaPropsVisible, 'Properties panel shows for area measurement');

        const areaValueText = await page.$eval('#measure-value', el => el.textContent);
        assert(areaValueText && areaValueText !== '—', `Area value displayed: "${areaValueText}"`);

        // Area badge in markup list
        await page.click('button[data-panel="markups"]');
        await page.waitForTimeout(300);

        const areaBadge = await page.$('.markup-type-badge.type-area');
        assert(areaBadge !== null, 'Area measurement appears in markup list with type-area badge');

        // =====================================================================
        // TEST GROUP 6: Count Tool
        // =====================================================================
        console.log('\n--- Test Group 6: Count Tool ---');

        // Clear canvas
        await page.evaluate(async () => {
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
        });
        await page.waitForTimeout(200);

        // Activate count tool via keyboard shortcut N
        await page.keyboard.press('n');
        await page.waitForTimeout(100);

        activeTool = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeTool === 'count', 'N key activates count tool');

        isActive = await page.$eval(
            'button[data-tool="count"]',
            el => el.classList.contains('active')
        );
        assert(isActive, 'Count button shows active state');

        // Place first count marker
        const p1 = await toPageCoords(page, 100, 100);
        await page.mouse.click(p1.x, p1.y);
        await page.waitForTimeout(200);

        const count1 = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().filter(o => o.measurementType === 'count').length
        );
        assert(count1 === 1, 'First click places count marker (#1)');

        const idx1 = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()
                .find(o => o.measurementType === 'count');
            return obj ? obj.countIndex : null;
        });
        assert(idx1 === 1, 'First count marker has countIndex=1');

        // Place second count marker
        const p2 = await toPageCoords(page, 200, 100);
        await page.mouse.click(p2.x, p2.y);
        await page.waitForTimeout(200);

        const count2 = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().filter(o => o.measurementType === 'count').length
        );
        assert(count2 === 2, 'Second click places count marker (#2)');

        const idx2 = await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects()
                .filter(o => o.measurementType === 'count');
            return objs.length >= 2 ? objs[1].countIndex : null;
        });
        assert(idx2 === 2, 'Second count marker has countIndex=2');

        // Select first marker and check properties panel
        await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()
                .find(o => o.measurementType === 'count');
            if (obj) {
                window.app.canvas.fabricCanvas.setActiveObject(obj);
                window.app.canvas.fabricCanvas.renderAll();
            }
        });
        await page.waitForTimeout(200);

        const countPropsVisible = await page.$eval(
            '#measurement-props',
            el => el.style.display !== 'none'
        );
        assert(countPropsVisible, 'Properties panel shows for count marker');

        const countValueText = await page.$eval('#measure-value', el => el.textContent);
        assert(countValueText.includes('#'), `Count value shows marker number: "${countValueText}"`);

        // Total count secondary row should be visible
        const secondaryVisible = await page.$eval(
            '#measure-secondary-row',
            el => el.style.display !== 'none'
        );
        assert(secondaryVisible, 'Secondary row shows total count for count tool');

        // Undo removes last count marker
        await page.keyboard.press('Escape');  // deselect
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(300);

        const countAfterUndo = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().filter(o => o.measurementType === 'count').length
        );
        assert(countAfterUndo < count2, 'Undo removes last count marker');

        // Count markers appear in markup list
        await page.click('button[data-panel="markups"]');
        await page.waitForTimeout(300);

        const countBadge = await page.$('.markup-type-badge.type-count');
        assert(countBadge !== null, 'Count markers appear in markup list with type-count badge');

        // =====================================================================
        // TEST GROUP 7: Calibration Tool
        // =====================================================================
        console.log('\n--- Test Group 7: Calibration Tool ---');

        // Clear canvas
        await page.evaluate(async () => {
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
        });
        await page.waitForTimeout(200);

        // Activate calibration via keyboard K
        await page.keyboard.press('k');
        await page.waitForTimeout(100);

        activeTool = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeTool === 'calibrate', 'K key activates calibrate tool');

        isActive = await page.$eval(
            'button[data-tool="calibrate"]',
            el => el.classList.contains('active')
        );
        assert(isActive, 'Calibrate button shows active state');

        // Draw a reference line (375px horizontal at natural coords — should be 10 ft at 1/4"=1')
        const calStart = await toPageCoords(page, 100, 200);
        const calEnd   = await toPageCoords(page, 475, 200);  // 375px natural

        await page.mouse.move(calStart.x, calStart.y);
        await page.mouse.down();
        await page.mouse.move(calEnd.x, calEnd.y, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(400);

        // Calibration modal should appear
        const modalVisible = await page.$eval(
            '#modal-calibrate',
            el => el.style.display !== 'none'
        );
        assert(modalVisible, 'Drawing reference line opens calibration modal');

        // Pixel length should be pre-filled
        const pixelsFilled = await page.$eval('#calib-pixels', el => parseFloat(el.value));
        assert(pixelsFilled > 0, `Calibration modal pre-fills pixel length: ${pixelsFilled?.toFixed(1)}`);

        // Enter real-world length: 10 feet
        await page.fill('#calib-value', '10');
        await page.selectOption('#calib-unit', 'ft');

        // Click Apply Scale
        await page.click('#calib-apply');

        // Wait for modal to close and scale state to update
        await page.waitForFunction(() => {
            const modal = document.getElementById('modal-calibrate');
            return modal && modal.style.display === 'none';
        }, { timeout: 5000 });

        // Modal should close
        const modalClosed = await page.$eval(
            '#modal-calibrate',
            el => el.style.display === 'none'
        );
        assert(modalClosed, 'Calibration modal closes after Apply');

        // Wait for scale preset to propagate to JS state and DOM
        await page.waitForFunction(() => {
            return window.app?.scale?.preset === 'custom'
                && document.getElementById('scale-label')?.textContent === 'Custom';
        }, { timeout: 5000 }).catch(() => {});

        // Scale preset should be 'custom'
        const scalePreset = await page.evaluate(() => window.app.scale.preset);
        assert(scalePreset === 'custom', 'Scale preset set to "custom" after calibration');

        // Scale display in status bar should show "Custom"
        const scaleLabelText = await page.$eval('#scale-label', el => el.textContent);
        assert(scaleLabelText === 'Custom', `Status bar shows "Custom" scale: "${scaleLabelText}"`);

        // Verify the scale unit is 'ft'
        const scaleUnit = await page.evaluate(() => window.app.scale.unitLabel);
        assert(scaleUnit === 'ft', `Calibration sets unit to 'ft': "${scaleUnit}"`);

        // Verify pixelsPerRealUnit was computed correctly
        // 375px line / 10 ft = 37.5 px/ft; paperInchesPerFoot = 37.5/150 = 0.25
        const pxPerUnit = await page.evaluate(() => window.app.scale.pixelsPerRealUnit);
        assert(pxPerUnit > 0, `pixelsPerRealUnit is positive: ${pxPerUnit?.toFixed(2)}`);

        // The calibrated scale should give ~10 ft for the 375px reference line
        const computed = await page.evaluate(() => {
            return window.app.scale.convertPixels(375);
        });
        assert(Math.abs(computed - 10) < 1.5, `Calibrated scale: 375px ≈ 10 ft (got ${computed?.toFixed(2)} ft)`);

        // =====================================================================
        // TEST GROUP 8: Scale Integration — Distance uses calibrated scale
        // =====================================================================
        console.log('\n--- Test Group 8: Scale Integration ---');

        // Set scale back to arch_1_4 (1/4"=1') for predictable test values
        await page.evaluate(async () => {
            await window.app.scale.setPreset('arch_1_4');
        });
        await page.waitForTimeout(300);

        // Activate distance tool and draw 375px line
        await page.keyboard.press('u');
        await page.waitForTimeout(100);

        const d2Start = await toPageCoords(page, 50, 300);
        const d2End   = await toPageCoords(page, 425, 300);  // ~375px

        await page.mouse.move(d2Start.x, d2Start.y);
        await page.mouse.down();
        await page.mouse.move(d2End.x, d2End.y, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(300);

        // The label should contain "ft" (since arch_1_4 uses feet)
        const ftLabel = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()
                .find(o => o.measurementType === 'distance');
            return obj ? obj.labelText : '';
        });
        assert(ftLabel.includes('ft'), `Distance label shows "ft" unit at 1/4"=1' scale: "${ftLabel}"`);

        // =====================================================================
        // SUMMARY
        // =====================================================================
        console.log('\n');
        console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

    } catch (err) {
        console.error('[TEST CRASH]', err.message);
        failed++;
        console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    } finally {
        await browser.close();
    }
}

run().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
});
