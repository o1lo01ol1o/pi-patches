import { err, hashReviewSource, ok, type HistoryMode, type Result, type ReviewDataset, type ReviewSource } from "@pi-patches/store";
import { gitRoot, materializeGitSource } from "./git.ts";
import { runText, type CommandRunner } from "./process.ts";

type PullRequestMetadata = {
  number: number;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
};

export function materializePullRequest(
  cwd: string,
  number: number,
  historyMode: HistoryMode,
  runner: CommandRunner
): Result<ReviewDataset> {
  const root = gitRoot(cwd, runner);
  if (!root.ok) return root;
  const before = worktreeIdentity(root.value, runner);
  if (!before.ok) return before;
  const metadata = pullRequestMetadata(root.value, number, runner);
  if (!metadata.ok) return metadata;
  const base = ensureObject(root.value, metadata.value.baseRefOid, metadata.value.baseRefName, runner);
  if (!base.ok) return base;
  const head = ensureObject(root.value, metadata.value.headRefOid, `refs/pull/${number}/head`, runner);
  if (!head.ok) return head;

  const dataset = materializeGitSource(root.value, {
    kind: "pullRequest",
    number,
    baseRef: metadata.value.baseRefOid,
    headRef: metadata.value.headRefOid
  }, historyMode, runner);
  if (!dataset.ok) return dataset;
  const after = worktreeIdentity(root.value, runner);
  if (!after.ok) return after;
  if (before.value !== after.value) {
    return err({ kind: "InvalidInput", field: "pullRequest", message: "active worktree or index changed while materializing the PR" });
  }
  const current = pullRequestMetadata(root.value, number, runner);
  if (!current.ok) return current;
  if (current.value.baseRefOid !== metadata.value.baseRefOid || current.value.headRefOid !== metadata.value.headRefOid) {
    return err({ kind: "InvalidInput", field: "pullRequest", message: "pull request refs changed during materialization; retry" });
  }
  return ok({
    ...dataset.value,
    fingerprint: hashReviewSource({
      fingerprint: dataset.value.fingerprint,
      pullRequest: metadata.value
    })
  });
}

export function validatePullRequestSource(
  cwd: string,
  source: Extract<ReviewSource, { kind: "pullRequest" }>,
  runner: CommandRunner
): Result<void> {
  const root = gitRoot(cwd, runner);
  if (!root.ok) return root;
  const current = pullRequestMetadata(root.value, source.number, runner);
  if (!current.ok) return current;
  if (current.value.baseRefOid !== source.baseRef || current.value.headRefOid !== source.headRef) {
    return err({ kind: "InvalidInput", field: "pullRequest", message: "pull request refs changed during analysis; rerun against the new source" });
  }
  return ok(undefined);
}

function pullRequestMetadata(cwd: string, number: number, runner: CommandRunner): Result<PullRequestMetadata> {
  const output = runText(runner, cwd, "gh", [
    "pr",
    "view",
    String(number),
    "--json",
    "number,baseRefName,headRefName,baseRefOid,headRefOid"
  ]);
  if (!output.ok) return output;
  let value: unknown;
  try {
    value = JSON.parse(output.value);
  } catch (error) {
    return err({ kind: "InvalidInput", field: "pullRequest.metadata", message: error instanceof Error ? error.message : "invalid JSON" });
  }
  if (!isRecord(value) || value.number !== number) {
    return err({ kind: "InvalidInput", field: "pullRequest.metadata", message: "response does not identify the requested PR" });
  }
  for (const field of ["baseRefName", "headRefName", "baseRefOid", "headRefOid"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      return err({ kind: "InvalidInput", field: `pullRequest.${field}`, message: "expected non-empty string" });
    }
  }
  return ok(value as PullRequestMetadata);
}

function ensureObject(cwd: string, oid: string, fetchRef: string, runner: CommandRunner): Result<void> {
  const present = runText(runner, cwd, "git", ["cat-file", "-e", `${oid}^{commit}`]);
  if (present.ok) return ok(undefined);
  const fetched = runText(runner, cwd, "git", ["fetch", "--no-tags", "origin", fetchRef]);
  if (!fetched.ok) return fetched;
  const verified = runText(runner, cwd, "git", ["cat-file", "-e", `${oid}^{commit}`]);
  return verified.ok ? ok(undefined) : verified;
}

function worktreeIdentity(cwd: string, runner: CommandRunner): Result<string> {
  const head = runText(runner, cwd, "git", ["rev-parse", "HEAD"]);
  if (!head.ok) return head;
  const status = runText(runner, cwd, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) return status;
  return ok(hashReviewSource({ head: head.value.trim(), status: status.value }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
