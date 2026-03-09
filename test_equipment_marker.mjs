/**
 * PortolanCAST — Equipment Marker Tool Tests
 *
 * Purpose:
 *   Validates the Equipment Marker tool: hotkey activation, click-to-place
 *   marker pin, panel lifecycle (open/close/cancel), entity search/filter,
 *   entity linking via API, entity creation with 409 conflict handling,
 *   and marker serialization persistence.
 *
 * Groups:
 *   Group 1: Tool Activation (5 tests)
 *   Group 2: Marker Placement (6 tests)
 *   Group 3: Panel Lifecycle (5 tests)
 *   Group 4: Entity Search (5 tests)
 *   Group 5: Entity Linking (6 tests)
 *   Group 6: Entity Creation (5 tests)
 *   Group 7: Serialization (4 tests)
 *
 * Design:
 *   - Per-run timestamp prefix on tag numbers prevents UNIQUE collisions.
 *   - Entities created during the run are cleaned up in finally.
 *   - Uses evaluate() for DOM clicks to avoid Playwright auto-scroll issues.
 *   - Canvas clicks use toPageCoords() for proper Fabric coordinate mapping.
 *
 * Run:
 *   node test_equipment_marker.mjs
 *
 * Author: PortolanCAST
 * Version: 0.2.0
 * Date: 2026-03-09
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID   = 1;
let passed = 0;
let failed = 0;

// Per-run unique suffix prevents UNIQUE constraint collisions between runs.
const RUN_TAG = `${Date.now()}`;

// Tracks entity IDs for cleanup in finally.
const createdEntityIds = [];

function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else           { failed++; console.log(`  FAIL: ${msg}`); }
}

// =============================================================================
// COORDINATE HELPERS — same pattern as test_sticky_note.mjs
// =============================================================================

async function getCanvasInfo(page) {
    return page.evaluate(() => {
        const el = document.getElementById('fabric-canvas');
        const rect = el.getBoundingClientRect();
        return { x: rect.left, y: rect.top, scale: window.app.viewer.zoom / 100 };
    });
}

async function toPageCoords(page, naturalX, naturalY) {
    const info = await getCanvasInfo(page);
    return { x: info.x + naturalX * info.scale, y: info.y + naturalY * info.scale };
}

// =============================================================================
// API HELPERS
// =============================================================================

async function apiCreateEntity(page, tag, extra = {}) {
    const data = await page.evaluate(async ({ tag, extra }) => {
        const r = await fetch('/api/entities', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag_number: tag, ...extra }),
        });
        return { status: r.status, body: await r.json() };
    }, { tag, extra });
    if (data.status === 200 && data.body.id) {
        createdEntityIds.push(data.body.id);
    }
    return data;
}

async function apiDeleteEntity(page, entityId) {
    await page.evaluate(async (id) => {
        await fetch(`/api/entities/${id}`, { method: 'DELETE' });
    }, entityId);
}

// =============================================================================
// SETUP HELPERS
// =============================================================================

/** Ensure the Markup tab is active (equipment-marker button lives there) */
async function openMarkupTab(page) {
    await page.evaluate(() => {
        document.querySelector('.toolbar-tab[data-tab="markup"]')?.click();
    });
    await page.waitForTimeout(100);
}

/** Place an equipment marker at natural coords and wait for panel to open */
async function placeMarkerAndWaitForPanel(page, natX, natY) {
    await page.keyboard.press('m');
    await page.waitForTimeout(200);

    const pt = await toPageCoords(page, natX, natY);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(500);

    // Wait for panel to appear
    await page.waitForFunction(() => {
        const panel = document.getElementById('em-panel');
        return panel && panel.style.display !== 'none';
    }, { timeout: 3000 }).catch(() => {});
}

/** Check if panel is open */
async function isPanelOpen(page) {
    return page.evaluate(() => {
        const panel = document.getElementById('em-panel');
        return panel && panel.style.display !== 'none';
    });
}

/** Clean up all equipment markers from canvas */
async function removeAllMarkers(page) {
    await page.evaluate(() => {
        const fc = window.app.canvas.fabricCanvas;
        fc.getObjects().filter(o => o.markupType === 'equipment-marker').forEach(m => fc.remove(m));
        fc.renderAll();
    });
}

