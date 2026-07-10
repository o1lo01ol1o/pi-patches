import { parsePatch, structuredPatch } from "diff";
import { hashContent, type PatchRecord } from "@pi-patches/store";

export type LineRange = {
  start: number;
  end: number;
};

export type RangeMapResult =
  | { kind: "mapped"; range: LineRange }
  | { kind: "conflict"; patch: PatchRecord; reason: string };

type ChangeBlock = {
  oldStart: number;
  oldLines: number;
  newLines: number;
};

export function mapRangeThroughPatches(range: LineRange, patches: readonly PatchRecord[]): RangeMapResult {
  let current = range;
  for (const patch of patches) {
    const next = mapRangeThroughPatch(current, patch);
    if (next.kind === "conflict") return next;
    current = next.range;
  }
  return { kind: "mapped", range: current };
}

export function mapRangeThroughTexts(range: LineRange, oldText: string, newText: string): RangeMapResult {
  const patch = structuredPatch("old", "new", oldText, newText, "", "", { context: 0 });
  let current = range;
  let shift = 0;
  for (const block of changeBlocksFromHunks(patch.hunks)) {
    const mapped = mapRangeThroughBlock(current, block);
    if (mapped.kind === "conflict") {
      return { kind: "conflict", patch: syntheticPatch(oldText, newText), reason: mapped.reason };
    }
    shift += mapped.shift;
  }
  current = { start: range.start + shift, end: range.end + shift };
  return { kind: "mapped", range: current };
}

export function patchesAfterAnchor(patches: readonly PatchRecord[], anchorPatchId: number | null): PatchRecord[] | null {
  if (anchorPatchId === null) return [...patches];
  const index = patches.findIndex((patch) => Number(patch.id) === anchorPatchId);
  if (index < 0) return null;
  return patches.slice(index + 1);
}

function mapRangeThroughPatch(range: LineRange, patch: PatchRecord): RangeMapResult {
  let shift = 0;
  for (const block of changeBlocksFromUnifiedPatch(patch.unifiedPatch)) {
    const mapped = mapRangeThroughBlock(range, block);
    if (mapped.kind === "conflict") {
      return { kind: "conflict", patch, reason: mapped.reason };
    }
    shift += mapped.shift;
  }
  return { kind: "mapped", range: { start: range.start + shift, end: range.end + shift } };
}

function mapRangeThroughBlock(range: LineRange, block: ChangeBlock): { kind: "shift"; shift: number } | { kind: "conflict"; reason: string } {
  const delta = block.newLines - block.oldLines;
  if (block.oldLines === 0) {
    if (block.oldStart <= range.start) return { kind: "shift", shift: delta };
    if (block.oldStart <= range.end) return { kind: "conflict", reason: `insert overlaps ${range.start}-${range.end}` };
    return { kind: "shift", shift: 0 };
  }

  const oldEnd = block.oldStart + block.oldLines - 1;
  if (oldEnd < range.start) return { kind: "shift", shift: delta };
  if (block.oldStart > range.end) return { kind: "shift", shift: 0 };
  return { kind: "conflict", reason: `change overlaps ${range.start}-${range.end}` };
}

function changeBlocksFromUnifiedPatch(unifiedPatch: string): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  for (const filePatch of parsePatch(unifiedPatch)) {
    blocks.push(...changeBlocksFromHunks(filePatch.hunks));
  }
  return blocks;
}

type HunkLike = {
  oldStart: number;
  lines: string[];
};

function changeBlocksFromHunks(hunks: readonly HunkLike[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let block: ChangeBlock | null = null;

    const flush = () => {
      if (block && (block.oldLines > 0 || block.newLines > 0)) blocks.push(block);
      block = null;
    };

    for (const line of hunk.lines) {
      const marker = line[0];
      if (marker === " ") {
        flush();
        oldLine++;
        continue;
      }
      if (marker === "-") {
        block ??= { oldStart: oldLine, oldLines: 0, newLines: 0 };
        block.oldLines++;
        oldLine++;
        continue;
      }
      if (marker === "+") {
        block ??= { oldStart: oldLine, oldLines: 0, newLines: 0 };
        block.newLines++;
        continue;
      }
      if (marker === "\\") continue;
    }
    flush();
  }
  return blocks;
}

function syntheticPatch(oldText: string, newText: string): PatchRecord {
  return {
    id: 0 as PatchRecord["id"],
    sessionId: "external" as PatchRecord["sessionId"],
    fileId: 0 as PatchRecord["fileId"],
    seq: 0 as PatchRecord["seq"],
    tool: "edit",
    toolCallId: null,
    unifiedPatch: "",
    displayDiff: "",
    firstChangedLine: null,
    preHash: null,
    postHash: hashContent(newText),
    createdAt: oldText.length + newText.length
  };
}
