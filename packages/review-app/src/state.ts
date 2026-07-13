import {
  currentLine,
  errorMessage,
  hashContent,
  type Anchor,
  type Annotation,
  type AnnotationId,
  type AnalysisRun,
  type AnalysisMode,
  type ContentHash,
  type DiffRow,
  type FileId,
  type FileRecord,
  type PatchId,
  type PatchRecord,
  type ReviewNoteRole,
  type ReviewDataset,
  type SessionRecord
} from "@pi-patches/store";
import { computeFrameLayout, hitTestFrame, type FrameLayout } from "./layout.ts";
import type { MouseEvent } from "./mouse.ts";
import { buildDiffPaneVisualMap } from "./components/diff-pane.ts";
import type { ColorDepth, TintTheme } from "./render/ansi.ts";
import { replayPatches } from "./render/blame.ts";
import { currentToAnchor, diffRow } from "./render/coords.ts";
import { buildDiffModel, type DiffModel, type DiffModelRow } from "./render/diff-model.ts";
import {
  visualEndForLogicalRow,
  visualRowRef,
  visualStartForLogicalRow,
  type DiffVisualMap
} from "./render/diff-wrap.ts";
import { fileIndexAtTreeRow, fileTreeRowCount, treeRowForFileIndex } from "./render/file-tree-model.ts";
import { buildPatchFileSnapshot } from "./render/patch-snapshot.ts";
import { mapRangeThroughPatches, mapRangeThroughTexts, patchesAfterAnchor, type LineRange } from "./render/reanchor.ts";
import {
  filterSourceOptions,
  parseInspectArgs,
  sourceFamily,
  type InspectRequest,
  type SourceInputKind,
  type SourceSelectorOption
} from "./sources/selector.ts";

export type FileState = {
  row: FileRecord;
  current: string | null;
  currentHash: ContentHash;
  additions: number;
  deletions: number;
};

export type DatasetHistoryEntry = {
  fileId: FileId;
  commitSha: string;
  subject: string;
  authoredAt: number;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "typeChanged";
  displayDiff: string;
};

const cumulativeDiffModelCache = new WeakMap<FileState, DiffModel>();
const expandedDiffModelCache = new WeakMap<FileState, DiffModel>();

type PatchTimeline = {
  ordered: PatchRecord[];
  byFile: Map<FileId, PatchRecord[]>;
  globalIndexById: Map<PatchId, number>;
  localIndexById: Map<PatchId, number>;
};

const patchTimelineCache = new WeakMap<readonly PatchRecord[], PatchTimeline>();

export type DbSnapshot = {
  files: FileState[];
  patches: PatchRecord[];
  annotations: Annotation[];
};

export type AnnotationDraft = {
  fileId: FileId;
  anchor: Anchor;
  snippet: string;
};

export type CommentTarget =
  | { kind: "new"; draft: AnnotationDraft }
  | { kind: "edit"; annotationId: AnnotationId }
  | { kind: "reanchor"; annotationId: AnnotationId; draft: AnnotationDraft; oldSnippet: string };

export type Mode =
  | { kind: "normal" }
  | { kind: "visual" }
  | { kind: "confirmSubmit"; count: number }
  | { kind: "comment"; target: CommentTarget; initialText: string; role: ReviewNoteRole }
  | { kind: "finish"; selected: 0 | 1 | 2 | 3; freshAgent: number; staleAgent: number; humanNotes: number }
  | { kind: "overlay"; which: "help" | "annotations" | "guidelines" }
  | { kind: "sourceSelector"; token: number; options: readonly SourceSelectorOption[]; query: string; selected: number }
  | { kind: "sourceInput"; token: number; input: SourceInputKind; text: string }
  | { kind: "sourceHistory"; token: number; request: InspectRequest; selected: 0 | 1 }
  | { kind: "sourceLoading"; token: number; operation: "listing" | "switching" | "refreshing"; label: string }
  | {
      kind: "analysisRunning";
      analysisMode: AnalysisMode;
      phase: "starting" | "direct" | "chunk" | "reduce" | "synthesis";
      completed: number;
      total: number;
      message: string;
      outputTail: string;
    };

export type SourceNavigation = {
  active: InspectRequest;
  lastSession: InspectRequest | null;
  lastGit: InspectRequest | null;
};

export type AppState = {
  session: SessionRecord;
  dataset: ReviewDataset;
  activeTab: "diff" | "notes" | "narrative" | "review";
  analysisRuns: AnalysisRun[];
  selectedAnalysisRun: { narrative: number; implementationReview: number };
  analysisScroll: { notes: number; narrative: number; review: number };
  reviewGuidelines: { path: string; contents: string } | null;
  historyEntries: DatasetHistoryEntry[];
  files: FileState[];
  patches: PatchRecord[];
  annotations: Annotation[];
  viewport: { cols: number; rows: number; bodyRows: number };
  selectedFile: number;
  focusedPane: "tree" | "diff";
  view: "cumulative" | "history";
  renderMode: "syntax" | "native";
  expandedFiles: ReadonlySet<FileId>;
  wrapLines: boolean;
  tintMode: "gradient" | "uniform" | "off";
  colorDepth: ColorDepth;
  tintTheme: TintTheme;
  patchIdx: number;
  followLatestPatch: boolean;
  patchLanding: { patchId: PatchId; phase: number } | null;
  cursorRow: DiffRow;
  annotationCursor: number;
  scrollTop: { tree: number; diff: number };
  pendingKey: "g" | null;
  mode: Mode;
  selection: { anchor: DiffRow; head: DiffRow } | null;
  statusMessage: string | null;
  sourceNavigation: SourceNavigation;
  sourceRequestSeq: number;
};

export type AppKey =
  | "q" | "r" | "tab" | "h" | "l" | "Enter" | "H" | "d" | "t" | "n" | "p" | "f"
  | "g" | "G" | "ctrl+e" | "ctrl+y" | "{" | "}" | "?" | "a" | "S" | "c" | "v"
  | "j" | "ArrowDown" | "k" | "ArrowUp" | "ctrl+d" | "ctrl+u" | "]" | "[" | "Escape"
  | "y" | "e" | "x" | "u" | "I" | "s" | "ctrl+s" | "Backspace" | "1" | "2" | "3" | "4" | "w";

export type AppEvent =
  | { kind: "key"; key: AppKey }
  | { kind: "commentSubmitted"; text: string; role?: ReviewNoteRole }
  | { kind: "commentCancelled" }
  | { kind: "mouse"; mouse: MouseEvent; layout: FrameLayout }
  | { kind: "dbChanged"; snapshot: DbSnapshot }
  | { kind: "fileChanged"; path: string; content: string | null }
  | { kind: "analysisRunsChanged"; runs: AnalysisRun[] }
  | { kind: "analysisStarted"; mode: AnalysisMode }
  | {
      kind: "analysisProgress";
      phase: "direct" | "chunk" | "reduce" | "synthesis";
      completed: number;
      total: number;
      message: string;
      delta?: string;
    }
  | { kind: "analysisFinished"; run: AnalysisRun }
  | { kind: "analysisFailed"; message: string }
  | { kind: "sourceTextInput"; text: string }
  | { kind: "sourceSelectorOpened"; token: number; options: readonly SourceSelectorOption[]; selected: number }
  | { kind: "sourceSwitchSucceeded"; token: number; request: InspectRequest; next: AppState }
  | { kind: "sourceSwitchFailed"; token: number; message: string }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "animationTick" }
  | { kind: "tick" };

export type Effect =
  | { kind: "quit" }
  | { kind: "refresh" }
  | { kind: "queueDrafts"; fixIntent: boolean; quitAfter: boolean }
  | { kind: "addAnnotation"; draft: AnnotationDraft; comment: string; role: ReviewNoteRole }
  | { kind: "updateAnnotation"; annotationId: AnnotationId; comment: string }
  | { kind: "updateAnnotationRole"; annotationId: AnnotationId; role: ReviewNoteRole }
  | { kind: "reanchorAnnotation"; annotationId: AnnotationId; anchor: Anchor; snippet: string }
  | { kind: "deleteAnnotation"; annotationId: AnnotationId }
  | { kind: "openSourceSelector"; token: number }
  | { kind: "switchSource"; token: number; request: InspectRequest }
  | { kind: "cancelAnalysis" };

