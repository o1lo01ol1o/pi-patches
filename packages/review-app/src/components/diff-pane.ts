import { generateDiffString, getLanguageFromPath, highlightCode, renderDiff } from "@earendil-works/pi-coding-agent";
import { hashContent, type Annotation } from "@pi-patches/store";
import { buildDiffModel, type Attribution, type DiffAttribution, type DiffModel, type DiffModelRow } from "../render/diff-model.ts";
import {
  applyBackgroundToLine,
  changeTint,
  diffGutter,
  selectionTint,
  truncateVisible,
  type ColorDepth,
  type TintTheme
} from "../render/ansi.ts";
import { applyExternalChanges, createBlameCache } from "../render/blame.ts";
import {
  buildDiffVisualMap,
  visualRowRef,
  wrapLineSegments,
  type DiffVisualMap
} from "../render/diff-wrap.ts";
import { createHighlightCache } from "../render/highlight-cache.ts";
import type { DatasetHistoryEntry, FileState } from "../state.ts";
import type { PatchRecord } from "@pi-patches/store";

const highlightCache = createHighlightCache();
const blameCache = createBlameCache();
const attributedModelCache = new Map<string, DiffModel>();
const nativeDiffCache = new Map<string, string[]>();
const visualMapCache = new Map<string, DiffVisualMap>();
const attributionRankCache = new WeakMap<DiffModel, ReadonlyMap<string, number>>();
const renderCacheLimit = 100;

export type DiffPaneOptions = {
  cursorRow: number;
  startRow: number;
  height: number;
  view: "cumulative" | "history";
  renderMode: "syntax" | "native";
  tintMode: "gradient" | "uniform" | "off";
  colorDepth: ColorDepth;
  tintTheme: TintTheme;
  patchIdx: number;
  historyEntry?: { entry: DatasetHistoryEntry; index: number; total: number } | null;
  width: number;
  selectedRange: { start: number; end: number } | null;
  showProvenance: boolean;
  wrapLines?: boolean;
  visualMap?: DiffVisualMap;
};

export type DiffPaneVisualOptions = Pick<
  DiffPaneOptions,
  "view" | "renderMode" | "patchIdx" | "historyEntry" | "width" | "showProvenance" | "wrapLines"
>;

const syntaxHunkPrefixWidth = 9;
const syntaxCodePrefixWidth = 12;
const nativePrefixWidth = 3;

export function renderDiffPane(
  file: FileState,
  patches: readonly PatchRecord[],
  annotations: readonly Annotation[],
  options: DiffPaneOptions
): string[] {
  const visualMap = options.visualMap ?? buildDiffPaneVisualMap(file, patches, options);
  if (options.view === "history") return renderHistoryPane(file, patches, { ...options, visualMap });
  if (options.renderMode === "native") {
    const key = `cumulative:${file.row.path}:${baselineHash(file)}:${file.currentHash}`;
    return renderNativeVisualRows(nativeLogicalLines(key, cumulativeDisplayDiff(file), file.row.path), { ...options, visualMap });
  }
  return renderCumulativeSyntax(file, patches, annotations, { ...options, visualMap });
}

export function buildDiffPaneVisualMap(
  file: FileState,
  patches: readonly PatchRecord[],
  options: DiffPaneVisualOptions
): DiffVisualMap {
  const wrap = options.wrapLines ?? true;
  const cacheKey = visualMapKey(file, patches, options, wrap);
  const cached = lruGet(visualMapCache, cacheKey);
  if (cached) return cached;

  let map: DiffVisualMap;
  if (options.view === "history") {
    const lines = historyLogicalLines(file, patches, options);
    map = buildDiffVisualMap(lines, () => Math.max(1, options.width - nativePrefixWidth), wrap);
  } else if (options.renderMode === "native") {
    const key = `cumulative:${file.row.path}:${baselineHash(file)}:${file.currentHash}`;
    const lines = nativeLogicalLines(key, cumulativeDisplayDiff(file), file.row.path);
    map = buildDiffVisualMap(lines, () => Math.max(1, options.width - nativePrefixWidth), wrap);
  } else {
    const model = buildAttributedDiffModel(file, patches, options.showProvenance);
    map = buildDiffVisualMap(
      model.rows.map(rowText),
      (index) => Math.max(1, options.width - syntaxPrefixWidth(model.rows[index]?.kind ?? "hunk")),
      wrap
    );
  }
  lruSet(visualMapCache, cacheKey, map);
  return map;
}

