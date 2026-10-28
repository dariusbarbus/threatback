/** Per-leaf navigation, deliberately never serialized. */
export class SessionTrails<Key> {
    private trails = new Map<Key, string[]>();
    visit(key: Key, path: string): readonly string[] {
        if (!path)
            return this.get(key);
        const trail = this.trails.get(key) ?? [];
        const previous = trail.indexOf(path);
        const next = previous >= 0 ? trail.slice(0, previous + 1) : [...trail, path].slice(-50);
        this.trails.set(key, next);
        return next;
    }
    get(key: Key): readonly string[] { return this.trails.get(key) ?? []; }
    forget(key: Key) { this.trails.delete(key); }
    retain(keys: Set<Key>) { for (const key of this.trails.keys())
        if (!keys.has(key))
            this.trails.delete(key); }
    rename(oldPath: string, newPath: string) {
        for (const [key, trail] of this.trails)
            this.trails.set(key, trail.map(path => path === oldPath ? newPath : path.startsWith(oldPath + '/') ? newPath + path.slice(oldPath.length) : path));
    }
    delete(path: string) {
        for (const [key, trail] of this.trails)
            this.trails.set(key, trail.filter(p => p !== path && !p.startsWith(path + '/')));
    }
    clear() { this.trails.clear(); }
}
