import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  baselineFromContent,
  anchorLine,
  checkedAnalysisRunId,
  checkedBatchId,
  checkedDocumentId,
  checkedSessionId,
  hashReviewSource,
  hashContent,
  PatchStore,
  type ContentHash,
  type Result
} from "../src/index.ts";
import { migrations, schemaVersion } from "../src/schema.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));

test("fresh and migrated databases have the same normalized schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-schema-"));
  try {
    const freshPath = join(dir, "fresh.db");
    const migratedPath = join(dir, "migrated.db");

    const fresh = unwrap(PatchStore.open(freshPath, { create: true }));
    unwrap(fresh.close());

    const seed = new DatabaseSync(migratedPath);
    seed.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    seed.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '0')").run();
    seed.close();
    const migrated = unwrap(PatchStore.open(migratedPath));
    unwrap(migrated.close());

    assert.equal(readSchemaVersion(freshPath), schemaVersion);
    assert.equal(readSchemaVersion(migratedPath), schemaVersion);
    assert.deepEqual(normalizedSchema(freshPath), normalizedSchema(migratedPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("committed fixtures/v1.db parses into checked domain records", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-v1-golden-"));
  try {
    const dbPath = join(dir, "v1.db");
    copyFileSync(join(thisDir, "fixtures", "v1.db"), dbPath);
    const store = unwrap(PatchStore.open(dbPath));
    try {
      const session = unwrap(checkedSessionId("019f-v1-fixture-session"));
      const sessions = unwrap(store.listSessions());
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, session);
      assert.equal(sessions[0].cwd, "/fixture/project");

      const files = unwrap(store.getFiles(session));
      assert.equal(files.length, 2);
      assert.deepEqual(files.map((file) => file.relPath), ["created.ts", "present.ts"]);
      assert.equal(files[0].baseline.kind, "absent");
      assert.equal(files[1].baseline.kind, "present");

      const patches = unwrap(store.getPatches(session));
      assert.equal(patches.length, 1);
      assert.equal(patches[0].tool, "edit");
      assert.equal(patches[0].preHash, hashContent("old\n"));
      assert.equal(patches[0].postHash, hashContent("new\n"));

      const annotations = unwrap(store.getAnnotations(session));
      assert.equal(annotations.length, 1);
      assert.equal(annotations[0].state.kind, "sent");
      if (annotations[0].state.kind === "sent") {
        assert.equal(annotations[0].state.batchId, unwrap(checkedBatchId("019f-v1-fixture-batch")));
        assert.equal(annotations[0].state.sentAt, 17);
      }
    } finally {
      unwrap(store.close());
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v1 database fixture rows parse into checked domain records", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-v1-fixture-"));
  try {
    const dbPath = join(dir, "v1.db");
    const session = unwrap(checkedSessionId("019f-v1-fixture-session"));
    const batch = unwrap(checkedBatchId("019f-v1-fixture-batch"));
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(schemaVersion));
      for (const migration of migrations) db.exec(migration);
      db.prepare(
        `INSERT INTO sessions
           (id, cwd, session_file, parent_session_id, started_at, last_event_at, ended_at)
         VALUES (?, ?, ?, NULL, ?, ?, NULL)`
      ).run(session, dir, join(dir, "session_019f-v1-fixture-session.jsonl"), 10, 11);
      db.prepare(
        `INSERT INTO files
           (id, session_id, path, rel_path, baseline_content, baseline_hash, baseline_missing, first_touched_at, first_tool)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(1, session, join(dir, "present.ts"), "present.ts", "old\n", hashContent("old\n"), 0, 12, "edit");
      db.prepare(
        `INSERT INTO files
           (id, session_id, path, rel_path, baseline_content, baseline_hash, baseline_missing, first_touched_at, first_tool)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
      ).run(2, session, join(dir, "created.ts"), "created.ts", 1, 13, "write");
      db.prepare(
        `INSERT INTO patches
           (id, session_id, file_id, seq, tool, tool_call_id, unified_patch, display_diff,
            first_changed_line, pre_hash, post_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        1,
        session,
        1,
        1,
        "edit",
        "call-1",
        "--- a/present.ts\n+++ b/present.ts\n@@ -1 +1 @@\n-old\n+new\n",
        "-1 old\n+1 new",
        1,
        hashContent("old\n"),
        hashContent("new\n"),
        14
      );
      db.prepare(
        `INSERT INTO annotations
           (id, session_id, file_id, anchor_patch_id, anchor_hash, start_line, end_line,
            snippet, comment, status, created_at, updated_at, sent_at, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(1, session, 1, 1, hashContent("new\n"), 1, 1, "new", "Looks good", "sent", 15, 16, 17, batch);
    } finally {
      db.close();
    }

    const store = unwrap(PatchStore.open(dbPath));
    try {
      const sessions = unwrap(store.listSessions());
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, session);
      assert.equal(sessions[0].endedAt, null);

      const files = unwrap(store.getFiles(session));
      assert.equal(files.length, 2);
      assert.equal(files[0].baseline.kind, "absent");
      assert.equal(files[1].baseline.kind, "present");
      if (files[1].baseline.kind === "present") {
        assert.equal(files[1].baseline.content, "old\n");
        assert.equal(files[1].baseline.hash, hashContent("old\n"));
      }

      const patches = unwrap(store.getPatches(session));
      assert.equal(patches.length, 1);
      assert.equal(patches[0].seq, 1);
      assert.equal(patches[0].tool, "edit");
      assert.equal(patches[0].preHash, hashContent("old\n"));
      assert.equal(patches[0].postHash, hashContent("new\n"));

      const annotations = unwrap(store.getAnnotations(session));
      assert.equal(annotations.length, 1);
      assert.equal(annotations[0].state.kind, "sent");
      if (annotations[0].state.kind === "sent") {
        assert.equal(annotations[0].state.batchId, batch);
        assert.equal(annotations[0].state.sentAt, 17);
      }
    } finally {
      unwrap(store.close());
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records baseline and monotonic patch seq across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-store-"));
  try {
    const dbPath = join(dir, "patches.db");
    const session = unwrap(checkedSessionId("019f-test-session"));
    const first = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(first.upsertSession(session, dir, null, 10));
    const file = unwrap(first.ensureFile(session, join(dir, "hello.txt"), "hello.txt", baselineFromContent(null), "write", 11));
    assert.equal(file.baseline.kind, "absent");
    const patch1 = unwrap(
      first.addPatch({
        sessionId: session,
        fileId: file.id,
        tool: "write",
        toolCallId: "call-1",
        unifiedPatch: "--- a/hello.txt\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hi\n",
        displayDiff: "+1 hi",
        firstChangedLine: 1,
        preHash: null,
        postHash: hashContent("hi\n"),
        createdAt: 12
      })
    );
    assert.equal(patch1.seq, 1);
    unwrap(first.close());

    const second = unwrap(PatchStore.open(dbPath));
    const patch2 = unwrap(
      second.addPatch({
        sessionId: session,
        fileId: file.id,
        tool: "edit",
        toolCallId: "call-2",
        unifiedPatch: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n",
        displayDiff: "-1 hi\n+1 hello",
        firstChangedLine: 1,
        preHash: hashContent("hi\n"),
        postHash: hashContent("hello\n"),
        createdAt: 13
      })
    );
    assert.equal(patch2.seq, 2);
    unwrap(second.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("baseline sum illegal mixed state is rejected by sqlite check", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-check-"));
  try {
    const dbPath = join(dir, "patches.db");
    const session = unwrap(checkedSessionId("019f-check-session"));
    const store = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(store.upsertSession(session, dir, null));
    unwrap(store.close());

    const db = new DatabaseSync(dbPath);
    assert.throws(() => {
      db.prepare(
        `INSERT INTO files
           (session_id, path, rel_path, baseline_content, baseline_hash, baseline_missing, first_touched_at, first_tool)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(session, join(dir, "bad.txt"), "bad.txt", "content", null, 0, 1, "write");
    }, /CHECK constraint failed/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("annotation sent sum illegal mixed state is rejected by sqlite check", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-ann-check-"));
  try {
    const dbPath = join(dir, "patches.db");
    const session = unwrap(checkedSessionId("019f-ann-check-session"));
    const store = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(store.upsertSession(session, dir, null));
    const file = unwrap(store.ensureFile(session, join(dir, "a.ts"), "a.ts", baselineFromContent("const a = 1;\n"), "edit"));
    unwrap(store.close());

    const db = new DatabaseSync(dbPath);
    assert.throws(() => {
      db.prepare(
        `INSERT INTO annotations
           (session_id, file_id, anchor_hash, start_line, end_line, snippet, comment,
            status, created_at, updated_at, sent_at, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(session, file.id, hashContent("const a = 1;\n"), 1, 1, "const a = 1;", "Review this", "sent", 1, 1, null, null);
    }, /CHECK constraint failed/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("annotation role sum accepts only prioritized findings and human callouts", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-role-check-"));
  try {
    const dbPath = join(dir, "patches.db");
    const session = unwrap(checkedSessionId("019f-role-check-session"));
    const store = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(store.upsertSession(session, dir, null));
    const file = unwrap(store.ensureFile(session, join(dir, "a.ts"), "a.ts", baselineFromContent("a\n"), "edit"));
    unwrap(store.close());

    const db = new DatabaseSync(dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO annotations
           (session_id, file_id, anchor_hash, start_line, end_line, snippet, comment,
            kind, priority, audience, status, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, '', '', ?, ?, ?, 'draft', 1, 1)`
      );
      assert.throws(() => insert.run(session, file.id, hashContent("a\n"), "callout", "P2", "human"), /CHECK constraint failed/);
      assert.throws(() => insert.run(session, file.id, hashContent("a\n"), "callout", null, "agent"), /CHECK constraint failed/);
      assert.throws(() => insert.run(session, file.id, hashContent("a\n"), "finding", null, "agent"), /CHECK constraint failed/);
      insert.run(session, file.id, hashContent("a\n"), "callout", null, "human");
      insert.run(session, file.id, hashContent("a\n"), "finding", "P0", "human");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite rejects every tool, range, status, and sequence constraint violation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-all-checks-"));
  try {
    const dbPath = join(dir, "patches.db");
    const session = unwrap(checkedSessionId("019f-all-checks-session"));
    const store = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(store.upsertSession(session, dir, null));
    const file = unwrap(store.ensureFile(session, join(dir, "valid.ts"), "valid.ts", baselineFromContent("old\n"), "edit"));
    unwrap(
      store.addPatch({
        sessionId: session,
        fileId: file.id,
        tool: "edit",
        toolCallId: "valid-call",
        unifiedPatch: "",
        displayDiff: "",
        firstChangedLine: null,
        preHash: hashContent("old\n"),
        postHash: hashContent("old\n")
      })
    );
    unwrap(store.close());

    const db = new DatabaseSync(dbPath);
    try {
      assert.throws(
        () => db.prepare(
          `INSERT INTO files
             (session_id, path, rel_path, baseline_content, baseline_hash, baseline_missing, first_touched_at, first_tool)
           VALUES (?, ?, ?, ?, ?, 0, 1, 'bash')`
        ).run(session, join(dir, "bad-tool.ts"), "bad-tool.ts", "old\n", hashContent("old\n")),
        /CHECK constraint failed/
      );

      assert.throws(
        () => db.prepare(
          `INSERT INTO patches
             (session_id, file_id, seq, tool, unified_patch, display_diff, created_at)
           VALUES (?, ?, 2, 'bash', '', '', 2)`
        ).run(session, file.id),
        /CHECK constraint failed/
      );

      assert.throws(
        () => db.prepare(
          `INSERT INTO patches
             (session_id, file_id, seq, tool, unified_patch, display_diff, created_at)
           VALUES (?, ?, 1, 'edit', '', '', 2)`
        ).run(session, file.id),
        /UNIQUE constraint failed/
      );

      const insertAnnotation = db.prepare(
        `INSERT INTO annotations
           (session_id, file_id, anchor_hash, start_line, end_line, snippet, comment, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', '', ?, 1, 1)`
      );
      assert.throws(
        () => insertAnnotation.run(session, file.id, hashContent("old\n"), 0, 1, "draft"),
        /CHECK constraint failed/
      );
      assert.throws(
        () => insertAnnotation.run(session, file.id, hashContent("old\n"), 2, 1, "draft"),
        /CHECK constraint failed/
      );
      assert.throws(
        () => insertAnnotation.run(session, file.id, hashContent("old\n"), 1, 1, "reviewed"),
        /CHECK constraint failed/
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queue and claim annotations atomically across connections", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-claim-"));
  try {
    const dbPath = join(dir, "patches.db");
    const session = unwrap(checkedSessionId("019f-claim-session"));
    const batch = unwrap(checkedBatchId("019f-claim-batch"));
    const storeA = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(storeA.upsertSession(session, dir, null));
    const file = unwrap(storeA.ensureFile(session, join(dir, "a.ts"), "a.ts", baselineFromContent("const a = 1;\n"), "edit"));
    const hash = hashContent("const a = 1;\n") as ContentHash;
    const annotation = unwrap(
      storeA.addAnnotation({
        sessionId: session,
        fileId: file.id,
        anchor: { patchId: null, hash, start: unwrap(anchorLine(1)), end: unwrap(anchorLine(1)) },
        snippet: "const a = 1;",
        comment: "Make this clearer."
      })
    );
    assert.equal(annotation.state.kind, "draft");
    const queued = unwrap(storeA.queueAllDrafts(session, new Map([[file.id, hash]])));
    assert.equal(queued.queued.length, 1);
    assert.equal(queued.skippedStale.length, 0);

    const storeB = unwrap(PatchStore.open(dbPath));
    const claimedA = unwrap(storeA.claimQueued(session, batch));
    const claimedB = unwrap(storeB.claimQueued(session, batch));
    assert.equal(claimedA.length, 1);
    assert.equal(claimedA[0].state.kind, "sent");
    assert.equal(claimedB.length, 0);
    unwrap(storeA.close());
    unwrap(storeB.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only fresh drafts queue, and sent annotations are immutable through the API", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-transitions-"));
  try {
    const dbPath = join(dir, "patches.db");
    const session = unwrap(checkedSessionId("019f-transition-session"));
    const batch = unwrap(checkedBatchId("019f-transition-batch"));
    const store = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(store.upsertSession(session, dir, null));
    const file = unwrap(store.ensureFile(session, join(dir, "a.ts"), "a.ts", baselineFromContent("one\ntwo\n"), "edit"));
    const currentHash = hashContent("one\ntwo\n");
    const staleHash = hashContent("old\n");
    const fresh = unwrap(
      store.addAnnotation({
        sessionId: session,
        fileId: file.id,
        anchor: { patchId: null, hash: currentHash, start: unwrap(anchorLine(1)), end: unwrap(anchorLine(1)) },
        snippet: "one",
        comment: "Fresh comment",
        createdAt: 10
      })
    );
    const stale = unwrap(
      store.addAnnotation({
        sessionId: session,
        fileId: file.id,
        anchor: { patchId: null, hash: staleHash, start: unwrap(anchorLine(2)), end: unwrap(anchorLine(2)) },
        snippet: "old",
        comment: "Stale comment",
        createdAt: 11
      })
    );

    const queued = unwrap(store.queueAllDrafts(session, new Map([[file.id, currentHash]])));
    assert.deepEqual(queued.queued.map((annotation) => annotation.id), [fresh.id]);
    assert.deepEqual(queued.skippedStale.map((annotation) => annotation.id), [stale.id]);

    const claimed = unwrap(store.claimQueued(session, batch, 12));
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, fresh.id);
    assert.equal(claimed[0].state.kind, "sent");

    const editSent = unwrap(store.updateAnnotation(fresh.id, "Edited after send", 13));
    assert.equal(editSent.comment, "Fresh comment");
    assert.equal(editSent.state.kind, "sent");
    assert.equal(unwrap(store.deleteAnnotation(fresh.id)), false);

    const drafts = unwrap(store.getAnnotations(session, "draft"));
    assert.deepEqual(drafts.map((annotation) => annotation.id), [stale.id]);
    assert.equal(drafts[0].comment, "Stale comment");
    unwrap(store.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queue preserves human notes and carries submit-and-fix intent on agent findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-role-queue-"));
  try {
    const dbPath = join(dir, "patches.db");
    const session = unwrap(checkedSessionId("019f-role-queue-session"));
    const batch = unwrap(checkedBatchId("019f-role-queue-batch"));
    const store = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(store.upsertSession(session, dir, null));
    const file = unwrap(store.ensureFile(session, join(dir, "a.ts"), "a.ts", baselineFromContent("a\n"), "edit"));
    const anchor = { patchId: null, hash: hashContent("a\n"), start: unwrap(anchorLine(1)), end: unwrap(anchorLine(1)) };
    const agent = unwrap(store.addAnnotation({ sessionId: session, fileId: file.id, anchor, snippet: "a", comment: "fix", role: { kind: "finding", priority: "P1", audience: "agent" } }));
    const human = unwrap(store.addAnnotation({ sessionId: session, fileId: file.id, anchor, snippet: "a", comment: "inspect", role: { kind: "finding", priority: "P2", audience: "human" } }));
    const callout = unwrap(store.addAnnotation({ sessionId: session, fileId: file.id, anchor, snippet: "a", comment: "context", role: { kind: "callout", audience: "human" } }));

    const queued = unwrap(store.queueAllDrafts(session, new Map([[file.id, hashContent("a\n")]]), { fixIntent: true }));
    assert.deepEqual(queued.queued.map((note) => note.id), [agent.id]);
    assert.deepEqual(queued.preservedHumanFindings.map((note) => note.id), [human.id]);
    assert.deepEqual(queued.preservedCallouts.map((note) => note.id), [callout.id]);
    const claimed = unwrap(store.claimQueued(session, batch));
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].fixIntent, true);
    assert.deepEqual(claimed[0].role, { kind: "finding", priority: "P1", audience: "agent" });
    unwrap(store.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review sources, outcomes, analysis runs, and coverage round-trip with invariants", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-analysis-store-"));
  try {
    const store = unwrap(PatchStore.open(join(dir, "patches.db"), { create: true }));
    const source = { kind: "workingTree", base: "HEAD" } as const;
    const fingerprint = hashReviewSource({ source, head: "abc", documents: ["a.ts"] });
    unwrap(store.saveReviewSource({ fingerprint, source, historyMode: "squashed", createdAt: 10 }));

    assertStoreError(store.recordReviewOutcome(fingerprint, "correct", 1, 11), "InvalidInput", "verdict");
    assert.deepEqual(unwrap(store.recordReviewOutcome(fingerprint, "needsAttention", 1, 12)), {
      sourceFingerprint: fingerprint,
      verdict: "needsAttention",
      recordedAt: 12
    });

    const narrativeId = unwrap(checkedAnalysisRunId("run-narrative"));
    unwrap(store.startAnalysisRun({
      id: narrativeId,
      sourceFingerprint: fingerprint,
      mode: "narrative",
      model: { provider: "test", modelId: "model", thinkingLevel: "medium" },
      promptVersion: "narrative/v1",
      focus: "API changes",
      manifest: emptyAnalysisManifest(),
      startedAt: 20
    }));
    assertStoreError(store.completeAnalysisRun(narrativeId, {
      output: {
        mode: "narrative",
        scope: "working tree",
        executiveSummary: "partial",
        changeMap: [],
        changes: { behavioral: [], apiSchema: [], configuration: [], dependencies: [], tests: [], documentation: [] },
        interactions: [],
        questions: [],
        commitNarratives: [],
        crossCommitSynthesis: null
      },
      rawOutput: "{}",
      documentCoverage: [{ id: "a.ts", state: { kind: "excluded", reason: "too large" } }],
      commitCoverage: []
    }), "InvalidInput", "coverage");
    const narrative = unwrap(store.completeAnalysisRun(narrativeId, {
      output: {
        mode: "narrative",
        scope: "working tree",
        executiveSummary: "complete",
        changeMap: [{ path: "a.ts", summary: "changed" }],
        changes: { behavioral: ["changed"], apiSchema: [], configuration: [], dependencies: [], tests: [], documentation: [] },
        interactions: [],
        questions: [],
        commitNarratives: [],
        crossCommitSynthesis: null
      },
      rawOutput: "{\"summary\":\"complete\"}",
      documentCoverage: [{ id: "a.ts", state: { kind: "included" } }],
      commitCoverage: [],
      completedAt: 21
    }));
    assert.equal(narrative.status, "completed");
    assert.equal(narrative.output?.mode, "narrative");
    assert.deepEqual(narrative.documentCoverage, [{ id: "a.ts", state: { kind: "included" } }]);

    const reviewId = unwrap(checkedAnalysisRunId("run-review"));
    unwrap(store.startAnalysisRun({
      id: reviewId,
      sourceFingerprint: fingerprint,
      mode: "implementationReview",
      model: { provider: "test", modelId: "model", thinkingLevel: "high" },
      promptVersion: "review/v1",
      manifest: emptyAnalysisManifest()
    }));
    const review = unwrap(store.completeAnalysisRun(reviewId, {
      output: {
        mode: "implementationReview",
        scope: "working tree",
        verdict: "needsAttention",
        findings: [{
          priority: "P1",
          path: "a.ts",
          startLine: 1,
          endLine: 1,
          title: "Issue",
          scenario: "When used",
          impact: "It fails",
          correctiveDirection: "Fix it"
        }],
        callouts: [],
        coverageSummary: "a.ts reviewed",
        coverageLimited: true
      },
      rawOutput: "review",
      reviewVerdict: "needsAttention",
      documentCoverage: [{ id: "a.ts", state: { kind: "excluded", reason: "generated" } }],
      commitCoverage: []
    }));
    assert.equal(review.reviewVerdict, "needsAttention");
    assert.equal(unwrap(store.listAnalysisRuns(fingerprint)).length, 2);
    unwrap(store.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("patch and annotation ownership cannot cross session or file boundaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-ownership-"));
  try {
    const dbPath = join(dir, "patches.db");
    const firstSession = unwrap(checkedSessionId("019f-ownership-first"));
    const secondSession = unwrap(checkedSessionId("019f-ownership-second"));
    const store = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(store.upsertSession(firstSession, dir, null));
    unwrap(store.upsertSession(secondSession, dir, null));
    const firstFile = unwrap(
      store.ensureFile(firstSession, join(dir, "first.ts"), "first.ts", baselineFromContent("one\n"), "edit")
    );
    const secondFile = unwrap(
      store.ensureFile(secondSession, join(dir, "second.ts"), "second.ts", baselineFromContent("alpha\n"), "edit")
    );
    const secondPatch = unwrap(
      store.addPatch({
        sessionId: secondSession,
        fileId: secondFile.id,
        tool: "edit",
        toolCallId: "call-second",
        unifiedPatch: "--- a/second.ts\n+++ b/second.ts\n@@ -1 +1 @@\n-alpha\n+beta\n",
        displayDiff: "-1 alpha\n+1 beta",
        firstChangedLine: 1,
        preHash: hashContent("alpha\n"),
        postHash: hashContent("beta\n")
      })
    );

    assertStoreError(
      store.addPatch({
        sessionId: secondSession,
        fileId: firstFile.id,
        tool: "edit",
        toolCallId: "cross-session",
        unifiedPatch: "",
        displayDiff: "",
        firstChangedLine: null,
        preHash: hashContent("one\n"),
        postHash: hashContent("one\n")
      }),
      "InvalidInput",
      "fileId"
    );

    assertStoreError(
      store.addAnnotation({
        sessionId: firstSession,
        fileId: firstFile.id,
        anchor: {
          patchId: secondPatch.id,
          hash: hashContent("beta\n"),
          start: unwrap(anchorLine(1)),
          end: unwrap(anchorLine(1))
        },
        snippet: "beta",
        comment: "Wrong file"
      }),
      "InvalidInput",
      "anchor.patchId"
    );

    const annotation = unwrap(
      store.addAnnotation({
        sessionId: firstSession,
        fileId: firstFile.id,
        anchor: {
          patchId: null,
          hash: hashContent("one\n"),
          start: unwrap(anchorLine(1)),
          end: unwrap(anchorLine(1))
        },
        snippet: "one",
        comment: "Valid anchor"
      })
    );
    assertStoreError(
      store.reanchorAnnotation(
        annotation.id,
        {
          patchId: secondPatch.id,
          hash: hashContent("beta\n"),
          start: unwrap(anchorLine(1)),
          end: unwrap(anchorLine(1))
        },
        "beta"
      ),
      "InvalidInput",
      "anchor.patchId"
    );
    assert.equal(unwrap(store.getAnnotations(firstSession))[0].anchor.patchId, null);
    unwrap(store.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source notes are fingerprint-scoped, role-checked, freshness-gated, and claimable", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-source-notes-"));
  try {
    const dbPath = join(dir, "patches.db");
    const session = unwrap(checkedSessionId("source-note-session"));
    const document = unwrap(checkedDocumentId("src/example.ts"));
    const fingerprint = hashReviewSource({ source: "working-tree", version: 1 });
    const otherFingerprint = hashReviewSource({ source: "working-tree", version: 2 });
    const freshHash = hashContent("const value = 1;\n");
    const staleHash = hashContent("const value = 0;\n");
    const store = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(store.upsertSession(session, dir, null, 1));
    unwrap(store.saveReviewSource({
      fingerprint,
      source: { kind: "workingTree", base: "HEAD" },
      historyMode: "squashed",
      createdAt: 2
    }));
    unwrap(store.saveReviewSource({
      fingerprint: otherFingerprint,
      source: { kind: "workingTree", base: "HEAD" },
      historyMode: "squashed",
      createdAt: 3
    }));
    const add = (comment: string, hash: ContentHash, role: Parameters<PatchStore["addSourceNote"]>[0]["role"]) =>
      unwrap(store.addSourceNote({
        sourceFingerprint: fingerprint,
        targetSessionId: session,
        documentId: document,
        path: join(dir, "src", "example.ts"),
        relPath: "src/example.ts",
        anchor: { hash, start: unwrap(anchorLine(1)), end: unwrap(anchorLine(1)) },
        snippet: "const value = 1;",
        comment,
        role
      }));
    const agent = add("Fix this", freshHash, { kind: "finding", priority: "P1", audience: "agent" });
    add("Reviewer note", freshHash, { kind: "finding", priority: "P2", audience: "human" });
    add("Context", freshHash, { kind: "callout", audience: "human" });
    add("Old code", staleHash, { kind: "finding", priority: "P0", audience: "agent" });

    assert.equal(unwrap(store.getSourceNotes(otherFingerprint)).length, 0);
    const queued = unwrap(store.queueSourceNotes(
      fingerprint,
      session,
      new Map([[document, freshHash]]),
      { fixIntent: true }
    ));
    assert.deepEqual(queued.queued.map((note) => note.id), [agent.id]);
    assert.equal(queued.skippedStale.length, 1);
    assert.equal(queued.preservedHumanFindings.length, 1);
    assert.equal(queued.preservedCallouts.length, 1);

    const batch = unwrap(checkedBatchId("source-note-batch"));
    const claimed = unwrap(store.claimQueuedSourceNotes(session, batch, 20));
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].fixIntent, true);
    assert.equal(claimed[0].checkDisk, false);
    assert.equal(claimed[0].file.relPath, "src/example.ts");
    assert.equal(claimed[0].state.kind, "sent");

    unwrap(store.updateSourceNote(agent.id, "must remain unchanged", 21));
    assert.equal(unwrap(store.getSourceNotes(fingerprint, "sent"))[0].comment, "Fix this");
    assert.equal(unwrap(store.deleteSourceNote(agent.id)), false);
    unwrap(store.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source note SQL role sum rejects illegal callout and finding combinations", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-source-note-check-"));
  try {
    const dbPath = join(dir, "patches.db");
    const session = unwrap(checkedSessionId("source-note-check-session"));
    const fingerprint = hashReviewSource({ source: "snapshot", version: 1 });
    const store = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(store.upsertSession(session, dir, null, 1));
    unwrap(store.saveReviewSource({
      fingerprint,
      source: { kind: "snapshot", paths: ["src/example.ts"] },
      historyMode: "squashed",
      createdAt: 2
    }));
    unwrap(store.close());
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const insert = db.prepare(
        `INSERT INTO source_notes
           (source_fingerprint, target_session_id, document_id, path, rel_path, anchor_hash,
            start_line, end_line, snippet, comment, kind, priority, audience, status, created_at, updated_at)
         VALUES (?, ?, 'doc', '/tmp/example.ts', 'example.ts', ?, 1, 1, 'x', 'x', ?, ?, ?, 'draft', 3, 3)`
      );
      assert.throws(() => insert.run(fingerprint, session, hashContent("x"), "callout", "P2", "human"));
      assert.throws(() => insert.run(fingerprint, session, hashContent("x"), "finding", null, "agent"));
      assert.throws(() => insert.run(fingerprint, session, hashContent("x"), "callout", null, "agent"));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dataVersion changes on another connection commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-data-version-"));
  try {
    const dbPath = join(dir, "patches.db");
    const session = unwrap(checkedSessionId("019f-data-version-session"));
    const storeA = unwrap(PatchStore.open(dbPath, { create: true }));
    const storeB = unwrap(PatchStore.open(dbPath));
    unwrap(storeA.upsertSession(session, dir, null));

    const before = unwrap(storeA.dataVersion());
    unwrap(storeB.touchSession(session, 20));
    const after = unwrap(storeA.dataVersion());

    assert.notEqual(after, before);
    unwrap(storeA.close());
    unwrap(storeB.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forkSession copies files, patches, and annotations into the child session", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-fork-"));
  try {
    const dbPath = join(dir, "patches.db");
    const parent = unwrap(checkedSessionId("019f-parent-session"));
    const child = unwrap(checkedSessionId("019f-child-session"));
    const store = unwrap(PatchStore.open(dbPath, { create: true }));
    unwrap(store.upsertSession(parent, dir, join(dir, "parent.jsonl"), 1));
    const file = unwrap(store.ensureFile(parent, join(dir, "a.ts"), "a.ts", baselineFromContent("one\n"), "edit", 2));
    const patch = unwrap(
      store.addPatch({
        sessionId: parent,
        fileId: file.id,
        tool: "edit",
        toolCallId: "call-1",
        unifiedPatch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-one\n+two\n",
        displayDiff: "-1 one\n+1 two",
        firstChangedLine: 1,
        preHash: hashContent("one\n"),
        postHash: hashContent("two\n"),
        createdAt: 3
      })
    );
    const annotation = unwrap(
      store.addAnnotation({
        sessionId: parent,
        fileId: file.id,
        anchor: { patchId: patch.id, hash: hashContent("two\n"), start: unwrap(anchorLine(1)), end: unwrap(anchorLine(1)) },
        snippet: "two",
        comment: "Review forked code",
        createdAt: 4
      })
    );

    unwrap(store.upsertSession(child, dir, join(dir, "child.jsonl"), 5));
    unwrap(store.forkSession(parent, child));

    const sessions = unwrap(store.listSessions());
    assert.equal(sessions.find((session) => session.id === child)?.parentSessionId, parent);
    const childFiles = unwrap(store.getFiles(child));
    assert.equal(childFiles.length, 1);
    assert.equal(childFiles[0].relPath, file.relPath);
    assert.equal(childFiles[0].baseline.kind, "present");
    const childPatches = unwrap(store.getPatches(child));
    assert.equal(childPatches.length, 1);
    assert.equal(childPatches[0].seq, patch.seq);
    assert.equal(childPatches[0].fileId, childFiles[0].id);
    const childAnnotations = unwrap(store.getAnnotations(child));
    assert.equal(childAnnotations.length, 1);
    assert.equal(childAnnotations[0].comment, annotation.comment);
    assert.equal(childAnnotations[0].fileId, childFiles[0].id);
    assert.equal(childAnnotations[0].anchor.patchId, childPatches[0].id);
    unwrap(store.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}

function emptyAnalysisManifest() {
  return {
    strategy: "direct" as const,
    stats: { files: 0, commits: 0, bytes: 0, diffRows: 0, estimatedTokens: 0 },
    chunks: [],
    documentIds: [],
    commitShas: []
  };
}

function assertStoreError(
  result: Result<unknown>,
  kind: "InvalidInput" | "NotFound",
  field?: string
): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, kind);
  if (field !== undefined && result.error.kind === "InvalidInput") {
    assert.equal(result.error.field, field);
  }
}

function readSchemaVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: unknown } | undefined;
    return typeof row?.value === "string" ? Number(row.value) : -1;
  } finally {
    db.close();
  }
}

function normalizedSchema(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(
      `SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name, tbl_name`
    ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
    return rows.map((row) => `${row.type}:${row.name}:${row.tbl_name}:${row.sql.replace(/\s+/g, " ").trim()}`);
  } finally {
    db.close();
  }
}
