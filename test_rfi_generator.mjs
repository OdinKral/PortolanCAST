/**
 * PortolanCAST — RFI Generator Browser Tests
 *
 * Tests the RFI Generator tab: panel shell, server endpoint, header field
 * rendering, type/tag/status filters, and Markdown output format.
 *
 * Groups:
 *   1. RFI Tab Shell (5)             — tab button, content divs, form elements
 *   2. RFI Server Endpoint (6)       — POST /generate-rfi, response shape, empty case
 *   3. RFI Header Block (4)          — header fields render into Markdown
 *   4. RFI With Markups (6)          — numbered items, note content, author attribution
 *   5. RFI Filters (5)               — type/status/tag filter logic end-to-end
 *
 * Total: 26 tests
 * Running total after this suite: 501 + 26 = 527
 *
 * Requires server running on http://127.0.0.1:8000 with at least one document (id=1).
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_rfi_generator.mjs"
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-02-25
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
        // SETUP: Load edit page, clear previous markups
        // =====================================================================
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

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
        // TEST GROUP 1: RFI Tab Shell
        // =====================================================================
        console.log('\n--- Test Group 1: RFI Tab Shell ---');

        // 1.1 — RFI tab button exists in the left panel tabs
        const rfiTabBtn = await page.$('.panel-tabs .panel-tab[data-panel="rfi"]');
        assert(rfiTabBtn !== null, 'RFI tab button exists in left panel tabs');

        // 1.2 — #tab-rfi content div exists in the DOM
        const rfiTabDiv = await page.$('#tab-rfi');
        assert(rfiTabDiv !== null, '#tab-rfi content div exists');

        // 1.3 — Clicking RFI tab makes #tab-rfi .active
        await page.click('.panel-tabs .panel-tab[data-panel="rfi"]');
        await page.waitForTimeout(200);
        const rfiTabActive = await page.$eval('#tab-rfi', el => el.classList.contains('active'));
        assert(rfiTabActive, 'Clicking RFI tab makes #tab-rfi .active');

        // 1.4 — All five header inputs exist (#rfi-no, #rfi-project, #rfi-drawing, #rfi-to, #rfi-from)
        const headerIds = ['rfi-no', 'rfi-project', 'rfi-drawing', 'rfi-to', 'rfi-from'];
        const allHeadersExist = await page.evaluate((ids) => {
            return ids.every(id => document.getElementById(id) !== null);
        }, headerIds);
        assert(allHeadersExist, 'All five header input fields exist in #tab-rfi');

        // 1.5 — #rfi-content div and #btn-rfi-generate button exist
        const rfiContent = await page.$('#rfi-content');
        const genBtn = await page.$('#btn-rfi-generate');
        assert(rfiContent !== null && genBtn !== null, '#rfi-content div and #btn-rfi-generate button exist');

        // =====================================================================
        // TEST GROUP 2: RFI Server Endpoint
        // =====================================================================
        console.log('\n--- Test Group 2: RFI Server Endpoint ---');

        // 2.1 — POST /api/documents/1/generate-rfi with empty payload → 200
        const emptyResp = await page.evaluate(async () => {
            const r = await fetch('/api/documents/1/generate-rfi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages: {}, filters: {}, header: {} }),
            });
            return { status: r.status, data: await r.json() };
        });
        assert(emptyResp.status === 200, 'POST /api/documents/1/generate-rfi returns 200');

        // 2.2 — Response has markdown and item_count keys
        const d = emptyResp.data;
        assert(
            'markdown' in d && 'item_count' in d,
            'Response has markdown and item_count keys'
        );

        // 2.3 — Empty pages → item_count = 0
        assert(d.item_count === 0, `Empty pages → item_count = 0 (got: ${d.item_count})`);

        // 2.4 — Markdown starts with "# RFI"
        assert(
            typeof d.markdown === 'string' && d.markdown.startsWith('# RFI'),
            `Markdown starts with "# RFI" (got: "${d.markdown?.slice(0, 40)}")`
        );

        // 2.5 — Empty pages → markdown contains "No markups match" message
        assert(
            d.markdown.includes('No markups match'),
            'Empty pages → markdown contains "No markups match"'
        );

        // 2.6 — Non-existent doc → 404
        const missingResp = await page.evaluate(async () => {
            const r = await fetch('/api/documents/99999/generate-rfi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages: {}, filters: {}, header: {} }),
            });
            return { status: r.status };
        });
        assert(missingResp.status === 404, 'Non-existent doc → 404');

        // =====================================================================
        // TEST GROUP 3: RFI Header Block
        // =====================================================================
        console.log('\n--- Test Group 3: RFI Header Block ---');

        // 3.1 — Providing header fields → Markdown contains them
        const withHeaderResp = await page.evaluate(async () => {
            const r = await fetch('/api/documents/1/generate-rfi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pages: {},
                    filters: {},
                    header: {
                        rfi_no:  'RFI-042',
                        project: 'Campus HVAC Retrofit',
                        drawing: 'M-101 Rev C',
                        to:      'Mechanical Engineer',
                        from:    'Facilities Manager',
                    },
                }),
            });
            return await r.json();
        });
        const headerMd = withHeaderResp.markdown || '';
        assert(headerMd.includes('RFI-042'),         'Header: RFI number appears in Markdown');
        assert(headerMd.includes('Campus HVAC'),     'Header: project name appears in Markdown');
        assert(headerMd.includes('Mechanical Eng'),  'Header: "To:" appears in Markdown');

        // 3.4 — Empty header fields → "—" placeholders used
        const emptyHeaderMd = emptyResp.data.markdown || '';
        assert(
            emptyHeaderMd.includes('**To:** —') || emptyHeaderMd.includes('**To:** —'),
            'Empty header fields use em-dash placeholders for To/From'
        );

        // =====================================================================
        // TEST GROUP 4: RFI With Markups
        // =====================================================================
        console.log('\n--- Test Group 4: RFI With Markups ---');

        // Add markups to canvas
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const mkRect = (type, status, note, author) => new fabric.Rect({
                left: 50, top: 50, width: 60, height: 40,
                fill: 'transparent', stroke: '#888', strokeWidth: 2,
                markupType: type, markupStatus: status,
                markupNote: note, markupAuthor: author,
            });
            fc.add(mkRect('issue',    'open',     'Duct conflicts with beam at C-4 #structural', 'J.Smith'));
            fc.add(mkRect('question', 'open',     'Clarify beam spec #rfi-042', 'K.Jones'));
            fc.add(mkRect('approval', 'resolved', 'Grid spacing confirmed', 'M.Brown'));
            fc.renderAll();
        });
        await page.waitForTimeout(200);

        const markupResp = await page.evaluate(async () => {
            const pages = window.app.canvas.getAllPageMarkups();
            const r = await fetch('/api/documents/1/generate-rfi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages, filters: {}, header: { rfi_no: 'RFI-001' } }),
            });
            return await r.json();
        });

        // 4.1 — item_count = 3 (all markups, no filter)
        assert(markupResp.item_count === 3, `item_count = 3 with 3 markups (got: ${markupResp.item_count})`);

        const itemMd = markupResp.markdown || '';

        // 4.2 — Markdown contains "## Item 1" header
        assert(itemMd.includes('## Item 1'), 'Markdown contains "## Item 1" header');

        // 4.3 — Item note text appears in Markdown
        assert(
            itemMd.includes('Duct conflicts with beam'),
            'Markup note text appears in RFI Markdown'
        );

        // 4.4 — Author attribution appears in Markdown
        assert(
            itemMd.includes('J.Smith'),
            'Author attribution appears in RFI Markdown'
        );

        // 4.5 — Clicking Generate button renders content in #rfi-content
        // First, make sure we're on the RFI tab
        await page.click('.panel-tabs .panel-tab[data-panel="rfi"]');
        await page.waitForTimeout(200);

        // Fill a header field and click Generate
        await page.fill('#rfi-no', 'RFI-010');
        await page.click('#btn-rfi-generate');
        await page.waitForTimeout(800); // allow fetch to complete

        const contentAfterGenerate = await page.$eval(
            '#rfi-content',
            el => el.textContent?.trim() || ''
        );
        assert(
            contentAfterGenerate.length > 20 &&
            !contentAfterGenerate.includes('Fill in the header'),
            `After clicking Generate, #rfi-content shows non-placeholder content (got: "${contentAfterGenerate.slice(0, 60)}")`
        );

        // 4.6 — #btn-rfi-copy button exists in the RFI tab
        const copyBtn = await page.$('#btn-rfi-copy');
        assert(copyBtn !== null, '#btn-rfi-copy button exists in the RFI tab');

        // =====================================================================
        // TEST GROUP 5: RFI Filters
        // =====================================================================
        console.log('\n--- Test Group 5: RFI Filters ---');

        // 5.1 — Type filter "question" → only 1 item (the question), not 3
        const questOnly = await page.evaluate(async () => {
            const pages = window.app.canvas.getAllPageMarkups();
            const r = await fetch('/api/documents/1/generate-rfi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages, filters: { types: ['question'] }, header: {} }),
            });
            return await r.json();
        });
        assert(
            questOnly.item_count === 1,
            `Type filter "question" → item_count = 1 (got: ${questOnly.item_count})`
        );

        // 5.2 — Status filter "open" → 2 items (issue + question; approval is resolved)
        const openOnly = await page.evaluate(async () => {
            const pages = window.app.canvas.getAllPageMarkups();
            const r = await fetch('/api/documents/1/generate-rfi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages, filters: { statuses: ['open'] }, header: {} }),
            });
            return await r.json();
        });
        assert(
            openOnly.item_count === 2,
            `Status filter "open" → item_count = 2 (got: ${openOnly.item_count})`
        );

        // 5.3 — Tag filter "structural" → 1 item (issue note has #structural)
        const structuralOnly = await page.evaluate(async () => {
            const pages = window.app.canvas.getAllPageMarkups();
            const r = await fetch('/api/documents/1/generate-rfi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages, filters: { tags: ['structural'] }, header: {} }),
            });
            return await r.json();
        });
        assert(
            structuralOnly.item_count === 1,
            `Tag filter "structural" → item_count = 1 (got: ${structuralOnly.item_count})`
        );

        // 5.4 — Combined filter: type=issue + status=open → 1 item
        const combined = await page.evaluate(async () => {
            const pages = window.app.canvas.getAllPageMarkups();
            const r = await fetch('/api/documents/1/generate-rfi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pages,
                    filters: { types: ['issue'], statuses: ['open'] },
                    header: {},
                }),
            });
            return await r.json();
        });
        assert(
            combined.item_count === 1,
            `Combined filter issue+open → item_count = 1 (got: ${combined.item_count})`
        );

        // 5.5 — Filter that matches nothing → item_count = 0 + "No markups match" in Markdown
        const noMatch = await page.evaluate(async () => {
            const pages = window.app.canvas.getAllPageMarkups();
            const r = await fetch('/api/documents/1/generate-rfi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pages,
                    filters: { types: ['change'] }, // no changes added
                    header: {},
                }),
            });
            return await r.json();
        });
        assert(
            noMatch.item_count === 0 && noMatch.markdown.includes('No markups match'),
            `Filter with no matches → item_count=0 and "No markups match" in MD (got: ${noMatch.item_count})`
        );

    } finally {
        await browser.close();
    }

    // ==========================================================================
    // RESULTS SUMMARY
    // ==========================================================================
    console.log('\n');
    console.log('════════════════════════════════════════');
    console.log('  RFI Generator');
    console.log('════════════════════════════════════════');
    console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('════════════════════════════════════════');

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('[RFI Generator Test] Fatal error:', err);
    process.exit(1);
});
