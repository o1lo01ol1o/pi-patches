import { createHash } from "node:crypto";
import { err, errorMessage, ok, type Result } from "./errors.ts";
import { isPriority, type ReviewNoteRole } from "./review.ts";

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type BatchId = Brand<string, "BatchId">;
export type ContentHash = Brand<string, "ContentHash">;
export type Seq = Brand<number, "Seq">;
export type PatchId = Brand<number, "PatchId">;
export type FileId = Brand<number, "FileId">;
export type AnnotationId = Brand<number, "AnnotationId">;
export type BaselineLine = Brand<number, "BaselineLine">;
export type CurrentLine = Brand<number, "CurrentLine">;
export type AnchorLine = Brand<number, "AnchorLine">;
export type DiffRow = Brand<number, "DiffRow">;

export type ToolName = "edit" | "write";

export type Baseline =
  | { kind: "absent" }
  | { kind: "present"; content: string; hash: ContentHash };

export type AnnotationState =
  | { kind: "draft" }
  | { kind: "queued" }
  | { kind: "sent"; sentAt: number; batchId: BatchId };

export type Anchor = {
  patchId: PatchId | null;
  hash: ContentHash;
  start: AnchorLine;
  end: AnchorLine;
};

export type Freshness =
  | { kind: "fresh" }
  | { kind: "stale"; anchorSeq: Seq | 0; headSeq: Seq | 0; external: boolean };

export type SessionRecord = {
  id: SessionId;
  cwd: string;
  sessionFile: string | null;
  parentSessionId: SessionId | null;
  startedAt: number;
  lastEventAt: number | null;
  endedAt: number | null;
};

export type FileRecord = {
  id: FileId;
  sessionId: SessionId;
  path: string;
  relPath: string;
  baseline: Baseline;
  firstTouchedAt: number;
  firstTool: ToolName;
};

export type PatchRecord = {
  id: PatchId;
  sessionId: SessionId;
  fileId: FileId;
  seq: Seq;
  tool: ToolName;
  toolCallId: string | null;
  unifiedPatch: string;
  displayDiff: string;
  firstChangedLine: number | null;
  preHash: ContentHash | null;
  postHash: ContentHash;
  createdAt: number;
};

export type Annotation = {
  id: AnnotationId;
  sessionId: SessionId;
  fileId: FileId;
  anchor: Anchor;
  snippet: string;
  comment: string;
  role: ReviewNoteRole;
  state: AnnotationState;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedAnnotation = Annotation & {
  file: Pick<FileRecord, "id" | "path" | "relPath">;
  anchorSeq: Seq | 0;
  fixIntent: boolean;
  checkDisk: true;
};

type Row = Record<string, unknown>;

export type SessionRow = {
  id: string;
  cwd: string;
  session_file: string | null;
  parent_session_id: string | null;
  started_at: number;
  last_event_at: number | null;
  ended_at: number | null;
};

export type FileRow = {
  id: number;
  session_id: string;
  path: string;
  rel_path: string;
  baseline_content: string | null;
  baseline_hash: string | null;
  baseline_missing: 0 | 1;
  first_touched_at: number;
  first_tool: ToolName;
};

export type PatchRow = {
  id: number;
  session_id: string;
  file_id: number;
  seq: number;
  tool: ToolName;
  tool_call_id: string | null;
  unified_patch: string;
  display_diff: string;
  first_changed_line: number | null;
  pre_hash: string | null;
  post_hash: string | null;
  created_at: number;
};

export type AnnotationRow = {
  id: number;
  session_id: string;
  file_id: number;
  anchor_patch_id: number | null;
  anchor_hash: string;
  start_line: number;
  end_line: number;
  snippet: string;
  comment: string;
  kind: "finding" | "callout";
  priority: "P0" | "P1" | "P2" | "P3" | null;
  audience: "agent" | "human";
  fix_intent: 0 | 1;
  status: "draft" | "queued" | "sent";
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  batch_id: string | null;
};

export function hashContent(content: string): ContentHash {
  return createHash("sha256").update(content).digest("hex") as ContentHash;
}

export function hashBytes(content: Uint8Array): ContentHash {
  return createHash("sha256").update(content).digest("hex") as ContentHash;
}

export function sessionId(value: string): Result<SessionId> {
  const parsed = nonEmptyString("SessionId", value);
  return parsed.ok ? ok(parsed.value as SessionId) : err(parsed.error);
}

export function batchId(value: string): Result<BatchId> {
  const parsed = nonEmptyString("BatchId", value);
  return parsed.ok ? ok(parsed.value as BatchId) : err(parsed.error);
}

export function contentHash(value: string): Result<ContentHash> {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    return err({ kind: "InvalidInput", field: "ContentHash", message: "expected lowercase sha256 hex" });
  }
  return ok(value as ContentHash);
}

