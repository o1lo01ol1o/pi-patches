import assert from "node:assert/strict";
import { test } from "node:test";
import {
  annotationId,
  annotationStatusDbFields,
  anchorLine,
  baselineDbFields,
  batchId,
  fileId,
  hashContent,
  parseAnnotationRow,
  parseClaimedAnnotationRow,
  parseFileRow,
  parsePatchRow,
  parseSessionRow,
  patchId,
  printAnnotationRow,
  printFileRow,
  printPatchRow,
  printSessionRow,
  seq,
  sessionId,
  type Annotation,
  type ContentHash,
  type FileRecord,
  type PatchRecord,
  type SessionRecord
} from "../src/rows.ts";
import type { Result, StoreError } from "../src/errors.ts";

test("row printers and parsers round-trip representative domain records", () => {
  const session = makeSession();
  assert.deepEqual(unwrap(parseSessionRow(printSessionRow(session))), session);

  const file = makeFile({ baseline: { kind: "present", content: "old\n", hash: hashContent("old\n") } });
  assert.deepEqual(unwrap(parseFileRow(printFileRow(file))), file);

  const absentFile = makeFile({ id: unwrap(fileId(2)), baseline: { kind: "absent" }, firstTool: "write" });
  assert.deepEqual(unwrap(parseFileRow(printFileRow(absentFile))), absentFile);

  const patch = makePatch(file);
  assert.deepEqual(unwrap(parsePatchRow(printPatchRow(patch))), patch);

  const annotation = makeAnnotation(file, patch);
  assert.deepEqual(unwrap(parseAnnotationRow(printAnnotationRow(annotation))), annotation);

  const claimed = unwrap(
    parseClaimedAnnotationRow({
      ...printAnnotationRow(annotation),
      file_path: file.path,
      rel_path: file.relPath,
      anchor_seq: patch.seq
    })
  );
  assert.equal(claimed.file.path, file.path);
  assert.equal(claimed.file.relPath, file.relPath);
  assert.equal(claimed.anchorSeq, patch.seq);
  assert.equal(claimed.state.kind, "sent");
});

test("row printers and parsers round-trip generated domain variants", () => {
  const baselines: FileRecord["baseline"][] = [
    { kind: "absent" },
    { kind: "present", content: "", hash: hashContent("") },
    { kind: "present", content: "alpha\nbeta\n", hash: hashContent("alpha\nbeta\n") }
  ];
  baselines.forEach((baseline, index) => {
    const file = makeFile({
      id: unwrap(fileId(index + 1)),
      baseline,
      firstTool: baseline.kind === "absent" ? "write" : "edit"
    });
    assert.deepEqual(unwrap(parseFileRow(printFileRow(file))), file);
  });

  const file = makeFile();
  const patch = makePatch(file);
  const states: Annotation["state"][] = [
    { kind: "draft" },
    { kind: "queued" },
    { kind: "sent", sentAt: 24, batchId: unwrap(batchId("row-generated-batch")) }
  ];
  states.forEach((state, index) => {
    const annotation = makeAnnotation(file, patch, {
      id: unwrap(annotationId(index + 1)),
      state
    });
    assert.deepEqual(unwrap(parseAnnotationRow(printAnnotationRow(annotation))), annotation);
  });
});

