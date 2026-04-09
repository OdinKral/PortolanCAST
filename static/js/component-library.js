/**
 * PortolanCAST — Component Library Panel
 *
 * Purpose:
 *   Right-docked panel for browsing, searching, and stamping reusable
 *   components harvested from document regions. Supports pop-out to
 *   a separate browser window via BroadcastChannel.
 *
 * Security:
 *   - Component names set via textContent (never innerHTML)
 *   - Thumbnail URLs are server-provided relative paths
 */

export class ComponentLibrary {
    constructor() {
        this._components = [];
        this._tags = [];
        this._activeTags = new Set();
        this._searchQuery = '';
        this._toolbar = null;
        this._visible = false;
        this._channel = new BroadcastChannel('portolancast-components');

        window.addEventListener('component-harvested', () => this.refresh());

        this._channel.onmessage = (e) => {
            if (e.data?.type === 'stamp' && e.data.componentId) {
                this._enterStampMode(e.data.componentId);
            }
        };
    }

    init(toolbar) {
        this._toolbar = toolbar;
        this._bindToggle();
        this._bindSearch();
        this._bindImport();
    }

    toggle() {
        this._visible = !this._visible;
        const panel = document.getElementById('component-library-panel');
        if (panel) panel.style.display = this._visible ? 'flex' : 'none';
        if (this._visible) this.refresh();
    }

    show() {
        this._visible = true;
        const panel = document.getElementById('component-library-panel');
        if (panel) panel.style.display = 'flex';
        this.refresh();
    }

    hide() {
        this._visible = false;
        const panel = document.getElementById('component-library-panel');
        if (panel) panel.style.display = 'none';
    }

    async refresh() {
        await this._fetchComponents();
        await this._fetchTags();
        this._renderGrid();
        this._renderTagChips();
    }

    // =========================================================================
    // DATA FETCHING
    // =========================================================================

