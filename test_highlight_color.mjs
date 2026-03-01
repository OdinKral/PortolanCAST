/**
 * PortolanCAST — Highlight Color Fix Verification
 *
 * Tests that the properties panel correctly updates the fill (not just stroke)
 * on highlighter objects when the markup type or color picker changes.
 *
 * Uses direct Fabric.js object creation (same pattern as other test suites)
 * rather than mouse simulation, which is more reliable and faster.
 *
 * Run via Windows Chrome:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_highlight_color.mjs"
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

        // Clear canvas state from any previous test runs
        await page.evaluate(() => {
            window.app.canvas.pageMarkups.clear();
            window.app.canvas.fabricCanvas.clear();
        });

        // ── Test 1-3: Newly created highlight has correct defaults ────────────
        console.log('\n  -- Group 1: Initial Highlight State --');

        const initial = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            // Create a highlight the same way the toolbar does —
            // a filled rect with opacity 0.25 and no stroke
            const hl = new fabric.Rect({
                left: 50, top: 50, width: 120, height: 40,
                fill: '#aaaaaa',   // MARKUP_COLORS.note (the default)
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
            fc.setActiveObject(hl);
            fc.renderAll();
            return { fill: hl.fill, opacity: hl.opacity, markupType: hl.markupType };
        });

        assert(initial.fill === '#aaaaaa', `Initial fill is #aaaaaa (note/gray) — got "${initial.fill}"`);
        assert(initial.opacity === 0.25,   `Opacity is 0.25 — got ${initial.opacity}`);
        assert(initial.markupType === 'note', `markupType is 'note' — got "${initial.markupType}"`);

        // ── Test 4-5: Type dropdown updates fill ─────────────────────────────
        console.log('\n  -- Group 2: Markup Type Change Updates Fill --');

        // Trigger the properties panel to recognise the selected object,
        // then fire the type change event
        await page.waitForTimeout(200);
        await page.evaluate(() => {
            // The properties panel listens for canvas:selection:created
            // Simulate by directly dispatching the type change on the dropdown
            const sel = document.getElementById('prop-markup-type');
            if (sel) {
                sel.value = 'issue';
                sel.dispatchEvent(new Event('change'));
            }
        });
        await page.waitForTimeout(200);

        const afterType = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getActiveObject();
            return obj ? { fill: obj.fill, markupType: obj.markupType } : null;
        });

        assert(
            afterType && afterType.fill === '#ff4444',
            `Fill updates to #ff4444 (red/issue) after type change — got "${afterType?.fill}"`
        );
        assert(
            afterType && afterType.markupType === 'issue',
            `markupType updates to 'issue' — got "${afterType?.markupType}"`
        );

        // ── Test 6: Stroke color picker also updates fill ─────────────────────
        console.log('\n  -- Group 3: Color Picker Updates Fill --');

        const testColor = '#33cc77';
        await page.evaluate((color) => {
            const picker = document.getElementById('prop-stroke-color');
            if (picker) {
                picker.value = color;
                picker.dispatchEvent(new Event('input'));
            }
        }, testColor);
        await page.waitForTimeout(200);

        const afterPicker = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getActiveObject();
            return obj ? { fill: obj.fill } : null;
        });

        assert(
            afterPicker && afterPicker.fill === testColor,
            `Fill updates to ${testColor} after color picker input — got "${afterPicker?.fill}"`
        );

        // ── Test 7: Normal rect fill stays 'transparent' (no regression) ──────
        console.log('\n  -- Group 4: Regression — Normal Rect Unaffected --');

        const rectResult = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const rect = new fabric.Rect({
                left: 200, top: 200, width: 80, height: 60,
                fill: 'transparent',
                stroke: '#aaaaaa',
                strokeWidth: 2,
                selectable: true,
            });
            window.app.canvas.stampDefaults(rect, { markupType: 'note', preserveColor: true });
            fc.add(rect);
            fc.setActiveObject(rect);
            fc.renderAll();

            const sel = document.getElementById('prop-markup-type');
            if (sel) { sel.value = 'issue'; sel.dispatchEvent(new Event('change')); }

            return { fill: rect.fill, stroke: rect.stroke };
        });
        await page.waitForTimeout(200);

        assert(
            rectResult.fill === 'transparent',
            `Normal rect fill stays 'transparent' after type change — got "${rectResult.fill}"`
        );

    } finally {
        await page.evaluate(() => {
            window.app.canvas.fabricCanvas.clear();
            window.app.canvas.pageMarkups.clear();
        });
        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
