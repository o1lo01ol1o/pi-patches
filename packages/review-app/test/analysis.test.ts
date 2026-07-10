import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  baselineFromContent,
  checkedAnalysisRunId,
  checkedDocumentId,
  err,
  hashContent,
  hashReviewSource,
  ok,
  parseImplementationReviewResult,
  parseNarrativeResult,
  PatchStore,
  type AnalysisRunId,
  type CommitChange,
  type ModelSelection,
  type Result,
  type ReviewDataset,
  type TextReviewDocument
} from "@pi-patches/store";
import {
  executePersistedAnalysis,
  manifestForRequest,
  runAnalysis,
  type AnalysisRequest,
  type ModelInvocation,
  type ModelOption,
  type ModelResponse,
  type ModelRunner
} from "../src/analysis/index.ts";

const selection: ModelSelection = { provider: "fake", modelId: "review-model", thinkingLevel: "high" };
const modelOption: ModelOption = {
  ...selection,
  name: "Review Model",
  contextWindow: 8_192,
  maxOutputTokens: 1_024,
  supportsThinking: true
};

test("narrative and implementation-review parsers reject task conflation and illegal findings", () => {
  const narrative = validNarrative(squashedDataset());
  assert.equal(parseNarrativeResult({ ...narrative, verdict: "correct" }).ok, false);
  assert.equal(parseNarrativeResult({ ...narrative, findings: [] }).ok, false);

  const review = validReview();
  assert.equal(parseImplementationReviewResult({ ...review, verdict: "correct" }).ok, false);
  assert.equal(parseImplementationReviewResult({ ...review, findings: [{ ...review.findings[0], priority: "urgent" }] }).ok, false);
  assert.equal(parseImplementationReviewResult({ ...review, callouts: [{ path: null, startLine: null, endLine: null, message: "note", priority: "P3" }] }).ok, false);
});

test("direct narrative uses the selected model and remains separate from review", async () => {
  const dataset = squashedDataset();
  const output = validNarrative(dataset);
  const runner = new FakeRunner((invocation) => {
    assert.equal(invocation.mode, "narrative");
    assert.equal(invocation.phase, "direct");
    assert.doesNotMatch(invocation.systemPrompt, /implementation reviewer/i);
    return JSON.stringify(output);
  });
  const request = { mode: "narrative", dataset, model: selection, focus: "public API" } as const;

  const result = unwrap(await runAnalysis(request, runner, { maxInputTokens: 10_000 }));

  assert.equal(result.output.mode, "narrative");
  assert.deepEqual(result.documentCoverage.map((entry) => entry.state.kind), ["included", "included"]);
  assert.deepEqual(runner.invocations.map((invocation) => invocation.model), [selection]);
  assert.match(runner.invocations[0].userPrompt, /One-run focus: public API/);
  assert.doesNotMatch(runner.invocations[0].userPrompt, /Project review guidelines/);
});

