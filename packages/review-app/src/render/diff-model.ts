import { structuredPatch } from "diff";
import {
  baselineLine,
  currentLine,
  type BaselineLine,
  type CurrentLine,
  type PatchRecord,
  type Seq
} from "@pi-patches/store";

export type Attribution = { kind: "patch"; seq: Seq } | { kind: "external" };

export type DiffModelRow =
  | { kind: "hunk"; text: string }
  | { kind: "collapsed"; oldStart: BaselineLine; newStart: CurrentLine; lines: number; text: string }
  | { kind: "context"; oldLine: BaselineLine; newLine: CurrentLine; text: string; attribution?: Attribution }
  | { kind: "add"; newLine: CurrentLine; text: string; attribution?: Attribution }
  | { kind: "del"; oldLine: BaselineLine; text: string; attribution?: Attribution };

export type DiffModel = {
  rows: DiffModelRow[];
  additions: number;
  deletions: number;
};

export type DiffAttribution = {
  currentLines: readonly { attribution?: Attribution }[];
  deletedBaselineLines: ReadonlyMap<number, Attribution>;
};

export type DiffContext = "patches" | "full";

export type DiffModelOptions = {
  attribution?: DiffAttribution;
  context?: DiffContext;
};

export function buildDiffModel(oldText: string, newText: string, path = "file", options: DiffModelOptions = {}): DiffModel {
  const context = options.context ?? "patches";
  const oldLineCount = contentLines(oldText).length;
  const newLines = contentLines(newText);
  const patch = structuredPatch(path, path, oldText, newText, "", "", {
    context: context === "full" ? Math.max(oldLineCount, newLines.length, 1) : 3
  });
  const rows: DiffModelRow[] = [];
  let additions = 0;
  let deletions = 0;
  let oldCursor = 1;
  let newCursor = 1;

  if (context === "full" && patch.hunks.length === 0) {
    for (let index = 0; index < newLines.length; index++) {
      const oldParsed = baselineLine(index + 1);
      const newParsed = currentLine(index + 1);
      if (oldParsed.ok && newParsed.ok) {
        rows.push({
          kind: "context",
          oldLine: oldParsed.value,
          newLine: newParsed.value,
          text: newLines[index],
          attribution: options.attribution?.currentLines[index]?.attribution
        });
      }
    }
    return { rows, additions, deletions };
  }

  for (const hunk of patch.hunks) {
    if (context === "patches") {
      pushCollapsedGap(rows, oldCursor, newCursor, hunk.oldStart - oldCursor, hunk.newStart - newCursor);
    }
    rows.push({ kind: "hunk", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const rawLine of hunk.lines) {
      const marker = rawLine[0];
      const text = rawLine.slice(1);
      if (marker === "+") {
        const parsed = currentLine(newLine);
        if (parsed.ok) rows.push({ kind: "add", newLine: parsed.value, text, attribution: options.attribution?.currentLines[newLine - 1]?.attribution });
        additions++;
        newLine++;
      } else if (marker === "-") {
        const parsed = baselineLine(oldLine);
        if (parsed.ok) rows.push({ kind: "del", oldLine: parsed.value, text, attribution: options.attribution?.deletedBaselineLines.get(oldLine) });
        deletions++;
        oldLine++;
      } else if (marker === " ") {
        const oldParsed = baselineLine(oldLine);
        const newParsed = currentLine(newLine);
        if (oldParsed.ok && newParsed.ok) {
          rows.push({ kind: "context", oldLine: oldParsed.value, newLine: newParsed.value, text, attribution: options.attribution?.currentLines[newLine - 1]?.attribution });
        }
        oldLine++;
        newLine++;
      }
    }
    oldCursor = oldLine;
    newCursor = newLine;
  }
  if (context === "patches") {
    pushCollapsedGap(
      rows,
      oldCursor,
      newCursor,
      oldLineCount - oldCursor + 1,
      newLines.length - newCursor + 1
    );
  }
  return { rows, additions, deletions };
}

function pushCollapsedGap(
  rows: DiffModelRow[],
  oldStart: number,
  newStart: number,
  oldLines: number,
  newLines: number
): void {
  const lines = Math.max(0, Math.min(oldLines, newLines));
  if (lines === 0) return;
  const oldParsed = baselineLine(oldStart);
  const newParsed = currentLine(newStart);
  if (!oldParsed.ok || !newParsed.ok) return;
  rows.push({
    kind: "collapsed",
    oldStart: oldParsed.value,
    newStart: newParsed.value,
    lines,
    text: `... ${lines} unchanged ${lines === 1 ? "line" : "lines"} - Enter/click to expand`
  });
}

function contentLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
}

export function latestPatchId(patches: readonly PatchRecord[]): number | null {
  return patches.length === 0 ? null : patches[patches.length - 1].id;
}
