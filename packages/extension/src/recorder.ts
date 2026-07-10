import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { applyPatch } from "diff";
import {
  generateDiffString,
  generateUnifiedPatch,
  isEditToolResult,
  isToolCallEventType,
  isWriteToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type ToolCallEvent,
  type ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import {
  baselineFromContent,
  checkedSessionId,
  dbPathForCwd,
  err,
  errorMessage,
  hashContent,
  ok,
  parseSessionIdFromSessionFile,
  PatchStore,
  type ContentHash,
  type PatchStore as PatchStoreType,
  type Result,
  type SessionId
} from "@pi-patches/store";
import { pollQueuedAnnotations } from "./submitter.ts";

export type RecorderState = {
  store: PatchStoreType;
  dbPath: string;
  cwd: string;
  sessionId: SessionId;
  preImages: Map<string, { absPath: string; content: string | null; logicalHeadAtCapture: string | null | undefined }>;
  logicalHeads: Map<string, string>;
  pollTimer: NodeJS.Timeout;
  lastDataVersion: number;
  sending: boolean;
};

let currentState: RecorderState | null = null;

export function getRecorderState(): RecorderState | null {
  return currentState;
}

export function registerRecorder(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => startSession(pi, event, ctx));
  pi.on("tool_call", (event, ctx) => recordPreImage(event, ctx));
  pi.on("tool_result", (event, ctx) => recordToolResult(event, ctx));
  pi.on("agent_end", () => {
    currentState?.preImages.clear();
  });
  pi.on("session_shutdown", (event, ctx) => shutdownSession(event, ctx));
}

function startSession(pi: ExtensionAPI, event: SessionStartEvent, ctx: ExtensionContext): void {
  if (currentState) shutdownLiveState();
  const cwd = ctx.sessionManager.getCwd();
  const session = checkedSessionId(ctx.sessionManager.getSessionId());
  if (!session.ok) {
    ctx.ui.notify(`pi-patches: ${errorMessage(session.error)}`, "error");
    return;
  }
  const dbPath = dbPathForCwd(cwd);
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = PatchStore.open(dbPath, { create: true });
  if (!store.ok) {
    ctx.ui.notify(`pi-patches: ${errorMessage(store.error)}`, "error");
    return;
  }
  const upsert = store.value.upsertSession(session.value, cwd, ctx.sessionManager.getSessionFile() ?? null);
  if (!upsert.ok) {
    ctx.ui.notify(`pi-patches: ${errorMessage(upsert.error)}`, "error");
    store.value.close();
    return;
  }
  if (event.reason === "fork") {
    const parentId = parseSessionIdFromSessionFile(event.previousSessionFile);
    if (parentId) {
      const fork = store.value.forkSession(parentId, session.value);
      if (!fork.ok) ctx.ui.notify(`pi-patches fork copy failed: ${errorMessage(fork.error)}`, "warning");
    } else {
      ctx.ui.notify("pi-patches: could not infer parent session for fork; starting empty patch DB state", "warning");
    }
  }
  const state: RecorderState = {
    store: store.value,
    dbPath,
    cwd,
    sessionId: session.value,
    preImages: new Map(),
    logicalHeads: new Map(),
    pollTimer: setInterval(() => {
      if (currentState === state) pollQueuedAnnotations(pi, ctx, state);
    }, 1000),
    lastDataVersion: -1,
    sending: false
  };
  currentState = state;
}

function recordPreImage(event: ToolCallEvent, ctx: ExtensionContext): void {
  const state = currentState;
  if (!state) return;
  if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
  const rawPath = event.input.path;
  if (typeof rawPath !== "string") return;
  const absPath = resolveToolPath(ctx.sessionManager.getCwd(), rawPath);
  const content = readTextIfExists(absPath);
  if (!content.ok) {
    ctx.ui.notify(`pi-patches: ${errorMessage(content.error)}`, "error");
    return;
  }
  state.preImages.set(event.toolCallId, {
    absPath,
    content: content.value,
    logicalHeadAtCapture: state.logicalHeads.get(absPath)
  });
}

