import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkedDocumentId,
  err,
  hashReviewSource,
  ok,
  type Attribution,
  type CommitChange,
  type CommitDocumentChange,
  type HistoryMode,
  type Result,
  type ReviewDataset,
  type ReviewDocument,
  type ReviewSource
} from "@pi-patches/store";
import { makeReviewDocument, normalizedDocumentFingerprint, type DocumentSide } from "./document.ts";
import { runBytes, runText, type CommandRunner } from "./process.ts";

type GitSource = Extract<ReviewSource, { kind: "branch" | "commit" | "commitRange" | "pullRequest" }>;

type NameStatus = {
  code: "A" | "M" | "D" | "R" | "C" | "T";
  path: string;
  oldPath: string | null;
};

type ResolvedRange = {
  source: GitSource;
  base: string | null;
  head: string;
  commitShas: string[];
};

export function materializeGitSource(
  cwd: string,
  requested: GitSource,
  historyMode: HistoryMode,
  runner: CommandRunner
): Result<ReviewDataset> {
  const root = gitRoot(cwd, runner);
  if (!root.ok) return root;
  const resolved = resolveRange(root.value, requested, runner);
  if (!resolved.ok) return resolved;
  if (historyMode === "perCommit" && resolved.value.commitShas.length === 0) {
    return err({ kind: "InvalidInput", field: "historyMode", message: "perCommit requires a non-empty commit sequence" });
  }
  const commitChanges = materializeCommits(root.value, resolved.value.commitShas, runner);
  if (!commitChanges.ok) return commitChanges;
  const renameEdges = collectRenameEdges(commitChanges.value);
  const normalizedCommits = normalizeCommitDocumentPaths(commitChanges.value, renameEdges);
  if (!normalizedCommits.ok) return normalizedCommits;
  const netChanges = nameStatusBetween(root.value, resolved.value.base, resolved.value.head, runner);
  if (!netChanges.ok) return netChanges;
  const allPaths = new Map<string, { oldPath: string | null }>();
  for (const change of netChanges.value) {
    const path = finalPathThroughRenames(change.path, renameEdges);
    const oldPath = change.oldPath ?? (path === change.path ? null : change.path);
    allPaths.set(path, { oldPath });
  }
  for (const commit of normalizedCommits.value) {
    for (const change of commit.changes) {
      if (!allPaths.has(String(change.documentId))) allPaths.set(String(change.documentId), { oldPath: change.oldPath });
    }
  }

  const documents: ReviewDocument[] = [];
  for (const [path, rename] of [...allPaths].sort(([left], [right]) => left.localeCompare(right))) {
    const baselinePath = rename.oldPath ?? path;
    const baseline = readTreeSide(root.value, resolved.value.base, baselinePath, runner);
    if (!baseline.ok) return baseline;
    const head = readTreeSide(root.value, resolved.value.head, path, runner);
    if (!head.ok) return head;
    const provenance = normalizedCommits.value
      .filter((commit) => commit.documents.some((document) => String(document) === path))
      .map((commit): Attribution => ({ kind: "gitCommit", sha: commit.sha }));
    documents.push(makeReviewDocument({
      root: root.value,
      relPath: path,
      baseline: baseline.value,
      head: head.value,
      renamedFrom: rename.oldPath,
      provenance
    }));
  }

  const fingerprint = hashReviewSource({
    source: resolved.value.source,
    historyMode,
    documents: documents.map(normalizedDocumentFingerprint),
    commits: normalizedCommits.value.map((commit) => ({
      sha: commit.sha,
      parents: commit.parents,
      documents: commit.documents,
      changes: commit.changes.map(({ patch, ...change }) => ({ ...change, patchHash: hashReviewSource(patch) }))
    }))
  });
  return ok({
    source: resolved.value.source,
    historyMode,
    fingerprint,
    documents,
    commits: normalizedCommits.value
  });
}

export type WorkingDiffKind = "workingTree" | "staged" | "unstaged";

export function materializeWorkingTree(cwd: string, historyMode: HistoryMode, runner: CommandRunner): Result<ReviewDataset> {
  return materializeWorkingDiff(cwd, "workingTree", historyMode, runner);
}