export function seq(value: number): Result<Seq> {
  const parsed = positiveInteger("Seq", value);
  return parsed.ok ? ok(parsed.value as Seq) : err(parsed.error);
}

export function patchId(value: number): Result<PatchId> {
  const parsed = positiveInteger("PatchId", value);
  return parsed.ok ? ok(parsed.value as PatchId) : err(parsed.error);
}

export function fileId(value: number): Result<FileId> {
  const parsed = positiveInteger("FileId", value);
  return parsed.ok ? ok(parsed.value as FileId) : err(parsed.error);
}

export function annotationId(value: number): Result<AnnotationId> {
  const parsed = positiveInteger("AnnotationId", value);
  return parsed.ok ? ok(parsed.value as AnnotationId) : err(parsed.error);
}

export function baselineLine(value: number): Result<BaselineLine> {
  const parsed = positiveInteger("BaselineLine", value);
  return parsed.ok ? ok(parsed.value as BaselineLine) : err(parsed.error);
}

export function currentLine(value: number): Result<CurrentLine> {
  const parsed = positiveInteger("CurrentLine", value);
  return parsed.ok ? ok(parsed.value as CurrentLine) : err(parsed.error);
}

export function anchorLine(value: number): Result<AnchorLine> {
  const parsed = positiveInteger("AnchorLine", value);
  return parsed.ok ? ok(parsed.value as AnchorLine) : err(parsed.error);
}

export function baselineFromContent(content: string | null): Baseline {
  return content === null ? { kind: "absent" } : { kind: "present", content, hash: hashContent(content) };
}

export function printSessionRow(session: SessionRecord): SessionRow {
  return {
    id: session.id,
    cwd: session.cwd,
    session_file: session.sessionFile,
    parent_session_id: session.parentSessionId,
    started_at: session.startedAt,
    last_event_at: session.lastEventAt,
    ended_at: session.endedAt
  };
}

export function printFileRow(file: FileRecord): FileRow {
  const baseline = baselineDbFields(file.baseline);
  return {
    id: file.id,
    session_id: file.sessionId,
    path: file.path,
    rel_path: file.relPath,
    baseline_content: baseline.baselineContent,
    baseline_hash: baseline.baselineHash,
    baseline_missing: baseline.baselineMissing,
    first_touched_at: file.firstTouchedAt,
    first_tool: file.firstTool
  };
}

export function printPatchRow(patch: PatchRecord): PatchRow {
  return {
    id: patch.id,
    session_id: patch.sessionId,
    file_id: patch.fileId,
    seq: patch.seq,
    tool: patch.tool,
    tool_call_id: patch.toolCallId,
    unified_patch: patch.unifiedPatch,
    display_diff: patch.displayDiff,
    first_changed_line: patch.firstChangedLine,
    pre_hash: patch.preHash,
    post_hash: patch.postHash,
    created_at: patch.createdAt
  };
}

export function printAnnotationRow(annotation: Annotation): AnnotationRow {
  const state = annotationStatusDbFields(annotation.state);
  const role = annotationRoleDbFields(annotation.role);
  return {
    id: annotation.id,
    session_id: annotation.sessionId,
    file_id: annotation.fileId,
    anchor_patch_id: annotation.anchor.patchId,
    anchor_hash: annotation.anchor.hash,
    start_line: annotation.anchor.start,
    end_line: annotation.anchor.end,
    snippet: annotation.snippet,
    comment: annotation.comment,
    kind: role.kind,
    priority: role.priority,
    audience: role.audience,
    fix_intent: 0,
    status: state.status,
    created_at: annotation.createdAt,
    updated_at: annotation.updatedAt,
    sent_at: state.sentAt,
    batch_id: state.batchId
  };
}

