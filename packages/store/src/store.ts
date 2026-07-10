import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { errorMessage, err, ok, sqliteError, type Result } from "./errors.ts";
import { parseAnalysisResult, type AnalysisResult } from "./analysis-result.ts";
import { migrations, schemaVersion } from "./schema.ts";
import {
  annotationRoleDbFields,
  annotationId,
  anchorLine,
  baselineDbFields,
  batchId,
  contentHash,
  fileId,
  hashContent,
  parseAnnotationRow,
  parseClaimedAnnotationRow,
  parseFileRow,
  parsePatchRow,
  parseSessionRow,
  patchId,
  sessionId,
  type Annotation,
  type AnnotationId,
  type Anchor,
  type BatchId,
  type Baseline,
  type ClaimedAnnotation,
  type ContentHash,
  type FileId,
  type FileRecord,
  type PatchRecord,
  type SessionId,
  type SessionRecord,
  type ToolName
} from "./rows.ts";
import {
  canonicalJson,
  checkedAnalysisRunId,
  checkedDocumentId,
  checkedSourceFingerprint,
  checkedSourceNoteId,
  isAnalysisMode,
  isAnalysisStatus,
  isHistoryMode,
  isPriority,
  isVerdict,
  parseModelSelection,
  parseAnalysisManifestEvidence,
  parseReviewSource,
  type AnalysisMode,
  type AnalysisManifestEvidence,
  type AnalysisRun,
  type AnalysisRunId,
  type CoverageEntry,
  type CoverageState,
  type DocumentId,
  type HistoryMode,
  type ModelSelection,
  type ReviewNoteRole,
  type ReviewOutcome,
  type ReviewSource,
  type ReviewSourceRecord,
  type SourceNote,
  type SourceNoteId,
  type ClaimedSourceNote,
  type SourceFingerprint,
  type Verdict
} from "./review.ts";

type SqlParams = readonly (string | number | null)[];

export type OpenOptions = {
  create?: boolean;
};

export type AddPatchInput = {
  sessionId: SessionId;
  fileId: FileId;
  tool: ToolName;
  toolCallId: string | null;
  unifiedPatch: string;
  displayDiff: string;
  firstChangedLine: number | null;
  preHash: ContentHash | null;
  postHash: ContentHash;
  createdAt?: number;
};

export type AddAnnotationInput = {
  sessionId: SessionId;
  fileId: FileId;
  anchor: Anchor;
  snippet: string;
  comment: string;
  role?: ReviewNoteRole;
  createdAt?: number;
};

export type QueueDraftsResult = {
  queued: Annotation[];
  skippedStale: Annotation[];
  preservedCallouts: Annotation[];
  preservedHumanFindings: Annotation[];
};

export type QueueDraftsOptions = {
  fixIntent?: boolean;
};

export type AddSourceNoteInput = {
  sourceFingerprint: SourceFingerprint;
  targetSessionId: SessionId;
  documentId: DocumentId;
  path: string;
  relPath: string;
  anchor: { hash: ContentHash; start: import("./rows.ts").AnchorLine; end: import("./rows.ts").AnchorLine };
  snippet: string;
  comment: string;
  role?: ReviewNoteRole;
  createdAt?: number;
};

export type QueueSourceNotesResult = {
  queued: SourceNote[];
  skippedStale: SourceNote[];
  preservedCallouts: SourceNote[];
  preservedHumanFindings: SourceNote[];
};

export type StartAnalysisRunInput = {
  id: AnalysisRunId;
  sourceFingerprint: SourceFingerprint;
  mode: AnalysisMode;
  model: ModelSelection;
  promptVersion: string;
  focus?: string;
  manifest: AnalysisManifestEvidence;
  startedAt?: number;
};

export type CompleteAnalysisRunInput = {
  output: AnalysisResult;
  rawOutput: string;
  reviewVerdict?: Verdict;
  documentCoverage: readonly CoverageEntry[];
  commitCoverage: readonly CoverageEntry[];
  completedAt?: number;
};

