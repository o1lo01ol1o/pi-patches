import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { applyPatch } from "diff";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { checkedSessionId, dbPathForCwd, hashContent, PatchStore, type Result, type SessionId } from "@pi-patches/store";
import { getRecorderState, registerRecorder } from "../src/recorder.ts";

test("registerRecorder records write and edit tool results from Pi events", async () => {
  const fixture = makeRecorderFixture("recorder-hooks-session");
  try {
    registerRecorder(fakePi(fixture.handlers));
    await fixture.emit("session_start", sessionStart("startup"));

    await fixture.emit("tool_call", writeCall("write-1", "hello.txt", "hello\n"));
    writeText(join(fixture.dir, "hello.txt"), "hello\n");
    await fixture.emit("tool_result", writeResult("write-1", "hello.txt", "hello\n"));

    await fixture.emit("tool_call", editCall("edit-1", "hello.txt"));
    writeText(join(fixture.dir, "hello.txt"), "hello world\n");
    await fixture.emit(
      "tool_result",
      editResult("edit-1", "hello.txt", "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hello\n+hello world\n", "-1 hello\n+1 hello world")
    );

    const state = getRecorderState();
    assert.ok(state);
    assert.equal(state.lastDataVersion, -1);
    assert.equal(state.preImages.size, 0);

    const files = unwrap(state.store.getFiles(fixture.session));
    assert.equal(files.length, 1);
    assert.equal(files[0].relPath, "hello.txt");
    assert.equal(files[0].baseline.kind, "absent");

    const patches = unwrap(state.store.getPatches(fixture.session, files[0].id));
    assert.equal(patches.length, 2);
    assert.equal(patches[0].seq, 1);
    assert.equal(patches[0].tool, "write");
    assert.equal(patches[0].toolCallId, "write-1");
    assert.equal(patches[0].preHash, null);
    assert.equal(patches[0].postHash, hashContent("hello\n"));
    assert.match(patches[0].unifiedPatch, /\+hello/);
    assert.match(patches[0].displayDiff, /\+1 hello/);

    assert.equal(patches[1].seq, 2);
    assert.equal(patches[1].tool, "edit");
    assert.equal(patches[1].toolCallId, "edit-1");
    assert.equal(patches[1].firstChangedLine, 1);
    assert.equal(patches[1].preHash, hashContent("hello\n"));
    assert.equal(patches[1].postHash, hashContent("hello world\n"));
    assert.match(patches[1].unifiedPatch, /\+hello world/);
    assert.match(patches[1].displayDiff, /\+1 hello world/);
    assertPatchChain("", patches, "hello world\n");
    assert.deepEqual(fixture.notifications, []);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("agent_end clears recorder pre-images captured before tool results", async () => {
  const fixture = makeRecorderFixture("recorder-agent-end-session");
  try {
    registerRecorder(fakePi(fixture.handlers));
    await fixture.emit("session_start", sessionStart("startup"));
    writeText(join(fixture.dir, "src", "example.ts"), "const value = 1;\n");

    await fixture.emit("tool_call", editCall("edit-1", "src/example.ts"));
    assert.equal(getRecorderState()?.preImages.size, 1);

    await fixture.emit("agent_end", { type: "agent_end", messages: [] } as AgentEndEvent);
    assert.equal(getRecorderState()?.preImages.size, 0);
    assert.deepEqual(fixture.notifications, []);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("tool_result without a captured pre-image is skipped instead of inventing an absent baseline", async () => {
  const fixture = makeRecorderFixture("recorder-missing-preimage-session");
  try {
    registerRecorder(fakePi(fixture.handlers));
    await fixture.emit("session_start", sessionStart("startup"));
    writeText(join(fixture.dir, "src", "example.ts"), "const value = 2;\n");

    await fixture.emit("tool_result", writeResult("write-1", "src/example.ts", "const value = 2;\n"));

    const state = getRecorderState();
    assert.ok(state);
    assert.deepEqual(unwrap(state.store.getFiles(fixture.session)), []);
    assert.deepEqual(unwrap(state.store.getPatches(fixture.session)), []);
    assert.deepEqual(fixture.notifications, [
      "warning: pi-patches: skipped write result write-1; missing pre-image from tool_call"
    ]);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("tool_call read failures are reported without capturing a false absent baseline", async () => {
  const fixture = makeRecorderFixture("recorder-preimage-read-failure-session");
  const unreadablePath = join(fixture.dir, "src", "as-dir.ts");
  try {
    registerRecorder(fakePi(fixture.handlers));
    await fixture.emit("session_start", sessionStart("startup"));
    mkdirSync(unreadablePath, { recursive: true });

    await fixture.emit("tool_call", editCall("edit-1", "src/as-dir.ts"));

    const state = getRecorderState();
    assert.ok(state);
    assert.equal(state.preImages.size, 0);
    assert.deepEqual(unwrap(state.store.getFiles(fixture.session)), []);
    assert.equal(fixture.notifications.length, 1);
    assert.match(fixture.notifications[0], new RegExp(`^error: pi-patches: ${escapeRegExp(unreadablePath)}:`));
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("edit results whose patch does not apply are skipped and clear captured pre-images", async () => {
  const fixture = makeRecorderFixture("recorder-patch-application-failure-session");
  const path = join(fixture.dir, "src", "example.ts");
  try {
    registerRecorder(fakePi(fixture.handlers));
    await fixture.emit("session_start", sessionStart("startup"));
    writeText(path, "const value = 1;\n");

    await fixture.emit("tool_call", editCall("edit-1", "src/example.ts"));
    await fixture.emit(
      "tool_result",
      editResult("edit-1", "src/example.ts", "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n", "-1 old\n+1 new")
    );

    const state = getRecorderState();
    assert.ok(state);
    assert.equal(state.preImages.size, 0);
    assert.deepEqual(unwrap(state.store.getFiles(fixture.session)), []);
    assert.deepEqual(unwrap(state.store.getPatches(fixture.session)), []);
    assert.equal(fixture.notifications.length, 1);
    assert.equal(
      fixture.notifications[0],
      "warning: pi-patches: skipped edit result edit-1; patch did not apply to the recorded pre-image"
    );
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("parallel same-file tool calls advance from the prior recorded logical head", async () => {
  const fixture = makeRecorderFixture("recorder-parallel-same-file-session");
  const path = join(fixture.dir, "value.txt");
  try {
    registerRecorder(fakePi(fixture.handlers));
    await fixture.emit("session_start", sessionStart("startup"));
    writeText(path, "zero\n");

    await fixture.emit("tool_call", editCall("edit-1", "value.txt"));
    await fixture.emit("tool_call", editCall("edit-2", "value.txt"));
    writeText(path, "two\n");

    await fixture.emit(
      "tool_result",
      editResult("edit-1", "value.txt", "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-zero\n+one\n", "-1 zero\n+1 one")
    );
    await fixture.emit(
      "tool_result",
      editResult("edit-2", "value.txt", "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-one\n+two\n", "-1 one\n+1 two")
    );

    const state = getRecorderState();
    assert.ok(state);
    const files = unwrap(state.store.getFiles(fixture.session));
    const patches = unwrap(state.store.getPatches(fixture.session, files[0].id));
    assert.equal(patches.length, 2);
    assert.equal(patches[0].preHash, hashContent("zero\n"));
    assert.equal(patches[0].postHash, hashContent("one\n"));
    assert.equal(patches[1].preHash, hashContent("one\n"));
    assert.equal(patches[1].postHash, hashContent("two\n"));
    assertPatchChain("zero\n", patches, "two\n");
    assert.deepEqual(fixture.notifications, []);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("resuming the same session appends the next patch sequence", async () => {
  const fixture = makeRecorderFixture("recorder-resume-session");
  const path = join(fixture.dir, "resume.txt");
  try {
    registerRecorder(fakePi(fixture.handlers));
    await fixture.emit("session_start", sessionStart("startup"));
    await fixture.emit("tool_call", writeCall("write-1", "resume.txt", "one\n"));
    writeText(path, "one\n");
    await fixture.emit("tool_result", writeResult("write-1", "resume.txt", "one\n"));
    await fixture.shutdown("resume", fixture.sessionFile);

    await fixture.emit("session_start", sessionStart("resume"));
    await fixture.emit("tool_call", editCall("edit-2", "resume.txt"));
    writeText(path, "two\n");
    await fixture.emit(
      "tool_result",
      editResult("edit-2", "resume.txt", "--- a/resume.txt\n+++ b/resume.txt\n@@ -1 +1 @@\n-one\n+two\n", "-1 one\n+1 two")
    );

    const state = getRecorderState();
    assert.ok(state);
    const files = unwrap(state.store.getFiles(fixture.session));
    const patches = unwrap(state.store.getPatches(fixture.session, files[0].id));
    assert.deepEqual(patches.map((patch) => Number(patch.seq)), [1, 2]);
    assertPatchChain("", patches, "two\n");
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("edit recording preserves BOM and CRLF while storing a patch that applies to the raw baseline", async () => {
  const fixture = makeRecorderFixture("recorder-crlf-session");
  const path = join(fixture.dir, "windows.txt");
  const baseline = "\uFEFFhello\r\n";
  const current = "\uFEFFhello world\r\n";
  try {
    registerRecorder(fakePi(fixture.handlers));
    await fixture.emit("session_start", sessionStart("startup"));
    writeText(path, baseline);
    await fixture.emit("tool_call", editCall("edit-crlf", "windows.txt"));
    writeText(path, current);
    await fixture.emit(
      "tool_result",
      editResult(
        "edit-crlf",
        "windows.txt",
        "--- a/windows.txt\n+++ b/windows.txt\n@@ -1 +1 @@\n-hello\n+hello world\n",
        "-1 hello\n+1 hello world"
      )
    );

    const state = getRecorderState();
    assert.ok(state);
    const files = unwrap(state.store.getFiles(fixture.session));
    assert.equal(files[0].baseline.kind, "present");
    if (files[0].baseline.kind === "present") assert.equal(files[0].baseline.content, baseline);
    const patches = unwrap(state.store.getPatches(fixture.session, files[0].id));
    assert.equal(patches[0].preHash, hashContent(baseline));
    assert.equal(patches[0].postHash, hashContent(current));
    assertPatchChain(baseline, patches, current);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("session_shutdown closes recorder state and marks the session ended", async () => {
  const fixture = makeRecorderFixture("recorder-shutdown-session");
  try {
    registerRecorder(fakePi(fixture.handlers));
    await fixture.emit("session_start", sessionStart("startup"));
    assert.ok(getRecorderState());

    await fixture.shutdown();
    assert.equal(getRecorderState(), null);

    const store = unwrap(PatchStore.open(dbPathForCwd(fixture.dir)));
    try {
      const sessions = unwrap(store.listSessions());
      const session = sessions.find((row) => row.id === fixture.session);
      assert.ok(session);
      assert.notEqual(session.endedAt, null);
    } finally {
      unwrap(store.close());
    }
    assert.deepEqual(fixture.notifications, []);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("fork session_start copies parent recorder state from previous session file", async () => {
  const fixture = makeRecorderFixture("recorder-parent-session");
  try {
    registerRecorder(fakePi(fixture.handlers));
    await fixture.emit("session_start", sessionStart("startup"));
    await fixture.emit("tool_call", writeCall("write-1", "forked.txt", "one\n"));
    writeText(join(fixture.dir, "forked.txt"), "one\n");
    await fixture.emit("tool_result", writeResult("write-1", "forked.txt", "one\n"));

    const parent = fixture.session;
    const parentSessionFile = fixture.sessionFile;
    await fixture.shutdown("fork", join(fixture.dir, "session_recorder-child-session.jsonl"));

    const child = unwrap(checkedSessionId("recorder-child-session"));
    fixture.setSession(child, join(fixture.dir, "session_recorder-child-session.jsonl"));
    await fixture.emit("session_start", {
      type: "session_start",
      reason: "fork",
      previousSessionFile: parentSessionFile
    } satisfies SessionStartEvent);

    const state = getRecorderState();
    assert.ok(state);
    const sessions = unwrap(state.store.listSessions());
    assert.equal(sessions.find((session) => session.id === child)?.parentSessionId, parent);

    const files = unwrap(state.store.getFiles(child));
    assert.equal(files.length, 1);
    assert.equal(files[0].relPath, "forked.txt");

    const patches = unwrap(state.store.getPatches(child));
    assert.equal(patches.length, 1);
    assert.equal(patches[0].seq, 1);
    assert.equal(patches[0].tool, "write");
    assert.equal(patches[0].postHash, hashContent("one\n"));
    assert.deepEqual(fixture.notifications, []);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

type RecorderFixture = {
  dir: string;
  handlers: Map<string, Handler>;
  notifications: string[];
  session: SessionId;
  sessionFile: string;
  emit(event: string, payload: unknown): Promise<void>;
  setSession(session: SessionId, sessionFile: string): void;
  shutdown(reason?: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void>;
  cleanup(): void;
};

function makeRecorderFixture(sessionId: string): RecorderFixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-recorder-"));
  let session = unwrap(checkedSessionId(sessionId));
  let sessionFile = join(dir, `session_${sessionId}.jsonl`);
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  const ctx = fakeContext({
    cwd: dir,
    get sessionId() {
      return session;
    },
    get sessionFile() {
      return sessionFile;
    },
    notifications
  });
  return {
    dir,
    handlers,
    notifications,
    get session() {
      return session;
    },
    get sessionFile() {
      return sessionFile;
    },
    async emit(event: string, payload: unknown): Promise<void> {
      const handler = handlers.get(event);
      assert.ok(handler, `missing handler for ${event}`);
      await handler(payload, ctx);
    },
    setSession(nextSession: SessionId, nextSessionFile: string): void {
      session = nextSession;
      sessionFile = nextSessionFile;
    },
    async shutdown(reason: SessionShutdownEvent["reason"] = "quit", targetSessionFile?: string): Promise<void> {
      const handler = handlers.get("session_shutdown");
      if (handler) await handler({ type: "session_shutdown", reason, targetSessionFile } satisfies SessionShutdownEvent, ctx);
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function fakePi(handlers: Map<string, Handler>): ExtensionAPI {
  return {
    on(event: string, handler: Handler): void {
      handlers.set(event, handler);
    }
  } as unknown as ExtensionAPI;
}

function fakeContext(input: { cwd: string; sessionId: SessionId; sessionFile: string; notifications: string[] }): ExtensionContext {
  return {
    cwd: input.cwd,
    isIdle: () => true,
    sessionManager: {
      getCwd: () => input.cwd,
      getSessionId: () => input.sessionId,
      getSessionFile: () => input.sessionFile
    },
    ui: {
      notify(message: string, level: string): void {
        input.notifications.push(`${level}: ${message}`);
      }
    }
  } as unknown as ExtensionContext;
}

function sessionStart(reason: Exclude<SessionStartEvent["reason"], "fork">): SessionStartEvent {
  return { type: "session_start", reason };
}

function writeCall(toolCallId: string, path: string, content: string): ToolCallEvent {
  return { type: "tool_call", toolName: "write", toolCallId, input: { path, content } } as ToolCallEvent;
}

function writeResult(toolCallId: string, path: string, content: string): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "write",
    toolCallId,
    input: { path, content },
    content: [],
    isError: false,
    details: undefined
  } as ToolResultEvent;
}

function editCall(toolCallId: string, path: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolName: "edit",
    toolCallId,
    input: { path, edits: [{ oldText: "hello", newText: "hello world" }] }
  } as ToolCallEvent;
}

function editResult(toolCallId: string, path: string, patch: string, diff: string): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "edit",
    toolCallId,
    input: { path, edits: [{ oldText: "hello", newText: "hello world" }] },
    content: [],
    isError: false,
    details: { patch, diff, firstChangedLine: 1 }
  } as ToolResultEvent;
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertPatchChain(baseline: string, patches: readonly { unifiedPatch: string; postHash: string }[], expected: string): void {
  let content = baseline;
  for (const patch of patches) {
    const applied = applyPatch(content, patch.unifiedPatch);
    assert.equal(typeof applied, "string");
    if (typeof applied !== "string") return;
    content = applied;
    assert.equal(hashContent(content), patch.postHash);
  }
  assert.equal(content, expected);
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
