import { randomUUID } from "node:crypto";
import {
  checkedAnalysisRunId,
  err,
  errorMessage,
  ok,
  parseAnalysisResult,
  type AnalysisMode,
  type AnalysisManifestEvidence,
  type AnalysisRun,
  type AnalysisRunId,
  type ImplementationReviewResult,
  type NarrativeResult,
  type PatchStore,
  type Result,
  type ReviewDataset
} from "@pi-patches/store";
import { buildDiffModel } from "../render/diff-model.ts";
import { estimateTokens, planAnalysis, type AnalysisManifest } from "./planner.ts";
import { buildInvocation, parsePartial, promptVersion, type AnalysisPartial } from "./prompts.ts";
import type {
  AnalysisExecution,
  AnalysisExecutionOptions,
  AnalysisOutput,
  AnalysisRequest,
  ModelRunner
} from "./types.ts";

export async function runAnalysis(
  request: AnalysisRequest,
  runner: ModelRunner,
  options: AnalysisExecutionOptions = {}
): Promise<Result<AnalysisExecution>> {
  const model = runner.listModels().find(
    (candidate) => candidate.provider === request.model.provider && candidate.modelId === request.model.modelId
  );
  if (!model) {
    return err({ kind: "InvalidInput", field: "model", message: `${request.model.provider}/${request.model.modelId} is not available` });
  }
  const maxInputTokens = positiveLimit(
    options.maxInputTokens,
    Math.max(1024, Math.floor(model.contextWindow * 0.65) - model.maxOutputTokens)
  );
  const maxChunkTokens = Math.min(maxInputTokens, positiveLimit(options.maxChunkTokens, Math.max(512, Math.floor(maxInputTokens * 0.8))));
  const manifest = planAnalysis(request.dataset, { maxInputTokens, maxChunkTokens });
  if (options.signal?.aborted) return aborted();
  if (manifest.strategy === "direct") {
    const response = await invoke(runner, buildInvocation(request, "direct", manifest.chunks[0]?.content ?? ""), options, 1, 1);
    if (!response.ok) return response;
    const parsed = parseFinal(request, response.value.text);
    if (!parsed.ok) return parsed;
    return ok({
      output: parsed.value,
      rawOutput: response.value.text,
      documentCoverage: manifest.documentIds.map((id) => ({ id, state: { kind: "included" as const } })),
      commitCoverage: manifest.commitShas.map((id) => ({ id, state: { kind: "included" as const } })),
      promptVersion: promptVersion(request.mode)
    });
  }

  const partials: AnalysisPartial[] = [];
  for (let index = 0; index < manifest.chunks.length; index++) {
    const chunk = manifest.chunks[index];
    if (options.signal?.aborted) return aborted();
    const response = await invoke(
      runner,
      buildInvocation(request, "chunk", chunk.content),
      options,
      index + 1,
      manifest.chunks.length
    );
    if (!response.ok) return response;
    const partial = parseJsonPartial(request.mode, response.value.text);
    if (!partial.ok) return partial;
    const covered = validatePartialCoverage(partial.value, chunk.documentIds, chunk.commitShas);
    if (!covered.ok) return covered;
    partials.push(partial.value);
  }
  const reduced = await reducePartials(request, partials, runner, maxInputTokens, options);
  if (!reduced.ok) return reduced;
  const synthesisInput = `TYPED PARTIAL RESULTS\n${JSON.stringify(reduced.value)}`;
  const finalResponse = await invoke(runner, buildInvocation(request, "synthesis", synthesisInput), options, 1, 1);
  if (!finalResponse.ok) return finalResponse;
  const parsed = parseFinal(request, finalResponse.value.text);
  if (!parsed.ok) return parsed;
  return ok({
    output: parsed.value,
    rawOutput: finalResponse.value.text,
    documentCoverage: manifest.documentIds.map((id) => ({ id, state: { kind: "summarized" as const } })),
    commitCoverage: manifest.commitShas.map((id) => ({ id, state: { kind: "summarized" as const } })),
    promptVersion: promptVersion(request.mode)
  });
}