export function materializeWorkingDiff(
  cwd: string,
  kind: WorkingDiffKind,
  historyMode: HistoryMode,
  runner: CommandRunner
): Result<ReviewDataset> {
  if (historyMode !== "squashed") {
    return err({ kind: "InvalidInput", field: "historyMode", message: `${kind} supports only squashed history` });
  }
  const root = gitRoot(cwd, runner);
  if (!root.ok) return root;
  const head = resolveCommit(root.value, "HEAD", runner);
  if (!head.ok) return head;
  const changes = workingNameStatus(root.value, head.value, kind, runner);
  if (!changes.ok) return changes;
  const untracked = kind === "staged"
    ? ok("")
    : gitText(root.value, ["ls-files", "--others", "--exclude-standard", "-z"], runner);
  if (!untracked.ok) return untracked;
  const byPath = new Map(
    changes.value
      .filter((change) => !isPiPatchesState(change.path) && (change.oldPath === null || !isPiPatchesState(change.oldPath)))
      .map((change) => [change.path, change])
  );
  for (const path of splitNul(untracked.value)) {
    if (!isPiPatchesState(path) && !byPath.has(path)) byPath.set(path, { code: "A", path, oldPath: null });
  }
  const staged = kind === "workingTree"
    ? changedPathSet(root.value, ["diff", "--cached", "--name-only", "-z", "HEAD"], runner)
    : ok(new Set<string>());
  if (!staged.ok) return staged;
  const unstaged = kind === "workingTree"
    ? changedPathSet(root.value, ["diff", "--name-only", "-z"], runner)
    : ok(new Set<string>());
  if (!unstaged.ok) return unstaged;
  const untrackedSet = new Set(splitNul(untracked.value));

  const documents: ReviewDocument[] = [];
  for (const change of [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    const baseline = kind === "unstaged"
      ? readIndexSide(root.value, change.oldPath ?? change.path, runner)
      : readTreeSide(root.value, head.value, change.oldPath ?? change.path, runner);
    if (!baseline.ok) return baseline;
    const current = kind === "staged"
      ? readIndexSide(root.value, change.path, runner)
      : readWorkingSide(root.value, change.path, head.value, runner);
    if (!current.ok) return current;
    const provenance: Attribution[] = [];
    if (kind === "staged" || staged.value.has(change.path) || (change.oldPath !== null && staged.value.has(change.oldPath))) {
      provenance.push({ kind: "workingTree", area: "index" });
    }
    if ((kind === "unstaged" && !untrackedSet.has(change.path)) || unstaged.value.has(change.path) || (change.oldPath !== null && unstaged.value.has(change.oldPath))) {
      provenance.push({ kind: "workingTree", area: "worktree" });
    }
    if (untrackedSet.has(change.path)) provenance.push({ kind: "workingTree", area: "untracked" });
    documents.push(makeReviewDocument({
      root: root.value,
      relPath: change.path,
      baseline: baseline.value,
      head: current.value,
      renamedFrom: change.oldPath,
      provenance
    }));
  }
  const source = workingReviewSource(kind);
  const fingerprint = hashReviewSource({
    source,
    pinnedHead: head.value,
    historyMode,
    documents: documents.map(normalizedDocumentFingerprint)
  });
  return ok({ source, historyMode, fingerprint, documents, commits: [] });
}

function workingReviewSource(kind: WorkingDiffKind): Extract<ReviewSource, { kind: WorkingDiffKind }> {
  switch (kind) {
    case "workingTree": return { kind: "workingTree", base: "HEAD" };
    case "staged": return { kind: "staged", base: "HEAD", head: "INDEX" };
    case "unstaged": return { kind: "unstaged", base: "INDEX", head: "WORKTREE" };
  }
}

function workingNameStatus(cwd: string, head: string, kind: WorkingDiffKind, runner: CommandRunner): Result<NameStatus[]> {
  const args = kind === "workingTree"
    ? ["diff", "--name-status", "-z", "-M", head]
    : kind === "staged"
      ? ["diff", "--cached", "--name-status", "-z", "-M", head]
      : ["diff", "--name-status", "-z", "-M"];
  const output = gitText(cwd, args, runner);
  return output.ok ? parseNameStatus(output.value) : output;
}

function isPiPatchesState(path: string): boolean {
  return path === ".pi/patches" || path.startsWith(".pi/patches/");
}

export function gitRoot(cwd: string, runner: CommandRunner): Result<string> {
  const root = gitText(cwd, ["rev-parse", "--show-toplevel"], runner);
  return root.ok ? ok(root.value.trim()) : root;
}

export function resolveCommit(cwd: string, ref: string, runner: CommandRunner): Result<string> {
  const resolved = gitText(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], runner);
  return resolved.ok ? ok(resolved.value.trim()) : resolved;
}

