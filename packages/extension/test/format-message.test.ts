import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorLine,
  checkedBatchId,
  checkedSessionId,
  hashContent,
  type AnnotationId,
  type ClaimedAnnotation,
  type FileId,
  type PatchId,
  type Result,
  type ReviewNoteRole,
  type Seq
} from "@pi-patches/store";
import { formatBatch } from "../src/format-message.ts";

test("formatBatch orders comments by file path, start line, and annotation id", () => {
  const message = formatBatch([
    claimed({ id: 3, relPath: "src/b.ts", start: 4 }),
    claimed({ id: 2, relPath: "src/a.ts", start: 8 }),
    claimed({ id: 1, relPath: "src/a.ts", start: 2 })
  ]);

  assert.ok(message.indexOf("## 1. src/a.ts:2") < message.indexOf("## 2. src/a.ts:8"));
  assert.ok(message.indexOf("## 2. src/a.ts:8") < message.indexOf("## 3. src/b.ts:4"));
});

test("formatBatch widens code fences, uses pi language names, and reports claim-time staleness", () => {
  const row = claimed({
    relPath: "src/example.ts",
    start: 4,
    end: 5,
    snippet: "const fence = ```;\nconsole.log(fence);",
    anchorSeq: 3 as Seq,
    anchorHash: hashContent("old\n")
  });

  const message = formatBatch([row], {
    currentHashes: new Map([[row.file.path, hashContent("new\n")]])
  });

  assert.match(message, /## 1\. src\/example\.ts:4-5/);
  assert.match(message, /\(note: anchored @ patch 3; file has changed since\)/);
  assert.match(message, /````typescript\nconst fence = ```;\nconsole\.log\(fence\);\n````/);
});

test("formatBatch sorts findings by priority and carries explicit fix intent", () => {
  const message = formatBatch([
    claimed({ id: 1, relPath: "p3.ts", role: { kind: "finding", priority: "P3", audience: "agent" } }),
    claimed({ id: 2, relPath: "p0.ts", role: { kind: "finding", priority: "P0", audience: "agent" }, fixIntent: true }),
    claimed({ id: 3, relPath: "p1.ts", role: { kind: "finding", priority: "P1", audience: "agent" } })
  ]);

  assert.ok(message.indexOf("p0.ts") < message.indexOf("p1.ts"));
  assert.ok(message.indexOf("p1.ts") < message.indexOf("p3.ts"));
  assert.match(message, /Fix each item in priority order/);
  assert.match(message, /p0\.ts:1 \[P0\]/);
});

function claimed(overrides: Partial<{
  id: number;
  relPath: string;
  start: number;
  end: number;
  snippet: string;
  comment: string;
  anchorSeq: Seq | 0;
  anchorHash: ClaimedAnnotation["anchor"]["hash"];
  role: ReviewNoteRole;
  fixIntent: boolean;
}> = {}): ClaimedAnnotation {
  const sessionId = unwrap(checkedSessionId("format-test-session"));
  const relPath = overrides.relPath ?? "src/example.ts";
  const start = unwrap(anchorLine(overrides.start ?? 1));
  const end = unwrap(anchorLine(overrides.end ?? overrides.start ?? 1));
  const batchId = unwrap(checkedBatchId("format-test-batch"));
  return {
    id: (overrides.id ?? 1) as AnnotationId,
    sessionId,
    fileId: 1 as FileId,
    anchor: {
      patchId: 7 as PatchId,
      hash: overrides.anchorHash ?? hashContent("anchor\n"),
      start,
      end
    },
    snippet: overrides.snippet ?? "const value = 1;",
    comment: overrides.comment ?? "Review this.",
    role: overrides.role ?? { kind: "finding", priority: "P2", audience: "agent" },
    state: { kind: "sent", sentAt: 1, batchId },
    createdAt: 1,
    updatedAt: 1,
    file: {
      id: 1 as FileId,
      path: `/tmp/${relPath}`,
      relPath
    },
    anchorSeq: overrides.anchorSeq ?? 1 as Seq,
    fixIntent: overrides.fixIntent ?? false,
    checkDisk: true
  };
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