export function update(state: AppState, event: AppEvent): { state: AppState; effects: Effect[] } {
  if (event.kind === "commentSubmitted") return submitComment(state, event.text, event.role);
  if (event.kind === "commentCancelled") return cancelComment(state);
  if (event.kind === "mouse") return updateMouse(state, event.mouse, event.layout);
  if (event.kind === "dbChanged") return applyDbSnapshot(state, event.snapshot);
  if (event.kind === "fileChanged") return applyFileChanged(state, event.path, event.content);
  if (event.kind === "analysisRunsChanged") return applyAnalysisRuns(state, event.runs);
  if (event.kind === "sourceTextInput") return updateSourceTextInput(state, event.text);
  if (event.kind === "sourceSelectorOpened") return applySourceSelectorOpened(state, event);
  if (event.kind === "sourceSwitchSucceeded") return applySourceSwitchSucceeded(state, event);
  if (event.kind === "sourceSwitchFailed") return applySourceSwitchFailed(state, event);
  if (event.kind === "analysisStarted") {
    return {
      state: {
        ...state,
        activeTab: event.mode === "narrative" ? "narrative" : "review",
        mode: {
          kind: "analysisRunning",
          analysisMode: event.mode,
          phase: "starting",
          completed: 0,
          total: 1,
          message: "Preparing analysis",
          outputTail: ""
        },
        statusMessage: "Analysis running; Esc cancels"
      },
      effects: []
    };
  }
  if (event.kind === "analysisProgress") return applyAnalysisProgress(state, event);
  if (event.kind === "analysisFinished") return applyAnalysisFinished(state, event.run);
  if (event.kind === "analysisFailed") {
    return {
      state: { ...state, mode: { kind: "normal" }, statusMessage: `Analysis failed: ${event.message}` },
      effects: []
    };
  }
  if (event.kind === "resize") return applyResize(state, event.cols, event.rows);
  if (event.kind === "animationTick") return advancePatchLanding(state);
  if (event.kind === "tick") return tick(state);
  switch (state.mode.kind) {
    case "comment":
      return { state, effects: [] };
    case "overlay":
      if (state.mode.which === "annotations") return updateAnnotationOverlay(state, event.key);
      if (event.key === "Escape" || event.key === "q" || event.key === "?") {
        return { state: { ...state, mode: { kind: "normal" } }, effects: [] };
      }
      return { state, effects: [] };
    case "sourceSelector":
      return updateSourceSelector(state, event.key);
    case "sourceInput":
      return updateSourceInput(state, event.key);
    case "sourceHistory":
      return updateSourceHistory(state, event.key);
    case "sourceLoading":
      return event.key === "Escape"
        ? { state: { ...state, mode: { kind: "normal" }, statusMessage: "Source switch cancelled" }, effects: [] }
        : { state, effects: [] };
    case "analysisRunning":
      if (event.key === "Escape" || event.key === "q") {
        return {
          state: { ...state, statusMessage: "Cancelling analysis" },
          effects: [{ kind: "cancelAnalysis" }]
        };
      }
      return { state, effects: [] };
    case "confirmSubmit":
      if (event.key === "y") return { state: { ...state, mode: { kind: "normal" } }, effects: [{ kind: "queueDrafts", fixIntent: false, quitAfter: false }] };
      if (event.key === "n" || event.key === "Escape") return { state: { ...state, mode: { kind: "normal" } }, effects: [] };
      return { state, effects: [] };
    case "finish":
      return updateFinishSelector(state, event.key);
    case "normal":
    case "visual":
      break;
    default:
      return assertNever(state.mode);
  }
  if (state.pendingKey === "g") {
    if (event.key === "g") return moveCursorToDiffRow({ ...state, pendingKey: null, statusMessage: null }, 0);
    return update({ ...state, pendingKey: null, statusMessage: null }, event);
  }
  if (event.key === "1") return { state: { ...state, activeTab: "diff" }, effects: [] };
  if (event.key === "2") return { state: { ...state, activeTab: "notes" }, effects: [] };
  if (event.key === "3") return { state: { ...state, activeTab: "narrative" }, effects: [] };
  if (event.key === "4") return { state: { ...state, activeTab: "review" }, effects: [] };
  if (event.key === "I") {
    return state.reviewGuidelines === null
      ? { state: { ...state, statusMessage: "No REVIEW_GUIDELINES.md for this project" }, effects: [] }
      : { state: { ...state, mode: { kind: "overlay", which: "guidelines" } }, effects: [] };
  }
  if (event.key === "s") return openSourceSelector(state);
  if (state.activeTab !== "diff") return updateNonDiffTab(state, event.key);
  switch (event.key) {
    case "q":
      return openFinishSelector(state);
    case "r":
      return refreshSource(state);
    case "tab":
      return { state: { ...state, pendingKey: null, focusedPane: state.focusedPane === "tree" ? "diff" : "tree" }, effects: [] };
    case "h":
      return { state: { ...state, pendingKey: null, focusedPane: "tree" }, effects: [] };
    case "l":
      return { state: { ...state, pendingKey: null, focusedPane: "diff" }, effects: [] };
    case "Enter":
      return expandCollapsedAtCursor(state) ?? { state: { ...state, pendingKey: null, focusedPane: "diff" }, effects: [] };
    case "H":
      return {
        state: {
          ...state,
          pendingKey: null,
          view: state.view === "cumulative" ? "history" : "cumulative",
          patchIdx: 0,
          followLatestPatch: false,
          patchLanding: null,
          cursorRow: diffRow(0),
          scrollTop: { ...state.scrollTop, diff: 0 }
        },
        effects: []
      };
    case "d":
      return {
        state: {
          ...state,
          pendingKey: null,
          renderMode: state.renderMode === "syntax" ? "native" : "syntax",
          cursorRow: diffRow(0),
          scrollTop: { ...state.scrollTop, diff: 0 }
        },
        effects: []
      };
    case "w":
      return toggleLineWrap(state);
    case "e":
      return toggleSelectedFileExpansion(state);
    case "t":
      return { state: { ...state, pendingKey: null, tintMode: nextTintMode(state.tintMode) }, effects: [] };
    case "n":
      return selectPatch(state, 1);
    case "p":
      return selectPatch(state, -1);
    case "f":
      return followLatestPatch(state);
    case "g":
      return { state: { ...state, pendingKey: "g", statusMessage: "g" }, effects: [] };
    case "G":
      return moveCursorToDiffRow(state, diffRowCount(state) - 1);
    case "ctrl+e":
      return scrollPane(state, state.focusedPane, 1, viewportRows(state));
    case "ctrl+y":
      return scrollPane(state, state.focusedPane, -1, viewportRows(state));
    case "{":
      return moveToHunk(state, -1);
    case "}":
      return moveToHunk(state, 1);
    case "?":
      return { state: { ...state, mode: { kind: "overlay", which: "help" } }, effects: [] };
    case "a":
      return { state: { ...state, mode: { kind: "overlay", which: "annotations" } }, effects: [] };
    case "S": {
      const drafts = state.annotations.filter((annotation) => annotation.state.kind === "draft");
      const freshCount = drafts.filter((annotation) => annotationIsFresh(state, annotation)).length;
      const staleCount = drafts.length - freshCount;
      const suffix = staleCount > 0 ? `; ${staleCount} stale excluded` : "";
      return {
        state: {
          ...state,
          mode: freshCount > 0 ? { kind: "confirmSubmit", count: freshCount } : { kind: "normal" },
          statusMessage:
            freshCount > 0
              ? `Submit ${freshCount} fresh draft comment(s)? y/n${suffix}`
              : staleCount > 0
                ? `${staleCount} stale draft comment(s) need update or removal`
                : "No draft comments to submit"
        },
        effects: []
      };
    }
    case "c": {
      const draft = draftForCursor(state);
      if (!draft) return { state: { ...state, statusMessage: "No current-version line under cursor" }, effects: [] };
      return {
        state: {
          ...state,
          mode: {
            kind: "comment",
            target: { kind: "new", draft },
            initialText: "",
            role: { kind: "finding", priority: "P2", audience: "agent" }
          },
          statusMessage: "Ctrl-S saves note; Esc cancels"
        },
        effects: []
      };
    }
    case "v":
      if (state.mode.kind === "visual") return { state: { ...state, mode: { kind: "normal" }, selection: null }, effects: [] };
      return {
        state: { ...state, mode: { kind: "visual" }, selection: { anchor: state.cursorRow, head: state.cursorRow } },
        effects: []
      };
    case "j":
    case "ArrowDown":
      return moveCursor(state, 1);
    case "k":
    case "ArrowUp":
      return moveCursor(state, -1);
    case "ctrl+d":
      return moveCursor(state, halfPageRows(state));
    case "ctrl+u":
      return moveCursor(state, -halfPageRows(state));
    case "]":
      return selectFile(state, 1);
    case "[":
      return selectFile(state, -1);
    case "Escape":
      return { state: { ...state, mode: { kind: "normal" }, selection: null }, effects: [] };
    default:
      return { state, effects: [] };
  }
}

function openSourceSelector(state: AppState): { state: AppState; effects: Effect[] } {
  const token = state.sourceRequestSeq + 1;
  return {
    state: {
      ...state,
      sourceRequestSeq: token,
      mode: { kind: "sourceLoading", token, operation: "listing", label: "Loading review sources" },
      selection: null,
      statusMessage: "Loading review sources"
    },
    effects: [{ kind: "openSourceSelector", token }]
  };
}

function refreshSource(state: AppState): { state: AppState; effects: Effect[] } {
  if (state.dataset.source.kind === "session") return { state, effects: [{ kind: "refresh" }] };
  const token = state.sourceRequestSeq + 1;
  const request = state.sourceNavigation.active;
  return {
    state: {
      ...state,
      sourceRequestSeq: token,
      mode: { kind: "sourceLoading", token, operation: "refreshing", label: `Refreshing ${sourceRequestLabel(request)}` },
      statusMessage: `Refreshing ${sourceRequestLabel(request)}`
    },
    effects: [{ kind: "switchSource", token, request }]
  };
}

function applySourceSelectorOpened(
  state: AppState,
  event: Extract<AppEvent, { kind: "sourceSelectorOpened" }>
): { state: AppState; effects: Effect[] } {
  if (state.mode.kind !== "sourceLoading" || state.mode.token !== event.token || state.mode.operation !== "listing") {
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      mode: {
        kind: "sourceSelector",
        token: event.token,
        options: event.options,
        query: "",
        selected: clamp(event.selected, 0, Math.max(0, event.options.length - 1))
      },
      statusMessage: event.options.length === 0 ? "No review sources available" : "Type to filter; Enter switches; Esc cancels"
    },
    effects: []
  };
}

