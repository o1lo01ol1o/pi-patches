import type { PatchRecord } from "@pi-patches/store";
import type { Attribution } from "./diff-model.ts";

export function patchAgeRanks(
  patches: readonly PatchRecord[],
  attributions: Iterable<Attribution | undefined>
): ReadonlyMap<string, number> {
  const relevantSeqs = new Set<number>();
  let hasExternal = false;
  for (const attribution of attributions) {
    if (attribution?.kind === "external") hasExternal = true;
    if (attribution?.kind === "patch") relevantSeqs.add(Number(attribution.seq));
  }

  const relevant = patches
    .filter((patch) => relevantSeqs.has(Number(patch.seq)))
    .sort((left, right) => left.createdAt - right.createdAt || Number(left.seq) - Number(right.seq));
  const result = new Map<string, number>();
  if (relevant.length === 1) {
    result.set(`patch:${Number(relevant[0].seq)}`, 1);
  } else if (relevant.length > 1) {
    const oldest = relevant[0].createdAt;
    const newest = relevant[relevant.length - 1].createdAt;
    relevant.forEach((patch, index) => {
      const rank = newest === oldest
        ? index / (relevant.length - 1)
        : (patch.createdAt - oldest) / (newest - oldest);
      result.set(`patch:${Number(patch.seq)}`, rank);
    });
  }
  if (hasExternal) result.set("external", 1);
  return result;
}

export function attributionKey(attribution: Attribution): string {
  return attribution.kind === "external" ? "external" : `patch:${Number(attribution.seq)}`;
}