async function run() {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to editor with a document loaded
    await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
    // Wait for app to initialize
    await page.waitForFunction(() => window.app && window.app.canvas && window.app.equipmentMarkerPanel);
    await page.waitForTimeout(500);

    // Ensure markup tab is open
    await openMarkupTab(page);

    try {
        // =================================================================
        // GROUP 1: Tool Activation (5 tests)
        // =================================================================
        console.log('\nGroup 1: Tool Activation');

        // 1.1 M hotkey activates equipment-marker tool
        await page.keyboard.press('m');
        await page.waitForTimeout(200);
        const drawingMode = await page.evaluate(() => {
            const wrapper = window.app.canvas.fabricCanvas.wrapperEl;
            return wrapper?.classList.contains('drawing-active');
        });
        assert(drawingMode === true, '1.1 M hotkey activates drawing mode');

        // 1.2 Toolbar button gets active class
        const btnActive = await page.evaluate(() =>
            document.querySelector('[data-tool="equipment-marker"]')?.classList.contains('active')
        );
        assert(btnActive === true, '1.2 Equipment marker button shows active state');

        // 1.3 Pressing Escape deactivates tool (reverts to select)
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        const toolAfterEsc = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(toolAfterEsc === 'select' || toolAfterEsc === null, '1.3 Escape reverts to select tool');

        // 1.4 Toolbar button click activates tool
        await page.evaluate(() =>
            document.querySelector('[data-tool="equipment-marker"]').click()
        );
        await page.waitForTimeout(200);
        const drawingMode2 = await page.evaluate(() => {
            const wrapper = window.app.canvas.fabricCanvas.wrapperEl;
            return wrapper?.classList.contains('drawing-active');
        });
        assert(drawingMode2 === true, '1.4 Button click activates drawing mode');

        // 1.5 Tool button exists in the DOM with correct title
        const btnTitle = await page.evaluate(() =>
            document.querySelector('[data-tool="equipment-marker"]')?.title
        );
        assert(btnTitle === 'Equipment Marker (M)', '1.5 Button has correct title');

        // Reset to select for next group
        await page.keyboard.press('v');
        await page.waitForTimeout(100);

        // =================================================================
        // GROUP 2: Marker Placement (6 tests)
        // =================================================================
        console.log('\nGroup 2: Marker Placement');

        // Place a marker at natural coords (150, 150) — center-ish of the page
        await placeMarkerAndWaitForPanel(page, 150, 150);

        // 2.1 A Group was added to the canvas
        const markerInfo = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const marker = fc.getObjects().find(o => o.markupType === 'equipment-marker');
            if (!marker) return null;
            return {
                type: marker.type,
                markupType: marker.markupType,
                markupId: marker.markupId,
                childCount: marker._objects ? marker._objects.length : 0,
                childTypes: marker._objects ? marker._objects.map(o => o.type) : [],
            };
        });
        assert(markerInfo !== null, '2.1 Equipment marker Group added to canvas');

        // 2.2 Group has correct markupType
        assert(markerInfo?.markupType === 'equipment-marker', '2.2 markupType is equipment-marker');

        // 2.3 Group has a markupId (UUID from stampDefaults)
        assert(markerInfo?.markupId && markerInfo.markupId.length > 8, '2.3 markupId UUID assigned');

        // 2.4 Group has Circle + IText children
        assert(markerInfo?.childCount === 2, '2.4 Marker Group has 2 children (Circle + IText)');

        // 2.5 Children are circle and i-text types (Fabric.js 6 uses lowercase)
        const hasCircle = markerInfo?.childTypes?.includes('circle');
        const hasText = markerInfo?.childTypes?.includes('i-text');
        assert(hasCircle && hasText, '2.5 Children are circle + i-text');

        // 2.6 Tool reverted to select after placement (one-shot)
        const toolAfterPlace = await page.evaluate(() => window.app.toolbar.activeTool);
        assert(toolAfterPlace === 'select', '2.6 Tool reverts to select after placement');

        // =================================================================
        // GROUP 3: Panel Lifecycle (5 tests)
        // =================================================================
        console.log('\nGroup 3: Panel Lifecycle');

        // 3.1 Panel opened after marker placement (from Group 2)
        const panelVisible = await isPanelOpen(page);
        assert(panelVisible === true, '3.1 Panel opens after marker placement');

        // 3.2 Search input is focused
        await page.waitForTimeout(200);
        const searchFocused = await page.evaluate(() =>
            document.activeElement?.id === 'em-search'
        );
        assert(searchFocused === true, '3.2 Search input auto-focused');

        // 3.3 Close button closes panel
        await page.evaluate(() => document.getElementById('em-close').click());
        await page.waitForTimeout(100);
        const panelAfterClose = await isPanelOpen(page);
        assert(panelAfterClose === false, '3.3 Close button hides panel');

        // 3.4 Cancelling removes the placeholder marker (label was still "...")
        const markerRemovedAfterCancel = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            return fc.getObjects().filter(o => o.markupType === 'equipment-marker').length === 0;
        });
        assert(markerRemovedAfterCancel === true, '3.4 Cancel removes unlinked placeholder marker');

        // 3.5 Escape key closes panel
        await placeMarkerAndWaitForPanel(page, 200, 200);
        const panelOpen2 = await isPanelOpen(page);
        if (panelOpen2) {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(100);
        }
        const panelAfterEsc = await isPanelOpen(page);
        assert(panelAfterEsc === false, '3.5 Escape key closes panel');

        // Clean up leftover markers
        await removeAllMarkers(page);

        // =================================================================
        // GROUP 4: Entity Search (5 tests)
        // =================================================================
        console.log('\nGroup 4: Entity Search');

        // Create test entities for search
        const searchTag1 = `EM-SEARCH-A-${RUN_TAG}`;
        const searchTag2 = `EM-SEARCH-B-${RUN_TAG}`;
        const searchTag3 = `EM-PUMP-C-${RUN_TAG}`;
        await apiCreateEntity(page, searchTag1, { equip_type: 'AHU' });
        await apiCreateEntity(page, searchTag2, { equip_type: 'RTU' });
        await apiCreateEntity(page, searchTag3, { equip_type: 'Pump' });

        // Place a marker and open panel
        await placeMarkerAndWaitForPanel(page, 250, 150);

        // 4.1 Results container populated on open
        const resultCount = await page.evaluate(() => {
            const results = document.getElementById('em-results');
            return results ? results.querySelectorAll('.em-result-row').length : 0;
        });
        assert(resultCount >= 3, '4.1 Entity results populated on panel open');

        // 4.2 Search filters by tag number — use evaluate to set value + dispatch input
        await page.evaluate(() => {
            const el = document.getElementById('em-search');
            el.value = 'EM-SEARCH';
            el.dispatchEvent(new Event('input'));
        });
        await page.waitForTimeout(100);
        const filteredCount = await page.evaluate(() => {
            const results = document.getElementById('em-results');
            return results ? results.querySelectorAll('.em-result-row').length : 0;
        });
        assert(filteredCount >= 2, '4.2 Search filters entities by tag');

        // 4.3 Search filters by type
        await page.evaluate(() => {
            const el = document.getElementById('em-search');
            el.value = 'Pump';
            el.dispatchEvent(new Event('input'));
        });
        await page.waitForTimeout(100);
        const pumpCount = await page.evaluate(() => {
            const results = document.getElementById('em-results');
            return results ? results.querySelectorAll('.em-result-row').length : 0;
        });
        assert(pumpCount >= 1, '4.3 Search filters entities by type');

        // 4.4 Empty search shows all entities
        await page.evaluate(() => {
            const el = document.getElementById('em-search');
            el.value = '';
            el.dispatchEvent(new Event('input'));
        });
        await page.waitForTimeout(100);
        const allCount = await page.evaluate(() => {
            const results = document.getElementById('em-results');
            return results ? results.querySelectorAll('.em-result-row').length : 0;
        });
        assert(allCount >= 3, '4.4 Empty search shows all entities');

        // 4.5 No match shows "No entities found"
        await page.evaluate(() => {
            const el = document.getElementById('em-search');
            el.value = 'ZZZZNONEXISTENT';
            el.dispatchEvent(new Event('input'));
        });
        await page.waitForTimeout(100);
        const noResults = await page.evaluate(() => {
            const results = document.getElementById('em-results');
            const msg = results?.querySelector('.em-no-results');
            return msg ? msg.textContent : null;
        });
        assert(noResults === 'No entities found', '4.5 No match shows empty state message');

        // Close panel and clean up
        await page.evaluate(() => document.getElementById('em-close').click());
        await page.waitForTimeout(100);
        await removeAllMarkers(page);

        // =================================================================
        // GROUP 5: Entity Linking (6 tests)
        // =================================================================
        console.log('\nGroup 5: Entity Linking');

        // Create a specific entity to link
        const linkTag = `EM-LINK-${RUN_TAG}`;
        const linkResult = await apiCreateEntity(page, linkTag, { equip_type: 'VAV' });
        const linkEntityId = linkResult.body.id;

        // Place a marker and open panel
        await placeMarkerAndWaitForPanel(page, 300, 200);

        // Search for the link entity
        await page.evaluate((tag) => {
            const el = document.getElementById('em-search');
            el.value = tag;
            el.dispatchEvent(new Event('input'));
        }, linkTag);
        await page.waitForTimeout(200);

        // 5.1 Result row shows correct tag
        const rowTag = await page.evaluate((tag) => {
            const rows = document.querySelectorAll('.em-result-row');
            for (const row of rows) {
                const tagEl = row.querySelector('.em-result-tag');
                if (tagEl && tagEl.textContent === tag) return tagEl.textContent;
            }
            return null;
        }, linkTag);
        assert(rowTag === linkTag, '5.1 Result row shows entity tag');

        // Click the result row to link
        await page.evaluate((tag) => {
            const rows = document.querySelectorAll('.em-result-row');
            for (const row of rows) {
                const tagEl = row.querySelector('.em-result-tag');
                if (tagEl && tagEl.textContent === tag) {
                    row.click();
                    return;
                }
            }
        }, linkTag);
        await page.waitForTimeout(500);

        // 5.2 Panel closes after linking
        const panelAfterLink = await isPanelOpen(page);
        assert(panelAfterLink === false, '5.2 Panel closes after entity linking');

        // 5.3 Marker label updated to entity tag_number
        const linkedMarkerInfo = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const marker = fc.getObjects().find(o => o.markupType === 'equipment-marker');
            if (!marker || !marker._objects) return null;
            const label = marker._objects.find(o => o.type === 'i-text');
            return {
                labelText: label ? label.text : null,
                entityId: marker.entityId,
            };
        });
        assert(linkedMarkerInfo?.labelText === linkTag, '5.3 Marker label updated to entity tag');

        // 5.4 entityId set on marker Group
        assert(linkedMarkerInfo?.entityId === linkEntityId, '5.4 entityId set on marker');

        // 5.5 Markup-entity link exists in API
        const linkCheck = await page.evaluate(async () => {
            const fc = window.app.canvas.fabricCanvas;
            const marker = fc.getObjects().find(o => o.markupType === 'equipment-marker');
            if (!marker) return null;
            const docId = window.app.docId;
            const resp = await fetch(
                `/api/documents/${docId}/markup-entities/${encodeURIComponent(marker.markupId)}`
            );
            if (!resp.ok) return null;
            const data = await resp.json();
            return data.entity;
        });
        assert(linkCheck && linkCheck.tag_number === linkTag, '5.5 Markup-entity link persisted in API');

        // 5.6 Selecting the marker shows entity section in Properties panel
        await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            const marker = fc.getObjects().find(o => o.markupType === 'equipment-marker');
            if (marker) {
                fc.setActiveObject(marker);
                // Trigger selection event so properties panel updates
                fc.fire('selection:created', { selected: [marker] });
            }
        });
        await page.waitForTimeout(500);
        const entitySectionVisible = await page.evaluate(() => {
            const section = document.getElementById('entity-section');
            return section && section.style.display !== 'none';
        });
        assert(entitySectionVisible === true, '5.6 Properties panel shows entity section for marker');

        // Keep the linked marker for serialization tests — deselect first
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);

        // =================================================================
        // GROUP 6: Entity Creation (5 tests)
        // =================================================================
        console.log('\nGroup 6: Entity Creation');

        // Place a new marker for create flow
        await placeMarkerAndWaitForPanel(page, 400, 250);

        const createTag = `EM-NEW-${RUN_TAG}`;

        // 6.1 Fill tag and type, click Create & Link
        await page.evaluate((tag) => {
            document.getElementById('em-new-tag').value = tag;
        }, createTag);
        await page.evaluate(() => {
            const sel = document.getElementById('em-new-type');
            if (sel) sel.value = 'Chiller';
        });
        await page.evaluate(() => document.getElementById('em-create-btn').click());
        await page.waitForTimeout(1000);

        // Check if entity was created
        const newEntityCheck = await page.evaluate(async (tag) => {
            const resp = await fetch('/api/entities');
            if (!resp.ok) return null;
            const data = await resp.json();
            const entities = data.entities || data;
            return entities.find(e => e.tag_number === tag);
        }, createTag);
        assert(newEntityCheck !== null, '6.1 New entity created via Create & Link');
        if (newEntityCheck) createdEntityIds.push(newEntityCheck.id);

        // 6.2 New entity has correct type
        assert(newEntityCheck?.equip_type === 'Chiller', '6.2 New entity has correct equip_type');

        // 6.3 Panel closed after create+link
        const panelAfterCreate = await isPanelOpen(page);
        assert(panelAfterCreate === false, '6.3 Panel closes after create + link');

        // 6.4 Marker label updated to new entity tag
        const createMarkerLabel = await page.evaluate((tag) => {
            const fc = window.app.canvas.fabricCanvas;
            const markers = fc.getObjects().filter(o => o.markupType === 'equipment-marker');
            for (const m of markers) {
                const label = m._objects?.find(o => o.type === 'i-text');
                if (label && label.text === tag) return label.text;
            }
            return null;
        }, createTag);
        assert(createMarkerLabel === createTag, '6.4 Marker label shows new entity tag');

        // 6.5 409 conflict: creating duplicate tag links to existing
        await placeMarkerAndWaitForPanel(page, 100, 350);
        await page.evaluate((tag) => {
            document.getElementById('em-new-tag').value = tag;
        }, createTag); // duplicate tag
        await page.evaluate(() => document.getElementById('em-create-btn').click());
        await page.waitForTimeout(1500); // includes 500ms delay for conflict message

        const conflictMarkerLabel = await page.evaluate((tag) => {
            const fc = window.app.canvas.fabricCanvas;
            const markers = fc.getObjects().filter(o => o.markupType === 'equipment-marker');
            const last = markers[markers.length - 1];
            const label = last?._objects?.find(o => o.type === 'i-text');
            return label ? label.text : null;
        }, createTag);
        assert(conflictMarkerLabel === createTag, '6.5 409 conflict links to existing entity');

        // =================================================================
        // GROUP 7: Serialization (4 tests)
        // =================================================================
        console.log('\nGroup 7: Serialization');

        // Force a save
        await page.evaluate(() => window.app.canvas.onContentChange());
        await page.waitForTimeout(500);

        // Get marker count before navigation
        const markerCountBefore = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            return fc.getObjects().filter(o => o.markupType === 'equipment-marker').length;
        });

        // Navigate away and back to trigger save/load cycle
        const totalPages = await page.evaluate(() => window.app.viewer.totalPages);
        if (totalPages > 1) {
            await page.evaluate(() => window.app.viewer.goToPage(1));
            await page.waitForTimeout(500);
            await page.evaluate(() => window.app.viewer.goToPage(0));
            await page.waitForTimeout(500);
        }

        // 7.1 Markers survive page navigation (save/load)
        const markerCountAfter = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            return fc.getObjects().filter(o => o.markupType === 'equipment-marker').length;
        });
        assert(markerCountAfter === markerCountBefore, '7.1 Markers survive page navigation');

        // 7.2 markupType preserved through serialization
        const serializedTypes = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            return fc.getObjects().filter(o => o.markupType === 'equipment-marker').map(m => m.markupType);
        });
        assert(serializedTypes.length > 0 && serializedTypes.every(t => t === 'equipment-marker'),
            '7.2 markupType persists through save/load');

        // 7.3 entityId preserved through serialization
        const serializedEntityIds = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            return fc.getObjects().filter(o => o.markupType === 'equipment-marker')
                .map(m => m.entityId).filter(Boolean);
        });
        assert(serializedEntityIds.length > 0, '7.3 entityId persists through save/load');

        // 7.4 Label text preserved through serialization
        const serializedLabels = await page.evaluate(() => {
            const fc = window.app.canvas.fabricCanvas;
            return fc.getObjects().filter(o => o.markupType === 'equipment-marker').map(m => {
                const label = m._objects?.find(o => o.type === 'i-text');
                return label ? label.text : null;
            }).filter(Boolean);
        });
        assert(serializedLabels.length > 0 && serializedLabels.every(l => l !== '...'),
            '7.4 Label text persists through save/load');

    } finally {
        // =====================================================================
        // CLEANUP
        // =====================================================================
        console.log('\nCleanup...');

        // Remove all equipment markers from canvas
        try {
            await page.evaluate(() => {
                const fc = window.app.canvas.fabricCanvas;
                fc.getObjects().filter(o => o.markupType === 'equipment-marker').forEach(m => fc.remove(m));
                fc.renderAll();
                window.app.canvas.onContentChange();
            });
            await page.waitForTimeout(300);
        } catch (_) {}

        // Delete test entities
        for (const id of createdEntityIds) {
            try { await apiDeleteEntity(page, id); } catch (_) {}
        }

        await browser.close();
    }

    // =====================================================================
    // SUMMARY
    // =====================================================================
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Equipment Marker Tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
    console.log(`${'='.repeat(50)}`);

    if (failed > 0) process.exit(1);
}

run().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
