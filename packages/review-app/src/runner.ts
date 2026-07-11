import { unwatchFile, watch, watchFile, type FSWatcher, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import {
  decodeKittyPrintable,
  Editor,
  isKeyRelease,
  matchesKey,
  ProcessTerminal,
  TUI,
  type Component
} from "@earendil-works/pi-tui";
import {
  checkedSourceNoteId,
  errorMessage,
  type ContentHash,
  type Discovery,
  type DocumentId,
  type FileId,
  type Result,
  type ReviewDocument,
  type ReviewNoteRole
} from "@pi-patches/store";
import {
  executePersistedAnalysis,
  type AnalysisExecutionOptions,
  type AnalysisProgress,
  type AnalysisRequest,
  type ModelRunner
} from "./analysis/index.ts";
import { loadDbSnapshot, loadSourceAnnotations, readCurrentFile } from "./app.ts";
import { renderFrame } from "./components/frame.ts";
import { computeFrameLayout } from "./layout.ts";
import { parseSgrMouseEvents } from "./mouse.ts";
import { truncateVisible, visibleWidth } from "./render/ansi.ts";
import { enableMouseTracking, enterAltScreen, type TerminalCleanup } from "./term.ts";
import { fileFreshnessMap, update, type AppEvent, type AppKey, type AppState, type Effect, type Mode } from "./state.ts";

export function runInteractive(discovery: Discovery, initialState: AppState): void {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  let exitAltScreen: TerminalCleanup = () => undefined;
  let component: ReviewComponent | null = null;
  let stopped = false;

  function handleUncaughtException(error: Error): void {
    cleanup();
    throw error;
  }

  function cleanup(): void {
    if (stopped) return;
    stopped = true;
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    process.off("exit", cleanup);
    process.off("uncaughtException", handleUncaughtException);
    component?.dispose();
    component = null;
    tui.stop();
    exitAltScreen();
    discovery.store.close();
  }

  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("exit", cleanup);
  process.once("uncaughtException", handleUncaughtException);

  try {
    exitAltScreen = enterAltScreen((chunk) => terminal.write(chunk));
    component = createReviewComponent(tui, discovery, initialState, cleanup);
    tui.addChild(component);
    tui.setFocus(component);
    tui.start();
  } catch (error) {
    cleanup();
    throw error;
  }
}

export type ReviewComponent = Component & { dispose(): void };

export type PendingAnalysis = {
  request: AnalysisRequest;
  runner: ModelRunner;
  executionOptions?: Omit<AnalysisExecutionOptions, "signal" | "onProgress">;
};

export type ReviewComponentOptions = {
  reservedRows?: number;
  analysis?: PendingAnalysis;
  mouseTracking?: boolean;
};

export function createReviewComponent(
  tui: TUI,
  discovery: Discovery,
  initialState: AppState,
  onQuit: () => void,
  options: ReviewComponentOptions = {}
): ReviewComponent {
  let state = initialState;
  let disposed = false;
  let quitting = false;
  const initialVersion = discovery.store.dataVersion();
  let lastDataVersion = initialVersion.ok ? initialVersion.value : 0;
  const fileWatchers = new Map<string, FSWatcher>();
  const fallbackWatchDirs = new Set<string>();
  const fallbackWatchPaths = new Set<string>();
  let diskRefreshTimer: NodeJS.Timeout | null = null;
  let diskRefreshAll = false;
  const pendingDiskRefreshPaths = new Set<string>();
  let commentOverlay: { key: string; handle: { hide(): void } } | null = null;
  let analysisController: AbortController | null = null;
  let analysisProgressTimer: NodeJS.Timeout | null = null;
  let pendingAnalysisProgress: AnalysisProgress | null = null;
  const disableComponentMouse = options.mouseTracking === false
    ? null
    : enableMouseTracking((chunk) => tui.terminal.write(chunk));

  const component: ReviewComponent = {
    render(width: number): string[] {
      const rows = availableRows();
      if (state.viewport.cols !== width || state.viewport.rows !== rows) {
        state = update(state, { kind: "resize", cols: width, rows }).state;
      }
      return renderFrame(state, width, rows);
    },
    handleInput(data: string): void {
      const key = keyFromInput(data);
      if (key) dispatch({ kind: "key", key });
    },
    invalidate(): void {},
    dispose
  };

  const refreshTimer = setInterval(() => {
    if (disposed) return;
    const version = discovery.store.dataVersion();
    if (!version.ok || version.value === lastDataVersion) return;
    const didRefresh = refresh();
    lastDataVersion = dataVersionAfterRefresh(lastDataVersion, version, didRefresh);
    tui.requestRender();
  }, 400);
  const pendingKeyTimer = setInterval(() => {
    if (!disposed && state.pendingKey) dispatch({ kind: "tick" });
  }, 500);
  const patchLandingTimer = setInterval(() => {
    if (!disposed && state.patchLanding !== null) dispatch({ kind: "animationTick" });
  }, 120);

  const removeMouseListener = tui.addInputListener((data) => {
    const events = parseSgrMouseEvents(data);
    if (events.length === 0) return undefined;
    const layout = computeFrameLayout(tui.terminal.columns, availableRows());
    for (const mouse of events) dispatch({ kind: "mouse", mouse, layout });
    return { consume: true };
  });

  function dispatch(event: AppEvent): void {
    if (disposed) return;
    reduce(event);
    syncCommentOverlay();
    tui.requestRender();
  }

  function reduce(event: AppEvent): void {
    const result = update(state, event);
    state = result.state;
    for (const effect of result.effects) execute(effect);
  }

  function execute(effect: Effect): void {
    switch (effect.kind) {
      case "quit":
        if (!quitting) {
          quitting = true;
          onQuit();
        }
        return;
      case "refresh":
        refresh();
        return;
      case "queueDrafts": {
        const queued = state.dataset.source.kind === "session"
          ? discovery.store.queueAllDrafts(
              state.session.id,
              fileFreshnessMap(state),
              { fixIntent: effect.fixIntent }
            )
          : discovery.store.queueSourceNotes(
              state.dataset.fingerprint,
              state.session.id,
              sourceFreshnessMap(state),
              { fixIntent: effect.fixIntent }
            );
        state = {
          ...state,
          statusMessage: queued.ok
            ? [
                `Queued ${queued.value.queued.length}`,
                `skipped ${queued.value.skippedStale.length} stale`,
                `preserved ${queued.value.preservedHumanFindings.length + queued.value.preservedCallouts.length} human`
              ].join("; ")
            : errorMessage(queued.error)
        };
        refresh();
        if (queued.ok && effect.quitAfter && !quitting) {
          quitting = true;
          onQuit();
        }
        return;
      }
      case "addAnnotation": {
        const document = documentForFile(state, effect.draft.fileId);
        const added = state.dataset.source.kind === "session"
          ? discovery.store.addAnnotation({
              sessionId: state.session.id,
              fileId: effect.draft.fileId,
              anchor: effect.draft.anchor,
              snippet: effect.draft.snippet,
              comment: effect.comment,
              role: effect.role
            })
          : document === null
            ? { ok: false as const, error: { kind: "InvalidInput" as const, field: "document", message: "selected document is unavailable" } }
            : discovery.store.addSourceNote({
                sourceFingerprint: state.dataset.fingerprint,
                targetSessionId: state.session.id,
                documentId: document.id,
                path: document.path,
                relPath: document.relPath,
                anchor: effect.draft.anchor,
                snippet: effect.draft.snippet,
                comment: effect.comment,
                role: effect.role
              });
        state = { ...state, statusMessage: added.ok ? "Draft comment saved" : errorMessage(added.error) };
        refresh();
        return;
      }
      case "updateAnnotation": {
        const sourceId = checkedSourceNoteId(Number(effect.annotationId));
        const updated = state.dataset.source.kind === "session"
          ? discovery.store.updateAnnotation(effect.annotationId, effect.comment)
          : sourceId.ok
            ? discovery.store.updateSourceNote(sourceId.value, effect.comment)
            : sourceId;
        state = { ...state, statusMessage: updated.ok ? "Comment edit saved" : errorMessage(updated.error) };
        refresh();
        return;
      }
      case "updateAnnotationRole": {
        const sourceId = checkedSourceNoteId(Number(effect.annotationId));
        const updated = state.dataset.source.kind === "session"
          ? discovery.store.updateAnnotationRole(effect.annotationId, effect.role)
          : sourceId.ok
            ? discovery.store.updateSourceNoteRole(sourceId.value, effect.role)
            : sourceId;
        state = { ...state, statusMessage: updated.ok ? "Note role saved" : errorMessage(updated.error) };
        refresh();
        return;
      }
      case "reanchorAnnotation": {
        const sourceId = checkedSourceNoteId(Number(effect.annotationId));
        const reanchored = state.dataset.source.kind === "session"
          ? discovery.store.reanchorAnnotation(effect.annotationId, effect.anchor, effect.snippet)
          : sourceId.ok
            ? discovery.store.reanchorSourceNote(sourceId.value, effect.anchor, effect.snippet)
            : sourceId;
        state = { ...state, statusMessage: reanchored.ok ? "Annotation re-anchored" : errorMessage(reanchored.error) };
        refresh();
        return;
      }
      case "deleteAnnotation": {
        const sourceId = checkedSourceNoteId(Number(effect.annotationId));
        const deleted = state.dataset.source.kind === "session"
          ? discovery.store.deleteAnnotation(effect.annotationId)
          : sourceId.ok
            ? discovery.store.deleteSourceNote(sourceId.value)
            : sourceId;
        state = {
          ...state,
          statusMessage: deleted.ok ? (deleted.value ? "Annotation deleted" : "Annotation was not deleted") : errorMessage(deleted.error)
        };
        refresh();
        return;
      }
      case "cancelAnalysis":
        analysisController?.abort();
        return;
      default:
        return assertNever(effect);
    }
  }

  function refresh(): boolean {
    let refreshed = true;
    if (state.dataset.source.kind === "session" && state.dataset.source.sessionId === state.session.id) {
      const snapshot = loadDbSnapshot(discovery.store, state.session);
      if (snapshot.ok) {
        reduce({ kind: "dbChanged", snapshot: snapshot.value });
      } else {
        state = { ...state, statusMessage: errorMessage(snapshot.error) };
        refreshed = false;
      }
    } else {
      const annotations = loadSourceAnnotations(discovery.store, state.dataset, state.files);
      if (annotations.ok) {
        reduce({ kind: "dbChanged", snapshot: { files: state.files, patches: state.patches, annotations: annotations.value } });
      } else {
        state = { ...state, statusMessage: errorMessage(annotations.error) };
        refreshed = false;
      }
    }
    const runs = discovery.store.listAnalysisRuns(state.dataset.fingerprint);
    if (runs.ok) reduce({ kind: "analysisRunsChanged", runs: runs.value });
    else {
      state = { ...state, statusMessage: errorMessage(runs.error) };
      refreshed = false;
    }
    installFileWatchers();
    syncCommentOverlay();
    return refreshed;
  }

  function syncCommentOverlay(): void {
    if (state.mode.kind !== "comment") {
      commentOverlay?.handle.hide();
      commentOverlay = null;
      return;
    }
    const key = commentModeKey(state.mode);
    if (commentOverlay?.key === key) return;
    commentOverlay?.handle.hide();
    const details = commentOverlayDetails(state);
    const editor = new CommentEditorOverlay(
      tui,
      details,
      (text, role) => dispatch({ kind: "commentSubmitted", text, role }),
      () => dispatch({ kind: "commentCancelled" })
    );
    commentOverlay = { key, handle: tui.showOverlay(editor) };
  }

  function scheduleDiskRefresh(path: string | null): void {
    if (disposed) return;
    if (path === null) {
      diskRefreshAll = true;
      pendingDiskRefreshPaths.clear();
    } else if (!diskRefreshAll) {
      pendingDiskRefreshPaths.add(path);
    }
    if (diskRefreshTimer) clearTimeout(diskRefreshTimer);
    diskRefreshTimer = setTimeout(() => {
      diskRefreshTimer = null;
      if (diskRefreshAll) {
        diskRefreshAll = false;
        pendingDiskRefreshPaths.clear();
        refresh();
      } else {
        for (const changedPath of pendingDiskRefreshPaths) {
          const current = readCurrentFile(changedPath);
          if (current.ok) {
            reduce({ kind: "fileChanged", path: changedPath, content: current.value });
          } else {
            state = { ...state, statusMessage: errorMessage(current.error) };
          }
        }
        pendingDiskRefreshPaths.clear();
        syncCommentOverlay();
      }
      tui.requestRender();
    }, 150);
  }

  function installFileWatchers(): void {
    const watchesDisk = state.dataset.source.kind === "session" || state.dataset.source.kind === "workingTree" || state.dataset.source.kind === "snapshot";
    const dirs = new Set(watchesDisk ? state.files.map((file) => dirname(file.row.path)) : []);
    for (const [dir, watcher] of fileWatchers) {
      if (dirs.has(dir)) continue;
      watcher.close();
      fileWatchers.delete(dir);
    }
    for (const dir of fallbackWatchDirs) {
      if (dirs.has(dir)) continue;
      fallbackWatchDirs.delete(dir);
    }
    for (const dir of dirs) {
      if (fileWatchers.has(dir) || fallbackWatchDirs.has(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
          if (typeof filename !== "string") {
            scheduleDiskRefresh(null);
            return;
          }
          const changedPath = join(dir, filename);
          scheduleDiskRefresh(state.files.some((file) => file.row.path === changedPath) ? changedPath : null);
        });
        watcher.on("error", (error) => {
          watcher.close();
          fileWatchers.delete(dir);
          fallbackWatchDirs.add(dir);
          syncFallbackWatchFiles();
          state = { ...state, statusMessage: `watch failed for ${dir}; using polling: ${error.message}` };
          tui.requestRender();
        });
        fileWatchers.set(dir, watcher);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fallbackWatchDirs.add(dir);
        state = { ...state, statusMessage: `watch failed for ${dir}; using polling: ${message}` };
      }
    }
    syncFallbackWatchFiles();
  }

  function syncFallbackWatchFiles(): void {
    const desired = new Set(
      state.files
        .filter((file) => fallbackWatchDirs.has(dirname(file.row.path)))
        .map((file) => file.row.path)
    );
    for (const path of fallbackWatchPaths) {
      if (desired.has(path)) continue;
      unwatchFile(path);
      fallbackWatchPaths.delete(path);
    }
    for (const path of desired) {
      if (fallbackWatchPaths.has(path)) continue;
      watchFile(path, { interval: 150, persistent: false }, (current, previous) => {
        if (sameFileStats(current, previous)) return;
        scheduleDiskRefresh(path);
      });
      fallbackWatchPaths.add(path);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    analysisController?.abort();
    analysisController = null;
    if (analysisProgressTimer) clearTimeout(analysisProgressTimer);
    analysisProgressTimer = null;
    pendingAnalysisProgress = null;
    disableComponentMouse?.();
    clearInterval(refreshTimer);
    clearInterval(pendingKeyTimer);
    clearInterval(patchLandingTimer);
    removeMouseListener();
    commentOverlay?.handle.hide();
    commentOverlay = null;
    if (diskRefreshTimer) clearTimeout(diskRefreshTimer);
    pendingDiskRefreshPaths.clear();
    for (const watcher of fileWatchers.values()) watcher.close();
    fileWatchers.clear();
    for (const path of fallbackWatchPaths) unwatchFile(path);
    fallbackWatchPaths.clear();
    fallbackWatchDirs.clear();
  }

  function availableRows(): number {
    return Math.max(3, tui.terminal.rows - Math.max(0, options.reservedRows ?? 0));
  }

  try {
    installFileWatchers();
    syncCommentOverlay();
    const pendingAnalysis = options.analysis;
    if (pendingAnalysis) queueMicrotask(() => void startAnalysis(pendingAnalysis));
    return component;
  } catch (error) {
    dispose();
    throw error;
  }

  async function startAnalysis(pending: PendingAnalysis): Promise<void> {
    if (disposed || analysisController !== null) return;
    analysisController = new AbortController();
    dispatch({ kind: "analysisStarted", mode: pending.request.mode });
    const completed = await executePersistedAnalysis(discovery.store, pending.request, pending.runner, {
      ...pending.executionOptions,
      signal: analysisController.signal,
      onProgress: scheduleAnalysisProgress
    });
    flushAnalysisProgress();
    analysisController = null;
    if (disposed) return;
    if (!completed.ok) {
      dispatch({ kind: "analysisFailed", message: errorMessage(completed.error) });
      return;
    }
    refresh();
    dispatch({ kind: "analysisFinished", run: completed.value });
  }

  function scheduleAnalysisProgress(progress: AnalysisProgress): void {
    if (disposed) return;
    pendingAnalysisProgress = mergeAnalysisProgress(pendingAnalysisProgress, progress);
    if (analysisProgressTimer !== null) return;
    analysisProgressTimer = setTimeout(flushAnalysisProgress, 50);
  }

  function flushAnalysisProgress(): void {
    if (analysisProgressTimer !== null) clearTimeout(analysisProgressTimer);
    analysisProgressTimer = null;
    const progress = pendingAnalysisProgress;
    pendingAnalysisProgress = null;
    if (progress === null || disposed) return;
    dispatch({ kind: "analysisProgress", ...progress });
  }
}

function mergeAnalysisProgress(previous: AnalysisProgress | null, next: AnalysisProgress): AnalysisProgress {
  if (previous === null || previous.phase !== next.phase || previous.message !== next.message) return next;
  return {
    ...next,
    delta: `${previous.delta ?? ""}${next.delta ?? ""}`
  };
}

function sameFileStats(current: Stats, previous: Stats): boolean {
  return current.mtimeMs === previous.mtimeMs &&
    current.ctimeMs === previous.ctimeMs &&
    current.size === previous.size &&
    current.ino === previous.ino &&
    current.nlink === previous.nlink;
}

function documentForFile(state: AppState, fileId: FileId): ReviewDocument | null {
  const file = state.files.find((candidate) => candidate.row.id === fileId);
  return file ? state.dataset.documents.find((document) => document.relPath === file.row.relPath) ?? null : null;
}

function sourceFreshnessMap(state: AppState): Map<DocumentId, ContentHash> {
  const hashes = new Map<DocumentId, ContentHash>();
  for (const document of state.dataset.documents) {
    const file = state.files.find((candidate) => candidate.row.relPath === document.relPath);
    if (file) hashes.set(document.id, file.currentHash);
  }
  return hashes;
}

type CommentOverlayDetails = {
  title: string;
  snippet: string;
  initialText: string;
  role: ReviewNoteRole;
};

class CommentEditorOverlay implements Component {
  private readonly editor: Editor;
  private readonly tui: TUI;
  private readonly details: CommentOverlayDetails;
  private readonly submit: (text: string, role: ReviewNoteRole) => void;
  private readonly cancel: () => void;
  private role: ReviewNoteRole;

  constructor(
    tui: TUI,
    details: CommentOverlayDetails,
    submit: (text: string, role: ReviewNoteRole) => void,
    cancel: () => void
  ) {
    this.tui = tui;
    this.details = details;
    this.submit = submit;
    this.cancel = cancel;
    this.role = details.role;
    this.editor = new Editor(tui, editorTheme(), { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.setText(details.initialText);
  }

  render(width: number): string[] {
    const snippetLines = this.details.snippet.length === 0
      ? []
      : this.details.snippet.split("\n").slice(0, 8).map((line) => pad(`  ${line}`, width));
    return [
      pad(this.details.title, width),
      pad(`Role: ${reviewNoteRoleLabel(this.role)}`, width),
      ...snippetLines,
      ...this.editor.render(width)
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.cancel();
      return;
    }
    if (matchesKey(data, "ctrl+s")) {
      this.submit(this.editor.getExpandedText(), this.role);
      return;
    }
    if (matchesKey(data, "ctrl+p")) {
      this.role = nextReviewPriority(this.role);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+a")) {
      this.role = toggleReviewAudience(this.role);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+t")) {
      this.role = toggleReviewNoteKind(this.role);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.editor.insertTextAtCursor("\n");
      return;
    }
    this.editor.handleInput(data);
  }

  invalidate(): void {
    this.editor.invalidate();
  }
}

function commentModeKey(mode: Extract<Mode, { kind: "comment" }>): string {
  if (mode.target.kind === "edit") return `edit:${mode.target.annotationId}`;
  if (mode.target.kind === "reanchor") {
    const anchor = mode.target.draft.anchor;
    return `reanchor:${mode.target.annotationId}:${anchor.start}:${anchor.end}:${anchor.hash}`;
  }
  const anchor = mode.target.draft.anchor;
  return `new:${mode.target.draft.fileId}:${anchor.start}:${anchor.end}:${anchor.hash}`;
}

function commentOverlayDetails(state: AppState): CommentOverlayDetails {
  if (state.mode.kind !== "comment") {
    return { title: "Comment", snippet: "", initialText: "", role: { kind: "finding", priority: "P2", audience: "agent" } };
  }
  const mode = state.mode;
  if (mode.target.kind === "edit") {
    const target = mode.target;
    const annotation = state.annotations.find((candidate) => candidate.id === target.annotationId);
    const file = annotation ? state.files.find((candidate) => candidate.row.id === annotation.fileId) : undefined;
    const range = annotation ? lineRangeLabel(Number(annotation.anchor.start), Number(annotation.anchor.end)) : "";
    return {
      title: `${file?.row.relPath ?? "unknown"}${range}`,
      snippet: annotation?.snippet ?? "",
      initialText: mode.initialText,
      role: mode.role
    };
  }
  if (mode.target.kind === "reanchor") {
    const target = mode.target;
    const file = state.files.find((candidate) => candidate.row.id === target.draft.fileId);
    const range = lineRangeLabel(Number(target.draft.anchor.start), Number(target.draft.anchor.end));
    return {
      title: `${file?.row.relPath ?? "unknown"}${range} re-anchor`,
      snippet: `previous:\n${target.oldSnippet}\ncurrent:\n${target.draft.snippet}`,
      initialText: mode.initialText,
      role: mode.role
    };
  }
  const draft = mode.target.draft;
  const file = state.files.find((candidate) => candidate.row.id === draft.fileId);
  return {
    title: `${file?.row.relPath ?? "unknown"}${lineRangeLabel(Number(draft.anchor.start), Number(draft.anchor.end))}`,
    snippet: draft.snippet,
    initialText: mode.initialText,
    role: mode.role
  };
}

function reviewNoteRoleLabel(role: ReviewNoteRole): string {
  return role.kind === "callout" ? "human callout" : `${role.priority} ${role.audience} finding`;
}

function nextReviewPriority(role: ReviewNoteRole): ReviewNoteRole {
  if (role.kind === "callout") return { kind: "finding", priority: "P0", audience: "human" };
  const next = { P0: "P1", P1: "P2", P2: "P3", P3: "P0" } as const;
  return { ...role, priority: next[role.priority] };
}

function toggleReviewAudience(role: ReviewNoteRole): ReviewNoteRole {
  if (role.kind === "callout") return role;
  return { ...role, audience: role.audience === "agent" ? "human" : "agent" };
}

function toggleReviewNoteKind(role: ReviewNoteRole): ReviewNoteRole {
  return role.kind === "callout"
    ? { kind: "finding", priority: "P2", audience: "human" }
    : { kind: "callout", audience: "human" };
}

function lineRangeLabel(start: number, end: number): string {
  return start === end ? `:${start}` : `:${start}-${end}`;
}

function editorTheme() {
  const identity = (text: string) => text;
  return {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity
    }
  };
}

function pad(input: string, width: number): string {
  const truncated = truncateVisible(input, width);
  const padding = Math.max(0, width - visibleWidth(truncated));
  return `${truncated}${" ".repeat(padding)}`;
}

export function keyFromInput(data: string): AppKey | null {
  if (isKeyRelease(data)) return null;
  if (matchesKey(data, "ctrl+c")) return "q";
  if (matchesKey(data, "ctrl+s")) return "ctrl+s";
  if (matchesKey(data, "escape")) return "Escape";
  if (matchesKey(data, "backspace")) return "Backspace";
  if (matchesKey(data, "tab")) return "tab";
  if (matchesKey(data, "enter")) return "Enter";
  if (matchesKey(data, "up")) return "ArrowUp";
  if (matchesKey(data, "down")) return "ArrowDown";
  if (matchesKey(data, "ctrl+d")) return "ctrl+d";
  if (matchesKey(data, "ctrl+e")) return "ctrl+e";
  if (matchesKey(data, "ctrl+u")) return "ctrl+u";
  if (matchesKey(data, "ctrl+y")) return "ctrl+y";

  const printable = decodeKittyPrintable(data) ?? data;
  return knownSingleKey(printable) ? printable : null;
}

export function dataVersionAfterRefresh(previous: number, observed: Result<number>, refreshed: boolean): number {
  if (!observed.ok || observed.value === previous) return previous;
  return refreshed ? observed.value : previous;
}

function knownSingleKey(data: string): data is AppKey {
  return data.length === 1 && "qrhlHdtnpfgG{}?aScevjkw[]ynuxI1234".includes(data);
}

function assertNever(value: never): never {
  throw new Error(`unhandled effect variant: ${JSON.stringify(value)}`);
}