function updateSourceSelector(state: AppState, key: AppKey): { state: AppState; effects: Effect[] } {
  if (state.mode.kind !== "sourceSelector") return { state, effects: [] };
  const mode = state.mode;
  const visible = filterSourceOptions(mode.options, mode.query);
  if (key === "Escape" || key === "q") {
    return { state: { ...state, mode: { kind: "normal" }, statusMessage: "Source switch cancelled" }, effects: [] };
  }
  if (key === "Backspace") {
    return {
      state: { ...state, mode: { ...mode, query: mode.query.slice(0, -1), selected: 0 } },
      effects: []
    };
  }
  if (key === "ArrowDown" || key === "ctrl+d") {
    return {
      state: { ...state, mode: { ...mode, selected: clamp(mode.selected + 1, 0, Math.max(0, visible.length - 1)) } },
      effects: []
    };
  }
  if (key === "ArrowUp" || key === "ctrl+u") {
    return {
      state: { ...state, mode: { ...mode, selected: clamp(mode.selected - 1, 0, Math.max(0, visible.length - 1)) } },
      effects: []
    };
  }
  if (key !== "Enter") return { state, effects: [] };
  const option = visible[mode.selected];
  if (!option) return { state, effects: [] };
  if (option.choice.kind === "input") {
    return {
      state: {
        ...state,
        mode: { kind: "sourceInput", token: mode.token, input: option.choice.input, text: "" },
        statusMessage: sourceInputPrompt(option.choice.input)
      },
      effects: []
    };
  }
  if (option.choice.selectHistory) {
    return {
      state: {
        ...state,
        mode: {
          kind: "sourceHistory",
          token: mode.token,
          request: option.choice.request,
          selected: option.choice.request.historyMode === "perCommit" ? 1 : 0
        },
        statusMessage: "Choose squashed or per-commit history"
      },
      effects: []
    };
  }
  return beginSourceSwitch(state, mode.token, option.choice.request);
}

function updateSourceTextInput(state: AppState, text: string): { state: AppState; effects: Effect[] } {
  if (text.length === 0 || [...text].some((character) => character < " ")) return { state, effects: [] };
  if (state.mode.kind === "sourceSelector") {
    return {
      state: { ...state, mode: { ...state.mode, query: `${state.mode.query}${text}`, selected: 0 } },
      effects: []
    };
  }
  if (state.mode.kind === "sourceInput") {
    return {
      state: { ...state, mode: { ...state.mode, text: `${state.mode.text}${text}` } },
      effects: []
    };
  }
  return { state, effects: [] };
}

function updateSourceInput(state: AppState, key: AppKey): { state: AppState; effects: Effect[] } {
  if (state.mode.kind !== "sourceInput") return { state, effects: [] };
  const mode = state.mode;
  if (key === "Escape") return { state: { ...state, mode: { kind: "normal" }, statusMessage: "Source switch cancelled" }, effects: [] };
  if (key === "Backspace") return { state: { ...state, mode: { ...mode, text: mode.text.slice(0, -1) } }, effects: [] };
  if (key !== "Enter") return { state, effects: [] };
  const parsed = parseSourceInput(mode.input, mode.text);
  if (!parsed.ok || parsed.value === null) {
    const message = parsed.ok ? "Source input is required" : errorMessage(parsed.error);
    return { state: { ...state, statusMessage: message }, effects: [] };
  }
  const request = parsed.value;
  const selectHistory = request.source.kind === "commitRange" || request.source.kind === "pullRequest";
  return selectHistory
    ? {
        state: {
          ...state,
          mode: { kind: "sourceHistory", token: mode.token, request, selected: 0 },
          statusMessage: "Choose squashed or per-commit history"
        },
        effects: []
      }
    : beginSourceSwitch(state, mode.token, request);
}

function updateSourceHistory(state: AppState, key: AppKey): { state: AppState; effects: Effect[] } {
  if (state.mode.kind !== "sourceHistory") return { state, effects: [] };
  const mode = state.mode;
  if (key === "Escape") return { state: { ...state, mode: { kind: "normal" }, statusMessage: "Source switch cancelled" }, effects: [] };
  if (key === "ArrowDown" || key === "ArrowUp" || key === "j" || key === "k") {
    return { state: { ...state, mode: { ...mode, selected: mode.selected === 0 ? 1 : 0 } }, effects: [] };
  }
  if (key !== "Enter") return { state, effects: [] };
  return beginSourceSwitch(state, mode.token, {
    ...mode.request,
    historyMode: mode.selected === 0 ? "squashed" : "perCommit"
  });
}

function beginSourceSwitch(
  state: AppState,
  token: number,
  request: InspectRequest
): { state: AppState; effects: Effect[] } {
  const label = sourceRequestLabel(request);
  return {
    state: {
      ...state,
      mode: { kind: "sourceLoading", token, operation: "switching", label: `Loading ${label}` },
      statusMessage: `Loading ${label}`
    },
    effects: [{ kind: "switchSource", token, request }]
  };
}

function applySourceSwitchSucceeded(
  state: AppState,
  event: Extract<AppEvent, { kind: "sourceSwitchSucceeded" }>
): { state: AppState; effects: Effect[] } {
  if (state.mode.kind !== "sourceLoading" || state.mode.token !== event.token) return { state, effects: [] };
  const refreshed = state.mode.operation === "refreshing";
  const family = sourceFamily(event.request);
  const navigation: SourceNavigation = {
    active: event.request,
    lastSession: family === "session" ? event.request : state.sourceNavigation.lastSession,
    lastGit: family === "git" ? event.request : state.sourceNavigation.lastGit
  };
  return {
    state: {
      ...event.next,
      activeTab: "diff",
      viewport: state.viewport,
      focusedPane: state.focusedPane,
      renderMode: state.renderMode,
      wrapLines: state.wrapLines,
      tintMode: state.tintMode,
      colorDepth: state.colorDepth,
      tintTheme: state.tintTheme,
      reviewGuidelines: state.reviewGuidelines,
      sourceNavigation: navigation,
      sourceRequestSeq: state.sourceRequestSeq,
      mode: { kind: "normal" },
      statusMessage: `${refreshed ? "Refreshed" : "Switched to"} ${sourceRequestLabel(event.request)}`
    },
    effects: []
  };
}

function applySourceSwitchFailed(
  state: AppState,
  event: Extract<AppEvent, { kind: "sourceSwitchFailed" }>
): { state: AppState; effects: Effect[] } {
  if (state.mode.kind !== "sourceLoading" || state.mode.token !== event.token) return { state, effects: [] };
  return {
    state: { ...state, mode: { kind: "normal" }, statusMessage: `Source switch failed: ${event.message}` },
    effects: []
  };
}

function parseSourceInput(input: SourceInputKind, text: string) {
  switch (input) {
    case "commitRange": return parseInspectArgs(`range ${text}`);
    case "pullRequest": return parseInspectArgs(`pr ${text}`);
    case "snapshot": return parseInspectArgs(`snapshot ${text}`);
  }
}

function sourceInputPrompt(input: SourceInputKind): string {
  switch (input) {
    case "commitRange": return "Enter commit range: base..head";
    case "pullRequest": return "Enter pull request number";
    case "snapshot": return "Enter snapshot paths (quotes supported)";
  }
}

function sourceRequestLabel(request: InspectRequest): string {
  const source = request.source;
  switch (source.kind) {
    case "session": return `session ${source.sessionId ?? "current"}`;
    case "workingTree": return "complete working tree";
    case "staged": return "staged HEAD..INDEX";
    case "unstaged": return "unstaged INDEX..WORKTREE";
    case "branch": return `branch ${source.baseRef}..${source.headRef}`;
    case "commit": return `commit ${source.sha.slice(0, 8)}`;
    case "commitRange": return `range ${source.baseExclusive}..${source.headInclusive}`;
    case "pullRequest": return `PR #${source.number}`;
    case "snapshot": return `snapshot ${source.paths.join(" ")}`;
  }
}

function applyDbSnapshot(state: AppState, snapshot: DbSnapshot): { state: AppState; effects: Effect[] } {
  const previousTimeline = patchTimeline(state.patches);
  const nextTimeline = patchTimeline(snapshot.patches);
  const previousTail = previousTimeline.ordered.at(-1)?.id;
  const nextTail = nextTimeline.ordered.at(-1)?.id;
  const liveFileIds = new Set(snapshot.files.map((file) => file.row.id));
  const replaced = {
    ...state,
    files: snapshot.files,
    patches: snapshot.patches,
    annotations: snapshot.annotations,
    expandedFiles: new Set([...state.expandedFiles].filter((id) => liveFileIds.has(id))),
    selectedFile: Math.min(state.selectedFile, Math.max(0, snapshot.files.length - 1)),
    annotationCursor: Math.min(state.annotationCursor, Math.max(0, snapshot.annotations.length - 1)),
    mode: state.mode.kind === "comment" ? { kind: "normal" } as const : state.mode
  };
  const tailAdvanced = nextTimeline.ordered.length > previousTimeline.ordered.length && previousTail !== nextTail;
  const followed = state.followLatestPatch && tailAdvanced
    ? selectLatestSessionPatch(replaced, true, true)
    : replaced;
  return {
    state: clampScroll(followed),
    effects: []
  };
}

function applyFileChanged(state: AppState, path: string, content: string | null): { state: AppState; effects: Effect[] } {
  const index = state.files.findIndex((file) => file.row.path === path);
  if (index < 0) return { state, effects: [] };
  const files = state.files.slice();
  files[index] = fileStateFromContent(files[index].row, content);
  return {
    state: clampScroll({
      ...state,
      files,
      mode: state.mode.kind === "comment" ? { kind: "normal" } : state.mode
    }),
    effects: []
  };
}

function applyAnalysisRuns(state: AppState, runs: AnalysisRun[]): { state: AppState; effects: Effect[] } {
  const narrativeCount = runs.filter((run) => run.mode === "narrative").length;
  const reviewCount = runs.filter((run) => run.mode === "implementationReview").length;
  return {
    state: {
      ...state,
      analysisRuns: runs,
      selectedAnalysisRun: {
        narrative: clamp(state.selectedAnalysisRun.narrative, 0, Math.max(0, narrativeCount - 1)),
        implementationReview: clamp(state.selectedAnalysisRun.implementationReview, 0, Math.max(0, reviewCount - 1))
      }
    },
    effects: []
  };
}

