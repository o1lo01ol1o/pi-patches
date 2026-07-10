import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type DiffVisualMap = {
  starts: readonly number[];
  logicalRowCount: number;
  visualRowCount: number;
};

export type DiffVisualRowRef = {
  logicalRow: number;
  segmentIndex: number;
};

export function buildDiffVisualMap(
  lines: readonly string[],
  widthForLine: (index: number) => number,
  wrap: boolean
): DiffVisualMap {
  const starts: number[] = [0];
  for (let index = 0; index < lines.length; index++) {
    const count = wrapLineSegments(lines[index] ?? "", widthForLine(index), wrap).length;
    starts.push(starts[starts.length - 1] + count);
  }
  return {
    starts,
    logicalRowCount: lines.length,
    visualRowCount: starts[starts.length - 1] ?? 0
  };
}

export function wrapLineSegments(line: string, width: number, wrap: boolean): string[] {
  return wrap ? wrapTextWithAnsi(line, Math.max(1, width)) : [line];
}

export function visualRowRef(map: DiffVisualMap, visualRow: number): DiffVisualRowRef | null {
  if (visualRow < 0 || visualRow >= map.visualRowCount) return null;
  let low = 0;
  let high = map.logicalRowCount;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((map.starts[middle] ?? 0) <= visualRow) low = middle;
    else high = middle;
  }
  return { logicalRow: low, segmentIndex: visualRow - (map.starts[low] ?? 0) };
}

export function visualStartForLogicalRow(map: DiffVisualMap, logicalRow: number): number {
  if (map.logicalRowCount === 0) return 0;
  const clamped = Math.max(0, Math.min(map.logicalRowCount - 1, logicalRow));
  return map.starts[clamped] ?? 0;
}

export function visualEndForLogicalRow(map: DiffVisualMap, logicalRow: number): number {
  if (map.logicalRowCount === 0) return 0;
  const clamped = Math.max(0, Math.min(map.logicalRowCount - 1, logicalRow));
  return Math.max(visualStartForLogicalRow(map, clamped), (map.starts[clamped + 1] ?? 1) - 1);
}