export class PatchStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  private constructor(dbPath: string, db: DatabaseSync) {
    this.dbPath = dbPath;
    this.db = db;
  }

  static open(dbPath: string, options: OpenOptions = {}): Result<PatchStore> {
    let db: DatabaseSync | null = null;
    try {
      if (!options.create && !existsSync(dbPath)) {
        return err({ kind: "NotFound", entity: "database", id: dbPath });
      }
      if (options.create) mkdirSync(dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=NORMAL");
      db.exec("PRAGMA busy_timeout=5000");
      db.exec("PRAGMA foreign_keys=ON");
      applyMigrations(db);
      return ok(new PatchStore(dbPath, db));
    } catch (error) {
      try {
        db?.close();
      } catch {}
      return err(sqliteError(error));
    }
  }

  close(): Result<void> {
    try {
      this.db.close();
      return ok(undefined);
    } catch (error) {
      return err(sqliteError(error));
    }
  }

  upsertSession(id: SessionId, cwd: string, sessionFile: string | null, now = Date.now()): Result<void> {
    return this.write(() => {
      this.run(
        `INSERT INTO sessions (id, cwd, session_file, started_at, last_event_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd,
           session_file = excluded.session_file,
           last_event_at = excluded.last_event_at,
           ended_at = NULL`,
        [id, cwd, sessionFile, now, now]
      );
    });
  }

  touchSession(id: SessionId, now = Date.now()): Result<void> {
    return this.write(() => {
      this.run("UPDATE sessions SET last_event_at = ?, ended_at = NULL WHERE id = ?", [now, id]);
    });
  }

  endSession(id: SessionId, now = Date.now()): Result<void> {
    return this.write(() => {
      this.run("UPDATE sessions SET ended_at = ?, last_event_at = ? WHERE id = ?", [now, now, id]);
    });
  }

  forkSession(fromId: SessionId, toId: SessionId): Result<void> {
    return this.transaction(() => {
      this.run("UPDATE sessions SET parent_session_id = ? WHERE id = ?", [fromId, toId]);
      const existing = this.scalar("SELECT COUNT(*) AS count FROM files WHERE session_id = ?", [toId]);
      if (Number(existing ?? 0) > 0) return;

      const fileRows = this.all("SELECT * FROM files WHERE session_id = ? ORDER BY id", [fromId]);
      const fileMap = new Map<number, number>();
      for (const row of fileRows) {
        const file = parseFileRow(row);
        if (!file.ok) throw new StoreFailure(file.error);
        const baseline = baselineDbFields(file.value.baseline);
        const result = this.run(
          `INSERT INTO files
             (session_id, path, rel_path, baseline_content, baseline_hash, baseline_missing, first_touched_at, first_tool)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            toId,
            file.value.path,
            file.value.relPath,
            baseline.baselineContent,
            baseline.baselineHash,
            baseline.baselineMissing,
            file.value.firstTouchedAt,
            file.value.firstTool
          ]
        );
        fileMap.set(file.value.id, Number(result.lastInsertRowid));
      }

      const patchRows = this.all("SELECT * FROM patches WHERE session_id = ? ORDER BY seq", [fromId]);
      const patchMap = new Map<number, number>();
      for (const row of patchRows) {
        const patch = parsePatchRow(row);
        if (!patch.ok) throw new StoreFailure(patch.error);
        const mappedFileId = fileMap.get(patch.value.fileId);
        if (mappedFileId === undefined) continue;
        const result = this.run(
          `INSERT INTO patches
             (session_id, file_id, seq, tool, tool_call_id, unified_patch, display_diff,
              first_changed_line, pre_hash, post_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            toId,
            mappedFileId,
            patch.value.seq,
            patch.value.tool,
            patch.value.toolCallId,
            patch.value.unifiedPatch,
            patch.value.displayDiff,
            patch.value.firstChangedLine,
            patch.value.preHash,
            patch.value.postHash,
            patch.value.createdAt
          ]
        );
        patchMap.set(patch.value.id, Number(result.lastInsertRowid));
      }

      const annotationRows = this.all("SELECT * FROM annotations WHERE session_id = ? ORDER BY id", [fromId]);
      for (const row of annotationRows) {
        const annotation = parseAnnotationRow(row);
        if (!annotation.ok) throw new StoreFailure(annotation.error);
        const mappedFileId = fileMap.get(annotation.value.fileId);
        if (mappedFileId === undefined) continue;
        let mappedPatchId: number | null = null;
        if (annotation.value.anchor.patchId !== null) {
          const copiedPatchId = patchMap.get(annotation.value.anchor.patchId);
          if (copiedPatchId === undefined) {
            throw new StoreFailure({
              kind: "CorruptRow",
              table: "annotations",
              id: annotation.value.id,
              field: "anchor_patch_id",
              message: `patch ${annotation.value.anchor.patchId} was not copied with its file`
            });
          }
          mappedPatchId = copiedPatchId;
        }
        const sent =
          annotation.value.state.kind === "sent"
            ? { status: "sent", sentAt: annotation.value.state.sentAt, batchId: annotation.value.state.batchId }
            : { status: annotation.value.state.kind, sentAt: null, batchId: null };
        const role = annotationRoleDbFields(annotation.value.role);
        this.run(
          `INSERT INTO annotations
             (session_id, file_id, anchor_patch_id, anchor_hash, start_line, end_line,
              snippet, comment, kind, priority, audience, status, created_at, updated_at, sent_at, batch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            toId,
            mappedFileId,
            mappedPatchId,
            annotation.value.anchor.hash,
            annotation.value.anchor.start,
            annotation.value.anchor.end,
            annotation.value.snippet,
            annotation.value.comment,
            role.kind,
            role.priority,
            role.audience,
            sent.status,
            annotation.value.createdAt,
            annotation.value.updatedAt,
            sent.sentAt,
            sent.batchId
          ]
        );
      }
    });
  }

  ensureFile(
    session: SessionId,
    absPath: string,
    relPath: string,
    baseline: Baseline,
    tool: ToolName,
    now = Date.now()
  ): Result<FileRecord> {
    return this.write(() => {
      const existing = this.get("SELECT * FROM files WHERE session_id = ? AND path = ?", [session, absPath]);
      if (existing) {
        const parsed = parseFileRow(existing);
        if (!parsed.ok) throw new StoreFailure(parsed.error);
        return parsed.value;
      }
      const fields = baselineDbFields(baseline);
      const result = this.run(
        `INSERT INTO files
           (session_id, path, rel_path, baseline_content, baseline_hash, baseline_missing, first_touched_at, first_tool)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [session, absPath, relPath, fields.baselineContent, fields.baselineHash, fields.baselineMissing, now, tool]
      );
      const row = this.get("SELECT * FROM files WHERE id = ?", [Number(result.lastInsertRowid)]);
      const parsed = parseFileRow(row);
      if (!parsed.ok) throw new StoreFailure(parsed.error);
      return parsed.value;
    });
  }

  addPatch(input: AddPatchInput): Result<PatchRecord> {
    return this.transaction(() => {
      this.requireFileInSession(input.fileId, input.sessionId);
      const now = input.createdAt ?? Date.now();
      const nextSeq = Number(this.scalar("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM patches WHERE session_id = ?", [input.sessionId]));
      const result = this.run(
        `INSERT INTO patches
           (session_id, file_id, seq, tool, tool_call_id, unified_patch, display_diff,
            first_changed_line, pre_hash, post_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.sessionId,
          input.fileId,
          nextSeq,
          input.tool,
          input.toolCallId,
          input.unifiedPatch,
          input.displayDiff,
          input.firstChangedLine,
          input.preHash,
          input.postHash,
          now
        ]
      );
      this.run("UPDATE sessions SET last_event_at = ? WHERE id = ?", [now, input.sessionId]);
      const row = this.get("SELECT * FROM patches WHERE id = ?", [Number(result.lastInsertRowid)]);
      const parsed = parsePatchRow(row);
      if (!parsed.ok) throw new StoreFailure(parsed.error);
      return parsed.value;
    });
  }

  addAnnotation(input: AddAnnotationInput): Result<Annotation> {
    return this.transaction(() => {
      this.requireFileInSession(input.fileId, input.sessionId);
      this.requireAnchorForFile(input.anchor, input.fileId, input.sessionId);
      const now = input.createdAt ?? Date.now();
      const role = annotationRoleDbFields(input.role ?? { kind: "finding", priority: "P2", audience: "agent" });
      const result = this.run(
        `INSERT INTO annotations
           (session_id, file_id, anchor_patch_id, anchor_hash, start_line, end_line,
            snippet, comment, kind, priority, audience, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        [
          input.sessionId,
          input.fileId,
          input.anchor.patchId,
          input.anchor.hash,
          input.anchor.start,
          input.anchor.end,
          input.snippet,
          input.comment,
          role.kind,
          role.priority,
          role.audience,
          now,
          now
        ]
      );
      return this.annotationByRowId(Number(result.lastInsertRowid));
    });
  }

  updateAnnotation(id: AnnotationId, comment: string, now = Date.now()): Result<Annotation> {
    return this.write(() => {
      this.run("UPDATE annotations SET comment = ?, updated_at = ? WHERE id = ? AND status <> 'sent'", [comment, now, id]);
      return this.annotationById(id);
    });
  }

  updateAnnotationRole(id: AnnotationId, role: ReviewNoteRole, now = Date.now()): Result<Annotation> {
    return this.write(() => {
      const fields = annotationRoleDbFields(role);
      this.run(
        `UPDATE annotations
         SET kind = ?, priority = ?, audience = ?, updated_at = ?
         WHERE id = ? AND status <> 'sent'`,
        [fields.kind, fields.priority, fields.audience, now, id]
      );
      return this.annotationById(id);
    });
  }

  reanchorAnnotation(id: AnnotationId, anchor: Anchor, snippet: string, now = Date.now()): Result<Annotation> {
    return this.transaction(() => {
      const annotation = this.annotationById(id);
      this.requireAnchorForFile(anchor, annotation.fileId, annotation.sessionId);
      this.run(
        `UPDATE annotations
         SET anchor_patch_id = ?, anchor_hash = ?, start_line = ?, end_line = ?,
             snippet = ?, updated_at = ?
         WHERE id = ? AND status <> 'sent'`,
        [anchor.patchId, anchor.hash, anchor.start, anchor.end, snippet, now, id]
      );
      return this.annotationById(id);
    });
  }

  deleteAnnotation(id: AnnotationId): Result<boolean> {
    return this.write(() => {
      const result = this.run("DELETE FROM annotations WHERE id = ? AND status <> 'sent'", [id]);
      return Number(result.changes) > 0;
    });
  }

  queueAllDrafts(
    session: SessionId,
    freshnessByFile: ReadonlyMap<FileId, ContentHash> | Record<number, string>,
    options: QueueDraftsOptions = {}
  ): Result<QueueDraftsResult> {
    return this.transaction(() => {
      const drafts = this.getAnnotations(session, "draft");
      if (!drafts.ok) throw new StoreFailure(drafts.error);
      const queued: Annotation[] = [];
      const skippedStale: Annotation[] = [];
      const preservedCallouts: Annotation[] = [];
      const preservedHumanFindings: Annotation[] = [];
      const now = Date.now();
      for (const annotation of drafts.value) {
        if (annotation.role.kind === "callout") {
          preservedCallouts.push(annotation);
          continue;
        }
        if (annotation.role.audience === "human") {
          preservedHumanFindings.push(annotation);
          continue;
        }
        const expected = freshnessLookup(freshnessByFile, annotation.fileId);
        if (expected !== annotation.anchor.hash) {
          skippedStale.push(annotation);
          continue;
        }
        this.run("UPDATE annotations SET status = 'queued', fix_intent = ?, updated_at = ? WHERE id = ? AND status = 'draft'", [
          options.fixIntent ? 1 : 0,
          now,
          annotation.id
        ]);
        queued.push(this.annotationById(annotation.id));
      }
      return { queued, skippedStale, preservedCallouts, preservedHumanFindings };
    });
  }

  claimQueued(session: SessionId, batch: BatchId, now = Date.now()): Result<ClaimedAnnotation[]> {
    return this.transaction(() => this.claimQueuedAnnotationsBody(session, batch, now));
  }

  listSessions(): Result<SessionRecord[]> {
    return this.readMany("SELECT * FROM sessions ORDER BY COALESCE(last_event_at, started_at) DESC", [], parseSessionRow);
  }

  latestLiveSession(): Result<SessionRecord | null> {
    const live = this.get("SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY COALESCE(last_event_at, started_at) DESC LIMIT 1", []);
    const row = live ?? this.get("SELECT * FROM sessions ORDER BY COALESCE(last_event_at, started_at) DESC LIMIT 1", []);
    if (!row) return ok(null);
    return parseSessionRow(row);
  }

  getFiles(session: SessionId): Result<FileRecord[]> {
    return this.readMany("SELECT * FROM files WHERE session_id = ? ORDER BY rel_path", [session], parseFileRow);
  }

  getPatches(session: SessionId, file?: FileId): Result<PatchRecord[]> {
    return this.readMany(
      file
        ? "SELECT * FROM patches WHERE session_id = ? AND file_id = ? ORDER BY seq"
        : "SELECT * FROM patches WHERE session_id = ? ORDER BY seq",
      file ? [session, file] : [session],
      parsePatchRow
    );
  }

  getAnnotations(session: SessionId, status?: "draft" | "queued" | "sent"): Result<Annotation[]> {
    return this.readMany(
      status
        ? "SELECT * FROM annotations WHERE session_id = ? AND status = ? ORDER BY id"
        : "SELECT * FROM annotations WHERE session_id = ? ORDER BY id",
      status ? [session, status] : [session],
      parseAnnotationRow
    );
  }

  addSourceNote(input: AddSourceNoteInput): Result<SourceNote> {
    return this.transaction(() => {
      this.reviewSourceByFingerprint(input.sourceFingerprint);
      this.requireSession(input.targetSessionId);
      if (input.path.length === 0 || input.relPath.length === 0) {
        throw new StoreFailure({ kind: "InvalidInput", field: "sourceNote.path", message: "paths must be non-empty" });
      }
      const now = input.createdAt ?? Date.now();
      const role = annotationRoleDbFields(input.role ?? { kind: "finding", priority: "P2", audience: "agent" });
      const inserted = this.run(
        `INSERT INTO source_notes
           (source_fingerprint, target_session_id, document_id, path, rel_path,
            anchor_hash, start_line, end_line, snippet, comment, kind, priority,
            audience, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        [
          input.sourceFingerprint,
          input.targetSessionId,
          input.documentId,
          input.path,
          input.relPath,
          input.anchor.hash,
          input.anchor.start,
          input.anchor.end,
          input.snippet,
          input.comment,
          role.kind,
          role.priority,
          role.audience,
          now,
          now
        ]
      );
      return this.sourceNoteById(checkedSourceNoteIdOrThrow(Number(inserted.lastInsertRowid)));
    });
  }

  updateSourceNote(id: SourceNoteId, comment: string, now = Date.now()): Result<SourceNote> {
    return this.write(() => {
      this.run("UPDATE source_notes SET comment = ?, updated_at = ? WHERE id = ? AND status <> 'sent'", [comment, now, id]);
      return this.sourceNoteById(id);
    });
  }

  updateSourceNoteRole(id: SourceNoteId, role: ReviewNoteRole, now = Date.now()): Result<SourceNote> {
    return this.write(() => {
      const fields = annotationRoleDbFields(role);
      this.run(
        "UPDATE source_notes SET kind = ?, priority = ?, audience = ?, updated_at = ? WHERE id = ? AND status <> 'sent'",
        [fields.kind, fields.priority, fields.audience, now, id]
      );
      return this.sourceNoteById(id);
    });
  }

  reanchorSourceNote(
    id: SourceNoteId,
    anchor: SourceNote["anchor"],
    snippet: string,
    now = Date.now()
  ): Result<SourceNote> {
    return this.write(() => {
      this.run(
        `UPDATE source_notes SET anchor_hash = ?, start_line = ?, end_line = ?, snippet = ?, updated_at = ?
         WHERE id = ? AND status <> 'sent'`,
        [anchor.hash, anchor.start, anchor.end, snippet, now, id]
      );
      return this.sourceNoteById(id);
    });
  }

  deleteSourceNote(id: SourceNoteId): Result<boolean> {
    return this.write(() => Number(this.run("DELETE FROM source_notes WHERE id = ? AND status <> 'sent'", [id]).changes) > 0);
  }

  getSourceNotes(sourceFingerprint: SourceFingerprint, status?: "draft" | "queued" | "sent"): Result<SourceNote[]> {
    return this.write(() => {
      const rows = this.all(
        status
          ? `SELECT * FROM source_notes WHERE source_fingerprint = ? AND status = ?
             ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
               rel_path, start_line, id`
          : `SELECT * FROM source_notes WHERE source_fingerprint = ?
             ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
               rel_path, start_line, id`,
        status ? [sourceFingerprint, status] : [sourceFingerprint]
      );
      return rows.map(parseSourceNoteRow);
    });
  }

  queueSourceNotes(
    sourceFingerprint: SourceFingerprint,
    targetSessionId: SessionId,
    freshness: ReadonlyMap<DocumentId, ContentHash> | Record<string, string>,
    options: QueueDraftsOptions = {}
  ): Result<QueueSourceNotesResult> {
    return this.transaction(() => {
      const notes = this.getSourceNotes(sourceFingerprint, "draft");
      if (!notes.ok) throw new StoreFailure(notes.error);
      const result: QueueSourceNotesResult = { queued: [], skippedStale: [], preservedCallouts: [], preservedHumanFindings: [] };
      const now = Date.now();
      for (const note of notes.value) {
        if (note.targetSessionId !== targetSessionId) continue;
        if (note.role.kind === "callout") {
          result.preservedCallouts.push(note);
          continue;
        }
        if (note.role.audience === "human") {
          result.preservedHumanFindings.push(note);
          continue;
        }
        const current = sourceFreshnessLookup(freshness, note.documentId);
        if (current !== note.anchor.hash) {
          result.skippedStale.push(note);
          continue;
        }
        this.run(
          "UPDATE source_notes SET status = 'queued', fix_intent = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
          [options.fixIntent ? 1 : 0, now, note.id]
        );
        result.queued.push(this.sourceNoteById(note.id));
      }
      return result;
    });
  }

  claimQueuedSourceNotes(session: SessionId, batch: BatchId, now = Date.now()): Result<ClaimedSourceNote[]> {
    return this.transaction(() => this.claimQueuedSourceNotesBody(session, batch, now));
  }

  claimQueuedFeedback(
    session: SessionId,
    batch: BatchId,
    now = Date.now()
  ): Result<Array<ClaimedAnnotation | ClaimedSourceNote>> {
    return this.transaction(() => [
      ...this.claimQueuedAnnotationsBody(session, batch, now),
      ...this.claimQueuedSourceNotesBody(session, batch, now)
    ]);
  }

  saveReviewSource(record: ReviewSourceRecord): Result<ReviewSourceRecord> {
    return this.write(() => {
      const descriptor = canonicalJson(record.source);
      this.run(
        `INSERT INTO review_sources (fingerprint, descriptor_json, history_mode, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO NOTHING`,
        [record.fingerprint, descriptor, record.historyMode, record.createdAt]
      );
      const stored = this.reviewSourceByFingerprint(record.fingerprint);
      if (canonicalJson(stored.source) !== descriptor || stored.historyMode !== record.historyMode) {
        throw new StoreFailure({
          kind: "InvalidInput",
          field: "sourceFingerprint",
          message: `fingerprint ${record.fingerprint} is already bound to a different source`
        });
      }
      return stored;
    });
  }

  getReviewSource(fingerprint: SourceFingerprint): Result<ReviewSourceRecord> {
    return this.write(() => this.reviewSourceByFingerprint(fingerprint));
  }

  recordReviewOutcome(
    sourceFingerprint: SourceFingerprint,
    verdict: Verdict,
    unresolvedFindingCount: number,
    recordedAt = Date.now()
  ): Result<ReviewOutcome> {
    return this.write(() => {
      this.reviewSourceByFingerprint(sourceFingerprint);
      if (!Number.isInteger(unresolvedFindingCount) || unresolvedFindingCount < 0) {
        throw new StoreFailure({ kind: "InvalidInput", field: "unresolvedFindingCount", message: "expected a non-negative integer" });
      }
      if (verdict === "correct" && unresolvedFindingCount !== 0) {
        throw new StoreFailure({ kind: "InvalidInput", field: "verdict", message: "correct requires zero unresolved findings" });
      }
      this.run(
        `INSERT INTO review_outcomes (source_fingerprint, verdict, recorded_at)
         VALUES (?, ?, ?)
         ON CONFLICT(source_fingerprint) DO UPDATE SET verdict = excluded.verdict, recorded_at = excluded.recorded_at`,
        [sourceFingerprint, verdict, recordedAt]
      );
      return { sourceFingerprint, verdict, recordedAt };
    });
  }

  getReviewOutcome(sourceFingerprint: SourceFingerprint): Result<ReviewOutcome | null> {
    return this.write(() => {
      const row = this.get("SELECT * FROM review_outcomes WHERE source_fingerprint = ?", [sourceFingerprint]);
      return row ? parseReviewOutcomeRow(row) : null;
    });
  }

  startAnalysisRun(input: StartAnalysisRunInput): Result<AnalysisRun> {
    return this.transaction(() => {
      this.reviewSourceByFingerprint(input.sourceFingerprint);
      const startedAt = input.startedAt ?? Date.now();
      const manifest = parseAnalysisManifestEvidence(input.manifest);
      if (!manifest.ok) throw new StoreFailure(manifest.error);
      this.run(
        `INSERT INTO analysis_runs
           (id, source_fingerprint, mode, provider, model_id, thinking_level,
            prompt_version, focus, manifest_json, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
        [
          input.id,
          input.sourceFingerprint,
          input.mode,
          input.model.provider,
          input.model.modelId,
          input.model.thinkingLevel,
          input.promptVersion,
          input.focus ?? null,
          canonicalJson(manifest.value),
          startedAt
        ]
      );
      return this.analysisRunById(input.id);
    });
  }

  completeAnalysisRun(id: AnalysisRunId, input: CompleteAnalysisRunInput): Result<AnalysisRun> {
    return this.transaction(() => {
      const current = this.analysisRunById(id);
      if (current.status !== "running") {
        throw new StoreFailure({ kind: "InvalidInput", field: "status", message: `run ${id} is already ${current.status}` });
      }
      if (current.mode === "narrative" && input.reviewVerdict !== undefined) {
        throw new StoreFailure({ kind: "InvalidInput", field: "reviewVerdict", message: "narrative runs cannot carry a verdict" });
      }
      if (current.mode === "implementationReview" && input.reviewVerdict === undefined) {
        throw new StoreFailure({ kind: "InvalidInput", field: "reviewVerdict", message: "implementation reviews require a verdict" });
      }
      validateCoverageForCompletion(current.mode, input.documentCoverage, input.commitCoverage);
      const parsedOutput = parseAnalysisResult(current.mode, input.output);
      if (!parsedOutput.ok) throw new StoreFailure(parsedOutput.error);
      this.insertCoverage("analysis_run_documents", "document_id", id, input.documentCoverage);
      this.insertCoverage("analysis_run_commits", "commit_sha", id, input.commitCoverage);
      this.run(
        `UPDATE analysis_runs
         SET status = 'completed', output_json = ?, raw_output = ?, review_verdict = ?, completed_at = ?
         WHERE id = ? AND status = 'running'`,
        [JSON.stringify(parsedOutput.value), input.rawOutput, input.reviewVerdict ?? null, input.completedAt ?? Date.now(), id]
      );
      return this.analysisRunById(id);
    });
  }

  failAnalysisRun(
    id: AnalysisRunId,
    status: "failed" | "cancelled",
    message: string,
    completedAt = Date.now(),
    documentCoverage: readonly CoverageEntry[] = [],
    commitCoverage: readonly CoverageEntry[] = []
  ): Result<AnalysisRun> {
    return this.transaction(() => {
      const current = this.analysisRunById(id);
      if (current.status !== "running") {
        throw new StoreFailure({ kind: "InvalidInput", field: "status", message: `run ${id} is already ${current.status}` });
      }
      this.insertCoverage("analysis_run_documents", "document_id", id, documentCoverage);
      this.insertCoverage("analysis_run_commits", "commit_sha", id, commitCoverage);
      this.run(
        `UPDATE analysis_runs SET status = ?, error = ?, completed_at = ? WHERE id = ? AND status = 'running'`,
        [status, message, completedAt, id]
      );
      return this.analysisRunById(id);
    });
  }

  getAnalysisRun(id: AnalysisRunId): Result<AnalysisRun> {
    return this.write(() => this.analysisRunById(id));
  }

  listAnalysisRuns(sourceFingerprint: SourceFingerprint, mode?: AnalysisMode): Result<AnalysisRun[]> {
    return this.write(() => {
      const rows = this.all(
        mode
          ? "SELECT * FROM analysis_runs WHERE source_fingerprint = ? AND mode = ? ORDER BY started_at DESC, id DESC"
          : "SELECT * FROM analysis_runs WHERE source_fingerprint = ? ORDER BY started_at DESC, id DESC",
        mode ? [sourceFingerprint, mode] : [sourceFingerprint]
      );
      return rows.map((row) => this.parseAnalysisRun(row));
    });
  }

  counts(session: SessionId): Result<{ files: number; patches: number; queued: number; sent: number }> {
    return this.write(() => ({
      files: Number(this.scalar("SELECT COUNT(*) AS count FROM files WHERE session_id = ?", [session]) ?? 0),
      patches: Number(this.scalar("SELECT COUNT(*) AS count FROM patches WHERE session_id = ?", [session]) ?? 0),
      queued: Number(this.scalar(
        `SELECT (SELECT COUNT(*) FROM annotations WHERE session_id = ? AND status = 'queued')
              + (SELECT COUNT(*) FROM source_notes WHERE target_session_id = ? AND status = 'queued')`,
        [session, session]
      ) ?? 0),
      sent: Number(this.scalar(
        `SELECT (SELECT COUNT(*) FROM annotations WHERE session_id = ? AND status = 'sent')
              + (SELECT COUNT(*) FROM source_notes WHERE target_session_id = ? AND status = 'sent')`,
        [session, session]
      ) ?? 0)
    }));
  }

  dataVersion(): Result<number> {
    return this.write(() => Number(this.scalar("PRAGMA data_version", []) ?? 0));
  }

  private annotationByRowId(id: number): Annotation {
    const parsedId = annotationId(id);
    if (!parsedId.ok) throw new StoreFailure(parsedId.error);
    return this.annotationById(parsedId.value);
  }

  private claimQueuedAnnotationsBody(session: SessionId, batch: BatchId, now: number): ClaimedAnnotation[] {
    const rows = this.all(
      `SELECT annotations.*, files.path AS file_path, files.rel_path AS rel_path, patches.seq AS anchor_seq
       FROM annotations
       JOIN files ON files.id = annotations.file_id
       LEFT JOIN patches ON patches.id = annotations.anchor_patch_id
       WHERE annotations.session_id = ? AND annotations.status = 'queued'
         AND annotations.kind = 'finding' AND annotations.audience = 'agent'
       ORDER BY CASE annotations.priority
         WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
         files.rel_path, annotations.start_line, annotations.id`,
      [session]
    );
    const ids: number[] = [];
    const claimed: ClaimedAnnotation[] = [];
    for (const row of rows) {
      const parsed = parseClaimedAnnotationRow(row);
      if (!parsed.ok) throw new StoreFailure(parsed.error);
      ids.push(Number(parsed.value.id));
      claimed.push({ ...parsed.value, state: { kind: "sent", sentAt: now, batchId: batch } });
    }
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(", ");
      this.run(
        `UPDATE annotations SET status = 'sent', sent_at = ?, batch_id = ?, updated_at = ?
         WHERE id IN (${placeholders}) AND status = 'queued'`,
        [now, batch, now, ...ids]
      );
    }
    return claimed;
  }

  private claimQueuedSourceNotesBody(session: SessionId, batch: BatchId, now: number): ClaimedSourceNote[] {
    const rows = this.all(
      `SELECT * FROM source_notes
       WHERE target_session_id = ? AND status = 'queued' AND kind = 'finding' AND audience = 'agent'
       ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
         rel_path, start_line, id`,
      [session]
    );
    const claimed: ClaimedSourceNote[] = [];
    for (const row of rows) {
      const note = parseSourceNoteRow(row);
      const values = recordRow(row, "source_notes");
      const fixIntent = values.fix_intent;
      if (fixIntent !== 0 && fixIntent !== 1) throw corrupt("source_notes", Number(note.id), "fix_intent", "expected 0 or 1");
      claimed.push({
        ...note,
        state: { kind: "sent", sentAt: now, batchId: batch },
        file: { path: note.path, relPath: note.relPath },
        anchorSeq: 0,
        fixIntent: fixIntent === 1,
        checkDisk: false
      });
    }
    if (claimed.length > 0) {
      const ids = claimed.map((note) => Number(note.id));
      const placeholders = ids.map(() => "?").join(", ");
      this.run(
        `UPDATE source_notes SET status = 'sent', sent_at = ?, batch_id = ?, updated_at = ?
         WHERE id IN (${placeholders}) AND status = 'queued'`,
        [now, batch, now, ...ids]
      );
    }
    return claimed;
  }

  private sourceNoteById(id: SourceNoteId): SourceNote {
    const row = this.get("SELECT * FROM source_notes WHERE id = ?", [id]);
    if (!row) throw new StoreFailure({ kind: "NotFound", entity: "source note", id });
    return parseSourceNoteRow(row);
  }

  private reviewSourceByFingerprint(fingerprint: SourceFingerprint): ReviewSourceRecord {
    const row = this.get("SELECT * FROM review_sources WHERE fingerprint = ?", [fingerprint]);
    if (!row) throw new StoreFailure({ kind: "NotFound", entity: "review source", id: fingerprint });
    return parseReviewSourceRow(row);
  }

  private analysisRunById(id: AnalysisRunId): AnalysisRun {
    const row = this.get("SELECT * FROM analysis_runs WHERE id = ?", [id]);
    if (!row) throw new StoreFailure({ kind: "NotFound", entity: "analysis run", id });
    return this.parseAnalysisRun(row);
  }

  private parseAnalysisRun(row: unknown): AnalysisRun {
    const parsed = parseAnalysisRunRow(row);
    const documentCoverage = this.readCoverage("analysis_run_documents", "document_id", parsed.id);
    const commitCoverage = this.readCoverage("analysis_run_commits", "commit_sha", parsed.id);
    return { ...parsed, documentCoverage, commitCoverage };
  }

  private readCoverage(table: "analysis_run_documents" | "analysis_run_commits", idColumn: "document_id" | "commit_sha", runId: AnalysisRunId): CoverageEntry[] {
    return this.all(`SELECT ${idColumn} AS entry_id, status, detail FROM ${table} WHERE run_id = ? ORDER BY ${idColumn}`, [runId])
      .map(parseCoverageRow);
  }

  private insertCoverage(
    table: "analysis_run_documents" | "analysis_run_commits",
    idColumn: "document_id" | "commit_sha",
    runId: AnalysisRunId,
    entries: readonly CoverageEntry[]
  ): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.id.length === 0 || seen.has(entry.id)) {
        throw new StoreFailure({ kind: "InvalidInput", field: "coverage", message: "coverage ids must be non-empty and unique" });
      }
      seen.add(entry.id);
      const fields = coverageDbFields(entry.state);
      this.run(`INSERT INTO ${table} (run_id, ${idColumn}, status, detail) VALUES (?, ?, ?, ?)`, [
        runId,
        entry.id,
        fields.status,
        fields.detail
      ]);
    }
  }

  private annotationById(id: AnnotationId): Annotation {
    const row = this.get("SELECT * FROM annotations WHERE id = ?", [id]);
    if (!row) throw new StoreFailure({ kind: "NotFound", entity: "annotation", id });
    const parsed = parseAnnotationRow(row);
    if (!parsed.ok) throw new StoreFailure(parsed.error);
    return parsed.value;
  }

  private requireFileInSession(id: FileId, session: SessionId): void {
    const row = this.get("SELECT session_id FROM files WHERE id = ?", [id]);
    if (!row || typeof row !== "object" || !("session_id" in row)) {
      throw new StoreFailure({ kind: "NotFound", entity: "file", id });
    }
    if (row.session_id !== session) {
      throw new StoreFailure({
        kind: "InvalidInput",
        field: "fileId",
        message: `file ${id} does not belong to session ${session}`
      });
    }
  }

  private requireSession(id: SessionId): void {
    if (Number(this.scalar("SELECT COUNT(*) FROM sessions WHERE id = ?", [id]) ?? 0) !== 1) {
      throw new StoreFailure({ kind: "NotFound", entity: "session", id });
    }
  }

  private requireAnchorForFile(anchor: Anchor, file: FileId, session: SessionId): void {
    if (anchor.patchId === null) return;
    const row = this.get("SELECT file_id, session_id FROM patches WHERE id = ?", [anchor.patchId]);
    if (!row || typeof row !== "object") {
      throw new StoreFailure({ kind: "NotFound", entity: "anchor patch", id: anchor.patchId });
    }
    const values = row as Record<string, unknown>;
    if (values.file_id !== file || values.session_id !== session) {
      throw new StoreFailure({
        kind: "InvalidInput",
        field: "anchor.patchId",
        message: `patch ${anchor.patchId} is not a version of file ${file} in session ${session}`
      });
    }
  }

  private readMany<T>(sql: string, params: SqlParams, parse: (row: unknown) => Result<T>): Result<T[]> {
    return this.write(() => {
      const values: T[] = [];
      for (const row of this.all(sql, params)) {
        const parsed = parse(row);
        if (!parsed.ok) throw new StoreFailure(parsed.error);
        values.push(parsed.value);
      }
      return values;
    });
  }

  private transaction<T>(body: () => T): Result<T> {
    return this.write(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const value = body();
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    });
  }

  private write<T>(body: () => T): Result<T> {
    try {
      return ok(body());
    } catch (error) {
      if (error instanceof StoreFailure) return err(error.error);
      return err(sqliteError(error));
    }
  }

  private run(sql: string, params: SqlParams) {
    return this.db.prepare(sql).run(...params);
  }

  private get(sql: string, params: SqlParams): unknown | undefined {
    return this.db.prepare(sql).get(...params);
  }

  private all(sql: string, params: SqlParams): unknown[] {
    return this.db.prepare(sql).all(...params);
  }

  private scalar(sql: string, params: SqlParams): string | number | null {
    const row = this.get(sql, params);
    if (!row || typeof row !== "object") return null;
    const values = Object.values(row);
    const value = values[0];
    return typeof value === "string" || typeof value === "number" ? value : null;
  }
}