function applyAnalysisProgress(
  state: AppState,
  event: Extract<AppEvent, { kind: "analysisProgress" }>
): { state: AppState; effects: Effect[] } {
  if (state.mode.kind !== "analysisRunning") return { state, effects: [] };
  const outputTail = event.delta === undefined
    ? state.mode.outputTail
    : `${state.mode.outputTail}${event.delta}`.slice(-4000);
  return {
    state: {
      ...state,
      mode: {
        ...state.mode,
        phase: event.phase,
        completed: event.completed,
        total: event.total,
        message: event.message,
        outputTail
      }
    },
    effects: []
  };
}

function applyAnalysisFinished(state: AppState, run: AnalysisRun): { state: AppState; effects: Effect[] } {
  if (state.mode.kind !== "analysisRunning") return { state, effects: [] };
  const label = run.status === "completed"
    ? `${run.mode === "narrative" ? "Narrative" : "Implementation review"} completed`
    : `Analysis ${run.status}: ${run.error ?? "no result"}`;
  return {
    state: {
      ...state,
      mode: { kind: "normal" },
      activeTab: run.mode === "narrative" ? "narrative" : "review",
      statusMessage: label
    },
    effects: []
  };
}

function updateNonDiffTab(state: AppState, key: AppKey): { state: AppState; effects: Effect[] } {
  if (state.activeTab === "diff") return { state, effects: [] };
  if (key === "q") return openFinishSelector(state);
  if (key === "r") return refreshSource(state);
  if (key === "?") return { state: { ...state, mode: { kind: "overlay", which: "help" } }, effects: [] };
  const tab = state.activeTab;
  if (key === "j" || key === "ArrowDown" || key === "ctrl+e") {
    return { state: { ...state, analysisScroll: { ...state.analysisScroll, [tab]: state.analysisScroll[tab] + 1 } }, effects: [] };
  }
  if (key === "k" || key === "ArrowUp" || key === "ctrl+y") {
    return { state: { ...state, analysisScroll: { ...state.analysisScroll, [tab]: Math.max(0, state.analysisScroll[tab] - 1) } }, effects: [] };
  }
  if ((key === "n" || key === "p") && (tab === "narrative" || tab === "review")) {
    const mode = tab === "narrative" ? "narrative" : "implementationReview";
    const count = state.analysisRuns.filter((run) => run.mode === mode).length;
    const delta = key === "n" ? 1 : -1;
    return {
      state: {
        ...state,
        selectedAnalysisRun: {
          ...state.selectedAnalysisRun,
          [mode]: clamp(state.selectedAnalysisRun[mode] + delta, 0, Math.max(0, count - 1))
        },
        analysisScroll: { ...state.analysisScroll, [tab]: 0 }
      },
      effects: []
    };
  }
  return { state, effects: [] };
}

function applyResize(state: AppState, cols: number, rows: number): { state: AppState; effects: Effect[] } {
  const topLogicalRow = visualRowRef(currentDiffVisualMap(state), state.scrollTop.diff)?.logicalRow;
  const resized = { ...state, viewport: viewportFromSize(cols, rows) };
  const nextMap = currentDiffVisualMap(resized);
  return {
    state: clampScroll({
      ...resized,
      scrollTop: {
        ...resized.scrollTop,
        diff: topLogicalRow === undefined
          ? resized.scrollTop.diff
          : visualStartForLogicalRow(nextMap, topLogicalRow)
      }
    }),
    effects: []
  };
}

function toggleLineWrap(state: AppState): { state: AppState; effects: Effect[] } {
  const topLogicalRow = visualRowRef(currentDiffVisualMap(state), state.scrollTop.diff)?.logicalRow ?? 0;
  const next = { ...state, wrapLines: !state.wrapLines };
  const nextMap = currentDiffVisualMap(next);
  return {
    state: clampScroll({
      ...next,
      pendingKey: null,
      scrollTop: { ...next.scrollTop, diff: visualStartForLogicalRow(nextMap, topLogicalRow) },
      statusMessage: next.wrapLines ? "Line wrap on" : "Line wrap off"
    }),
    effects: []
  };
}

function expandCollapsedAtCursor(state: AppState): { state: AppState; effects: Effect[] } | null {
  if (state.view !== "cumulative" || state.renderMode !== "syntax" || state.focusedPane !== "diff") return null;
  const file = state.files[state.selectedFile];
  if (!file || state.expandedFiles.has(file.row.id)) return null;
  const row = cumulativeDiffModel(file, false).rows[Number(state.cursorRow)];
  return row?.kind === "collapsed"
    ? toggleSelectedFileExpansion(state, true, Number(row.newStart))
    : null;
}

function toggleSelectedFileExpansion(
  state: AppState,
  force?: boolean,
  requestedLine?: number
): { state: AppState; effects: Effect[] } {
  if (state.view !== "cumulative") {
    return { state: { ...state, statusMessage: "File expansion is available in cumulative view" }, effects: [] };
  }
  const file = state.files[state.selectedFile];
  if (!file) return { state: { ...state, statusMessage: "No selected file to expand" }, effects: [] };
  const wasExpanded = state.expandedFiles.has(file.row.id);
  const expanded = force ?? !wasExpanded;
  if (expanded === wasExpanded) return { state, effects: [] };

  const previousRows = cumulativeDiffModel(file, wasExpanded).rows;
  const previousIndex = clamp(Number(state.cursorRow), 0, Math.max(0, previousRows.length - 1));
  const preferredLine = requestedLine ?? currentCoordinateForRow(previousRows, previousIndex) ?? 1;
  const expandedFiles = new Set(state.expandedFiles);
  if (expanded) expandedFiles.add(file.row.id);
  else expandedFiles.delete(file.row.id);

  const nextRows = cumulativeDiffModel(file, expanded).rows;
  const cursor = rowForCurrentLine(nextRows, preferredLine);
  const positioned = {
    ...state,
    expandedFiles,
    focusedPane: "diff" as const,
    pendingKey: null,
    cursorRow: diffRow(cursor),
    selection: null,
    statusMessage: `${expanded ? "Expanded" : "Collapsed"} ${file.row.relPath} to ${expanded ? "full file" : "patch context"}`
  };
  const map = currentDiffVisualMap(positioned);
  const visualRow = visualStartForLogicalRow(map, cursor);
  return {
    state: {
      ...positioned,
      scrollTop: {
        ...positioned.scrollTop,
        diff: clamp(visualRow - Math.floor(viewportRows(positioned) / 3), 0, Math.max(0, map.visualRowCount - viewportRows(positioned)))
      }
    },
    effects: []
  };
}

function currentCoordinateForRow(rows: readonly DiffModelRow[], index: number): number | null {
  const row = rows[index];
  if (!row) return null;
  if (row.kind === "collapsed") return Number(row.newStart);
  if (hasCurrentLine(row)) return Number(row.newLine);
  return nearestCurrentLineBefore(rows, index) ?? nearestCurrentLineAfter(rows, index);
}

function rowForCurrentLine(rows: readonly DiffModelRow[], line: number): number {
  const exact = rows.findIndex((row) => hasCurrentLine(row) && Number(row.newLine) === line);
  if (exact >= 0) return exact;
  const collapsed = rows.findIndex(
    (row) => row.kind === "collapsed" && line >= Number(row.newStart) && line < Number(row.newStart) + row.lines
  );
  if (collapsed >= 0) return collapsed;
  const following = rows.findIndex((row) => hasCurrentLine(row) && Number(row.newLine) > line);
  if (following >= 0) return following;
  return Math.max(0, rows.length - 1);
}

function tick(state: AppState): { state: AppState; effects: Effect[] } {
  if (state.pendingKey === null) return { state, effects: [] };
  return {
    state: {
      ...state,
      pendingKey: null,
      statusMessage: state.statusMessage === state.pendingKey ? null : state.statusMessage
    },
    effects: []
  };
}

function advancePatchLanding(state: AppState): { state: AppState; effects: Effect[] } {
  if (state.patchLanding === null) return { state, effects: [] };
  const phase = state.patchLanding.phase + 1;
  return {
    state: { ...state, patchLanding: phase >= 6 ? null : { ...state.patchLanding, phase } },
    effects: []
  };
}

function nextTintMode(mode: AppState["tintMode"]): AppState["tintMode"] {
  switch (mode) {
    case "gradient":
      return "uniform";
    case "uniform":
      return "off";
    case "off":
      return "gradient";
  }
}

function updateAnnotationOverlay(state: AppState, key: AppKey): { state: AppState; effects: Effect[] } {
  if (key === "Escape" || key === "q" || key === "?") {
    return { state: { ...state, mode: { kind: "normal" } }, effects: [] };
  }
  if (state.annotations.length === 0) return { state, effects: [] };
  switch (key) {
    case "j":
    case "ArrowDown":
      return { state: { ...state, annotationCursor: clamp(state.annotationCursor + 1, 0, state.annotations.length - 1) }, effects: [] };
    case "k":
    case "ArrowUp":
      return { state: { ...state, annotationCursor: clamp(state.annotationCursor - 1, 0, state.annotations.length - 1) }, effects: [] };
    case "Enter":
      return jumpToSelectedAnnotation(state);
    case "e": {
      const annotation = selectedAnnotation(state);
      if (!annotation) return { state, effects: [] };
      if (annotation.state.kind === "sent") {
        return { state: { ...state, statusMessage: "Sent annotations cannot be edited" }, effects: [] };
      }
      return {
        state: {
          ...state,
          mode: {
            kind: "comment",
            target: { kind: "edit", annotationId: annotation.id },
            initialText: annotation.comment,
            role: annotation.role
          },
          statusMessage: "Ctrl-S saves comment edit; Esc cancels"
        },
        effects: []
      };
    }
    case "x": {
      const annotation = selectedAnnotation(state);
      if (!annotation) return { state, effects: [] };
      if (annotation.state.kind === "sent") {
        return { state: { ...state, statusMessage: "Sent annotations cannot be deleted" }, effects: [] };
      }
      return {
        state: {
          ...state,
          annotationCursor: clamp(state.annotationCursor, 0, Math.max(0, state.annotations.length - 2)),
          statusMessage: "Deleting annotation"
        },
        effects: [{ kind: "deleteAnnotation", annotationId: annotation.id }]
      };
    }
    case "u":
      return reanchorSelectedAnnotation(state);
    default:
      return { state, effects: [] };
  }
}

