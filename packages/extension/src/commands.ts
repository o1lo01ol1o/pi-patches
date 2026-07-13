import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { discover, errorMessage, type HistoryMode, type PatchStore, type Result, type SessionId, type SessionRecord } from "@pi-patches/store";
import { type AnalysisRequest, type ModelRunner } from "@pi-patches/review-app/analysis";
import { loadAppState, loadDatasetAppState } from "@pi-patches/review-app/app";
import { createReviewComponent, type PendingAnalysis } from "@pi-patches/review-app/runner";
import {
  listBranches,
  listRecentCommits,
  loadReviewGuidelines,
  materializeInspectRequest,
  materializeWorkingTree,
  parseInspectArgs,
  smartPreselection,
  sourcePresetOrder,
  systemCommandRunner,
  validatePullRequestSource,
  type InspectRequest,
  type CommandRunner,
  type SourcePreset
} from "@pi-patches/review-app/sources";
import { PiModelRunner, defaultModelSelection } from "./model-runner.ts";
import { getRecorderState } from "./recorder.ts";

export type CommandDependencies = {
  commandRunner: CommandRunner;
  createModelRunner(ctx: ExtensionContext): ModelRunner;
};

const defaultDependencies: CommandDependencies = {
  commandRunner: systemCommandRunner,
  createModelRunner: (ctx) => new PiModelRunner(ctx.modelRegistry)
};

export function registerCommands(pi: ExtensionAPI, overrides: Partial<CommandDependencies> = {}): void {
  const dependencies = { ...defaultDependencies, ...overrides };
  pi.registerCommand("patches", {
    description: "Show pi-patches recorder status",
    handler: async (args: string, ctx: ExtensionContext) => {
      const state = getRecorderState();
      if (!state) {
        ctx.ui.notify("pi-patches recorder is not active", "warning");
        return;
      }
      const trimmed = args.trim();
      const command = trimmed.split(/\s+/, 1)[0] ?? "";
      const rest = trimmed.slice(command.length).trim();
      if (command.length > 0) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/patches interactive commands require pi interactive mode", "warning");
          return;
        }
        if (command === "connect") {
          if (rest.length === 0 || /\s/.test(rest)) {
            ctx.ui.notify("Usage: /patches connect <session-id-or-prefix>", "warning");
            return;
          }
          await connectReview(ctx, state.dbPath, rest, dependencies.commandRunner);
          return;
        }
        if (command === "inspect") {
          await inspectReview(ctx, state.dbPath, rest, dependencies);
          return;
        }
        if (command === "analyze") {
          await analyzeReview(ctx, state.dbPath, rest, dependencies);
          return;
        }
        ctx.ui.notify("Usage: /patches [connect <session>] | [inspect [source...]] | [analyze [source...]]", "warning");
        return;
      }
      const counts = state.store.counts(state.sessionId);
      if (!counts.ok) {
        ctx.ui.notify(`pi-patches: ${errorMessage(counts.error)}`, "error");
        return;
      }
      ctx.ui.notify(
        [
          `session ${state.sessionId}`,
          `${counts.value.files} files, ${counts.value.patches} patches · queued ${counts.value.queued}, sent ${counts.value.sent}`,
          `Open review: /patches connect ${state.sessionId}`
        ].join("\n"),
        "info"
      );
    }
  });
}

async function connectReview(ctx: ExtensionContext, dbPath: string, selector: string, commandRunner: CommandRunner): Promise<void> {
  const discovery = discover({ db: dbPath, session: selector, list: false, help: false });
  if (!discovery.ok) {
    ctx.ui.notify(`pi-patches: ${errorMessage(discovery.error)}`, "warning");
    return;
  }
  if (!discovery.value.session) {
    discovery.value.store.close();
    ctx.ui.notify("pi-patches: no matching session", "warning");
    return;
  }
  const initialState = loadAppState(discovery.value.store, discovery.value.session);
  if (!initialState.ok) {
    discovery.value.store.close();
    ctx.ui.notify(`pi-patches: ${errorMessage(initialState.error)}`, "error");
    return;
  }
  const guidelines = attachReviewGuidelines(ctx, initialState.value);
  if (!guidelines) {
    discovery.value.store.close();
    return;
  }
  try {
    await openReview(ctx, discovery.value, initialState.value, undefined, commandRunner);
  } finally {
    discovery.value.store.close();
  }
}

