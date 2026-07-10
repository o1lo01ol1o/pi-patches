import type { AnchorLine, CurrentLine, DiffRow, Freshness } from "@pi-patches/store";

export type Selection = {
  anchor: DiffRow;
  head: DiffRow;
};

export function orderedSelection(selection: Selection): { start: DiffRow; end: DiffRow } {
  return selection.anchor <= selection.head
    ? { start: selection.anchor, end: selection.head }
    : { start: selection.head, end: selection.anchor };
}

export function currentToAnchor(line: CurrentLine, _freshness: Extract<Freshness, { kind: "fresh" }>): AnchorLine {
  return line as number as AnchorLine;
}

export function diffRow(value: number): DiffRow {
  return Math.max(0, Math.floor(value)) as DiffRow;
}