export function checkedSessionId(value: string): Result<SessionId> {
  return sessionId(value);
}

export function checkedBatchId(value: string): Result<BatchId> {
  return batchId(value);
}

export function checkedContentHash(value: string): Result<ContentHash> {
  return contentHash(value);
}

export { hashContent };

class StoreFailure extends Error {
  readonly error: import("./errors.ts").StoreError;

  constructor(error: import("./errors.ts").StoreError) {
    super(errorMessage(error));
    this.error = error;
  }
}

function applyMigrations(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: unknown } | undefined;
  const current = typeof row?.value === "string" ? Number(row.value) : 0;
  if (!Number.isInteger(current) || current < 0) {
    throw new StoreFailure({ kind: "CorruptRow", table: "meta", id: "schema_version", field: "value", message: "expected migration number" });
  }
  if (current > schemaVersion) {
    throw new StoreFailure({
      kind: "CorruptRow",
      table: "meta",
      id: "schema_version",
      field: "value",
      message: `database schema ${current} is newer than code schema ${schemaVersion}`
    });
  }
  for (let index = current; index < migrations.length; index++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migrations[index]);
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(index + 1));
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}

function freshnessLookup(source: ReadonlyMap<FileId, ContentHash> | Record<number, string>, id: FileId): string | undefined {
  const maybeMap = source as ReadonlyMap<FileId, ContentHash>;
  if (typeof maybeMap.get === "function") return maybeMap.get(id);
  return (source as Record<number, string>)[Number(id)];
}

