import { applyPatch, structuredPatch } from "diff";
import { hashContent, type Baseline, type PatchRecord, type Result } from "@pi-patches/store";
import { err, ok } from "@pi-patches/store";
import type { Attribution } from "./diff-model.ts";

export type AttributedLine = {
  text: string;
  attribution?: Attribution;
  originBaselineLine?: number;
};

export type FileVersion = {
  content: string;
  lines: AttributedLine[];
  hash: string;
  deletedBaselineLines: Map<number, Attribution>;
};

export type BlameCache = {
  replay(key: string, baseline: Baseline, patches: readonly PatchRecord[]): Result<FileVersion>;
  clear(): void;
};

export function fromBaseline(baseline: Baseline): FileVersion {
  const content = baseline.kind === "present" ? baseline.content : "";
  return {
    content,
    lines: splitLines(content).map((text, index) => ({ text, originBaselineLine: index + 1 })),
    hash: hashContent(content),
    deletedBaselineLines: new Map()
  };
}

export function replayPatches(baseline: Baseline, patches: readonly PatchRecord[]): Result<FileVersion> {
  return replayFrom(fromBaseline(baseline), patches);
}

export function stepPatch(version: FileVersion, patch: PatchRecord): Result<FileVersion> {
  const expectedPreHash = patch.preHash ?? hashContent("");
  if (version.hash !== expectedPreHash) {
    return err({ kind: "ChainBreak", atSeq: patch.seq, expected: expectedPreHash, found: version.hash });
  }
  const next = applyPatch(version.content, patch.unifiedPatch);
  if (typeof next !== "string") {
    return err({ kind: "ChainBreak", atSeq: patch.seq, expected: patch.postHash ?? "applicable patch", found: "patch rejected" });
  }
  const nextHash = hashContent(next);
  if (nextHash !== patch.postHash) {
    return err({ kind: "ChainBreak", atSeq: patch.seq, expected: patch.postHash, found: nextHash });
  }
  return ok(applyTextChange(version, next, { kind: "patch", seq: patch.seq }));
}

export function createBlameCache(limit = 50): BlameCache {
  const entries = new Map<string, { patchIds: number[]; version: FileVersion }>();

  return {
    replay(key, baseline, patches) {
      const baselineHash = baseline.kind === "present" ? baseline.hash : hashContent("");
      const cacheKey = `${key}:${baselineHash}`;
      const cached = entries.get(cacheKey);
      const canExtend = cached !== undefined && isPatchPrefix(cached.patchIds, patches);
      const start = canExtend ? cached.version : fromBaseline(baseline);
      const remaining = canExtend ? patches.slice(cached.patchIds.length) : patches;
      const replayed = replayFrom(start, remaining);
      if (!replayed.ok) return replayed;

      entries.delete(cacheKey);
      entries.set(cacheKey, {
        patchIds: patches.map((patch) => Number(patch.id)),
        version: replayed.value
      });
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return replayed;
    },
    clear() {
      entries.clear();
    }
  };
}

function replayFrom(initial: FileVersion, patches: readonly PatchRecord[]): Result<FileVersion> {
  let version = initial;
  for (const patch of patches) {
    const stepped = stepPatch(version, patch);
    if (!stepped.ok) return stepped;
    version = stepped.value;
  }
  return ok(version);
}

function isPatchPrefix(ids: readonly number[], patches: readonly PatchRecord[]): boolean {
  if (ids.length > patches.length) return false;
  return ids.every((id, index) => id === Number(patches[index]?.id));
}

export function applyExternalChanges(version: FileVersion, currentContent: string): FileVersion {
  return applyTextChange(version, currentContent, { kind: "external" });
}

function applyTextChange(version: FileVersion, nextContent: string, attribution: Attribution): FileVersion {
  const patch = structuredPatch("old", "new", version.content, nextContent, "", "", { context: 0 });
  const lines: AttributedLine[] = [];
  const deletedBaselineLines = new Map(version.deletedBaselineLines);
  let oldIndex = 0;

  for (const hunk of patch.hunks) {
    const hunkOldIndex = Math.max(0, hunk.oldStart - 1);
    while (oldIndex < hunkOldIndex) {
      const line = version.lines[oldIndex];
      if (line) lines.push(line);
      oldIndex++;
    }

    for (const rawLine of hunk.lines) {
      const marker = rawLine[0];
      const text = rawLine.slice(1);
      if (marker === " ") {
        const line = version.lines[oldIndex];
        lines.push(line ?? { text });
        oldIndex++;
        continue;
      }
      if (marker === "-") {
        const removed = version.lines[oldIndex];
        if (removed?.originBaselineLine !== undefined) {
          deletedBaselineLines.set(removed.originBaselineLine, attribution);
        }
        oldIndex++;
        continue;
      }
      if (marker === "+") {
        lines.push({ text, attribution });
      }
    }
  }

  while (oldIndex < version.lines.length) {
    const line = version.lines[oldIndex];
    if (line) lines.push(line);
    oldIndex++;
  }

  return {
    content: nextContent,
    lines,
    hash: hashContent(nextContent),
    deletedBaselineLines
  };
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
}
