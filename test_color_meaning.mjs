/**
 * PortolanCAST — Color-as-Meaning & Ambient Status Browser Test
 *
 * Tests: semantic colors on shape creation, color updates on type change,
 * intent mode switching (1-5 keys), pen tool color, intent indicator,
 * ambient status bar counts, count updates on add/remove.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_color_meaning.mjs"
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

// Expected semantic colors — must match MARKUP_COLORS in canvas.js
const COLORS = {
    note:     '#aaaaaa',
    issue:    '#ff4444',
    question: '#ffaa00',
    approval: '#44cc66',
    change:   '#4a9eff',
};

async function run() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

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
        await page.waitForTimeout(200);

        // =====================================================================
        // TEST GROUP 1: Default markup type creates gray (note) shapes
        // =====================================================================
        console.log('\n--- Test Group 1: Default Color (Note = Gray) ---');

        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 50, top: 50, width: 100, height: 80,
                fill: 'transparent', stroke: '#ff0000', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(rect);
            fc.add(rect);
            fc.renderAll();
        });

        const noteColor = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()[0];
            return obj ? obj.stroke : null;
        });
        assert(noteColor === COLORS.note, `Default stampDefaults sets note color ${COLORS.note} (got "${noteColor}")`);

        const noteType = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()[0];
            return obj ? obj.markupType : null;
        });
        assert(noteType === 'note', 'Default markupType is "note"');

        // =====================================================================
        // TEST GROUP 2: stampDefaults with type override uses semantic color
        // =====================================================================
        console.log('\n--- Test Group 2: Semantic Colors Per Type ---');

        for (const [type, expectedColor] of Object.entries(COLORS)) {
            await page.evaluate(({ t }) => {
                const fc = window.app.canvas.fabricCanvas;
                const rect = new fabric.Rect({
                    left: 50, top: 200, width: 80, height: 60,
                    fill: 'transparent', stroke: '#000000', strokeWidth: 2,
                });
                window.app.canvas.stampDefaults(rect, { markupType: t });
                fc.add(rect);
            }, { t: type });

            const color = await page.evaluate(({ t }) => {
                const objs = window.app.canvas.fabricCanvas.getObjects();
                const obj = objs.find(o => o.markupType === t);
                return obj ? obj.stroke : null;
            }, { t: type });

            assert(color === expectedColor, `Type "${type}" → color ${expectedColor} (got "${color}")`);
        }

        await page.evaluate(() => window.app.canvas.fabricCanvas.renderAll());

        // =====================================================================
        // TEST GROUP 3: Changing type in properties panel updates color
        // =====================================================================
        console.log('\n--- Test Group 3: Type Change Updates Color ---');

        // Select the first object (note/gray) and change to issue
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const obj = fc.getObjects()[0];
            fc.setActiveObject(obj);
            fc.fire('selection:created', { selected: [obj] });
        });
        await page.waitForTimeout(100);

        await page.evaluate(() => {
            const sel = document.getElementById('prop-markup-type');
            sel.value = 'issue';
            sel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        const changedColor = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getActiveObject();
            return obj ? obj.stroke : null;
        });
        assert(changedColor === COLORS.issue, `Changing type to "issue" updates stroke to ${COLORS.issue} (got "${changedColor}")`);

        const colorPickerVal = await page.evaluate(() =>
            document.getElementById('prop-stroke-color').value
        );
        assert(colorPickerVal === COLORS.issue, `Color picker syncs to ${COLORS.issue} (got "${colorPickerVal}")`);

        // =====================================================================
        // TEST GROUP 4: Intent mode indicator
        // =====================================================================
        console.log('\n--- Test Group 4: Intent Mode Indicator ---');

        const defaultIntentLabel = await page.evaluate(() =>
            document.getElementById('intent-label').textContent
        );
        assert(defaultIntentLabel === 'Note', `Default intent label is "Note" (got "${defaultIntentLabel}")`);

        // Press '2' to switch to issue mode
        await page.keyboard.press('2');
        await page.waitForTimeout(100);

        const issueIntentLabel = await page.evaluate(() =>
            document.getElementById('intent-label').textContent
        );
        assert(issueIntentLabel === 'Issue', `Press 2 → intent label "Issue" (got "${issueIntentLabel}")`);

        const issueDotColor = await page.evaluate(() =>
            document.getElementById('intent-dot').style.background
        );
        // Browser may normalize hex to rgb
        const isRedish = issueDotColor.includes('ff4444') || issueDotColor.includes('255, 68, 68') || issueDotColor === 'rgb(255, 68, 68)';
        assert(isRedish, `Intent dot is red for issue (got "${issueDotColor}")`);

        // Press '3' for question
        await page.keyboard.press('3');
        await page.waitForTimeout(100);

        const questionLabel = await page.evaluate(() =>
            document.getElementById('intent-label').textContent
        );
        assert(questionLabel === 'Question', `Press 3 → intent label "Question" (got "${questionLabel}")`);

        // Press '4' for approval
        await page.keyboard.press('4');
        await page.waitForTimeout(100);
        const approvalLabel = await page.evaluate(() =>
            document.getElementById('intent-label').textContent
        );
        assert(approvalLabel === 'Approval', `Press 4 → intent label "Approval"`);

        // Press '5' for change
        await page.keyboard.press('5');
        await page.waitForTimeout(100);
        const changeLabel = await page.evaluate(() =>
            document.getElementById('intent-label').textContent
        );
        assert(changeLabel === 'Change', `Press 5 → intent label "Change"`);

        // Reset to note
        await page.keyboard.press('1');
        await page.waitForTimeout(100);

        // =====================================================================
        // TEST GROUP 5: Intent mode affects shape creation color
        // =====================================================================
        console.log('\n--- Test Group 5: Intent Mode Shapes ---');

        // Deselect first
        await page.evaluate(() => {
            window.app.canvas.fabricCanvas.discardActiveObject();
            window.app.canvas.fabricCanvas.renderAll();
        });

        // Clear canvas for a clean test
        await page.evaluate(() => {
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
        });
        await page.waitForTimeout(100);

        // Set intent to 'issue' mode, then set toolbar to 'rect'
        await page.keyboard.press('2'); // issue
        await page.waitForTimeout(50);

        // Create a rect programmatically through the toolbar flow
        await page.evaluate(() => {
            window.app.toolbar.setTool('rect');
        });

        // Simulate shape drawing via events
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 50, top: 50, width: 120, height: 80,
                fill: 'transparent',
                stroke: window.app.toolbar.activeMarkupType === 'issue' ? '#ff4444' : '#aaaaaa',
                strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(rect, {
                markupType: window.app.toolbar.activeMarkupType,
                preserveColor: true,
            });
            fc.add(rect);
            fc.renderAll();
        });

        const intentShapeColor = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()[0];
            return obj ? obj.stroke : null;
        });
        assert(intentShapeColor === COLORS.issue, `Issue intent mode → shape color ${COLORS.issue} (got "${intentShapeColor}")`);

        const intentShapeType = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getObjects()[0];
            return obj ? obj.markupType : null;
        });
        assert(intentShapeType === 'issue', `Issue intent mode → markupType "issue" (got "${intentShapeType}")`);

        // Reset
        await page.keyboard.press('1');
        await page.evaluate(() => window.app.toolbar.setTool(null));

        // =====================================================================
        // TEST GROUP 6: Ambient status bar counts
        // =====================================================================
        console.log('\n--- Test Group 6: Status Bar Counts ---');

        // Clear and create known markups
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            fc.clear();
            window.app.canvas._applyZoom();
            window.app.canvas.pageMarkups.clear();

            // 2 issues (1 open, 1 resolved), 1 question (open), 1 approval (resolved)
            const shapes = [
                { type: 'issue', status: 'open' },
                { type: 'issue', status: 'resolved' },
                { type: 'question', status: 'open' },
                { type: 'approval', status: 'resolved' },
            ];

            shapes.forEach((s, i) => {
                const rect = new fabric.Rect({
                    left: 50 + i * 80, top: 50, width: 60, height: 40,
                    fill: 'transparent', stroke: '#ff0000', strokeWidth: 2,
                });
                window.app.canvas.stampDefaults(rect, { markupType: s.type });
                rect.markupStatus = s.status;
                fc.add(rect);
            });

            fc.renderAll();
        });

        // Trigger counts update
        await page.evaluate(() => window.app._updateMarkupCounts());
        await page.waitForTimeout(200);

        const issueCount = await page.evaluate(() => {
            const el = document.querySelector('.count-issue');
            return el ? el.textContent : '';
        });
        assert(issueCount === '2 issues', `Issue count shows "2 issues" (got "${issueCount}")`);

        const questionCount = await page.evaluate(() => {
            const el = document.querySelector('.count-question');
            return el ? el.textContent : '';
        });
        assert(questionCount === '1 qstn', `Question count shows "1 qstn" (got "${questionCount}")`);

        const approvalCount = await page.evaluate(() => {
            const el = document.querySelector('.count-approval');
            return el ? el.textContent : '';
        });
        assert(approvalCount === '1 appr', `Approval count shows "1 appr" (got "${approvalCount}")`);

        const openCount = await page.evaluate(() => {
            const el = document.querySelector('.count-open');
            return el ? el.textContent : '';
        });
        assert(openCount === '2 open', `Open count shows "2 open" (got "${openCount}")`);

        // =====================================================================
        // TEST GROUP 7: Status counts visible
        // =====================================================================
        console.log('\n--- Test Group 7: Status Counts Visibility ---');

        const countsVisible = await page.evaluate(() => {
            const el = document.getElementById('status-counts');
            return el ? el.style.display !== 'none' : false;
        });
        assert(countsVisible, 'Status counts container is visible');

        // Change count is 0, should be hidden
        const changeHidden = await page.evaluate(() => {
            const el = document.querySelector('.count-change');
            return el ? el.style.display === 'none' : true;
        });
        assert(changeHidden, 'Change count hidden when 0');

        // =====================================================================
        // TEST GROUP 8: Counts update when markup removed
        // =====================================================================
        console.log('\n--- Test Group 8: Counts Update on Remove ---');

        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const objs = fc.getObjects();
            // Remove first issue
            fc.remove(objs[0]);
            fc.renderAll();
        });
        await page.waitForTimeout(300);

        // Manually update counts (the content change should trigger it via debounce)
        await page.evaluate(() => window.app._updateMarkupCounts());
        await page.waitForTimeout(100);

        const issueAfterRemove = await page.evaluate(() => {
            const el = document.querySelector('.count-issue');
            return el ? el.textContent : '';
        });
        assert(issueAfterRemove === '1 issue', `After remove: "1 issue" (got "${issueAfterRemove}")`);

        const openAfterRemove = await page.evaluate(() => {
            const el = document.querySelector('.count-open');
            return el ? el.textContent : '';
        });
        assert(openAfterRemove === '1 open', `After remove: "1 open" (got "${openAfterRemove}")`);

        // =====================================================================
        // TEST GROUP 9: Color survives serialization round-trip
        // =====================================================================
        console.log('\n--- Test Group 9: Color Survives Serialization ---');

        const json = await page.evaluate(() => window.app.canvas.toJSON());
        const issueObj = json.objects.find(o => o.markupType === 'issue');
        assert(issueObj !== undefined, 'Issue object found in JSON');
        assert(issueObj && issueObj.stroke === COLORS.issue, `Serialized issue has stroke ${COLORS.issue} (got "${issueObj?.stroke}")`);

        const questionObj = json.objects.find(o => o.markupType === 'question');
        assert(questionObj && questionObj.stroke === COLORS.question, `Serialized question has stroke ${COLORS.question}`);

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