function parseReviewSourceRow(value: unknown): ReviewSourceRecord {
  const row = recordRow(value, "review_sources");
  const fingerprint = stringField(row, "fingerprint", "review_sources");
  const checkedFingerprint = checkedSourceFingerprint(fingerprint);
  if (!checkedFingerprint.ok) throw new StoreFailure(checkedFingerprint.error);
  const descriptor = jsonField(row, "descriptor_json", "review_sources");
  const source = parseReviewSource(descriptor);
  if (!source.ok) throw new StoreFailure(source.error);
  if (!isHistoryMode(row.history_mode)) {
    throw corrupt("review_sources", fingerprint, "history_mode", "expected squashed or perCommit");
  }
  return {
    fingerprint: checkedFingerprint.value,
    source: source.value,
    historyMode: row.history_mode,
    createdAt: integerField(row, "created_at", "review_sources", fingerprint)
  };
}

function parseSourceNoteRow(value: unknown): SourceNote {
  const row = recordRow(value, "source_notes");
  const rawId = integerField(row, "id", "source_notes", null);
  const id = checkedSourceNoteId(rawId);
  if (!id.ok) throw new StoreFailure(id.error);
  const rawFingerprint = stringField(row, "source_fingerprint", "source_notes", rawId);
  const fingerprint = checkedSourceFingerprint(rawFingerprint);
  if (!fingerprint.ok) throw new StoreFailure(fingerprint.error);
  const rawSession = stringField(row, "target_session_id", "source_notes", rawId);
  const targetSessionId = sessionId(rawSession);
  if (!targetSessionId.ok) throw new StoreFailure(targetSessionId.error);
  const rawDocument = stringField(row, "document_id", "source_notes", rawId);
  const documentId = checkedDocumentId(rawDocument);
  if (!documentId.ok) throw new StoreFailure(documentId.error);
  const rawHash = stringField(row, "anchor_hash", "source_notes", rawId);
  const hash = contentHash(rawHash);
  if (!hash.ok) throw new StoreFailure(hash.error);
  const rawStart = integerField(row, "start_line", "source_notes", rawId);
  const rawEnd = integerField(row, "end_line", "source_notes", rawId);
  const start = anchorLine(rawStart);
  const end = anchorLine(rawEnd);
  if (!start.ok) throw new StoreFailure(start.error);
  if (!end.ok) throw new StoreFailure(end.error);
  if (rawEnd < rawStart) throw corrupt("source_notes", rawId, "end_line", "expected end_line >= start_line");
  const role = parseReviewNoteRoleFields(row, rawId);
  const state = parseSourceNoteState(row, rawId);
  return {
    id: id.value,
    sourceFingerprint: fingerprint.value,
    targetSessionId: targetSessionId.value,
    documentId: documentId.value,
    path: stringField(row, "path", "source_notes", rawId),
    relPath: stringField(row, "rel_path", "source_notes", rawId),
    anchor: { hash: hash.value, start: start.value, end: end.value },
    snippet: plainStringField(row, "snippet", "source_notes", rawId),
    comment: plainStringField(row, "comment", "source_notes", rawId),
    role,
    state,
    createdAt: integerField(row, "created_at", "source_notes", rawId),
    updatedAt: integerField(row, "updated_at", "source_notes", rawId)
  };
}