export async function executePersistedAnalysis(
  store: PatchStore,
  request: AnalysisRequest,
  runner: ModelRunner,
  options: AnalysisExecutionOptions & { runId?: AnalysisRunId; now?: () => number } = {}
): Promise<Result<AnalysisRun>> {
  const runId = options.runId ?? checkedRunId(randomUUID());
  const now = options.now ?? Date.now;
  const planned = manifestForRequest(request, runner, options);
  if (!planned.ok) return planned;
  const source = store.saveReviewSource({
    fingerprint: request.dataset.fingerprint,
    source: request.dataset.source,
    historyMode: request.dataset.historyMode,
    createdAt: now()
  });
  if (!source.ok) return source;
  const started = store.startAnalysisRun({
    id: runId,
    sourceFingerprint: request.dataset.fingerprint,
    mode: request.mode,
    model: request.model,
    promptVersion: promptVersion(request.mode),
    focus: request.focus,
    manifest: manifestEvidence(planned.value),
    startedAt: now()
  });
  if (!started.ok) return started;
  try {
    const execution = await runAnalysis(request, runner, options);
    if (!execution.ok) {
      const status = options.signal?.aborted ? "cancelled" : "failed";
      const message = errorMessage(execution.error);
      const coverage = failureCoverage(request.dataset, message);
      return store.failAnalysisRun(runId, status, message, now(), coverage.documents, coverage.commits);
    }
    const validatedSource = options.validateSourceBeforeComplete?.();
    if (validatedSource && !validatedSource.ok) {
      const message = errorMessage(validatedSource.error);
      const coverage = failureCoverage(request.dataset, message);
      return store.failAnalysisRun(runId, "failed", message, now(), coverage.documents, coverage.commits);
    }
    const verdict = execution.value.output.mode === "implementationReview" ? execution.value.output.verdict : undefined;
    const completed = store.completeAnalysisRun(runId, {
      output: execution.value.output,
      rawOutput: execution.value.rawOutput,
      reviewVerdict: verdict,
      documentCoverage: execution.value.documentCoverage,
      commitCoverage: execution.value.commitCoverage,
      completedAt: now()
    });
    if (!completed.ok) return completed;
    if (execution.value.output.mode === "implementationReview") {
      const outcome = store.recordReviewOutcome(
        request.dataset.fingerprint,
        execution.value.output.verdict,
        execution.value.output.findings.length,
        now()
      );
      if (!outcome.ok) return outcome;
    }
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const coverage = failureCoverage(request.dataset, message);
    const failed = store.failAnalysisRun(
      runId,
      options.signal?.aborted ? "cancelled" : "failed",
      message,
      now(),
      coverage.documents,
      coverage.commits
    );
    return failed.ok ? failed : err({ kind: "Io", path: "analysis", message: error instanceof Error ? error.message : String(error) });
  }
}

function manifestEvidence(manifest: AnalysisManifest): AnalysisManifestEvidence {
  return {
    strategy: manifest.strategy,
    stats: manifest.stats,
    chunks: manifest.chunks.map((chunk) => ({
      id: chunk.id,
      unitIds: chunk.unitIds,
      documentIds: chunk.documentIds,
      commitShas: chunk.commitShas,
      estimatedTokens: chunk.estimatedTokens
    })),
    documentIds: manifest.documentIds,
    commitShas: manifest.commitShas
  };
}

function failureCoverage(dataset: ReviewDataset, message: string): {
  documents: Array<{ id: string; state: { kind: "failed"; error: string } }>;
  commits: Array<{ id: string; state: { kind: "failed"; error: string } }>;
} {
  return {
    documents: dataset.documents.map((document) => ({ id: String(document.id), state: { kind: "failed", error: message } })),
    commits: dataset.historyMode === "perCommit"
      ? dataset.commits.map((commit) => ({ id: commit.sha, state: { kind: "failed", error: message } }))
      : []
  };
}

async function reducePartials(
  request: AnalysisRequest,
  initial: AnalysisPartial[],
  runner: ModelRunner,
  maxInputTokens: number,
  options: AnalysisExecutionOptions
): Promise<Result<AnalysisPartial[]>> {
  let partials = initial;
  for (let depth = 0; estimateTokens(JSON.stringify(partials)) > maxInputTokens; depth++) {
    if (depth >= 8) return err({ kind: "InvalidInput", field: "analysis.synthesis", message: "partial reduction did not fit the selected model" });
    const groups = groupPartials(partials, maxInputTokens);
    if (!groups.ok) return groups;
    const next: AnalysisPartial[] = [];
    for (let index = 0; index < groups.value.length; index++) {
      const group = groups.value[index];
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const response = await invoke(
        runner,
        buildInvocation(request, "reduce", `PARTIALS TO REDUCE\n${JSON.stringify(group)}`),
        options,
        index + 1,
        groups.value.length
      );
      if (!response.ok) return response;
      const parsed = parseJsonPartial(request.mode, response.value.text);
      if (!parsed.ok) return parsed;
      const documents = unique(group.flatMap((partial) => partial.documents));
      const commits = unique(group.flatMap((partial) => partial.commits));
      const coverage = validatePartialCoverage(parsed.value, documents, commits);
      if (!coverage.ok) return coverage;
      next.push(parsed.value);
    }
    partials = next;
  }
  return ok(partials);
}

