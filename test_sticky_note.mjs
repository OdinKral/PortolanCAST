/**
 * PortolanCAST — Sticky Note Tool Tests
 *
 * Verifies the sticky-note markup tool:
 *   1. Button exists in markup toolbar with correct title/icon.
 *   2. _TOOL_TAB maps sticky-note → 'markup'.
 *   3. Tool activates on button click (isDrawingMode false, selection false).
 *   4. S keyboard shortcut activates the tool.
 *   5. mouse:down handler is registered.
 *   6. Click on canvas produces a Textbox in editing mode.
 *   7. Finished note has markupType, markupId, backgroundColor, stroke.
 *   8. Text typed into the note is synced to markupNote on editing:exited.
 *   9. Tool reverts to select after placing a note.
 *  10. Clicking on empty canvas without typing removes the orphan Textbox.
 *  11. Markup type change (key 2 = issue) updates stroke color.
 *  12. Sticky note persists across save / reload (round-trip).
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_sticky_note.mjs"
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
// SETUP HELPERS
// =============================================================================

async function openMarkupTab(page) {
    await page.click('.toolbar-tab[data-tab="markup"]');
    await page.waitForTimeout(100);
}

/**
 * Activate the sticky-note tool via its toolbar button.
 * Presses V first to avoid toggle-off behavior — if sticky-note is already
 * active, clicking its button deactivates it. V also switches to the navigate
 * tab, so we re-open the markup tab afterwards.
 *
 * IMPORTANT: uses page.evaluate().click() instead of page.click() to avoid
 * Playwright's auto-scroll-to-view behavior. The sticky-note button is off-screen
 * to the right in the toolbar (too many markup buttons for the 1280px viewport),
 * so page.click() would scroll the window ~782px right, shifting the canvas
 * getBoundingClientRect to negative X, causing all subsequent canvas clicks to
 * land off-screen. Native .click() via evaluate fires the event without scrolling.
 */
