import type { AnalysisMode, ImplementationReviewResult, NarrativeResult, Result } from "@pi-patches/store";
import { err, ok, parseImplementationReviewResult } from "@pi-patches/store";
import type { AnalysisRequest, ModelInvocation } from "./types.ts";

export const narrativePromptVersion = "pi-patches/narrative/v1";
export const implementationReviewPromptVersion = "pi-patches/implementation-review/v1";

export type NarrativePartial = {
  mode: "narrativeChunk";
  summary: string;
  facts: readonly string[];
  documents: readonly string[];
  commits: readonly string[];
};

export type ReviewPartial = {
  mode: "reviewChunk";
  summary: string;
  findings: ImplementationReviewResult["findings"];
  callouts: ImplementationReviewResult["callouts"];
  documents: readonly string[];
  commits: readonly string[];
};

export type AnalysisPartial = NarrativePartial | ReviewPartial;

export function promptVersion(mode: AnalysisMode): string {
  return mode === "narrative" ? narrativePromptVersion : implementationReviewPromptVersion;
}

export function buildInvocation(
  request: AnalysisRequest,
  phase: ModelInvocation["phase"],
  content: string
): ModelInvocation {
  return {
    mode: request.mode,
    phase,
    promptVersion: promptVersion(request.mode),
    model: request.model,
    systemPrompt: request.mode === "narrative" ? narrativeSystemPrompt : reviewSystemPrompt,
    userPrompt: buildUserPrompt(request, phase, content)
  };
}

export function parsePartial(mode: AnalysisMode, value: unknown): Result<AnalysisPartial> {
  if (!isRecord(value)) return invalid("partial", "expected object");
  const summary = nonEmpty(value.summary, "partial.summary");
  const documents = strings(value.documents, "partial.documents");
  const commits = strings(value.commits, "partial.commits");
  if (!summary.ok) return summary;
  if (!documents.ok) return documents;
  if (!commits.ok) return commits;
  if (mode === "narrative") {
    if (value.mode !== "narrativeChunk") return invalid("partial.mode", "expected narrativeChunk");
    if ("findings" in value || "verdict" in value) return invalid("partial", "narrative chunks cannot contain review findings or verdicts");
    const facts = strings(value.facts, "partial.facts");
    return facts.ok ? ok({ mode: "narrativeChunk", summary: summary.value, facts: facts.value, documents: documents.value, commits: commits.value }) : facts;
  }
  if (value.mode !== "reviewChunk") return invalid("partial.mode", "expected reviewChunk");
  const findingsValue = Array.isArray(value.findings) ? value.findings : null;
  const calloutsValue = Array.isArray(value.callouts) ? value.callouts : null;
  if (findingsValue === null || calloutsValue === null) return invalid("partial", "review chunks require findings and callouts arrays");
  const parsed = parseImplementationReviewResult({
    mode: "implementationReview",
    scope: "chunk",
    verdict: findingsValue.length === 0 ? "correct" : "needsAttention",
    findings: findingsValue,
    callouts: calloutsValue,
    coverageSummary: "chunk",
    coverageLimited: false
  });
  return parsed.ok
    ? ok({
        mode: "reviewChunk",
        summary: summary.value,
        findings: parsed.value.findings,
        callouts: parsed.value.callouts,
        documents: documents.value,
        commits: commits.value
      })
    : parsed;
}

export function finalResultSchema(mode: AnalysisMode): string {
  return mode === "narrative" ? narrativeSchema : reviewSchema;
}

