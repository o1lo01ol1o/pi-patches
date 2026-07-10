import { existsSync, readFileSync } from "node:fs";
import {
  err,
  errorMessage,
  annotationId,
  fileId,
  baselineFromContent,
  type Annotation,
  type AnalysisRun,
  type FileRecord,
  type PatchRecord,
  type PatchStore,
  type Result,
  type ReviewDataset,
  type ReviewDocument,
  type SourceNote,
  type SessionRecord
} from "@pi-patches/store";
import { ok } from "@pi-patches/store";
import { detectColorDepth, detectTintTheme } from "./render/ansi.ts";
import { diffRow } from "./render/coords.ts";
import { buildDatasetHistoryEntries } from "./render/dataset-history.ts";
import { fileStateFromContent, update, viewportFromSize, type AppState, type DbSnapshot } from "./state.ts";
import { materializeSessionSource } from "./sources/session.ts";

export function loadAppState(store: PatchStore, session: SessionRecord): Result<AppState> {
  const snapshot = loadDbSnapshot(store, session);
  if (!snapshot.ok) return snapshot;
  const dataset = materializeSessionSource(store, session, "squashed");
  if (!dataset.ok) return dataset;
  const runs = store.listAnalysisRuns(dataset.value.fingerprint);
  if (!runs.ok) return runs;
  return ok({
    session,
    dataset: dataset.value,
    activeTab: "diff",
    analysisRuns: runs.value,
    selectedAnalysisRun: { narrative: 0, implementationReview: 0 },
    analysisScroll: { notes: 0, narrative: 0, review: 0 },
    reviewGuidelines: null,
    historyEntries: [],
    files: snapshot.value.files,
    patches: snapshot.value.patches,
    annotations: snapshot.value.annotations,
    viewport: viewportFromSize(80, 24),
    selectedFile: 0,
    focusedPane: "tree",
    view: "cumulative",
    renderMode: "syntax",
    wrapLines: true,
    tintMode: "gradient",
    colorDepth: detectColorDepth(process.env),
    tintTheme: detectTintTheme(process.env),
    patchIdx: 0,
    cursorRow: diffRow(0),
    annotationCursor: 0,
    scrollTop: { tree: 0, diff: 0 },
    pendingKey: null,
    mode: { kind: "normal" },
    selection: null,
    statusMessage: null
  });
}

export function loadDatasetAppState(store: PatchStore, session: SessionRecord, dataset: ReviewDataset): Result<AppState> {
  if (dataset.source.kind === "session" && dataset.source.sessionId === session.id) return loadAppState(store, session);
  const files = datasetFiles(session, dataset.documents);
  if (!files.ok) return files;
  const annotations = loadSourceAnnotations(store, dataset, files.value);
  if (!annotations.ok) return annotations;
  const runs = store.listAnalysisRuns(dataset.fingerprint);
  if (!runs.ok) return runs;
  return ok({
    session,
    dataset,
    activeTab: "diff",
    analysisRuns: runs.value,
    selectedAnalysisRun: { narrative: 0, implementationReview: 0 },
    analysisScroll: { notes: 0, narrative: 0, review: 0 },
    reviewGuidelines: null,
    historyEntries: buildDatasetHistoryEntries(dataset, files.value),
    files: files.value,
    patches: [],
    annotations: annotations.value,
    viewport: viewportFromSize(80, 24),
    selectedFile: 0,
    focusedPane: "tree",
    view: "cumulative",
    renderMode: "syntax",
    wrapLines: true,
    tintMode: "gradient",
    colorDepth: detectColorDepth(process.env),
    tintTheme: detectTintTheme(process.env),
    patchIdx: 0,
    cursorRow: diffRow(0),
    annotationCursor: 0,
    scrollTop: { tree: 0, diff: 0 },
    pendingKey: null,
    mode: { kind: "normal" },
    selection: null,
    statusMessage: null
  });
}

export function loadSourceAnnotations(
  store: PatchStore,
  dataset: ReviewDataset,
  files: AppState["files"]
): Result<Annotation[]> {
  const notes = store.getSourceNotes(dataset.fingerprint);
  if (!notes.ok) return notes;
  const fileByPath = new Map(files.map((file) => [file.row.relPath, file.row.id]));
  const annotations: Annotation[] = [];
  for (const note of notes.value) {
    const file = fileByPath.get(note.relPath);
    if (file === undefined) {
      return err({
        kind: "CorruptRow",
        table: "source_notes",
        id: Number(note.id),
        field: "document_id",
        message: "note document is absent from its source fingerprint"
      });
    }
    const id = annotationId(Number(note.id));
    if (!id.ok) return id;
    annotations.push(sourceNoteAnnotation(note, id.value, file));
  }
  return ok(annotations);
}

