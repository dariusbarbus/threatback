import { App, getLinkpath, MarkdownView, Plugin, PluginSettingTab, Setting, type SettingDefinitionControl, WorkspaceLeaf } from 'obsidian';
import { buildGraph, defaults, excluded, Graph, normalizeSettings, Result, Settings } from './graph';
import { inferGraph, linkContext, LinkEvidence } from './inference';
import { rankedPaths, rankingIndex } from './ranking';
import { SessionTrails } from './session';
interface Panel {
    leaf: WorkspaceLeaf;
    capture: (event: Event) => void;
    sessionElement: HTMLElement;
    sessionSignature: string;
    sessionVisible: boolean;
    element: HTMLElement;
    observer: MutationObserver;
    signature: string;
    expanded: boolean;
    file: string;
}
export default class Threatback extends Plugin {
    settings: Settings = defaults;
    private linkIntents = new Map<WorkspaceLeaf, {
        source: string;
        target: string;
        time: number;
    }>();
    private sessions = new SessionTrails<WorkspaceLeaf>();
    private graph: Graph = new Map();
    private ranking = rankingIndex(new Map());
    private panels = new Map<MarkdownView, Panel>();
    private results = new Map<string, Result>();
    private timer: number | undefined;
    private stopped = false;
    private generation = 0;
    async onload() {
        this.settings = normalizeSettings(await this.loadData());
        this.addSettingTab(new ThreatbackSettings(this.app, this));
        const schedule = () => this.schedule();
        this.registerEvent(this.app.metadataCache.on('changed', schedule));
        this.registerEvent(this.app.metadataCache.on('resolve', schedule));
        this.registerEvent(this.app.metadataCache.on('resolved', schedule));
        this.registerEvent(this.app.metadataCache.on('deleted', schedule));
        this.registerEvent(this.app.vault.on('create', schedule));
        this.registerEvent(this.app.vault.on('delete', file => { this.sessions.delete(file.path); this.render(); schedule(); }));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { this.sessions.rename(oldPath, file.path); this.render(); schedule(); }));
        this.registerEvent(this.app.workspace.on('layout-change', () => this.render()));
        this.registerEvent(this.app.workspace.on('file-open', () => this.render()));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.render()));
        this.app.workspace.onLayoutReady(() => { if (!this.stopped) {
            this.render();
            void this.rebuild();
        } });
    }
    private schedule() {
        if (this.stopped)
            return;
        this.generation++; // invalidate in-flight reads immediately
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => { void this.rebuild(); }, 120);
    }
    private async rebuild() {
        if (this.stopped)
            return;
        const generation = ++this.generation;
        if (!this.settings.showInferredPaths) {
            this.graph.clear();
            this.ranking = rankingIndex(new Map());
            this.results.clear();
            this.render();
            return;
        }
        const folders = [...this.settings.excludedFolders];
        // Only inspect notes already participating in Obsidian's resolved link cache.
        const indexedPaths = new Set<string>();
        for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
            indexedPaths.add(source);
            for (const target of Object.keys(targets)) indexedPaths.add(target);
        }
        const files = [...indexedPaths]
            .filter(path => !excluded(path, folders))
            .map(path => this.app.vault.getFileByPath(path))
            .filter((file): file is NonNullable<typeof file> => !!file && file.extension === 'md');
        const allowed = new Set(files.map(file => file.path));
        const rawGraph = buildGraph(this.app.metadataCache.resolvedLinks, allowed, folders);
        if (!this.settings.useHeuristics) {
            this.ranking = rankingIndex(rawGraph);
            this.graph = rawGraph;
            this.results.clear();
            this.render();
            return;
        }
        const evidence: LinkEvidence[] = [];
        let cursor = 0;
        // Limit concurrent reads. Obsidian's cachedRead avoids unnecessary disk reads.
        const worker = async () => {
            while (cursor < files.length && !this.stopped && generation === this.generation) {
                const file = files[cursor++];
                const cache = this.app.metadataCache.getFileCache(file);
                if (!cache?.links?.length)
                    continue;
                try {
                    const text = await this.app.vault.cachedRead(file);
                    for (const link of cache.links) {
                        const path = getLinkpath(link.link);
                        const target = path ? this.app.metadataCache.getFirstLinkpathDest(path, file.path) : file;
                        if (!target || !allowed.has(target.path) || target.path === file.path)
                            continue;
                        const heading = [...(cache.headings ?? [])].reverse()
                            .find(h => h.position.start.offset < link.position.start.offset)?.heading ?? '';
                        evidence.push({ source: file.path, target: target.path,
                            ...linkContext(text, link.position.start.offset, link.position.end.offset, heading) });
                    }
                }
                catch {
                    // A deleted/unreadable file must not prevent other notes from being indexed.
                    console.warn('Threatback: a note could not be indexed.');
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
        if (this.stopped || generation !== this.generation)
            return;
        this.graph = inferGraph(evidence);
        this.ranking = rankingIndex(rawGraph);
        this.results.clear();
        this.render();
    }
    async updateSettings(value: unknown) {
        this.settings = normalizeSettings(value);
        if (!this.settings.showSessionTrail) {
            this.sessions.clear();
            this.linkIntents.clear();
        }
        for (const folder of this.settings.excludedFolders)
            this.sessions.delete(folder);
        this.render();
        await this.rebuild();
        await this.saveData(this.settings);
    }
    private render() {
        if (this.stopped)
            return;
        const allLeaves = new Set<WorkspaceLeaf>();
        this.app.workspace.iterateAllLeaves(leaf => { allLeaves.add(leaf); });
        this.sessions.retain(allLeaves);
        for (const leaf of this.linkIntents.keys())
            if (!allLeaves.has(leaf))
                this.linkIntents.delete(leaf);
        const live = new Set<MarkdownView>();
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            if (!(leaf.view instanceof MarkdownView))
                continue;
            const view = leaf.view;
            live.add(view);
            let panel = this.panels.get(view);
            if (!panel) {
                const element = view.contentEl.createEl('nav');
                const sessionElement = view.contentEl.createEl('nav');
                sessionElement.remove();
                sessionElement.className = 'threatback threatback-session';
                sessionElement.setAttribute('aria-label', 'Navigation trail');
                element.className = 'threatback';
                element.setAttribute('aria-label', 'Likely ancestor breadcrumb paths');
                // Observe only the public container's immediate children, never editor mutations.
                const observer = new MutationObserver(() => {
                    if (!this.stopped && element.parentElement !== view.contentEl)
                        view.contentEl.prepend(element);
                    if (panel?.sessionVisible && sessionElement.parentElement !== view.contentEl)
                        view.contentEl.prepend(sessionElement);
                });
                observer.observe(view.contentEl, { childList: true });
                const capture = (event: Event) => this.captureNoteLink(leaf, view, event);
                view.contentEl.addEventListener('pointerdown', capture, true);
                view.contentEl.addEventListener('click', capture, true);
                view.contentEl.addEventListener('keydown', capture, true);
                panel = { leaf, capture, sessionElement, sessionSignature: '', sessionVisible: false, element, observer, signature: '', expanded: false, file: '' };
                this.panels.set(view, panel);
                view.contentEl.prepend(element);
            }
            const target = view.file?.path ?? '';
            this.drawSession(leaf, view, panel, target);
            if (panel.file !== target) {
                panel.file = target;
                panel.expanded = false;
            }
            let result: Result = { paths: [], limited: false };
            if (this.settings.showInferredPaths && target && !excluded(target, this.settings.excludedFolders)) {
                result = this.results.get(target) ?? rankedPaths(this.graph, target, this.settings.maxDepth, this.ranking, this.settings);
                this.results.set(target, result);
            }
            const signature = JSON.stringify([target, result, panel.expanded, this.settings.useHeuristics, this.settings.showInferredPaths]);
            if (signature === panel.signature)
                continue;
            panel.signature = signature;
            this.draw(panel, result);
        }
        for (const [view, panel] of this.panels) {
            if (!live.has(view)) {
                this.removePanel(view, panel);
                this.panels.delete(view);
            }
        }
    }
    private captureNoteLink(leaf: WorkspaceLeaf, view: MarkdownView, event: Event) {
        if (!this.settings.showSessionTrail)
            return;
        if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Enter')
            return;
        if (event.type !== 'keydown' && (event as MouseEvent).button !== 0)
            return;
        const element = event.target as HTMLElement | null;
        const link = element?.closest?.('a.internal-link, .cm-hmd-internal-link, .cm-link');
        if (!link || link.closest('.threatback') || !view.file)
            return;
        const source = view.file.path;
        const href = link.getAttribute('data-href') ?? link.getAttribute('href');
        let target: string | undefined;
        if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
            target = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(href), source)?.path;
        }
        else if (!href) {
            // Live Preview spans may expose only an alias: resolve through cached references.
            const label = link.textContent?.trim();
            const destinations = new Set((this.app.metadataCache.getFileCache(view.file)?.links ?? [])
                .filter(ref => ref.displayText === label || ref.link === label)
                .map(ref => this.app.metadataCache.getFirstLinkpathDest(getLinkpath(ref.link), source)?.path)
                .filter((path): path is string => !!path));
            if (destinations.size === 1)
                target = [...destinations][0];
        }
        if (target && target !== source)
            this.linkIntents.set(leaf, { source, target, time: Date.now() });
    }
    private followBreadcrumb(leaf: WorkspaceLeaf, path: string, newTab: boolean) {
        const file = this.app.vault.getFileByPath(path);
        if (!file)
            return;
        const trail = this.sessions.get(leaf);
        if (!newTab && trail.length)
            this.linkIntents.set(leaf, { source: trail[trail.length - 1], target: path, time: Date.now() });
        void (newTab ? this.app.workspace.getLeaf('tab') : leaf).openFile(file).catch(() => { this.linkIntents.delete(leaf); });
    }
    private removePanel(view: MarkdownView, panel: Panel) {
        panel.observer.disconnect();
        panel.element.remove();
        panel.sessionElement.remove();
        for (const type of ['pointerdown', 'click', 'keydown'])
            view.contentEl.removeEventListener(type, panel.capture, true);
    }
    private drawSession(leaf: WorkspaceLeaf, view: MarkdownView, panel: Panel, target: string) {
        if (!this.settings.showSessionTrail || !target || !this.app.vault.getFileByPath(target) || excluded(target, this.settings.excludedFolders)) {
            // Break history at excluded/non-note content rather than implying an unseen route.
            this.sessions.forget(leaf);
        }
        else {
            const trail = this.sessions.get(leaf);
            const previous = trail[trail.length - 1];
            if (previous && previous !== target) {
                const intent = this.linkIntents.get(leaf);
                this.linkIntents.delete(leaf);
                if (!intent || intent.source !== previous || intent.target !== target || Date.now() - intent.time > 1500)
                    this.sessions.forget(leaf);
            }
            this.sessions.visit(leaf, target);
        }
        const trail = this.sessions.get(leaf);
        const signature = JSON.stringify(trail);
        panel.sessionVisible = trail.length > 1;
        if (!panel.sessionVisible)
            panel.sessionElement.remove();
        else if (panel.sessionElement.parentElement !== view.contentEl)
            view.contentEl.prepend(panel.sessionElement);
        if (signature === panel.sessionSignature)
            return;
        panel.sessionSignature = signature;
        const el = panel.sessionElement;
        el.replaceChildren();
        const row = el.createDiv({ cls: 'threatback-path' });
        trail.forEach((path, index) => {
            if (index)
                row.createSpan({ text: ' › ', attr: { 'aria-hidden': 'true' } });
            const link = row.createEl('a', { text: path.split('/').pop()!.replace(/\.md$/i, ''),
                cls: 'internal-link', attr: { href: '#', title: path } });
            if (index === trail.length - 1)
                link.setAttribute('aria-current', 'page');
            link.addEventListener('click', event => {
                event.preventDefault();
                const file = this.app.vault.getFileByPath(path);
                if (file)
                    this.followBreadcrumb(leaf, path, !!(event.ctrlKey || event.metaKey));
            });
        });
        row.scrollLeft = row.scrollWidth; // keep the current end visible in a long trail
    }
    private draw(panel: Panel, result: Result) {
        const el = panel.element;
        el.replaceChildren();
        el.hidden = !this.settings.showInferredPaths || (!result.paths.length && !result.limited);
        el.setAttribute('data-expanded', String(panel.expanded));
        el.setAttribute('aria-label', this.settings.useHeuristics ? 'Likely ancestor breadcrumb paths' : 'Incoming link breadcrumb paths');
        el.setAttribute('title', result.limited ? 'Some paths omitted to keep navigation fast.'
            : this.settings.useHeuristics ? 'Likely ancestors inferred from link context; may be inaccurate.' : 'All incoming links; related notes may appear as ancestors.');
        for (const path of result.paths.slice(0, panel.expanded ? undefined : 1)) {
            const row = el.createDiv({ cls: 'threatback-path' });
            if (path.end !== 'root') {
                row.createSpan({ text: '… ', attr: { title: path.end === 'cycle' ? 'Cycle stopped here' : path.end === 'overview' ? 'Suggested starting point; earlier links may exist' : 'Maximum ancestor depth reached' } });
            }
            path.nodes.forEach((node, index) => {
                if (index)
                    row.createSpan({ text: ' › ', attr: { 'aria-hidden': 'true' } });
                const link = row.createEl('a', { text: node.split('/').pop()!.replace(/\.md$/i, ''),
                    cls: 'internal-link', attr: { href: '#', title: node } });
                if (index === path.nodes.length - 1)
                    link.setAttribute('aria-current', 'page');
                link.addEventListener('click', event => {
                    event.preventDefault();
                    // Exact cached vault path avoids ambiguity from duplicate basenames.
                    const file = this.app.vault.getFileByPath(node);
                    if (file)
                        this.followBreadcrumb(panel.leaf, node, !!(event.ctrlKey || event.metaKey));
                });
            });
        }
        if (result.paths.length > 1) {
            const label = panel.expanded ? 'Collapse ancestor paths' : `Show ${result.paths.length - 1}${result.limited ? ' or more' : ''} additional ancestor paths`;
            const button = el.createEl('button', { cls: 'threatback-toggle',
                text: panel.expanded ? '−' : `+${result.paths.length - 1}${result.limited ? '+' : ''}`,
                attr: { 'aria-label': label, title: label } });
            button.setAttribute('aria-expanded', String(panel.expanded));
            button.addEventListener('click', () => { panel.expanded = !panel.expanded; this.render(); });
        }
        if (result.limited && !result.paths.length) {
            el.createSpan({ text: '…', attr: { title: 'Traversal limit reached; no paths available.', 'aria-label': 'Traversal limit reached' } });
        }
    }
    onunload() {
        this.stopped = true;
        this.generation++;
        window.clearTimeout(this.timer);
        for (const [view, panel] of this.panels)
            this.removePanel(view, panel);
        this.linkIntents.clear();
        this.sessions.clear();
        this.panels.clear();
        this.results.clear();
    }
}
class ThreatbackSettings extends PluginSettingTab {
    constructor(app: App, private plugin: Threatback) { super(app, plugin); }