function recordToolResult(event: ToolResultEvent, ctx: ExtensionContext): void {
  const state = currentState;
  if (!state) return;
  if (event.isError) {
    state.preImages.delete(event.toolCallId);
    return;
  }

  if (isEditToolResult(event)) {
    try {
      const details = event.details;
      if (!details) return;
      const preImage = state.preImages.get(event.toolCallId);
      if (!preImage) {
        notifyMissingPreImage(ctx, event.toolCallId, "edit");
        return;
      }
      const absPath = preImage.absPath;
      const pre = logicalPreImage(state, preImage);
      const applied = applyPiEditPatch(pre ?? "", details.patch);
      if (!applied) {
        ctx.ui.notify(`pi-patches: skipped edit result ${event.toolCallId}; patch did not apply to the recorded pre-image`, "warning");
        return;
      }
      const unifiedPatch = applied.normalized ? generateUnifiedPatch(absPath, pre ?? "", applied.post) : details.patch;
      const persisted = persistPatch(state, ctx, {
        absPath,
        tool: "edit",
        toolCallId: event.toolCallId,
        pre,
        post: applied.post,
        unifiedPatch,
        displayDiff: details.diff,
        firstChangedLine: details.firstChangedLine ?? null
      });
      if (persisted) state.logicalHeads.set(absPath, applied.post);
    } finally {
      state.preImages.delete(event.toolCallId);
    }
    return;
  }

  if (isWriteToolResult(event)) {
    try {
      const preImage = state.preImages.get(event.toolCallId);
      if (!preImage) {
        notifyMissingPreImage(ctx, event.toolCallId, "write");
        return;
      }
      const absPath = preImage.absPath;
      const post = typeof event.input.content === "string" ? event.input.content : null;
      if (!absPath || post === null) return;
      const pre = logicalPreImage(state, preImage);
      const diff = generateDiffString(pre ?? "", post);
      const persisted = persistPatch(state, ctx, {
        absPath,
        tool: "write",
        toolCallId: event.toolCallId,
        pre,
        post,
        unifiedPatch: generateUnifiedPatch(absPath, pre ?? "", post),
        displayDiff: diff.diff,
        firstChangedLine: diff.firstChangedLine ?? null
      });
      if (persisted) state.logicalHeads.set(absPath, post);
    } finally {
      state.preImages.delete(event.toolCallId);
    }
  }
}

function notifyMissingPreImage(ctx: ExtensionContext, toolCallId: string, tool: "edit" | "write"): void {
  ctx.ui.notify(
    `pi-patches: skipped ${tool} result ${toolCallId}; missing pre-image from tool_call`,
    "warning"
  );
}

function shutdownSession(_event: SessionShutdownEvent, _ctx: ExtensionContext): void {
  shutdownLiveState();
}

function shutdownLiveState(): void {
  const state = currentState;
  currentState = null;
  if (!state) return;
  clearInterval(state.pollTimer);
  state.store.endSession(state.sessionId);
  state.store.close();
}

function persistPatch(
  state: RecorderState,
  ctx: ExtensionContext,
  input: {
    absPath: string;
    tool: "edit" | "write";
    toolCallId: string;
    pre: string | null;
    post: string;
    unifiedPatch: string;
    displayDiff: string;
    firstChangedLine: number | null;
  }
): boolean {
  const file = state.store.ensureFile(
    state.sessionId,
    input.absPath,
    relativeDisplayPath(state.cwd, input.absPath),
    baselineFromContent(input.pre),
    input.tool
  );
  if (!file.ok) {
    ctx.ui.notify(`pi-patches: ${errorMessage(file.error)}`, "error");
    return false;
  }
  const patch = state.store.addPatch({
    sessionId: state.sessionId,
    fileId: file.value.id,
    tool: input.tool,
    toolCallId: input.toolCallId,
    unifiedPatch: input.unifiedPatch,
    displayDiff: input.displayDiff,
    firstChangedLine: input.firstChangedLine,
    preHash: input.pre === null ? null : hashContent(input.pre),
    postHash: hashContent(input.post) as ContentHash
  });
  if (!patch.ok) {
    ctx.ui.notify(`pi-patches: ${errorMessage(patch.error)}`, "error");
    return false;
  }
  const touched = state.store.touchSession(state.sessionId);
  if (!touched.ok) ctx.ui.notify(`pi-patches: ${errorMessage(touched.error)}`, "error");
  return true;
}

function logicalPreImage(
  state: RecorderState,
  preImage: { absPath: string; content: string | null; logicalHeadAtCapture: string | null | undefined }
): string | null {
  const currentHead = state.logicalHeads.get(preImage.absPath);
  return currentHead === preImage.logicalHeadAtCapture ? preImage.content : (currentHead ?? preImage.content);
}

function applyPiEditPatch(pre: string, patch: string): { post: string; normalized: boolean } | null {
  const bom = pre.startsWith("\uFEFF") ? "\uFEFF" : "";
  const withoutBom = bom ? pre.slice(1) : pre;
  const ending = detectLineEnding(withoutBom);
  const normalizedPre = normalizeToLf(withoutBom);
  const normalizedPost = applyPatch(normalizedPre, patch);
  if (typeof normalizedPost !== "string") return null;
  return {
    post: bom + (ending === "\r\n" ? normalizedPost.replaceAll("\n", "\r\n") : normalizedPost),
    normalized: bom.length > 0 || normalizedPre !== withoutBom
  };
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  return lf !== -1 && crlf !== -1 && crlf < lf ? "\r\n" : "\n";
}

function normalizeToLf(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function readTextIfExists(path: string): Result<string | null> {
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

function resolveToolPath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function relativeDisplayPath(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath);
  if (!rel || rel.startsWith("..") || rel === ".." || rel.split(sep).includes("..")) return absPath;
  return rel.split(sep).join("/");
}
