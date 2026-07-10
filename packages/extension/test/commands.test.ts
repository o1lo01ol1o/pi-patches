import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { checkedSessionId, ok, type Result, type SessionId } from "@pi-patches/store";
import type { ModelInvocation, ModelRunner } from "@pi-patches/review-app/analysis";
import { registerCommands } from "../src/commands.ts";
import { registerRecorder } from "../src/recorder.ts";

test("/patches reports the current session and embedded review command", async () => {
  const fixture = makeCommandFixture("commands-patches-session");
  try {
    registerRecorder(fixture.pi);
    registerCommands(fixture.pi);
    await fixture.emit("session_start", sessionStart("startup"));
    await fixture.recordWrite("write-1", "hello.txt", "hello\n");

    await fixture.command("patches").handler("", fixture.ctx);

    assert.deepEqual(fixture.notifications, [
      {
        level: "info",
        message: [
          "session commands-patches-session",
          "1 files, 1 patches · queued 0, sent 0",
          "Open review: /patches connect commands-patches-session"
        ].join("\n")
      }
    ]);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("/patches connect opens an existing session through pi custom UI", async () => {
  const fixture = makeCommandFixture("commands-connect-session");
  try {
    registerRecorder(fixture.pi);
    registerCommands(fixture.pi);
    await fixture.emit("session_start", sessionStart("startup"));
    await fixture.recordWrite("write-1", "hello.txt", "hello\n");

    await fixture.command("patches").handler("connect commands-connect", fixture.ctx);

    assert.equal(fixture.customUiCalls, 1);
    assert.equal(fixture.customOverlayUiCalls, 1);
    assert.deepEqual(fixture.notifications, []);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("/patches connect requires a session selector", async () => {
  const fixture = makeCommandFixture("commands-connect-usage-session");
  try {
    registerRecorder(fixture.pi);
    registerCommands(fixture.pi);
    await fixture.emit("session_start", sessionStart("startup"));

    await fixture.command("patches").handler("connect", fixture.ctx);

    assert.equal(fixture.customUiCalls, 0);
    assert.deepEqual(fixture.notifications, [
      { level: "warning", message: "Usage: /patches connect <session-id-or-prefix>" }
    ]);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("/patches inspect materializes a direct source and opens it in the embedded UI", async () => {
  const fixture = makeCommandFixture("commands-inspect-session");
  try {
    registerRecorder(fixture.pi);
    registerCommands(fixture.pi);
    await fixture.emit("session_start", sessionStart("startup"));
    writeText(join(fixture.dir, "snapshot.txt"), "snapshot\n");

    await fixture.command("patches").handler("inspect snapshot snapshot.txt", fixture.ctx);

    assert.equal(fixture.customUiCalls, 1);
    assert.deepEqual(fixture.notifications, []);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("/patches analyze keeps narrative separate, uses the selected model, and opens the Narrative tab", async () => {
  const fixture = makeCommandFixture("commands-analyze-session");
  try {
    registerRecorder(fixture.pi);
    const invocations: ModelInvocation[] = [];
    const runner: ModelRunner = {
      listModels: () => [{
        provider: "fake-provider",
        modelId: "fake-model",
        thinkingLevel: "medium",
        name: "Fake Model",
        contextWindow: 32_000,
        maxOutputTokens: 4_000,
        supportsThinking: true
      }],
      async run(invocation) {
        invocations.push(invocation);
        return ok({
          text: JSON.stringify({
            mode: "narrative",
            scope: "snapshot",
            executiveSummary: "The snapshot contains one file.",
            changeMap: [{ path: "snapshot.txt", summary: "Current snapshot content." }],
            changes: { behavioral: [], apiSchema: [], configuration: [], dependencies: [], tests: [], documentation: [] },
            interactions: [],
            questions: [],
            commitNarratives: [],
            crossCommitSynthesis: null
          }),
          resolvedModel: invocation.model
        });
      }
    };
    registerCommands(fixture.pi, { createModelRunner: () => runner });
    await fixture.emit("session_start", sessionStart("startup"));
    writeText(join(fixture.dir, "snapshot.txt"), "snapshot\n");
    const choices = ["Narrative", "fake-provider/fake-model · Fake Model", "high", "No one-off focus"];
    (fixture.ctx.ui as unknown as { select(title: string, options: string[]): Promise<string | undefined> }).select = async () => choices.shift();

    await fixture.command("patches").handler("analyze snapshot snapshot.txt", fixture.ctx);

    assert.equal(fixture.customUiCalls, 1);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].mode, "narrative");
    assert.equal(invocations[0].model.thinkingLevel, "high");
    assert.doesNotMatch(invocations[0].systemPrompt, /implementation reviewer/i);
  } finally {
    await fixture.shutdown();
    fixture.cleanup();
  }
});

test("the extension does not register a terminal-launching /review command", () => {
  const fixture = makeCommandFixture("commands-no-review-session");
  try {
    registerCommands(fixture.pi);
    assert.equal(fixture.hasCommand("patches"), true);
    assert.equal(fixture.hasCommand("review"), false);
  } finally {
    fixture.cleanup();
  }
});

type CommandHandler = {
  description?: string;
  handler(args: string, ctx: ExtensionContext): Promise<void> | void;
};

type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

type Notification = {
  message: string;
  level: string;
};

type CommandFixture = {
  dir: string;
  session: SessionId;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  notifications: Notification[];
  customUiCalls: number;
  customOverlayUiCalls: number;
  emit(event: string, payload: unknown): Promise<void>;
  command(name: string): CommandHandler;
  hasCommand(name: string): boolean;
  recordWrite(toolCallId: string, path: string, content: string): Promise<void>;
  shutdown(): Promise<void>;
  cleanup(): void;
};

function makeCommandFixture(sessionId: string): CommandFixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-commands-"));
  const session = unwrap(checkedSessionId(sessionId));
  const sessionFile = join(dir, `session_${sessionId}.jsonl`);
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandHandler>();
  const notifications: Notification[] = [];
  let customUiCalls = 0;
  let customOverlayUiCalls = 0;
  const ctx = {
    cwd: dir,
    mode: "tui",
    isIdle: () => true,
    sessionManager: {
      getCwd: () => dir,
      getSessionId: () => session,
      getSessionFile: () => sessionFile
    },
    ui: {
      notify(message: string, level: string): void {
        notifications.push({ message, level });
      },
      async custom(
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: undefined) => void
        ) => { render(width: number): string[]; dispose?(): void },
        options?: { overlay?: boolean }
      ): Promise<undefined> {
        customUiCalls++;
        if (options?.overlay) customOverlayUiCalls++;
        const tui = {
          terminal: {
            columns: 120,
            rows: 30,
            write(): void {}
          },
          addInputListener(): () => void {
            return () => undefined;
          },
          requestRender(): void {},
          showOverlay(): { hide(): void } {
            return { hide(): void {} };
          }
        };
        const component = factory(tui, {}, {}, () => undefined);
        await new Promise((resolve) => setTimeout(resolve, 10));
        component.dispose?.();
        return undefined;
      },
      async select(): Promise<undefined> {
        return undefined;
      },
      async input(): Promise<undefined> {
        return undefined;
      },
      onTerminalInput(): () => void {
        return () => undefined;
      },
      setWorkingVisible(): void {},
      setWorkingMessage(): void {}
    },
    modelRegistry: {
      find(provider: string, modelId: string) {
        if (provider !== "fake-provider" || modelId !== "fake-model") return undefined;
        return {
          id: "fake-model",
          name: "Fake Model",
          api: "openai-responses",
          provider: "fake-provider",
          baseUrl: "https://example.test",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 4_000
        };
      }
    }
  } as unknown as ExtensionContext;
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: CommandHandler): void {
      commands.set(name, command);
    }
  } as unknown as ExtensionAPI;
  return {
    dir,
    session,
    ctx,
    pi,
    notifications,
    get customUiCalls(): number {
      return customUiCalls;
    },
    get customOverlayUiCalls(): number {
      return customOverlayUiCalls;
    },
    async emit(event: string, payload: unknown): Promise<void> {
      const handler = handlers.get(event);
      assert.ok(handler, `missing handler for ${event}`);
      await handler(payload, ctx);
    },
    command(name: string): CommandHandler {
      const command = commands.get(name);
      assert.ok(command, `missing command ${name}`);
      return command;
    },
    hasCommand(name: string): boolean {
      return commands.has(name);
    },
    async recordWrite(toolCallId: string, path: string, content: string): Promise<void> {
      await this.emit("tool_call", writeCall(toolCallId, path, content));
      writeText(join(dir, path), content);
      await this.emit("tool_result", writeResult(toolCallId, path, content));
    },
    async shutdown(): Promise<void> {
      const handler = handlers.get("session_shutdown");
      if (handler) await handler({ type: "session_shutdown", reason: "quit" } satisfies SessionShutdownEvent, ctx);
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    }
  };
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

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
