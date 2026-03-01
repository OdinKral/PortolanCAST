/**
 * PortolanCAST — Properties Panel Browser Test
 *
 * Tests: panel visibility on select/deselect, property read/write,
 * metadata persistence through page change and save/load, color/width controls.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_properties.mjs"
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
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // =====================================================================
        // TEST GROUP 1: Panel initial state
        // =====================================================================
        console.log('\n--- Test Group 1: Initial State ---');

        const markupPropsVisible = await page.evaluate(() =>
            document.getElementById('markup-props').style.display
        );
        assert(markupPropsVisible === 'none', 'Markup props hidden initially');

        const docInfoVisible = await page.evaluate(() =>
            document.getElementById('doc-info').style.display
        );
        assert(docInfoVisible === 'block', 'Doc info visible when document loaded');

        // =====================================================================
        // TEST GROUP 2: Panel shows on selection
        // =====================================================================
        console.log('\n--- Test Group 2: Selection Shows Panel ---');

        // Create a rect with metadata and select it
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 100, top: 100, width: 200, height: 150,
                fill: 'transparent', stroke: '#ff0000', strokeWidth: 3,
            });
            window.app.canvas.stampDefaults(rect, { markupType: 'issue' });
            fc.add(rect);
            fc.setActiveObject(rect);
            // Fire selection event manually since setActiveObject may not trigger it
            fc.fire('selection:created', { selected: [rect] });
            fc.renderAll();
        });
        await page.waitForTimeout(100);

        const markupAfterSelect = await page.evaluate(() =>
            document.getElementById('markup-props').style.display
        );
        assert(markupAfterSelect === 'block', 'Markup props visible after selection');

        const docInfoAfterSelect = await page.evaluate(() =>
            document.getElementById('doc-info').style.display
        );
        assert(docInfoAfterSelect === 'none', 'Doc info hidden during selection');

        // =====================================================================
        // TEST GROUP 3: Panel reads object properties correctly
        // =====================================================================
        console.log('\n--- Test Group 3: Property Reading ---');

        const objType = await page.evaluate(() =>
            document.getElementById('prop-obj-type').textContent
        );
        assert(objType === 'Rectangle', `Object type shows "Rectangle" (got "${objType}")`)

        const typeVal = await page.evaluate(() =>
            document.getElementById('prop-markup-type').value
        );
        assert(typeVal === 'issue', `Markup type reads "issue" (got "${typeVal}")`);

        const statusVal = await page.evaluate(() =>
            document.getElementById('prop-markup-status').value
        );
        assert(statusVal === 'open', `Status reads "open" (got "${statusVal}")`);

        const noteVal = await page.evaluate(() =>
            document.getElementById('prop-markup-note').value
        );
        assert(noteVal === '', 'Note starts empty');

        const strokeColor = await page.evaluate(() =>
            document.getElementById('prop-stroke-color').value
        );
        assert(strokeColor === '#ff4444', `Stroke color reads #ff4444 for issue type (got "${strokeColor}")`);

        const strokeWidth = await page.evaluate(() =>
            document.getElementById('prop-stroke-width').value
        );
        assert(strokeWidth === '3', `Stroke width reads 3 (got "${strokeWidth}")`);

        // =====================================================================
        // TEST GROUP 4: Changing properties updates the object
        // =====================================================================
        console.log('\n--- Test Group 4: Property Writing ---');

        // Change markup type to 'question'
        await page.evaluate(() => {
            const sel = document.getElementById('prop-markup-type');
            sel.value = 'question';
            sel.dispatchEvent(new Event('change'));
        });
        const newType = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getActiveObject();
            return obj ? obj.markupType : null;
        });
        assert(newType === 'question', `Changing dropdown updates object markupType to "question"`);

        // Change status to 'resolved'
        await page.evaluate(() => {
            const sel = document.getElementById('prop-markup-status');
            sel.value = 'resolved';
            sel.dispatchEvent(new Event('change'));
        });
        const newStatus = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getActiveObject();
            return obj ? obj.markupStatus : null;
        });
        assert(newStatus === 'resolved', `Changing dropdown updates object markupStatus to "resolved"`);

        // Type a note
        await page.evaluate(() => {
            const ta = document.getElementById('prop-markup-note');
            ta.value = 'Check dimension on this wall';
            ta.dispatchEvent(new Event('input'));
        });
        const newNote = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getActiveObject();
            return obj ? obj.markupNote : null;
        });
        assert(newNote === 'Check dimension on this wall', 'Note textarea updates object markupNote');

        // Change stroke color
        await page.evaluate(() => {
            const input = document.getElementById('prop-stroke-color');
            input.value = '#00ff00';
            input.dispatchEvent(new Event('input'));
        });
        const newStroke = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getActiveObject();
            return obj ? obj.stroke : null;
        });
        assert(newStroke === '#00ff00', `Color picker updates stroke to #00ff00`);

        // Change stroke width
        await page.evaluate(() => {
            const input = document.getElementById('prop-stroke-width');
            input.value = '5';
            input.dispatchEvent(new Event('input'));
        });
        const newWidth = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getActiveObject();
            return obj ? obj.strokeWidth : null;
        });
        assert(newWidth === 5, `Slider updates strokeWidth to 5`);

        const widthLabel = await page.evaluate(() =>
            document.getElementById('prop-stroke-width-val').textContent
        );
        assert(widthLabel === '5', 'Width label updates to "5"');

        // =====================================================================
        // TEST GROUP 5: Deselection hides panel
        // =====================================================================
        console.log('\n--- Test Group 5: Deselection ---');

        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            fc.discardActiveObject();
            fc.fire('selection:cleared');
            fc.renderAll();
        });
        await page.waitForTimeout(100);

        const markupAfterDeselect = await page.evaluate(() =>
            document.getElementById('markup-props').style.display
        );
        assert(markupAfterDeselect === 'none', 'Markup props hidden after deselection');

        const docInfoAfterDeselect = await page.evaluate(() =>
            document.getElementById('doc-info').style.display
        );
        assert(docInfoAfterDeselect === 'block', 'Doc info restored after deselection');

        // =====================================================================
        // TEST GROUP 6: Modified metadata survives toJSON serialization
        // =====================================================================
        console.log('\n--- Test Group 6: Serialization of Edited Properties ---');

        const json = await page.evaluate(() => window.app.canvas.toJSON());
        const editedObj = json.objects.find(o => o.markupType === 'question');
        assert(editedObj !== undefined, 'Edited markupType=question found in JSON');
        assert(editedObj && editedObj.markupStatus === 'resolved', 'Edited status=resolved in JSON');
        assert(editedObj && editedObj.markupNote === 'Check dimension on this wall', 'Edited note in JSON');

        // =====================================================================
        // TEST GROUP 7: Metadata survives page change round-trip
        // =====================================================================
        console.log('\n--- Test Group 7: Page Change Preserves Edits ---');

        // Go to page 2 and back
        await page.evaluate(() => window.app.viewer.goToPage(1));
        await page.waitForTimeout(500);
        await page.evaluate(() => window.app.viewer.goToPage(0));
        await page.waitForTimeout(500);

        const rtJson = await page.evaluate(() => window.app.canvas.toJSON());
        const rtObj = rtJson.objects.find(o => o.markupType === 'question');
        assert(rtObj !== undefined, 'markupType=question survives page round-trip');
        assert(rtObj && rtObj.markupStatus === 'resolved', 'status=resolved survives page round-trip');
        assert(rtObj && rtObj.markupNote === 'Check dimension on this wall', 'note survives page round-trip');

        // =====================================================================
        // TEST GROUP 8: Selecting different objects updates panel
        // =====================================================================
        console.log('\n--- Test Group 8: Multi-Object Selection ---');

        // Add a second shape with different metadata
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const ellipse = new fabric.Ellipse({
                left: 400, top: 200, rx: 60, ry: 40,
                fill: 'transparent', stroke: '#0000ff', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(ellipse, { markupType: 'approval' });
            ellipse.markupNote = 'Approved as-is';
            fc.add(ellipse);
            fc.setActiveObject(ellipse);
            fc.fire('selection:created', { selected: [ellipse] });
            fc.renderAll();
        });
        await page.waitForTimeout(100);

        const objType2 = await page.evaluate(() =>
            document.getElementById('prop-obj-type').textContent
        );
        assert(objType2 === 'Ellipse', `Second object shows "Ellipse" (got "${objType2}")`);

        const type2 = await page.evaluate(() =>
            document.getElementById('prop-markup-type').value
        );
        assert(type2 === 'approval', `Second object shows markupType=approval`);

        const note2 = await page.evaluate(() =>
            document.getElementById('prop-markup-note').value
        );
        assert(note2 === 'Approved as-is', `Second object shows note`);

        // Now select the first rect — panel should update
        // Use lowercase type for live object lookup (Fabric.js 6)
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = fc.getObjects().find(o =>
                o.type === 'rect' || o.type === 'Rect'
            );
            if (rect) {
                fc.setActiveObject(rect);
                fc.fire('selection:updated', { selected: [rect] });
                fc.renderAll();
            }
        });
        await page.waitForTimeout(100);

        const switchedType = await page.evaluate(() =>
            document.getElementById('prop-markup-type').value
        );
        assert(switchedType === 'question', 'Switching selection updates panel to first object');

        const switchedNote = await page.evaluate(() =>
            document.getElementById('prop-markup-note').value
        );
        assert(switchedNote === 'Check dimension on this wall', 'Note updates when switching selection');

        // =====================================================================
        // TEST GROUP 9: Dirty flag fires on property change
        // =====================================================================
        console.log('\n--- Test Group 9: Dirty Tracking ---');

        // Reset dirty flag
        await page.evaluate(() => { window.app._dirty = false; });

        // Change a property
        await page.evaluate(() => {
            const sel = document.getElementById('prop-markup-status');
            sel.value = 'open';
            sel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        const isDirty = await page.evaluate(() => window.app._dirty);
        assert(isDirty === true, 'Property change sets dirty flag');

    } catch (err) {
        console.error('Test error:', err);
        failed++;
    } finally {
        await browser.close();
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log(`${'='.repeat(50)}`);
    process.exit(failed > 0 ? 1 : 0);
}

run();
