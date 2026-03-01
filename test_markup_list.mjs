/**
 * PortolanCAST — Markup List Panel Browser Test
 *
 * Tests: tab switching, list population from multiple pages, filter by type,
 * filter by status, click to navigate + select, count summary, active row
 * highlighting, empty state.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_markup_list.mjs"
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

        // Clear any pre-existing markups from previous test runs
        await page.evaluate(async () => {
            // Clear all page markups in memory
            window.app.canvas.pageMarkups.clear();
            // Clear current canvas
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
            // Save empty state to server
            await fetch(`/api/documents/${window.app.docId}/markups`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages: {} }),
            });
            window.app._dirty = false;
        });
        await page.waitForTimeout(200);

        // =====================================================================
        // TEST GROUP 1: Tab switching
        // =====================================================================
        console.log('\n--- Test Group 1: Tab Switching ---');

        // Pages tab should be active by default
        const pagesTabActive = await page.evaluate(() =>
            document.querySelector('[data-panel="pages"]').classList.contains('active')
        );
        assert(pagesTabActive, 'Pages tab active by default');

        const pagesContentVisible = await page.evaluate(() =>
            document.getElementById('tab-pages').classList.contains('active')
        );
        assert(pagesContentVisible, 'Pages tab content visible by default');

        // Click Markups tab
        await page.click('[data-panel="markups"]');
        await page.waitForTimeout(100);

        const markupsTabActive = await page.evaluate(() =>
            document.querySelector('[data-panel="markups"]').classList.contains('active')
        );
        assert(markupsTabActive, 'Markups tab active after click');

        const markupsContentVisible = await page.evaluate(() =>
            document.getElementById('tab-markups').classList.contains('active')
        );
        assert(markupsContentVisible, 'Markups tab content visible after click');

        const pagesHidden = await page.evaluate(() =>
            !document.getElementById('tab-pages').classList.contains('active')
        );
        assert(pagesHidden, 'Pages tab content hidden when Markups active');

        // Switch back to Pages
        await page.click('[data-panel="pages"]');
        await page.waitForTimeout(100);

        const pagesBackActive = await page.evaluate(() =>
            document.querySelector('[data-panel="pages"]').classList.contains('active')
        );
        assert(pagesBackActive, 'Pages tab re-activates on click');

        // =====================================================================
        // TEST GROUP 2: Empty state
        // =====================================================================
        console.log('\n--- Test Group 2: Empty State ---');

        // Switch to markups tab to check empty state
        await page.click('[data-panel="markups"]');
        await page.waitForTimeout(200);

        const emptyVisible = await page.evaluate(() => {
            const el = document.getElementById('markup-list-empty');
            return el && el.style.display !== 'none';
        });
        assert(emptyVisible, 'Empty message visible when no markups');

        const countText = await page.evaluate(() =>
            document.getElementById('markup-count').textContent
        );
        assert(countText === '0 markups', `Count shows "0 markups" (got "${countText}")`);

        // =====================================================================
        // TEST GROUP 3: Add markups on page 0, verify list populates
        // =====================================================================
        console.log('\n--- Test Group 3: List Population ---');

        // Create 3 markups on page 0 with different types
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;

            const rect = new fabric.Rect({
                left: 50, top: 50, width: 100, height: 80,
                fill: 'transparent', stroke: '#ff0000', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(rect, { markupType: 'issue' });
            rect.markupNote = 'Wall dimension incorrect';
            fc.add(rect);

            const ellipse = new fabric.Ellipse({
                left: 200, top: 100, rx: 50, ry: 30,
                fill: 'transparent', stroke: '#00ff00', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(ellipse, { markupType: 'question' });
            ellipse.markupNote = 'Verify pipe size';
            fc.add(ellipse);

            const line = new fabric.Line([300, 50, 400, 150], {
                stroke: '#0000ff', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(line, { markupType: 'approval' });
            line.markupStatus = 'resolved';
            line.markupNote = 'Approved as-is';
            fc.add(line);

            fc.renderAll();
        });

        // Refresh the markup list
        await page.evaluate(() => window.app.markupList.refresh());
        await page.waitForTimeout(200);

        const rowCount = await page.evaluate(() =>
            document.querySelectorAll('.markup-row').length
        );
        assert(rowCount === 3, `3 markup rows created (got ${rowCount})`);

        const countAfterAdd = await page.evaluate(() =>
            document.getElementById('markup-count').textContent
        );
        assert(countAfterAdd === '3 markups', `Count shows "3 markups" (got "${countAfterAdd}")`);

        const emptyHidden = await page.evaluate(() => {
            const el = document.getElementById('markup-list-empty');
            return el && el.style.display === 'none';
        });
        assert(emptyHidden, 'Empty message hidden when markups exist');

        // =====================================================================
        // TEST GROUP 4: Verify row content
        // =====================================================================
        console.log('\n--- Test Group 4: Row Content ---');

        // First row should be the rect/issue
        const firstRowType = await page.evaluate(() => {
            const badge = document.querySelector('.markup-row:nth-child(2) .markup-type-badge');
            return badge ? badge.textContent : null;
        });
        assert(firstRowType === 'Issue', `First row type badge shows "Issue" (got "${firstRowType}")`);

        const firstRowNote = await page.evaluate(() => {
            const note = document.querySelector('.markup-row:nth-child(2) .markup-row-note');
            return note ? note.textContent : null;
        });
        assert(firstRowNote === 'Wall dimension incorrect', `First row note shows correctly`);

        const firstRowPage = await page.evaluate(() => {
            const pg = document.querySelector('.markup-row:nth-child(2) .markup-row-page');
            return pg ? pg.textContent : null;
        });
        assert(firstRowPage === 'p.1', `First row page shows "p.1" (got "${firstRowPage}")`);

        // Check status dot on the resolved item (third row)
        const resolvedDot = await page.evaluate(() => {
            const dot = document.querySelector('.markup-row:nth-child(4) .markup-status-dot');
            return dot ? dot.classList.contains('status-resolved') : false;
        });
        assert(resolvedDot, 'Resolved item has status-resolved dot');

        // =====================================================================
        // TEST GROUP 5: Filter by type
        // =====================================================================
        console.log('\n--- Test Group 5: Type Filter ---');

        // Filter to "issue" only
        await page.evaluate(() => {
            const sel = document.getElementById('markup-filter');
            sel.value = 'issue';
            sel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        const issueRows = await page.evaluate(() =>
            document.querySelectorAll('.markup-row').length
        );
        assert(issueRows === 1, `Filter "issue" shows 1 row (got ${issueRows})`);

        const filteredCount = await page.evaluate(() =>
            document.getElementById('markup-count').textContent
        );
        assert(filteredCount === '1/3 markups', `Filtered count shows "1/3 markups" (got "${filteredCount}")`);

        // Reset filter
        await page.evaluate(() => {
            const sel = document.getElementById('markup-filter');
            sel.value = 'all';
            sel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        const allRowsBack = await page.evaluate(() =>
            document.querySelectorAll('.markup-row').length
        );
        assert(allRowsBack === 3, 'Reset filter shows all 3 rows');

        // =====================================================================
        // TEST GROUP 6: Filter by status
        // =====================================================================
        console.log('\n--- Test Group 6: Status Filter ---');

        // Filter to "resolved" only
        await page.evaluate(() => {
            const sel = document.getElementById('markup-status-filter');
            sel.value = 'resolved';
            sel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        const resolvedRows = await page.evaluate(() =>
            document.querySelectorAll('.markup-row').length
        );
        assert(resolvedRows === 1, `Filter "resolved" shows 1 row (got ${resolvedRows})`);

        // Filter to "open"
        await page.evaluate(() => {
            const sel = document.getElementById('markup-status-filter');
            sel.value = 'open';
            sel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        const openRows = await page.evaluate(() =>
            document.querySelectorAll('.markup-row').length
        );
        assert(openRows === 2, `Filter "open" shows 2 rows (got ${openRows})`);

        // Reset status filter
        await page.evaluate(() => {
            const sel = document.getElementById('markup-status-filter');
            sel.value = 'all';
            sel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        // =====================================================================
        // TEST GROUP 7: Combined filters
        // =====================================================================
        console.log('\n--- Test Group 7: Combined Filters ---');

        // Filter: type=approval + status=resolved — should match 1
        await page.evaluate(() => {
            const typeSel = document.getElementById('markup-filter');
            typeSel.value = 'approval';
            typeSel.dispatchEvent(new Event('change'));
            const statusSel = document.getElementById('markup-status-filter');
            statusSel.value = 'resolved';
            statusSel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        const combinedRows = await page.evaluate(() =>
            document.querySelectorAll('.markup-row').length
        );
        assert(combinedRows === 1, `Combined filter (approval+resolved) shows 1 row (got ${combinedRows})`);

        // Filter: type=issue + status=resolved — should match 0
        await page.evaluate(() => {
            const typeSel = document.getElementById('markup-filter');
            typeSel.value = 'issue';
            typeSel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        const noMatch = await page.evaluate(() =>
            document.querySelectorAll('.markup-row').length
        );
        assert(noMatch === 0, 'Incompatible filters show 0 rows');

        // Reset both filters
        await page.evaluate(() => {
            document.getElementById('markup-filter').value = 'all';
            document.getElementById('markup-filter').dispatchEvent(new Event('change'));
            document.getElementById('markup-status-filter').value = 'all';
            document.getElementById('markup-status-filter').dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        // =====================================================================
        // TEST GROUP 8: Click row to select object on same page
        // =====================================================================
        console.log('\n--- Test Group 8: Click to Select (Same Page) ---');

        // Click the first markup row
        await page.evaluate(() => {
            const rows = document.querySelectorAll('.markup-row');
            if (rows.length > 0) rows[0].click();
        });
        await page.waitForTimeout(300);

        const hasActive = await page.evaluate(() => {
            const active = document.querySelector('.markup-row.active');
            return active !== null;
        });
        assert(hasActive, 'Clicked row gets active class');

        const selectedType = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getActiveObject();
            return obj ? obj.markupType : null;
        });
        assert(selectedType === 'issue', `Clicking first row selects the issue markup (got "${selectedType}")`);

        // =====================================================================
        // TEST GROUP 9: Multi-page — add markups on page 1, verify in list
        // =====================================================================
        console.log('\n--- Test Group 9: Multi-Page Markups ---');

        // Navigate to page 1
        await page.evaluate(() => window.app.viewer.goToPage(1));
        await page.waitForTimeout(800);

        // Add a markup on page 1
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 100, top: 100, width: 150, height: 100,
                fill: 'transparent', stroke: '#ff0000', strokeWidth: 2,
            });
            window.app.canvas.stampDefaults(rect, { markupType: 'change' });
            rect.markupNote = 'Revise ductwork routing';
            fc.add(rect);
            fc.renderAll();
        });
        await page.waitForTimeout(200);

        // Refresh the list
        await page.evaluate(() => window.app.markupList.refresh());
        await page.waitForTimeout(200);

        const totalRows = await page.evaluate(() =>
            document.querySelectorAll('.markup-row').length
        );
        assert(totalRows === 4, `4 total markups across 2 pages (got ${totalRows})`);

        const totalCount = await page.evaluate(() =>
            document.getElementById('markup-count').textContent
        );
        assert(totalCount === '4 markups', `Count shows "4 markups" (got "${totalCount}")`);

        // Verify the page 1 markup shows page 2 label
        const page2Label = await page.evaluate(() => {
            const rows = document.querySelectorAll('.markup-row');
            const lastRow = rows[rows.length - 1];
            const pageSpan = lastRow ? lastRow.querySelector('.markup-row-page') : null;
            return pageSpan ? pageSpan.textContent : null;
        });
        assert(page2Label === 'p.2', `Page 1 markup shows "p.2" label (got "${page2Label}")`);

        // =====================================================================
        // TEST GROUP 10: Click row to navigate to different page
        // =====================================================================
        console.log('\n--- Test Group 10: Click to Navigate (Different Page) ---');

        // Currently on page 1. Click a page 0 markup row.
        await page.evaluate(() => {
            const rows = document.querySelectorAll('.markup-row');
            // First row should be from page 0
            if (rows.length > 0) rows[0].click();
        });
        await page.waitForTimeout(2000);

        const navigatedPage = await page.evaluate(() =>
            window.app.viewer.currentPage
        );
        assert(navigatedPage === 0, `Clicking page 0 row navigates to page 0 (got page ${navigatedPage})`);

        // Check for selection — onPageChanged().then() should have fired by now
        const navSelectedType = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getActiveObject();
            return obj ? obj.markupType : null;
        });
        assert(navSelectedType === 'issue', `Object is selected after cross-page navigation (got "${navSelectedType}")`);

        // =====================================================================
        // TEST GROUP 11: Singular count
        // =====================================================================
        console.log('\n--- Test Group 11: Count Grammar ---');

        // Filter to show only 1 result
        await page.evaluate(() => {
            const sel = document.getElementById('markup-filter');
            sel.value = 'change';
            sel.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(100);

        const singularCount = await page.evaluate(() =>
            document.getElementById('markup-count').textContent
        );
        assert(singularCount === '1/4 markups', `Filtered singular count correct (got "${singularCount}")`);

        // Reset
        await page.evaluate(() => {
            document.getElementById('markup-filter').value = 'all';
            document.getElementById('markup-filter').dispatchEvent(new Event('change'));
        });

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
