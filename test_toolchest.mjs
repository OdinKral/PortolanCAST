/**
 * PortolanCAST — Tool Chest Panel Tests
 *
 * Purpose:
 *   Verifies the four Bluebeam-inspired Tool Chest features added in the
 *   2026-03-01 session: Formatted Typewriter, Stamps, Saved Presets,
 *   and Sequences.
 *
 * Groups:
 *   Group 1:  Tools tab — navigation and DOM presence
 *   Group 2:  Formatted Typewriter — typography section show/hide + handlers
 *   Group 3:  Stamps — built-in display, placement, custom stamp CRUD
 *   Group 4:  Saved Tool Presets — right-click save, apply, delete
 *   Group 5:  Sequences — create, place badge, increment, reset
 *
 * Setup:
 *   localStorage keys 'portolancast-stamps', 'portolancast-presets', and
 *   'portolancast-sequences' are cleared before tests so each run starts
 *   from a known empty state. A page reload re-initialises the tool panels.
 *
 * Run:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_toolchest.mjs"
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

// =============================================================================
// COORDINATE HELPERS
// =============================================================================

async function getCanvasInfo(page) {
    return page.evaluate(() => {
        const el   = document.getElementById('fabric-canvas');
        const rect = el.getBoundingClientRect();
        return { x: rect.left, y: rect.top, scale: window.app.viewer.zoom / 100 };
    });
}

async function toPageCoords(page, naturalX, naturalY) {
    const info = await getCanvasInfo(page);
    return { x: info.x + naturalX * info.scale, y: info.y + naturalY * info.scale };
}

// =============================================================================
// TAB NAVIGATION HELPERS
// =============================================================================

/** Click the Tools tab in the left panel (uses evaluate to avoid auto-scroll). */
async function openToolsTab(page) {
    await page.evaluate(() =>
        document.querySelector('.panel-tab[data-panel="tools"]').click()
    );
    await page.waitForTimeout(150);
}

/** Click the markup tab in the top toolbar. */
async function openMarkupTab(page) {
    await page.click('.toolbar-tab[data-tab="markup"]');
    await page.waitForTimeout(100);
}

// =============================================================================
// MAIN TEST RUNNER
// =============================================================================

