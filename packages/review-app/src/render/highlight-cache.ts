export type HighlightCache = {
  get(contentHash: string): string[] | undefined;
  set(contentHash: string, lines: string[]): void;
};

export function createHighlightCache(limit = 20): HighlightCache {
  const map = new Map<string, string[]>();
  return {
    get(contentHash) {
      const value = map.get(contentHash);
      if (!value) return undefined;
      map.delete(contentHash);
      map.set(contentHash, value);
      return value;
    },
    set(contentHash, lines) {
      if (map.has(contentHash)) map.delete(contentHash);
      map.set(contentHash, lines);
      while (map.size > limit) {
        const first = map.keys().next().value;
        if (first === undefined) return;
        map.delete(first);
      }
    }
  };
}
