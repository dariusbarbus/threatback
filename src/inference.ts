import { Graph } from './graph';
export interface LinkEvidence {
    source: string;
    target: string;
    before: string;
    after: string;
    heading: string;
}
interface Candidate {
    parent: string;
    child: string;
    score: number;
}
/** Local English-language clues only; no semantic certainty is claimed. */
export function inferGraph(references: LinkEvidence[]): Graph {
    const candidates = new Map<string, Candidate>();
    const put = (parent: string, child: string, score: number) => {
        if (parent === child)
            return;
        const key = JSON.stringify([parent, child]);
        if ((candidates.get(key)?.score ?? -Infinity) < score)
            candidates.set(key, { parent, child, score });
    };
    for (const ref of references) {
        const before = ref.before.toLowerCase();
        const after = ref.after.toLowerCase();
        const heading = ref.heading.toLowerCase();
        // "This is the second layer of [[AI]]" is evidence for AI -> this note.
        const upward = /\b(?:part|layer|type|kind|subset|subtopic|branch|component|member)\s+of\s*(?:the\s+)?$/.test(before)
            || /\b(?:belongs?\s+to|parent(?:\s+note)?\s*:)\s*$/.test(before)
            || (/\b(?:first|second|third|\d+(?:st|nd|rd|th))\s*$/.test(before)
                && /^layers? of /i.test(ref.target.split('/').pop() ?? ''));
        const downward = /\b(?:includes?|contains?|consists?\s+of|divided\s+into|such\s+as|subtopics?\s*:)\s*$/.test(before)
            || /^\s*(?:is|are)\s+(?:(?:a|an|the|first|second|third|\w+th)\s+)*(?:layer|type|kind|part|subtopic|component)\s+of\s+(?:this|the\s+current)\b/.test(after);
        const related = /\b(?:see\s+also|related|references?|further\s+reading|bibliography)\b/.test(heading)
            || /\b(?:see\s+also|related\s+to|compare(?:\s+with)?)\s*:?\s*$/.test(before);
        if (upward) {
            put(ref.target, ref.source, 9);
            put(ref.source, ref.target, -9);
            continue;
        }
        if (related) {
            put(ref.source, ref.target, 0);
            continue;
        }
        const list = /^\s*(?:[-*+]|\d+[.)])\s+/.test(before);
        const overview = /\b(?:subtopics?|contents|overview|layers|types|components|topics|children)\b/.test(heading);
        // A list is modest evidence; explicit relational language is much stronger.
        put(ref.source, ref.target, downward ? 8 : overview && list ? 6 : list ? 3 : 1);
    }
    const incoming = new Map<string, Candidate[]>();
    for (const edge of candidates.values()) {
        const reverse = candidates.get(JSON.stringify([edge.child, edge.parent]));
        // Reciprocal links with equal evidence are ambiguous: do not invent an ordering.
        if (edge.score < 3 || (reverse && reverse.score >= edge.score))
            continue;
        if (!incoming.has(edge.child))
            incoming.set(edge.child, []);
        incoming.get(edge.child)!.push(edge);
    }
    const ranked = new Map<string, Candidate[]>();
    for (const [child, edges] of incoming) {
        edges.sort((a, b) => b.score - a.score || a.parent.localeCompare(b.parent));
        const best = edges[0].score;
        // Retain comparable candidates and multiple strong parents; suppress weak peers.
        ranked.set(child, edges.filter(edge => edge.score >= Math.max(3, best - 2)));
    }
    // Build strongest edges first and reject cycle-closing edges. Bounded work per edge.
    const edges = [...ranked.values()].flat().filter(edge => {
        // Shared overview suggests siblings: do not promote their cross-reference to parenthood.
        return !(ranked.get(edge.parent) ?? []).some(above => above.score >= edge.score && (ranked.get(edge.child) ?? []).some(other => other.parent === above.parent && other.score >= edge.score));
    }).sort((a, b) => b.score - a.score || a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child));
    const children = new Map<string, string[]>();
    const graph: Graph = new Map();
    for (const edge of edges) {
        const pending = [edge.child];
        const seen = new Set<string>();
        let cycle = false;
        let steps = 0;
        while (pending.length && steps++ < 5000) {
            const next = pending.pop()!;
            if (next === edge.parent) {
                cycle = true;
                break;
            }
            if (seen.has(next))
                continue;
            seen.add(next);
            for (const child of children.get(next) ?? [])
                if (!seen.has(child))
                    pending.push(child);
            if (pending.length > 5000) {
                cycle = true;
                break;
            }
        }
        if (cycle || pending.length)
            continue; // fail closed when cycle-check budget is exhausted
        if (!children.has(edge.parent))
            children.set(edge.parent, []);
        children.get(edge.parent)!.push(edge.child);
        if (!graph.has(edge.child))
            graph.set(edge.child, []);
        graph.get(edge.child)!.push(edge.parent);
    }
    return graph;
}
/** Use only the surrounding sentence on the link's line, avoiding unrelated sentences. */
export function linkContext(text: string, start: number, end: number, heading: string): Pick<LinkEvidence, 'before' | 'after' | 'heading'> {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const nextNewline = text.indexOf('\n', end);
    const lineEnd = nextNewline < 0 ? text.length : nextNewline;
    const before = text.slice(lineStart, start).slice(-240).split(/[.!?]\s+/).pop()!;
    const after = text.slice(end, lineEnd).slice(0, 240).split(/[.!?]\s+/)[0];
    return { before, after, heading };
}