test("hierarchical per-commit narrative covers every commit and performs cross-commit synthesis", async () => {
  const dataset = perCommitDataset();
  const request = { mode: "narrative", dataset, model: selection } as const;
  const probe = new FakeRunner(() => "{}");
  const manifest = unwrap(manifestForRequest(request, probe, { maxInputTokens: 400, maxChunkTokens: 110 }));
  assert.equal(manifest.strategy, "hierarchical");
  let chunkIndex = 0;
  const runner = new FakeRunner((invocation) => {
    if (invocation.phase === "chunk") {
      const chunk = manifest.chunks[chunkIndex++];
      return JSON.stringify({
        mode: "narrativeChunk",
        summary: `chunk ${chunk.id}`,
        facts: ["fact"],
        documents: chunk.documentIds,
        commits: chunk.commitShas
      });
    }
    if (invocation.phase === "reduce") {
      const partials = reducedInput(invocation);
      return JSON.stringify({
        mode: "narrativeChunk",
        summary: "reduced",
        facts: partials.flatMap((partial) => partial.facts ?? []),
        documents: unique(partials.flatMap((partial) => partial.documents)),
        commits: unique(partials.flatMap((partial) => partial.commits))
      });
    }
    assert.equal(invocation.phase, "synthesis");
    return JSON.stringify(validNarrative(dataset));
  });

  const result = unwrap(await runAnalysis(request, runner, { maxInputTokens: 400, maxChunkTokens: 110 }));

  assert.equal(result.output.mode, "narrative");
  assert.deepEqual(
    result.output.mode === "narrative" ? result.output.commitNarratives.map((commit) => commit.sha) : [],
    dataset.commits.map((commit) => commit.sha)
  );
  assert.match(result.output.mode === "narrative" ? result.output.crossCommitSynthesis ?? "" : "", /evolution.*revert/i);
  assert.ok(runner.invocations.some((invocation) => invocation.phase === "chunk"));
  assert.ok(runner.invocations.some((invocation) => invocation.phase === "reduce"));
  assert.equal(runner.invocations.at(-1)?.phase, "synthesis");
  assert.deepEqual(result.commitCoverage.map((entry) => entry.id), dataset.commits.map((commit) => commit.sha));
  assert.ok(result.commitCoverage.every((entry) => entry.state.kind === "summarized"));
});

test("implementation review includes guidelines and enforces diff locations", async () => {
  const dataset = squashedDataset();
  const runner = new FakeRunner((invocation) => {
    assert.equal(invocation.mode, "implementationReview");
    assert.match(invocation.userPrompt, /Project review guidelines:\nCheck resource cleanup\./);
    assert.doesNotMatch(invocation.systemPrompt, /change narrator/i);
    return JSON.stringify(validReview());
  });
  const request = {
    mode: "implementationReview",
    dataset,
    model: selection,
    guidelines: "Check resource cleanup."
  } as const;
  const result = unwrap(await runAnalysis(request, runner, { maxInputTokens: 10_000 }));
  assert.equal(result.output.mode, "implementationReview");
  assert.equal(result.output.mode === "implementationReview" ? result.output.verdict : null, "needsAttention");

  const outsideRunner = new FakeRunner(() => JSON.stringify({
    ...validReview(),
    findings: [{ ...validReview().findings[0], startLine: 99, endLine: 99 }]
  }));
  const invalid = await runAnalysis(request, outsideRunner, { maxInputTokens: 10_000 });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.kind, "InvalidInput");
});

test("planner is stable, splits oversized evidence, and never drops document or commit ids", () => {
  const request = { mode: "narrative", dataset: perCommitDataset(), model: selection } as const;
  const runner = new FakeRunner(() => "{}");
  const first = unwrap(manifestForRequest(request, runner, { maxInputTokens: 180, maxChunkTokens: 110 }));
  const second = unwrap(manifestForRequest(request, runner, { maxInputTokens: 180, maxChunkTokens: 110 }));
  assert.deepEqual(first, second);
  assert.ok(first.chunks.length > 1);
  assert.deepEqual(unique(first.chunks.flatMap((chunk) => chunk.documentIds)).sort(), first.documentIds.slice().sort());
  assert.deepEqual(unique(first.chunks.flatMap((chunk) => chunk.commitShas)).sort(), first.commitShas.slice().sort());
  assert.ok(first.chunks.every((chunk) => chunk.estimatedTokens <= 110));
  assert.ok(first.chunks.every((chunk) => chunk.unitIds.length > 0));
});