async function invoke(
  runner: ModelRunner,
  invocation: Parameters<ModelRunner["run"]>[0],
  options: AnalysisExecutionOptions,
  completed: number,
  total: number
): Promise<Result<{ text: string }>> {
  const attempts = Math.max(1, (options.maxRetries ?? 1) + 1);
  let last: Result<{ text: string }> | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.signal?.aborted) return aborted();
    options.onProgress?.({ phase: invocation.phase, completed: completed - 1, total, message: `${invocation.phase} ${completed}/${total}` });
    const response = await runner.run(invocation, {
      signal: options.signal,
      onDelta: (delta) => options.onProgress?.({ phase: invocation.phase, completed: completed - 1, total, message: `${invocation.phase} ${completed}/${total}`, delta })
    });
    if (response.ok) {
      if (!sameModel(invocation.model, response.value.resolvedModel)) {
        return err({ kind: "InvalidInput", field: "model", message: "runner resolved a different model than selected" });
      }
      options.onProgress?.({ phase: invocation.phase, completed, total, message: `${invocation.phase} ${completed}/${total} complete` });
      return ok({ text: response.value.text });
    }
    last = response;
  }
  return last ?? err({ kind: "Io", path: "model", message: "model invocation failed" });
}

function parseFinal(request: AnalysisRequest, raw: string): Result<AnalysisOutput> {
  const json = parseJson(raw, "analysis.output");
  if (!json.ok) return json;
  const parsed = parseAnalysisResult(request.mode, json.value);
  if (!parsed.ok) return parsed;
  return request.mode === "narrative"
    ? validateNarrative(parsed.value as NarrativeResult, request.dataset)
    : validateReview(parsed.value as ImplementationReviewResult, request.dataset);
}

function validateNarrative(result: NarrativeResult, dataset: ReviewDataset): Result<NarrativeResult> {
  const expectedPaths = dataset.documents.map((document) => document.relPath).sort();
  const actualPaths = unique(result.changeMap.map((entry) => entry.path)).sort();
  if (!sameStrings(expectedPaths, actualPaths)) {
    return err({ kind: "InvalidInput", field: "narrative.changeMap", message: "must cover every selected document exactly by path" });
  }
  if (dataset.historyMode === "perCommit") {
    const expected = dataset.commits.map((commit) => commit.sha);
    const actual = result.commitNarratives.map((commit) => commit.sha);
    if (!sameStrings(expected, actual)) {
      return err({ kind: "InvalidInput", field: "narrative.commitNarratives", message: "must cover every selected commit in order" });
    }
    if (result.crossCommitSynthesis === null || result.crossCommitSynthesis.trim().length === 0) {
      return err({ kind: "InvalidInput", field: "narrative.crossCommitSynthesis", message: "perCommit requires cross-commit synthesis" });
    }
  } else if (result.commitNarratives.length !== 0 || result.crossCommitSynthesis !== null) {
    return err({ kind: "InvalidInput", field: "narrative.commitNarratives", message: "squashed narratives must describe only the net change" });
  }
  return ok(result);
}

function validateReview(result: ImplementationReviewResult, dataset: ReviewDataset): Result<ImplementationReviewResult> {
  const byPath = new Map(dataset.documents.map((document) => [document.relPath, document]));
  for (let index = 0; index < result.findings.length; index++) {
    const finding = result.findings[index];
    const document = byPath.get(finding.path);
    if (!document) return err({ kind: "InvalidInput", field: `implementationReview.findings[${index}].path`, message: "path is not in the reviewed dataset" });
    if (document.kind !== "text") return err({ kind: "InvalidInput", field: `implementationReview.findings[${index}].path`, message: "opaque documents cannot carry line findings" });
    const content = document.head.content ?? (document.baseline.kind === "present" ? document.baseline.content : "");
    const lines = content.length === 0 ? 0 : content.replace(/\n$/, "").split("\n").length;
    if (finding.endLine > Math.max(1, lines)) {
      return err({ kind: "InvalidInput", field: `implementationReview.findings[${index}].endLine`, message: "location exceeds reviewed content" });
    }
    if (dataset.source.kind !== "snapshot" && !overlapsChangedLine(document, finding.startLine, finding.endLine)) {
      return err({ kind: "InvalidInput", field: `implementationReview.findings[${index}]`, message: "finding does not overlap the reviewed diff" });
    }
  }
  if (result.coverageLimited) {
    return err({ kind: "InvalidInput", field: "implementationReview.coverageLimited", message: "the current planner did not exclude evidence" });
  }
  return ok(result);
}

