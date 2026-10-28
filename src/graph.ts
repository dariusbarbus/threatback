export interface Settings {
    showInferredPaths: boolean;
    showSessionTrail: boolean;
    penalizeReciprocal: boolean;
    penalizeDetours: boolean;
    rankOverviews: boolean;
    maxDepth: number;
    useHeuristics: boolean;
    excludedFolders: string[];
}
export const defaults: Settings = { showInferredPaths: true, showSessionTrail: true, penalizeReciprocal: true, penalizeDetours: true, rankOverviews: true, maxDepth: 5, useHeuristics: true, excludedFolders: [] };
export function normalizeSettings(value: unknown): Settings {
    const v = (value && typeof value === 'object' ? value : {}) as Partial<Settings>;
    return {
        showInferredPaths: typeof v.showInferredPaths === 'boolean' ? v.showInferredPaths : true,
        showSessionTrail: typeof v.showSessionTrail === 'boolean' ? v.showSessionTrail : true,
        penalizeReciprocal: typeof v.penalizeReciprocal === 'boolean' ? v.penalizeReciprocal : true,
        penalizeDetours: typeof v.penalizeDetours === 'boolean' ? v.penalizeDetours : true,
        rankOverviews: typeof v.rankOverviews === 'boolean' ? v.rankOverviews : true,
        useHeuristics: typeof v.useHeuristics === 'boolean' ? v.useHeuristics : true,
        maxDepth: typeof v.maxDepth === 'number' && Number.isFinite(v.maxDepth)
            ? Math.max(1, Math.min(20, Math.floor(v.maxDepth))) : 5,
        excludedFolders: Array.isArray(v.excludedFolders)
            ? [...new Set(v.excludedFolders.filter((x): x is string => typeof x === 'string')
                    .map(x => x.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean))] : []
    };
}
export function excluded(path: string, folders: string[]): boolean {
    return folders.some(f => path === f || path.startsWith(f + '/'));
}
export type Graph = Map<string, string[]>;
/** Obsidian resolves aliases, relative Markdown links and heading/block links. */
export function buildGraph(links: Record<string, Record<string, number>>, files: Set<string>, folders: string[]): Graph {
    const parents = new Map<string, Set<string>>();
    for (const [source, targets] of Object.entries(links)) {
        if (!files.has(source) || excluded(source, folders))
            continue;
        for (const [target, count] of Object.entries(targets)) {
            if (count <= 0 || source === target || !files.has(target) || excluded(target, folders))
                continue;
            if (!parents.has(target))
                parents.set(target, new Set());
            parents.get(target)!.add(source);
        }
    }
    return new Map([...parents].map(([key, values]) => [key, [...values].sort()]));
}
export interface AncestorPath {
    nodes: string[];
    end: 'root' | 'depth' | 'cycle' | 'overview';
}
export interface Result {
    paths: AncestorPath[];
    limited: boolean;
}
/** Iterative DFS, branch-local cycle detection; bounded output AND work. */
export function ancestorPaths(graph: Graph, target: string, depth: number, maxPaths = 100, maxSteps = 5000): Result {
    depth = Math.max(1, Math.min(20, Math.floor(depth) || 5));
    const paths: AncestorPath[] = [];
    const seen = new Set<string>();
    const stack = [{ nodes: [target] }];
    let steps = 0;
    let clipped = false;
    const emit = (nodes: string[], end: AncestorPath['end']) => {
        if (nodes.length < 2)
            return;
        const key = JSON.stringify(nodes);
        if (!seen.has(key)) {
            seen.add(key);
            paths.push({ nodes: [...nodes].reverse(), end });
        }
    };
    while (stack.length && paths.length < maxPaths && steps < maxSteps) {
        steps++;
        const { nodes } = stack.pop()!;
        const parents = graph.get(nodes[nodes.length - 1]) ?? [];
        if (!parents.length) {
            emit(nodes, 'root');
            continue;
        }
        if (nodes.length - 1 >= depth) {
            emit(nodes, 'depth');
            continue;
        }
        const available = parents.filter(p => !nodes.includes(p));
        if (!available.length) {
            emit(nodes, 'cycle');
            continue;
        }
        // Mixed branches still expose that a cycle was cut through a separate terminal path.
        if (available.length < parents.length)
            emit(nodes, 'cycle');
        const capacity = Math.max(0, maxSteps - steps - stack.length);
        const count = Math.min(available.length, capacity);
        if (count < available.length)
            clipped = true;
        for (let i = count - 1; i >= 0; i--) {
            stack.push({ nodes: [...nodes, available[i]] });
        }
    }
    return { paths, limited: clipped || stack.length > 0 };
}
