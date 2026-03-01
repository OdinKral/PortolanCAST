/**
 * PortolanCAST — Shape Tools Browser Test
 *
 * Tests: shape tool buttons, interactive drawing, markupType metadata,
 * serialization/deserialization, undo/redo with shapes, zoom stability.
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_shapes.mjs"
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
        // Load the editor with a document
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        // Wait for canvas to initialize (image load + Fabric init)
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
        await page.waitForTimeout(200);

        // =====================================================================
        // TEST GROUP 1: Shape tool buttons exist
        // =====================================================================
        console.log('\n--- Test Group 1: Shape Tool Buttons ---');

        const rectBtn = await page.$('button[data-tool="rect"]');
        assert(rectBtn !== null, 'Rectangle button exists');

        const ellipseBtn = await page.$('button[data-tool="ellipse"]');
        assert(ellipseBtn !== null, 'Ellipse button exists');

        const lineBtn = await page.$('button[data-tool="line"]');
        assert(lineBtn !== null, 'Line button exists');

        const selectBtn = await page.$('button[data-tool="select"]');
        assert(selectBtn !== null, 'Select button exists');

        const penBtn = await page.$('button[data-tool="pen"]');
        assert(penBtn !== null, 'Pen button exists');

        // =====================================================================
        // TEST GROUP 2: Tool activation via click
        // =====================================================================
        console.log('\n--- Test Group 2: Tool Activation ---');

        // Switch to Markup tab first — markup tool buttons live in that panel.
        // Phase 3B introduced mode tabs; buttons are hidden when their panel is inactive.
        await page.evaluate(() => window.app.toolbar._setActiveTab('markup'));
        await page.waitForTimeout(100);

        // Click rect button
        await rectBtn.click();
        let activeToolName = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeToolName === 'rect', 'Clicking rect button activates rect tool');

        let rectActive = await page.evaluate(() =>
            document.querySelector('[data-tool="rect"]').classList.contains('active')
        );
        assert(rectActive, 'Rect button has active class');

        // Click ellipse button
        await ellipseBtn.click();
        activeToolName = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeToolName === 'ellipse', 'Clicking ellipse button activates ellipse tool');

        // Click line button
        await lineBtn.click();
        activeToolName = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeToolName === 'line', 'Clicking line button activates line tool');

        // Toggle off: click active tool again
        await lineBtn.click();
        activeToolName = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeToolName === null, 'Clicking active tool toggles it off');

        // =====================================================================
        // TEST GROUP 3: Keyboard shortcuts
        // =====================================================================
        console.log('\n--- Test Group 3: Keyboard Shortcuts ---');

        await page.keyboard.press('r');
        activeToolName = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeToolName === 'rect', 'R key activates rect tool');

        await page.keyboard.press('e');
        activeToolName = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeToolName === 'ellipse', 'E key activates ellipse tool');

        await page.keyboard.press('l');
        activeToolName = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeToolName === 'line', 'L key activates line tool');

        await page.keyboard.press('Escape');
        activeToolName = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(activeToolName === null, 'Escape deactivates tool');

        // =====================================================================
        // TEST GROUP 4: Programmatic shape creation with markupType
        // =====================================================================
        console.log('\n--- Test Group 4: Shape Creation with Metadata ---');

        // Create shapes programmatically (more reliable than mouse events in headless)
        const rectCreated = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 100, top: 100, width: 200, height: 150,
                fill: 'transparent', stroke: '#ff0000', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(rect);
            fc.add(rect);
            fc.renderAll();
            return {
                type: rect.type,
                markupType: rect.markupType,
                markupStatus: rect.markupStatus,
                markupNote: rect.markupNote,
            };
        });
        assert(rectCreated.type === 'Rect' || rectCreated.type === 'rect', 'Rect created on canvas');
        assert(rectCreated.markupType === 'note', 'Rect has markupType=note');
        assert(rectCreated.markupStatus === 'open', 'Rect has markupStatus=open');
        assert(rectCreated.markupNote === '', 'Rect has empty markupNote');

        const ellipseCreated = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const ellipse = new fabric.Ellipse({
                left: 350, top: 100, rx: 80, ry: 50,
                fill: 'transparent', stroke: '#ff0000', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(ellipse, { markupType: 'issue' });
            fc.add(ellipse);
            fc.renderAll();
            return {
                type: ellipse.type,
                markupType: ellipse.markupType,
                markupStatus: ellipse.markupStatus,
            };
        });
        assert(ellipseCreated.type === 'Ellipse' || ellipseCreated.type === 'ellipse', 'Ellipse created on canvas');
        assert(ellipseCreated.markupType === 'issue', 'Ellipse has markupType=issue (override)');

        const lineCreated = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const line = new fabric.Line([100, 300, 400, 350], {
                stroke: '#ff0000', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(line);
            fc.add(line);
            fc.renderAll();
            return {
                type: line.type,
                markupType: line.markupType,
            };
        });
        assert(lineCreated.type === 'Line' || lineCreated.type === 'line', 'Line created on canvas');
        assert(lineCreated.markupType === 'note', 'Line has markupType=note');

        // =====================================================================
        // TEST GROUP 5: Custom properties survive toJSON serialization
        // =====================================================================
        console.log('\n--- Test Group 5: Serialization ---');

        const jsonData = await page.evaluate(() => {
            return window.app.canvas.toJSON();
        });
        assert(jsonData.objects.length === 3, `toJSON has 3 objects (got ${jsonData.objects.length})`);

        // Check that custom properties are in the serialized JSON
        const rectJson = jsonData.objects.find(o => o.type === 'Rect');
        assert(rectJson && rectJson.markupType === 'note', 'Rect markupType survives toJSON');
        assert(rectJson && rectJson.markupStatus === 'open', 'Rect markupStatus survives toJSON');

        const ellipseJson = jsonData.objects.find(o => o.type === 'Ellipse');
        assert(ellipseJson && ellipseJson.markupType === 'issue', 'Ellipse markupType=issue survives toJSON');

        const lineJson = jsonData.objects.find(o => o.type === 'Line');
        assert(lineJson && lineJson.markupType === 'note', 'Line markupType survives toJSON');

        // =====================================================================
        // TEST GROUP 6: Custom properties survive page change round-trip
        // =====================================================================
        console.log('\n--- Test Group 6: Page Change Round-Trip ---');

        // Navigate to page 2 then back to page 1
        const objectCountBefore = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );

        await page.evaluate(() => window.app.viewer.goToPage(1));
        await page.waitForTimeout(500);

        const objectsOnPage2 = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );
        assert(objectsOnPage2 === 0, 'Page 2 starts with 0 objects');

        // Go back to page 1
        await page.evaluate(() => window.app.viewer.goToPage(0));
        await page.waitForTimeout(500);

        const objectCountAfter = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );
        assert(objectCountAfter === objectCountBefore, `Page 1 restored ${objectCountAfter}/${objectCountBefore} objects`);

        // Verify markupType survived the round-trip
        const roundTripJson = await page.evaluate(() => window.app.canvas.toJSON());
        const rtRect = roundTripJson.objects.find(o => o.type === 'Rect');
        assert(rtRect && rtRect.markupType === 'note', 'markupType survives page change round-trip');

        const rtEllipse = roundTripJson.objects.find(o => o.type === 'Ellipse');
        assert(rtEllipse && rtEllipse.markupType === 'issue', 'Custom markupType=issue survives page change');

        // =====================================================================
        // TEST GROUP 7: Undo/redo preserves custom properties
        // =====================================================================
        console.log('\n--- Test Group 7: Undo/Redo ---');

        // After page change round-trip, undo stack was reset.
        // Add a new shape so we have something to undo.
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const testRect = new fabric.Rect({
                left: 500, top: 500, width: 50, height: 50,
                fill: 'transparent', stroke: 'blue', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(testRect, { markupType: 'question' });
            fc.add(testRect);
            fc.renderAll();
        });
        await page.waitForTimeout(200);

        const beforeUndoCount = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );

        // Undo should remove the shape we just added (undo/redo are now async)
        const undoResult = await page.evaluate(async () => {
            return await window.app.canvas.undo();
        });
        assert(undoResult === true, 'Undo returns true');
        await page.waitForTimeout(200);

        const afterUndoCount = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );
        assert(afterUndoCount === beforeUndoCount - 1, `Undo removed shape (${beforeUndoCount} -> ${afterUndoCount})`);

        // Redo should restore the shape with custom properties
        const redoResult = await page.evaluate(async () => {
            return await window.app.canvas.redo();
        });
        assert(redoResult === true, 'Redo returns true');
        await page.waitForTimeout(200);

        const afterRedoCount = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );
        assert(afterRedoCount === beforeUndoCount, `Redo restored shape (${afterRedoCount} == ${beforeUndoCount})`);

        const afterRedoJson = await page.evaluate(() => window.app.canvas.toJSON());
        // Find the question-typed shape we added for undo test
        const questionObj = afterRedoJson.objects.find(o => o.markupType === 'question');
        assert(questionObj !== undefined, 'markupType=question survives undo/redo round-trip');

        // =====================================================================
        // TEST GROUP 8: Zoom doesn't break shapes
        // =====================================================================
        console.log('\n--- Test Group 8: Zoom Stability ---');

        const beforeZoomPositions = await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects();
            return objs.map(o => ({ type: o.type, left: o.left, top: o.top }));
        });

        // Zoom in
        await page.evaluate(() => window.app.viewer.setZoom(200));
        await page.waitForTimeout(300);

        const afterZoomPositions = await page.evaluate(() => {
            const objs = window.app.canvas.fabricCanvas.getObjects();
            return objs.map(o => ({ type: o.type, left: o.left, top: o.top }));
        });

        // Natural coordinates should be unchanged
        let coordsStable = true;
        for (let i = 0; i < beforeZoomPositions.length; i++) {
            if (Math.abs(beforeZoomPositions[i].left - afterZoomPositions[i].left) > 0.1 ||
                Math.abs(beforeZoomPositions[i].top - afterZoomPositions[i].top) > 0.1) {
                coordsStable = false;
                break;
            }
        }
        assert(coordsStable, 'Natural coordinates unchanged after zoom');

        // Reset zoom
        await page.evaluate(() => window.app.viewer.setZoom(100));
        await page.waitForTimeout(200);

        // =====================================================================
        // TEST GROUP 9: Delete key removes selected object
        // =====================================================================
        console.log('\n--- Test Group 9: Delete ---');

        const beforeDelete = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );

        // Select the first object and delete it
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const obj = fc.getObjects()[0];
            fc.setActiveObject(obj);
        });

        // Press V first to activate select tool so keyboard events go to canvas
        await page.keyboard.press('v');
        await page.waitForTimeout(100);

        await page.keyboard.press('Delete');
        await page.waitForTimeout(300);

        const afterDelete = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );
        assert(afterDelete === beforeDelete - 1, `Delete removed 1 object (${beforeDelete} -> ${afterDelete})`);

        // =====================================================================
        // TEST GROUP 10: Drawing mode / pointer-events toggle
        // =====================================================================
        console.log('\n--- Test Group 10: Drawing Mode ---');

        // Activate rect tool — should enable pointer events
        await page.keyboard.press('r');
        const drawingActive = await page.evaluate(() => {
            const wrapper = window.app.canvas.fabricCanvas.wrapperEl;
            return wrapper.classList.contains('drawing-active');
        });
        assert(drawingActive, 'Canvas wrapper has drawing-active when rect tool is active');

        // Deactivate — should disable pointer events
        await page.keyboard.press('Escape');
        const notDrawing = await page.evaluate(() => {
            const wrapper = window.app.canvas.fabricCanvas.wrapperEl;
            return !wrapper.classList.contains('drawing-active');
        });
        assert(notDrawing, 'Canvas wrapper loses drawing-active on Escape');

    } catch (err) {
        console.error('Test error:', err);
        failed++;
    } finally {
        await browser.close();
    }

    // Results
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log(`${'='.repeat(50)}`);
    process.exit(failed > 0 ? 1 : 0);
}

run();
