import {
  err,
  ok,
  type PatchStore,
  type Result,
  type ReviewDataset,
  type SessionRecord
} from "@pi-patches/store";
import { materializeGitSource, materializeWorkingTree } from "./git.ts";
import { materializePullRequest } from "./pull-request.ts";
import { materializeSessionSource } from "./session.ts";
import { materializeSnapshot } from "./snapshot.ts";
import { systemCommandRunner, type CommandRunner } from "./process.ts";
import type { InspectRequest } from "./selector.ts";

export type MaterializeContext = {
  cwd: string;
  store: PatchStore;
  currentSession: SessionRecord;
  runner?: CommandRunner;
  now?: () => number;
};

export function materializeInspectRequest(request: InspectRequest, context: MaterializeContext): Result<ReviewDataset> {
  const runner = context.runner ?? systemCommandRunner;
  let dataset: Result<ReviewDataset>;
  switch (request.source.kind) {
    case "session": {
      const session = request.source.sessionId === null
        ? ok(context.currentSession)
        : resolveSession(context.store, request.source.sessionId);
      if (!session.ok) return session;
      dataset = materializeSessionSource(context.store, session.value, request.historyMode);
      break;
    }
    case "workingTree":
      dataset = materializeWorkingTree(context.cwd, request.historyMode, runner);
      break;
    case "branch":
      dataset = materializeGitSource(context.cwd, { kind: "branch", baseRef: request.source.baseRef, headRef: request.source.headRef }, request.historyMode, runner);
      break;
    case "commit":
      dataset = materializeGitSource(context.cwd, { kind: "commit", sha: request.source.sha }, request.historyMode, runner);
      break;
    case "commitRange":
      dataset = materializeGitSource(context.cwd, {
        kind: "commitRange",
        baseExclusive: request.source.baseExclusive,
        headInclusive: request.source.headInclusive
      }, request.historyMode, runner);
      break;
    case "pullRequest":
      dataset = materializePullRequest(context.cwd, request.source.number, request.historyMode, runner);
      break;
    case "snapshot":
      dataset = materializeSnapshot(context.cwd, request.source.paths, request.historyMode);
      break;
  }
  if (!dataset.ok) return dataset;
  const saved = context.store.saveReviewSource({
    fingerprint: dataset.value.fingerprint,
    source: dataset.value.source,
    historyMode: dataset.value.historyMode,
    createdAt: context.now?.() ?? Date.now()
  });
  return saved.ok ? dataset : saved;
}

function resolveSession(store: PatchStore, selector: string): Result<SessionRecord> {
  const sessions = store.listSessions();
  if (!sessions.ok) return sessions;
  const exact = sessions.value.find((session) => session.id === selector);
  if (exact) return ok(exact);
  const matches = sessions.value.filter((session) => session.id.startsWith(selector));
  if (matches.length === 1) return ok(matches[0]);
  if (matches.length === 0) return err({ kind: "NotFound", entity: "session", id: selector });
  return err({ kind: "InvalidInput", field: "session", message: `ambiguous prefix ${selector}` });
}
