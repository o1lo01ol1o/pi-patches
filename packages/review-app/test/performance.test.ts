import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  baselineFromContent,
  checkedSessionId,
  fileId,
  type FileRecord,
  type Result
} from "@pi-patches/store";
import { renderFileTree } from "../src/components/file-tree.ts";
import { renderDiffPane } from "../src/components/diff-pane.ts";
import { fileIndexAtTreeRow, fileTreeRowCount, treeRowForFileIndex } from "../src/render/file-tree-model.ts";
import { fileStateFromContent, type FileState } from "../src/state.ts";

initTheme(undefined, false);

test("cached file-tree navigation and rendering remain viewport-bounded on 20000 files", (context) => {
  const files = Array.from({ length: 20_000 }, (_, index) => fileState(index));
  const firstStart = performance.now();
  assert.equal(fileTreeRowCount(files), 40_000);
  const firstMs = performance.now() - firstStart;

  const cachedStart = performance.now();
  for (let index = 0; index < 1_000; index++) {
    const fileIndex = (index * 19) % files.length;
    const row = treeRowForFileIndex(files, fileIndex);
    assert.notEqual(row, null);
    assert.equal(fileIndexAtTreeRow(files, row ?? 0), fileIndex);
    assert.equal(renderFileTree(files, fileIndex, [], row ?? 0, 40).length, 40);
  }
  const cachedMs = performance.now() - cachedStart;
  context.diagnostic(`file tree first=${firstMs.toFixed(1)}ms cached-1000=${cachedMs.toFixed(1)}ms`);
  assert.ok(cachedMs < 2_000, `cached file-tree interaction took ${cachedMs.toFixed(1)}ms`);
});

test("cached large-diff rendering composes only the requested viewport", (context) => {
  const baseline = Array.from({ length: 20_000 }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n";
  const current = baseline.replace("export const value10000 = 10000;", "export const value10000 = 10001;");
  const row: FileRecord = {
    id: unwrap(fileId(1)),
    sessionId: unwrap(checkedSessionId("large-diff-session")),
    path: "/tmp/large.ts",
    relPath: "large.ts",
    baseline: baselineFromContent(baseline),
    firstTouchedAt: 1,
    firstTool: "edit"
  };
  const file = fileStateFromContent(row, current);
  const options = {
    cursorRow: 0,
    startRow: 0,
    height: 40,
    view: "cumulative" as const,
    renderMode: "syntax" as const,
    tintMode: "gradient" as const,
    colorDepth: "truecolor" as const,
    tintTheme: "dark" as const,
    patchIdx: 0,
    width: 120,
    selectedRange: null,
    showProvenance: true
  };
  renderDiffPane(file, [], [], options);

  const cachedStart = performance.now();
  for (let index = 0; index < 200; index++) {
    const lines = renderDiffPane(file, [], [], { ...options, startRow: index % 20 });
    assert.ok(lines.length <= options.height);
  }
  const cachedMs = performance.now() - cachedStart;
  context.diagnostic(`large diff cached-200=${cachedMs.toFixed(1)}ms`);
  assert.ok(cachedMs < 2_000, `cached large-diff rendering took ${cachedMs.toFixed(1)}ms`);

  const expandedOptions = { ...options, expanded: true };
  renderDiffPane(file, [], [], expandedOptions);
  const expandedStart = performance.now();
  for (let index = 0; index < 200; index++) {
    const lines = renderDiffPane(file, [], [], { ...expandedOptions, startRow: index * 17 });
    assert.ok(lines.length <= options.height);
  }
  const expandedMs = performance.now() - expandedStart;
  context.diagnostic(`full-file diff cached-200=${expandedMs.toFixed(1)}ms`);
  assert.ok(expandedMs < 2_000, `cached full-file rendering took ${expandedMs.toFixed(1)}ms`);
});

function fileState(index: number): FileState {
  const id = unwrap(fileId(index + 1));
  const content = `value ${index}\n`;
  return fileStateFromContent({
    id,
    sessionId: unwrap(checkedSessionId("large-tree-session")),
    path: `/tmp/group-${String(index).padStart(5, "0")}/file.ts`,
    relPath: `group-${String(index).padStart(5, "0")}/file.ts`,
    baseline: baselineFromContent(content),
    firstTouchedAt: 1,
    firstTool: "edit"
  }, `${content}changed\n`);
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
