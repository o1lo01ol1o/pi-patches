import { createHash } from "node:crypto";
import { err, ok, type Result } from "./errors.ts";
import type { AnalysisResult } from "./analysis-result.ts";
import type { AnnotationState, AnchorLine, Baseline, BatchId, Brand, ContentHash, SessionId } from "./rows.ts";

export type SourceFingerprint = Brand<string, "SourceFingerprint">;
export type DocumentId = Brand<string, "DocumentId">;
export type AnalysisRunId = Brand<string, "AnalysisRunId">;
export type SourceNoteId = Brand<number, "SourceNoteId">;

export type Priority = "P0" | "P1" | "P2" | "P3";
export type ReviewNoteRole =
  | { kind: "finding"; priority: Priority; audience: "agent" | "human" }
  | { kind: "callout"; audience: "human" };
export type Verdict = "correct" | "needsAttention";

export type ReviewSource =
  | { kind: "session"; sessionId: SessionId }
  | { kind: "workingTree"; base: "HEAD" }
  | { kind: "branch"; baseRef: string; headRef: string }
  | { kind: "commit"; sha: string }
  | { kind: "commitRange"; baseExclusive: string; headInclusive: string }
  | { kind: "pullRequest"; number: number; baseRef: string; headRef: string }
  | { kind: "snapshot"; paths: readonly [string, ...string[]] };

export type HistoryMode = "squashed" | "perCommit";

export type Attribution =
  | { kind: "sessionPatch"; patchId: number; sequence: number }
  | { kind: "gitCommit"; sha: string }
  | { kind: "workingTree"; area: "index" | "worktree" | "untracked" }
  | { kind: "snapshot" };

export type TextReviewDocument = {
  kind: "text";
  id: DocumentId;
  path: string;
  relPath: string;
  baseline: Baseline;
  head: { content: string | null; hash: ContentHash };
  renamedFrom: string | null;
  provenance: readonly Attribution[];
};

export type OpaqueReviewDocument = {
  kind: "binary" | "submodule";
  id: DocumentId;
  path: string;
  relPath: string;
  baseline: { kind: "absent" } | { kind: "present"; hash: ContentHash };
  head: { present: boolean; hash: ContentHash };
  renamedFrom: string | null;
  provenance: readonly Attribution[];
};

export type ReviewDocument = TextReviewDocument | OpaqueReviewDocument;

export type CommitChange = {
  sha: string;
  parents: readonly string[];
  subject: string;
  authoredAt: number;
  documents: readonly DocumentId[];
  changes: readonly CommitDocumentChange[];
};

export type CommitDocumentChange = {
  documentId: DocumentId;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "typeChanged";
  oldPath: string | null;
  patch: string;
};