async function activateStickyNote(page) {
    await page.keyboard.press('v');     // switch away (prevents toggle-off); moves to navigate tab
    await page.waitForTimeout(50);
    await openMarkupTab(page);          // re-open markup tab so sticky-note button is visible
    // Use native .click() to avoid Playwright auto-scroll-to-view shifting the window
    await page.evaluate(() =>
        document.querySelector('.tool-btn[data-tool="sticky-note"]').click()
    );
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
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear any markups left by previous test runs
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

        // ── Group 1: Toolbar presence ─────────────────────────────────────────
        console.log('\n  -- Group 1: Toolbar Button --');

        await openMarkupTab(page);

        const btnExists = await page.$('button[data-tool="sticky-note"]');
        assert(btnExists !== null, 'Sticky-note button exists in markup toolbar');

        const btnTitle = await page.evaluate(() =>
            document.querySelector('.tool-btn[data-tool="sticky-note"]')?.title || ''
        );
        assert(btnTitle.toLowerCase().includes('sticky'),
            `Button title mentions "Sticky" (got "${btnTitle}")`);

        const hasIcon = await page.evaluate(() =>
            !!document.querySelector('.tool-btn[data-tool="sticky-note"] .icon')
        );
        assert(hasIcon, 'Sticky-note button has .icon span');

        // ── Group 2: _TOOL_TAB mapping ────────────────────────────────────────
        console.log('\n  -- Group 2: _TOOL_TAB mapping --');

        const toolTab = await page.evaluate(() =>
            window.app?.toolbar?._TOOL_TAB?.['sticky-note']
        );
        assert(toolTab === 'markup',
            `_TOOL_TAB["sticky-note"] === "markup" (got "${toolTab}")`);

        // ── Group 3: Tool activation ──────────────────────────────────────────
        console.log('\n  -- Group 3: Tool Activation --');

        await activateStickyNote(page);

        const activeTool = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(activeTool === 'sticky-note',
            `activeTool === "sticky-note" after click (got "${activeTool}")`);

        const noDrawingMode = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.isDrawingMode === false
        );
        assert(noDrawingMode, 'isDrawingMode is false (sticky-note uses event handlers)');

        const noSelection = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.selection === false
        );
        assert(noSelection, 'canvas.selection is false while sticky-note is active');

        const btnActive = await page.$eval(
            'button[data-tool="sticky-note"]',
            el => el.classList.contains('active')
        );
        assert(btnActive, 'Sticky-note button has .active class while selected');

        // ── Group 4: Keyboard shortcut S ──────────────────────────────────────
        console.log('\n  -- Group 4: Keyboard Shortcut (S) --');

        await page.keyboard.press('v');   // switch away to select
        await page.waitForTimeout(100);

        await page.keyboard.press('s');
        await page.waitForTimeout(100);

        const afterKey = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(afterKey === 'sticky-note',
            `activeTool === "sticky-note" after S key (got "${afterKey}")`);

        // ── Group 5: Handler registration ────────────────────────────────────
        console.log('\n  -- Group 5: Handler Registration --');

        // Re-activate cleanly to get fresh handler registration
        await activateStickyNote(page);

        const handlers = await page.evaluate(() => {
            const h = window.app?.toolbar?._shapeHandlers;
            return h ? Object.keys(h) : [];
        });
        assert(handlers.includes('mouse:down'), 'mouse:down handler registered');

        // ── Group 6: Placement — click produces Textbox in editing mode ───────
        console.log('\n  -- Group 6: Sticky Note Placement --');

        await activateStickyNote(page);

        const countBefore = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );

        // Click on the canvas to place a note
        const pt = await toPageCoords(page, 150, 150);
        await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(300);

        // A Textbox should be on the canvas and in editing mode
        const placedState = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const note = objs.find(o => o.type === 'textbox');
            if (!note) return null;
            return {
                type:        note.type,
                isEditing:   note.isEditing,
                bgColor:     note.backgroundColor,
                strokeWidth: note.strokeWidth,
            };
        });

        assert(placedState !== null,                    'A Textbox was placed on the canvas');
        assert(placedState?.isEditing === true,         'Textbox is in editing mode after placement');
        assert(placedState?.bgColor === '#fffde7',      `backgroundColor is sticky-note yellow (got "${placedState?.bgColor}")`);
        assert((placedState?.strokeWidth ?? 0) > 0,     `strokeWidth > 0 (border visible, got ${placedState?.strokeWidth})`);

        // ── Group 7: Note object properties ──────────────────────────────────
        console.log('\n  -- Group 7: Note Object Properties --');

        // Type some text then press Escape to exit editing
        await page.keyboard.type('Hello world');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        const noteObj = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const note = objs.find(o => o.type === 'textbox');
            if (!note) return null;
            return {
                type:        note.type,
                markupType:  note.markupType,
                markupId:    note.markupId,
                markupNote:  note.markupNote,
                bgColor:     note.backgroundColor,
                stroke:      note.stroke,
                text:        note.text,
            };
        });

        assert(noteObj !== null,                    'Note object still on canvas after editing:exited');
        assert(noteObj?.type === 'textbox',         `type is "textbox" (got "${noteObj?.type}")`);
        assert(!!noteObj?.markupType,               `markupType is set (got "${noteObj?.markupType}")`);
        assert(!!noteObj?.markupId,                 'markupId UUID stamped on note');
        assert(noteObj?.bgColor === '#fffde7',      `backgroundColor preserved (got "${noteObj?.bgColor}")`);
        assert(!!noteObj?.stroke,                   `stroke color set (got "${noteObj?.stroke}")`);

        // ── Group 8: Text synced to markupNote ────────────────────────────────
        console.log('\n  -- Group 8: Text → markupNote Sync --');

        assert(noteObj?.text === 'Hello world',
            `text content preserved (got "${noteObj?.text}")`);
        assert(noteObj?.markupNote === 'Hello world',
            `markupNote synced from text (got "${noteObj?.markupNote}")`);

        // ── Group 9: Tool reverts to select after placing ─────────────────────
        console.log('\n  -- Group 9: Auto-revert to Select --');

        // After placement the tool should have switched to select (one-shot)
        const toolAfter = await page.evaluate(() => window.app?.toolbar?.activeTool);
        assert(toolAfter === 'select',
            `Tool reverts to select after placing note (got "${toolAfter}")`);

        // ── Group 10: Empty note is removed on editing:exited ─────────────────
        console.log('\n  -- Group 10: Empty Note Removed --');

        // Place another note but don't type anything
        await activateStickyNote(page);
        const countBeforeEmpty = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );

        const pt2 = await toPageCoords(page, 350, 200);
        await page.mouse.click(pt2.x, pt2.y);
        await page.waitForTimeout(200);

        // Press Escape without typing
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        const countAfterEmpty = await page.evaluate(() =>
            window.app?.canvas?.fabricCanvas?.getObjects()?.length ?? 0
        );
        assert(countAfterEmpty === countBeforeEmpty,
            `Empty note removed on Escape (${countBeforeEmpty}→${countAfterEmpty})`);

        // ── Group 11: Markup type change updates stroke color ─────────────────
        console.log('\n  -- Group 11: Markup Type → Stroke Color --');

        // Set markup type to 'issue' (red) via key 2
        await activateStickyNote(page);
        await page.keyboard.press('2');   // '2' = issue
        await page.waitForTimeout(100);

        // Re-activate to get fresh handler with updated color
        await activateStickyNote(page);

        const pt3 = await toPageCoords(page, 200, 300);
        await page.mouse.click(pt3.x, pt3.y);
        await page.waitForTimeout(200);
        await page.keyboard.type('Issue note');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        const issueStroke = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            // Find the last textbox that has markupType 'issue'
            for (let i = objs.length - 1; i >= 0; i--) {
                if (objs[i].type === 'textbox' && objs[i].markupType === 'issue') {
                    return objs[i].stroke || null;
                }
            }
            return null;
        });
        assert(issueStroke === '#ff4444',
            `Issue-type note stroke is red #ff4444 (got "${issueStroke}")`);

        // Reset markup type to 'note' for cleanup
        await page.keyboard.press('1');

        // ── Group 12: Save / reload round-trip ───────────────────────────────
        console.log('\n  -- Group 12: Save / Reload Round-trip --');

        // Place a final fresh note with typed content
        await activateStickyNote(page);
        const pt4 = await toPageCoords(page, 80, 400);
        await page.mouse.click(pt4.x, pt4.y);
        await page.waitForTimeout(200);
        await page.keyboard.type('Persists');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        // Save to server
        await page.evaluate(async () => {
            const fc  = window.app.canvas.fabricCanvas;
            const json = fc.toJSON();
            await fetch(`/api/documents/${window.app.docId}/markups`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ page: 0, markups: json }),
            });
        });
        await page.waitForTimeout(300);

        // Reload and verify the sticky note survived
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        const noteAfterReload = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            return objs.some(o => o.type === 'textbox' && !!o.markupType);
        });
        assert(noteAfterReload, 'Sticky note persists after page reload');

        const mtAfterReload = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const note = objs.find(o => o.type === 'textbox' && !!o.markupType);
            return note?.markupType || null;
        });
        assert(!!mtAfterReload,
            `markupType preserved after reload (got "${mtAfterReload}")`);

        const bgAfterReload = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const note = objs.find(o => o.type === 'textbox' && !!o.markupType);
            return note?.backgroundColor || null;
        });
        assert(bgAfterReload === '#fffde7',
            `backgroundColor preserved after reload (got "${bgAfterReload}")`);

        const noteTextAfterReload = await page.evaluate(() => {
            const objs = window.app?.canvas?.fabricCanvas?.getObjects() || [];
            const note = objs.find(o => o.type === 'textbox' && !!o.markupType
                && o.text === 'Persists');
            return note?.text || null;
        });
        assert(noteTextAfterReload === 'Persists',
            `Note text preserved after reload (got "${noteTextAfterReload}")`);

    } finally {
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