function parseReviewNoteRoleFields(row: Record<string, unknown>, id: number): ReviewNoteRole {
  if (row.kind === "finding" && isPriority(row.priority) && (row.audience === "agent" || row.audience === "human")) {
    return { kind: "finding", priority: row.priority, audience: row.audience };
  }
  if (row.kind === "callout" && row.priority === null && row.audience === "human") {
    return { kind: "callout", audience: "human" };
  }
  throw corrupt("source_notes", id, "role", "expected a prioritized finding or human callout");
}

function parseSourceNoteState(row: Record<string, unknown>, id: number): import("./rows.ts").AnnotationState {
  if (row.status === "draft" || row.status === "queued") {
    if (row.sent_at !== null || row.batch_id !== null) throw corrupt("source_notes", id, "status", "unsent note carries delivery metadata");
    return { kind: row.status };
  }
  if (row.status !== "sent") throw corrupt("source_notes", id, "status", "expected draft, queued, or sent");
  const sentAt = integerField(row, "sent_at", "source_notes", id);
  const rawBatch = stringField(row, "batch_id", "source_notes", id);
  const checkedBatch = batchId(rawBatch);
  if (!checkedBatch.ok) throw new StoreFailure(checkedBatch.error);
  return { kind: "sent", sentAt, batchId: checkedBatch.value };
}

