import type { Annotation } from "@pi-patches/store";
import { buildFileTreeRows } from "../render/file-tree-model.ts";
import {
  applyBackgroundToLine,
  changeTint,
  selectionTint,
  truncateVisible,
  type ColorDepth,
  type TintTheme
} from "../render/ansi.ts";
import type { AppState, FileState } from "../state.ts";

export type FileTreeTintOptions = {
  mode: AppState["tintMode"];
  colorDepth: ColorDepth;
  theme: TintTheme;
  width?: number;
};

export function renderFileTree(
  files: readonly FileState[],
  selected: number,
  annotations: readonly Annotation[] = [],
  startRow = 0,
  height = Number.POSITIVE_INFINITY,
  tintOptions?: FileTreeTintOptions
): string[] {
  const annotatedFileIds = new Set(annotations.map((annotation) => annotation.fileId));
  return buildFileTreeRows(files).slice(startRow, startRow + height).map((row) => {
    if (row.kind === "directory") return `  ▸ ${row.dir}/`;
    const file = files[row.fileIndex];
    if (!file) return "";
    const isSelected = row.fileIndex === selected;
    const selectedMarker = isSelected ? ">" : " ";
    const annotationMarker = annotatedFileIds.has(file.row.id) ? "●" : " ";
    const missingMarker = file.current === null ? "∅" : " ";
    const additions = tintCount(`+${file.additions}`, "add", file.additions, isSelected ? undefined : tintOptions);
    const deletions = tintCount(`-${file.deletions}`, "del", file.deletions, isSelected ? undefined : tintOptions);
    const line = `${selectedMarker} ${annotationMarker}${missingMarker} ${row.displayName} ${additions} ${deletions}`;
    if (!isSelected || tintOptions?.width === undefined) return line;
    return applyBackgroundToLine(
      truncateVisible(line, tintOptions.width),
      tintOptions.width,
      selectionTint(tintOptions.colorDepth, tintOptions.theme)
    );
  });
}

function tintCount(
  label: string,
  kind: "add" | "del",
  count: number,
  options: FileTreeTintOptions | undefined
): string {
  if (count === 0 || !options) return label;
  const background = changeTint(kind, 1, options.mode, options.colorDepth, options.theme);
  return background ? background(label) : label;
}