export function parseSessionRow(row: unknown): Result<SessionRecord> {
  const record = asRow(row);
  if (!record.ok) return record;
  const id = readSessionId(record.value, "id", "sessions");
  const cwd = readString(record.value, "cwd", "sessions", null, true);
  const sessionFile = readNullableString(record.value, "session_file", "sessions", null);
  const parent = readNullable(record.value, "parent_session_id", (value) =>
    readSessionIdValue(value, "parent_session_id", "sessions", null)
  );
  const startedAt = readInteger(record.value, "started_at", "sessions", null);
  const lastEventAt = readNullableInteger(record.value, "last_event_at", "sessions", null);
  const endedAt = readNullableInteger(record.value, "ended_at", "sessions", null);
  if (!id.ok) return id;
  if (!cwd.ok) return cwd;
  if (!sessionFile.ok) return sessionFile;
  if (!parent.ok) return parent;
  if (!startedAt.ok) return startedAt;
  if (!lastEventAt.ok) return lastEventAt;
  if (!endedAt.ok) return endedAt;
  return ok({
    id: id.value,
    cwd: cwd.value,
    sessionFile: sessionFile.value,
    parentSessionId: parent.value,
    startedAt: startedAt.value,
    lastEventAt: lastEventAt.value,
    endedAt: endedAt.value
  });
}

export function parseFileRow(row: unknown): Result<FileRecord> {
  const record = asRow(row);
  if (!record.ok) return record;
  const id = readId(record.value, "id", "files", fileId);
  const session = readSessionId(record.value, "session_id", "files");
  const path = readString(record.value, "path", "files", readIdValue(record.value, "id"), true);
  const relPath = readString(record.value, "rel_path", "files", readIdValue(record.value, "id"), true);
  const firstTouchedAt = readInteger(record.value, "first_touched_at", "files", readIdValue(record.value, "id"));
  const firstTool = readTool(record.value, "first_tool", "files", readIdValue(record.value, "id"));
  const baseline = readBaseline(record.value);
  if (!id.ok) return id;
  if (!session.ok) return session;
  if (!path.ok) return path;
  if (!relPath.ok) return relPath;
  if (!firstTouchedAt.ok) return firstTouchedAt;
  if (!firstTool.ok) return firstTool;
  if (!baseline.ok) return baseline;
  return ok({
    id: id.value,
    sessionId: session.value,
    path: path.value,
    relPath: relPath.value,
    baseline: baseline.value,
    firstTouchedAt: firstTouchedAt.value,
    firstTool: firstTool.value
  });
}

export function parsePatchRow(row: unknown): Result<PatchRecord> {
  const record = asRow(row);
  if (!record.ok) return record;
  const idValue = readIdValue(record.value, "id");
  const id = readId(record.value, "id", "patches", patchId);
  const session = readSessionId(record.value, "session_id", "patches");
  const file = readId(record.value, "file_id", "patches", fileId);
  const sequence = readId(record.value, "seq", "patches", seq);
  const tool = readTool(record.value, "tool", "patches", idValue);
  const toolCallId = readNullableString(record.value, "tool_call_id", "patches", idValue);
  const unifiedPatch = readString(record.value, "unified_patch", "patches", idValue);
  const displayDiff = readString(record.value, "display_diff", "patches", idValue);
  const firstChangedLine = readNullableInteger(record.value, "first_changed_line", "patches", idValue);
  const preHash = readNullableHash(record.value, "pre_hash", "patches", idValue);
  const postHash = readHash(record.value, "post_hash", "patches", idValue);
  const createdAt = readInteger(record.value, "created_at", "patches", idValue);
  if (!id.ok) return id;
  if (!session.ok) return session;
  if (!file.ok) return file;
  if (!sequence.ok) return sequence;
  if (!tool.ok) return tool;
  if (!toolCallId.ok) return toolCallId;
  if (!unifiedPatch.ok) return unifiedPatch;
  if (!displayDiff.ok) return displayDiff;
  if (!firstChangedLine.ok) return firstChangedLine;
  if (!preHash.ok) return preHash;
  if (!postHash.ok) return postHash;
  if (!createdAt.ok) return createdAt;
  return ok({
    id: id.value,
    sessionId: session.value,
    fileId: file.value,
    seq: sequence.value,
    tool: tool.value,
    toolCallId: toolCallId.value,
    unifiedPatch: unifiedPatch.value,
    displayDiff: displayDiff.value,
    firstChangedLine: firstChangedLine.value,
    preHash: preHash.value,
    postHash: postHash.value,
    createdAt: createdAt.value
  });
}