    getSettingDefinitions(): SettingDefinitionControl<keyof Settings>[] {
        return [
            {
                name: 'Show navigation trail',
                desc: 'Remember your route in each tab for this session. Clicking an earlier note trims the trail. Turning this off clears it.',
                control: { type: 'toggle', key: 'showSessionTrail' }
            },
            {
                name: 'Show inferred paths',
                desc: 'Show paths calculated from note links. Turn off to use only your navigation trail; link analysis is paused.',
                control: { type: 'toggle', key: 'showInferredPaths' }
            },
            {
                name: 'Use local heuristics',
                desc: 'Infer likely parents from link context. Turn off to follow all incoming links. Depth, exclusions and safety limits apply in both modes.',
                control: { type: 'toggle', key: 'useHeuristics' }
            },
            {
                name: 'Penalize reciprocal links',
                desc: 'Prefer routes with fewer links that point both ways. Applies in both link modes.',
                control: { type: 'toggle', key: 'penalizeReciprocal' }
            },
            {
                name: 'Penalize detours',
                desc: 'Prefer direct routes over longer routes with shortcut links. Applies in both link modes.',
                control: { type: 'toggle', key: 'penalizeDetours' }
            },
            {
                name: 'Rank likely overview notes',
                desc: 'Favor starting notes with broad outward links. Suggested starts may have earlier links. Applies in both link modes.',
                control: { type: 'toggle', key: 'rankOverviews' }
            },
            {
                name: 'Maximum ancestor depth',
                desc: 'Number of ancestor links to follow (1–20). Default: 5.',
                control: { type: 'dropdown', key: 'maxDepth', options: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i + 1), String(i + 1)])) }
            },
            {
                name: 'Excluded folders',
                desc: 'One vault-relative folder per line. Includes subfolders; excluded notes are not traversed.',
                control: { type: 'textarea', key: 'excludedFolders', rows: 4 }
            }
        ];
    }

    getControlValue(key: string): unknown {
        if (key === 'excludedFolders') return this.plugin.settings.excludedFolders.join('\n');
        if (key === 'maxDepth') return String(this.plugin.settings.maxDepth);
        return this.plugin.settings[key as keyof Settings];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        if (!Object.prototype.hasOwnProperty.call(defaults, key)) return;
        const next = key === 'excludedFolders' && typeof value === 'string' ? value.split('\n')
            : key === 'maxDepth' ? Number(value) : value;
        await this.plugin.updateSettings({ ...this.plugin.settings, [key]: next });
    }

    display() {
        // Newer hosts render/search definitions; older hosts keep the same controls.
        if (typeof PluginSettingTab.prototype.getSettingDefinitions === 'function') {
            super.display();
            return;
        }
        this.containerEl.empty();
        for (const definition of this.getSettingDefinitions()) {
            const setting = new Setting(this.containerEl).setName(definition.name).setDesc(definition.desc ?? '');
            const control = definition.control;
            const value = this.getControlValue(control.key);
            if (control.type === 'toggle') {
                setting.addToggle(toggle => toggle.setValue(Boolean(value)).onChange(next => this.setControlValue(control.key, next)));
            } else if (control.type === 'dropdown') {
                setting.addDropdown(dropdown => dropdown.addOptions(control.options).setValue(String(value)).onChange(next => this.setControlValue(control.key, next)));
            } else if (control.type === 'textarea') {
                setting.addTextArea(text => text.setValue(String(value)).onChange(next => this.setControlValue(control.key, next)));
            }
        }
    }
}
