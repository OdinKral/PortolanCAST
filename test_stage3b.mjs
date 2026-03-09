/**
 * PortolanCAST — Stage 3B: Equipment Tab + Entity Detail Modal Tests
 *
 * Purpose:
 *   Validates Stage 3B: Equipment tab list (EntityManager), entity detail
 *   modal overlay (EntityModal), filter/search functionality, CRUD editing
 *   in the modal, and integration with the properties panel.
 *
 * Groups:
 *   Group 1: Equipment Tab (8 tests)      — tab button, list rendering, filters
 *   Group 2: Entity Modal Display (8 tests) — overlay, header, fields, log, close
 *   Group 3: Entity Modal Editing (8 tests) — save, log add, delete, error handling
 *   Group 4: Integration (6 tests)         — properties ↔ modal ↔ tab cross-wire
 *
 * Design:
 *   - All entity tag numbers use a per-run timestamp prefix to avoid UNIQUE collisions.
 *   - Entities created by the test are deleted in the finally block.
 *   - Uses page.evaluate for button clicks (avoids Playwright scroll side-effects).
 *
 * Run:
 *   cmd.exe /c "cd C:\Users\User1\ClaudeProjects\PortolanCAST && node test_stage3b.mjs"
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-03-07
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8000';
const DOC_ID   = 1;
let passed = 0;
let failed = 0;

// Per-run unique suffix prevents UNIQUE constraint collisions between runs.
const RUN_TAG = `${Date.now()}`;

// Tracks entity IDs created during the run so we can clean up in finally.
const createdEntityIds = [];

function assert(condition, msg) {
    if (condition) { passed++; console.log(`  PASS: ${msg}`); }
    else           { failed++; console.log(`  FAIL: ${msg}`); }
}

// =============================================================================
// HELPERS
// =============================================================================

// Helper: POST a new entity and return { status, body }
async function apiCreateEntity(page, tag, extra = {}) {
    const data = await page.evaluate(async ({ tag, extra }) => {
        const r = await fetch('/api/entities', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag_number: tag, ...extra }),
        });
        return { status: r.status, body: await r.json() };
    }, { tag, extra });
    return data;
}

// Helper: DELETE an entity by ID (best-effort, used in cleanup)
async function apiDeleteEntity(page, entityId) {
    await page.evaluate(async (id) => {
        await fetch(`/api/entities/${id}`, { method: 'DELETE' });
    }, entityId);
}

// Helper: inject a rect onto the canvas with stampDefaults applied, then select it
async function injectAndSelectMarkup(page, overrides = {}) {
    await page.evaluate(({ overrides }) => {
        const fc = window.app.canvas.fabricCanvas;
        const rect = new fabric.Rect({
            left: 80, top: 80, width: 100, height: 80,
            fill: 'transparent', stroke: '#ff0000', strokeWidth: 2,
        });
        window.app.canvas.stampDefaults(rect, overrides);
        fc.add(rect);
        fc.setActiveObject(rect);
        fc.fire('selection:created', { selected: [rect] });
        fc.renderAll();
    }, { overrides });
    await page.waitForTimeout(600); // allow _loadEntitySection() async fetch to complete
}

// Helper: switch to Equipment tab
async function switchToEquipmentTab(page) {
    await page.evaluate(() => {
        document.querySelector('.panel-tab[data-panel="equipment"]').click();
    });
    await page.waitForTimeout(500); // allow refresh() async fetch
}

// Helper: link a markup to an entity via API
async function apiLinkMarkup(page, docId, markupId, entityId, pageNumber = 0) {
    return await page.evaluate(async ({ docId, markupId, entityId, pageNumber }) => {
        const r = await fetch(`/api/documents/${docId}/markup-entities`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markup_id: markupId, entity_id: entityId, page_number: pageNumber }),
        });
        return { status: r.status, body: await r.json() };
    }, { docId, markupId, entityId, pageNumber });
}

// =============================================================================
// MAIN TEST RUNNER
// =============================================================================

async function run() {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page    = await context.newPage();

    try {
        // ── Initial load ──────────────────────────────────────────────────────
        await page.goto(`${BASE_URL}/edit/${DOC_ID}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Clear canvas from any previous test run
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

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 1: Equipment Tab
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 1: Equipment Tab --');

        // 1.1 Equipment tab button exists
        const equipTabExists = await page.evaluate(() =>
            !!document.querySelector('.panel-tab[data-panel="equipment"]')
        );
        assert(equipTabExists, '1.1 Equipment tab button exists in DOM');

        // 1.2 Clicking Equipment tab shows equip panel
        await switchToEquipmentTab(page);
        const equipPanelActive = await page.evaluate(() =>
            document.getElementById('tab-equipment')?.classList.contains('active')
        );
        assert(equipPanelActive, '1.2 Clicking Equipment tab shows equip panel');

        // 1.3 Empty state message when no entities exist
        // First, clean up any leftover entities from previous runs
        await page.evaluate(async () => {
            const resp = await fetch('/api/entities');
            const data = await resp.json();
            for (const e of data.entities) {
                await fetch(`/api/entities/${e.id}`, { method: 'DELETE' });
            }
        });
        await switchToEquipmentTab(page);
        const emptyVisible = await page.evaluate(() => {
            const el = document.getElementById('equip-empty');
            return el && el.style.display !== 'none';
        });
        assert(emptyVisible, '1.3 Empty state: "No entities" message when no entities');

        // Create test entities for remaining tests
        const tag1 = `PRV-${RUN_TAG}-A`;
        const tag2 = `AHU-${RUN_TAG}-B`;
        const tag3 = `PRV-${RUN_TAG}-C`;

        const e1 = await apiCreateEntity(page, tag1, { equip_type: 'Valve', location: 'Bldg-A / Floor-1' });
        createdEntityIds.push(e1.body.id);
        const e2 = await apiCreateEntity(page, tag2, { equip_type: 'AHU', location: 'Bldg-B / Roof' });
        createdEntityIds.push(e2.body.id);
        const e3 = await apiCreateEntity(page, tag3, { equip_type: 'Valve', location: 'Bldg-A / Floor-2' });
        createdEntityIds.push(e3.body.id);

        // 1.4 List populates after creating entities
        await switchToEquipmentTab(page);
        const rowCount = await page.evaluate(() =>
            document.querySelectorAll('#equip-list .equip-row').length
        );
        assert(rowCount >= 3, `1.4 List populates after creating entities (${rowCount} rows)`);

        // 1.5 Filter by tag substring
        await page.evaluate((tag) => {
            const input = document.getElementById('equip-search');
            input.value = tag;
            input.dispatchEvent(new Event('input'));
        }, 'AHU');
        await page.waitForTimeout(200);
        const filteredByTag = await page.evaluate(() =>
            document.querySelectorAll('#equip-list .equip-row').length
        );
        assert(filteredByTag === 1, `1.5 Filter by tag substring "AHU" → ${filteredByTag} row(s)`);
        // Clear filter
        await page.evaluate(() => {
            const input = document.getElementById('equip-search');
            input.value = '';
            input.dispatchEvent(new Event('input'));
        });

        // 1.6 Filter by equip_type dropdown
        await page.evaluate(() => {
            const select = document.getElementById('equip-filter-type');
            select.value = 'Valve';
            select.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(200);
        const filteredByType = await page.evaluate(() =>
            document.querySelectorAll('#equip-list .equip-row').length
        );
        assert(filteredByType === 2, `1.6 Filter by equip_type "Valve" → ${filteredByType} row(s)`);
        // Clear filter
        await page.evaluate(() => {
            const select = document.getElementById('equip-filter-type');
            select.value = '';
            select.dispatchEvent(new Event('change'));
        });

        // 1.7 Row shows tag_number and equip_type
        const rowContent = await page.evaluate(() => {
            const row = document.querySelector('#equip-list .equip-row');
            if (!row) return null;
            return {
                tag: row.querySelector('.equip-tag')?.textContent || '',
                type: row.querySelector('.equip-type')?.textContent || '',
            };
        });
        assert(
            rowContent && rowContent.tag.length > 0 && rowContent.type.length > 0,
            `1.7 Row shows tag="${rowContent?.tag}" type="${rowContent?.type}"`
        );

        // 1.8 Clicking row opens entity modal
        const entityIdForModal = e1.body.id;
        await page.evaluate((id) => {
            const row = document.querySelector(`#equip-list .equip-row[data-entity-id="${id}"]`);
            if (row) row.click();
        }, entityIdForModal);
        await page.waitForTimeout(500);
        const modalVisible = await page.evaluate(() => {
            const modal = document.getElementById('entity-modal');
            return modal && modal.style.display !== 'none';
        });
        assert(modalVisible, '1.8 Clicking row opens entity modal');

        // Close modal for next group
        await page.evaluate(() => {
            document.getElementById('entity-modal-close')?.click();
        });
        await page.waitForTimeout(200);

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 2: Entity Modal — Display
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 2: Entity Modal — Display --');

        // Open modal for entity 1
        await page.evaluate((id) => {
            window.app.entityModal.open(id);
        }, entityIdForModal);
        await page.waitForTimeout(500);

        // 2.1 Modal overlay appears with correct z-index
        const modalStyle = await page.evaluate(() => {
            const modal = document.getElementById('entity-modal');
            if (!modal) return null;
            const cs = getComputedStyle(modal);
            return { display: modal.style.display, zIndex: cs.zIndex };
        });
        assert(
            modalStyle && modalStyle.display !== 'none' && parseInt(modalStyle.zIndex) >= 1000,
            `2.1 Modal overlay visible, z-index=${modalStyle?.zIndex}`
        );

        // 2.2 Header shows entity tag
        const modalTitle = await page.evaluate(() =>
            document.getElementById('entity-modal-title')?.textContent || ''
        );
        assert(modalTitle.includes(tag1.substring(0, 3)), `2.2 Header shows tag: "${modalTitle}"`);

        // 2.3 Fields table shows all 5 editable fields
        const fieldCount = await page.evaluate(() =>
            document.querySelectorAll('.entity-fields-table .entity-field-input').length
        );
        assert(fieldCount === 5, `2.3 Fields table shows ${fieldCount} editable fields`);

        // 2.4 Fields have correct values
        const fieldValues = await page.evaluate(() => {
            const inputs = document.querySelectorAll('.entity-fields-table .entity-field-input');
            return Array.from(inputs).map(i => ({ field: i.dataset.field, value: i.value }));
        });
        const tagField = fieldValues.find(f => f.field === 'tag_number');
        assert(tagField && tagField.value.length > 0, `2.4 Tag number field populated: "${tagField?.value}"`);

        // 2.5 Observations section exists
        const obsSection = await page.evaluate(() => {
            const headers = document.querySelectorAll('.entity-modal-section-header');
            return Array.from(headers).some(h => h.textContent.includes('Observations'));
        });
        assert(obsSection, '2.5 Observations section exists in modal');

        // 2.6 Log section exists
        const logSection = await page.evaluate(() => {
            const headers = document.querySelectorAll('.entity-modal-section-header');
            return Array.from(headers).some(h => h.textContent.includes('Maintenance Log'));
        });
        assert(logSection, '2.6 Log section exists in modal');

        // 2.7 Close button dismisses modal
        await page.evaluate(() => {
            document.getElementById('entity-modal-close')?.click();
        });
        await page.waitForTimeout(200);
        const modalHidden = await page.evaluate(() => {
            const modal = document.getElementById('entity-modal');
            return modal && modal.style.display === 'none';
        });
        assert(modalHidden, '2.7 Close button dismisses modal');

        // 2.8 Escape key dismisses modal
        await page.evaluate((id) => {
            window.app.entityModal.open(id);
        }, entityIdForModal);
        await page.waitForTimeout(500);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        const modalHiddenEsc = await page.evaluate(() => {
            const modal = document.getElementById('entity-modal');
            return modal && modal.style.display === 'none';
        });
        assert(modalHiddenEsc, '2.8 Escape key dismisses modal');

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 3: Entity Modal — Editing
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 3: Entity Modal — Editing --');

        // Open modal for entity 2
        const entityId2 = e2.body.id;
        await page.evaluate((id) => {
            window.app.entityModal.open(id);
        }, entityId2);
        await page.waitForTimeout(500);

        // 3.1 Edit equip_type field and save
        await page.evaluate(() => {
            const inputs = document.querySelectorAll('.entity-fields-table .entity-field-input');
            const typeInput = Array.from(inputs).find(i => i.dataset.field === 'equip_type');
            if (typeInput) typeInput.value = 'RTU';
        });
        // Click Save button
        await page.evaluate(() => {
            const btns = document.querySelectorAll('.entity-modal-body .entity-promote-btn');
            const saveBtn = Array.from(btns).find(b => b.textContent === 'Save');
            if (saveBtn) saveBtn.click();
        });
        await page.waitForTimeout(500);
        // Verify via API
        const updatedEntity = await page.evaluate(async (id) => {
            const r = await fetch(`/api/entities/${id}`);
            return (await r.json()).entity;
        }, entityId2);
        assert(updatedEntity.equip_type === 'RTU', `3.1 Edit equip_type → "${updatedEntity.equip_type}"`);

        // 3.2 Edit location field and save
        await page.evaluate(() => {
            const inputs = document.querySelectorAll('.entity-fields-table .entity-field-input');
            const locInput = Array.from(inputs).find(i => i.dataset.field === 'location');
            if (locInput) locInput.value = 'Bldg-C / Roof';
        });
        await page.evaluate(() => {
            const btns = document.querySelectorAll('.entity-modal-body .entity-promote-btn');
            const saveBtn = Array.from(btns).find(b => b.textContent === 'Save');
            if (saveBtn) saveBtn.click();
        });
        await page.waitForTimeout(500);
        const updatedEntity2 = await page.evaluate(async (id) => {
            const r = await fetch(`/api/entities/${id}`);
            return (await r.json()).entity;
        }, entityId2);
        assert(updatedEntity2.location === 'Bldg-C / Roof', `3.2 Edit location → "${updatedEntity2.location}"`);

        // Close and reopen to test log (fresh modal state)
        await page.evaluate(() => document.getElementById('entity-modal-close')?.click());
        await page.waitForTimeout(200);
        await page.evaluate((id) => window.app.entityModal.open(id), entityId2);
        await page.waitForTimeout(500);

        // 3.3 Add log entry → appears at top of log list
        await page.evaluate(() => {
            const ta = document.querySelector('.entity-log-textarea');
            if (ta) ta.value = 'Replaced belt. Inspected bearings.';
        });
        await page.evaluate(() => {
            const btns = document.querySelectorAll('.entity-modal-body .entity-promote-btn');
            const addBtn = Array.from(btns).find(b => b.textContent === 'Add');
            if (addBtn) addBtn.click();
        });
        await page.waitForTimeout(500);
        const logEntries = await page.evaluate(() => {
            const entries = document.querySelectorAll('#entity-log-list .entity-log-entry');
            return entries.length;
        });
        assert(logEntries >= 1, `3.3 Add log entry → ${logEntries} entry(ies) in log`);

        // 3.4 Log entry has timestamp
        const logDate = await page.evaluate(() => {
            const dateEl = document.querySelector('#entity-log-list .entity-log-date');
            return dateEl?.textContent || '';
        });
        assert(logDate.length >= 10, `3.4 Log entry has timestamp: "${logDate}"`);

        // 3.5 Log entry note text is correct
        const logNote = await page.evaluate(() => {
            const noteEl = document.querySelector('#entity-log-list .entity-log-note');
            return noteEl?.textContent || '';
        });
        assert(logNote.includes('Replaced belt'), `3.5 Log entry note: "${logNote}"`);

        // 3.6 Edit tag_number to duplicate → 409 error shown
        await page.evaluate((tag) => {
            const inputs = document.querySelectorAll('.entity-fields-table .entity-field-input');
            const tagInput = Array.from(inputs).find(i => i.dataset.field === 'tag_number');
            if (tagInput) tagInput.value = tag;
        }, tag1); // tag1 belongs to entity 1, so this should conflict
        await page.evaluate(() => {
            const btns = document.querySelectorAll('.entity-modal-body .entity-promote-btn');
            const saveBtn = Array.from(btns).find(b => b.textContent === 'Save');
            if (saveBtn) saveBtn.click();
        });
        await page.waitForTimeout(500);
        const errorMsg = await page.evaluate(() => {
            const status = document.querySelector('.entity-save-status');
            return status?.textContent || '';
        });
        assert(errorMsg.includes('tag number already in use'), `3.6 Duplicate tag → error: "${errorMsg}"`);

        // Restore original tag
        await page.evaluate((tag) => {
            const inputs = document.querySelectorAll('.entity-fields-table .entity-field-input');
            const tagInput = Array.from(inputs).find(i => i.dataset.field === 'tag_number');
            if (tagInput) tagInput.value = tag;
        }, tag2);
        await page.evaluate(() => {
            const btns = document.querySelectorAll('.entity-modal-body .entity-promote-btn');
            const saveBtn = Array.from(btns).find(b => b.textContent === 'Save');
            if (saveBtn) saveBtn.click();
        });
        await page.waitForTimeout(300);

        // 3.7 Empty note rejected (no blank log entries)
        await page.evaluate(() => {
            const ta = document.querySelector('.entity-log-textarea');
            if (ta) ta.value = '   '; // whitespace only
        });
        await page.evaluate(() => {
            const btns = document.querySelectorAll('.entity-modal-body .entity-promote-btn');
            const addBtn = Array.from(btns).find(b => b.textContent === 'Add');
            if (addBtn) addBtn.click();
        });
        await page.waitForTimeout(300);
        const logCountAfterBlank = await page.evaluate(() => {
            const entries = document.querySelectorAll('#entity-log-list .entity-log-entry');
            return entries.length;
        });
        // Should still be 1 (the blank entry should not have been added)
        assert(logCountAfterBlank === logEntries, `3.7 Empty note rejected (still ${logCountAfterBlank} entries)`);

        // Close modal
        await page.evaluate(() => document.getElementById('entity-modal-close')?.click());
        await page.waitForTimeout(200);

        // 3.8 Delete entity → confirm dialog → modal closes + entity removed
        // Create a disposable entity for deletion test
        const tagDel = `DEL-${RUN_TAG}`;
        const eDel = await apiCreateEntity(page, tagDel, { equip_type: 'Test' });
        const delId = eDel.body.id;
        // Don't add to createdEntityIds — we're about to delete it

        // Open modal for the disposable entity
        await page.evaluate((id) => window.app.entityModal.open(id), delId);
        await page.waitForTimeout(500);

        // Override confirm() to auto-accept
        await page.evaluate(() => { window._origConfirm = window.confirm; window.confirm = () => true; });
        // Click Delete button
        await page.evaluate(() => {
            const btns = document.querySelectorAll('.entity-modal-body .toolbar-btn');
            const delBtn = Array.from(btns).find(b => b.textContent === 'Delete Entity');
            if (delBtn) delBtn.click();
        });
        await page.waitForTimeout(500);
        // Restore confirm
        await page.evaluate(() => { window.confirm = window._origConfirm; });

        const modalAfterDelete = await page.evaluate(() => {
            const modal = document.getElementById('entity-modal');
            return modal?.style.display;
        });
        assert(modalAfterDelete === 'none', '3.8 Delete entity → modal closes');

        // ══════════════════════════════════════════════════════════════════════
        // GROUP 4: Integration
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n  -- Group 4: Integration --');

        // 4.1 Entity deleted → removed from Equipment tab list
        await switchToEquipmentTab(page);
        const deletedInList = await page.evaluate((id) => {
            return !!document.querySelector(`#equip-list .equip-row[data-entity-id="${id}"]`);
        }, delId);
        assert(!deletedInList, '4.1 Deleted entity not in Equipment tab list');

        // 4.2 Properties panel View button opens entity modal
        // Inject a markup and promote it to entity 1
        await injectAndSelectMarkup(page);
        const markupId4_2 = await page.evaluate(() => {
            const obj = window.app.canvas.fabricCanvas.getActiveObject();
            return obj?.markupId || null;
        });
        // Link markup to entity 1
        if (markupId4_2) {
            await apiLinkMarkup(page, DOC_ID, markupId4_2, entityIdForModal, 0);
            // Reselect to trigger entity section load
            await page.evaluate(() => {
                const fc = window.app.canvas.fabricCanvas;
                const obj = fc.getActiveObject();
                fc.discardActiveObject();
                fc.renderAll();
                setTimeout(() => {
                    fc.setActiveObject(obj);
                    fc.fire('selection:created', { selected: [obj] });
                    fc.renderAll();
                }, 100);
            });
            await page.waitForTimeout(800);

            // Click the View button
            await page.evaluate(() => {
                document.getElementById('entity-view-btn')?.click();
            });
            await page.waitForTimeout(500);

            const modalFromView = await page.evaluate(() => {
                const modal = document.getElementById('entity-modal');
                return modal && modal.style.display !== 'none';
            });
            assert(modalFromView, '4.2 Properties panel View button opens entity modal');

            // Close modal
            await page.evaluate(() => document.getElementById('entity-modal-close')?.click());
            await page.waitForTimeout(200);
        } else {
            assert(false, '4.2 Properties panel View button opens entity modal (no markupId)');
        }

        // 4.3 Entity modal Observations shows linked markups
        // Link another markup to entity 1
        const markupId4_3 = `test-obs-${RUN_TAG}`;
        await apiLinkMarkup(page, DOC_ID, markupId4_3, entityIdForModal, 0);

        await page.evaluate((id) => window.app.entityModal.open(id), entityIdForModal);
        await page.waitForTimeout(500);
        const obsCount = await page.evaluate(() => {
            return document.querySelectorAll('.entity-markup-row').length;
        });
        assert(obsCount >= 1, `4.3 Entity modal shows ${obsCount} observation(s)`);

        // Close modal
        await page.evaluate(() => document.getElementById('entity-modal-close')?.click());
        await page.waitForTimeout(200);

        // 4.4 Equipment tab shows markup_count in row
        await switchToEquipmentTab(page);
        const countBadge = await page.evaluate((id) => {
            const row = document.querySelector(`#equip-list .equip-row[data-entity-id="${id}"]`);
            if (!row) return '';
            const badge = row.querySelector('.equip-count');
            return badge?.textContent || '';
        }, entityIdForModal);
        assert(countBadge.length > 0 && parseInt(countBadge) > 0, `4.4 Markup count badge: "${countBadge}"`);

        // 4.5 Location filter works
        await page.evaluate(() => {
            const input = document.getElementById('equip-filter-loc');
            input.value = 'Bldg-A';
            input.dispatchEvent(new Event('input'));
        });
        await page.waitForTimeout(200);
        const locFilterCount = await page.evaluate(() =>
            document.querySelectorAll('#equip-list .equip-row').length
        );
        // e1 (Bldg-A/Floor-1) and e3 (Bldg-A/Floor-2) should match; e2 (Bldg-C now) should not
        assert(locFilterCount === 2, `4.5 Location filter "Bldg-A" → ${locFilterCount} row(s)`);
        // Clear filter
        await page.evaluate(() => {
            const input = document.getElementById('equip-filter-loc');
            input.value = '';
            input.dispatchEvent(new Event('input'));
        });

        // 4.6 Equipment tab refreshes after entity edit in modal
        // Edit entity 3's type
        await page.evaluate((id) => window.app.entityModal.open(id), e3.body.id);
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            const inputs = document.querySelectorAll('.entity-fields-table .entity-field-input');
            const typeInput = Array.from(inputs).find(i => i.dataset.field === 'equip_type');
            if (typeInput) typeInput.value = 'Pump';
        });
        await page.evaluate(() => {
            const btns = document.querySelectorAll('.entity-modal-body .entity-promote-btn');
            const saveBtn = Array.from(btns).find(b => b.textContent === 'Save');
            if (saveBtn) saveBtn.click();
        });
        await page.waitForTimeout(500);
        await page.evaluate(() => document.getElementById('entity-modal-close')?.click());
        await page.waitForTimeout(200);

        // Switch to Equipment tab and verify the type changed
        await switchToEquipmentTab(page);
        const updatedType = await page.evaluate((id) => {
            const row = document.querySelector(`#equip-list .equip-row[data-entity-id="${id}"]`);
            return row?.querySelector('.equip-type')?.textContent || '';
        }, e3.body.id);
        assert(updatedType === 'Pump', `4.6 Equipment tab reflects edit: type="${updatedType}"`);

    } finally {
        // ── Cleanup: delete all entities created by this test run ──────────────
        console.log(`\n  Cleaning up ${createdEntityIds.length} test entities...`);
        for (const id of createdEntityIds) {
            try { await apiDeleteEntity(page, id); } catch { /* ignore */ }
        }

        await browser.close();

        console.log('\n══════════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
        console.log('══════════════════════════════════════════════════');
        if (failed > 0) process.exit(1);
    }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