function openFinishSelector(state: AppState): { state: AppState; effects: Effect[] } {
  const drafts = state.annotations.filter((annotation) => annotation.state.kind === "draft");
  if (drafts.length === 0) return { state, effects: [{ kind: "quit" }] };
  const agentFindings = drafts.filter(
    (annotation) => annotation.role.kind === "finding" && annotation.role.audience === "agent"
  );
  const freshAgent = agentFindings.filter((annotation) => annotationIsFresh(state, annotation)).length;
  const staleAgent = agentFindings.length - freshAgent;
  return {
    state: {
      ...state,
      mode: {
        kind: "finish",
        selected: 0,
        freshAgent,
        staleAgent,
        humanNotes: drafts.length - agentFindings.length
      },
      statusMessage: "Choose how to finish this review"
    },
    effects: []
  };
}

function updateFinishSelector(state: AppState, key: AppKey): { state: AppState; effects: Effect[] } {
  if (state.mode.kind !== "finish") return { state, effects: [] };
  if (key === "Escape" || key === "q" || key === "n") {
    return { state: { ...state, mode: { kind: "normal" }, statusMessage: "Finish cancelled" }, effects: [] };
  }
  if (key === "j" || key === "ArrowDown") {
    return { state: { ...state, mode: { ...state.mode, selected: finishIndex(state.mode.selected + 1) } }, effects: [] };
  }
  if (key === "k" || key === "ArrowUp") {
    return { state: { ...state, mode: { ...state.mode, selected: finishIndex(state.mode.selected - 1) } }, effects: [] };
  }
  if (key !== "Enter" && key !== "y") return { state, effects: [] };
  switch (state.mode.selected) {
    case 0:
      return { state, effects: [{ kind: "quit" }] };
    case 1:
      return {
        state: { ...state, mode: { kind: "normal" }, statusMessage: "Submitting feedback" },
        effects: [{ kind: "queueDrafts", fixIntent: false, quitAfter: true }]
      };
    case 2:
      return {
        state: { ...state, mode: { kind: "normal" }, statusMessage: "Submitting findings with fix intent" },
        effects: [{ kind: "queueDrafts", fixIntent: true, quitAfter: true }]
      };
    case 3:
      return { state: { ...state, mode: { kind: "normal" }, statusMessage: "Finish cancelled" }, effects: [] };
  }
}

function finishIndex(value: number): 0 | 1 | 2 | 3 {
  return Math.max(0, Math.min(3, value)) as 0 | 1 | 2 | 3;
}

function updateMouse(state: AppState, mouse: MouseEvent, layout: FrameLayout): { state: AppState; effects: Effect[] } {
  if (state.mode.kind === "comment" ||
    state.mode.kind === "overlay" ||
    state.mode.kind === "confirmSubmit" ||
    state.mode.kind === "finish" ||
    state.mode.kind === "analysisRunning" ||
    state.mode.kind === "sourceSelector" ||
    state.mode.kind === "sourceInput" ||
    state.mode.kind === "sourceHistory" ||
    state.mode.kind === "sourceLoading") {
    return { state, effects: [] };
  }
  const hit = hitTestFrame(layout, mouse.x, mouse.y);
  if (mouse.kind === "press" && mouse.button === 0 && mouse.y === 1 && hit.kind === "header") {
    const tab = tabForColumn(mouse.x, layout.columns);
    return tab ? { state: { ...state, activeTab: tab }, effects: [] } : { state, effects: [] };
  }
  if (state.activeTab !== "diff") {
    if (mouse.kind !== "wheel" || (hit.kind !== "tree" && hit.kind !== "diff")) return { state, effects: [] };
    const tab = state.activeTab;
    const wheelRows = Math.max(3, Math.ceil(layout.bodyRows / 8));
    const delta = mouse.direction === "down" ? wheelRows : -wheelRows;
    return {
      state: {
        ...state,
        analysisScroll: { ...state.analysisScroll, [tab]: Math.max(0, state.analysisScroll[tab] + delta) }
      },
      effects: []
    };
  }
  if (mouse.kind === "wheel") {
    if (hit.kind !== "tree" && hit.kind !== "diff") return { state, effects: [] };
    const wheelRows = Math.max(3, Math.ceil(layout.bodyRows / 8));
    const delta = mouse.direction === "down" ? wheelRows : -wheelRows;
    return scrollPane(state, hit.kind, delta, layout.bodyRows);
  }
  if (mouse.button !== 0) return { state, effects: [] };
  if (mouse.kind === "press" && hit.kind === "tree") {
    const fileIndex = fileIndexAtTreeRow(state.files, state.scrollTop.tree + hit.row);
    return fileIndex === null ? { state: { ...state, focusedPane: "tree" }, effects: [] } : selectFileAt(state, fileIndex, layout.bodyRows);
  }
  if (hit.kind !== "diff") return { state, effects: [] };
  const ref = visualRowRef(currentDiffVisualMap(state), state.scrollTop.diff + hit.row);
  if (!ref) {
    return mouse.kind === "press"
      ? { state: { ...state, focusedPane: "diff", mode: { kind: "normal" }, selection: null }, effects: [] }
      : { state, effects: [] };
  }
  if (mouse.kind === "press") {
    const file = state.files[state.selectedFile];
    const row = file && state.view === "cumulative" && state.renderMode === "syntax"
      ? cumulativeDiffModel(file, state.expandedFiles.has(file.row.id)).rows[ref.logicalRow]
      : undefined;
    if (row?.kind === "collapsed") return toggleSelectedFileExpansion(state, true, Number(row.newStart));
    return moveCursorToRow(state, ref.logicalRow, layout.bodyRows, false);
  }
  if (mouse.kind === "move") return moveCursorToRow(state, ref.logicalRow, layout.bodyRows, true);
  if (mouse.kind === "release" && state.mode.kind === "visual") {
    return moveCursorToRow(state, ref.logicalRow, layout.bodyRows, true);
  }
  return { state, effects: [] };
}

export function tabForColumn(x: number, width: number): AppState["activeTab"] | null {
  const labels: Array<{ tab: AppState["activeTab"]; label: string }> = [
    { tab: "diff", label: " Diff " },
    { tab: "notes", label: " Notes " },
    { tab: "narrative", label: " Narrative " },
    { tab: "review", label: " Review " }
  ];
  let start = 1;
  for (const entry of labels) {
    const end = start + entry.label.length - 1;
    if (x >= start && x <= Math.min(width, end)) return entry.tab;
    start = end + 2;
  }
  return null;
}

function submitComment(state: AppState, text: string, submittedRole?: ReviewNoteRole): { state: AppState; effects: Effect[] } {
  if (state.mode.kind !== "comment") return { state, effects: [] };
  const comment = text.trim();
  if (!comment) return { state: { ...state, statusMessage: "Comment is empty" }, effects: [] };
  const role = submittedRole ?? state.mode.role;
  if (state.mode.target.kind === "edit") {
    return {
      state: { ...state, mode: { kind: "normal" }, statusMessage: "Saving comment edit" },
      effects: [
        { kind: "updateAnnotation", annotationId: state.mode.target.annotationId, comment },
        { kind: "updateAnnotationRole", annotationId: state.mode.target.annotationId, role }
      ]
    };
  }
  if (state.mode.target.kind === "reanchor") {
    return {
      state: { ...state, mode: { kind: "normal" }, statusMessage: "Saving re-anchored comment" },
      effects: [
        {
          kind: "reanchorAnnotation",
          annotationId: state.mode.target.annotationId,
          anchor: state.mode.target.draft.anchor,
          snippet: state.mode.target.draft.snippet
        },
        { kind: "updateAnnotation", annotationId: state.mode.target.annotationId, comment },
        { kind: "updateAnnotationRole", annotationId: state.mode.target.annotationId, role }
      ]
    };
  }
  return {
    state: { ...state, mode: { kind: "normal" }, statusMessage: "Saving draft comment" },
    effects: [{ kind: "addAnnotation", draft: state.mode.target.draft, comment, role }]
  };
}

function cancelComment(state: AppState): { state: AppState; effects: Effect[] } {
  if (state.mode.kind !== "comment") return { state, effects: [] };
  return { state: { ...state, mode: { kind: "normal" }, statusMessage: "Comment cancelled" }, effects: [] };
}

function moveCursor(state: AppState, delta: number): { state: AppState; effects: Effect[] } {
  return moveCursorToDiffRow(state, Number(state.cursorRow) + delta);
}

function moveCursorToDiffRow(state: AppState, row: number): { state: AppState; effects: Effect[] } {
  const rowCount = diffRowCount(state);
  if (rowCount === 0) return { state: { ...state, pendingKey: null }, effects: [] };
  const next = diffRow(clamp(row, 0, rowCount - 1));
  const visualMap = currentDiffVisualMap(state);
  const selection =
    state.mode.kind === "visual" && state.selection ? { ...state.selection, head: next } : state.selection;
  return {
    state: {
      ...state,
      pendingKey: null,
      cursorRow: next,
      selection,
      scrollTop: {
        ...state.scrollTop,
        diff: scrollTopForLogicalRow(Number(next), visualMap, state.scrollTop.diff, viewportRows(state))
      }
    },
    effects: []
  };
}

