import { ok, type PatchStore, type Result, type SessionRecord } from "@pi-patches/store";
import { listBranches, listRecentCommits } from "./git.ts";
import type { CommandRunner } from "./process.ts";
import {
  inspectRequestKey,
  sourceFamily,
  type InspectRequest,
  type SourceSelectorOption
} from "./selector.ts";

export type SourceOptionContext = {
  cwd: string;
  store: PatchStore;
  connectedSession: SessionRecord;
  runner: CommandRunner;
  remembered: readonly InspectRequest[];
};

export function buildSourceSelectorOptions(context: SourceOptionContext): Result<SourceSelectorOption[]> {
  const sessions = context.store.listSessions();
  if (!sessions.ok) return sessions;
  const branches = listBranches(context.cwd, context.runner);
  const commits = listRecentCommits(context.cwd, context.runner);

  const options: SourceSelectorOption[] = [];
  const orderedSessions = [...sessions.value].sort((left, right) => {
    if (left.id === context.connectedSession.id) return -1;
    if (right.id === context.connectedSession.id) return 1;
    return (right.lastEventAt ?? right.startedAt) - (left.lastEventAt ?? left.startedAt);
  });
  for (const session of orderedSessions) {
    options.push(requestOption(
      `session:${session.id}`,
      `Session patches: ${session.id}`,
      session.id === context.connectedSession.id
        ? "connected session"
        : `${session.endedAt === null ? "live" : "ended"} ${new Date(session.lastEventAt ?? session.startedAt).toISOString()}`,
      { source: { kind: "session", sessionId: session.id }, historyMode: "squashed" },
      false
    ));
  }

  options.push(requestOption(
    "git:working-tree",
    "Git: complete working tree",
    "HEAD to WORKTREE (staged, unstaged, and untracked)",
    { source: { kind: "workingTree" }, historyMode: "squashed" },
    false
  ));
  options.push(requestOption(
    "git:staged",
    "Git: staged only",
    "HEAD to INDEX",
    { source: { kind: "staged" }, historyMode: "squashed" },
    false
  ));
  options.push(requestOption(
    "git:unstaged",
    "Git: unstaged only",
    "INDEX to WORKTREE (including untracked)",
    { source: { kind: "unstaged" }, historyMode: "squashed" },
    false
  ));

  for (const branch of (branches.ok ? branches.value : []).filter((branch) => !branch.current)) {
    options.push(requestOption(
      `git:branch:${branch.name}`,
      `Git branch: ${branch.name}..HEAD`,
      branch.isDefault ? "default base branch" : "merge-base comparison",
      { source: { kind: "branch", baseRef: branch.name, headRef: "HEAD" }, historyMode: "squashed" },
      true
    ));
  }
  for (const commit of commits.ok ? commits.value : []) {
    options.push(requestOption(
      `git:commit:${commit.sha}`,
      `Git commit: ${commit.sha.slice(0, 8)} ${commit.subject}`,
      "single commit",
      { source: { kind: "commit", sha: commit.sha }, historyMode: "squashed" },
      true
    ));
  }

  options.push({
    id: "git:range-input",
    label: "Git range...",
    description: "enter base..head",
    family: "git",
    choice: { kind: "input", input: "commitRange" }
  });
  options.push({
    id: "git:pr-input",
    label: "Git pull request...",
    description: "enter pull request number",
    family: "git",
    choice: { kind: "input", input: "pullRequest" }
  });
  options.push({
    id: "snapshot:input",
    label: "Snapshot paths...",
    description: "current files without a Git diff",
    family: "snapshot",
    choice: { kind: "input", input: "snapshot" }
  });

  for (const request of context.remembered) {
    const existing = options.findIndex((option) => option.choice.kind === "request" && inspectRequestKey(option.choice.request) === inspectRequestKey(request));
    if (existing >= 0) {
      const option = options[existing];
      if (option.choice.kind === "request") {
        options[existing] = {
          ...option,
          description: `${option.description}; most recently viewed in this family`,
          choice: { ...option.choice, selectHistory: false }
        };
      }
      continue;
    }
    options.push(requestOption(
      `remembered:${inspectRequestKey(request)}`,
      `${sourceFamily(request) === "session" ? "Session patches" : "Previous Git source"}: ${requestLabel(request)}`,
      "most recently viewed source in this family",
      request,
      false
    ));
  }
  return ok(options);
}

export function selectedSourceOption(
  options: readonly SourceSelectorOption[],
  active: InspectRequest,
  lastSession: InspectRequest | null,
  lastGit: InspectRequest | null
): number {
  const activeFamily = sourceFamily(active);
  const target = activeFamily === "session" ? lastGit : activeFamily === "git" ? lastSession : active;
  if (target !== null) {
    const key = inspectRequestKey(target);
    const exact = options.findIndex((option) => option.choice.kind === "request" && inspectRequestKey(option.choice.request) === key);
    if (exact >= 0) return exact;
  }
  const desiredFamily = activeFamily === "session" ? "git" : activeFamily === "git" ? "session" : "snapshot";
  const sameFamily = options.findIndex((option) => option.family === desiredFamily);
  return Math.max(0, sameFamily);
}

function requestOption(
  id: string,
  label: string,
  description: string,
  request: InspectRequest,
  selectHistory: boolean
): SourceSelectorOption {
  return { id, label, description, family: sourceFamily(request), choice: { kind: "request", request, selectHistory } };
}

function requestLabel(request: InspectRequest): string {
  const source = request.source;
  switch (source.kind) {
    case "session": return source.sessionId ?? "current";
    case "workingTree": return "complete working tree";
    case "staged": return "staged HEAD..INDEX";
    case "unstaged": return "unstaged INDEX..WORKTREE";
    case "branch": return `${source.baseRef}..${source.headRef}`;
    case "commit": return `commit ${source.sha.slice(0, 8)}`;
    case "commitRange": return `${source.baseExclusive}..${source.headInclusive}`;
    case "pullRequest": return `PR #${source.number}`;
    case "snapshot": return source.paths.join(" ");
  }
}
