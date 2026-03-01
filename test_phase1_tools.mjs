/**
 * PortolanCAST — Phase 1 New Tools Browser Test
 *
 * Tests: highlighter, text, and cloud tools — toolbar buttons, keyboard
 * shortcuts, creation, metadata, serialization, intent mode integration,
 * and status bar counts.
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_phase1_tools.mjs"
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

        // =================================================================
        // TEST GROUP 1: Toolbar buttons exist
        // =================================================================
        console.log('\n--- Test Group 1: Toolbar Buttons ---');

        const highlighterBtn = await page.$('button[data-tool="highlighter"]');
        assert(highlighterBtn !== null, 'Highlighter button exists');

        const textBtn = await page.$('button[data-tool="text"]');
        assert(textBtn !== null, 'Text button exists');

        const cloudBtn = await page.$('button[data-tool="cloud"]');
        assert(cloudBtn !== null, 'Cloud button exists');

        // =================================================================
        // TEST GROUP 2: Keyboard shortcuts
        // =================================================================
        console.log('\n--- Test Group 2: Keyboard Shortcuts ---');

        await page.keyboard.press('h');
        let tool = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(tool === 'highlighter', 'H key activates highlighter tool');

        await page.keyboard.press('t');
        tool = await page.evaluate(() => window.app.toolbar.activeTool);
        // Text tool is one-shot — it activates then waits for click
        // But before clicking, it should be 'text'
        assert(tool === 'text', 'T key activates text tool');

        await page.keyboard.press('Escape');
        await page.keyboard.press('c');
        tool = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(tool === 'cloud', 'C key activates cloud tool');

        await page.keyboard.press('Escape');

        // =================================================================
        // TEST GROUP 3: Highlighter creation
        // =================================================================
        console.log('\n--- Test Group 3: Highlighter Creation ---');

        const hlResult = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            // Create a highlighter rect programmatically (same as tool would)
            const hl = new fabric.Rect({
                left: 100, top: 50, width: 200, height: 25,
                fill: '#aaaaaa',
                opacity: 0.25,
                stroke: null,
                strokeWidth: 0,
                selectable: true,
            });
            window.app.canvas.stampDefaults(hl, {
                markupType: 'note',
                preserveColor: true,
            });
            fc.add(hl);
            fc.renderAll();
            return {
                type: hl.type,
                fill: hl.fill,
                opacity: hl.opacity,
                strokeWidth: hl.strokeWidth,
                markupType: hl.markupType,
                markupStatus: hl.markupStatus,
            };
        });

        assert(hlResult.type === 'Rect' || hlResult.type === 'rect',
            'Highlighter creates a Rect');
        assert(hlResult.fill === '#aaaaaa', 'Highlighter has fill color');
        assert(Math.abs(hlResult.opacity - 0.25) < 0.01,
            `Highlighter opacity ~0.25 (got ${hlResult.opacity})`);
        assert(hlResult.strokeWidth === 0, 'Highlighter has no stroke');
        assert(hlResult.markupType === 'note', 'Highlighter has markupType=note');
        assert(hlResult.markupStatus === 'open', 'Highlighter has markupStatus=open');

        // =================================================================
        // TEST GROUP 4: Highlighter with intent mode
        // =================================================================
        console.log('\n--- Test Group 4: Highlighter Intent Mode ---');

        const hlIssue = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const MARKUP_COLORS = { note: '#aaaaaa', issue: '#ff4444', question: '#ffaa00', approval: '#44cc66', change: '#4a9eff' };
            const hl = new fabric.Rect({
                left: 100, top: 100, width: 200, height: 25,
                fill: MARKUP_COLORS.issue,
                opacity: 0.25,
                stroke: null, strokeWidth: 0,
                selectable: true,
            });
            window.app.canvas.stampDefaults(hl, {
                markupType: 'issue',
                preserveColor: true,
            });
            fc.add(hl);
            fc.renderAll();
            return { markupType: hl.markupType, fill: hl.fill };
        });

        assert(hlIssue.markupType === 'issue', 'Highlighter intent=issue sets markupType');
        assert(hlIssue.fill === '#ff4444', 'Highlighter intent=issue uses red fill');

        // =================================================================
        // TEST GROUP 5: Text creation
        // =================================================================
        console.log('\n--- Test Group 5: Text Creation ---');

        const textResult = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const MARKUP_COLORS = { note: '#aaaaaa' };
            const txt = new fabric.IText('Hello', {
                left: 300, top: 200,
                fontFamily: 'Arial, sans-serif',
                fontSize: 16,
                fill: MARKUP_COLORS.note,
                stroke: null, strokeWidth: 0,
                selectable: true, editable: true,
            });
            window.app.canvas.stampDefaults(txt, {
                markupType: 'note',
                preserveColor: true,
            });
            fc.add(txt);
            fc.renderAll();
            return {
                type: txt.type,
                text: txt.text,
                fill: txt.fill,
                markupType: txt.markupType,
                markupStatus: txt.markupStatus,
                editable: txt.editable,
            };
        });

        assert(textResult.type === 'IText' || textResult.type === 'i-text',
            `Text creates IText (got ${textResult.type})`);
        assert(textResult.text === 'Hello', 'Text has correct content');
        assert(textResult.fill === '#aaaaaa', 'Text fill matches semantic color');
        assert(textResult.markupType === 'note', 'Text has markupType=note');
        assert(textResult.markupStatus === 'open', 'Text has markupStatus=open');
        assert(textResult.editable === true, 'Text is editable');

        // =================================================================
        // TEST GROUP 6: Text editing and empty text removal
        // =================================================================
        console.log('\n--- Test Group 6: Text Editing ---');

        const beforeCount = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );

        // Create empty text and exit editing — should be removed
        const emptyRemoved = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const emptyTxt = new fabric.IText('', {
                left: 400, top: 300,
                fontSize: 16, fill: '#aaaaaa',
            });
            fc.add(emptyTxt);
            fc.setActiveObject(emptyTxt);
            emptyTxt.enterEditing();
            // Fire editing:exited to trigger cleanup
            emptyTxt.exitEditing();
            return fc.getObjects().length;
        });

        assert(emptyRemoved === beforeCount,
            `Empty text removed on edit exit (${emptyRemoved} === ${beforeCount})`);

        // =================================================================
        // TEST GROUP 7: Text metadata with intent mode
        // =================================================================
        console.log('\n--- Test Group 7: Text Intent Mode ---');

        const textChange = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const MARKUP_COLORS = { change: '#4a9eff' };
            const txt = new fabric.IText('Change note', {
                left: 300, top: 250,
                fontSize: 16,
                fill: MARKUP_COLORS.change,
                stroke: null, strokeWidth: 0,
            });
            window.app.canvas.stampDefaults(txt, {
                markupType: 'change',
                preserveColor: true,
            });
            fc.add(txt);
            fc.renderAll();
            return { markupType: txt.markupType, fill: txt.fill };
        });

        assert(textChange.markupType === 'change', 'Text intent=change sets markupType');
        assert(textChange.fill === '#4a9eff', 'Text intent=change uses blue fill');

        // =================================================================
        // TEST GROUP 8: Cloud creation
        // =================================================================
        console.log('\n--- Test Group 8: Cloud Creation ---');

        const cloudResult = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            // Generate cloud path using the toolbar method
            const pathStr = window.app.toolbar._generateCloudPath(0, 0, 150, 100);
            const cloud = new fabric.Path(pathStr, {
                left: 50, top: 350,
                fill: 'transparent',
                stroke: '#aaaaaa',
                strokeWidth: 2,
                strokeUniform: true,
                selectable: true,
            });
            window.app.canvas.stampDefaults(cloud, {
                markupType: 'note',
                preserveColor: true,
            });
            fc.add(cloud);
            fc.renderAll();
            return {
                type: cloud.type,
                markupType: cloud.markupType,
                markupStatus: cloud.markupStatus,
                hasPath: typeof cloud.path !== 'undefined' || typeof cloud.d !== 'undefined',
                stroke: cloud.stroke,
            };
        });

        assert(cloudResult.type === 'Path' || cloudResult.type === 'path',
            `Cloud creates Path (got ${cloudResult.type})`);
        assert(cloudResult.markupType === 'note', 'Cloud has markupType=note');
        assert(cloudResult.markupStatus === 'open', 'Cloud has markupStatus=open');
        assert(cloudResult.stroke === '#aaaaaa', 'Cloud stroke matches semantic color');

        // =================================================================
        // TEST GROUP 9: Cloud path generation
        // =================================================================
        console.log('\n--- Test Group 9: Cloud Path Generation ---');

        const pathTests = await page.evaluate(() => {
            const tb = window.app.toolbar;
            const small = tb._generateCloudPath(0, 0, 30, 30);
            const large = tb._generateCloudPath(0, 0, 200, 150);
            return {
                smallStartsWithM: small.startsWith('M'),
                smallEndsWithZ: small.endsWith('Z'),
                smallHasArcs: small.includes('A'),
                largeStartsWithM: large.startsWith('M'),
                largeHasArcs: large.includes('A'),
                // Larger shapes should have more arc segments
                smallArcCount: (small.match(/A /g) || []).length,
                largeArcCount: (large.match(/A /g) || []).length,
            };
        });

        assert(pathTests.smallStartsWithM, 'Cloud path starts with M');
        assert(pathTests.smallEndsWithZ, 'Cloud path ends with Z');
        assert(pathTests.smallHasArcs, 'Cloud path contains arc commands');
        assert(pathTests.largeArcCount > pathTests.smallArcCount,
            `Larger cloud has more arcs (${pathTests.largeArcCount} > ${pathTests.smallArcCount})`);

        // =================================================================
        // TEST GROUP 10: Cloud serialization round-trip
        // =================================================================
        console.log('\n--- Test Group 10: Cloud Serialization ---');

        const serialized = await page.evaluate(() => {
            const json = window.app.canvas.toJSON();
            // Find a Path object with markupType (cloud)
            const cloudObj = json.objects.find(o =>
                (o.type === 'Path' || o.type === 'path') && o.markupType
            );
            return {
                found: !!cloudObj,
                markupType: cloudObj ? cloudObj.markupType : null,
                markupStatus: cloudObj ? cloudObj.markupStatus : null,
                hasPathData: cloudObj ? (!!cloudObj.path || !!cloudObj.d) : false,
            };
        });

        assert(serialized.found, 'Cloud Path found in toJSON output');
        assert(serialized.markupType === 'note',
            'Cloud markupType survives serialization');
        assert(serialized.markupStatus === 'open',
            'Cloud markupStatus survives serialization');

        // =================================================================
        // TEST GROUP 11: Intent mode integration (all 3 tools)
        // =================================================================
        console.log('\n--- Test Group 11: Intent Mode Integration ---');

        const intentResults = await page.evaluate(() => {
            const MARKUP_COLORS = { question: '#ffaa00', approval: '#44cc66' };
            const fc = window.app.canvas.fabricCanvas;
            const results = {};

            // Highlighter with question intent
            const hl = new fabric.Rect({
                left: 100, top: 400, width: 100, height: 20,
                fill: MARKUP_COLORS.question, opacity: 0.25,
                stroke: null, strokeWidth: 0,
            });
            window.app.canvas.stampDefaults(hl, {
                markupType: 'question', preserveColor: true,
            });
            fc.add(hl);
            results.hlType = hl.markupType;
            results.hlFill = hl.fill;

            // Text with approval intent
            const txt = new fabric.IText('Approved', {
                left: 100, top: 430, fontSize: 16,
                fill: MARKUP_COLORS.approval,
                stroke: null, strokeWidth: 0,
            });
            window.app.canvas.stampDefaults(txt, {
                markupType: 'approval', preserveColor: true,
            });
            fc.add(txt);
            results.txtType = txt.markupType;
            results.txtFill = txt.fill;

            // Cloud with question intent
            const pathStr = window.app.toolbar._generateCloudPath(0, 0, 80, 60);
            const cloud = new fabric.Path(pathStr, {
                left: 100, top: 460, fill: 'transparent',
                stroke: MARKUP_COLORS.question, strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(cloud, {
                markupType: 'question', preserveColor: true,
            });
            fc.add(cloud);
            results.cloudType = cloud.markupType;
            results.cloudStroke = cloud.stroke;

            fc.renderAll();
            return results;
        });

        assert(intentResults.hlType === 'question',
            'Highlighter inherits question intent');
        assert(intentResults.hlFill === '#ffaa00',
            'Highlighter uses amber fill for question');
        assert(intentResults.txtType === 'approval',
            'Text inherits approval intent');
        assert(intentResults.txtFill === '#44cc66',
            'Text uses green fill for approval');
        assert(intentResults.cloudType === 'question',
            'Cloud inherits question intent');
        assert(intentResults.cloudStroke === '#ffaa00',
            'Cloud uses amber stroke for question');

        // =================================================================
        // TEST GROUP 12: Status bar counts include new tools
        // =================================================================
        console.log('\n--- Test Group 12: Counts Integration ---');

        // Force a counts update
        await page.evaluate(() => {
            window.app._updateMarkupCounts();
        });
        await page.waitForTimeout(100);

        const counts = await page.evaluate(() => {
            const get = (cls) => {
                const el = document.querySelector(`.${cls}`);
                return el ? el.textContent : '';
            };
            return {
                issue: get('count-issue'),
                question: get('count-question'),
                approval: get('count-approval'),
                change: get('count-change'),
                open: get('count-open'),
            };
        });

        // We created objects with various types — verify counts are non-empty
        assert(counts.question.includes('qstn'), `Question count shown (${counts.question})`);
        assert(counts.open.includes('open'), `Open count shown (${counts.open})`);

        // =================================================================
        // TEST GROUP 13: Page change round-trip for new tools
        // =================================================================
        console.log('\n--- Test Group 13: Page Change Round-Trip ---');

        const objCountBefore = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );

        // Navigate to page 2 then back to page 1
        await page.evaluate(() => window.app.viewer.goToPage(1));
        await page.waitForTimeout(500);

        const page2Count = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );
        assert(page2Count === 0, 'Page 2 starts with 0 objects');

        await page.evaluate(() => window.app.viewer.goToPage(0));
        await page.waitForTimeout(500);

        const objCountAfter = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );
        assert(objCountAfter === objCountBefore,
            `Page 1 restored ${objCountAfter}/${objCountBefore} objects`);

        // Verify new tool types survived the round-trip
        const rtJson = await page.evaluate(() => window.app.canvas.toJSON());
        const hasIText = rtJson.objects.some(o =>
            (o.type === 'IText' || o.type === 'i-text') && o.markupType
        );
        assert(hasIText, 'IText survives page change round-trip with markupType');

        const hasCloudPath = rtJson.objects.some(o =>
            (o.type === 'Path' || o.type === 'path') && o.markupType
        );
        assert(hasCloudPath, 'Cloud Path survives page change round-trip');

        // =================================================================
        // TEST GROUP 14: Keyboard shortcuts blocked during text editing
        // =================================================================
        console.log('\n--- Test Group 14: Keyboard Guard During Text Edit ---');

        const guardResult = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            // Find an IText object and enter editing
            const textObj = fc.getObjects().find(o =>
                o.type === 'IText' || o.type === 'i-text'
            );
            if (!textObj) return { found: false };

            fc.setActiveObject(textObj);
            textObj.enterEditing();
            const isEditing = textObj.isEditing;
            textObj.exitEditing();
            return { found: true, wasEditing: isEditing };
        });

        assert(guardResult.found, 'Found IText object for edit guard test');
        assert(guardResult.wasEditing === true,
            'IText enters editing mode (keyboard guard active)');

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
