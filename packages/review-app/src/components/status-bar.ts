import type { AppState } from "../state.ts";

export function renderStatusBar(state: AppState): string {
  const message = state.statusMessage ? ` | ${state.statusMessage}` : "";
  const pending = state.pendingKey ? ` | pending ${state.pendingKey}` : "";
  const counts = annotationCounts(state);
  return `src:${sourceBadge(state)} | ${counts.draft} drafts | ${counts.queued} queued | ${counts.sent} sent | ${state.activeTab} | ${state.mode.kind}${pending}${message} | e expand | s source | ? keys`;
}

function sourceBadge(state: AppState): string {
  switch (state.dataset.source.kind) {
    case "session": return "session";
    case "workingTree": return "worktree";
    case "staged": return "staged";
    case "unstaged": return "unstaged";
    case "branch": return "branch";
    case "commit": return "commit";
    case "commitRange": return "range";
    case "pullRequest": return "pr";
    case "snapshot": return "snapshot";
  }
}

function annotationCounts(state: AppState): { draft: number; queued: number; sent: number } {
  let draft = 0;
  let queued = 0;
  let sent = 0;
  for (const annotation of state.annotations) {
    switch (annotation.state.kind) {
      case "draft":
        draft++;
        break;
      case "queued":
        queued++;
        break;
      case "sent":
        sent++;
        break;
    }
  }
  return { draft, queued, sent };
}