export function parseAnnotationRow(row: unknown): Result<Annotation> {
  const record = asRow(row);
  if (!record.ok) return record;
  const idValue = readIdValue(record.value, "id");
  const id = readId(record.value, "id", "annotations", annotationId);
  const session = readSessionId(record.value, "session_id", "annotations");
  const file = readId(record.value, "file_id", "annotations", fileId);
  const anchorPatch = readNullable(record.value, "anchor_patch_id", (value) =>
    readIdValueAs(value, "anchor_patch_id", "annotations", idValue, patchId)
  );
  const anchorHash = readHash(record.value, "anchor_hash", "annotations", idValue);
  const start = readId(record.value, "start_line", "annotations", anchorLine);
  const end = readId(record.value, "end_line", "annotations", anchorLine);
  const state = readAnnotationState(record.value, idValue);
  const role = readAnnotationRole(record.value, idValue);
  const snippet = readString(record.value, "snippet", "annotations", idValue);
  const comment = readString(record.value, "comment", "annotations", idValue);
  const createdAt = readInteger(record.value, "created_at", "annotations", idValue);
  const updatedAt = readInteger(record.value, "updated_at", "annotations", idValue);
  if (!id.ok) return id;
  if (!session.ok) return session;
  if (!file.ok) return file;
  if (!anchorPatch.ok) return anchorPatch;
  if (!anchorHash.ok) return anchorHash;
  if (!start.ok) return start;
  if (!end.ok) return end;
  if (!state.ok) return state;
  if (!role.ok) return role;
  if (!snippet.ok) return snippet;
  if (!comment.ok) return comment;
  if (!createdAt.ok) return createdAt;
  if (!updatedAt.ok) return updatedAt;
  if (Number(end.value) < Number(start.value)) {
    return err({ kind: "CorruptRow", table: "annotations", id: idValue, field: "end_line", message: "expected end_line >= start_line" });
  }
  return ok({
    id: id.value,
    sessionId: session.value,
    fileId: file.value,
    anchor: {
      patchId: anchorPatch.value,
      hash: anchorHash.value,
      start: start.value,
      end: end.value
    },
    snippet: snippet.value,
    comment: comment.value,
    role: role.value,
    state: state.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value
  });
}

export function parseClaimedAnnotationRow(row: unknown): Result<ClaimedAnnotation> {
  const annotation = parseAnnotationRow(row);
  if (!annotation.ok) return annotation;
  const record = asRow(row);
  if (!record.ok) return record;
  const filePath = readString(record.value, "file_path", "annotations", annotation.value.id, true);
  const relPath = readString(record.value, "rel_path", "annotations", annotation.value.id, true);
  if (!filePath.ok) return filePath;
  if (!relPath.ok) return relPath;
  const file = {
    id: annotation.value.fileId,
    path: filePath.value,
    relPath: relPath.value
  };
  const anchorSeqValue = record.value.anchor_seq;
  const anchorSeq =
    anchorSeqValue === null || anchorSeqValue === undefined ? ok(0 as const) : readIdValueAs(anchorSeqValue, "anchor_seq", "annotations", annotation.value.id, seq);
  if (!anchorSeq.ok) return anchorSeq;
  const fixIntent = record.value.fix_intent;
  if (fixIntent !== 0 && fixIntent !== 1) {
    return err({ kind: "CorruptRow", table: "annotations", id: annotation.value.id, field: "fix_intent", message: "expected 0 or 1" });
  }
  return ok({ ...annotation.value, file, anchorSeq: anchorSeq.value, fixIntent: fixIntent === 1, checkDisk: true });
}

export function baselineDbFields(baseline: Baseline): {
  baselineContent: string | null;
  baselineHash: string | null;
  baselineMissing: 0 | 1;
} {
  if (baseline.kind === "absent") {
    return { baselineContent: null, baselineHash: null, baselineMissing: 1 };
  }
  return { baselineContent: baseline.content, baselineHash: baseline.hash, baselineMissing: 0 };
}

