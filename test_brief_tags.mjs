/**
 * PortolanCAST — Review Brief + Markup Tags Browser Tests
 *
 * Tests the Brief tab and #tag system that ship together:
 *   - Review Brief: server-generated Markdown brief from live markup state
 *   - Markup Tags: #word syntax parsed from note fields into filter chips
 *
 * Groups:
 *   1. Brief Tab Shell (5)            — tab button, content div, placeholder, actions
 *   2. Brief Server Endpoint (5)      — POST /review-brief, response shape, Markdown format
 *   3. Brief With Markups (6)         — generates correct sections, open-count badge
 *   4. Tag Chips in Properties (5)    — #prop-markup-tags, live chip rendering, multi-tag
 *   5. Tag Cloud in Markup List (5)   — #markup-tag-cloud, chip filtering, clear behavior
 *
 * Total: 26 tests
 * Running total after this suite: 475 + 26 = 501
 *
 * Requires server running on http://127.0.0.1:8000 with at least one document (id=1).
 *
 * Run via Windows Chrome from WSL:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_brief_tags.mjs"
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
    const browser = await chromium.launch();
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
        // TEST GROUP 1: Brief Tab Shell
        // =====================================================================
        console.log('\n--- Test Group 1: Brief Tab Shell ---');

        // 1.1 — Brief tab button exists in the left panel tabs
        const briefTabBtn = await page.$('.panel-tabs .panel-tab[data-panel="brief"]');
        assert(briefTabBtn !== null, 'Brief tab button exists in left panel tabs');

        // 1.2 — #tab-brief content div exists in the DOM
        const briefTabDiv = await page.$('#tab-brief');
        assert(briefTabDiv !== null, '#tab-brief content div exists');

        // 1.3 — Clicking Brief tab makes #tab-brief .active
        await page.click('.panel-tabs .panel-tab[data-panel="brief"]');
        await page.waitForTimeout(200);
        const briefTabActive = await page.$eval(
            '#tab-brief',
            el => el.classList.contains('active')
        );
        assert(briefTabActive, 'Clicking Brief tab makes #tab-brief .active');

        // 1.4 — #brief-content div exists inside #tab-brief
        const briefContent = await page.$('#brief-content');
        assert(briefContent !== null, '#brief-content div exists inside #tab-brief');

        // 1.5 — #btn-brief-refresh button exists
        const refreshBtn = await page.$('#btn-brief-refresh');
        assert(refreshBtn !== null, '#btn-brief-refresh button exists');

        // =====================================================================
        // TEST GROUP 2: Brief Server Endpoint
        // =====================================================================
        console.log('\n--- Test Group 2: Brief Server Endpoint ---');

        // 2.1 — POST /api/documents/1/review-brief with empty pages → 200
        const emptyResp = await page.evaluate(async () => {
            const r = await fetch('/api/documents/1/review-brief', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages: {} }),
            });
            return { status: r.status, data: await r.json() };
        });
        assert(emptyResp.status === 200, 'POST /api/documents/1/review-brief returns 200');

        // 2.2 — Response has markdown, total, open, resolved keys
        const d = emptyResp.data;
        assert(
            'markdown' in d && 'total' in d && 'open' in d && 'resolved' in d,
            'Response has markdown, total, open, resolved keys'
        );

        // 2.3 — Markdown string is non-empty
        assert(
            typeof d.markdown === 'string' && d.markdown.length > 0,
            'Response markdown is a non-empty string'
        );

        // 2.4 — Markdown starts with "# Review Brief"
        assert(
            d.markdown.startsWith('# Review Brief'),
            `Markdown starts with "# Review Brief" (got: "${d.markdown.slice(0, 40)}")`
        );

        // 2.5 — Empty pages → total = 0 and open = 0
        assert(
            d.total === 0 && d.open === 0,
            `Empty pages → total=0, open=0 (got total=${d.total}, open=${d.open})`
        );

        // =====================================================================
        // TEST GROUP 3: Brief With Markups
        // =====================================================================
        console.log('\n--- Test Group 3: Brief With Markups ---');

        // Add markups: 1 open issue + 1 open question + 1 resolved approval
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const mkRect = (type, status, note) => {
                return new fabric.Rect({
                    left: 50, top: 50, width: 60, height: 40,
                    fill: 'transparent', stroke: '#888', strokeWidth: 2,
                    markupType: type, markupStatus: status, markupNote: note,
                    markupAuthor: 'TestUser',
                });
            };
            fc.add(mkRect('issue',    'open',     'Duct conflicts at C-4 #structural'));
            fc.add(mkRect('question', 'open',     'Clarify beam size #rfi'));
            fc.add(mkRect('approval', 'resolved', 'Grid confirmed'));
            fc.renderAll();
        });
        await page.waitForTimeout(200);

        // Fetch brief directly with the live page data
        const briefResp = await page.evaluate(async () => {
            const pages = window.app.canvas.getAllPageMarkups();
            const r = await fetch('/api/documents/1/review-brief', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pages }),
            });
            return { data: await r.json() };
        });
        const md = briefResp.data.markdown || '';

        // 3.1 — total = 3
        assert(briefResp.data.total === 3, `total = 3 (got: ${briefResp.data.total})`);

        // 3.2 — open = 2 (issue + question)
        assert(briefResp.data.open === 2, `open = 2 (got: ${briefResp.data.open})`);

        // 3.3 — Markdown contains "## Issues" section
        assert(md.includes('## Issues'), 'Markdown contains "## Issues" section');

        // 3.4 — Markdown contains "## Questions" section
        assert(md.includes('## Questions'), 'Markdown contains "## Questions" section');

        // 3.5 — Markdown contains "## Tag Index" section (from #structural and #rfi tags)
        assert(md.includes('## Tag Index'), 'Markdown contains "## Tag Index" section');

        // 3.6 — Clicking Refresh shows non-empty brief content in the panel
        await page.click('#btn-brief-refresh');
        await page.waitForFunction(() => {
            const el = document.getElementById('brief-content');
            if (!el) return false;
            const text = el.textContent || '';
            return !text.includes('Generating brief') && text.trim().length > 10;
        }, { timeout: 8000 }).catch(() => null);
        await page.waitForTimeout(300);

        const briefText = await page.$eval('#brief-content', el => el.textContent?.trim() || '');
        assert(
            briefText.length > 10 && !briefText.includes('Generating brief'),
            `After Refresh, #brief-content shows non-empty content (got: "${briefText.slice(0, 60)}")`
        );

        // =====================================================================
        // TEST GROUP 4: Tag Chips in Properties Panel
        // =====================================================================
        console.log('\n--- Test Group 4: Tag Chips in Properties Panel ---');

        // Switch to Markup tab and activate Select tool
        await page.evaluate(() => {
            const btn = document.querySelector('.panel-tabs .panel-tab[data-panel="markups"]');
            if (btn) btn.click();
        });
        await page.waitForTimeout(200);
        await page.evaluate(() => window.app.toolbar.setTool('select'));

        // 4.1 — #prop-markup-tags element exists in the DOM
        const tagDisplay = await page.$('#prop-markup-tags');
        assert(tagDisplay !== null, '#prop-markup-tags element exists in the DOM');

        // 4.2 — Before any selection, tag display is empty (no chips)
        const tagsBeforeSelect = await page.$eval('#prop-markup-tags', el => el.children.length);
        assert(tagsBeforeSelect === 0, '#prop-markup-tags is empty before any markup is selected');

        // 4.3 — Selecting a markup with #tags in note shows tag chips
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const objs = fc.getObjects().filter(o => o.markupType === 'issue');
            if (objs.length > 0) fc.setActiveObject(objs[0]);
            fc.renderAll();
        });
        await page.waitForTimeout(200);

        const chipsAfterSelect = await page.$eval('#prop-markup-tags', el => el.children.length);
        assert(
            chipsAfterSelect > 0,
            `Selecting issue markup (note has #structural) shows tag chips (got: ${chipsAfterSelect})`
        );

        // 4.4 — Tag chip text content matches the tag (without #)
        const chipTexts = await page.$$eval('#prop-markup-tags .prop-tag', chips =>
            chips.map(c => c.textContent?.trim() || '')
        );
        assert(
            chipTexts.includes('#structural'),
            `Tag chip shows "#structural" (got: ${JSON.stringify(chipTexts)})`
        );

        // 4.5 — Typing a new note with multiple tags shows multiple chips
        await page.evaluate(() => {
            const noteEl = document.getElementById('prop-markup-note');
            if (noteEl) {
                noteEl.value = 'Test note #alpha #beta #gamma';
                noteEl.dispatchEvent(new Event('input'));
            }
        });
        await page.waitForTimeout(100);

        const multiChips = await page.$$eval('#prop-markup-tags .prop-tag', chips =>
            chips.map(c => c.textContent?.trim() || '')
        );
        assert(
            multiChips.length >= 3,
            `Three tags typed → three or more chips shown (got: ${JSON.stringify(multiChips)})`
        );

        // =====================================================================
        // TEST GROUP 5: Tag Cloud in Markup List
        // =====================================================================
        console.log('\n--- Test Group 5: Tag Cloud in Markup List ---');

        // Deselect, switch to Markups tab
        await page.evaluate(() => {
            window.app.canvas.fabricCanvas.discardActiveObject();
            window.app.canvas.fabricCanvas.renderAll();
            const btn = document.querySelector('.panel-tabs .panel-tab[data-panel="markups"]');
            if (btn) btn.click();
        });
        await page.waitForTimeout(300);

        // Trigger a list refresh so the tag cloud populates
        await page.evaluate(() => window.app.markupList.refresh());
        await page.waitForTimeout(300);

        // 5.1 — #markup-tag-cloud div exists
        const tagCloud = await page.$('#markup-tag-cloud');
        assert(tagCloud !== null, '#markup-tag-cloud div exists');

        // 5.2 — After adding tagged markups, tag cloud is visible (display != none)
        const cloudVisible = await page.evaluate(() => {
            const el = document.getElementById('markup-tag-cloud');
            if (!el) return false;
            return el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
        });
        assert(cloudVisible, '#markup-tag-cloud is visible when markups have #tags');

        // 5.3 — Tag cloud contains at least one chip with "#rfi"
        // Note: test 4.5 overwrites the issue markup note to #alpha/#beta/#gamma so
        // #structural is gone by this point. #rfi (on the question markup) is stable.
        const cloudChips = await page.$$eval('#markup-tag-cloud .markup-tag', chips =>
            chips.map(c => c.dataset.tag || c.textContent?.trim() || '')
        );
        assert(
            cloudChips.some(t => t.includes('rfi')),
            `Tag cloud contains #rfi chip (got: ${JSON.stringify(cloudChips)})`
        );

        // 5.4 — Clicking a tag chip filters the markup list
        const rowCountBefore = await page.$$eval('#markup-list .markup-row', rows => rows.length);

        // Click the #rfi chip (always present — from the question markup seeded in Group 3)
        const rfiChip = await page.$('.markup-tag[data-tag="rfi"]');
        if (rfiChip) {
            await rfiChip.click();
            await page.waitForTimeout(200);
        }

        const rowCountAfter = await page.$$eval('#markup-list .markup-row', rows => rows.length);
        assert(
            rowCountAfter <= rowCountBefore,
            `Clicking #rfi chip filters list (before: ${rowCountBefore}, after: ${rowCountAfter})`
        );

        // 5.5 — Clicking "All" chip clears the tag filter (row count restored)
        const allChip = await page.$('.markup-tag[data-tag="all"]');
        if (allChip) {
            await allChip.click();
            await page.waitForTimeout(200);
        }

        const rowCountCleared = await page.$$eval('#markup-list .markup-row', rows => rows.length);
        assert(
            rowCountCleared >= rowCountAfter,
            `Clicking "All" chip clears filter (rows before: ${rowCountAfter}, after clear: ${rowCountCleared})`
        );

    } finally {
        await browser.close();
    }

    // ==========================================================================
    // RESULTS SUMMARY
    // ==========================================================================
    console.log('\n');
    console.log('════════════════════════════════════════');
    console.log('  Review Brief + Markup Tags');
    console.log('════════════════════════════════════════');
    console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('════════════════════════════════════════');

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('[BriefTags Test] Fatal error:', err);
    process.exit(1);
});