function sourceNoteAnnotation(note: SourceNote, id: Annotation["id"], fileId: Annotation["fileId"]): Annotation {
  return {
    id,
    sessionId: note.targetSessionId,
    fileId,
    anchor: { patchId: null, hash: note.anchor.hash, start: note.anchor.start, end: note.anchor.end },
    snippet: note.snippet,
    comment: note.comment,
    role: note.role,
    state: note.state,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}

export function refreshAppState(previous: AppState, store: PatchStore): Result<AppState> {
  const snapshot = loadDbSnapshot(store, previous.session);
  if (!snapshot.ok) return snapshot;
  return ok(update(previous, { kind: "dbChanged", snapshot: snapshot.value }).state);
}

export function renderReadOnly(state: AppState): string {
  const lines: string[] = [];
  lines.push(`pi-review session ${state.session.id}`);
  lines.push(`${state.files.length} files, ${state.patches.length} patches, ${state.annotations.length} annotations`);
  lines.push("");
  for (const file of state.files) {
    const missing = file.current === null ? " (missing)" : "";
    lines.push(`${file.row.relPath}${missing}  +${file.additions} -${file.deletions}`);
  }
  if (state.files.length === 0) lines.push("No tracked edits yet.");
  return lines.join("\n");
}

function datasetFiles(session: SessionRecord, documents: readonly ReviewDocument[]): Result<AppState["files"]> {
  const files: AppState["files"] = [];
  for (let index = 0; index < documents.length; index++) {
    const document = documents[index];
    const id = fileId(index + 1);
    if (!id.ok) return id;
    const contents = displayContents(document);
    const row: FileRecord = {
      id: id.value,
      sessionId: session.id,
      path: document.path,
      relPath: document.relPath,
      baseline: baselineFromContent(contents.baseline),
      firstTouchedAt: session.startedAt,
      firstTool: contents.baseline === null ? "write" : "edit"
    };
    files.push(fileStateFromContent(row, contents.head));
  }
  return ok(files);
}

function displayContents(document: ReviewDocument): { baseline: string | null; head: string | null } {
  if (document.kind === "text") {
    return {
      baseline: document.baseline.kind === "present" ? document.baseline.content : null,
      head: document.head.content
    };
  }
  const baseline = document.baseline.kind === "present"
    ? `[${document.kind} baseline ${document.baseline.hash}]\n`
    : null;
  const head = document.head.present ? `[${document.kind} head ${document.head.hash}]\n` : null;
  return { baseline, head };
}

export function explainResult<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(errorMessage(result.error));
}

export function loadDbSnapshot(store: PatchStore, session: SessionRecord): Result<DbSnapshot> {
  const files = store.getFiles(session.id);
  if (!files.ok) return files;
  const patches = store.getPatches(session.id);
  if (!patches.ok) return patches;
  const annotations = store.getAnnotations(session.id);
  if (!annotations.ok) return annotations;
  const pathByFile = new Map(files.value.map((file) => [file.id, file.relPath]));
  const fileStates: DbSnapshot["files"] = [];
  for (const file of files.value) {
    const current = readCurrentFile(file.path);
    if (!current.ok) return current;
    fileStates.push(fileStateFromContent(file, current.value));
  }
  return ok({
    files: fileStates,
    patches: patches.value,
    annotations: [...annotations.value].sort((left, right) => {
      const byRole = annotationRoleRank(left) - annotationRoleRank(right);
      if (byRole !== 0) return byRole;
      const byPath = (pathByFile.get(left.fileId) ?? "").localeCompare(pathByFile.get(right.fileId) ?? "");
      if (byPath !== 0) return byPath;
      const byLine = Number(left.anchor.start) - Number(right.anchor.start);
      return byLine !== 0 ? byLine : Number(left.id) - Number(right.id);
    })
  });
}

function annotationRoleRank(annotation: Annotation): number {
  if (annotation.role.kind === "callout") return 5;
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[annotation.role.priority] + (annotation.role.audience === "human" ? 0.25 : 0);
}

export function readCurrentFile(path: string): Result<string | null> {
  try {
    return ok(existsSync(path) ? readFileSync(path, "utf8") : null);
  } catch (error) {
    if (isMissingFileError(error)) return ok(null);
    return err({ kind: "Io", path, message: error instanceof Error ? error.message : String(error) });
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export type { Annotation, FileRecord, PatchRecord };
export type { AppState } from "./state.ts";
