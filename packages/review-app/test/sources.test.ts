import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  baselineFromContent,
  checkedSessionId,
  hashContent,
  ok,
  PatchStore,
  type ReviewDocument,
  type Result
} from "@pi-patches/store";
import {
  fuzzyFilter,
  buildSourceSelectorOptions,
  loadReviewGuidelines,
  materializeGitSource,
  materializePullRequest,
  materializeSessionSource,
  materializeSnapshot,
  materializeWorkingDiff,
  materializeWorkingTree,
  parseInspectArgs,
  selectedSourceOption,
  smartPreselection,
  sourcePresetOrder,
  systemCommandRunner,
  validatePullRequestSource,
  type CommandRunner
} from "../src/sources/index.ts";

test("working-tree source covers staged, unstaged, untracked, deleted, renamed, binary, and submodule entries", () => {
  const repo = makeRepo("working");
  try {
    write(repo, "staged.txt", "old staged\n");
    write(repo, "unstaged.txt", "old unstaged\n");
    write(repo, "deleted.txt", "delete me\n");
    write(repo, "old-name.txt", "rename me\n");
    writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    commitAll(repo, "base files");
    const gitlinkTarget = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${gitlinkTarget},vendor/sub`);
    git(repo, "commit", "-m", "add gitlink");
    const head = git(repo, "rev-parse", "HEAD").trim();

    write(repo, "staged.txt", "new staged\n");
    git(repo, "add", "staged.txt");
    write(repo, "unstaged.txt", "new unstaged\n");
    rmSync(join(repo, "deleted.txt"));
    git(repo, "mv", "old-name.txt", "new-name.txt");
    write(repo, "untracked.txt", "new file\n");
    write(repo, ".pi/patches/patches.db", "internal state\n");
    writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 9, 8, 7]));
    git(repo, "update-index", "--cacheinfo", `160000,${head},vendor/sub`);

    const result = unwrap(materializeWorkingTree(repo, "squashed", systemCommandRunner));
    const documents = new Map(result.documents.map((document) => [document.relPath, document]));
    assert.deepEqual(
      [...documents.keys()].sort(),
      ["binary.bin", "deleted.txt", "new-name.txt", "staged.txt", "unstaged.txt", "untracked.txt", "vendor/sub"]
    );
    const staged = documents.get("staged.txt");
    assert.equal(staged?.kind, "text");
    if (staged?.kind === "text") {
      assert.equal(staged.baseline.kind === "present" ? staged.baseline.content : null, git(repo, "show", "HEAD:staged.txt"));
      assert.equal(staged.head.content, readFileSync(join(repo, "staged.txt"), "utf8"));
      assert.deepEqual(staged.provenance, [{ kind: "workingTree", area: "index" }]);
    }
    assert.deepEqual(documents.get("unstaged.txt")?.provenance, [{ kind: "workingTree", area: "worktree" }]);
    assert.deepEqual(documents.get("untracked.txt")?.provenance, [{ kind: "workingTree", area: "untracked" }]);
    assert.equal(documents.get("new-name.txt")?.renamedFrom, "old-name.txt");
    const deleted = documents.get("deleted.txt");
    assert.equal(deleted?.kind === "text" ? deleted.head.content : "present", null);
    assert.equal(documents.get("binary.bin")?.kind, "binary");
    assert.equal(documents.get("vendor/sub")?.kind, "submodule");
    assert.equal(result.commits.length, 0);
    assert.equal(result.source.kind, "workingTree");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("staged and unstaged sources read distinct HEAD, index, and worktree bytes", () => {
  const repo = makeRepo("staged-unstaged");
  try {
    write(repo, "both.txt", "head\n");
    write(repo, "index-only.txt", "head index\n");
    commitAll(repo, "base");

    write(repo, "both.txt", "index\n");
    write(repo, "index-only.txt", "index only\n");
    git(repo, "add", "both.txt", "index-only.txt");
    write(repo, "both.txt", "worktree\n");
    write(repo, "untracked.txt", "untracked\n");

    const staged = unwrap(materializeWorkingDiff(repo, "staged", "squashed", systemCommandRunner));
    const unstaged = unwrap(materializeWorkingDiff(repo, "unstaged", "squashed", systemCommandRunner));
    const complete = unwrap(materializeWorkingTree(repo, "squashed", systemCommandRunner));

    assert.equal(staged.source.kind, "staged");
    assert.equal(unstaged.source.kind, "unstaged");
    assert.equal(complete.source.kind, "workingTree");
    assert.deepEqual(staged.documents.map((document) => document.relPath), ["both.txt", "index-only.txt"]);
    assert.deepEqual(unstaged.documents.map((document) => document.relPath), ["both.txt", "untracked.txt"]);
    assert.deepEqual(complete.documents.map((document) => document.relPath), ["both.txt", "index-only.txt", "untracked.txt"]);

    const stagedBoth = staged.documents.find((document) => document.relPath === "both.txt");
    const unstagedBoth = unstaged.documents.find((document) => document.relPath === "both.txt");
    const completeBoth = complete.documents.find((document) => document.relPath === "both.txt");
    assert.deepEqual(textSides(stagedBoth), { baseline: "head\n", head: "index\n" });
    assert.deepEqual(textSides(unstagedBoth), { baseline: "index\n", head: "worktree\n" });
    assert.deepEqual(textSides(completeBoth), { baseline: "head\n", head: "worktree\n" });
    assert.deepEqual(stagedBoth?.provenance, [{ kind: "workingTree", area: "index" }]);
    assert.deepEqual(unstagedBoth?.provenance, [{ kind: "workingTree", area: "worktree" }]);
    assert.deepEqual(completeBoth?.provenance, [
      { kind: "workingTree", area: "index" },
      { kind: "workingTree", area: "worktree" }
    ]);
    assert.notEqual(staged.fingerprint, unstaged.fingerprint);
    assert.notEqual(unstaged.fingerprint, complete.fingerprint);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commit ranges retain every commit and files whose net change is reverted", () => {
  const repo = makeRepo("range");
  try {
    write(repo, "a.txt", "base\n");
    commitAll(repo, "base");
    const base = git(repo, "rev-parse", "HEAD").trim();

    write(repo, "a.txt", "one\n");
    commitAll(repo, "first change");
    write(repo, "a.txt", "two\n");
    write(repo, "temporary.txt", "temporary\n");
    commitAll(repo, "second change");
    const second = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "revert", "--no-edit", second);
    const head = git(repo, "rev-parse", "HEAD").trim();

    const dataset = unwrap(materializeGitSource(repo, {
      kind: "commitRange",
      baseExclusive: base,
      headInclusive: head
    }, "perCommit", systemCommandRunner));

    assert.equal(dataset.commits.length, 3);
    assert.deepEqual(dataset.commits.map((commit) => commit.subject), ["first change", "second change", `Revert \"second change\"`]);
    assert.ok(dataset.commits.every((commit) => commit.changes.length > 0));
    assert.ok(dataset.commits.every((commit) => commit.changes.every((change) => change.patch.length > 0)));
    assert.ok(dataset.documents.some((document) => document.relPath === "temporary.txt"));
    const temporary = dataset.documents.find((document) => document.relPath === "temporary.txt");
    assert.equal(temporary?.kind, "text");
    if (temporary?.kind === "text") {
      assert.equal(temporary.baseline.kind, "absent");
      assert.equal(temporary.head.content, null);
    }
    assert.equal(dataset.source.kind, "commitRange");
    assert.equal(dataset.source.kind === "commitRange" ? dataset.source.baseExclusive : null, base);
    assert.equal(dataset.source.kind === "commitRange" ? dataset.source.headInclusive : null, head);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commit ranges associate pre-rename history with the final document", () => {
  const repo = makeRepo("range-rename");
  try {
    write(repo, "old-name.txt", "base\n");
    commitAll(repo, "base");
    const base = git(repo, "rev-parse", "HEAD").trim();

    write(repo, "old-name.txt", "changed before rename\n");
    commitAll(repo, "change old path");
    git(repo, "mv", "old-name.txt", "new-name.txt");
    commitAll(repo, "rename path");
    write(repo, "new-name.txt", "changed after rename\n");
    commitAll(repo, "change new path");
    const head = git(repo, "rev-parse", "HEAD").trim();

    const dataset = unwrap(materializeGitSource(repo, {
      kind: "commitRange",
      baseExclusive: base,
      headInclusive: head
    }, "perCommit", systemCommandRunner));

    assert.deepEqual(dataset.documents.map((document) => document.relPath), ["new-name.txt"]);
    assert.equal(dataset.documents[0]?.renamedFrom, "old-name.txt");
    assert.deepEqual(
      dataset.commits.map((commit) => commit.documents.map(String)),
      [["new-name.txt"], ["new-name.txt"], ["new-name.txt"]]
    );
    assert.ok(dataset.commits.every((commit) => commit.changes.every((change) => change.patch.length > 0)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branch source uses the merge base and merge commits retain both parents", () => {
  const repo = makeRepo("branches");
  try {
    write(repo, "shared.txt", "base\n");
    commitAll(repo, "base");
    const base = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "branch", "feature");
    write(repo, "main.txt", "main\n");
    commitAll(repo, "main diverges");
    git(repo, "switch", "feature");
    write(repo, "shared.txt", "feature\n");
    commitAll(repo, "feature change");
    const featureHead = git(repo, "rev-parse", "HEAD").trim();

    const branch = unwrap(materializeGitSource(repo, {
      kind: "branch",
      baseRef: "main",
      headRef: "feature"
    }, "perCommit", systemCommandRunner));
    assert.equal(branch.source.kind === "branch" ? branch.source.baseRef : null, base);
    assert.equal(branch.source.kind === "branch" ? branch.source.headRef : null, featureHead);
    const shared = branch.documents.find((document) => document.relPath === "shared.txt");
    assert.equal(shared?.kind === "text" && shared.baseline.kind === "present" ? shared.baseline.content : null, "base\n");

    git(repo, "switch", "main");
    git(repo, "merge", "--no-ff", "feature", "-m", "merge feature");
    const mergeSha = git(repo, "rev-parse", "HEAD").trim();
    const merge = unwrap(materializeGitSource(repo, { kind: "commit", sha: mergeSha }, "perCommit", systemCommandRunner));
    assert.equal(merge.commits.length, 1);
    assert.equal(merge.commits[0].parents.length, 2);
    assert.ok(merge.commits[0].documents.some((document) => String(document) === "shared.txt"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pull-request source reads pinned objects without changing HEAD, index, or worktree", () => {
  const repo = makeRepo("pr");
  try {
    write(repo, "a.txt", "base\n");
    commitAll(repo, "base");
    const base = git(repo, "rev-parse", "HEAD").trim();
    write(repo, "a.txt", "head\n");
    commitAll(repo, "head");
    const head = git(repo, "rev-parse", "HEAD").trim();
    write(repo, "local.txt", "untracked local state\n");
    const beforeHead = git(repo, "rev-parse", "HEAD");
    const beforeStatus = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
    let ghCalls = 0;
    let liveHead = head;
    const runner: CommandRunner = {
      run(request) {
        if (request.command !== "gh") return systemCommandRunner.run(request);
        ghCalls++;
        return ok({
          stdout: Buffer.from(JSON.stringify({
            number: 42,
            baseRefName: "main",
            headRefName: "feature",
            baseRefOid: base,
            headRefOid: liveHead
          })),
          stderr: ""
        });
      }
    };

    const dataset = unwrap(materializePullRequest(repo, 42, "perCommit", runner));
    assert.equal(dataset.source.kind, "pullRequest");
    assert.equal(dataset.commits.length, 1);
    assert.equal(ghCalls, 2);
    assert.equal(dataset.source.kind, "pullRequest");
    if (dataset.source.kind === "pullRequest") {
      assert.equal(unwrap(validatePullRequestSource(repo, dataset.source, runner)), undefined);
      liveHead = base;
      const stale = validatePullRequestSource(repo, dataset.source, runner);
      assert.equal(stale.ok, false);
    }
    assert.equal(ghCalls, 4);
    assert.equal(git(repo, "rev-parse", "HEAD"), beforeHead);
    assert.equal(git(repo, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("snapshot and session sources use checked documents without synthetic Git history", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-patches-snapshot-"));
  try {
    mkdirSync(join(root, "dir"));
    write(root, "dir/text.txt", "text\n");
    writeFileSync(join(root, "dir/binary.bin"), Buffer.from([0, 2, 4]));
    const snapshot = unwrap(materializeSnapshot(root, ["dir"], "squashed"));
    assert.deepEqual(snapshot.documents.map((document) => [document.relPath, document.kind]), [
      ["dir/binary.bin", "binary"],
      ["dir/text.txt", "text"]
    ]);
    assert.equal(snapshot.commits.length, 0);

    const store = unwrap(PatchStore.open(join(root, "patches.db"), { create: true }));
    const sessionId = unwrap(checkedSessionId("source-session"));
    unwrap(store.upsertSession(sessionId, root, null, 1));
    const file = unwrap(store.ensureFile(sessionId, join(root, "session.txt"), "session.txt", baselineFromContent("old\n"), "edit", 2));
    write(root, "session.txt", "new\n");
    unwrap(store.addPatch({
      sessionId,
      fileId: file.id,
      tool: "edit",
      toolCallId: "call",
      unifiedPatch: "",
      displayDiff: "",
      firstChangedLine: 1,
      preHash: hashContent("old\n"),
      postHash: hashContent("new\n"),
      createdAt: 3
    }));
    const session = unwrap(store.listSessions())[0];
    const dataset = unwrap(materializeSessionSource(store, session, "squashed"));
    assert.equal(dataset.documents[0].provenance[0]?.kind, "sessionPatch");
    assert.equal(dataset.commits.length, 0);
    unwrap(store.close());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source parser, fuzzy selector, smart default, and project guidelines are deterministic", () => {
  assert.deepEqual(sourcePresetOrder, ["session", "workingTree", "staged", "unstaged", "baseBranch", "commitRange", "pullRequest", "snapshot"]);
  assert.deepEqual(unwrap(parseInspectArgs("staged")), { source: { kind: "staged" }, historyMode: "squashed" });
  assert.deepEqual(unwrap(parseInspectArgs("unstaged")), { source: { kind: "unstaged" }, historyMode: "squashed" });
  assert.deepEqual(unwrap(parseInspectArgs("range main..HEAD --history per-commit")), {
    source: { kind: "commitRange", baseExclusive: "main", headInclusive: "HEAD" },
    historyMode: "perCommit"
  });
  assert.deepEqual(unwrap(parseInspectArgs("snapshot 'path with spaces' src")), {
    source: { kind: "snapshot", paths: ["path with spaces", "src"] },
    historyMode: "squashed"
  });
  assert.deepEqual(
    fuzzyFilter([
      { id: "1", label: "main", value: 1 },
      { id: "2", label: "feature/parser", value: 2 },
      { id: "3", label: "release", value: 3 }
    ], "fpar").map((option) => option.id),
    ["2"]
  );
  assert.equal(smartPreselection({ connectedSessionHasPatches: false, workingTreeHasChanges: true, onNonDefaultBranch: true }), "workingTree");

  const root = mkdtempSync(join(tmpdir(), "pi-patches-guidelines-"));
  try {
    mkdirSync(join(root, ".pi"));
    mkdirSync(join(root, "nested"));
    write(root, "REVIEW_GUIDELINES.md", "  Check migrations.  \n");
    assert.deepEqual(unwrap(loadReviewGuidelines(join(root, "nested"))), {
      projectRoot: root,
      path: join(root, "REVIEW_GUIDELINES.md"),
      contents: "Check migrations."
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source options make the remembered opposite-family request the direct toggle target", () => {
  const repo = makeRepo("source-options");
  try {
    write(repo, "a.txt", "base\n");
    commitAll(repo, "base");
    git(repo, "branch", "feature");
    const store = unwrap(PatchStore.open(join(repo, "patches.db"), { create: true }));
    const sessionId = unwrap(checkedSessionId("source-options-session"));
    unwrap(store.upsertSession(sessionId, repo, null, 1));
    const session = unwrap(store.listSessions())[0];
    const active = { source: { kind: "session" as const, sessionId }, historyMode: "squashed" as const };
    const remembered = {
      source: { kind: "branch" as const, baseRef: "feature", headRef: "HEAD" },
      historyMode: "perCommit" as const
    };
    const options = unwrap(buildSourceSelectorOptions({
      cwd: repo,
      store,
      connectedSession: session,
      runner: systemCommandRunner,
      remembered: [active, remembered]
    }));
    const selected = selectedSourceOption(options, active, active, remembered);
    const option = options[selected];
    assert.equal(option.choice.kind, "request");
    if (option.choice.kind === "request") {
      assert.deepEqual(option.choice.request, remembered);
      assert.equal(option.choice.selectHistory, false);
    }
    unwrap(store.close());
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function textSides(document: ReviewDocument | undefined): { baseline: string | null; head: string | null } {
  assert.equal(document?.kind, "text");
  if (document?.kind !== "text") return { baseline: null, head: null };
  return {
    baseline: document.baseline.kind === "present" ? document.baseline.content : null,
    head: document.head.content
  };
}

function makeRepo(label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `pi-patches-${label}-`));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "pi-patches@example.test");
  git(repo, "config", "user.name", "Pi Patches Test");
  return repo;
}

function write(root: string, path: string, contents: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-m", message);
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