function renderCumulativeSyntax(
  file: FileState,
  patches: readonly PatchRecord[],
  annotations: readonly Annotation[],
  options: DiffPaneOptions & { visualMap: DiffVisualMap }
): string[] {
  const model = buildAttributedDiffModel(file, patches, options.showProvenance);
  const highlighted = highlightedVersions(file);
  const ranks = attributionRanks(model);
  const segmentCache = new Map<number, string[]>();
  const lines: string[] = [];
  for (let visualRow = options.startRow; visualRow < options.startRow + options.height; visualRow++) {
    const ref = visualRowRef(options.visualMap, visualRow);
    if (!ref) break;
    const row = model.rows[ref.logicalRow];
    if (!row) continue;
    let segments = segmentCache.get(ref.logicalRow);
    if (!segments) {
      const content = syntaxContent(row, highlighted);
      segments = wrapLineSegments(
        content,
        Math.max(1, options.width - syntaxPrefixWidth(row.kind)),
        options.wrapLines ?? true
      );
      segmentCache.set(ref.logicalRow, segments);
    }
    const cursor = ref.logicalRow === options.cursorRow ? ">" : " ";
    const marker = ref.segmentIndex === 0 ? annotatedMarker(row, file, annotations) : "↳";
    const selected = options.selectedRange !== null && ref.logicalRow >= options.selectedRange.start && ref.logicalRow <= options.selectedRange.end;
    const line = `${syntaxPrefix(row, cursor, marker, ref.segmentIndex > 0)}${segments[ref.segmentIndex] ?? ""}`;
    const bg = selected
      ? selectionTint(options.colorDepth, options.tintTheme)
      : rowBackground(row, ranks, options.tintMode, options.colorDepth, options.tintTheme);
    lines.push(bg ? applyBackgroundToLine(truncateVisible(line, options.width), options.width, bg) : line);
  }
  return lines;
}

function syntaxContent(
  row: DiffModelRow,
  highlighted: { baseline: string[]; current: string[] }
): string {
  switch (row.kind) {
    case "hunk":
      return row.text;
    case "add":
    case "context":
      return highlighted.current[Number(row.newLine) - 1] ?? row.text;
    case "del":
      return highlighted.baseline[Number(row.oldLine) - 1] ?? row.text;
  }
}

function syntaxPrefix(row: DiffModelRow, cursor: string, marker: string, continuation: boolean): string {
  if (row.kind === "hunk") return `${cursor} ${marker}      `;
  if (continuation) return `${cursor} ${marker} ${themedDiffGutter("context", "      │")} `;
  switch (row.kind) {
    case "add":
      return `${cursor} ${marker} ${themedDiffGutter("add", `+${String(row.newLine).padStart(4, " ")} │`)} `;
    case "del":
      return `${cursor} ${marker} ${themedDiffGutter("del", `-${String(row.oldLine).padStart(4, " ")} │`)} `;
    case "context":
      return `${cursor} ${marker} ${themedDiffGutter("context", ` ${String(row.newLine).padStart(4, " ")} │`)} `;
  }
}

function syntaxPrefixWidth(kind: DiffModelRow["kind"]): number {
  return kind === "hunk" ? syntaxHunkPrefixWidth : syntaxCodePrefixWidth;
}

function rowText(row: DiffModelRow): string {
  return row.text;
}

function visualMapKey(
  file: FileState,
  patches: readonly PatchRecord[],
  options: DiffPaneVisualOptions,
  wrap: boolean
): string {
  const historyKey = options.historyEntry
    ? `commit:${options.historyEntry.entry.commitSha}`
    : options.view === "history"
      ? `patch:${patches.filter((patch) => patch.fileId === file.row.id)[options.patchIdx]?.id ?? "none"}`
      : `head:${file.currentHash}`;
  return [
    file.row.sessionId,
    file.row.id,
    file.row.relPath,
    baselineHash(file),
    historyKey,
    options.view,
    options.renderMode,
    options.width,
    wrap ? "wrap" : "nowrap"
  ].join(":");
}

function highlightedVersions(file: FileState): { baseline: string[]; current: string[] } {
  const baselineContent = file.row.baseline.kind === "present" ? file.row.baseline.content : "";
  const baselineHash = file.row.baseline.kind === "present" ? file.row.baseline.hash : hashContent("");
  return {
    baseline: highlightedLines(file.row.path, baselineContent, baselineHash),
    current: highlightedLines(file.row.path, file.current ?? "", file.currentHash)
  };
}

