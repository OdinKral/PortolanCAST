/**
 * PortolanCAST — OCR / Page Text Tests
 *
 * Verifies the text extraction feature introduced alongside OCR support:
 *   1. GET /api/documents/{id}/text/{page} endpoint — native text extraction.
 *   2. ocr_available flag reflects whether Tesseract is installed.
 *   3. Frontend Text tab panel: visible, shows extracted text, word count.
 *   4. Method badge updates to "native" for digital PDFs.
 *   5. Copy button becomes enabled when text is present.
 *   6. Tab is lazy: text is only fetched when the tab is active.
 *   7. OCR section hidden when native text is found.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_ocr_text.mjs"
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

async function run() {
    const browser = await chromium.launch({ headless: true });
    const page    = await browser.newPage();

    try {
        // ── Group 1: API endpoint — native text ───────────────────────────────
        console.log('\n  -- Group 1: API Endpoint --');

        // Hit endpoint directly via fetch in browser context (avoids CORS for same-origin)
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1000);

        const apiResult = await page.evaluate(async (docId) => {
            const r = await fetch(`/api/documents/${docId}/text/0`);
            return r.ok ? r.json() : null;
        }, DOC_ID);

        assert(apiResult !== null, 'GET /api/documents/{id}/text/0 returns 200');
        assert(typeof apiResult.text === 'string',        'Response has text field');
        assert(typeof apiResult.word_count === 'number',  'Response has word_count');
        assert(typeof apiResult.char_count === 'number',  'Response has char_count');
        assert(typeof apiResult.has_native_text === 'boolean', 'Response has has_native_text');
        assert(['native','ocr','none'].includes(apiResult.method), `method is valid (got "${apiResult.method}")`);
        assert(typeof apiResult.ocr_available === 'boolean', 'Response has ocr_available');
        assert(typeof apiResult.page === 'number',        'Response echo-backs page number');
        assert(apiResult.page === 0,                      'page field echoes request (0)');

        // For our test document: it's a digital PDF so we expect native text
        assert(apiResult.has_native_text === true,        'Test document has native text layer');
        assert(apiResult.method === 'native',             'method=native for digital PDF');
        assert(apiResult.word_count > 0,                  `word_count > 0 (got ${apiResult.word_count})`);
        assert(apiResult.ocr_available === true,          'ocr_available=true (Tesseract installed)');

        // ── Group 2: Invalid page returns 400 ────────────────────────────────
        console.log('\n  -- Group 2: Error Handling --');

        const badPage = await page.evaluate(async (docId) => {
            const r = await fetch(`/api/documents/${docId}/text/9999`);
            return { status: r.status };
        }, DOC_ID);
        assert(badPage.status === 400, 'Out-of-range page returns 400');

        const missingDoc = await page.evaluate(async () => {
            const r = await fetch('/api/documents/99999/text/0');
            return { status: r.status };
        });
        assert(missingDoc.status === 404, 'Unknown document ID returns 404');

        // ── Group 3: Text tab exists in left panel ────────────────────────────
        console.log('\n  -- Group 3: Text Tab UI Elements --');

        const tabBtnExists = await page.evaluate(() =>
            !!document.querySelector('.panel-tab[data-panel="text"]')
        );
        assert(tabBtnExists, '"Text" tab button exists in left panel');

        const tabContentExists = await page.evaluate(() =>
            !!document.getElementById('tab-text')
        );
        assert(tabContentExists, '#tab-text content element exists');

        const textBodyExists   = await page.evaluate(() => !!document.getElementById('text-body'));
        const textBadgeExists  = await page.evaluate(() => !!document.getElementById('text-method-badge'));
        const textStatsExists  = await page.evaluate(() => !!document.getElementById('text-stats'));
        const textCopyExists   = await page.evaluate(() => !!document.getElementById('text-copy-btn'));
        const textOcrWrapExists = await page.evaluate(() => !!document.getElementById('text-ocr-wrap'));
        assert(textBodyExists,    '#text-body element exists');
        assert(textBadgeExists,   '#text-method-badge element exists');
        assert(textStatsExists,   '#text-stats element exists');
        assert(textCopyExists,    '#text-copy-btn element exists');
        assert(textOcrWrapExists, '#text-ocr-wrap element exists');

        // ── Group 4: Text tab fetches on activation ───────────────────────────
        console.log('\n  -- Group 4: Text Tab Fetch on Activation --');

        // Click the Text tab
        await page.click('.panel-tab[data-panel="text"]');
        await page.waitForTimeout(1500);  // allow fetch + render

        const methodBadge = await page.evaluate(() =>
            document.getElementById('text-method-badge')?.dataset?.method
        );
        assert(methodBadge === 'native', `Method badge shows "native" (got "${methodBadge}")`);

        const statsText = await page.evaluate(() =>
            document.getElementById('text-stats')?.textContent?.trim()
        );
        assert(
            statsText && statsText.includes('words'),
            `Stats shows word count (got "${statsText}")`
        );

        const bodyText = await page.evaluate(() =>
            document.getElementById('text-body')?.textContent?.trim()
        );
        assert(bodyText && bodyText.length > 5 && !bodyText.startsWith('('),
            `Text body has extracted text (got ${bodyText?.length} chars)`);

        // Copy button should be enabled after text is loaded
        const copyEnabled = await page.evaluate(() =>
            !document.getElementById('text-copy-btn')?.disabled
        );
        assert(copyEnabled, 'Copy button is enabled after text load');

        // OCR section should be hidden (native text was found)
        const ocrWrapHidden = await page.evaluate(() =>
            document.getElementById('text-ocr-wrap')?.style?.display === 'none'
        );
        assert(ocrWrapHidden, '#text-ocr-wrap is hidden when native text is available');

        // ── Group 5: Lazy loading — tab must be active to fetch ───────────────
        console.log('\n  -- Group 5: Lazy Loading --');

        // Switch away from text tab, change page, check that text body doesn't auto-update
        await page.click('.panel-tab[data-panel="pages"]');
        await page.waitForTimeout(100);

        const bodyBeforePageChange = await page.evaluate(() =>
            document.getElementById('text-body')?.textContent?.trim()
        );

        // Force a page nav (if doc has >1 page)
        const pageCount = await page.evaluate(() => window.app?.viewer?.pageCount || 1);
        if (pageCount > 1) {
            await page.evaluate(() => window.app.viewer.goToPage(1));
            await page.waitForTimeout(600);

            const bodyAfterPageChange = await page.evaluate(() =>
                document.getElementById('text-body')?.textContent?.trim()
            );
            // Body should NOT have changed (tab inactive → no fetch)
            assert(
                bodyAfterPageChange === bodyBeforePageChange,
                'Text body does NOT update when tab is inactive (lazy loading works)'
            );
        } else {
            passed++;
            console.log('  PASS: (single-page doc — lazy loading test skipped)');
        }

        // ── Group 6: PageTextPanel is wired in window.app ────────────────────
        console.log('\n  -- Group 6: App Wiring --');

        const pageTextOnApp = await page.evaluate(() => !!window.app?.pageText);
        assert(pageTextOnApp, 'window.app.pageText is a PageTextPanel instance');

        const docIdSet = await page.evaluate(() =>
            typeof window.app?.pageText?._docId === 'number'
        );
        assert(docIdSet, 'pageText._docId is set after document load');

    } finally {
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
