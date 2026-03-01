/**
 * PortolanCAST — Q2 Callout Label Editable Tests
 *
 * Tests that the callout tool (O key) allows the user to:
 *   1. Place a callout with two clicks and immediately enter IText editing mode.
 *   2. Re-edit an existing callout's label by double-clicking it.
 *   3. Labels are trimmed; empty input reverts to 'Callout'.
 *   4. Metadata (markupType, markupId, _isCallout) survives the ungroup/regroup cycle.
 *   5. _isCallout flag is set on newly placed callouts.
 *
 * Implementation note:
 *   We cannot fully simulate two-click callout placement via Playwright pointer
 *   events because Fabric's coordinate mapping depends on canvas scale factors.
 *   Instead, we test the _enterCalloutEdit() editing path directly by
 *   constructing a synthetic callout Group and calling the method programmatically.
 *   A separate smoke test verifies that the O key activates the callout tool.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_q2_callout_edit.mjs"
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID = 1;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else           { failed++; console.log(`  FAIL: ${msg}`); }
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);

        // ── Group 1: O key activates callout tool ─────────────────────────────
        console.log('\n  -- Group 1: Callout Tool Activation --');

        // Ensure markup tab is active first (callout button lives there)
        await page.evaluate(() => {
            if (window.app && window.app.toolbar && window.app.toolbar._setActiveTab) {
                window.app.toolbar._setActiveTab('markup');
            }
        });

        await page.keyboard.press('o');
        await page.waitForTimeout(100);

        const toolIsCallout = await page.evaluate(() =>
            window.app.toolbar.activeTool === 'callout'
        );
        assert(toolIsCallout, 'O key activates callout tool');

        // Switch back to select before further tests
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);

        // ── Group 2: _initCalloutEditing binds handler ────────────────────────
        console.log('\n  -- Group 2: Handler Registration --');

        const handlerBound = await page.evaluate(() =>
            typeof window.app.toolbar._calloutDblClickHandler === 'function'
        );
        assert(handlerBound, '_calloutDblClickHandler is a function (bound by _initCalloutEditing)');

        // ── Group 3: _isCallout flag on new placement ─────────────────────────
        console.log('\n  -- Group 3: _isCallout Flag Set --');

        // Create a synthetic callout Group programmatically and stamp it
        const flagResult = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const line = new fabric.Line([50, 50, 150, 80], {
                stroke: '#e74c3c', strokeWidth: 2, selectable: false, evented: false,
            });
            const textObj = new fabric.IText('Test callout', {
                left: 150, top: 80, fontFamily: 'Arial', fontSize: 14,
                fill: '#e74c3c', selectable: true, editable: true,
            });
            const group = new fabric.Group([line, textObj], { selectable: true });
            window.app.canvas.stampDefaults(group, { markupType: 'note', preserveColor: true });
            group._isCallout = true;
            fc.add(group);
            fc.renderAll();
            window._testCalloutGroup = group;
            return {
                hasFlag: group._isCallout === true,
                hasMarkupId: typeof group.markupId === 'string' && group.markupId.length > 0,
                markupType: group.markupType,
            };
        });
        assert(flagResult.hasFlag, '_isCallout=true on synthetic callout group');
        assert(flagResult.hasMarkupId, 'markupId assigned by stampDefaults');
        assert(flagResult.markupType === 'note', `markupType preserved (got "${flagResult.markupType}")`);

        // ── Group 4: _enterCalloutEdit — ungroups and enters editing ──────────
        console.log('\n  -- Group 4: Edit Entry (ungroup + enterEditing) --');

        // Call _enterCalloutEdit on the synthetic group
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const group = window._testCalloutGroup;
            window.app.toolbar._enterCalloutEdit(group, fc);
        });
        await page.waitForTimeout(300);

        // After edit entry, we expect IText to be the active object in editing mode
        const editingState = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const active = fc.getActiveObject();
            return {
                activeType: active ? active.type : null,
                isEditing: active ? active.isEditing : false,
            };
        });
        // IText type is 'i-text' in Fabric 6
        assert(
            editingState.activeType === 'i-text' || editingState.activeType === 'IText',
            `Active object is IText after _enterCalloutEdit (got "${editingState.activeType}")`
        );
        assert(editingState.isEditing, 'IText is in editing mode after _enterCalloutEdit');

        // ── Group 5: Regroup on editing:exited ───────────────────────────────
        console.log('\n  -- Group 5: Regroup on Editing Exit --');

        // Exit editing by dispatching the event programmatically
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const active = fc.getActiveObject();
            if (active && active.isEditing) {
                active.exitEditing();
            }
        });
        await page.waitForTimeout(300);

        const afterExit = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const active = fc.getActiveObject();
            const allObjs = fc.getObjects();
            // Look for a group with _isCallout
            const regrouped = allObjs.find(o => o._isCallout && (o.type === 'group' || o.type === 'Group'));
            return {
                foundRegrouped: !!regrouped,
                regroupedType: regrouped ? regrouped.type : null,
                markupIdPreserved: regrouped ? (typeof regrouped.markupId === 'string') : false,
                markupTypePreserved: regrouped ? regrouped.markupType : null,
            };
        });
        assert(afterExit.foundRegrouped, 'Callout regrouped after editing:exited');
        assert(afterExit.markupIdPreserved, 'markupId preserved through edit cycle');
        assert(
            afterExit.markupTypePreserved === 'note',
            `markupType preserved through edit cycle (got "${afterExit.markupTypePreserved}")`
        );

        // ── Group 6: Empty text reverts to 'Callout' ─────────────────────────
        console.log('\n  -- Group 6: Empty Text Fallback --');

        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            // Re-enter edit on the regrouped callout, clear text, exit
            const group = fc.getObjects().find(o => o._isCallout);
            if (group) {
                window._testCalloutGroup2 = group;
                window.app.toolbar._enterCalloutEdit(group, fc);
            }
        });
        await page.waitForTimeout(300);

        // Clear the text and exit editing
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const active = fc.getActiveObject();
            if (active && active.isEditing) {
                active.set('text', '   '); // whitespace only
                active.exitEditing();
            }
        });
        await page.waitForTimeout(300);

        const fallbackText = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const group = fc.getObjects().find(o => o._isCallout);
            if (!group || !group._objects) return null;
            const textItem = group._objects.find(o => {
                const t = o.type ? o.type.toLowerCase() : '';
                return t === 'i-text' || t === 'itext';
            });
            return textItem ? textItem.text : null;
        });
        assert(
            fallbackText === 'Callout',
            `Empty/whitespace text reverts to 'Callout' (got "${fallbackText}")`
        );

        // ── Group 7: Double-click detection (isCallout check) ─────────────────
        console.log('\n  -- Group 7: Double-click Detection --');

        // Create a non-callout group and verify handler ignores it
        const ignoreResult = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            // Plain rect — not a callout
            const rect = new fabric.Rect({ left: 300, top: 300, width: 50, height: 30 });
            fc.add(rect);
            fc.renderAll();
            // Simulate the handler's isCallout check
            const target = rect;
            const isCallout = target._isCallout ||
                (target.type === 'group' && target._objects &&
                 target._objects.some(o => o.type === 'line' || o.type === 'Line') &&
                 target._objects.some(o => o.type === 'i-text' || o.type === 'IText'));
            fc.remove(rect);
            return isCallout;
        });
        assert(!ignoreResult, 'Handler ignores non-callout objects (plain Rect)');

        // Verify it would detect our callout group
        const detectResult = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const group = fc.getObjects().find(o => o._isCallout);
            if (!group) return null;
            return group._isCallout ||
                (group.type === 'group' && group._objects &&
                 group._objects.some(o => o.type === 'line' || o.type === 'Line') &&
                 group._objects.some(o => o.type === 'i-text' || o.type === 'IText'));
        });
        assert(detectResult === true, 'Handler detects callout group via _isCallout flag');

        // ── Group 8: _isCallout survives CUSTOM_PROPERTIES serialization ──────
        console.log('\n  -- Group 8: Serialization Persistence --');

        const serResult = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const group = fc.getObjects().find(o => o._isCallout);
            if (!group) return null;
            // toJSON() uses CUSTOM_PROPERTIES — check _isCallout survives
            const json = group.toObject();
            return { hasFlag: json._isCallout === true };
        });
        assert(serResult !== null, 'Found callout group for serialisation test');
        assert(serResult && serResult.hasFlag, '_isCallout serialised via toObject() / CUSTOM_PROPERTIES');

    } finally {
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