test("provider retry, cancellation, parse failure, and persisted status boundaries are explicit", async () => {
  const dataset = squashedDataset();
  const request = { mode: "narrative", dataset, model: selection } as const;
  let calls = 0;
  const retryRunner = new FakeRunner(() => {
    calls++;
    return calls === 1 ? err({ kind: "Io", path: "fake", message: "temporary" }) : JSON.stringify(validNarrative(dataset));
  });
  assert.equal((await runAnalysis(request, retryRunner, { maxInputTokens: 10_000, maxRetries: 1 })).ok, true);
  assert.equal(calls, 2);

  const dir = mkdtempSync(join(tmpdir(), "pi-patches-analysis-"));
  try {
    const store = unwrap(PatchStore.open(join(dir, "patches.db"), { create: true }));
    const badRunner = new FakeRunner(() => "not-json");
    const failedId = unwrap(checkedAnalysisRunId("failed-run"));
    const failed = unwrap(await executePersistedAnalysis(store, request, badRunner, {
      runId: failedId,
      maxInputTokens: 10_000,
      now: monotonicClock(10)
    }));
    assert.equal(failed.status, "failed");
    assert.equal(failed.output, null);
    assert.equal(failed.documentCoverage.length, dataset.documents.length);
    assert.ok(failed.documentCoverage.every((entry) => entry.state.kind === "failed"));

    const controller = new AbortController();
    controller.abort();
    const cancelledId = unwrap(checkedAnalysisRunId("cancelled-run"));
    const cancelled = unwrap(await executePersistedAnalysis(store, request, badRunner, {
      runId: cancelledId,
      signal: controller.signal,
      now: monotonicClock(20)
    }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.documentCoverage.length, dataset.documents.length);

    const staleId = unwrap(checkedAnalysisRunId("stale-source-run"));
    const stale = unwrap(await executePersistedAnalysis(
      store,
      request,
      new FakeRunner(() => JSON.stringify(validNarrative(dataset))),
      {
        runId: staleId,
        now: monotonicClock(30),
        validateSourceBeforeComplete: () => err({ kind: "InvalidInput", field: "source", message: "source changed" })
      }
    ));
    assert.equal(stale.status, "failed");
    assert.match(stale.error ?? "", /source changed/);
    assert.ok(stale.documentCoverage.every((entry) => entry.state.kind === "failed"));
    unwrap(store.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted successful runs retain model, prompt, source, result, coverage, and outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-analysis-success-"));
  try {
    const store = unwrap(PatchStore.open(join(dir, "patches.db"), { create: true }));
    const dataset = squashedDataset();
    const request = { mode: "implementationReview", dataset, model: selection, guidelines: null } as const;
    const runId = unwrap(checkedAnalysisRunId("review-run"));
    const run = unwrap(await executePersistedAnalysis(
      store,
      request,
      new FakeRunner(() => JSON.stringify(validReview())),
      { runId, maxInputTokens: 10_000, now: monotonicClock(30) }
    ));
    assert.equal(run.status, "completed");
    assert.deepEqual(run.model, selection);
    assert.equal(run.promptVersion, "pi-patches/implementation-review/v1");
    assert.equal(run.sourceFingerprint, dataset.fingerprint);
    assert.equal(run.manifest.strategy, "direct");
    assert.deepEqual(run.manifest.documentIds, dataset.documents.map((document) => String(document.id)));
    assert.ok(run.manifest.chunks[0]?.unitIds.every((id) => id.startsWith("document:")));
    assert.equal(run.output?.mode, "implementationReview");
    assert.equal(run.documentCoverage.length, dataset.documents.length);
    assert.equal(unwrap(store.getReviewOutcome(dataset.fingerprint))?.verdict, "needsAttention");
    unwrap(store.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakeRunner implements ModelRunner {
  readonly invocations: ModelInvocation[] = [];
  private readonly respond: (invocation: ModelInvocation) => string | Result<never>;

  constructor(respond: (invocation: ModelInvocation) => string | Result<never>) {
    this.respond = respond;
  }

  listModels(): readonly ModelOption[] {
    return [modelOption];
  }

  async run(invocation: ModelInvocation): Promise<Result<ModelResponse>> {
    this.invocations.push(invocation);
    const response = this.respond(invocation);
    return typeof response === "string" ? ok({ text: response, resolvedModel: selection }) : response;
  }
}

function squashedDataset(): ReviewDataset {
  const documents = [
    textDocument("src/a.ts", "export const value = 0;\n", "export const value = 1;\n"),
    textDocument("test/a.test.ts", "", "test('value', () => assert(value));\n")
  ];
  const source = { kind: "workingTree", base: "HEAD" } as const;
  return {
    source,
    historyMode: "squashed",
    fingerprint: hashReviewSource({ source, documents: documents.map((document) => document.head.hash) }),
    documents,
    commits: []
  };
}

function perCommitDataset(): ReviewDataset {
  const large = Array.from({ length: 80 }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n";
  const documents = [
    textDocument("src/feature.ts", "", large),
    textDocument("src/migration.ts", "old\n", "final\n"),
    textDocument("test/feature.test.ts", "", "test('feature', () => true);\n")
  ];
  const shas = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
  const commits: CommitChange[] = shas.map((sha, index) => ({
    sha,
    parents: index === 0 ? [] : [shas[index - 1]],
    subject: ["add feature", "stage migration", "correct and revert migration"][index],
    authoredAt: index + 1,
    documents: [documents[index].id],
    changes: [{
      documentId: documents[index].id,
      status: index === 1 ? "modified" : "added",
      oldPath: null,
      patch: `--- a/${documents[index].relPath}\n+++ b/${documents[index].relPath}\n${large}`
    }]
  }));
  const source = { kind: "commitRange", baseExclusive: "0".repeat(40), headInclusive: shas[2] } as const;
  return {
    source,
    historyMode: "perCommit",
    fingerprint: hashReviewSource({ source, documents: documents.map((document) => document.head.hash), shas }),
    documents,
    commits
  };
}

function textDocument(path: string, baseline: string, head: string): TextReviewDocument {
  const id = unwrap(checkedDocumentId(path));
  return {
    kind: "text",
    id,
    path: `/tmp/${path}`,
    relPath: path,
    baseline: baselineFromContent(baseline),
    head: { content: head, hash: hashContent(head) },
    renamedFrom: null,
    provenance: []
  };
}

function validNarrative(dataset: ReviewDataset) {
  return {
    mode: "narrative" as const,
    scope: "selected changes",
    executiveSummary: "The selected implementation changes behavior and tests.",
    changeMap: dataset.documents.map((document) => ({ path: document.relPath, summary: "Changed this document." })),
    changes: {
      behavioral: ["Behavior changes."],
      apiSchema: [],
      configuration: [],
      dependencies: [],
      tests: ["Tests change."],
      documentation: []
    },
    interactions: ["Implementation and tests move together."],
    questions: [],
    commitNarratives: dataset.historyMode === "perCommit"
      ? dataset.commits.map((commit) => ({ sha: commit.sha, summary: commit.subject }))
      : [],
    crossCommitSynthesis: dataset.historyMode === "perCommit"
      ? "The feature evolution stages a migration, then applies a correction and revert to reach the final net effect."
      : null
  };
}

function validReview() {
  return {
    mode: "implementationReview" as const,
    scope: "working-tree changes",
    verdict: "needsAttention" as const,
    findings: [{
      priority: "P1" as const,
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      title: "Export changes without compatibility handling",
      scenario: "A caller expects the previous exported value.",
      impact: "The caller observes incompatible behavior.",
      correctiveDirection: "Preserve or intentionally migrate the contract."
    }],
    callouts: [{ path: "test/a.test.ts", startLine: 1, endLine: 1, message: "A human should confirm test intent." }],
    coverageSummary: "Reviewed both changed files.",
    coverageLimited: false
  };
}

function reducedInput(invocation: ModelInvocation): Array<{ facts?: string[]; documents: string[]; commits: string[] }> {
  const marker = "PARTIALS TO REDUCE\n";
  const start = invocation.userPrompt.lastIndexOf(marker);
  if (start < 0) throw new Error("missing reduction payload");
  return JSON.parse(invocation.userPrompt.slice(start + marker.length));
}

function monotonicClock(start: number): () => number {
  let current = start;
  return () => current++;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
