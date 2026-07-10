export type FrameLayout = {
  rows: number;
  columns: number;
  bodyRows: number;
  treeWidth: number;
  diffWidth: number;
  bodyTop: number;
  statusRow: number;
  separatorColumn: number;
};

export type PaneHit =
  | { kind: "tree"; row: number }
  | { kind: "diff"; row: number }
  | { kind: "header" | "status" | "separator" | "outside" };

export function computeFrameLayout(width: number, height: number): FrameLayout {
  const rows = Math.max(1, height);
  const columns = Math.max(1, width);
  const bodyTop = rows >= 3 ? 2 : 1;
  const bodyRows = Math.max(0, rows - bodyTop - 1);
  const treeWidth = computeTreeWidth(columns);
  return {
    rows,
    columns,
    bodyRows,
    treeWidth,
    diffWidth: Math.max(1, columns - treeWidth - 1),
    bodyTop,
    statusRow: rows - 1,
    separatorColumn: treeWidth
  };
}

function computeTreeWidth(columns: number): number {
  if (columns <= 1) return 0;
  if (columns >= 55) return Math.min(Math.max(24, Math.floor(columns * 0.3)), columns - 30);
  if (columns >= 26) return 24;
  return Math.floor((columns - 1) / 2);
}

export function hitTestFrame(layout: FrameLayout, terminalX: number, terminalY: number): PaneHit {
  const x = terminalX - 1;
  const y = terminalY - 1;
  if (x < 0 || y < 0 || x >= layout.columns || y >= layout.rows) return { kind: "outside" };
  if (y < layout.bodyTop) return { kind: "header" };
  if (y === layout.statusRow) return { kind: "status" };
  if (y < layout.bodyTop || y >= layout.statusRow) return { kind: "outside" };
  if (x < layout.treeWidth) return { kind: "tree", row: y - layout.bodyTop };
  if (x === layout.separatorColumn) return { kind: "separator" };
  return { kind: "diff", row: y - layout.bodyTop };
}