function moveToHunk(state: AppState, direction: -1 | 1): { state: AppState; effects: Effect[] } {
  if (state.view === "history" && state.dataset.source.kind === "session" && state.historyEntries.length === 0) {
    return { state: { ...state, pendingKey: null, statusMessage: "Hunk navigation is unavailable in full-file patch view" }, effects: [] };
  }
  const rows = currentDiffRows(state);
  const cursor = Number(state.cursorRow);
  const hunkRows = rows
    .map((row, index) => (row.kind === "hunk" ? index : null))
    .filter((index): index is number => index !== null);
  const target =
    direction > 0
      ? hunkRows.find((row) => row > cursor)
      : hunkRows.findLast((row) => row < cursor);
  return target === undefined ? { state: { ...state, pendingKey: null }, effects: [] } : moveCursorToDiffRow(state, target);
}

function moveCursorToRow(state: AppState, row: number, viewportRows: number, extendSelection: boolean): { state: AppState; effects: Effect[] } {
  const rowCount = diffRowCount(state);
  if (rowCount === 0) return { state, effects: [] };
  const next = diffRow(clamp(row, 0, rowCount - 1));
  const visualMap = currentDiffVisualMap(state);
  const selection = extendSelection
    ? { anchor: state.selection?.anchor ?? state.cursorRow, head: next }
    : null;
  return {
    state: {
      ...state,
      focusedPane: "diff",
      mode: extendSelection ? { kind: "visual" } : { kind: "normal" },
      cursorRow: next,
      selection,
      scrollTop: {
        ...state.scrollTop,
        diff: scrollTopForLogicalRow(Number(next), visualMap, state.scrollTop.diff, viewportRows)
      }
    },
    effects: []
  };
}

function selectFile(state: AppState, delta: number): { state: AppState; effects: Effect[] } {
  if (state.files.length === 0) return { state, effects: [] };
  const next = clamp(state.selectedFile + delta, 0, state.files.length - 1);
  return selectFileAt(state, next, viewportRows(state));
}

function selectFileAt(state: AppState, index: number, viewportRows: number): { state: AppState; effects: Effect[] } {
  if (state.files.length === 0) return { state, effects: [] };
  const next = clamp(index, 0, state.files.length - 1);
  const treeRow = treeRowForFileIndex(state.files, next) ?? next;
  return {
    state: {
      ...state,
      selectedFile: next,
      focusedPane: "tree",
      patchIdx: 0,
      followLatestPatch: false,
      patchLanding: null,
      cursorRow: diffRow(0),
      selection: null,
      scrollTop: { ...state.scrollTop, diff: 0, tree: scrollTopFor(treeRow, state.scrollTop.tree, viewportRows) }
    },
    effects: []
  };
}

function selectPatch(state: AppState, delta: number): { state: AppState; effects: Effect[] } {
  if (state.view !== "history") return { state, effects: [] };
  const file = state.files[state.selectedFile];
  if (!file) return { state, effects: [] };
  if (state.dataset.source.kind === "session" && state.historyEntries.length === 0) {
    const timeline = patchTimeline(state.patches);
    if (timeline.ordered.length === 0) return { state, effects: [] };
    const position = sessionPatchPosition(state);
    const current = position?.index ?? (delta > 0 ? -1 : timeline.ordered.length);
    const target = clamp(current + delta, 0, timeline.ordered.length - 1);
    if (position !== null && target === current) return { state, effects: [] };
    return { state: selectSessionPatchAt(state, target, false, false), effects: [] };
  }
  const count = historyCountForFile(state, file.row.id);
  if (count === 0) return { state, effects: [] };
  return {
    state: {
      ...state,
      patchIdx: clamp(state.patchIdx + delta, 0, count - 1),
      followLatestPatch: false,
      cursorRow: diffRow(0),
      scrollTop: { ...state.scrollTop, diff: 0 }
    },
    effects: []
  };
}

function followLatestPatch(state: AppState): { state: AppState; effects: Effect[] } {
  if (state.dataset.source.kind !== "session" || state.historyEntries.length > 0) {
    return { state: { ...state, statusMessage: "Follow latest is available for session patches" }, effects: [] };
  }
  return { state: selectLatestSessionPatch({ ...state, view: "history" }, true, false), effects: [] };
}

function selectLatestSessionPatch(state: AppState, following: boolean, animate: boolean): AppState {
  const timeline = patchTimeline(state.patches);
  if (timeline.ordered.length === 0) {
    return {
      ...state,
      view: "history",
      followLatestPatch: following,
      patchLanding: null,
      statusMessage: following ? "Following latest patch; waiting for the first patch" : state.statusMessage
    };
  }
  return selectSessionPatchAt(state, timeline.ordered.length - 1, following, animate);
}

function selectSessionPatchAt(state: AppState, index: number, following: boolean, animate: boolean): AppState {
  const timeline = patchTimeline(state.patches);
  const targetIndex = clamp(index, 0, Math.max(0, timeline.ordered.length - 1));
  const patch = timeline.ordered[targetIndex];
  if (!patch) return { ...state, followLatestPatch: following };
  const selectedFile = state.files.findIndex((file) => file.row.id === patch.fileId);
  if (selectedFile < 0) {
    return { ...state, followLatestPatch: false, statusMessage: `Patch ${patch.seq} file is no longer tracked` };
  }
  const treeRow = treeRowForFileIndex(state.files, selectedFile) ?? selectedFile;
  const patchIdx = timeline.localIndexById.get(patch.id) ?? 0;
  let next: AppState = {
    ...state,
    selectedFile,
    focusedPane: "diff",
    view: "history",
    patchIdx,
    followLatestPatch: following,
    patchLanding: animate ? { patchId: patch.id, phase: 0 } : null,
    cursorRow: diffRow(0),
    selection: null,
    scrollTop: {
      tree: scrollTopFor(treeRow, state.scrollTop.tree, viewportRows(state)),
      diff: 0
    },
    statusMessage: `${following ? "Following" : "Patch"} ${targetIndex + 1}/${timeline.ordered.length}`
  };
  const selectedFileState = next.files[selectedFile];
  if (!selectedFileState) return next;
  const snapshot = buildPatchFileSnapshot(selectedFileState, next.patches, patchIdx);
  if (snapshot.kind !== "snapshot") return next;
  const logicalRow = snapshot.value.landingLine;
  next = { ...next, cursorRow: diffRow(logicalRow) };
  const map = currentDiffVisualMap(next);
  const visualRow = visualStartForLogicalRow(map, logicalRow);
  const visibleRows = viewportRows(next);
  const maxScroll = Math.max(0, map.visualRowCount - visibleRows);
  return {
    ...next,
    scrollTop: {
      ...next.scrollTop,
      diff: clamp(visualRow - Math.floor(visibleRows / 3), 0, maxScroll)
    }
  };
}

export function sessionPatchPosition(
  state: AppState
): { index: number; total: number; following: boolean } | null {
  if (state.view !== "history" || state.dataset.source.kind !== "session" || state.historyEntries.length > 0) return null;
  const file = state.files[state.selectedFile];
  if (!file) return null;
  const timeline = patchTimeline(state.patches);
  const patch = timeline.byFile.get(file.row.id)?.[state.patchIdx];
  if (!patch) return null;
  const index = timeline.globalIndexById.get(patch.id);
  return index === undefined ? null : { index, total: timeline.ordered.length, following: state.followLatestPatch };
}

function patchTimeline(patches: readonly PatchRecord[]): PatchTimeline {
  const cached = patchTimelineCache.get(patches);
  if (cached) return cached;
  const ordered = [...patches].sort((left, right) => Number(left.seq) - Number(right.seq) || Number(left.id) - Number(right.id));
  const byFile = new Map<FileId, PatchRecord[]>();
  const globalIndexById = new Map<PatchId, number>();
  const localIndexById = new Map<PatchId, number>();
  ordered.forEach((patch, globalIndex) => {
    const filePatches = byFile.get(patch.fileId) ?? [];
    localIndexById.set(patch.id, filePatches.length);
    filePatches.push(patch);
    byFile.set(patch.fileId, filePatches);
    globalIndexById.set(patch.id, globalIndex);
  });
  const timeline = { ordered, byFile, globalIndexById, localIndexById };
  patchTimelineCache.set(patches, timeline);
  return timeline;
}

export function draftForCursor(state: AppState): AnnotationDraft | null {
  if (state.view !== "cumulative") return null;
  const file = state.files[state.selectedFile];
  if (!file) return null;
  const model = cumulativeDiffModel(file, state.expandedFiles.has(file.row.id));
  const range = selectedRange(state);
  const rows = model.rows.slice(range.start, range.end + 1);
  const anchorRange = anchorRangeForSelection(model.rows, range, rows);
  if (!anchorRange) return null;
  const start = currentLine(anchorRange.start);
  const end = currentLine(anchorRange.end);
  if (!start.ok || !end.ok) return null;
  return {
    fileId: file.row.id,
    anchor: {
      patchId: newestPatchId(state, file.row.id),
      hash: file.currentHash,
      start: currentToAnchor(start.value, { kind: "fresh" }),
      end: currentToAnchor(end.value, { kind: "fresh" })
    },
    snippet: rows.map(rowText).join("\n")
  };
}

function anchorRangeForSelection(
  modelRows: readonly DiffModelRow[],
  range: { start: number; end: number },
  selectedRows: readonly DiffModelRow[]
): { start: number; end: number } | null {
  if (selectedRows.every((row) => row.kind === "hunk" || row.kind === "collapsed")) return null;
  const currentRows = selectedRows.filter(hasCurrentLine);
  const first = currentRows[0]?.newLine;
  if (first !== undefined) {
    const last = currentRows[currentRows.length - 1]?.newLine ?? first;
    return { start: Number(first), end: Number(last) };
  }

  const preceding = nearestCurrentLineBefore(modelRows, range.start);
  if (preceding !== null) return { start: preceding, end: preceding };
  const following = nearestCurrentLineAfter(modelRows, range.end);
  return following === null ? null : { start: following, end: following };
}

