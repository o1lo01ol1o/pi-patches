import { parsePatch } from "diff";
import { errorMessage, type PatchRecord } from "@pi-patches/store";
import { createBlameCache } from "./blame.ts";
import type { Attribution } from "./diff-model.ts";
import { patchAgeRanks } from "./patch-age.ts";
import type { FileState } from "../state.ts";

const replayCache = createBlameCache(100);
const filePatchCache = new WeakMap<readonly PatchRecord[], Map<number, PatchRecord[]>>();
const snapshotCache = new WeakMap<readonly PatchRecord[], Map<string, PatchFileSnapshotResult>>();

export type PatchFileSnapshot = {
  patch: PatchRecord;
  index: number;
  total: number;
  content: string;
  hash: string;
  lines: string[];
  lineAttributions: readonly (Attribution | undefined)[];
  ageRanks: ReadonlyMap<string, number>;
  landingLine: number;
  changedLines: ReadonlySet<number>;
};

export type PatchFileSnapshotResult =
  | { kind: "snapshot"; value: PatchFileSnapshot }
  | { kind: "empty" }
  | { kind: "chainBreak"; message: string };

export function buildPatchFileSnapshot(
  file: FileState,
  patches: readonly PatchRecord[],
  patchIdx: number
): PatchFileSnapshotResult {
  const filePatches = patchesForFile(patches, Number(file.row.id));
  if (filePatches.length === 0) return { kind: "empty" };
  const index = Math.max(0, Math.min(patchIdx, filePatches.length - 1));
  const selected = filePatches[index];
  const baselineHash = file.row.baseline.kind === "present" ? file.row.baseline.hash : "missing";
  const cacheKey = `${Number(file.row.id)}:${baselineHash}:${Number(selected.id)}`;
  const cached = snapshotCache.get(patches)?.get(cacheKey);
  if (cached) return cached;

  const selectedPatches = filePatches.slice(0, index + 1);
  const replayed = replayCache.replay(
    `${file.row.sessionId}:${Number(file.row.id)}`,
    file.row.baseline,
    selectedPatches
  );
  if (!replayed.ok) {
    return cacheSnapshot(patches, cacheKey, {
      kind: "chainBreak",
      message: errorMessage(replayed.error)
    });
  }
  const lines = splitLines(replayed.value.content);
  const lineAttributions = replayed.value.lines.map((line) => line.attribution);
  const changedLines = changedCurrentLines(selected, lines.length);
  const firstChanged = selected.firstChangedLine ?? changedLines.values().next().value ?? 1;
  const landingLine = lines.length === 0 ? 0 : clamp(firstChanged, 1, lines.length);
  return cacheSnapshot(patches, cacheKey, {
    kind: "snapshot",
    value: {
      patch: selected,
      index,
      total: filePatches.length,
      content: replayed.value.content,
      hash: replayed.value.hash,
      lines,
      lineAttributions,
      ageRanks: patchAgeRanks(selectedPatches, lineAttributions),
      landingLine,
      changedLines
    }
  });
}

function patchesForFile(patches: readonly PatchRecord[], fileId: number): PatchRecord[] {
  let grouped = filePatchCache.get(patches);
  if (!grouped) {
    grouped = new Map();
    for (const patch of patches) {
      const id = Number(patch.fileId);
      const filePatches = grouped.get(id) ?? [];
      filePatches.push(patch);
      grouped.set(id, filePatches);
    }
    for (const filePatches of grouped.values()) {
      filePatches.sort((left, right) => Number(left.seq) - Number(right.seq) || Number(left.id) - Number(right.id));
    }
    filePatchCache.set(patches, grouped);
  }
  return grouped.get(fileId) ?? [];
}

function cacheSnapshot(
  patches: readonly PatchRecord[],
  key: string,
  result: PatchFileSnapshotResult
): PatchFileSnapshotResult {
  let snapshots = snapshotCache.get(patches);
  if (!snapshots) {
    snapshots = new Map();
    snapshotCache.set(patches, snapshots);
  }
  snapshots.set(key, result);
  return result;
}

function changedCurrentLines(patch: PatchRecord, lineCount: number): ReadonlySet<number> {
  const changed = new Set<number>();
  try {
    for (const file of parsePatch(patch.unifiedPatch)) {
      for (const hunk of file.hunks) {
        let newLine = hunk.newStart;
        for (const raw of hunk.lines) {
          const marker = raw[0];
          if (marker === "+") {
            if (newLine >= 1 && newLine <= lineCount) changed.add(newLine);
            newLine++;
          } else if (marker === "-") {
            if (lineCount > 0) changed.add(clamp(newLine, 1, lineCount));
          } else if (marker === " ") {
            newLine++;
          }
        }
      }
    }
  } catch {}
  if (changed.size === 0 && patch.firstChangedLine !== null && lineCount > 0) {
    changed.add(clamp(patch.firstChangedLine, 1, lineCount));
  }
  return changed;
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
