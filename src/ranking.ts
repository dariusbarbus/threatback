import { ancestorPaths, AncestorPath, Graph, Result } from './graph';
export interface RankingOptions {
    penalizeReciprocal: boolean;
    penalizeDetours: boolean;
    rankOverviews: boolean;
}
export interface RankingIndex {
    outgoing: Map<string, Set<string>>;
    overview: Map<string, number>;
}
/** Uses the original eligible link graph, even when context inference removes an edge. */
export function rankingIndex(raw: Graph): RankingIndex {
    const outgoing = new Map<string, Set<string>>();
    for (const [child, parents] of raw)
        for (const parent of parents) {
            if (!outgoing.has(parent))
                outgoing.set(parent, new Set());
            outgoing.get(parent)!.add(child);
        }
    const overview = new Map<string, number>();
    for (const [node, targets] of outgoing) {
        let breadth = 0;
        for (const target of targets)
            breadth += outgoing.get(target)?.has(node) ? 0.25 : 1;
        // Favor outward breadth over popularity; reciprocal-heavy hubs receive less credit.
        overview.set(node, Math.max(0, Math.log1p(breadth) - 0.5 * Math.log1p(raw.get(node)?.length ?? 0)));
    }
    return { outgoing, overview };
}
export function routeCost(nodes: string[], index: RankingIndex, options: RankingOptions): number {
    let cost = 0;
    if (options.penalizeReciprocal)
        for (let i = 0; i < nodes.length - 1; i++) {
            if (index.outgoing.get(nodes[i + 1])?.has(nodes[i]))
                cost += 2;
        }
    if (options.penalizeDetours) {
        cost += 0.2 * (nodes.length - 1);
        for (let i = 0; i < nodes.length - 2; i++)
            for (let j = i + 2; j < nodes.length; j++) {
                if (index.outgoing.get(nodes[i])?.has(nodes[j]))
                    cost += 2 * (j - i - 1);
            }
    }
    if (options.rankOverviews)
        cost -= index.overview.get(nodes[0]) ?? 0;
    return cost;
}
/** Bounded best-first traversal ranks before output caps, rather than sorting a DFS sample. */
export function rankedPaths(graph: Graph, target: string, depth: number, index: RankingIndex, options: RankingOptions, maxPaths = 100, maxSteps = 5000): Result {
    if (!options.penalizeReciprocal && !options.penalizeDetours && !options.rankOverviews)
        return ancestorPaths(graph, target, depth, maxPaths, maxSteps);
    depth = Math.max(1, Math.min(20, Math.floor(depth) || 5));
    const compare = (a: string[], b: string[]) => routeCost(a, index, options) - routeCost(b, index, options)
        || a.length - b.length || JSON.stringify(a).localeCompare(JSON.stringify(b));
    type Entry = {
        nodes: string[];
        cost: number;
        key: string;
    };
    const queue: Entry[] = [];
    const entryCompare = (a: Entry, b: Entry) => a.cost - b.cost || a.nodes.length - b.nodes.length || a.key.localeCompare(b.key);
    const push = (nodes: string[]) => {
        const entry = { nodes, cost: routeCost(nodes, index, options), key: JSON.stringify(nodes) };
        queue.push(entry);
        let i = queue.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (entryCompare(queue[parent], queue[i]) <= 0)
                break;
            [queue[parent], queue[i]] = [queue[i], queue[parent]];
            i = parent;
        }
    };
    const pop = (): string[] => {
        const first = queue[0];
        const last = queue.pop()!;
        if (queue.length) {
            queue[0] = last;
            let i = 0;
            while (true) {
                let next = i;
                const left = 2 * i + 1, right = left + 1;
                if (left < queue.length && entryCompare(queue[left], queue[next]) < 0)
                    next = left;
                if (right < queue.length && entryCompare(queue[right], queue[next]) < 0)
                    next = right;
                if (next === i)
                    break;
                [queue[i], queue[next]] = [queue[next], queue[i]];
                i = next;
            }
        }
        return first.nodes;
    };
    push([target]);
    const candidates = new Map<string, AncestorPath>();
    let steps = 0, generated = 1, limited = false;
    while (queue.length && steps++ < maxSteps) {
        const nodes = pop();
        const parents = graph.get(nodes[0]) ?? [];
        const available = parents.filter(p => !nodes.includes(p));
        const end: AncestorPath['end'] = !parents.length ? 'root' : nodes.length - 1 >= depth ? 'depth' : !available.length ? 'cycle' : 'overview';
        // Overview starts are navigation candidates; never claim they are true roots.
        if (nodes.length > 1 && (end !== 'overview' || options.rankOverviews))
            candidates.set(JSON.stringify(nodes), { nodes, end });
        if (end !== 'overview')
            continue;
        const next = available.map(p => [p, ...nodes]).sort(compare);
        for (const path of next) {
            if (generated >= maxSteps) {
                limited = true;
                break;
            }
            push(path);
            generated++;
        }
    }
    const paths = [...candidates.values()].sort((a, b) => compare(a.nodes, b.nodes));
    return { paths: paths.slice(0, maxPaths), limited: limited || queue.length > 0 || paths.length > maxPaths };
}