function nearestCurrentLineBefore(rows: readonly DiffModelRow[], index: number): number | null {
  for (let row = index - 1; row >= 0; row--) {
    const candidate = rows[row];
    if (candidate && hasCurrentLine(candidate)) return Number(candidate.newLine);
  }
  return null;
}

function nearestCurrentLineAfter(rows: readonly DiffModelRow[], index: number): number | null {
  for (let row = index + 1; row < rows.length; row++) {
    const candidate = rows[row];
    if (candidate && hasCurrentLine(candidate)) return Number(candidate.newLine);
  }
  return null;
}

function selectedAnnotation(state: AppState): Annotation | null {
  return state.annotations[clamp(state.annotationCursor, 0, state.annotations.length - 1)] ?? null;
}

function jumpToSelectedAnnotation(state: AppState): { state: AppState; effects: Effect[] } {
  const annotation = selectedAnnotation(state);
  if (!annotation) return { state, effects: [] };
  const fileIndex = state.files.findIndex((file) => file.row.id === annotation.fileId);
  if (fileIndex < 0) return { state: { ...state, statusMessage: "Annotation file is no longer tracked" }, effects: [] };
  if (!annotationIsFresh(state, annotation)) {
    const file = state.files[fileIndex];
    const automatic = automaticReanchorSelectedAnnotation(state, annotation, file);
    const draft = automatic.kind === "planned" ? automatic.draft : bestGuessDraftForAnnotation(state, file, annotation);
    const location = draft ? visibleAnchorLocation(state, fileIndex, draft.anchor) : null;
    if (location) {
      const positioned = {
        ...location.state,
        focusedPane: "diff" as const,
        mode: { kind: "normal" as const },
        cursorRow: diffRow(location.rowRange.start),
        selection: location.rowRange.start === location.rowRange.end
          ? null
          : { anchor: diffRow(location.rowRange.start), head: diffRow(location.rowRange.end) },
        statusMessage: `Jumped to stale annotation #${annotation.id} best-guess location`
      };
      return {
        state: {
          ...positioned,
          scrollTop: {
            ...positioned.scrollTop,
            diff: diffScrollTopForLogicalRow(positioned, location.rowRange.start)
          }
        },
        effects: []
      };
    }
    return {
      state: { ...state, selectedFile: fileIndex, mode: { kind: "normal" }, statusMessage: "Annotation is stale; re-anchor before exact jump" },
      effects: []
    };
  }
  const location = visibleAnchorLocation(state, fileIndex, annotation.anchor);
  if (!location) {
    return {
      state: { ...state, selectedFile: fileIndex, mode: { kind: "normal" }, statusMessage: "Annotation anchor is not visible in current diff" },
      effects: []
    };
  }
  const positioned = {
    ...location.state,
    focusedPane: "diff" as const,
    mode: { kind: "normal" as const },
    cursorRow: diffRow(location.rowRange.start),
    selection: location.rowRange.start === location.rowRange.end
      ? null
      : { anchor: diffRow(location.rowRange.start), head: diffRow(location.rowRange.end) },
    statusMessage: `Jumped to annotation #${annotation.id}`
  };
  return {
    state: {
      ...positioned,
      scrollTop: {
        ...positioned.scrollTop,
        diff: diffScrollTopForLogicalRow(positioned, location.rowRange.start)
      }
    },
    effects: []
  };
}

function reanchorSelectedAnnotation(state: AppState): { state: AppState; effects: Effect[] } {
  const annotation = selectedAnnotation(state);
  if (!annotation) return { state, effects: [] };
  if (annotation.state.kind === "sent") {
    return { state: { ...state, statusMessage: "Sent annotations cannot be re-anchored" }, effects: [] };
  }
  if (annotationIsFresh(state, annotation)) {
    return { state: { ...state, statusMessage: "Annotation is already fresh" }, effects: [] };
  }
  if (state.view !== "cumulative") {
    return { state: { ...state, statusMessage: "Switch to cumulative view before re-anchoring" }, effects: [] };
  }
  const fileIndex = state.files.findIndex((file) => file.row.id === annotation.fileId);
  if (fileIndex < 0) return { state: { ...state, statusMessage: "Annotation file is no longer tracked" }, effects: [] };
  if (fileIndex !== state.selectedFile) {
    return {
      state: {
        ...state,
        selectedFile: fileIndex,
        focusedPane: "diff",
        mode: { kind: "normal" },
        cursorRow: diffRow(0),
        selection: null,
        scrollTop: { ...state.scrollTop, diff: 0 },
        statusMessage: "Select the replacement range, reopen annotations, then press u"
      },
      effects: []
    };
  }
  if (state.selection) return manualReanchorSelectedAnnotation(state, annotation);
  const automatic = automaticReanchorSelectedAnnotation(state, annotation, state.files[fileIndex]);
  if (automatic.kind === "planned") {
    return {
      state: { ...state, statusMessage: `Re-anchoring annotation #${annotation.id}` },
      effects: [{ kind: "reanchorAnnotation", annotationId: annotation.id, anchor: automatic.draft.anchor, snippet: automatic.draft.snippet }]
    };
  }
  if (automatic.kind === "conflict") {
    return openConflictReanchorEditor(state, annotation, state.files[fileIndex], automatic.message);
  }
  return manualReanchorSelectedAnnotation(state, annotation);
}

function openConflictReanchorEditor(
  state: AppState,
  annotation: Annotation,
  file: FileState,
  message: string
): { state: AppState; effects: Effect[] } {
  const draft = bestGuessDraftForAnnotation(state, file, annotation);
  if (!draft) {
    return { state: { ...state, statusMessage: `${message}; select replacement range and press u` }, effects: [] };
  }
  const fileIndex = state.files.findIndex((candidate) => candidate.row.id === file.row.id);
  const location = fileIndex < 0 ? null : visibleAnchorLocation(state, fileIndex, draft.anchor);
  const base = location?.state ?? state;
  const rowRange = location?.rowRange ?? null;
  const positioned = {
    ...base,
    focusedPane: "diff" as const,
    mode: {
      kind: "comment" as const,
      target: { kind: "reanchor" as const, annotationId: annotation.id, draft, oldSnippet: annotation.snippet },
      initialText: annotation.comment,
      role: annotation.role
    },
    cursorRow: diffRow(rowRange?.start ?? Number(base.cursorRow)),
    selection: rowRange && rowRange.start !== rowRange.end
      ? { anchor: diffRow(rowRange.start), head: diffRow(rowRange.end) }
      : null,
    statusMessage: `${message}; adjust re-anchor and save`
  };
  return {
    state: {
      ...positioned,
      scrollTop: rowRange
        ? { ...positioned.scrollTop, diff: diffScrollTopForLogicalRow(positioned, rowRange.start) }
        : positioned.scrollTop
    },
    effects: []
  };
}

function manualReanchorSelectedAnnotation(state: AppState, annotation: Annotation): { state: AppState; effects: Effect[] } {
  const draft = draftForCursor(state);
  if (!draft || draft.fileId !== annotation.fileId) {
    return { state: { ...state, statusMessage: "Select a current-version line before re-anchoring" }, effects: [] };
  }
  return {
    state: {
      ...state,
      statusMessage: `Re-anchoring annotation #${annotation.id}`
    },
    effects: [{ kind: "reanchorAnnotation", annotationId: annotation.id, anchor: draft.anchor, snippet: draft.snippet }]
  };
}

function automaticReanchorSelectedAnnotation(
  state: AppState,
  annotation: Annotation,
  file: FileState
): { kind: "planned"; draft: AnnotationDraft } | { kind: "conflict"; message: string } | { kind: "manual" } {
  const filePatches = state.patches.filter((patch) => patch.fileId === annotation.fileId);
  const afterAnchor = patchesAfterAnchor(filePatches, annotation.anchor.patchId === null ? null : Number(annotation.anchor.patchId));
  if (!afterAnchor) return { kind: "conflict", message: "Anchor patch is no longer available" };
  const mapped = mapRangeThroughPatches({ start: Number(annotation.anchor.start), end: Number(annotation.anchor.end) }, afterAnchor);
  if (mapped.kind === "conflict") return { kind: "conflict", message: `Patch ${mapped.patch.seq} changed the annotated lines` };
  const headVersion = replayPatches(file.row.baseline, filePatches);
  if (!headVersion.ok) return { kind: "conflict", message: "Patch chain break requires manual re-anchor" };
  const currentRange =
    headVersion.value.hash === file.currentHash
      ? { kind: "mapped" as const, range: mapped.range }
      : mapRangeThroughExternalText(mapped.range, headVersion.value.content, file.current ?? "");
  if (currentRange.kind === "conflict") return currentRange;
  const draft = draftForCurrentLineRange(state, file, currentRange.range);
  return draft ? { kind: "planned", draft } : { kind: "manual" };
}

function mapRangeThroughExternalText(
  range: LineRange,
  headContent: string,
  currentContent: string
): { kind: "mapped"; range: LineRange } | { kind: "conflict"; message: string } {
  const mapped = mapRangeThroughTexts(range, headContent, currentContent);
  if (mapped.kind === "mapped") return mapped;
  return { kind: "conflict", message: "External edits changed the annotated lines" };
}