function buildUserPrompt(request: AnalysisRequest, phase: ModelInvocation["phase"], content: string): string {
  const source = JSON.stringify({
    source: request.dataset.source,
    historyMode: request.dataset.historyMode,
    fingerprint: request.dataset.fingerprint,
    documents: request.dataset.documents.map((document) => document.relPath),
    commits: request.dataset.historyMode === "perCommit" ? request.dataset.commits.map((commit) => commit.sha) : []
  });
  const focus = request.focus ? `\nOne-run focus: ${request.focus}` : "";
  const guidelines = request.mode === "implementationReview" && request.guidelines
    ? `\nProject review guidelines:\n${request.guidelines}`
    : "";
  if (phase === "chunk" || phase === "reduce") {
    return [
      `Task phase: ${phase}. Source identity: ${source}.${focus}${guidelines}`,
      "Return only one JSON object matching this chunk schema:",
      request.mode === "narrative" ? narrativeChunkSchema : reviewChunkSchema,
      "The documents and commits arrays must list every id present in this input. Do not silently omit evidence.",
      content
    ].join("\n\n");
  }
  return [
    `Task phase: ${phase}. Source identity: ${source}.${focus}${guidelines}`,
    request.mode === "narrative"
      ? "Explain all selected changes. This is descriptive change narration, not defect review. Do not assign P0-P3, produce findings, or issue a verdict."
      : "Review the implementation for introduced correctness, safety, and maintainability defects. Findings must be actionable and located on reviewed text; human context belongs in callouts.",
    request.dataset.historyMode === "perCommit" && request.mode === "narrative"
      ? "Cover every commit in order and synthesize across commits: evolution, dependencies, later corrections or reverts, staged migrations, and final net effect."
      : "",
    "Return only one JSON object matching this final schema:",
    finalResultSchema(request.mode),
    content
  ].join("\n\n");
}

const narrativeSystemPrompt = [
  "You are the pi-patches change narrator.",
  "Describe evidence completely and neutrally. Never turn the task into an implementation review.",
  "Output strict JSON only, with no Markdown fence or surrounding prose."
].join(" ");

const reviewSystemPrompt = [
  "You are the pi-patches implementation reviewer.",
  "Report only defects introduced by the selected change. A correct verdict is allowed when there are no findings.",
  "Output strict JSON only, with no Markdown fence or surrounding prose."
].join(" ");

const narrativeChunkSchema = JSON.stringify({
  mode: "narrativeChunk",
  summary: "non-empty summary",
  facts: ["concrete fact"],
  documents: ["every document id represented"],
  commits: ["every commit sha represented"]
});

const reviewChunkSchema = JSON.stringify({
  mode: "reviewChunk",
  summary: "non-empty summary",
  findings: [{
    priority: "P0|P1|P2|P3",
    path: "reviewed path",
    startLine: 1,
    endLine: 1,
    title: "short title",
    scenario: "triggering scenario",
    impact: "concrete impact",
    correctiveDirection: "repair direction"
  }],
  callouts: [{ path: null, startLine: null, endLine: null, message: "human-only context" }],
  documents: ["every document id represented"],
  commits: ["every commit sha represented"]
});

const narrativeSchema = JSON.stringify({
  mode: "narrative",
  scope: "source identity and scope",
  executiveSummary: "summary",
  changeMap: [{ path: "path", summary: "what changed" }],
  changes: { behavioral: [], apiSchema: [], configuration: [], dependencies: [], tests: [], documentation: [] },
  interactions: [],
  questions: [],
  commitNarratives: [{ sha: "full sha", summary: "commit change" }],
  crossCommitSynthesis: "required for perCommit, otherwise null"
});

const reviewSchema = JSON.stringify({
  mode: "implementationReview",
  scope: "source identity and scope",
  verdict: "correct|needsAttention",
  findings: [{
    priority: "P0|P1|P2|P3",
    path: "reviewed path",
    startLine: 1,
    endLine: 1,
    title: "short title",
    scenario: "triggering scenario",
    impact: "concrete impact",
    correctiveDirection: "repair direction"
  }],
  callouts: [{ path: null, startLine: null, endLine: null, message: "human-only context" }],
  coverageSummary: "what was reviewed",
  coverageLimited: false
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown, field: string): Result<string> {
  return typeof value === "string" && value.trim().length > 0 ? ok(value) : invalid(field, "expected non-empty string");
}

function strings(value: unknown, field: string): Result<string[]> {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    return invalid(field, "expected string array");
  }
  return ok(value as string[]);
}

function invalid(field: string, message: string): Result<never> {
  return err({ kind: "InvalidInput", field, message });
}

export type { NarrativeResult };
