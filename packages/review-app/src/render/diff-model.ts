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

export function buildDiffModel(oldText: string, newText: string, path = "file", attribution?: DiffAttribution): DiffModel {
  const patch = structuredPatch(path, path, oldText, newText, "", "", { context: 3 });
  const rows: DiffModelRow[] = [];
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch.hunks) {
    rows.push({ kind: "hunk", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const rawLine of hunk.lines) {
      const marker = rawLine[0];
      const text = rawLine.slice(1);
      if (marker === "+") {
        const parsed = currentLine(newLine);
        if (parsed.ok) rows.push({ kind: "add", newLine: parsed.value, text, attribution: attribution?.currentLines[newLine - 1]?.attribution });
        additions++;
        newLine++;
      } else if (marker === "-") {
        const parsed = baselineLine(oldLine);
        if (parsed.ok) rows.push({ kind: "del", oldLine: parsed.value, text, attribution: attribution?.deletedBaselineLines.get(oldLine) });
        deletions++;
        oldLine++;
      } else {
        const oldParsed = baselineLine(oldLine);
        const newParsed = currentLine(newLine);
        if (oldParsed.ok && newParsed.ok) {
          rows.push({ kind: "context", oldLine: oldParsed.value, newLine: newParsed.value, text, attribution: attribution?.currentLines[newLine - 1]?.attribution });
        }
        oldLine++;
        newLine++;
      }
    }
  }
  return { rows, additions, deletions };
}

export function latestPatchId(patches: readonly PatchRecord[]): number | null {
  return patches.length === 0 ? null : patches[patches.length - 1].id;
}