function highlightedLines(path: string, content: string, hash: string): string[] {
  const language = getLanguageFromPath(path);
  const key = `${language ?? "plain"}:${hash}`;
  const cached = highlightCache.get(key);
  if (cached) return cached;
  const lines = safeHighlight(content, language);
  highlightCache.set(key, lines);
  return lines;
}

function safeHighlight(content: string, language: string | undefined): string[] {
  try {
    return highlightCode(content, language);
  } catch {
    return splitLines(content);
  }
}

function buildAttributedDiffModel(file: FileState, patches: readonly PatchRecord[], showProvenance: boolean): DiffModel {
  const baseline = file.row.baseline.kind === "present" ? file.row.baseline.content : "";
  const filePatches = patches.filter((patch) => patch.fileId === file.row.id);
  const lastPatchId = filePatches.at(-1)?.id ?? 0;
  const cacheKey = `${showProvenance ? "attributed" : "plain"}:${file.row.id}:${baselineHash(file)}:${lastPatchId}:${file.currentHash}`;
  const cached = lruGet(attributedModelCache, cacheKey);
  if (cached) return cached;
  if (!showProvenance) {
    const model = buildDiffModel(baseline, file.current ?? "", file.row.relPath);
    lruSet(attributedModelCache, cacheKey, model);
    return model;
  }
  const replay = blameCache.replay(String(file.row.id), file.row.baseline, filePatches);
  if (!replay.ok) {
    const model = buildDiffModel(
      baseline,
      file.current ?? "",
      file.row.relPath,
      mostRecentAttribution(baseline, file.current ?? "", filePatches)
    );
    lruSet(attributedModelCache, cacheKey, model);
    return model;
  }
  const version = replay.value.hash === file.currentHash
    ? replay.value
    : applyExternalChanges(replay.value, file.current ?? "");
  const model = buildDiffModel(baseline, file.current ?? "", file.row.relPath, {
    currentLines: version.lines,
    deletedBaselineLines: version.deletedBaselineLines
  });
  lruSet(attributedModelCache, cacheKey, model);
  return model;
}

function mostRecentAttribution(
  baseline: string,
  current: string,
  patches: readonly PatchRecord[]
): DiffAttribution | undefined {
  const latest = patches[patches.length - 1];
  if (!latest) return undefined;
  const attribution = { kind: "patch", seq: latest.seq } satisfies Attribution;
  return {
    currentLines: splitLines(current).map(() => ({ attribution })),
    deletedBaselineLines: new Map(splitLines(baseline).map((_, index) => [index + 1, attribution]))
  };
}

function renderHistoryPane(
  file: FileState,
  patches: readonly PatchRecord[],
  options: DiffPaneOptions & { visualMap: DiffVisualMap }
): string[] {
  return renderNativeVisualRows(historyLogicalLines(file, patches, options), options);
}

function cumulativeDisplayDiff(file: FileState): string {
  const baseline = file.row.baseline.kind === "present" ? file.row.baseline.content : "";
  return generateDiffString(baseline, file.current ?? "").diff;
}

function nativeLogicalLines(key: string, diff: string, filePath: string): string[] {
  let lines = lruGet(nativeDiffCache, key);
  if (!lines) {
    lines = renderDiff(diff, { filePath }).split("\n");
    lruSet(nativeDiffCache, key, lines);
  }
  return lines;
}

function historyLogicalLines(
  file: FileState,
  patches: readonly PatchRecord[],
  options: Pick<DiffPaneOptions, "historyEntry" | "patchIdx">
): string[] {
  if (options.historyEntry) {
    const { entry, index, total } = options.historyEntry;
    const header = `${index + 1}/${total} · ${entry.commitSha.slice(0, 8)} · ${entry.subject} · ${formatPatchTime(entry.authoredAt)}`;
    const key = `commit:${entry.commitSha}:${file.row.path}:${entry.status}`;
    return [header, ...nativeLogicalLines(key, entry.displayDiff, file.row.path)];
  }
  const filePatches = patches.filter((patch) => patch.fileId === file.row.id);
  if (filePatches.length === 0) return ["No recorded patches for this file."];
  const index = Math.max(0, Math.min(options.patchIdx, filePatches.length - 1));
  const patch = filePatches[index];
  const header = `patch ${index + 1}/${filePatches.length} · ${patch.tool} · ${formatPatchTime(patch.createdAt)}`;
  const key = `patch:${patch.id}:${file.row.path}`;
  return [header, ...nativeLogicalLines(key, patch.displayDiff, file.row.path)];
}