    async _fetchComponents() {
        const params = new URLSearchParams();
        if (this._activeTags.size > 0) {
            params.set('tags', [...this._activeTags].join(','));
        }
        if (this._searchQuery) {
            params.set('search', this._searchQuery);
        }
        try {
            const resp = await fetch(`/api/components?${params}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._components = data.components || [];
        } catch (err) {
            console.error('[ComponentLibrary] Fetch failed:', err);
            this._components = [];
        }
    }

    async _fetchTags() {
        try {
            const resp = await fetch('/api/components/tags');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._tags = data.tags || [];
        } catch (err) {
            console.error('[ComponentLibrary] Tags fetch failed:', err);
            this._tags = [];
        }
    }

    // =========================================================================
    // RENDERING
    // =========================================================================

    _renderGrid() {
        const grid = document.getElementById('component-library-grid');
        if (!grid) return;
        grid.textContent = '';

        if (this._components.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'component-library-empty';
            empty.textContent = 'No components yet. Use the Harvest tool (Y) to capture regions from documents.';
            grid.appendChild(empty);
            return;
        }

        for (const comp of this._components) {
            const cell = document.createElement('div');
            cell.className = 'component-library-cell';
            cell.dataset.componentId = comp.id;

            const thumb = document.createElement('img');
            thumb.className = 'component-library-thumb';
            thumb.src = comp.thumb_url;
            thumb.alt = comp.name;
            thumb.loading = 'lazy';

            const name = document.createElement('div');
            name.className = 'component-library-name';
            name.textContent = comp.name;
            name.title = comp.name;

            cell.appendChild(thumb);
            cell.appendChild(name);

            cell.addEventListener('click', () => {
                this._enterStampMode(comp.id);
            });

            cell.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this._showContextMenu(e, comp);
            });

            grid.appendChild(cell);
        }
    }

    _renderTagChips() {
        const container = document.getElementById('component-library-tags');
        if (!container) return;
        container.textContent = '';

        for (const tagInfo of this._tags) {
            const chip = document.createElement('span');
            chip.className = 'component-tag-chip';
            if (this._activeTags.has(tagInfo.tag)) {
                chip.classList.add('active');
            }
            chip.textContent = `${tagInfo.tag} (${tagInfo.count})`;
            chip.addEventListener('click', () => {
                if (this._activeTags.has(tagInfo.tag)) {
                    this._activeTags.delete(tagInfo.tag);
                } else {
                    this._activeTags.add(tagInfo.tag);
                }
                this.refresh();
            });
            container.appendChild(chip);
        }
    }

    // =========================================================================
    // BINDINGS
    // =========================================================================

    _bindToggle() {
        const closeBtn = document.getElementById('component-library-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.hide());

        const popoutBtn = document.getElementById('component-library-popout');
        if (popoutBtn) popoutBtn.addEventListener('click', () => this._popOut());
    }

    _bindSearch() {
        const input = document.getElementById('component-library-search');
        if (!input) return;
        let debounce = null;
        input.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                this._searchQuery = input.value.trim();
                this.refresh();
            }, 300);
        });
    }

    _bindImport() {
        const btn = document.getElementById('component-library-import');
        const input = document.getElementById('component-import-input');
        if (!btn || !input) return;

        btn.addEventListener('click', () => input.click());
        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            input.value = '';
            if (!file) return;

            const form = new FormData();
            form.append('file', file);
            form.append('mode', 'create');

            try {
                const resp = await fetch('/api/components/import', {
                    method: 'POST',
                    body: form,
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                console.log('[ComponentLibrary] Imported:', data.imported?.length, 'components');
                this.refresh();
            } catch (err) {
                console.error('[ComponentLibrary] Import failed:', err);
            }
        });
    }

    // =========================================================================
    // STAMP MODE
    // =========================================================================

    _enterStampMode(componentId) {
        const comp = this._components.find(c => c.id === componentId);
        if (!comp || !this._toolbar) return;

        this._toolbar._stampComponent = comp;
        this._toolbar.setTool('component-stamp');
    }

    // =========================================================================
    // POP-OUT WINDOW
    // =========================================================================

    _popOut() {
        const url = '/static/component-library-popout.html';
        const win = window.open(url, 'ComponentLibrary',
            'width=350,height=600,resizable=yes,scrollbars=yes');

        if (win) {
            this.hide();
            const check = setInterval(() => {
                if (win.closed) {
                    clearInterval(check);
                    this.show();
                }
            }, 1000);
        }
    }

    // =========================================================================
    // CONTEXT MENU
    // =========================================================================

    _showContextMenu(event, comp) {
        this._removeContextMenu();

        const menu = document.createElement('div');
        menu.className = 'component-context-menu';
        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;

        const entityLabel = comp.prompt_entity
            ? '✓ Equipment Symbol' : 'Use as Equipment Symbol';
        const items = [
            { label: 'Rename', action: () => this._renameComponent(comp) },
            { label: 'Edit Tags', action: () => this._editTags(comp) },
            { label: entityLabel, action: () => this._togglePromptEntity(comp) },
            { label: 'Export SVG', action: () => window.open(comp.svg_url) },
            { label: 'Export PNG', action: () => window.open(comp.png_url) },
            { label: 'Delete', action: () => this._deleteComponent(comp) },
        ];

        for (const item of items) {
            const el = document.createElement('div');
            el.className = 'component-context-item';
            el.textContent = item.label;
            el.addEventListener('click', () => {
                this._removeContextMenu();
                item.action();
            });
            menu.appendChild(el);
        }

        document.body.appendChild(menu);
        this._activeContextMenu = menu;

        const closer = (e) => {
            if (!menu.contains(e.target)) {
                this._removeContextMenu();
                document.removeEventListener('click', closer);
            }
        };
        setTimeout(() => document.addEventListener('click', closer), 0);
    }

    _removeContextMenu() {
        if (this._activeContextMenu) {
            this._activeContextMenu.remove();
            this._activeContextMenu = null;
        }
    }

    async _renameComponent(comp) {
        const newName = prompt('Rename component:', comp.name);
        if (!newName || newName.trim() === comp.name) return;
        try {
            await fetch(`/api/components/${comp.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName.trim() }),
            });
            this.refresh();
        } catch (err) {
            console.error('[ComponentLibrary] Rename failed:', err);
        }
    }

    async _togglePromptEntity(comp) {
        try {
            await fetch(`/api/components/${comp.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt_entity: !comp.prompt_entity }),
            });
            this.refresh();
        } catch (err) {
            console.error('[ComponentLibrary] Toggle prompt_entity failed:', err);
        }
    }

    async _editTags(comp) {
        const current = comp.tags?.join(', ') || '';
        const newTags = prompt('Edit tags (comma-separated):', current);
        if (newTags === null) return;
        const tags = newTags.split(',').map(t => t.trim().toLowerCase()).filter(t => t);
        try {
            await fetch(`/api/components/${comp.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags }),
            });
            this.refresh();
        } catch (err) {
            console.error('[ComponentLibrary] Edit tags failed:', err);
        }
    }

    async _deleteComponent(comp) {
        if (!confirm(`Delete "${comp.name}"?`)) return;
        try {
            await fetch(`/api/components/${comp.id}`, { method: 'DELETE' });
            this.refresh();
        } catch (err) {
            console.error('[ComponentLibrary] Delete failed:', err);
        }
    }
}
