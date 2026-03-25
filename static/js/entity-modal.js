/**
 * PortolanCAST — Entity Detail Modal
 *
 * Purpose:
 *   Full-screen overlay for viewing and editing a single equipment entity.
 *   Shows editable fields (tag, type, model, serial, location), linked
 *   markup observations (with navigation), and a chronological maintenance
 *   log. Opened from Equipment tab rows or the properties panel View button.
 *
 * Security:
 *   All user-supplied text rendered via textContent — never innerHTML.
 *   Input fields trimmed and length-limited before submission.
 *   Entity IDs validated as non-empty before API calls.
 *
 * Threat model:
 *   - Entity data comes from DB (user-created, not externally trusted)
 *   - Input is validated server-side (db.py + main.py); client does trim only
 *   - No dynamic code execution; no eval; no innerHTML
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-03-07
 */

// =============================================================================
// ENTITY MODAL — DETAIL OVERLAY
// =============================================================================

export class EntityModal {
    constructor() {
        /** @type {string|null} Currently displayed entity ID */
        this._entityId = null;

        /** @type {boolean} Whether Escape key listener is bound */
        this._escBound = false;
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Initialize the modal. Binds the Escape key listener (once) and
     * the close button in the pre-built HTML shell.
     *
     * Called by app.js on first document load.
     *
     * Args:
     *   canvas: CanvasOverlay reference (unused currently, reserved for future nav)
     */
    init(canvas) {
        this._canvas = canvas;

        // Bind close button in the pre-existing HTML shell
        const closeBtn = document.getElementById('entity-modal-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }

        // Bind Escape key — dismiss modal (once, idempotent guard)
        if (!this._escBound) {
            this._escBound = true;
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this._entityId) {
                    this.close();
                }
            });
        }
    }

    // =========================================================================
    // OPEN / CLOSE
    // =========================================================================

    /**
     * Open the modal for a specific entity.
     *
     * Fetches entity dossier (fields + log + markup_count) and linked markups,
     * then renders the full modal body.
     *
     * Args:
     *   entityId: UUID string of the entity to display.
     */
    async open(entityId) {
        if (!entityId) return;
        this._entityId = entityId;

        const overlay = document.getElementById('entity-modal');
        if (!overlay) return;

        // Show overlay immediately (loading state)
        overlay.style.display = '';

        try {
            // Fetch entity dossier, markups, tasks, photos, and parts in parallel
            const [dossierResp, markupsResp, tasksResp, photosResp, partsResp] = await Promise.all([
                fetch(`/api/entities/${entityId}`),
                fetch(`/api/entities/${entityId}/markups`),
                fetch(`/api/entities/${entityId}/tasks`),
                fetch(`/api/entities/${entityId}/photos`),
                fetch(`/api/entities/${entityId}/parts`),
            ]);

            if (!dossierResp.ok) {
                console.error('[EntityModal] Entity not found:', dossierResp.status);
                this.close();
                return;
            }

            const dossier = await dossierResp.json();
            const markupsData = markupsResp.ok ? await markupsResp.json() : { markups: [] };
            const tasksData = tasksResp.ok ? await tasksResp.json() : { tasks: [] };
            const photosData = photosResp.ok ? await photosResp.json() : { photos: [] };
            const partsData = partsResp.ok ? await partsResp.json() : { parts: [] };

            const entity = dossier.entity;
            const log = dossier.log || [];
            const markups = markupsData.markups || [];
            const tasks = tasksData.tasks || [];
            const photos = photosData.photos || [];
            const parts = partsData.parts || [];

            // Render header title — show building prefix if set
            const titleEl = document.getElementById('entity-modal-title');
            if (titleEl) {
                // SECURITY: textContent only
                const titleText = entity.building
                    ? `${entity.building} / ${entity.tag_number}`
                    : entity.tag_number || 'Entity';
                titleEl.textContent = titleText;
            }

            // Render modal body sections
            const body = document.getElementById('entity-modal-body');
            if (body) {
                // Clear previous content
                body.innerHTML = '';
                this._renderFields(body, entity);
                this._renderObservations(body, markups);
                this._renderLog(body, entity, log);
                this._renderTasks(body, entity.id, tasks);
                this._renderParts(body, entity.id, parts);
                this._renderPhotos(body, entity.id, photos);
                this._renderDangerZone(body, entity);
            }
        } catch (err) {
            console.error('[EntityModal] Error opening entity:', err);
            this.close();
        }
    }

    /**
     * Close the modal and reset state.
     */
    close() {
        this._entityId = null;
        const overlay = document.getElementById('entity-modal');
        if (overlay) overlay.style.display = 'none';

        // Clear body to free DOM nodes
        const body = document.getElementById('entity-modal-body');
        if (body) body.innerHTML = '';
    }

    // =========================================================================
    // RENDER — EDITABLE FIELDS
    // =========================================================================

    /**
     * Render the editable fields table (tag_number, equip_type, model, serial, location).
     *
     * Each field shows a label and an inline-editable input. A single Save button
     * at the bottom PUTs all fields to the API.
     *
     * Args:
     *   container: DOM element to append into.
     *   entity:    Entity dict from the API.
     */
    _renderFields(container, entity) {
        const section = document.createElement('div');
        section.className = 'entity-modal-section';

        const header = document.createElement('div');
        header.className = 'entity-modal-section-header';
        header.textContent = 'Details';
        section.appendChild(header);

        const table = document.createElement('table');
        table.className = 'entity-fields-table';

        const fields = [
            { key: 'building', label: 'Building' },
            { key: 'tag_number', label: 'Tag Number' },
            { key: 'equip_type', label: 'Type' },
            { key: 'model', label: 'Model' },
            { key: 'serial', label: 'Serial' },
            { key: 'location', label: 'Location' },
        ];

        const inputs = {};

        for (const f of fields) {
            const tr = document.createElement('tr');

            const td1 = document.createElement('td');
            td1.className = 'entity-field-label';
            td1.textContent = f.label;
            tr.appendChild(td1);

            const td2 = document.createElement('td');
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'entity-field-input';
            input.value = entity[f.key] || '';
            input.dataset.field = f.key;
            inputs[f.key] = input;
            td2.appendChild(input);
            tr.appendChild(td2);

            table.appendChild(tr);
        }

        section.appendChild(table);

        // Status message for save feedback
        const statusMsg = document.createElement('div');
        statusMsg.className = 'entity-save-status';
        statusMsg.style.fontSize = '11px';
        statusMsg.style.marginTop = '6px';
        statusMsg.style.minHeight = '16px';
        section.appendChild(statusMsg);

        // Save button
        const saveBtn = document.createElement('button');
        saveBtn.className = 'toolbar-btn entity-promote-btn';
        saveBtn.textContent = 'Save';
        saveBtn.style.marginTop = '8px';
        saveBtn.addEventListener('click', async () => {
            await this._onSave(entity.id, inputs, statusMsg);
        });
        section.appendChild(saveBtn);

        container.appendChild(section);
    }

    /**
     * Handle Save button click — PUT updated fields to the API.
     *
     * Args:
     *   entityId: UUID of the entity.
     *   inputs:   Map of field key → input element.
     *   statusEl: DOM element for save feedback text.
     */
    async _onSave(entityId, inputs, statusEl) {
        const updates = {};
        for (const [key, input] of Object.entries(inputs)) {
            updates[key] = input.value.trim();
        }

        try {
            const resp = await fetch(`/api/entities/${entityId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });

            if (resp.status === 409) {
                // Tag number conflict
                statusEl.textContent = 'Error: tag number already in use';
                statusEl.style.color = '#ff6b6b';
                return;
            }

            if (!resp.ok) {
                statusEl.textContent = 'Save failed';
                statusEl.style.color = '#ff6b6b';
                return;
            }

            const data = await resp.json();
            statusEl.textContent = 'Saved';
            statusEl.style.color = '#4caf50';

            // Update modal title if tag or building changed
            const titleEl = document.getElementById('entity-modal-title');
            if (titleEl && data.entity) {
                const titleText = data.entity.building
                    ? `${data.entity.building} / ${data.entity.tag_number}`
                    : data.entity.tag_number || 'Entity';
                titleEl.textContent = titleText;
            }

            // Refresh Equipment tab list to reflect changes
            if (window.app && window.app.entityManager) {
                window.app.entityManager.refresh();
            }

            // Clear status after 2s
            setTimeout(() => { statusEl.textContent = ''; }, 2000);
        } catch (err) {
            statusEl.textContent = 'Network error';
            statusEl.style.color = '#ff6b6b';
            console.error('[EntityModal] Save failed:', err);
        }
    }

    // =========================================================================
    // RENDER — OBSERVATIONS (LINKED MARKUPS)
    // =========================================================================

    /**
     * Render the Observations section — linked markups across documents.
     *
     * Each row shows doc_name + page_number and is clickable to navigate
     * to that document/page in the editor.
     *
     * Args:
     *   container: DOM element to append into.
     *   markups:   Array of { markup_id, doc_id, doc_name, page_number }.
     */
    _renderObservations(container, markups) {
        const section = document.createElement('div');
        section.className = 'entity-modal-section';

        const header = document.createElement('div');
        header.className = 'entity-modal-section-header';
        header.textContent = `Observations (${markups.length})`;
        section.appendChild(header);

        if (markups.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'muted-text';
            empty.style.padding = '8px 0';
            empty.textContent = 'No markups linked to this entity yet.';
            section.appendChild(empty);
        } else {
            for (const m of markups) {
                const row = document.createElement('div');
                row.className = 'entity-markup-row';

                const docName = document.createElement('span');
                docName.className = 'entity-markup-doc';
                // SECURITY: textContent only — doc_name comes from DB
                docName.textContent = m.doc_name || `Document ${m.doc_id}`;
                row.appendChild(docName);

                const pageLabel = document.createElement('span');
                pageLabel.className = 'entity-markup-page';
                pageLabel.textContent = `Page ${(m.page_number || 0) + 1}`;
                row.appendChild(pageLabel);

                // Click → navigate to that document/page
                row.addEventListener('click', () => {
                    this._navigateToMarkup(m.doc_id, m.page_number);
                });

                section.appendChild(row);
            }
        }

        container.appendChild(section);
    }

    /**
     * Navigate to a markup's document and page.
     *
     * If the markup is in the current document, just go to the page.
     * If it's in a different document, do a full page navigation.
     *
     * Args:
     *   docId:      Document ID containing the markup.
     *   pageNumber: Zero-indexed page number.
     */
    _navigateToMarkup(docId, pageNumber) {
        this.close();

        if (window.app) {
            if (window.app.docId === docId) {
                // Same document — just navigate to the page
                window.app.viewer.goToPage(pageNumber || 0);
            } else {
                // Different document — full navigation
                window.location.href = `/edit/${docId}`;
            }
        }
    }

    // =========================================================================
    // RENDER — MAINTENANCE LOG
    // =========================================================================

    /**
     * Render the Log section — maintenance/observation log entries.
     *
     * Shows entries newest-first with timestamp and note text.
     * Includes an "Add Entry" input at the top for new log entries.
     *
     * Args:
     *   container: DOM element to append into.
     *   entity:    Entity dict (for the entity ID).
     *   log:       Array of { id, note, created_at } entries.
     */
    _renderLog(container, entity, log) {
        const section = document.createElement('div');
        section.className = 'entity-modal-section';

        const header = document.createElement('div');
        header.className = 'entity-modal-section-header';
        header.textContent = 'Maintenance Log';
        section.appendChild(header);

        // Add entry input row
        const addRow = document.createElement('div');
        addRow.className = 'entity-log-add-row';

        const textarea = document.createElement('textarea');
        textarea.className = 'entity-log-textarea';
        textarea.placeholder = 'Add a log entry…';
        textarea.maxLength = 2000;
        addRow.appendChild(textarea);

        const addBtn = document.createElement('button');
        addBtn.className = 'toolbar-btn entity-promote-btn';
        addBtn.textContent = 'Add';
        addBtn.addEventListener('click', async () => {
            await this._onAddLog(entity.id, textarea, logList);
        });
        addRow.appendChild(addBtn);

        section.appendChild(addRow);

        // Log entries container
        const logList = document.createElement('div');
        logList.id = 'entity-log-list';

        // Render existing entries (newest first — API already returns DESC)
        for (const entry of log) {
            logList.appendChild(this._createLogEntry(entry));
        }

        if (log.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'muted-text';
            empty.style.padding = '8px 0';
            empty.textContent = 'No log entries yet.';
            empty.id = 'entity-log-empty';
            logList.appendChild(empty);
        }

        section.appendChild(logList);
        container.appendChild(section);
    }

    /**
     * Create a single log entry DOM element.
     *
     * Args:
     *   entry: { id, note, created_at } log entry dict.
     *
     * Returns:
     *   DOM element for the log entry row.
     */
    _createLogEntry(entry) {
        const row = document.createElement('div');
        row.className = 'entity-log-entry';

        const date = document.createElement('span');
        date.className = 'entity-log-date';
        // Format date — show date portion only for brevity
        const dateStr = entry.created_at || '';
        date.textContent = dateStr.substring(0, 10);
        row.appendChild(date);

        const note = document.createElement('span');
        note.className = 'entity-log-note';
        // SECURITY: textContent only — note is user-entered free text
        note.textContent = entry.note || '';
        row.appendChild(note);

        return row;
    }

    /**
     * Handle Add Log button click — POST new log entry.
     *
     * Args:
     *   entityId: UUID of the entity.
     *   textarea: The textarea DOM element (cleared on success).
     *   logList:  The log list container DOM element (new entry prepended).
     */
    async _onAddLog(entityId, textarea, logList) {
        const noteText = textarea.value.trim();
        if (!noteText) return; // reject blank entries

        try {
            const resp = await fetch(`/api/entities/${entityId}/log`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note: noteText }),
            });

            if (!resp.ok) {
                console.error('[EntityModal] Failed to add log entry:', resp.status);
                return;
            }

            const data = await resp.json();
            // POST /api/entities/{id}/log returns the entry directly (not wrapped in .entry)
            const entry = data.note ? data : { note: noteText, created_at: new Date().toISOString() };

            // Remove "No log entries" placeholder if present
            const emptyEl = document.getElementById('entity-log-empty');
            if (emptyEl) emptyEl.remove();

            // Prepend new entry at top (newest first)
            const entryEl = this._createLogEntry(entry);
            logList.prepend(entryEl);

            // Clear textarea
            textarea.value = '';
        } catch (err) {
            console.error('[EntityModal] Error adding log entry:', err);
        }
    }

    // =========================================================================
    // RENDER — TASKS
    // =========================================================================

    /**
     * Render the Tasks section — maintenance/work tasks for this entity.
     *
     * Each task has a checkbox (toggle open↔done), title, priority badge,
     * and optional due date. Includes an inline add form.
     *
     * Args:
     *   container: DOM element to append into.
     *   entityId:  UUID of the entity.
     *   tasks:     Array of task objects from the API.
     */
    _renderTasks(container, entityId, tasks) {
        const section = document.createElement('div');
        section.className = 'entity-modal-section';

        const header = document.createElement('div');
        header.className = 'entity-modal-section-header';
        header.textContent = `Tasks (${tasks.length})`;
        section.appendChild(header);

        // Task list container
        const taskList = document.createElement('div');
        taskList.id = 'entity-task-list';

        if (tasks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'muted-text';
            empty.style.padding = '8px 0';
            empty.textContent = 'No tasks yet.';
            empty.id = 'entity-tasks-empty';
            taskList.appendChild(empty);
        } else {
            for (const task of tasks) {
                taskList.appendChild(this._createTaskRow(task, taskList, entityId));
            }
        }

        section.appendChild(taskList);

        // Inline add-task form
        const addRow = document.createElement('div');
        addRow.className = 'entity-task-add-row';

        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.placeholder = 'New task…';
        titleInput.maxLength = 500;
        addRow.appendChild(titleInput);

        const prioritySelect = document.createElement('select');
        for (const p of ['normal', 'low', 'high', 'urgent']) {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            prioritySelect.appendChild(opt);
        }
        addRow.appendChild(prioritySelect);

        const addBtn = document.createElement('button');
        addBtn.className = 'toolbar-btn entity-promote-btn';
        addBtn.textContent = 'Add';
        addBtn.addEventListener('click', async () => {
            const title = titleInput.value.trim();
            if (!title) return;

            try {
                const resp = await fetch(`/api/entities/${entityId}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title,
                        priority: prioritySelect.value,
                    }),
                });
                if (!resp.ok) return;

                const data = await resp.json();

                // Remove empty placeholder if present
                const emptyEl = document.getElementById('entity-tasks-empty');
                if (emptyEl) emptyEl.remove();

                // Prepend new task at top (newest first)
                taskList.prepend(this._createTaskRow(data.task, taskList, entityId));
                titleInput.value = '';

                // Update section header count
                const count = taskList.querySelectorAll('.entity-task-row').length;
                header.textContent = `Tasks (${count})`;
            } catch (err) {
                console.error('[EntityModal] Failed to add task:', err);
            }
        });
        addRow.appendChild(addBtn);

        section.appendChild(addRow);
        container.appendChild(section);
    }

    /**
     * Create a single task row DOM element.
     *
     * Args:
     *   task:     Task object from the API.
     *   taskList: Container DOM element (for removal on delete).
     *   entityId: UUID of the parent entity.
     *
     * Returns:
     *   DOM element for the task row.
     */
    _createTaskRow(task, taskList, entityId) {
        const row = document.createElement('div');
        row.className = 'entity-task-row';
        row.dataset.taskId = task.id;

        // Checkbox — toggle open/done
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'entity-task-checkbox';
        checkbox.checked = task.status === 'done';
        checkbox.addEventListener('change', async () => {
            const newStatus = checkbox.checked ? 'done' : 'open';
            try {
                await fetch(`/api/tasks/${task.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: newStatus }),
                });
                titleSpan.classList.toggle('done', checkbox.checked);
            } catch (err) {
                // Revert on failure
                checkbox.checked = !checkbox.checked;
                console.error('[EntityModal] Failed to update task:', err);
            }
        });
        row.appendChild(checkbox);

        // Title
        const titleSpan = document.createElement('span');
        titleSpan.className = 'entity-task-title' + (task.status === 'done' ? ' done' : '');
        // SECURITY: textContent only
        titleSpan.textContent = task.title;
        row.appendChild(titleSpan);

        // Priority badge (skip 'normal' to reduce visual noise)
        if (task.priority && task.priority !== 'normal') {
            const badge = document.createElement('span');
            badge.className = `task-priority-badge ${task.priority}`;
            badge.textContent = task.priority;
            row.appendChild(badge);
        }

        // Due date
        if (task.due_date) {
            const due = document.createElement('span');
            due.className = 'entity-task-due';
            due.textContent = task.due_date;
            row.appendChild(due);
        }

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'toolbar-btn';
        deleteBtn.style.fontSize = '10px';
        deleteBtn.style.padding = '1px 5px';
        deleteBtn.style.color = '#666';
        deleteBtn.textContent = '✕';
        deleteBtn.title = 'Delete task';
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const resp = await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
                if (resp.ok) {
                    // Grab header BEFORE removing row from DOM (closest won't work after removal)
                    const hdr = row.closest('.entity-modal-section')?.querySelector('.entity-modal-section-header');
                    row.remove();
                    // Update header count
                    const count = taskList.querySelectorAll('.entity-task-row').length;
                    if (hdr) hdr.textContent = `Tasks (${count})`;
                    // Show empty placeholder if no tasks remain
                    if (count === 0) {
                        const empty = document.createElement('div');
                        empty.className = 'muted-text';
                        empty.style.padding = '8px 0';
                        empty.textContent = 'No tasks yet.';
                        empty.id = 'entity-tasks-empty';
                        taskList.appendChild(empty);
                    }
                }
            } catch (err) {
                console.error('[EntityModal] Failed to delete task:', err);
            }
        });
        row.appendChild(deleteBtn);

        return row;
    }

    // =========================================================================
    // RENDER — PARTS INVENTORY
    // =========================================================================

    /**
     * Render the Parts Inventory section — parts/spares for this entity.
     *
     * Shows a grid-table of parts with columns: part number, description,
     * quantity, unit, location. Includes an inline add form for new parts
     * and edit/delete actions per row.
     *
     * Args:
     *   container: DOM element to append into.
     *   entityId:  UUID of the entity.
     *   parts:     Array of part objects from the API.
     */
    _renderParts(container, entityId, parts) {
        const section = document.createElement('div');
        section.className = 'entity-modal-section';

        const header = document.createElement('div');
        header.className = 'entity-modal-section-header';
        header.textContent = `Parts Inventory (${parts.length})`;
        section.appendChild(header);

        // Parts table container
        const table = document.createElement('div');
        table.className = 'entity-parts-table';
        table.id = 'entity-parts-table';

        if (parts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'muted-text';
            empty.style.padding = '8px 0';
            empty.textContent = 'No parts in inventory.';
            empty.id = 'entity-parts-empty';
            table.appendChild(empty);
        } else {
            // Column header row
            const headerRow = document.createElement('div');
            headerRow.className = 'parts-header-row';

            const cols = [
                { cls: 'part-col-number', text: 'Part #' },
                { cls: 'part-col-desc', text: 'Description' },
                { cls: 'part-col-qty', text: 'Qty' },
                { cls: 'part-col-unit', text: 'Unit' },
                { cls: 'part-col-location', text: 'Location' },
                { cls: 'part-col-actions', text: '' },
            ];
            for (const col of cols) {
                const span = document.createElement('span');
                span.className = col.cls;
                span.textContent = col.text;
                headerRow.appendChild(span);
            }
            table.appendChild(headerRow);

            // Part data rows
            for (const part of parts) {
                table.appendChild(this._createPartRow(part, table, header, entityId));
            }
        }

        section.appendChild(table);

        // Inline add-part form
        const addRow = document.createElement('div');
        addRow.className = 'entity-part-add-row';

        const partNumInput = document.createElement('input');
        partNumInput.type = 'text';
        partNumInput.placeholder = 'Part #…';
        partNumInput.maxLength = 128;
        partNumInput.className = 'part-add-number';
        addRow.appendChild(partNumInput);

        const descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.placeholder = 'Description…';
        descInput.maxLength = 500;
        descInput.className = 'part-add-desc';
        addRow.appendChild(descInput);

        const qtyInput = document.createElement('input');
        qtyInput.type = 'number';
        qtyInput.placeholder = 'Qty';
        qtyInput.value = '1';
        qtyInput.min = '0';
        qtyInput.className = 'part-add-qty';
        addRow.appendChild(qtyInput);

        const unitInput = document.createElement('input');
        unitInput.type = 'text';
        unitInput.placeholder = 'Unit…';
        unitInput.maxLength = 32;
        unitInput.className = 'part-add-unit';
        addRow.appendChild(unitInput);

        const addBtn = document.createElement('button');
        addBtn.className = 'toolbar-btn entity-promote-btn';
        addBtn.textContent = 'Add';
        addBtn.addEventListener('click', async () => {
            const pn = partNumInput.value.trim();
            const desc = descInput.value.trim();
            const qty = qtyInput.value || '1';

            // Require part number and description at minimum
            if (!pn || !desc) return;

            try {
                const resp = await fetch(`/api/entities/${entityId}/parts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        part_number: pn,
                        description: desc,
                        quantity: parseInt(qty, 10),
                        unit: unitInput.value.trim(),
                    }),
                });
                if (!resp.ok) return;

                const data = await resp.json();

                // Remove empty placeholder if present
                const emptyEl = document.getElementById('entity-parts-empty');
                if (emptyEl) emptyEl.remove();

                // If this is the first part, add column header row
                const tableEl = document.getElementById('entity-parts-table');
                if (tableEl && !tableEl.querySelector('.parts-header-row')) {
                    const hr = document.createElement('div');
                    hr.className = 'parts-header-row';
                    const colDefs = [
                        { cls: 'part-col-number', text: 'Part #' },
                        { cls: 'part-col-desc', text: 'Description' },
                        { cls: 'part-col-qty', text: 'Qty' },
                        { cls: 'part-col-unit', text: 'Unit' },
                        { cls: 'part-col-location', text: 'Location' },
                        { cls: 'part-col-actions', text: '' },
                    ];
                    for (const col of colDefs) {
                        const s = document.createElement('span');
                        s.className = col.cls;
                        s.textContent = col.text;
                        hr.appendChild(s);
                    }
                    tableEl.appendChild(hr);
                }

                // Append new part row
                if (tableEl) {
                    tableEl.appendChild(this._createPartRow(data.part, tableEl, header, entityId));
                }

                // Update header count
                const count = tableEl ? tableEl.querySelectorAll('.entity-part-row').length : 0;
                header.textContent = `Parts Inventory (${count})`;

                // Clear form inputs
                partNumInput.value = '';
                descInput.value = '';
                qtyInput.value = '1';
                unitInput.value = '';
            } catch (err) {
                console.error('[EntityModal] Failed to add part:', err);
            }
        });
        addRow.appendChild(addBtn);

        section.appendChild(addRow);
        container.appendChild(section);
    }

    /**
     * Create a single part row DOM element.
     *
     * Shows part_number, description, quantity, unit, location — with
     * edit (quantity) and delete action buttons.
     *
     * Args:
     *   part:     Part object from the API.
     *   table:    Table container DOM element (for row count after delete).
     *   header:   Section header DOM element (for updating count on changes).
     *   entityId: UUID of the parent entity (unused currently, reserved).
     *
     * Returns:
     *   DOM element for the part row.
     */
    _createPartRow(part, table, header, entityId) {
        const row = document.createElement('div');
        row.className = 'entity-part-row';
        row.dataset.partId = part.id;

        // Part number
        const numSpan = document.createElement('span');
        numSpan.className = 'part-col-number';
        // SECURITY: textContent only — part_number is user-entered
        numSpan.textContent = part.part_number || '—';
        row.appendChild(numSpan);

        // Description
        const descSpan = document.createElement('span');
        descSpan.className = 'part-col-desc';
        descSpan.textContent = part.description || '—';
        descSpan.title = part.notes || '';  // show notes on hover
        row.appendChild(descSpan);

        // Quantity
        const qtySpan = document.createElement('span');
        qtySpan.className = 'part-col-qty';
        qtySpan.textContent = part.quantity ?? 0;
        row.appendChild(qtySpan);

        // Unit
        const unitSpan = document.createElement('span');
        unitSpan.className = 'part-col-unit';
        unitSpan.textContent = part.unit || '';
        row.appendChild(unitSpan);

        // Location
        const locSpan = document.createElement('span');
        locSpan.className = 'part-col-location';
        locSpan.textContent = part.location || '';
        row.appendChild(locSpan);

        // Action buttons
        const actionsSpan = document.createElement('span');
        actionsSpan.className = 'part-col-actions';

        // Edit button — updates quantity inline via prompt
        const editBtn = document.createElement('button');
        editBtn.className = 'toolbar-btn part-edit-btn';
        editBtn.style.fontSize = '10px';
        editBtn.style.padding = '1px 5px';
        editBtn.textContent = '✎';
        editBtn.title = 'Edit quantity';
        editBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const newQty = prompt('New quantity:', part.quantity);
            if (newQty === null) return; // cancelled
            const parsed = parseInt(newQty, 10);
            if (isNaN(parsed) || parsed < 0) return;
            try {
                const resp = await fetch(`/api/entity-parts/${part.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quantity: parsed }),
                });
                if (resp.ok) {
                    qtySpan.textContent = parsed;
                    part.quantity = parsed;
                }
            } catch (err) {
                console.error('[EntityModal] Failed to update part:', err);
            }
        });
        actionsSpan.appendChild(editBtn);

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'toolbar-btn';
        deleteBtn.style.fontSize = '10px';
        deleteBtn.style.padding = '1px 5px';
        deleteBtn.style.color = '#666';
        deleteBtn.textContent = '✕';
        deleteBtn.title = 'Delete part';
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const resp = await fetch(`/api/entity-parts/${part.id}`, { method: 'DELETE' });
                if (resp.ok) {
                    // Grab header ref BEFORE removing row from DOM
                    const hdr = row.closest('.entity-modal-section')?.querySelector('.entity-modal-section-header');
                    row.remove();
                    const count = table.querySelectorAll('.entity-part-row').length;
                    if (hdr) hdr.textContent = `Parts Inventory (${count})`;
                    // Show empty placeholder if no parts remain
                    if (count === 0) {
                        // Remove header row too
                        const hr = table.querySelector('.parts-header-row');
                        if (hr) hr.remove();

                        const empty = document.createElement('div');
                        empty.className = 'muted-text';
                        empty.style.padding = '8px 0';
                        empty.textContent = 'No parts in inventory.';
                        empty.id = 'entity-parts-empty';
                        table.appendChild(empty);
                    }
                }
            } catch (err) {
                console.error('[EntityModal] Failed to delete part:', err);
            }
        });
        actionsSpan.appendChild(deleteBtn);

        row.appendChild(actionsSpan);
        return row;
    }

    // =========================================================================
    // RENDER — PHOTOS
    // =========================================================================

    /**
     * Render the Photos section — direct entity photo attachments.
     *
     * Shows photos in a 3-column grid with thumbnails, captions, and delete buttons.
     * Includes an "Add Photo" button that triggers a hidden file input.
     *
     * Args:
     *   container: DOM element to append into.
     *   entityId:  UUID of the entity.
     *   photos:    Array of photo objects from the API (each has url, caption, id).
     */
    _renderPhotos(container, entityId, photos) {
        const section = document.createElement('div');
        section.className = 'entity-modal-section';

        const header = document.createElement('div');
        header.className = 'entity-modal-section-header';
        header.textContent = `Photos (${photos.length})`;
        section.appendChild(header);

        // Photo grid container
        const grid = document.createElement('div');
        grid.className = 'entity-photo-grid';
        grid.id = 'entity-photo-grid';

        if (photos.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'muted-text';
            empty.style.padding = '8px 0';
            empty.textContent = 'No photos yet.';
            empty.id = 'entity-photos-empty';
            grid.appendChild(empty);
        } else {
            for (const photo of photos) {
                grid.appendChild(this._createPhotoItem(photo, grid, header));
            }
        }

        section.appendChild(grid);

        // Add Photo button + hidden file input
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;

            try {
                const formData = new FormData();
                formData.append('file', file);
                const resp = await fetch(`/api/entities/${entityId}/photos`, {
                    method: 'POST',
                    body: formData,
                });
                if (!resp.ok) return;

                const data = await resp.json();

                // Remove empty placeholder if present
                const emptyEl = document.getElementById('entity-photos-empty');
                if (emptyEl) emptyEl.remove();

                // Add new photo to grid
                grid.appendChild(this._createPhotoItem(data.photo, grid, header));

                // Update header count
                const count = grid.querySelectorAll('.entity-photo-item').length;
                header.textContent = `Photos (${count})`;
            } catch (err) {
                console.error('[EntityModal] Failed to upload photo:', err);
            }

            // Reset input so the same file can be re-selected
            fileInput.value = '';
        });
        section.appendChild(fileInput);

        const addBtn = document.createElement('button');
        addBtn.className = 'toolbar-btn entity-promote-btn';
        addBtn.textContent = '+ Add Photo';
        addBtn.style.marginTop = '8px';
        addBtn.addEventListener('click', () => fileInput.click());
        section.appendChild(addBtn);

        container.appendChild(section);
    }

    /**
     * Create a single photo grid item.
     *
     * Args:
     *   photo:  Photo object from the API (id, url, caption, filename).
     *   grid:   Grid container DOM element (for removal on delete).
     *   header: Section header DOM element (for updating count on delete).
     *
     * Returns:
     *   DOM element for the photo grid item.
     */
    _createPhotoItem(photo, grid, header) {
        const item = document.createElement('div');
        item.className = 'entity-photo-item';
        item.dataset.photoId = photo.id;

        const img = document.createElement('img');
        img.className = 'entity-photo-thumb';
        img.src = photo.url;
        img.alt = photo.caption || 'Entity photo';
        img.loading = 'lazy';
        // Click → open full image in new tab
        img.addEventListener('click', () => window.open(photo.url, '_blank'));
        item.appendChild(img);

        if (photo.caption) {
            const caption = document.createElement('div');
            caption.className = 'entity-photo-caption';
            // SECURITY: textContent only
            caption.textContent = photo.caption;
            item.appendChild(caption);
        }

        // Delete button (visible on hover via CSS)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'entity-photo-delete';
        deleteBtn.textContent = '✕';
        deleteBtn.title = 'Delete photo';
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const resp = await fetch(`/api/entity-photos/${photo.id}`, { method: 'DELETE' });
                if (resp.ok) {
                    item.remove();
                    const count = grid.querySelectorAll('.entity-photo-item').length;
                    header.textContent = `Photos (${count})`;
                    if (count === 0) {
                        const empty = document.createElement('div');
                        empty.className = 'muted-text';
                        empty.style.padding = '8px 0';
                        empty.textContent = 'No photos yet.';
                        empty.id = 'entity-photos-empty';
                        grid.appendChild(empty);
                    }
                }
            } catch (err) {
                console.error('[EntityModal] Failed to delete photo:', err);
            }
        });
        item.appendChild(deleteBtn);

        return item;
    }

    // =========================================================================
    // RENDER — DANGER ZONE (DELETE)
    // =========================================================================

    /**
     * Render the delete button at the bottom of the modal.
     *
     * Requires a confirm() dialog before proceeding — irreversible action.
     *
     * Args:
     *   container: DOM element to append into.
     *   entity:    Entity dict (for ID and tag_number in the confirm message).
     */
    _renderDangerZone(container, entity) {
        const section = document.createElement('div');
        section.className = 'entity-modal-section';
        section.style.marginTop = '24px';
        section.style.borderTop = '1px solid #3a1e1e';
        section.style.paddingTop = '16px';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'toolbar-btn';
        deleteBtn.style.color = '#ff6b6b';
        deleteBtn.style.borderColor = '#5a2a2a';
        deleteBtn.textContent = 'Delete Entity';
        deleteBtn.addEventListener('click', () => {
            this._onDeleteEntity(entity.id, entity.tag_number);
        });
        section.appendChild(deleteBtn);

        container.appendChild(section);
    }

    /**
     * Handle Delete Entity — confirm dialog then DELETE API call.
     *
     * On success: closes modal, refreshes Equipment tab, dispatches
     * entity-deleted event so the properties panel can reset if needed.
     *
     * Args:
     *   entityId:  UUID of the entity to delete.
     *   tagNumber: Tag text for the confirm dialog message.
     */
    async _onDeleteEntity(entityId, tagNumber) {
        // Confirm before irreversible action
        const confirmed = confirm(`Delete entity "${tagNumber}"?\n\nThis will unlink all associated markups. This cannot be undone.`);
        if (!confirmed) return;

        try {
            const resp = await fetch(`/api/entities/${entityId}`, {
                method: 'DELETE',
            });

            if (!resp.ok) {
                console.error('[EntityModal] Delete failed:', resp.status);
                return;
            }

            // Close modal
            this.close();

            // Refresh Equipment tab
            if (window.app && window.app.entityManager) {
                window.app.entityManager.refresh();
            }

            // Dispatch event so properties panel can reset linked state
            document.dispatchEvent(new CustomEvent('entity-deleted', {
                detail: { entityId },
            }));
        } catch (err) {
            console.error('[EntityModal] Error deleting entity:', err);
        }
    }
}
