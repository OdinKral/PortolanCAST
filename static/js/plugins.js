/**
 * PortolanCAST — Plugin Loader
 *
 * Purpose:
 *   Manages plugin registration, lifecycle event emission, and right-panel
 *   tab injection. Plugins receive document/page/selection events and may
 *   optionally render into a dedicated tab in the right properties panel.
 *
 * Security assumptions:
 *   - Plugins are loaded from trusted internal sources only (no remote fetch)
 *   - Each plugin's lifecycle hooks are isolated in try/catch — one bad plugin
 *     cannot crash the host application or prevent other plugins from running
 *
 * Architecture:
 *   App sets `plugins._app = this` after construction to give plugins access
 *   to the App instance without creating circular constructor dependencies.
 *
 * Supported lifecycle events (HOOK_MAP):
 *   'document-loaded'   → onDocumentLoaded(info)
 *   'page-changed'      → onPageChanged(page, total)
 *   'object-selected'   → onObjectSelected(fabricObject)
 *   'object-deselected' → onObjectDeselected()
 *
 * Plugin manifest shape:
 *   {
 *     name: 'my-plugin',     // required — string ID, used as Map key
 *     label: 'My Plugin',    // optional — if present, injects a right-panel tab
 *     version: '1.0.0',      // informational
 *     init(container, app) {},         // called once on register
 *     onDocumentLoaded(info) {},       // optional lifecycle hooks
 *     onPageChanged(page, total) {},
 *     onObjectSelected(obj) {},
 *     onObjectDeselected() {},
 *   }
 *
 * Author: PortolanCAST
 * Version: 1.0.0
 * Date: 2026-02-23
 */

// =============================================================================
// HOOK MAP — maps event name strings to manifest method names
// Closed vocabulary: adding a new lifecycle event requires updating this map.
// =============================================================================

const HOOK_MAP = {
    'document-loaded':   'onDocumentLoaded',
    'page-changed':      'onPageChanged',
    'object-selected':   'onObjectSelected',
    'object-deselected': 'onObjectDeselected',
};

// =============================================================================
// PLUGIN LOADER
// =============================================================================

export class PluginLoader {
    constructor() {
        // Map<name → manifest>: all registered plugins
        this.plugins = new Map();

        // Set by app.js after construction: this.plugins._app = this
        // Avoids circular dependency — App creates PluginLoader, then injects itself
        this._app = null;

        // Current event delegation handler on #right-panel-tabs
        // Stored so we can remove and re-add it when new tabs are injected
        // (keeps the handler idempotent across multiple register() calls)
        this._tabHandler = null;
    }

    /**
     * Initialize the plugin system.
     * Reserved for future directory-scan / manifest discovery.
     * Called by app.init() during startup.
     */
    async loadPlugins() {
        console.log('[Plugins] Plugin loader ready');
    }

    /**
     * Register a plugin with the application.
     *
     * Validates the manifest, stores it in the Map, optionally injects a
     * right-panel tab, then calls manifest.init(container, app).
     *
     * Args:
     *   manifest: Plugin manifest object (see shape in file header).
     */
    register(manifest) {
        // SECURITY: validate required field before anything else
        if (!manifest?.name) {
            console.warn('[Plugins] register() requires manifest.name — plugin ignored');
            return;
        }

        this.plugins.set(manifest.name, manifest);

        // Inject a tab into the right panel if the plugin has a UI label
        if (manifest.label) {
            this._injectTab(manifest);
        }

        // Resolve the container div for this plugin (null for background-only plugins)
        const container = manifest.label
            ? document.getElementById(`tab-plugin-${manifest.name}`)
            : null;

        // Call init() with isolated error handling — a broken plugin must not
        // prevent the rest of the application from loading
        if (typeof manifest.init === 'function') {
            try {
                manifest.init(container, this._app);
            } catch (err) {
                console.warn(`[Plugins] ${manifest.name} init() threw:`, err);
            }
        }

        console.log(`[Plugins] Registered: ${manifest.name} v${manifest.version || '?'}`);
    }

    /**
     * Emit a lifecycle event to all registered plugins.
     *
     * Each plugin's hook is called in a try/catch so one misbehaving
     * plugin never prevents others from receiving the event.
     *
     * Args:
     *   eventName: One of the keys in HOOK_MAP.
     *   ...args:   Arguments forwarded to the hook method.
     */
    emit(eventName, ...args) {
        const hookName = HOOK_MAP[eventName];
        if (!hookName) return; // unknown event — silently ignore

        for (const [name, plugin] of this.plugins) {
            if (typeof plugin[hookName] === 'function') {
                try {
                    plugin[hookName](...args);
                } catch (err) {
                    // Isolate the error — log it but keep delivering to other plugins
                    console.warn(`[Plugins] ${name}.${hookName} threw:`, err);
                }
            }
        }
    }

    // =========================================================================
    // PRIVATE — TAB INJECTION & BINDING
    // =========================================================================

    /**
     * Inject a tab button and content area into the right panel for a plugin.
     *
     * Creates:
     *   - <button class="panel-tab" data-panel="plugin-{name}"> in #right-panel-tabs
     *   - <div id="tab-plugin-{name}" class="tab-content plugin-tab-content"> in #panel-properties
     *
     * Then rebinds the tab click handler so the new button is handled immediately.
     *
     * Args:
     *   manifest: Plugin manifest (name + label required).
     */
    _injectTab(manifest) {
        const tabBar = document.getElementById('right-panel-tabs');
        const panel  = document.getElementById('panel-properties');
        if (!tabBar || !panel) return;

        // Tab button — mirrors left panel pattern (data-panel = content div ID suffix)
        const btn = document.createElement('button');
        btn.className = 'panel-tab';
        btn.dataset.panel = `plugin-${manifest.name}`;
        btn.textContent = manifest.label;
        tabBar.appendChild(btn);

        // Tab content area — plugin renders into this div via init(container, app)
        const content = document.createElement('div');
        content.id = `tab-plugin-${manifest.name}`;
        content.className = 'tab-content plugin-tab-content';
        panel.appendChild(content);

        // Re-bind delegation handler so the new button is covered immediately
        this._bindRightPanelTabs();
    }

    /**
     * Bind (or rebind) the right-panel tab click delegation handler.
     *
     * Uses event delegation on #right-panel-tabs rather than per-button
     * listeners — handles dynamically injected plugin tabs without manual
     * listener management. Removes the previous handler before attaching
     * to stay idempotent across multiple register() calls.
     */
    _bindRightPanelTabs() {
        const tabBar = document.getElementById('right-panel-tabs');
        if (!tabBar) return;

        // Remove previous handler to prevent duplicate firing
        if (this._tabHandler) {
            tabBar.removeEventListener('click', this._tabHandler);
        }

        this._tabHandler = (e) => {
            const btn = e.target.closest('.panel-tab');
            if (!btn) return;

            // Deactivate all tab buttons and content divs in the right panel
            tabBar.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
            document.getElementById('panel-properties')
                .querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            // Activate the clicked tab and its content div
            btn.classList.add('active');
            const content = document.getElementById(`tab-${btn.dataset.panel}`);
            if (content) content.classList.add('active');
        };

        tabBar.addEventListener('click', this._tabHandler);
    }
}