export function annotationStatusDbFields(state: AnnotationState): {
  status: "draft" | "queued" | "sent";
  sentAt: number | null;
  batchId: string | null;
} {
  switch (state.kind) {
    case "draft":
      return { status: "draft", sentAt: null, batchId: null };
    case "queued":
      return { status: "queued", sentAt: null, batchId: null };
    case "sent":
      return { status: "sent", sentAt: state.sentAt, batchId: state.batchId };
  }
}

export function annotationRoleDbFields(role: ReviewNoteRole): {
  kind: "finding" | "callout";
  priority: "P0" | "P1" | "P2" | "P3" | null;
  audience: "agent" | "human";
} {
  return role.kind === "finding"
    ? { kind: "finding", priority: role.priority, audience: role.audience }
    : { kind: "callout", priority: null, audience: "human" };
}

function asRow(value: unknown): Result<Row> {
  if (value && typeof value === "object") return ok(value as Row);
  return err({ kind: "CorruptRow", table: "unknown", id: null, field: "row", message: "expected object row" });
}

function nonEmptyString(field: string, value: string): Result<string> {
  if (typeof value === "string" && value.length > 0) return ok(value);
  return err({ kind: "InvalidInput", field, message: "expected non-empty string" });
}

function positiveInteger(field: string, value: number): Result<number> {
  if (Number.isInteger(value) && value >= 1) return ok(value);
  return err({ kind: "InvalidInput", field, message: "expected positive integer" });
}

function readIdValue(row: Row, field: string): number | null {
  const value = row[field];
  return typeof value === "number" ? value : null;
}

function readId<T extends number>(row: Row, field: string, table: string, make: (value: number) => Result<T>): Result<T> {
  return readIdValueAs(row[field], field, table, readIdValue(row, "id"), make);
}

function readIdValueAs<T extends number>(
  value: unknown,
  field: string,
  table: string,
  id: string | number | null,
  make: (value: number) => Result<T>
): Result<T> {
  if (typeof value !== "number") {
    return err({ kind: "CorruptRow", table, id, field, message: "expected integer" });
  }
  const parsed = make(value);
  if (parsed.ok) return parsed;
  return err({ kind: "CorruptRow", table, id, field, message: errorMessage(parsed.error) });
}

function readInteger(row: Row, field: string, table: string, id: string | number | null): Result<number> {
  const value = row[field];
  if (typeof value === "number" && Number.isInteger(value)) return ok(value);
  return err({ kind: "CorruptRow", table, id, field, message: "expected integer" });
}

function readNullableInteger(row: Row, field: string, table: string, id: string | number | null): Result<number | null> {
  const value = row[field];
  if (value === null || value === undefined) return ok(null);
  if (typeof value === "number" && Number.isInteger(value)) return ok(value);
  return err({ kind: "CorruptRow", table, id, field, message: "expected nullable integer" });
}

function readSessionId(row: Row, field: string, table: string): Result<SessionId> {
  return readSessionIdValue(row[field], field, table, readIdValue(row, "id"));
}

function readSessionIdValue(value: unknown, field: string, table: string, id: string | number | null): Result<SessionId> {
  if (typeof value !== "string" || value.length === 0) {
    return err({ kind: "CorruptRow", table, id, field, message: "expected non-empty session id" });
  }
  return ok(value as SessionId);
}

function readNullable<T>(row: Row, field: string, parse: (value: unknown) => Result<T>): Result<T | null> {
  const value = row[field];
  if (value === null || value === undefined) return ok(null);
  return parse(value);
}

function readString(
  row: Row,
  field: string,
  table: string,
  id: string | number | null,
  nonEmpty = false
): Result<string> {
  const value = row[field];
  if (typeof value !== "string") {
    return err({ kind: "CorruptRow", table, id, field, message: "expected string" });
  }
  if (nonEmpty && value.length === 0) {
    return err({ kind: "CorruptRow", table, id, field, message: "expected non-empty string" });
  }
  return ok(value);
}

function readNullableString(row: Row, field: string, table: string, id: string | number | null): Result<string | null> {
  const value = row[field];
  if (value === null || value === undefined) return ok(null);
  return typeof value === "string"
    ? ok(value)
    : err({ kind: "CorruptRow", table, id, field, message: "expected nullable string" });
}

function readHash(row: Row, field: string, table: string, id: string | number | null): Result<ContentHash> {
  const value = row[field];
  if (typeof value !== "string") {
    return err({ kind: "CorruptRow", table, id, field, message: "expected hash string" });
  }
  const parsed = contentHash(value);
  if (parsed.ok) return parsed;
  return err({ kind: "CorruptRow", table, id, field, message: errorMessage(parsed.error) });
}