function parseReviewOutcomeRow(value: unknown): ReviewOutcome {
  const row = recordRow(value, "review_outcomes");
  const rawFingerprint = stringField(row, "source_fingerprint", "review_outcomes");
  const fingerprint = checkedSourceFingerprint(rawFingerprint);
  if (!fingerprint.ok) throw new StoreFailure(fingerprint.error);
  if (!isVerdict(row.verdict)) throw corrupt("review_outcomes", rawFingerprint, "verdict", "expected review verdict");
  return {
    sourceFingerprint: fingerprint.value,
    verdict: row.verdict,
    recordedAt: integerField(row, "recorded_at", "review_outcomes", rawFingerprint)
  };
}

function parseAnalysisRunRow(value: unknown): Omit<AnalysisRun, "documentCoverage" | "commitCoverage"> {
  const row = recordRow(value, "analysis_runs");
  const rawId = stringField(row, "id", "analysis_runs");
  const id = checkedAnalysisRunId(rawId);
  if (!id.ok) throw new StoreFailure(id.error);
  const rawFingerprint = stringField(row, "source_fingerprint", "analysis_runs", rawId);
  const fingerprint = checkedSourceFingerprint(rawFingerprint);
  if (!fingerprint.ok) throw new StoreFailure(fingerprint.error);
  if (!isAnalysisMode(row.mode)) throw corrupt("analysis_runs", rawId, "mode", "expected analysis mode");
  if (!isAnalysisStatus(row.status)) throw corrupt("analysis_runs", rawId, "status", "expected analysis status");
  const model = parseModelSelection({
    provider: row.provider,
    modelId: row.model_id,
    thinkingLevel: row.thinking_level
  });
  if (!model.ok) throw new StoreFailure(model.error);
  const reviewVerdict = row.review_verdict === null ? null : row.review_verdict;
  if (reviewVerdict !== null && !isVerdict(reviewVerdict)) {
    throw corrupt("analysis_runs", rawId, "review_verdict", "expected nullable review verdict");
  }
  const rawOutputValue = row.output_json === null ? null : jsonField(row, "output_json", "analysis_runs", rawId);
  const output = rawOutputValue === null ? null : parseAnalysisResult(row.mode, rawOutputValue);
  if (output !== null && !output.ok) throw new StoreFailure(output.error);
  const manifest = parseAnalysisManifestEvidence(jsonField(row, "manifest_json", "analysis_runs", rawId));
  if (!manifest.ok) throw new StoreFailure(manifest.error);
  return {
    id: id.value,
    sourceFingerprint: fingerprint.value,
    mode: row.mode,
    model: model.value,
    promptVersion: stringField(row, "prompt_version", "analysis_runs", rawId),
    focus: nullableStringField(row, "focus", "analysis_runs", rawId),
    manifest: manifest.value,
    status: row.status,
    output: output?.value ?? null,
    rawOutput: nullableStringField(row, "raw_output", "analysis_runs", rawId),
    reviewVerdict,
    error: nullableStringField(row, "error", "analysis_runs", rawId),
    startedAt: integerField(row, "started_at", "analysis_runs", rawId),
    completedAt: nullableIntegerField(row, "completed_at", "analysis_runs", rawId)
  };
}

