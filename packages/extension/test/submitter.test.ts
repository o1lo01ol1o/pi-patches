import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  anchorLine,
  baselineFromContent,
  checkedSessionId,
  checkedDocumentId,
  err,
  hashContent,
  hashReviewSource,
  ok,
  PatchStore,
  type FileRecord,
  type Result,
  type SessionId
} from "@pi-patches/store";
import { pollQueuedAnnotations } from "../src/submitter.ts";
import type { RecorderState } from "../src/recorder.ts";

test("pollQueuedAnnotations sends queued comments as a normal user message when pi is idle", () => {
  const fixture = makeQueuedAnnotationFixture();
  try {
    const sent: SentMessage[] = [];
    const ctx = fakeContext(true);
    pollQueuedAnnotations(fakePi(sent), ctx, fixture.state);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.options, undefined);
    assert.match(sent[0]?.message ?? "", /Code review findings on the selected changes \(1 finding\)/);
    assert.match(sent[0]?.message ?? "", /## 1\. src\/example\.ts:1/);

    const sentRows = unwrap(fixture.state.store.getAnnotations(fixture.session, "sent"));
    assert.equal(sentRows.length, 1);
    assert.equal(sentRows[0].state.kind, "sent");
  } finally {
    fixture.cleanup();
  }
});

test("pollQueuedAnnotations drains queued comments on the initial scan", () => {
  const fixture = makeQueuedAnnotationFixture();
  try {
    fixture.state.lastDataVersion = -1;
    const sent: SentMessage[] = [];
    pollQueuedAnnotations(fakePi(sent), fakeContext(true), fixture.state);

    assert.equal(sent.length, 1);
    assert.equal(fixture.state.lastDataVersion, unwrap(fixture.state.store.dataVersion()));
  } finally {
    fixture.cleanup();
  }
});

test("pollQueuedAnnotations retries the same database version after claim errors", () => {
  const session = unwrap(checkedSessionId("submitter-retry-session"));
  const timer = setInterval(() => undefined, 60_000);
  const notifications: string[] = [];
  const state: RecorderState = {
    store: {
      dataVersion: () => ok(7),
      claimQueuedFeedback: () => err({ kind: "Busy", message: "database is locked" })
    } as unknown as RecorderState["store"],
    dbPath: "/tmp/pi-patches-retry.db",
    cwd: "/tmp",
    sessionId: session,
    preImages: new Map(),
    logicalHeads: new Map(),
    pollTimer: timer,
    lastDataVersion: 3,
    sending: false
  };
  try {
    pollQueuedAnnotations(fakePi([]), fakeContext(true, notifications), state);

    assert.equal(state.lastDataVersion, 3);
    assert.equal(state.sending, false);
    assert.deepEqual(notifications, ["error: pi-patches: database is locked"]);
  } finally {
    clearInterval(timer);
  }
});

test("pollQueuedAnnotations uses steer delivery mid-stream and does not send the claimed batch twice", () => {
  const fixture = makeQueuedAnnotationFixture();
  try {
    const sent: SentMessage[] = [];
    pollQueuedAnnotations(fakePi(sent), fakeContext(false), fixture.state);
    pollQueuedAnnotations(fakePi(sent), fakeContext(false), fixture.state);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.options, { deliverAs: "steer" });
  } finally {
    fixture.cleanup();
  }
});

test("pollQueuedAnnotations reports claim-time staleness from current disk content", () => {
  const fixture = makeQueuedAnnotationFixture();
  try {
    writeFileSync(fixture.file.path, "const value = 2;\n");
    const sent: SentMessage[] = [];
    pollQueuedAnnotations(fakePi(sent), fakeContext(false), fixture.state);

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.message ?? "", /\(note: anchored @ baseline; file has changed since\)/);
  } finally {
    fixture.cleanup();
  }
});

test("pollQueuedAnnotations still delivers with a stale note when the live file cannot be read", () => {
  const fixture = makeQueuedAnnotationFixture();
  try {
    rmSync(fixture.file.path);
    mkdirSync(fixture.file.path);
    const sent: SentMessage[] = [];
    const notifications: string[] = [];
    pollQueuedAnnotations(fakePi(sent), fakeContext(true, notifications), fixture.state);

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.message ?? "", /\(note: anchored @ baseline; file has changed since\)/);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /^warning: pi-patches: could not read /);
  } finally {
    fixture.cleanup();
  }
});

