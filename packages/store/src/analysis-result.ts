import { err, ok, type Result } from "./errors.ts";
import { isPriority, isVerdict, type Priority, type Verdict } from "./review.ts";

export type NarrativeChangeMapEntry = { path: string; summary: string };
export type CommitNarrative = { sha: string; summary: string };

export type NarrativeResult = {
  mode: "narrative";
  scope: string;
  executiveSummary: string;
  changeMap: readonly NarrativeChangeMapEntry[];
  changes: {
    behavioral: readonly string[];
    apiSchema: readonly string[];
    configuration: readonly string[];
    dependencies: readonly string[];
    tests: readonly string[];
    documentation: readonly string[];
  };
  interactions: readonly string[];
  questions: readonly string[];
  commitNarratives: readonly CommitNarrative[];
  crossCommitSynthesis: string | null;
};

export type ReviewFinding = {
  priority: Priority;
  path: string;
  startLine: number;
  endLine: number;
  title: string;
  scenario: string;
  impact: string;
  correctiveDirection: string;
};

export type HumanCallout = {
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  message: string;
};

export type ImplementationReviewResult = {
  mode: "implementationReview";
  scope: string;
  verdict: Verdict;
  findings: readonly ReviewFinding[];
  callouts: readonly HumanCallout[];
  coverageSummary: string;
  coverageLimited: boolean;
};

export type AnalysisResult = NarrativeResult | ImplementationReviewResult;

export function parseAnalysisResult(mode: "narrative", value: unknown): Result<NarrativeResult>;
export function parseAnalysisResult(mode: "implementationReview", value: unknown): Result<ImplementationReviewResult>;
export function parseAnalysisResult(mode: "narrative" | "implementationReview", value: unknown): Result<AnalysisResult>;
export function parseAnalysisResult(mode: "narrative" | "implementationReview", value: unknown): Result<AnalysisResult> {
  return mode === "narrative" ? parseNarrativeResult(value) : parseImplementationReviewResult(value);
}

export function parseNarrativeResult(value: unknown): Result<NarrativeResult> {
  const row = record(value, "narrative");
  if (!row.ok) return row;
  if ("verdict" in row.value || "findings" in row.value) return invalid("narrative", "must not contain verdict or findings");
  if (row.value.mode !== "narrative") return invalid("narrative.mode", "expected narrative");
  const scope = string(row.value.scope, "narrative.scope");
  const summary = string(row.value.executiveSummary, "narrative.executiveSummary");
  const changeMap = array(row.value.changeMap, "narrative.changeMap", parseChangeMapEntry);
  const changes = parseNarrativeChanges(row.value.changes);
  const interactions = stringArray(row.value.interactions, "narrative.interactions");
  const questions = stringArray(row.value.questions, "narrative.questions");
  const commitNarratives = array(row.value.commitNarratives, "narrative.commitNarratives", parseCommitNarrative);
  const crossCommitSynthesis = nullableString(row.value.crossCommitSynthesis, "narrative.crossCommitSynthesis");
  if (!scope.ok) return scope;
  if (!summary.ok) return summary;
  if (!changeMap.ok) return changeMap;
  if (!changes.ok) return changes;
  if (!interactions.ok) return interactions;
  if (!questions.ok) return questions;
  if (!commitNarratives.ok) return commitNarratives;
  if (!crossCommitSynthesis.ok) return crossCommitSynthesis;
  return ok({
    mode: "narrative",
    scope: scope.value,
    executiveSummary: summary.value,
    changeMap: changeMap.value,
    changes: changes.value,
    interactions: interactions.value,
    questions: questions.value,
    commitNarratives: commitNarratives.value,
    crossCommitSynthesis: crossCommitSynthesis.value
  });
}

export function parseImplementationReviewResult(value: unknown): Result<ImplementationReviewResult> {
  const row = record(value, "implementationReview");
  if (!row.ok) return row;
  if (row.value.mode !== "implementationReview") return invalid("implementationReview.mode", "expected implementationReview");
  const scope = string(row.value.scope, "implementationReview.scope");
  if (!isVerdict(row.value.verdict)) return invalid("implementationReview.verdict", "expected correct or needsAttention");
  const findings = array(row.value.findings, "implementationReview.findings", parseFinding);
  const callouts = array(row.value.callouts, "implementationReview.callouts", parseCallout);
  const coverageSummary = string(row.value.coverageSummary, "implementationReview.coverageSummary");
  if (typeof row.value.coverageLimited !== "boolean") return invalid("implementationReview.coverageLimited", "expected boolean");
  if (!scope.ok) return scope;
  if (!findings.ok) return findings;
  if (!callouts.ok) return callouts;
  if (!coverageSummary.ok) return coverageSummary;
  if (row.value.verdict === "correct" && findings.value.length !== 0) {
    return invalid("implementationReview.verdict", "correct requires zero findings");
  }
  if (row.value.verdict === "needsAttention" && findings.value.length === 0) {
    return invalid("implementationReview.verdict", "needsAttention requires at least one finding");
  }
  return ok({
    mode: "implementationReview",
    scope: scope.value,
    verdict: row.value.verdict,
    findings: findings.value,
    callouts: callouts.value,
    coverageSummary: coverageSummary.value,
    coverageLimited: row.value.coverageLimited
  });
}