function parseCoverageRow(value: unknown): CoverageEntry {
  const row = recordRow(value, "analysis_coverage");
  const id = stringField(row, "entry_id", "analysis_coverage");
  const detail = nullableStringField(row, "detail", "analysis_coverage", id);
  switch (row.status) {
    case "included":
    case "summarized":
      if (detail !== null) throw corrupt("analysis_coverage", id, "detail", `${row.status} must not carry detail`);
      return { id, state: { kind: row.status } };
    case "excluded":
      if (detail === null) throw corrupt("analysis_coverage", id, "detail", "excluded requires a reason");
      return { id, state: { kind: "excluded", reason: detail } };
    case "failed":
      if (detail === null) throw corrupt("analysis_coverage", id, "detail", "failed requires an error");
      return { id, state: { kind: "failed", error: detail } };
    default:
      throw corrupt("analysis_coverage", id, "status", "expected coverage status");
  }
}

function coverageDbFields(state: CoverageState): { status: string; detail: string | null } {
  switch (state.kind) {
    case "included":
    case "summarized":
      return { status: state.kind, detail: null };
    case "excluded":
      if (state.reason.length === 0) throw new StoreFailure({ kind: "InvalidInput", field: "coverage.reason", message: "expected non-empty reason" });
      return { status: "excluded", detail: state.reason };
    case "failed":
      if (state.error.length === 0) throw new StoreFailure({ kind: "InvalidInput", field: "coverage.error", message: "expected non-empty error" });
      return { status: "failed", detail: state.error };
  }
}

