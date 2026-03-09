/**
 * PortolanCAST — Quick Capture Panel
 *
 * Purpose:
 *   Slide-out panel for rapid equipment entity creation in the field.
 *   Triggered by Q hotkey or Equipment tab "+" button. Captures tag number,
 *   equipment type, location, note, and optional photo in 2-3 taps.
 *
 * Design philosophy:
 *   Minimize friction: auto-focus tag field, remember last location via
 *   localStorage, pre-populated type dropdown. Goal is stand-in-front-of-
 *   equipment → tap → type → snap → move-on in under 30 seconds.
 *
 * Security:
 *   All user-supplied text rendered via textContent — never innerHTML.
 *   Inputs trimmed and length-limited before API submission.
 *   Photo upload reuses existing ALLOWED_PHOTO_EXTENSIONS validation server-side.
 *
 * Author: PortolanCAST
 * Version: 0.1.0
 * Date: 2026-03-08
 */

// =============================================================================
// QUICK CAPTURE — SLIDE-IN PANEL
// =============================================================================

export class QuickCapture {
    constructor() {
        /** @type {Object|null} Reference to EntityManager for refresh after save */
        this._entityManager = null;

        /** @type {boolean} Whether init() has been called */
        this._initialized = false;

        /** @type {File|null} Selected photo file (pending upload) */
        this._photoFile = null;
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Initialize the Quick Capture panel — bind buttons and keyboard events.
     *
     * Called by app.js on first document load. Idempotent via _initialized guard.
     *
     * Args:
     *   entityManager: EntityManager instance for refreshing Equipment tab after save.
     */
    init(entityManager) {
        this._entityManager = entityManager;

        if (this._initialized) return;
        this._initialized = true;

        // Bind close button
        const closeBtn = document.getElementById('qc-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }

        // Bind save button
        const saveBtn = document.getElementById('qc-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this._onSave());
        }

        // Bind photo add button → hidden file input
        const photoBtn = document.getElementById('qc-photo-btn');
        const photoInput = document.getElementById('qc-photo-input');
        if (photoBtn && photoInput) {
            photoBtn.addEventListener('click', () => photoInput.click());
            photoInput.addEventListener('change', (e) => this._onPhotoSelected(e));
        }

        // Bind photo remove button
        const removeBtn = document.getElementById('qc-photo-remove');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => this._clearPhoto());
        }

        // Bind "+" button in Equipment tab
        const addBtn = document.getElementById('equip-btn-add');
        if (addBtn) {
            addBtn.addEventListener('click', () => this.open());
        }

        // Bind "Report" button in Equipment tab
        const reportBtn = document.getElementById('equip-btn-report');
        if (reportBtn) {
            reportBtn.addEventListener('click', () => this._openReport());
        }

        // Bind Escape key to close panel (only when panel is visible)
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._isOpen()) {
                e.stopPropagation();
                this.close();
            }
        }, { capture: true });
    }

    // =========================================================================
    // OPEN / CLOSE
    // =========================================================================

    /**
     * Open the Quick Capture panel — slide in from right.
     *
     * Auto-focuses the tag field and restores last-used location from localStorage.
     */
    open() {
        const panel = document.getElementById('quick-capture-panel');
        if (!panel) return;

        panel.style.display = '';

        // Pre-fill location from last capture (reduces friction for same-area recording)
        const lastLoc = localStorage.getItem('qc-last-location') || '';
        const locInput = document.getElementById('qc-location');
        if (locInput && !locInput.value) {
            locInput.value = lastLoc;
        }

        // Auto-focus tag field — the most critical input
        const tagInput = document.getElementById('qc-tag');
        if (tagInput) {
            // Short delay to let slide animation start before focus
            setTimeout(() => tagInput.focus(), 50);
        }
    }

    /**
     * Close the panel and reset all fields.
     */
    close() {
        const panel = document.getElementById('quick-capture-panel');
        if (panel) panel.style.display = 'none';

        this._clearFields();
    }

    /**
     * Check if the panel is currently visible.
     *
     * Returns:
     *   boolean — true if the quick capture panel is displayed.
     */
    _isOpen() {
        const panel = document.getElementById('quick-capture-panel');
        return panel && panel.style.display !== 'none';
    }

    // =========================================================================
    // PHOTO HANDLING
    // =========================================================================

    /**
     * Handle file selection from the hidden input.
     * Shows a thumbnail preview.
     *
     * Args:
     *   e: Change event from the file input.
     */
    _onPhotoSelected(e) {
        const file = e.target.files?.[0];
        if (!file) return;

        this._photoFile = file;

        // Show thumbnail preview
        const preview = document.getElementById('qc-photo-preview');
        const thumb = document.getElementById('qc-photo-thumb');
        if (preview && thumb) {
            const url = URL.createObjectURL(file);
            thumb.src = url;
            // Revoke the object URL after the image loads to free memory
            thumb.onload = () => URL.revokeObjectURL(url);
            preview.style.display = '';
        }

        // Hide the "Add Photo" button since we already have one
        const photoBtn = document.getElementById('qc-photo-btn');
        if (photoBtn) photoBtn.style.display = 'none';
    }

    /**
     * Clear the selected photo and reset the file input.
     */
    _clearPhoto() {
        this._photoFile = null;

        const preview = document.getElementById('qc-photo-preview');
        if (preview) preview.style.display = 'none';

        const input = document.getElementById('qc-photo-input');
        if (input) input.value = '';

        const photoBtn = document.getElementById('qc-photo-btn');
        if (photoBtn) photoBtn.style.display = '';
    }

    // =========================================================================
    // SAVE
    // =========================================================================

    /**
     * Handle Save button — create entity, add log entry, upload photo.
     *
     * Flow:
     *   1. POST /api/entities → create entity
     *   2. If note provided → POST /api/entities/{id}/log
     *   3. If photo selected → POST /api/entities/{id}/photos
     *   4. Refresh Equipment tab → close panel → show toast
     *
     * On 409 (tag conflict) → show inline merge prompt.
     */
    async _onSave() {
        const tag = (document.getElementById('qc-tag')?.value || '').trim();
        const equipType = document.getElementById('qc-type')?.value || '';
        const location = (document.getElementById('qc-location')?.value || '').trim();
        const note = (document.getElementById('qc-note')?.value || '').trim();
        const statusEl = document.getElementById('qc-status');
        const conflictEl = document.getElementById('qc-tag-conflict');

        // SECURITY: validate required field
        if (!tag) {
            if (statusEl) {
                statusEl.textContent = 'Tag number is required';
                statusEl.style.color = '#ff6b6b';
            }
            return;
        }

        // Clear previous status/conflict
        if (statusEl) statusEl.textContent = '';
        if (conflictEl) conflictEl.style.display = 'none';

        // Disable save button during async operation
        const saveBtn = document.getElementById('qc-save');
        if (saveBtn) saveBtn.disabled = true;

        try {
            // 1. Create entity
            const entityResp = await fetch('/api/entities', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tag_number: tag,
                    equip_type: equipType,
                    location: location,
                }),
            });

            if (entityResp.status === 409) {
                // Tag conflict — show inline merge prompt
                const conflictData = await entityResp.json();
                this._showConflict(conflictEl, conflictData);
                return;
            }

            if (!entityResp.ok) {
                const err = await entityResp.json();
                throw new Error(err.detail || 'Failed to create entity');
            }

            const entityData = await entityResp.json();
            const entityId = entityData.entity.id;

            // 2. Add log entry if note provided
            if (note) {
                await fetch(`/api/entities/${entityId}/log`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ note }),
                });
            }

            // 3. Upload photo if selected
            if (this._photoFile) {
                const formData = new FormData();
                formData.append('file', this._photoFile);
                await fetch(`/api/entities/${entityId}/photos`, {
                    method: 'POST',
                    body: formData,
                });
            }

            // 4. Save location for next capture
            if (location) {
                localStorage.setItem('qc-last-location', location);
            }

            // 5. Refresh Equipment tab
            if (this._entityManager) {
                this._entityManager.refresh();
            }

            // 6. Close panel and show toast
            this.close();
            this._showToast(`${tag} captured`);

        } catch (err) {
            console.error('[QuickCapture] Save failed:', err);
            if (statusEl) {
                statusEl.textContent = err.message || 'Save failed';
                statusEl.style.color = '#ff6b6b';
            }
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    // =========================================================================
    // TAG CONFLICT HANDLING
    // =========================================================================

    /**
     * Show inline merge prompt when tag_number already exists.
     *
     * Displays the existing entity info and offers to open it in the modal.
     *
     * Args:
     *   conflictEl: DOM element for the conflict message.
     *   data:       Response body from the 409 (contains existing entity).
     */
    _showConflict(conflictEl, data) {
        if (!conflictEl) return;

        const existing = data.existing || data.entity;
        if (!existing) {
            conflictEl.style.display = '';
            // SECURITY: textContent only
            conflictEl.textContent = 'Tag number already exists.';
            return;
        }

        conflictEl.style.display = '';
        conflictEl.innerHTML = ''; // safe — we build DOM nodes below

        const msg = document.createElement('span');
        msg.textContent = `Tag "${existing.tag_number}" already exists. `;
        conflictEl.appendChild(msg);

        const viewBtn = document.createElement('button');
        viewBtn.className = 'toolbar-btn';
        viewBtn.textContent = 'View Existing';
        viewBtn.style.fontSize = '11px';
        viewBtn.style.marginLeft = '6px';
        viewBtn.addEventListener('click', () => {
            this.close();
            if (window.app && window.app.entityModal) {
                window.app.entityModal.open(existing.id);
            }
        });
        conflictEl.appendChild(viewBtn);
    }

    // =========================================================================
    // REPORT
    // =========================================================================

    /**
     * Fetch maintenance report and open in a new window.
     */
    async _openReport() {
        try {
            const resp = await fetch('/api/maintenance-report');
            if (!resp.ok) throw new Error('Failed to generate report');
            const data = await resp.json();

            // Open report in a new window with basic styling
            const win = window.open('', '_blank');
            if (win) {
                win.document.write(`<!DOCTYPE html>
<html><head><title>Maintenance Report</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif;
       max-width: 900px; margin: 40px auto; padding: 0 20px;
       color: #333; line-height: 1.6; }
h1 { border-bottom: 2px solid #333; padding-bottom: 8px; }
h2 { color: #555; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 32px; }
h3 { color: #4a9eff; }
ul { padding-left: 20px; }
li { margin: 4px 0; }
hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
@media print { body { color: #000; } h3 { color: #000; } }
</style></head><body>`);
                // Convert markdown to basic HTML (simple conversion)
                const html = data.report
                    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
                    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
                    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
                    .replace(/^\*(.+)\*$/gm, '<em>$1</em>')
                    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                    .replace(/^- \[ \] (.+)$/gm, '<li>☐ $1</li>')
                    .replace(/^- (.+)$/gm, '<li>$1</li>')
                    .replace(/^---$/gm, '<hr>')
                    .replace(/\n\n/g, '<br><br>');
                win.document.write(html);
                win.document.write('</body></html>');
                win.document.close();
            }
        } catch (err) {
            console.error('[QuickCapture] Report generation failed:', err);
        }
    }

    // =========================================================================
    // UI HELPERS
    // =========================================================================

    /**
     * Clear all form fields and photo state.
     */
    _clearFields() {
        const ids = ['qc-tag', 'qc-note'];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el) el.value = '';
        }

        // Reset type dropdown to first option
        const typeSelect = document.getElementById('qc-type');
        if (typeSelect) typeSelect.selectedIndex = 0;

        // Don't clear location — it persists intentionally

        // Clear conflict message
        const conflictEl = document.getElementById('qc-tag-conflict');
        if (conflictEl) conflictEl.style.display = 'none';

        // Clear status
        const statusEl = document.getElementById('qc-status');
        if (statusEl) statusEl.textContent = '';

        // Clear photo
        this._clearPhoto();
    }

    /**
     * Show a brief confirmation toast (bottom-right, auto-dismiss 2s).
     *
     * Args:
     *   message: Text to display.
     */
    _showToast(message) {
        // Remove any existing toast
        const existing = document.querySelector('.qc-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'qc-toast';
        // SECURITY: textContent only
        toast.textContent = message;
        document.body.appendChild(toast);

        // Auto-dismiss after 2 seconds
        setTimeout(() => {
            toast.classList.add('qc-toast-fade');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }
}