test("pollQueuedAnnotations delivers queued non-session findings with fix intent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-source-submit-"));
  const dbPath = join(dir, "patches.db");
  const session = unwrap(checkedSessionId("source-submit-session"));
  const document = unwrap(checkedDocumentId("src/source.ts"));
  const fingerprint = hashReviewSource({ source: "snapshot", content: 1 });
  const storeA = unwrap(PatchStore.open(dbPath, { create: true }));
  const timer = setInterval(() => undefined, 60_000);
  try {
    unwrap(storeA.upsertSession(session, dir, null, 1));
    unwrap(storeA.saveReviewSource({
      fingerprint,
      source: { kind: "snapshot", paths: ["src/source.ts"] },
      historyMode: "squashed",
      createdAt: 2
    }));
    const note = unwrap(storeA.addSourceNote({
      sourceFingerprint: fingerprint,
      targetSessionId: session,
      documentId: document,
      path: join(dir, "src", "source.ts"),
      relPath: "src/source.ts",
      anchor: { hash: hashContent("const source = 1;\n"), start: unwrap(anchorLine(1)), end: unwrap(anchorLine(1)) },
      snippet: "const source = 1;",
      comment: "Handle the invalid source case.",
      role: { kind: "finding", priority: "P0", audience: "agent" },
      createdAt: 3
    }));
    const beforeQueue = unwrap(storeA.dataVersion());
    const storeB = unwrap(PatchStore.open(dbPath));
    try {
      const queued = unwrap(storeB.queueSourceNotes(
        fingerprint,
        session,
        new Map([[document, note.anchor.hash]]),
        { fixIntent: true }
      ));
      assert.equal(queued.queued.length, 1);
    } finally {
      unwrap(storeB.close());
    }
    const state: RecorderState = {
      store: storeA,
      dbPath,
      cwd: dir,
      sessionId: session,
      preImages: new Map(),
      logicalHeads: new Map(),
      pollTimer: timer,
      lastDataVersion: beforeQueue,
      sending: false
    };
    const sent: SentMessage[] = [];
    pollQueuedAnnotations(fakePi(sent), fakeContext(true), state);

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.message ?? "", /src\/source\.ts:1 \[P0\]/);
    assert.match(sent[0]?.message ?? "", /Report fixed and deferred item numbers/);
    assert.doesNotMatch(sent[0]?.message ?? "", /file has changed since/);
    assert.equal(unwrap(storeA.getSourceNotes(fingerprint, "sent")).length, 1);
  } finally {
    clearInterval(timer);
    storeA.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

type SentMessage = {
  message: string;
  options?: unknown;
};

function makeQueuedAnnotationFixture(): {
  session: SessionId;
  file: FileRecord;
  state: RecorderState;
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-submit-"));
  const dbPath = join(dir, "patches.db");
  const absPath = join(dir, "src", "example.ts");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(absPath, "const value = 1;\n", { flag: "w" });
  const session = unwrap(checkedSessionId("submitter-test-session"));
  const storeA = unwrap(PatchStore.open(dbPath, { create: true }));
  const timer = setInterval(() => undefined, 60_000);
  try {
    unwrap(storeA.upsertSession(session, dir, null, 1));
    const file = unwrap(storeA.ensureFile(session, absPath, "src/example.ts", baselineFromContent("const value = 1;\n"), "edit", 2));
    unwrap(
      storeA.addAnnotation({
        sessionId: session,
        fileId: file.id,
        anchor: {
          patchId: null,
          hash: hashContent("const value = 1;\n"),
          start: unwrap(anchorLine(1)),
          end: unwrap(anchorLine(1))
        },
        snippet: "const value = 1;",
        comment: "Please update this value.",
        createdAt: 3
      })
    );
    const beforeQueue = unwrap(storeA.dataVersion());
    const storeB = unwrap(PatchStore.open(dbPath));
    try {
      const queued = unwrap(storeB.queueAllDrafts(session, new Map([[file.id, hashContent("const value = 1;\n")]])));
      assert.equal(queued.queued.length, 1);
    } finally {
      unwrap(storeB.close());
    }
    const state: RecorderState = {
      store: storeA,
      dbPath,
      cwd: dir,
      sessionId: session,
      preImages: new Map(),
      logicalHeads: new Map(),
      pollTimer: timer,
      lastDataVersion: beforeQueue,
      sending: false
    };
    return {
      session,
      file,
      state,
      cleanup() {
        clearInterval(timer);
        storeA.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    clearInterval(timer);
    storeA.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function fakePi(sent: SentMessage[]): ExtensionAPI {
  return {
    sendUserMessage(message: string, options?: unknown): void {
      sent.push({ message, options });
    }
  } as unknown as ExtensionAPI;
}

function fakeContext(idle: boolean, notifications?: string[]): ExtensionContext {
  return {
    isIdle: () => idle,
    ui: {
      notify(message: string, level: string): void {
        if (notifications) {
          notifications.push(`${level}: ${message}`);
          return;
        }
        throw new Error(`unexpected notification ${level}: ${message}`);
      }
    }
  } as unknown as ExtensionContext;
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