function readNullableHash(row: Row, field: string, table: string, id: string | number | null): Result<ContentHash | null> {
  const value = row[field];
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "string") {
    return err({ kind: "CorruptRow", table, id, field, message: "expected nullable hash string" });
  }
  const parsed = contentHash(value);
  if (parsed.ok) return parsed;
  return err({ kind: "CorruptRow", table, id, field, message: errorMessage(parsed.error) });
}

function readTool(row: Row, field: string, table: string, id: string | number | null): Result<ToolName> {
  const value = row[field];
  if (value === "edit" || value === "write") return ok(value);
  return err({ kind: "CorruptRow", table, id, field, message: "expected edit or write" });
}

function readAnnotationRole(row: Row, id: string | number | null): Result<ReviewNoteRole> {
  const kind = row.kind;
  const priority = row.priority;
  const audience = row.audience;
  if (kind === "finding" && isPriority(priority) && (audience === "agent" || audience === "human")) {
    return ok({ kind, priority, audience });
  }
  if (kind === "callout" && priority === null && audience === "human") {
    return ok({ kind, audience });
  }
  return err({
    kind: "CorruptRow",
    table: "annotations",
    id,
    field: "role",
    message: "expected a prioritized finding or human callout"
  });
}

function readBaseline(row: Row): Result<Baseline> {
  const missing = row.baseline_missing;
  if (missing !== 0 && missing !== 1) {
    return err({ kind: "CorruptRow", table: "files", id: readIdValue(row, "id"), field: "baseline_missing", message: "expected 0 or 1" });
  }
  const rawContent = row.baseline_content;
  const rawHash = row.baseline_hash;
  if (missing === 1) {
    if (rawContent === null && rawHash === null) return ok({ kind: "absent" });
    return err({ kind: "CorruptRow", table: "files", id: readIdValue(row, "id"), field: "baseline", message: "absent baseline must not carry content or hash" });
  }
  const content = blobToString(rawContent);
  if (!content.ok) return content;
  const hash = readHash(row, "baseline_hash", "files", readIdValue(row, "id"));
  if (!hash.ok) return hash;
  const expectedHash = hashContent(content.value);
  if (hash.value !== expectedHash) {
    return err({
      kind: "CorruptRow",
      table: "files",
      id: readIdValue(row, "id"),
      field: "baseline_hash",
      message: `expected ${expectedHash} for baseline_content`
    });
  }
  return ok({ kind: "present", content: content.value, hash: hash.value });
}

function blobToString(value: unknown): Result<string> {
  if (typeof value === "string") return ok(value);
  if (value instanceof Uint8Array) return ok(new TextDecoder().decode(value));
  return err({ kind: "CorruptRow", table: "files", id: null, field: "baseline_content", message: "expected text blob" });
}

function readAnnotationState(row: Row, id: string | number | null): Result<AnnotationState> {
  const status = row.status;
  const rawSentAt = row.sent_at;
  const rawBatch = row.batch_id;
  if (status === "draft" || status === "queued") {
    if (rawSentAt !== null && rawSentAt !== undefined || rawBatch !== null && rawBatch !== undefined) {
      return err({ kind: "CorruptRow", table: "annotations", id, field: "status", message: "unsent annotation must not carry sent_at or batch_id" });
    }
    return ok({ kind: status });
  }
  if (status !== "sent") {
    return err({ kind: "CorruptRow", table: "annotations", id, field: "status", message: "expected draft, queued, or sent" });
  }
  const sentAt = readInteger(row, "sent_at", "annotations", id);
  if (!sentAt.ok) return sentAt;
  if (typeof rawBatch !== "string" || rawBatch.length === 0) {
    return err({ kind: "CorruptRow", table: "annotations", id, field: "batch_id", message: "sent annotation needs batch id" });
  }
  const parsedBatch = batchId(rawBatch);
  if (!parsedBatch.ok) {
    return err({ kind: "CorruptRow", table: "annotations", id, field: "batch_id", message: errorMessage(parsedBatch.error) });
  }
  return ok({ kind: "sent", sentAt: sentAt.value, batchId: parsedBatch.value });
}