export function listBranches(cwd: string, runner: CommandRunner): Result<Array<{ name: string; current: boolean; isDefault: boolean }>> {
  const root = gitRoot(cwd, runner);
  if (!root.ok) return root;
  const refs = gitText(root.value, ["for-each-ref", "--format=%(refname:short)%00%(HEAD)", "refs/heads"], runner);
  if (!refs.ok) return refs;
  const defaultRef = gitText(root.value, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], runner);
  const defaultName = defaultRef.ok ? defaultRef.value.trim().replace(/^origin\//, "") : null;
  const branches = refs.value.split("\n").filter(Boolean).map((line) => {
    const [name = "", marker = ""] = line.split("\0");
    return { name, current: marker.trim() === "*", isDefault: name === defaultName };
  });
  return ok(branches.sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name)));
}

export function listRecentCommits(cwd: string, runner: CommandRunner, limit = 50): Result<Array<{ sha: string; subject: string }>> {
  const root = gitRoot(cwd, runner);
  if (!root.ok) return root;
  const output = gitText(root.value, ["log", `-${Math.max(1, limit)}`, "--format=%H%x00%s"], runner);
  if (!output.ok) return output;
  return ok(output.value.split("\n").filter(Boolean).map((line) => {
    const [sha = "", subject = ""] = line.split("\0");
    return { sha, subject };
  }));
}

function resolveRange(cwd: string, source: GitSource, runner: CommandRunner): Result<ResolvedRange> {
  if (source.kind === "commit") {
    const head = resolveCommit(cwd, source.sha, runner);
    if (!head.ok) return head;
    const parents = commitParents(cwd, head.value, runner);
    if (!parents.ok) return parents;
    return ok({
      source: { kind: "commit", sha: head.value },
      base: parents.value[0] ?? null,
      head: head.value,
      commitShas: [head.value]
    });
  }
  const requestedBase = source.kind === "commitRange" ? source.baseExclusive : source.baseRef;
  const requestedHead = source.kind === "commitRange" ? source.headInclusive : source.headRef;
  const baseTip = resolveCommit(cwd, requestedBase, runner);
  if (!baseTip.ok) return baseTip;
  const head = resolveCommit(cwd, requestedHead, runner);
  if (!head.ok) return head;
  const base = source.kind === "commitRange"
    ? baseTip
    : gitText(cwd, ["merge-base", baseTip.value, head.value], runner);
  if (!base.ok) return base;
  const pinnedBase = base.value.trim();
  const list = gitText(cwd, ["rev-list", "--reverse", "--topo-order", `${pinnedBase}..${head.value}`], runner);
  if (!list.ok) return list;
  const pinnedSource: GitSource = source.kind === "commitRange"
    ? { kind: "commitRange", baseExclusive: pinnedBase, headInclusive: head.value }
    : source.kind === "branch"
      ? { kind: "branch", baseRef: pinnedBase, headRef: head.value }
      : { kind: "pullRequest", number: source.number, baseRef: pinnedBase, headRef: head.value };
  return ok({ source: pinnedSource, base: pinnedBase, head: head.value, commitShas: list.value.trim().split("\n").filter(Boolean) });
}

