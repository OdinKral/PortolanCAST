/**
 * PortolanCAST — Phase 1 Polish Browser Test
 *
 * Tests: PDF export button + endpoint, callout tool (creation, metadata,
 * serialization, keyboard shortcut, markup list label).
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_phase1_polish.mjs"
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
        // TEST GROUP 1: Export button exists
        // =================================================================
        console.log('\n--- Test Group 1: Export Button ---');

        const exportBtn = await page.$('#btn-export');
        assert(exportBtn !== null, 'Export button exists in toolbar');

        const exportText = await page.evaluate(() =>
            document.getElementById('btn-export')?.textContent?.trim()
        );
        assert(exportText && exportText.includes('Export'), `Export button has label (${exportText})`);

        // =================================================================
        // TEST GROUP 2: Export endpoint returns PDF
        // =================================================================
        console.log('\n--- Test Group 2: Export Endpoint ---');

        // First create some markups so the export has content
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 50, top: 50, width: 100, height: 60,
                fill: 'transparent', stroke: '#ff4444', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(rect, { markupType: 'issue' });
            fc.add(rect);
            fc.renderAll();
        });
        await page.waitForTimeout(200);

        // Save markups to server
        await page.evaluate(async () => {
            const pages = window.app.canvas.getAllPageMarkups();
            await fetch(`/api/documents/${window.app.docId}/markups`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages }),
            });
        });
        await page.waitForTimeout(200);

        // Call export endpoint directly
        const exportResult = await page.evaluate(async () => {
            const resp = await fetch(`/api/documents/${window.app.docId}/export`);
            return {
                status: resp.status,
                contentType: resp.headers.get('Content-Type'),
                contentDisposition: resp.headers.get('Content-Disposition'),
                size: (await resp.blob()).size,
            };
        });

        assert(exportResult.status === 200, `Export returns 200 (got ${exportResult.status})`);
        assert(
            exportResult.contentType && exportResult.contentType.includes('application/pdf'),
            `Export returns PDF content-type (${exportResult.contentType})`
        );
        assert(
            exportResult.contentDisposition && exportResult.contentDisposition.includes('attachment'),
            'Export has download disposition'
        );
        assert(exportResult.size > 100, `Export PDF has content (${exportResult.size} bytes)`);

        // =================================================================
        // TEST GROUP 3: Export with no markups still works
        // =================================================================
        console.log('\n--- Test Group 3: Export Empty ---');

        // Clear markups
        await page.evaluate(async () => {
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
            window.app.canvas.pageMarkups.clear();
            await fetch(`/api/documents/${window.app.docId}/markups`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages: {} }),
            });
        });
        await page.waitForTimeout(200);

        const emptyExport = await page.evaluate(async () => {
            const resp = await fetch(`/api/documents/${window.app.docId}/export`);
            return { status: resp.status, size: (await resp.blob()).size };
        });

        assert(emptyExport.status === 200, 'Export with no markups returns 200');
        assert(emptyExport.size > 100, 'Export with no markups returns valid PDF');

        // =================================================================
        // TEST GROUP 4: Callout button exists
        // =================================================================
        console.log('\n--- Test Group 4: Callout Button ---');

        const calloutBtn = await page.$('button[data-tool="callout"]');
        assert(calloutBtn !== null, 'Callout button exists');

        const calloutTitle = await page.evaluate(() =>
            document.querySelector('button[data-tool="callout"]')?.getAttribute('title')
        );
        assert(
            calloutTitle && calloutTitle.includes('Callout'),
            `Callout button has tooltip (${calloutTitle})`
        );

        // =================================================================
        // TEST GROUP 5: Callout keyboard shortcut
        // =================================================================
        console.log('\n--- Test Group 5: Callout Keyboard Shortcut ---');

        await page.keyboard.press('o');
        const calloutTool = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(calloutTool === 'callout', `O key activates callout tool (got ${calloutTool})`);

        await page.keyboard.press('Escape');

        // =================================================================
        // TEST GROUP 6: Callout creation (programmatic)
        // =================================================================
        console.log('\n--- Test Group 6: Callout Creation ---');

        const calloutResult = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const MARKUP_COLORS = { note: '#aaaaaa' };

            // Create callout components like the tool would
            const line = new fabric.Line([100, 100, 250, 50], {
                stroke: MARKUP_COLORS.note,
                strokeWidth: 2,
                strokeUniform: true,
                selectable: false,
            });

            const textObj = new fabric.IText('Test Callout', {
                left: 250, top: 50,
                fontFamily: 'Arial, sans-serif',
                fontSize: 14,
                fill: MARKUP_COLORS.note,
                stroke: null, strokeWidth: 0,
                selectable: true, editable: true,
            });

            const group = new fabric.Group([line, textObj], {
                selectable: true,
            });

            fc.add(group);
            window.app.canvas.stampDefaults(group, {
                markupType: 'note',
                preserveColor: true,
            });

            fc.setActiveObject(group);
            fc.renderAll();

            return {
                type: group.type,
                markupType: group.markupType,
                markupStatus: group.markupStatus,
                childCount: group.getObjects ? group.getObjects().length : 0,
            };
        });

        assert(
            calloutResult.type === 'Group' || calloutResult.type === 'group',
            `Callout creates Group (got ${calloutResult.type})`
        );
        assert(calloutResult.markupType === 'note', 'Callout has markupType=note');
        assert(calloutResult.markupStatus === 'open', 'Callout has markupStatus=open');
        assert(calloutResult.childCount === 2, `Callout has 2 children (got ${calloutResult.childCount})`);

        // =================================================================
        // TEST GROUP 7: Callout with intent mode
        // =================================================================
        console.log('\n--- Test Group 7: Callout Intent Mode ---');

        const calloutIssue = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const MARKUP_COLORS = { issue: '#ff4444' };

            const line = new fabric.Line([200, 200, 350, 150], {
                stroke: MARKUP_COLORS.issue,
                strokeWidth: 2, strokeUniform: true,
            });
            const txt = new fabric.IText('Issue callout', {
                left: 350, top: 150,
                fontSize: 14, fill: MARKUP_COLORS.issue,
                stroke: null, strokeWidth: 0,
            });
            const group = new fabric.Group([line, txt], { selectable: true });
            fc.add(group);
            window.app.canvas.stampDefaults(group, {
                markupType: 'issue',
                preserveColor: true,
            });
            fc.renderAll();

            return { markupType: group.markupType };
        });

        assert(calloutIssue.markupType === 'issue', 'Callout intent=issue sets markupType');

        // =================================================================
        // TEST GROUP 8: Callout serialization round-trip
        // =================================================================
        console.log('\n--- Test Group 8: Callout Serialization ---');

        const serialized = await page.evaluate(() => {
            const json = window.app.canvas.toJSON();
            const groupObj = json.objects.find(o =>
                (o.type === 'Group' || o.type === 'group') && o.markupType
            );
            return {
                found: !!groupObj,
                markupType: groupObj ? groupObj.markupType : null,
                markupStatus: groupObj ? groupObj.markupStatus : null,
                hasChildren: groupObj ? (groupObj.objects && groupObj.objects.length > 0) : false,
            };
        });

        assert(serialized.found, 'Callout Group found in toJSON output');
        assert(serialized.markupType === 'note', 'Callout markupType survives serialization');
        assert(serialized.markupStatus === 'open', 'Callout markupStatus survives serialization');
        assert(serialized.hasChildren, 'Callout children survive serialization');

        // =================================================================
        // TEST GROUP 9: Callout page change round-trip
        // =================================================================
        console.log('\n--- Test Group 9: Page Change Round-Trip ---');

        const objCountBefore = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );

        await page.evaluate(() => window.app.viewer.goToPage(1));
        await page.waitForTimeout(500);

        await page.evaluate(() => window.app.viewer.goToPage(0));
        await page.waitForTimeout(500);

        const objCountAfter = await page.evaluate(() =>
            window.app.canvas.fabricCanvas.getObjects().length
        );
        assert(
            objCountAfter === objCountBefore,
            `Callout survives page change (${objCountAfter}/${objCountBefore})`
        );

        // Verify Group type survived
        const hasGroup = await page.evaluate(() => {
            const json = window.app.canvas.toJSON();
            return json.objects.some(o =>
                (o.type === 'Group' || o.type === 'group') && o.markupType
            );
        });
        assert(hasGroup, 'Callout Group type preserved after page change');

        // =================================================================
        // TEST GROUP 10: Properties panel labels Group as Callout
        // =================================================================
        console.log('\n--- Test Group 10: Properties Panel Label ---');

        // Select the callout group
        const propLabel = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const groups = fc.getObjects().filter(o =>
                o.type === 'Group' || o.type === 'group'
            );
            if (groups.length === 0) return { found: false };

            fc.setActiveObject(groups[0]);
            fc.renderAll();

            // Wait a tick for properties panel to update
            return new Promise(resolve => {
                setTimeout(() => {
                    const typeEl = document.getElementById('prop-obj-type');
                    resolve({
                        found: true,
                        label: typeEl ? typeEl.textContent : null,
                    });
                }, 100);
            });
        });

        assert(propLabel.found, 'Found callout group for properties test');
        assert(
            propLabel.label === 'Callout',
            `Properties panel shows "Callout" (got "${propLabel.label}")`
        );

        // =================================================================
        // TEST GROUP 11: Markup list labels Group as Callout
        // =================================================================
        console.log('\n--- Test Group 11: Markup List Label ---');

        // Refresh markup list and check for Callout label
        const listLabel = await page.evaluate(() => {
            window.app.markupList.refresh();
            return new Promise(resolve => {
                setTimeout(() => {
                    const rows = document.querySelectorAll('.markup-row-shape');
                    let hasCallout = false;
                    rows.forEach(r => {
                        if (r.textContent === 'Callout') hasCallout = true;
                    });
                    resolve({ hasCallout, rowCount: rows.length });
                }, 200);
            });
        });

        assert(listLabel.hasCallout, 'Markup list shows "Callout" shape label');
        assert(listLabel.rowCount > 0, `Markup list has rows (${listLabel.rowCount})`);

        // =================================================================
        // TEST GROUP 12: Export with callout markups
        // =================================================================
        console.log('\n--- Test Group 12: Export With Callouts ---');

        // Save current markups (includes callouts)
        await page.evaluate(async () => {
            const pages = window.app.canvas.getAllPageMarkups();
            await fetch(`/api/documents/${window.app.docId}/markups`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages }),
            });
        });
        await page.waitForTimeout(200);

        const calloutExport = await page.evaluate(async () => {
            const resp = await fetch(`/api/documents/${window.app.docId}/export`);
            return { status: resp.status, size: (await resp.blob()).size };
        });

        assert(calloutExport.status === 200, 'Export with callouts returns 200');
        assert(calloutExport.size > 100, `Export with callouts has content (${calloutExport.size} bytes)`);

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