function parseNarrativeChanges(value: unknown): Result<NarrativeResult["changes"]> {
  const row = record(value, "narrative.changes");
  if (!row.ok) return row;
  const behavioral = stringArray(row.value.behavioral, "narrative.changes.behavioral");
  const apiSchema = stringArray(row.value.apiSchema, "narrative.changes.apiSchema");
  const configuration = stringArray(row.value.configuration, "narrative.changes.configuration");
  const dependencies = stringArray(row.value.dependencies, "narrative.changes.dependencies");
  const tests = stringArray(row.value.tests, "narrative.changes.tests");
  const documentation = stringArray(row.value.documentation, "narrative.changes.documentation");
  if (!behavioral.ok) return behavioral;
  if (!apiSchema.ok) return apiSchema;
  if (!configuration.ok) return configuration;
  if (!dependencies.ok) return dependencies;
  if (!tests.ok) return tests;
  if (!documentation.ok) return documentation;
  return ok({
    behavioral: behavioral.value,
    apiSchema: apiSchema.value,
    configuration: configuration.value,
    dependencies: dependencies.value,
    tests: tests.value,
    documentation: documentation.value
  });
}

function parseChangeMapEntry(value: unknown, index: number): Result<NarrativeChangeMapEntry> {
  const row = record(value, `narrative.changeMap[${index}]`);
  if (!row.ok) return row;
  const path = string(row.value.path, `narrative.changeMap[${index}].path`);
  const summary = string(row.value.summary, `narrative.changeMap[${index}].summary`);
  if (!path.ok) return path;
  if (!summary.ok) return summary;
  return ok({ path: path.value, summary: summary.value });
}

function parseCommitNarrative(value: unknown, index: number): Result<CommitNarrative> {
  const row = record(value, `narrative.commitNarratives[${index}]`);
  if (!row.ok) return row;
  const sha = string(row.value.sha, `narrative.commitNarratives[${index}].sha`);
  const summary = string(row.value.summary, `narrative.commitNarratives[${index}].summary`);
  if (!sha.ok) return sha;
  if (!summary.ok) return summary;
  return ok({ sha: sha.value, summary: summary.value });
}

function parseFinding(value: unknown, index: number): Result<ReviewFinding> {
  const prefix = `implementationReview.findings[${index}]`;
  const row = record(value, prefix);
  if (!row.ok) return row;
  if (!isPriority(row.value.priority)) return invalid(`${prefix}.priority`, "expected P0-P3");
  const path = string(row.value.path, `${prefix}.path`);
  const range = lineRange(row.value.startLine, row.value.endLine, prefix);
  const title = string(row.value.title, `${prefix}.title`);
  const scenario = string(row.value.scenario, `${prefix}.scenario`);
  const impact = string(row.value.impact, `${prefix}.impact`);
  const direction = string(row.value.correctiveDirection, `${prefix}.correctiveDirection`);
  if (!path.ok) return path;
  if (!range.ok) return range;
  if (!title.ok) return title;
  if (!scenario.ok) return scenario;
  if (!impact.ok) return impact;
  if (!direction.ok) return direction;
  return ok({
    priority: row.value.priority,
    path: path.value,
    startLine: range.value.start,
    endLine: range.value.end,
    title: title.value,
    scenario: scenario.value,
    impact: impact.value,
    correctiveDirection: direction.value
  });
}

function parseCallout(value: unknown, index: number): Result<HumanCallout> {
  const prefix = `implementationReview.callouts[${index}]`;
  const row = record(value, prefix);
  if (!row.ok) return row;
  if ("priority" in row.value) return invalid(`${prefix}.priority`, "callouts cannot carry priority");
  const path = nullableString(row.value.path, `${prefix}.path`);
  const message = string(row.value.message, `${prefix}.message`);
  if (!path.ok) return path;
  if (!message.ok) return message;
  if (row.value.startLine === null && row.value.endLine === null) {
    return ok({ path: path.value, startLine: null, endLine: null, message: message.value });
  }
  const range = lineRange(row.value.startLine, row.value.endLine, prefix);
  return range.ok
    ? ok({ path: path.value, startLine: range.value.start, endLine: range.value.end, message: message.value })
    : range;
}

function lineRange(start: unknown, end: unknown, prefix: string): Result<{ start: number; end: number }> {
  if (!Number.isInteger(start) || Number(start) < 1) return invalid(`${prefix}.startLine`, "expected positive integer");
  if (!Number.isInteger(end) || Number(end) < Number(start)) return invalid(`${prefix}.endLine`, "expected integer >= startLine");
  return ok({ start: Number(start), end: Number(end) });
}

function record(value: unknown, field: string): Result<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? ok(value as Record<string, unknown>)
    : invalid(field, "expected object");
}

function string(value: unknown, field: string): Result<string> {
  return typeof value === "string" && value.trim().length > 0 ? ok(value) : invalid(field, "expected non-empty string");
}

function nullableString(value: unknown, field: string): Result<string | null> {
  return value === null ? ok(null) : string(value, field);
}

function stringArray(value: unknown, field: string): Result<string[]> {
  if (!Array.isArray(value)) return invalid(field, "expected array");
  const output: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const parsed = string(value[index], `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    output.push(parsed.value);
  }
  return ok(output);
}

function array<T>(value: unknown, field: string, parse: (value: unknown, index: number) => Result<T>): Result<T[]> {
  if (!Array.isArray(value)) return invalid(field, "expected array");
  const output: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const parsed = parse(value[index], index);
    if (!parsed.ok) return parsed;
    output.push(parsed.value);
  }
  return ok(output);
}

function invalid(field: string, message: string): Result<never> {
  return err({ kind: "InvalidInput", field, message });
}