function materializeCommits(cwd: string, shas: readonly string[], runner: CommandRunner): Result<CommitChange[]> {
  const commits: CommitChange[] = [];
  for (const sha of shas) {
    const metadata = gitText(cwd, ["show", "-s", "--format=%H%x00%P%x00%ct%x00%s", sha], runner);
    if (!metadata.ok) return metadata;
    const [resolved = "", parentText = "", authoredText = "", ...subjectParts] = metadata.value.trimEnd().split("\0");
    const parents = parentText.length === 0 ? [] : parentText.split(" ");
    const statuses = nameStatusBetween(cwd, parents[0] ?? null, resolved, runner);
    if (!statuses.ok) return statuses;
    const changes: CommitDocumentChange[] = [];
    for (const status of statuses.value) {
      const id = checkedDocumentId(status.path);
      if (!id.ok) return id;
      const patch = commitPatch(cwd, parents[0] ?? null, resolved, status, runner);
      if (!patch.ok) return patch;
      changes.push({
        documentId: id.value,
        status: statusLabel(status.code),
        oldPath: status.oldPath,
        patch: patch.value
      });
    }
    commits.push({
      sha: resolved,
      parents,
      subject: subjectParts.join("\0"),
      authoredAt: Number(authoredText) * 1000,
      documents: changes.map((change) => change.documentId),
      changes
    });
  }
  return ok(commits);
}

function commitPatch(cwd: string, base: string | null, head: string, change: NameStatus, runner: CommandRunner): Result<string> {
  const paths = change.oldPath === null ? [change.path] : [change.oldPath, change.path];
  return base === null
    ? gitText(cwd, ["show", "--format=", "--no-ext-diff", "--unified=3", "-M", head, "--", ...paths], runner)
    : gitText(cwd, ["diff", "--no-ext-diff", "--unified=3", "-M", base, head, "--", ...paths], runner);
}

type RenameEdge = { from: string; to: string };

function collectRenameEdges(commits: readonly CommitChange[]): RenameEdge[] {
  return commits.flatMap((commit) => commit.changes.flatMap((change) =>
    change.status === "renamed" && change.oldPath !== null
      ? [{ from: change.oldPath, to: String(change.documentId) }]
      : []
  ));
}

function finalPathThroughRenames(initial: string, renames: readonly RenameEdge[]): string {
  let path = initial;
  for (const rename of renames) if (rename.from === path) path = rename.to;
  return path;
}

function normalizeCommitDocumentPaths(commits: readonly CommitChange[], renames: readonly RenameEdge[]): Result<CommitChange[]> {
  const normalized: CommitChange[] = [];
  for (const commit of commits) {
    const changes: CommitDocumentChange[] = [];
    for (const change of commit.changes) {
      const id = checkedDocumentId(finalPathThroughRenames(String(change.documentId), renames));
      if (!id.ok) return id;
      changes.push({ ...change, documentId: id.value });
    }
    normalized.push({ ...commit, documents: [...new Set(changes.map((change) => change.documentId))], changes });
  }
  return ok(normalized);
}

function commitParents(cwd: string, sha: string, runner: CommandRunner): Result<string[]> {
  const result = gitText(cwd, ["show", "-s", "--format=%P", sha], runner);
  return result.ok ? ok(result.value.trim().split(" ").filter(Boolean)) : result;
}

function nameStatusBetween(cwd: string, base: string | null, head: string | null, runner: CommandRunner): Result<NameStatus[]> {
  let args: string[];
  if (base === null && head !== null) {
    args = ["diff-tree", "--root", "--no-commit-id", "--name-status", "-z", "-r", "-M", head];
  } else if (base !== null && head === null) {
    args = ["diff", "--name-status", "-z", "-M", base];
  } else if (base !== null && head !== null) {
    args = ["diff", "--name-status", "-z", "-M", base, head];
  } else {
    return ok([]);
  }
  const output = gitText(cwd, args, runner);
  if (!output.ok) return output;
  return parseNameStatus(output.value);
}