function validateCoverageForCompletion(
  mode: AnalysisMode,
  documentCoverage: readonly CoverageEntry[],
  commitCoverage: readonly CoverageEntry[]
): void {
  const coverage = [...documentCoverage, ...commitCoverage];
  if (coverage.some((entry) => entry.state.kind === "failed")) {
    throw new StoreFailure({ kind: "InvalidInput", field: "coverage", message: "failed coverage cannot complete a run" });
  }
  if (mode === "narrative" && coverage.some((entry) => entry.state.kind === "excluded")) {
    throw new StoreFailure({ kind: "InvalidInput", field: "coverage", message: "narrative completion requires full coverage" });
  }
}

function recordRow(value: unknown, table: string): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw corrupt(table, null, "row", "expected object row");
}

function stringField(row: Record<string, unknown>, field: string, table: string, id: string | number | null = null): string {
  const value = row[field];
  if (typeof value === "string" && value.length > 0) return value;
  throw corrupt(table, id, field, "expected non-empty string");
}

function plainStringField(row: Record<string, unknown>, field: string, table: string, id: string | number | null): string {
  const value = row[field];
  if (typeof value === "string") return value;
  throw corrupt(table, id, field, "expected string");
}

function nullableStringField(row: Record<string, unknown>, field: string, table: string, id: string | number | null): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw corrupt(table, id, field, "expected nullable string");
}

function integerField(row: Record<string, unknown>, field: string, table: string, id: string | number | null): number {
  const value = row[field];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw corrupt(table, id, field, "expected integer");
}

function nullableIntegerField(row: Record<string, unknown>, field: string, table: string, id: string | number | null): number | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw corrupt(table, id, field, "expected nullable integer");
}

function jsonField(row: Record<string, unknown>, field: string, table: string, id: string | number | null = null): unknown {
  const raw = stringField(row, field, table, id);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw corrupt(table, id, field, error instanceof Error ? error.message : "invalid JSON");
  }
}

function corrupt(table: string, id: string | number | null, field: string, message: string): StoreFailure {
  return new StoreFailure({ kind: "CorruptRow", table, id, field, message });
}

function checkedSourceNoteIdOrThrow(value: number): SourceNoteId {
  const id = checkedSourceNoteId(value);
  if (!id.ok) throw new StoreFailure(id.error);
  return id.value;
}

function sourceFreshnessLookup(
  source: ReadonlyMap<DocumentId, ContentHash> | Record<string, string>,
  id: DocumentId
): string | undefined {
  const map = source as ReadonlyMap<DocumentId, ContentHash>;
  return typeof map.get === "function" ? map.get(id) : (source as Record<string, string>)[String(id)];
}