export type ReviewDataset = {
  source: ReviewSource;
  historyMode: HistoryMode;
  fingerprint: SourceFingerprint;
  documents: readonly ReviewDocument[];
  commits: readonly CommitChange[];
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelSelection = { provider: string; modelId: string; thinkingLevel: ThinkingLevel };
export type AnalysisMode = "narrative" | "implementationReview";
export type AnalysisStatus = "running" | "completed" | "failed" | "cancelled";

export type CoverageState =
  | { kind: "included" }
  | { kind: "summarized" }
  | { kind: "excluded"; reason: string }
  | { kind: "failed"; error: string };

export type CoverageEntry = {
  id: string;
  state: CoverageState;
};

export type AnalysisManifestEvidence = {
  strategy: "direct" | "hierarchical";
  stats: {
    files: number;
    commits: number;
    bytes: number;
    diffRows: number;
    estimatedTokens: number;
  };
  chunks: readonly {
    id: string;
    unitIds: readonly string[];
    documentIds: readonly string[];
    commitShas: readonly string[];
    estimatedTokens: number;
  }[];
  documentIds: readonly string[];
  commitShas: readonly string[];
};

export type ReviewSourceRecord = {
  fingerprint: SourceFingerprint;
  source: ReviewSource;
  historyMode: HistoryMode;
  createdAt: number;
};

export type ReviewOutcome = {
  sourceFingerprint: SourceFingerprint;
  verdict: Verdict;
  recordedAt: number;
};

export type SourceNote = {
  id: SourceNoteId;
  sourceFingerprint: SourceFingerprint;
  targetSessionId: SessionId;
  documentId: DocumentId;
  path: string;
  relPath: string;
  anchor: { hash: ContentHash; start: AnchorLine; end: AnchorLine };
  snippet: string;
  comment: string;
  role: ReviewNoteRole;
  state: AnnotationState;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedSourceNote = SourceNote & {
  state: { kind: "sent"; sentAt: number; batchId: BatchId };
  file: { path: string; relPath: string };
  anchorSeq: 0;
  fixIntent: boolean;
  checkDisk: false;
};

export type AnalysisRun = {
  id: AnalysisRunId;
  sourceFingerprint: SourceFingerprint;
  mode: AnalysisMode;
  model: ModelSelection;
  promptVersion: string;
  focus: string | null;
  manifest: AnalysisManifestEvidence;
  status: AnalysisStatus;
  output: AnalysisResult | null;
  rawOutput: string | null;
  reviewVerdict: Verdict | null;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
  documentCoverage: readonly CoverageEntry[];
  commitCoverage: readonly CoverageEntry[];
};

export function checkedSourceFingerprint(value: string): Result<SourceFingerprint> {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    return err({ kind: "InvalidInput", field: "SourceFingerprint", message: "expected lowercase sha256 hex" });
  }
  return ok(value as SourceFingerprint);
}

export function checkedDocumentId(value: string): Result<DocumentId> {
  if (typeof value !== "string" || value.length === 0) {
    return err({ kind: "InvalidInput", field: "DocumentId", message: "expected non-empty string" });
  }
  return ok(value as DocumentId);
}

export function checkedAnalysisRunId(value: string): Result<AnalysisRunId> {
  if (typeof value !== "string" || value.length === 0) {
    return err({ kind: "InvalidInput", field: "AnalysisRunId", message: "expected non-empty string" });
  }
  return ok(value as AnalysisRunId);
}

export function checkedSourceNoteId(value: number): Result<SourceNoteId> {
  if (!Number.isInteger(value) || value < 1) {
    return err({ kind: "InvalidInput", field: "SourceNoteId", message: "expected positive integer" });
  }
  return ok(value as SourceNoteId);
}

export function hashReviewSource(value: unknown): SourceFingerprint {
  return createHash("sha256").update(canonicalJson(value)).digest("hex") as SourceFingerprint;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function parseReviewSource(value: unknown): Result<ReviewSource> {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return invalidSource("expected an object with a source kind");
  }
  switch (value.kind) {
    case "session":
      return nonEmpty(value.sessionId, "sessionId", (sessionId) => ({ kind: "session", sessionId: sessionId as SessionId }));
    case "workingTree":
      return value.base === "HEAD" ? ok({ kind: "workingTree", base: "HEAD" }) : invalidSource("workingTree base must be HEAD");
    case "branch":
      return twoStrings(value.baseRef, value.headRef, "baseRef", "headRef", (baseRef, headRef) => ({ kind: "branch", baseRef, headRef }));
    case "commit":
      return nonEmpty(value.sha, "sha", (sha) => ({ kind: "commit", sha }));
    case "commitRange":
      return twoStrings(value.baseExclusive, value.headInclusive, "baseExclusive", "headInclusive", (baseExclusive, headInclusive) => ({
        kind: "commitRange",
        baseExclusive,
        headInclusive
      }));
    case "pullRequest": {
      if (!Number.isInteger(value.number) || Number(value.number) < 1) return invalidSource("pull request number must be positive");
      const refs = twoStrings(value.baseRef, value.headRef, "baseRef", "headRef", (baseRef, headRef) => ({ baseRef, headRef }));
      return refs.ok ? ok({ kind: "pullRequest", number: Number(value.number), ...refs.value }) : refs;
    }
    case "snapshot": {
      if (!Array.isArray(value.paths) || value.paths.length === 0 || !value.paths.every((path) => typeof path === "string" && path.length > 0)) {
        return invalidSource("snapshot paths must be a non-empty string array");
      }
      return ok({ kind: "snapshot", paths: value.paths as [string, ...string[]] });
    }
    default:
      return invalidSource(`unknown source kind ${value.kind}`);
  }
}

export function parseModelSelection(value: unknown): Result<ModelSelection> {
  if (!isRecord(value)) return err({ kind: "InvalidInput", field: "model", message: "expected object" });
  const provider = typeof value.provider === "string" ? value.provider : "";
  const modelId = typeof value.modelId === "string" ? value.modelId : "";
  if (provider.length === 0 || modelId.length === 0) {
    return err({ kind: "InvalidInput", field: "model", message: "provider and modelId must be non-empty" });
  }
  if (!isThinkingLevel(value.thinkingLevel)) {
    return err({ kind: "InvalidInput", field: "model.thinkingLevel", message: "unsupported thinking level" });
  }
  return ok({ provider, modelId, thinkingLevel: value.thinkingLevel });
}

export function parseAnalysisManifestEvidence(value: unknown): Result<AnalysisManifestEvidence> {
  if (!isRecord(value) || (value.strategy !== "direct" && value.strategy !== "hierarchical")) {
    return err({ kind: "InvalidInput", field: "analysis.manifest", message: "expected a direct or hierarchical manifest" });
  }
  if (!isRecord(value.stats)) {
    return err({ kind: "InvalidInput", field: "analysis.manifest.stats", message: "expected manifest statistics" });
  }
  const stats = value.stats;
  const statNames = ["files", "commits", "bytes", "diffRows", "estimatedTokens"] as const;
  for (const name of statNames) {
    if (!Number.isInteger(stats[name]) || Number(stats[name]) < 0) {
      return err({ kind: "InvalidInput", field: `analysis.manifest.stats.${name}`, message: "expected a non-negative integer" });
    }
  }
  const documentIds = stringArray(value.documentIds);
  const commitShas = stringArray(value.commitShas);
  if (documentIds === null || commitShas === null || !Array.isArray(value.chunks)) {
    return err({ kind: "InvalidInput", field: "analysis.manifest", message: "expected ordered document, commit, and chunk arrays" });
  }
  const chunks: AnalysisManifestEvidence["chunks"][number][] = [];
  const chunkIds = new Set<string>();
  for (let index = 0; index < value.chunks.length; index++) {
    const chunk = value.chunks[index];
    if (!isRecord(chunk) || typeof chunk.id !== "string" || chunk.id.length === 0 || chunkIds.has(chunk.id)) {
      return err({ kind: "InvalidInput", field: `analysis.manifest.chunks[${index}].id`, message: "expected a unique non-empty chunk id" });
    }
    const unitIds = stringArray(chunk.unitIds);
    const chunkDocuments = stringArray(chunk.documentIds);
    const chunkCommits = stringArray(chunk.commitShas);
    if (unitIds === null || chunkDocuments === null || chunkCommits === null || !Number.isInteger(chunk.estimatedTokens) || Number(chunk.estimatedTokens) < 0) {
      return err({ kind: "InvalidInput", field: `analysis.manifest.chunks[${index}]`, message: "expected checked chunk evidence" });
    }
    chunkIds.add(chunk.id);
    chunks.push({ id: chunk.id, unitIds, documentIds: chunkDocuments, commitShas: chunkCommits, estimatedTokens: Number(chunk.estimatedTokens) });
  }
  return ok({
    strategy: value.strategy,
    stats: Object.fromEntries(statNames.map((name) => [name, Number(stats[name])])) as AnalysisManifestEvidence["stats"],
    chunks,
    documentIds,
    commitShas
  });
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
    ? [...value]
    : null;
}

export function isPriority(value: unknown): value is Priority {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

export function isVerdict(value: unknown): value is Verdict {
  return value === "correct" || value === "needsAttention";
}

export function isHistoryMode(value: unknown): value is HistoryMode {
  return value === "squashed" || value === "perCommit";
}

export function isAnalysisMode(value: unknown): value is AnalysisMode {
  return value === "narrative" || value === "implementationReview";
}

export function isAnalysisStatus(value: unknown): value is AnalysisStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled";
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidSource(message: string): Result<never> {
  return err({ kind: "InvalidInput", field: "source", message });
}

function nonEmpty<T>(value: unknown, field: string, build: (value: string) => T): Result<T> {
  return typeof value === "string" && value.length > 0
    ? ok(build(value))
    : invalidSource(`${field} must be non-empty`);
}

function twoStrings<T>(
  left: unknown,
  right: unknown,
  leftName: string,
  rightName: string,
  build: (left: string, right: string) => T
): Result<T> {
  if (typeof left !== "string" || left.length === 0) return invalidSource(`${leftName} must be non-empty`);
  if (typeof right !== "string" || right.length === 0) return invalidSource(`${rightName} must be non-empty`);
  return ok(build(left, right));
}