function parseNameStatus(output: string): Result<NameStatus[]> {
  const fields = splitNul(output);
  const changes: NameStatus[] = [];
  for (let index = 0; index < fields.length;) {
    const raw = fields[index++];
    const code = raw[0] as NameStatus["code"];
    if (!"AMDRCT".includes(code)) {
      return err({ kind: "InvalidInput", field: "git.nameStatus", message: `unsupported status ${raw}` });
    }
    if (code === "R" || code === "C") {
      const oldPath = fields[index++];
      const path = fields[index++];
      if (!oldPath || !path) return err({ kind: "InvalidInput", field: "git.nameStatus", message: "truncated rename/copy" });
      changes.push({ code, path, oldPath });
    } else {
      const path = fields[index++];
      if (!path) return err({ kind: "InvalidInput", field: "git.nameStatus", message: "truncated path" });
      changes.push({ code, path, oldPath: null });
    }
  }
  return ok(changes);
}

function readTreeSide(cwd: string, ref: string | null, path: string, runner: CommandRunner): Result<DocumentSide> {
  if (ref === null) return ok({ kind: "absent" });
  const entry = gitText(cwd, ["ls-tree", "-z", ref, "--", path], runner);
  if (!entry.ok) return entry;
  if (entry.value.length === 0) return ok({ kind: "absent" });
  const header = entry.value.slice(0, entry.value.indexOf("\t"));
  const [mode = "", type = "", oid = ""] = header.split(" ");
  if (mode === "160000" || type === "commit") return ok({ kind: "submodule", oid });
  const bytes = gitBytes(cwd, ["show", `${ref}:${path}`], runner);
  return bytes.ok ? ok({ kind: "blob", bytes: bytes.value }) : bytes;
}

function readWorkingSide(cwd: string, path: string, head: string, runner: CommandRunner): Result<DocumentSide> {
  const absolute = join(cwd, path);
  try {
    if (!existsSync(absolute)) {
      const index = readIndexSide(cwd, path, runner);
      return index.ok && index.value.kind === "submodule" ? index : ok({ kind: "absent" });
    }
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      const index = readIndexSide(cwd, path, runner);
      if (!index.ok) return index;
      const baseline = index.value.kind === "submodule" ? index : readTreeSide(cwd, head, path, runner);
      if (!baseline.ok) return baseline;
      if (baseline.value.kind !== "submodule") {
        return err({ kind: "Io", path: absolute, message: "unexpected directory in working-tree file set" });
      }
      const oid = gitText(absolute, ["rev-parse", "HEAD"], runner);
      return oid.ok ? ok({ kind: "submodule", oid: oid.value.trim() }) : baseline;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return err({ kind: "Io", path: absolute, message: "unsupported filesystem entry" });
    }
    return ok({ kind: "blob", bytes: readFileSync(absolute) });
  } catch (error) {
    return err({ kind: "Io", path: absolute, message: error instanceof Error ? error.message : String(error) });
  }
}

function readIndexSide(cwd: string, path: string, runner: CommandRunner): Result<DocumentSide> {
  const entry = gitText(cwd, ["ls-files", "-s", "-z", "--", path], runner);
  if (!entry.ok) return entry;
  if (entry.value.length === 0) return ok({ kind: "absent" });
  const [metadata = ""] = entry.value.split("\t");
  const [mode = "", oid = ""] = metadata.split(" ");
  if (mode === "160000") return ok({ kind: "submodule", oid });
  const bytes = gitBytes(cwd, ["show", `:${path}`], runner);
  return bytes.ok ? ok({ kind: "blob", bytes: bytes.value }) : bytes;
}

function changedPathSet(cwd: string, args: readonly string[], runner: CommandRunner): Result<Set<string>> {
  const result = gitText(cwd, args, runner);
  return result.ok ? ok(new Set(splitNul(result.value))) : result;
}

function gitText(cwd: string, args: readonly string[], runner: CommandRunner): Result<string> {
  return runText(runner, cwd, "git", args);
}

function gitBytes(cwd: string, args: readonly string[], runner: CommandRunner): Result<Buffer> {
  return runBytes(runner, cwd, "git", args);
}

function splitNul(value: string): string[] {
  const fields = value.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  return fields;
}

function statusLabel(code: NameStatus["code"]): CommitDocumentChange["status"] {
  switch (code) {
    case "A": return "added";
    case "M": return "modified";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "typeChanged";
  }
}