test("row parsers reject corrupt rows with structured CorruptRow errors", () => {
  assertCorrupt(parseSessionRow(null), {
    table: "unknown",
    id: null,
    field: "row",
    message: "expected object row"
  });

  assertCorrupt(parseFileRow({ ...printFileRow(makeFile({ baseline: { kind: "absent" } })), baseline_content: "ghost" }), {
    table: "files",
    id: 1,
    field: "baseline",
    message: "absent baseline must not carry content or hash"
  });

  assertCorrupt(parsePatchRow({ ...printPatchRow(makePatch(makeFile())), pre_hash: "not-a-hash" }), {
    table: "patches",
    id: 1,
    field: "pre_hash"
  });

  assertCorrupt(parsePatchRow({ ...printPatchRow(makePatch(makeFile())), post_hash: null }), {
    table: "patches",
    id: 1,
    field: "post_hash",
    message: "expected hash string"
  });

  assertCorrupt(parseAnnotationRow({ ...printAnnotationRow(makeAnnotation(makeFile(), makePatch(makeFile()))), batch_id: null }), {
    table: "annotations",
    id: 1,
    field: "batch_id",
    message: "sent annotation needs batch id"
  });

  assertCorrupt(
    parseAnnotationRow({
      ...printAnnotationRow(makeAnnotation(makeFile(), makePatch(makeFile()), { state: { kind: "draft" } })),
      sent_at: 12
    }),
    {
      table: "annotations",
      id: 1,
      field: "status",
      message: "unsent annotation must not carry sent_at or batch_id"
    }
  );

  assertCorrupt(
    parseAnnotationRow({
      ...printAnnotationRow(makeAnnotation(makeFile(), makePatch(makeFile()), { state: { kind: "queued" } })),
      batch_id: "queued-batch"
    }),
    {
      table: "annotations",
      id: 1,
      field: "status",
      message: "unsent annotation must not carry sent_at or batch_id"
    }
  );

  assertCorrupt(
    parseClaimedAnnotationRow({
      ...printAnnotationRow(makeAnnotation(makeFile(), makePatch(makeFile()))),
      file_path: "/tmp/example.ts",
      rel_path: "example.ts",
      anchor_seq: 0
    }),
    {
      table: "annotations",
      id: 1,
      field: "anchor_seq"
    }
  );

  assertCorrupt(parseSessionRow({ ...printSessionRow(makeSession()), cwd: 42 }), {
    table: "sessions",
    id: null,
    field: "cwd",
    message: "expected string"
  });

  assertCorrupt(parseFileRow({ ...printFileRow(makeFile()), baseline_hash: hashContent("different") }), {
    table: "files",
    id: 1,
    field: "baseline_hash"
  });

  assertCorrupt(parsePatchRow({ ...printPatchRow(makePatch(makeFile())), unified_patch: null }), {
    table: "patches",
    id: 1,
    field: "unified_patch",
    message: "expected string"
  });

  assertCorrupt(
    parseAnnotationRow({ ...printAnnotationRow(makeAnnotation(makeFile(), makePatch(makeFile()))), start_line: 3, end_line: 2 }),
    { table: "annotations", id: 1, field: "end_line", message: "expected end_line >= start_line" }
  );
});

function makeSession(): SessionRecord {
  return {
    id: unwrap(sessionId("row-session")),
    cwd: "/tmp/project",
    sessionFile: "/tmp/project/session_row-session.jsonl",
    parentSessionId: null,
    startedAt: 10,
    lastEventAt: 11,
    endedAt: null
  };
}

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: overrides.id ?? unwrap(fileId(1)),
    sessionId: overrides.sessionId ?? makeSession().id,
    path: overrides.path ?? "/tmp/project/example.ts",
    relPath: overrides.relPath ?? "example.ts",
    baseline: overrides.baseline ?? { kind: "present", content: "old\n", hash: hashContent("old\n") },
    firstTouchedAt: overrides.firstTouchedAt ?? 12,
    firstTool: overrides.firstTool ?? "edit"
  };
}

function makePatch(file: FileRecord): PatchRecord {
  return {
    id: unwrap(patchId(1)),
    sessionId: file.sessionId,
    fileId: file.id,
    seq: unwrap(seq(1)),
    tool: "edit",
    toolCallId: "call-1",
    unifiedPatch: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
    displayDiff: "-1 old\n+1 new",
    firstChangedLine: 1,
    preHash: hashContent("old\n"),
    postHash: hashContent("new\n"),
    createdAt: 13
  };
}

function makeAnnotation(file: FileRecord, patch: PatchRecord, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: overrides.id ?? unwrap(annotationId(1)),
    sessionId: file.sessionId,
    fileId: file.id,
    anchor: overrides.anchor ?? {
      patchId: patch.id,
      hash: patch.postHash as ContentHash,
      start: unwrap(anchorLine(1)),
      end: unwrap(anchorLine(1))
    },
    snippet: overrides.snippet ?? "new",
    comment: overrides.comment ?? "Looks good",
    role: overrides.role ?? { kind: "finding", priority: "P2", audience: "agent" },
    state: overrides.state ?? { kind: "sent", sentAt: 14, batchId: unwrap(batchId("row-batch")) },
    createdAt: overrides.createdAt ?? 13,
    updatedAt: overrides.updatedAt ?? 14
  };
}

function assertCorrupt<T>(
  result: Result<T>,
  expected: { table: string; id: string | number | null; field: string; message?: string }
): void {
  if (result.ok) assert.fail(`expected CorruptRow, got ${JSON.stringify(result.value)}`);
  const error = result.error;
  assert.equal(error.kind, "CorruptRow");
  assert.equal(error.table, expected.table);
  assert.equal(error.id, expected.id);
  assert.equal(error.field, expected.field);
  if (expected.message !== undefined) assert.equal(error.message, expected.message);
}

function unwrap<T>(result: Result<T, StoreError>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