async function inspectReview(ctx: ExtensionContext, dbPath: string, args: string, dependencies: CommandDependencies): Promise<void> {
  const discovery = discover({ db: dbPath, list: false, help: false });
  if (!discovery.ok) {
    ctx.ui.notify(`pi-patches: ${errorMessage(discovery.error)}`, "warning");
    return;
  }
  if (!discovery.value.session) {
    discovery.value.store.close();
    ctx.ui.notify("pi-patches: no current session", "warning");
    return;
  }
  try {
    const request = args.length === 0
      ? await selectInspectRequest(ctx, discovery.value.store, discovery.value.session, dependencies.commandRunner)
      : parseInspectArgs(args);
    if (request === undefined) return;
    if (!request.ok) {
      ctx.ui.notify(`pi-patches: ${errorMessage(request.error)}`, "warning");
      return;
    }
    if (request.value === null) return;
    const dataset = materializeInspectRequest(request.value, {
      cwd: ctx.cwd,
      store: discovery.value.store,
      currentSession: discovery.value.session,
      runner: dependencies.commandRunner
    });
    if (!dataset.ok) {
      ctx.ui.notify(`pi-patches: ${errorMessage(dataset.error)}`, "error");
      return;
    }
    const state = loadDatasetAppState(discovery.value.store, discovery.value.session, dataset.value, request.value);
    if (!state.ok) {
      ctx.ui.notify(`pi-patches: ${errorMessage(state.error)}`, "error");
      return;
    }
    if (!attachReviewGuidelines(ctx, state.value)) return;
    await openReview(ctx, discovery.value, state.value, undefined, dependencies.commandRunner);
  } finally {
    discovery.value.store.close();
  }
}

async function analyzeReview(ctx: ExtensionContext, dbPath: string, args: string, dependencies: CommandDependencies): Promise<void> {
  const discovery = discover({ db: dbPath, list: false, help: false });
  if (!discovery.ok) {
    ctx.ui.notify(`pi-patches: ${errorMessage(discovery.error)}`, "warning");
    return;
  }
  if (!discovery.value.session) {
    discovery.value.store.close();
    ctx.ui.notify("pi-patches: no current session", "warning");
    return;
  }
  try {
    const selectedSource = args.length === 0
      ? await selectInspectRequest(ctx, discovery.value.store, discovery.value.session, dependencies.commandRunner)
      : parseInspectArgs(args);
    if (selectedSource === undefined) return;
    if (!selectedSource.ok) {
      ctx.ui.notify(`pi-patches: ${errorMessage(selectedSource.error)}`, "warning");
      return;
    }
    const sourceRequest = selectedSource.value ?? { source: { kind: "session", sessionId: discovery.value.session.id }, historyMode: "squashed" } as const;
    const dataset = materializeInspectRequest(sourceRequest, {
      cwd: ctx.cwd,
      store: discovery.value.store,
      currentSession: discovery.value.session,
      runner: dependencies.commandRunner
    });
    if (!dataset.ok) {
      ctx.ui.notify(`pi-patches: ${errorMessage(dataset.error)}`, "error");
      return;
    }
    const runner = dependencies.createModelRunner(ctx);
    const mode = await ctx.ui.select("Analysis mode", ["Narrative", "Implementation review"]);
    if (!mode) return;
    const model = await selectModel(ctx, runner);
    if (!model) return;
    const focus = await selectFocus(ctx);
    if (focus === null) return;
    const guidelines = loadReviewGuidelines(ctx.cwd);
    if (!guidelines.ok) {
      ctx.ui.notify(`pi-patches: ${errorMessage(guidelines.error)}`, "error");
      return;
    }
    const request: AnalysisRequest = mode === "Narrative"
      ? { mode: "narrative", dataset: dataset.value, model, ...(focus === undefined ? {} : { focus }) }
      : {
          mode: "implementationReview",
          dataset: dataset.value,
          model,
          ...(focus === undefined ? {} : { focus }),
          guidelines: guidelines.value?.contents ?? null
        };
    const state = loadDatasetAppState(discovery.value.store, discovery.value.session, dataset.value, sourceRequest);
    if (!state.ok) {
      ctx.ui.notify(`pi-patches: ${errorMessage(state.error)}`, "error");
      return;
    }
    state.value.reviewGuidelines = guidelines.value
      ? { path: guidelines.value.path, contents: guidelines.value.contents }
      : null;
    await openReview(ctx, discovery.value, state.value, {
      request,
      runner,
      ...(dataset.value.source.kind === "pullRequest"
        ? {
            executionOptions: {
              validateSourceBeforeComplete: () => validatePullRequestSource(ctx.cwd, dataset.value.source as Extract<typeof dataset.value.source, { kind: "pullRequest" }>, dependencies.commandRunner)
            }
          }
        : {})
    }, dependencies.commandRunner);
  } finally {
    discovery.value.store.close();
  }
}