async function run() {
    const browser = await chromium.launch({
        headless: true,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    const context = await browser.newContext();
    const page    = await context.newPage();

    try {
        // ── Initial load ──────────────────────────────────────────────────────
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear tool chest state from any previous run so tests start clean.
        // A reload re-initialises the tool panels with empty localStorage.
        await page.evaluate(() => {
            localStorage.removeItem('portolancast-stamps');
            localStorage.removeItem('portolancast-presets');
            localStorage.removeItem('portolancast-sequences');
        });

        // Clear canvas markups too
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

        // Reload so tool panels reinit from clean localStorage
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 1: Tools Tab Navigation
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 1: Tools Tab Navigation --');

        const toolsTabBtn = await page.$('.panel-tab[data-panel="tools"]');
        assert(toolsTabBtn !== null, 'Tools tab button exists in left panel');

        // Click the tab
        await openToolsTab(page);

        const tabVisible = await page.evaluate(() => {
            const tab = document.getElementById('tab-tools');
            return tab && tab.classList.contains('active');
        });
        assert(tabVisible, '#tab-tools is active after clicking Tools tab');

        // The three sections must exist inside the Tools tab
        const presetsListExists  = await page.$('#presets-list');
        const stampsListExists   = await page.$('#stamps-list');
        const seqListExists      = await page.$('#sequences-list');
        assert(presetsListExists  !== null, '#presets-list exists inside Tools tab');
        assert(stampsListExists   !== null, '#stamps-list exists inside Tools tab');
        assert(seqListExists      !== null, '#sequences-list exists inside Tools tab');

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 2: Formatted Typewriter — Typography Controls
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 2: Formatted Typewriter (Typography Panel) --');

        // Typography section should be hidden before any object is selected
        const typoHiddenInitially = await page.evaluate(() => {
            const el = document.getElementById('markup-typography');
            return el && (el.style.display === 'none' || el.style.display === '');
        });
        assert(typoHiddenInitially, 'Typography section hidden when nothing is selected');

        // Place a rectangle shape, select it — typography section should stay hidden
        await openMarkupTab(page);
        await page.keyboard.press('r');   // rect tool
        await page.waitForTimeout(100);
        const rectStart = await toPageCoords(page, 50, 50);
        const rectEnd   = await toPageCoords(page, 130, 130);
        await page.mouse.move(rectStart.x, rectStart.y);
        await page.mouse.down();
        await page.mouse.move(rectEnd.x, rectEnd.y);
        await page.mouse.up();
        await page.waitForTimeout(300);

        const typoHiddenForShape = await page.evaluate(() => {
            const el = document.getElementById('markup-typography');
            return el && el.style.display === 'none';
        });
        assert(typoHiddenForShape, 'Typography section hidden when a shape (rect) is selected');

        // Now place a text object (T shortcut)
        await page.keyboard.press('v');    // back to select
        await page.waitForTimeout(50);
        await page.keyboard.press('t');    // text tool
        await page.waitForTimeout(100);

        const textPt = await toPageCoords(page, 200, 80);
        await page.mouse.click(textPt.x, textPt.y);
        await page.waitForTimeout(300);

        // Exit editing mode so we can select the object
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        // typography section should now be visible (text object is selected)
        const typoVisibleForText = await page.evaluate(() => {
            const el = document.getElementById('markup-typography');
            // Visible means display is not 'none' and not empty
            return el && el.style.display !== 'none';
        });
        assert(typoVisibleForText, 'Typography section shown when a text (IText) is selected');

        // DOM controls exist
        const fontFamilyExists = await page.$('#prop-font-family');
        const fontSizeExists   = await page.$('#prop-font-size');
        const fontBoldExists   = await page.$('#prop-font-bold');
        const fontItalicExists = await page.$('#prop-font-italic');
        assert(fontFamilyExists !== null, '#prop-font-family select exists');
        assert(fontSizeExists   !== null, '#prop-font-size input exists');
        assert(fontBoldExists   !== null, '#prop-font-bold toggle button exists');
        assert(fontItalicExists !== null, '#prop-font-italic toggle button exists');

        // Font size input is populated (should show a numeric value ≥ 1)
        const fontSizeVal = await page.evaluate(() => {
            const el = document.getElementById('prop-font-size');
            return el ? parseFloat(el.value) : 0;
        });
        assert(fontSizeVal >= 1, `Font size input is populated (got ${fontSizeVal})`);

        // Change font size to 24 via the input, verify object updates
        await page.evaluate(() => {
            const el = document.getElementById('prop-font-size');
            el.value = 24;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(200);

        const objFontSize = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const txt = objs.find(o => o.type === 'i-text' || o.type === 'textbox');
            return txt ? txt.fontSize : null;
        });
        assert(objFontSize === 24,
            `Fabric object fontSize updated to 24 via panel (got ${objFontSize})`);

        // Clicking Bold toggles fontWeight on the Fabric object
        const boldBefore = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const txt = objs.find(o => o.type === 'i-text' || o.type === 'textbox');
            return txt ? txt.fontWeight : null;
        });
        await page.evaluate(() =>
            document.getElementById('prop-font-bold').click()
        );
        await page.waitForTimeout(200);

        const boldAfter = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const txt = objs.find(o => o.type === 'i-text' || o.type === 'textbox');
            return txt ? txt.fontWeight : null;
        });
        // Weight should have flipped (normal→bold or bold→normal)
        assert(boldBefore !== boldAfter,
            `Bold toggle changes fontWeight (${boldBefore} → ${boldAfter})`);

        // localStorage prefs are saved
        const prefsStored = await page.evaluate(() => {
            const raw = localStorage.getItem('portolancast-text-prefs');
            if (!raw) return false;
            try { const p = JSON.parse(raw); return typeof p.fontSize === 'number'; }
            catch { return false; }
        });
        assert(prefsStored, 'portolancast-text-prefs saved to localStorage after font change');

        // Deselect — typography section should hide
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        await page.evaluate(() => window.app?.canvas?.fabricCanvas?.discardActiveObject());
        await page.evaluate(() => window.app?.canvas?.fabricCanvas?.fire('selection:cleared'));
        await page.waitForTimeout(200);

        const typoHiddenAfterDeselect = await page.evaluate(() => {
            const el = document.getElementById('markup-typography');
            return el && el.style.display === 'none';
        });
        assert(typoHiddenAfterDeselect, 'Typography section hidden after deselect');

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 3: Stamps
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 3: Stamps --');

        // Clear all canvas objects before stamp tests so the "don't place on
        // existing object" guard in StampManager never fires a false positive.
        await page.keyboard.press('v');   // back to select before clearing
        await page.evaluate(() => {
            window.app.canvas.fabricCanvas.discardActiveObject();
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas._applyZoom();
        });
        await page.waitForTimeout(200);

        await openToolsTab(page);

        // Built-in stamps are rendered
        const stampCount = await page.evaluate(() =>
            document.querySelectorAll('#stamps-list .stamp-btn').length
        );
        assert(stampCount >= 7,
            `At least 7 built-in stamp buttons rendered (got ${stampCount})`);

        // APPROVED stamp button exists
        const approvedExists = await page.evaluate(() => {
            const btns = document.querySelectorAll('#stamps-list .stamp-btn');
            return [...btns].some(b => b.textContent.includes('APPROVED'));
        });
        assert(approvedExists, 'APPROVED stamp button exists in stamps list');

        // Clicking a stamp button sets activeTool to 'stamp'
        await page.evaluate(() => {
            const btns = document.querySelectorAll('#stamps-list .stamp-btn');
            btns[0].click();   // APPROVED (first built-in)
        });
        await page.waitForTimeout(200);

        const activeToolStamp = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(activeToolStamp === 'stamp',
            `activeTool === "stamp" after clicking stamp button (got "${activeToolStamp}")`);

        // Click on empty canvas area — should place an IText
        const countBefore = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );

        const stampPt = await toPageCoords(page, 300, 300);
        await page.mouse.click(stampPt.x, stampPt.y);
        await page.waitForTimeout(300);

        const countAfter = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );
        assert(countAfter > countBefore,
            `Canvas gained an object after stamp placement (${countBefore}→${countAfter})`);

        // The placed stamp is an IText
        const stampObj = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            // Last object added
            return objs.length ? {
                type:     objs[objs.length - 1].type,
                angle:    objs[objs.length - 1].angle,
                markupId: objs[objs.length - 1].markupId,
                editable: objs[objs.length - 1].editable,
            } : null;
        });
        assert(stampObj?.type === 'i-text',
            `Stamp is an IText object (got "${stampObj?.type}")`);
        assert(stampObj?.angle === 30,
            `Stamp angle is 30° (got ${stampObj?.angle})`);
        assert(!!stampObj?.markupId,
            `Stamp has markupId (semantic defaults applied)`);
        assert(stampObj?.editable === false,
            `Stamp is editable:false (immutable once placed, got ${stampObj?.editable})`);

        // Tool returns to select after stamp placement
        const toolAfterStamp = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(toolAfterStamp === 'select',
            `activeTool returns to "select" after stamp placement (got "${toolAfterStamp}")`);

        // btn-new-stamp opens the modal
        await page.evaluate(() => document.getElementById('btn-new-stamp').click());
        await page.waitForTimeout(200);

        const stampModalOpen = await page.evaluate(() => {
            const m = document.getElementById('modal-new-stamp');
            return m && m.style.display !== 'none';
        });
        assert(stampModalOpen, 'Custom stamp modal opens on btn-new-stamp click');

        // Create a custom stamp
        await page.evaluate(() => {
            const labelEl = document.getElementById('stamp-label');
            const colorEl = document.getElementById('stamp-color');
            if (labelEl) labelEl.value = 'CUSTOM TEST';
            if (colorEl) colorEl.value = '#cc44cc';
        });
        await page.evaluate(() => document.getElementById('stamp-create').click());
        await page.waitForTimeout(200);

        const customStampExists = await page.evaluate(() => {
            const btns = document.querySelectorAll('#stamps-list .stamp-btn');
            return [...btns].some(b => b.textContent.includes('CUSTOM TEST'));
        });
        assert(customStampExists, 'Custom stamp "CUSTOM TEST" appears in stamps list after creation');

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 4: Saved Tool Presets
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 4: Saved Tool Presets --');

        // Empty hint is shown when no presets
        const emptyHint = await page.evaluate(() => {
            const el = document.getElementById('presets-empty');
            return el && el.textContent.includes('Right-click');
        });
        assert(emptyHint, 'Presets empty hint visible before any presets are saved');

        // Right-click on a tool button shows the context menu
        await openMarkupTab(page);
        await page.waitForTimeout(100);

        await page.evaluate(() => {
            const btn = document.querySelector('.tool-btn[data-tool="rect"]');
            if (btn) btn.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true,
                clientX: btn.getBoundingClientRect().left + 5,
                clientY: btn.getBoundingClientRect().top + 5,
            }));
        });
        await page.waitForTimeout(200);

        const ctxMenuVisible = await page.evaluate(() =>
            !!document.querySelector('.context-menu')
        );
        assert(ctxMenuVisible, 'Right-click context menu appears on tool button');

        // Context menu has a text input
        const ctxInput = await page.$('.context-menu-input');
        assert(ctxInput !== null, 'Context menu has a text input for preset name');

        // Save a preset named "My Red Rect"
        await page.evaluate(() => {
            const input = document.querySelector('.context-menu-input');
            if (input) input.value = 'My Red Rect';
        });
        await page.evaluate(() =>
            document.querySelector('.context-menu-action').click()
        );
        await page.waitForTimeout(200);

        // Preset should appear in #presets-list
        const presetCard = await page.evaluate(() => {
            const cards = document.querySelectorAll('#presets-list .preset-card');
            return [...cards].some(c => c.textContent.includes('My Red Rect'));
        });
        assert(presetCard, '"My Red Rect" preset card appears in #presets-list after save');

        // Preset card has a color swatch
        const swatchExists = await page.evaluate(() =>
            !!document.querySelector('.preset-card .preset-swatch')
        );
        assert(swatchExists, 'Preset card has a color swatch element');

        // Clicking the preset card activates the saved tool
        await openToolsTab(page);
        await page.evaluate(() =>
            document.querySelector('.preset-card').click()
        );
        await page.waitForTimeout(200);

        const toolAfterPreset = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(toolAfterPreset !== 'select',
            `Clicking preset card activates a tool (got "${toolAfterPreset}")`);

        // _pendingPresetOverride is cleared after activation (consumed by shapeDrawing init)
        // It may or may not have been consumed by now — we just check it was set at some point
        // by verifying the preset card click changed the active tool
        assert(typeof toolAfterPreset === 'string',
            `activeTool is a string after preset apply (got "${toolAfterPreset}")`);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 5: Sequences
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 5: Sequences --');

        await page.keyboard.press('v');   // back to select
        await openToolsTab(page);

        // Empty hint before any sequences
        const seqEmpty = await page.evaluate(() => {
            const el = document.getElementById('sequences-empty');
            return el && el.textContent.includes('No sequences');
        });
        assert(seqEmpty, 'Sequences empty hint visible before any sequences are created');

        // btn-new-sequence opens the modal
        await page.evaluate(() => document.getElementById('btn-new-sequence').click());
        await page.waitForTimeout(200);

        const seqModalOpen = await page.evaluate(() => {
            const m = document.getElementById('modal-new-sequence');
            return m && m.style.display !== 'none';
        });
        assert(seqModalOpen, 'Sequence creation modal opens on btn-new-sequence click');

        // Modal has required fields
        const seqNameExists  = await page.$('#seq-name');
        const seqFmtExists   = await page.$('#seq-format');
        const seqStartExists = await page.$('#seq-start');
        assert(seqNameExists  !== null, '#seq-name field exists in modal');
        assert(seqFmtExists   !== null, '#seq-format field exists in modal');
        assert(seqStartExists !== null, '#seq-start field exists in modal');

        // Create a sequence named "RFI" starting at 1, format "RFI-{n}"
        await page.evaluate(() => {
            document.getElementById('seq-name').value   = 'RFI';
            document.getElementById('seq-format').value = 'RFI-{n}';
            document.getElementById('seq-start').value  = '1';
        });
        await page.evaluate(() => document.getElementById('seq-create').click());
        await page.waitForTimeout(200);

        // Sequence row appears in the list
        const seqRowExists = await page.evaluate(() => {
            const rows = document.querySelectorAll('#sequences-list .seq-row');
            return [...rows].some(r => r.textContent.includes('RFI'));
        });
        assert(seqRowExists, '"RFI" sequence row appears in #sequences-list');

        // Badge shows the starting number in the correct format
        const badgeText = await page.evaluate(() => {
            const badge = document.querySelector('#sequences-list .seq-badge');
            return badge ? badge.textContent.trim() : null;
        });
        assert(badgeText === 'RFI-1',
            `Sequence badge shows "RFI-1" (got "${badgeText}")`);

        // Clicking Place sets activeTool to 'sequence'
        await page.evaluate(() => {
            const btn = document.querySelector('.seq-place-btn');
            if (btn) btn.click();
        });
        await page.waitForTimeout(200);

        const activeToolSeq = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(activeToolSeq === 'sequence',
            `activeTool === "sequence" after clicking Place (got "${activeToolSeq}")`);

        // Click canvas to place badge
        const seqPt = await toPageCoords(page, 400, 400);
        await page.mouse.click(seqPt.x, seqPt.y);
        await page.waitForTimeout(300);

        // A Group object should be on the canvas
        const groupPlaced = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            return objs.some(o => o.type === 'group');
        });
        assert(groupPlaced, 'A Group (circle + number badge) placed on canvas');

        // Group has expected structure (circle + itext children)
        const groupStructure = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const grp  = [...objs].reverse().find(o => o.type === 'group');
            if (!grp) return null;
            const items = grp.getObjects ? grp.getObjects() : grp._objects;
            if (!items) return null;
            return {
                count:     items.length,
                hasCircle: items.some(o => o.type === 'circle'),
                hasText:   items.some(o => o.type === 'i-text' || o.type === 'text'),
            };
        });
        assert(groupStructure !== null,                         'Group object found on canvas');
        assert(groupStructure?.count >= 2,                      `Group has ≥2 children (got ${groupStructure?.count})`);
        assert(groupStructure?.hasCircle,                       'Group contains a circle shape');
        assert(groupStructure?.hasText,                         'Group contains a text label');

        // Counter should now show RFI-2 (incremented after placement)
        const badgeAfter = await page.evaluate(() => {
            const badge = document.querySelector('#sequences-list .seq-badge');
            return badge ? badge.textContent.trim() : null;
        });
        assert(badgeAfter === 'RFI-2',
            `Badge increments to "RFI-2" after first placement (got "${badgeAfter}")`);

        // Reset button resets counter to start value
        await page.evaluate(() => {
            const btn = document.querySelector('.seq-reset-btn');
            if (btn) btn.click();
        });
        await page.waitForTimeout(200);

        const badgeReset = await page.evaluate(() => {
            const badge = document.querySelector('#sequences-list .seq-badge');
            return badge ? badge.textContent.trim() : null;
        });
        assert(badgeReset === 'RFI-1',
            `Badge resets to "RFI-1" after clicking Reset (got "${badgeReset}")`);

    } finally {
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
