import type { Annotation } from "@pi-patches/store";
import { buildFileTreeRows } from "../render/file-tree-model.ts";
import type { FileState } from "../state.ts";

export function renderFileTree(
  files: readonly FileState[],
  selected: number,
  annotations: readonly Annotation[] = [],
  startRow = 0,
  height = Number.POSITIVE_INFINITY
): string[] {
  const annotatedFileIds = new Set(annotations.map((annotation) => annotation.fileId));
  return buildFileTreeRows(files).slice(startRow, startRow + height).map((row) => {
    if (row.kind === "directory") return `  ▸ ${row.dir}/`;
    const file = files[row.fileIndex];
    if (!file) return "";
    const selectedMarker = row.fileIndex === selected ? ">" : " ";
    const annotationMarker = annotatedFileIds.has(file.row.id) ? "●" : " ";
    const missingMarker = file.current === null ? "∅" : " ";
    return `${selectedMarker} ${annotationMarker}${missingMarker} ${row.displayName} +${file.additions} -${file.deletions}`;
  });
}