function renderNativeVisualRows(
  logicalLines: readonly string[],
  options: DiffPaneOptions & { visualMap: DiffVisualMap }
): string[] {
  const segmentCache = new Map<number, string[]>();
  const lines: string[] = [];
  for (let visualRow = options.startRow; visualRow < options.startRow + options.height; visualRow++) {
    const ref = visualRowRef(options.visualMap, visualRow);
    if (!ref) break;
    const logicalLine = logicalLines[ref.logicalRow] ?? "";
    let segments = segmentCache.get(ref.logicalRow);
    if (!segments) {
      segments = wrapLineSegments(
        logicalLine,
        Math.max(1, options.width - nativePrefixWidth),
        options.wrapLines ?? true
      );
      segmentCache.set(ref.logicalRow, segments);
    }
    const cursor = ref.logicalRow === options.cursorRow ? ">" : " ";
    const continuation = ref.segmentIndex > 0 ? "↳" : " ";
    lines.push(truncateVisible(`${cursor}${continuation} ${segments[ref.segmentIndex] ?? ""}`, options.width));
  }
  return lines;
}

function formatPatchTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function annotatedMarker(row: DiffModelRow, file: FileState, annotations: readonly Annotation[]): string {
  const matching =
    "newLine" in row ? annotations.filter(
    (annotation) =>
      annotation.fileId === file.row.id &&
      Number(annotation.anchor.start) <= Number(row.newLine) &&
      Number(annotation.anchor.end) >= Number(row.newLine)
  ) : [];
  if (matching.some((annotation) => annotation.anchor.hash !== file.currentHash)) return "⚠";
  if (matching.length > 0) return "●";
  return "attribution" in row && row.attribution?.kind === "external" ? "~" : " ";
}

function rowBackground(
  row: DiffModelRow,
  ranks: ReadonlyMap<string, number>,
  mode: DiffPaneOptions["tintMode"],
  depth: ColorDepth,
  theme: TintTheme
) {
  if (row.kind !== "add" && row.kind !== "del") return null;
  if (!row.attribution) return null;
  return changeTint(row.kind, ranks.get(attributionKey(row.attribution)) ?? 1, mode, depth, theme);
}

function attributionRanks(model: DiffModel): ReadonlyMap<string, number> {
  const cached = attributionRankCache.get(model);
  if (cached) return cached;
  const patchSeqs = new Set<number>();
  let hasExternal = false;
  for (const row of model.rows) {
    const attribution = "attribution" in row ? row.attribution : undefined;
    if (!attribution) continue;
    if (attribution.kind === "external") {
      hasExternal = true;
    } else {
      patchSeqs.add(Number(attribution.seq));
    }
  }
  const ordered = [...patchSeqs].sort((a, b) => a - b).map((seq) => `patch:${seq}`);
  if (hasExternal) ordered.push("external");
  const result = new Map<string, number>();
  const denominator = Math.max(1, ordered.length - 1);
  ordered.forEach((key, index) => result.set(key, ordered.length === 1 ? 1 : index / denominator));
  attributionRankCache.set(model, result);
  return result;
}

function attributionKey(attribution: Attribution): string {
  return attribution.kind === "external" ? "external" : `patch:${Number(attribution.seq)}`;
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
}

const gutterForegrounds = new Map<"add" | "del" | "context", string>();

function themedDiffGutter(kind: "add" | "del" | "context", text: string): string {
  let foreground = gutterForegrounds.get(kind);
  if (!foreground) {
    const prefix = kind === "add" ? "+" : kind === "del" ? "-" : " ";
    const rendered = renderDiff(`${prefix}1 sample`);
    foreground = /^\x1b\[[0-9;:]+m/.exec(rendered)?.[0];
    if (foreground) gutterForegrounds.set(kind, foreground);
  }
  return foreground ? `${foreground}${text}\x1b[39m` : diffGutter(kind, text);
}

function baselineHash(file: FileState): string {
  return file.row.baseline.kind === "present" ? file.row.baseline.hash : hashContent("");
}

function lruGet<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function lruSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > renderCacheLimit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}