function draftForCurrentLineRange(state: AppState, file: FileState, range: LineRange): AnnotationDraft | null {
  const start = currentLine(range.start);
  const end = currentLine(range.end);
  if (!start.ok || !end.ok) return null;
  return {
    fileId: file.row.id,
    anchor: {
      patchId: newestPatchId(state, file.row.id),
      hash: file.currentHash,
      start: currentToAnchor(start.value, { kind: "fresh" }),
      end: currentToAnchor(end.value, { kind: "fresh" })
    },
    snippet: currentSnippet(file.current ?? "", range)
  };
}

function bestGuessDraftForAnnotation(state: AppState, file: FileState, annotation: Annotation): AnnotationDraft | null {
  const lineCount = Math.max(1, splitContentLines(file.current ?? "").length);
  const start = clamp(Number(annotation.anchor.start), 1, lineCount);
  const end = clamp(Number(annotation.anchor.end), start, lineCount);
  return draftForCurrentLineRange(state, file, { start, end });
}

function currentSnippet(content: string, range: LineRange): string {
  return splitContentLines(content).slice(range.start - 1, range.end).join("\n");
}

function splitContentLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
}

function visibleAnchorLocation(
  state: AppState,
  fileIndex: number,
  anchor: Anchor
): { state: AppState; rowRange: { start: number; end: number } } | null {
  const file = state.files[fileIndex];
  if (!file) return null;
  const expanded = state.expandedFiles.has(file.row.id);
  let rowRange = diffRowsForAnchor(file, anchor, expanded);
  let expandedFiles = state.expandedFiles;
  if (!rowRange && !expanded) {
    rowRange = diffRowsForAnchor(file, anchor, true);
    if (rowRange) expandedFiles = new Set([...state.expandedFiles, file.row.id]);
  }
  if (!rowRange) return null;
  return {
    state: { ...state, selectedFile: fileIndex, view: "cumulative", expandedFiles },
    rowRange
  };
}

function diffRowsForAnchor(file: FileState, anchor: Anchor, expanded: boolean): { start: number; end: number } | null {
  const model = cumulativeDiffModel(file, expanded);
  const matching = model.rows
    .map((row, index) => ("newLine" in row && Number(row.newLine) >= Number(anchor.start) && Number(row.newLine) <= Number(anchor.end) ? index : null))
    .filter((index): index is number => index !== null);
  if (matching.length === 0) return null;
  return { start: matching[0], end: matching[matching.length - 1] };
}

export function selectedRange(state: AppState): { start: number; end: number } {
  if (!state.selection) {
    const row = Number(state.cursorRow);
    return { start: row, end: row };
  }
  const a = Number(state.selection.anchor);
  const b = Number(state.selection.head);
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

function newestPatchId(state: AppState, fileId: FileId): PatchId | null {
  const patches = state.patches.filter((patch) => patch.fileId === fileId);
  return patches.length === 0 ? null : patches[patches.length - 1].id;
}

function rowText(row: DiffModelRow): string {
  switch (row.kind) {
    case "hunk":
    case "collapsed":
      return row.text;
    case "add":
    case "del":
    case "context":
      return row.text;
  }
}

function hasCurrentLine(row: DiffModelRow): row is Extract<DiffModelRow, { newLine: unknown }> {
  return "newLine" in row;
}

function diffRowCount(state: AppState): number {
  return currentDiffVisualMap(state).logicalRowCount;
}

export function currentDiffVisualMap(
  state: AppState,
  cols: number = state.viewport.cols,
  rows: number = state.viewport.rows
): DiffVisualMap {
  const file = state.files[state.selectedFile];
  if (!file) return { starts: [0], logicalRowCount: 0, visualRowCount: 0 };
  const layout = computeFrameLayout(cols, rows);
  const fileHistory = state.historyEntries.filter((entry) => entry.fileId === file.row.id);
  const historyIndex = Math.max(0, Math.min(state.patchIdx, Math.max(0, fileHistory.length - 1)));
  const historyEntry = fileHistory.length === 0
    ? null
    : { entry: fileHistory[historyIndex], index: historyIndex, total: fileHistory.length };
  return buildDiffPaneVisualMap(file, state.patches, {
    view: state.view,
    renderMode: state.renderMode,
    patchIdx: state.patchIdx,
    historyEntry,
    width: layout.diffWidth,
    showProvenance: state.dataset.source.kind === "session",
    expanded: state.expandedFiles.has(file.row.id),
    wrapLines: state.wrapLines
  });
}

function currentDiffRows(state: AppState): DiffModelRow[] {
  const file = state.files[state.selectedFile];
  if (!file) return [];
  if (state.view === "history") {
    const history = state.historyEntries.filter((entry) => entry.fileId === file.row.id);
    if (history.length > 0) {
      const entry = history[Math.max(0, Math.min(state.patchIdx, history.length - 1))];
      return entry ? entry.displayDiff.split("\n").map((text) => ({ kind: "hunk" as const, text })) : [];
    }
    if (state.dataset.source.kind === "session") {
      const snapshot = buildPatchFileSnapshot(file, state.patches, state.patchIdx);
      if (snapshot.kind === "snapshot") {
        return [
          { kind: "hunk", text: "patch file snapshot" },
          ...snapshot.value.lines.map((text) => ({ kind: "hunk" as const, text }))
        ];
      }
      return [{ kind: "hunk", text: snapshot.kind === "empty" ? "No recorded patches" : snapshot.message }];
    }
    const patches = state.patches.filter((patch) => patch.fileId === file.row.id);
    const patch = patches[Math.max(0, Math.min(state.patchIdx, patches.length - 1))];
    return patch ? [{ kind: "hunk", text: "patch header" }, ...patch.displayDiff.split("\n").map((text) => ({ kind: "hunk" as const, text }))] : [];
  }
  return cumulativeDiffModel(file, state.expandedFiles.has(file.row.id)).rows;
}

function historyCountForFile(state: AppState, fileId: FileId): number {
  const entries = state.historyEntries.filter((entry) => entry.fileId === fileId);
  return entries.length > 0 ? entries.length : state.patches.filter((patch) => patch.fileId === fileId).length;
}

function scrollPane(state: AppState, pane: "tree" | "diff", delta: number, viewportRows: number): { state: AppState; effects: Effect[] } {
  const visibleRows = Math.max(1, viewportRows);
  const maxScroll =
    pane === "tree"
      ? Math.max(0, fileTreeRowCount(state.files) - visibleRows)
      : Math.max(0, currentDiffVisualMap(state).visualRowCount - visibleRows);
  return {
    state: {
      ...state,
      focusedPane: pane,
      scrollTop: { ...state.scrollTop, [pane]: clamp(state.scrollTop[pane] + delta, 0, maxScroll) }
    },
    effects: []
  };
}

function scrollTopFor(row: number, current: number, viewportRows: number): number {
  const visibleRows = Math.max(1, viewportRows);
  if (row < current) return row;
  if (row >= current + visibleRows) return Math.max(0, row - visibleRows + 1);
  return current;
}

function scrollTopForLogicalRow(
  logicalRow: number,
  map: DiffVisualMap,
  current: number,
  viewportRows: number
): number {
  const visibleRows = Math.max(1, viewportRows);
  const start = visualStartForLogicalRow(map, logicalRow);
  const end = visualEndForLogicalRow(map, logicalRow);
  if (end < current) return start;
  if (start >= current + visibleRows) return start;
  return current;
}

function diffScrollTopForLogicalRow(state: AppState, logicalRow: number): number {
  return scrollTopForLogicalRow(
    logicalRow,
    currentDiffVisualMap(state),
    state.scrollTop.diff,
    viewportRows(state)
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function assertNever(value: never): never {
  throw new Error(`unhandled state variant: ${JSON.stringify(value)}`);
}

export function fileFreshnessMap(state: AppState): Map<FileId, ContentHash> {
  return new Map(state.files.map((file) => [file.row.id, file.currentHash]));
}

export function contentHashForCurrent(content: string | null): ContentHash {
  return hashContent(content ?? "");
}

export function viewportFromSize(cols: number, rows: number): AppState["viewport"] {
  const layout = computeFrameLayout(cols, rows);
  return { cols: layout.columns, rows: layout.rows, bodyRows: layout.bodyRows };
}

function viewportRows(state: AppState): number {
  return Math.max(1, state.viewport.bodyRows);
}

function halfPageRows(state: AppState): number {
  return Math.max(1, Math.floor(viewportRows(state) / 2));
}

function clampScroll(state: AppState): AppState {
  const rows = viewportRows(state);
  return {
    ...state,
    scrollTop: {
      tree: clamp(state.scrollTop.tree, 0, Math.max(0, fileTreeRowCount(state.files) - rows)),
      diff: clamp(state.scrollTop.diff, 0, Math.max(0, currentDiffVisualMap(state).visualRowCount - rows))
    }
  };
}

export function fileStateFromContent(row: FileRecord, current: string | null): FileState {
  const baselineContent = row.baseline.kind === "present" ? row.baseline.content : "";
  const model = buildDiffModel(baselineContent, current ?? "", row.relPath);
  const file: FileState = {
    row,
    current,
    currentHash: contentHashForCurrent(current),
    additions: model.additions,
    deletions: model.deletions
  };
  cumulativeDiffModelCache.set(file, model);
  return file;
}

function cumulativeDiffModel(file: FileState, expanded = false): DiffModel {
  const cache = expanded ? expandedDiffModelCache : cumulativeDiffModelCache;
  const cached = cache.get(file);
  if (cached) return cached;
  const baseline = file.row.baseline.kind === "present" ? file.row.baseline.content : "";
  const model = buildDiffModel(baseline, file.current ?? "", file.row.relPath, { context: expanded ? "full" : "patches" });
  cache.set(file, model);
  return model;
}

export function annotationIsFresh(state: AppState, annotation: Annotation): boolean {
  const file = state.files.find((candidate) => candidate.row.id === annotation.fileId);
  return file?.currentHash === annotation.anchor.hash;
}
