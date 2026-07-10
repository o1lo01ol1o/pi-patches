export type FileTreeInput = {
  row: {
    relPath: string;
  };
};

export type FileTreeRow =
  | { kind: "directory"; dir: string }
  | { kind: "file"; fileIndex: number; displayName: string };

type CachedFileTree = {
  rows: FileTreeRow[];
  rowByFileIndex: Map<number, number>;
};

const fileTreeCache = new WeakMap<readonly FileTreeInput[], CachedFileTree>();

export function buildFileTreeRows(files: readonly FileTreeInput[]): FileTreeRow[] {
  return cachedFileTree(files).rows;
}

function cachedFileTree(files: readonly FileTreeInput[]): CachedFileTree {
  const cached = fileTreeCache.get(files);
  if (cached) return cached;
  const rows: FileTreeRow[] = [];
  const rowByFileIndex = new Map<number, number>();
  let currentDir: string | null = null;
  files.forEach((file, fileIndex) => {
    const { dir, base } = splitRelPath(file.row.relPath);
    if (dir !== "" && dir !== currentDir) {
      rows.push({ kind: "directory", dir });
      currentDir = dir;
    } else if (dir === "") {
      currentDir = null;
    }
    rowByFileIndex.set(fileIndex, rows.length);
    rows.push({ kind: "file", fileIndex, displayName: dir === "" ? file.row.relPath : base });
  });
  const result = { rows, rowByFileIndex };
  fileTreeCache.set(files, result);
  return result;
}

export function fileTreeRowCount(files: readonly FileTreeInput[]): number {
  return cachedFileTree(files).rows.length;
}

export function fileIndexAtTreeRow(files: readonly FileTreeInput[], row: number): number | null {
  const item = cachedFileTree(files).rows[row];
  return item?.kind === "file" ? item.fileIndex : null;
}

export function treeRowForFileIndex(files: readonly FileTreeInput[], fileIndex: number): number | null {
  return cachedFileTree(files).rowByFileIndex.get(fileIndex) ?? null;
}

function splitRelPath(path: string): { dir: string; base: string } {
  const index = path.lastIndexOf("/");
  if (index < 0) return { dir: "", base: path };
  return { dir: path.slice(0, index), base: path.slice(index + 1) };
}