async function selectInspectRequest(
  ctx: ExtensionContext,
  store: PatchStore,
  session: SessionRecord,
  commandRunner: CommandRunner
): Promise<Result<InspectRequest | null> | undefined> {
  const counts = store.counts(session.id);
  if (!counts.ok) return counts;
  const working = materializeWorkingTree(ctx.cwd, "squashed", commandRunner);
  const branches = listBranches(ctx.cwd, commandRunner);
  const currentBranch = branches.ok ? branches.value.find((branch) => branch.current) : undefined;
  const recommended = smartPreselection({
    connectedSessionHasPatches: counts.value.patches > 0,
    workingTreeHasChanges: working.ok && working.value.documents.length > 0,
    onNonDefaultBranch: currentBranch !== undefined && !currentBranch.isDefault
  });
  const labels = sourcePresetOrder.map((preset) => `${presetLabel(preset)}${preset === recommended ? " (recommended)" : ""}`);
  const selected = await ctx.ui.select("Review source", labels);
  if (!selected) return undefined;
  const preset = sourcePresetOrder[labels.indexOf(selected)];
  if (!preset) return undefined;
  return requestForPreset(ctx, preset, session.id, commandRunner);
}

async function requestForPreset(ctx: ExtensionContext, preset: SourcePreset, sessionId: SessionId, commandRunner: CommandRunner): Promise<Result<InspectRequest | null> | undefined> {
  switch (preset) {
    case "session":
      return okInspect({ source: { kind: "session", sessionId }, historyMode: "squashed" });
    case "workingTree":
      return okInspect({ source: { kind: "workingTree" }, historyMode: "squashed" });
    case "staged":
      return okInspect({ source: { kind: "staged" }, historyMode: "squashed" });
    case "unstaged":
      return okInspect({ source: { kind: "unstaged" }, historyMode: "squashed" });
    case "baseBranch": {
      const branches = listBranches(ctx.cwd, commandRunner);
      if (!branches.ok) return branches;
      const candidates = branches.value.filter((branch) => !branch.current);
      const labels = candidates.map((branch) => `${branch.name}${branch.isDefault ? " (default)" : ""}`);
      const selected = await ctx.ui.select("Base branch", labels);
      if (!selected) return undefined;
      const branch = candidates[labels.indexOf(selected)];
      if (!branch) return undefined;
      const historyMode = await selectHistoryMode(ctx);
      return historyMode ? okInspect({ source: { kind: "branch", baseRef: branch.name, headRef: "HEAD" }, historyMode }) : undefined;
    }
    case "commitRange": {
      const kind = await ctx.ui.select("Commit source", ["Recent commit", "Commit range"]);
      if (!kind) return undefined;
      const historyMode = await selectHistoryMode(ctx);
      if (!historyMode) return undefined;
      if (kind === "Recent commit") {
        const commits = listRecentCommits(ctx.cwd, commandRunner);
        if (!commits.ok) return commits;
        const labels = commits.value.map((commit) => `${commit.sha.slice(0, 8)} ${commit.subject}`);
        const selected = await ctx.ui.select("Commit", labels);
        if (!selected) return undefined;
        const commit = commits.value[labels.indexOf(selected)];
        return commit ? okInspect({ source: { kind: "commit", sha: commit.sha }, historyMode }) : undefined;
      }
      const range = await ctx.ui.input("Commit range", "base..head");
      return range ? parseInspectArgs(`range ${range} --history ${historyMode}`) : undefined;
    }
    case "pullRequest": {
      const value = await ctx.ui.input("Pull request", "number");
      if (!value) return undefined;
      const historyMode = await selectHistoryMode(ctx);
      return historyMode ? parseInspectArgs(`pr ${value} --history ${historyMode}`) : undefined;
    }
    case "snapshot": {
      const value = await ctx.ui.input("Snapshot paths", "path [path ...]");
      return value ? parseInspectArgs(`snapshot ${value}`) : undefined;
    }
  }
}