function overlapsChangedLine(
  document: Extract<ReviewDataset["documents"][number], { kind: "text" }>,
  start: number,
  end: number
): boolean {
  const baseline = document.baseline.kind === "present" ? document.baseline.content : "";
  const head = document.head.content ?? "";
  const model = buildDiffModel(baseline, head, document.relPath);
  const changed = new Set<number>();
  for (let index = 0; index < model.rows.length; index++) {
    const row = model.rows[index];
    if (row.kind === "add") changed.add(Number(row.newLine));
    if (row.kind === "del") {
      if (document.head.content === null) changed.add(Number(row.oldLine));
      else {
        const next = model.rows.slice(index + 1).find((candidate) => "newLine" in candidate);
        const previous = model.rows.slice(0, index).findLast((candidate) => "newLine" in candidate);
        const mapped = next && "newLine" in next ? Number(next.newLine) : previous && "newLine" in previous ? Number(previous.newLine) : 1;
        changed.add(mapped);
      }
    }
  }
  for (let line = start; line <= end; line++) if (changed.has(line)) return true;
  return false;
}

function parseJsonPartial(mode: AnalysisMode, raw: string): Result<AnalysisPartial> {
  const json = parseJson(raw, "analysis.partial");
  return json.ok ? parsePartial(mode, json.value) : json;
}

function parseJson(raw: string, field: string): Result<unknown> {
  try {
    return ok(JSON.parse(raw));
  } catch (error) {
    return err({ kind: "InvalidInput", field, message: `expected strict JSON: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function validatePartialCoverage(partial: AnalysisPartial, documents: readonly string[], commits: readonly string[]): Result<void> {
  if (!sameStrings(unique(partial.documents).sort(), unique(documents).sort())) {
    return err({ kind: "InvalidInput", field: "analysis.partial.documents", message: "chunk result omitted or invented document ids" });
  }
  if (!sameStrings(unique(partial.commits).sort(), unique(commits).sort())) {
    return err({ kind: "InvalidInput", field: "analysis.partial.commits", message: "chunk result omitted or invented commit shas" });
  }
  return ok(undefined);
}

function groupPartials(partials: readonly AnalysisPartial[], maxTokens: number): Result<AnalysisPartial[][]> {
  const groups: AnalysisPartial[][] = [];
  let current: AnalysisPartial[] = [];
  for (const partial of partials) {
    const singleTokens = estimateTokens(JSON.stringify([partial]));
    if (singleTokens > maxTokens) return err({ kind: "InvalidInput", field: "analysis.synthesis", message: "one partial exceeds the reduction budget" });
    const candidate = [...current, partial];
    if (current.length > 0 && estimateTokens(JSON.stringify(candidate)) > maxTokens) {
      groups.push(current);
      current = [partial];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) groups.push(current);
  return ok(groups);
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function checkedRunId(value: string): AnalysisRunId {
  const result = checkedAnalysisRunId(value);
  if (!result.ok) throw new Error(errorMessage(result.error));
  return result.value;
}

function sameModel(left: AnalysisRequest["model"], right: AnalysisRequest["model"]): boolean {
  return left.provider === right.provider && left.modelId === right.modelId && left.thinkingLevel === right.thinkingLevel;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function aborted(): Result<never> {
  return err({ kind: "Io", path: "analysis", message: "analysis cancelled" });
}

export function manifestForRequest(request: AnalysisRequest, runner: ModelRunner, options: AnalysisExecutionOptions = {}): Result<AnalysisManifest> {
  const model = runner.listModels().find((candidate) => candidate.provider === request.model.provider && candidate.modelId === request.model.modelId);
  if (!model) return err({ kind: "InvalidInput", field: "model", message: "selected model is unavailable" });
  const maxInputTokens = positiveLimit(options.maxInputTokens, Math.max(1024, Math.floor(model.contextWindow * 0.65) - model.maxOutputTokens));
  const maxChunkTokens = Math.min(maxInputTokens, positiveLimit(options.maxChunkTokens, Math.max(512, Math.floor(maxInputTokens * 0.8))));
  return ok(planAnalysis(request.dataset, { maxInputTokens, maxChunkTokens }));
}