async function selectHistoryMode(ctx: ExtensionContext): Promise<HistoryMode | undefined> {
  const selected = await ctx.ui.select("History", ["Squashed", "Per commit"]);
  return selected === "Squashed" ? "squashed" : selected === "Per commit" ? "perCommit" : undefined;
}

async function selectModel(ctx: ExtensionContext, runner: ModelRunner): Promise<AnalysisRequest["model"] | undefined> {
  const models = [...runner.listModels()];
  const preferred = defaultModelSelection(runner, ctx.model);
  models.sort((left, right) => Number(isPreferred(right, preferred)) - Number(isPreferred(left, preferred)));
  const labels = models.map((model) => `${model.provider}/${model.modelId} · ${model.name}`);
  const selected = await ctx.ui.select("Model", labels);
  if (!selected) return undefined;
  const model = models[labels.indexOf(selected)];
  if (!model) return undefined;
  const raw = ctx.modelRegistry.find(model.provider, model.modelId);
  if (!raw) return undefined;
  const levels = getSupportedThinkingLevels(raw);
  const selectedLevel = await ctx.ui.select("Thinking", levels);
  if (!selectedLevel) return undefined;
  const thinkingLevel = levels.find((level) => level === selectedLevel);
  return thinkingLevel ? { provider: model.provider, modelId: model.modelId, thinkingLevel } : undefined;
}

async function selectFocus(ctx: ExtensionContext): Promise<string | undefined | null> {
  const selected = await ctx.ui.select("Focus", ["No one-off focus", "Add one-off focus"]);
  if (!selected) return null;
  if (selected === "No one-off focus") return undefined;
  const value = await ctx.ui.input("Analysis focus", "one-run instruction");
  if (value === undefined) return null;
  const focus = value.trim();
  return focus.length === 0 ? undefined : focus;
}

async function openReview(
  ctx: ExtensionContext,
  discovery: import("@pi-patches/store").Discovery,
  state: import("@pi-patches/review-app/app").AppState,
  analysis: PendingAnalysis | undefined,
  commandRunner: CommandRunner
): Promise<void> {
  await ctx.ui.custom(
    (tui, _theme, _keybindings, done) =>
      createReviewComponent(tui, discovery, state, () => done(undefined), {
        reservedRows: 0,
        analysis,
        sourceCwd: ctx.cwd,
        sourceCommandRunner: commandRunner
      }),
    {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 }
    }
  );
}

function attachReviewGuidelines(
  ctx: ExtensionContext,
  state: import("@pi-patches/review-app/app").AppState
): boolean {
  const guidelines = loadReviewGuidelines(ctx.cwd);
  if (!guidelines.ok) {
    ctx.ui.notify(`pi-patches: ${errorMessage(guidelines.error)}`, "error");
    return false;
  }
  state.reviewGuidelines = guidelines.value === null
    ? null
    : { path: guidelines.value.path, contents: guidelines.value.contents };
  return true;
}

function presetLabel(preset: SourcePreset): string {
  switch (preset) {
    case "session": return "Session";
    case "workingTree": return "Working tree";
    case "staged": return "Staged";
    case "unstaged": return "Unstaged";
    case "baseBranch": return "Base branch";
    case "commitRange": return "Commit or range";
    case "pullRequest": return "Pull request";
    case "snapshot": return "Snapshot";
  }
}

function okInspect(request: InspectRequest): Result<InspectRequest> {
  return { ok: true, value: request };
}

function isPreferred(model: AnalysisRequest["model"], preferred: AnalysisRequest["model"] | null): boolean {
  return preferred !== null && model.provider === preferred.provider && model.modelId === preferred.modelId;
}
