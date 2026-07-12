import type { AppState } from "../state.ts";

export function renderStatusBar(state: AppState): string {
  const message = state.statusMessage ? ` | ${state.statusMessage}` : "";
  const pending = state.pendingKey ? ` | pending ${state.pendingKey}` : "";
  const counts = annotationCounts(state);
  return `${counts.draft} drafts | ${counts.queued} queued | ${counts.sent} sent | ${state.activeTab} | ${state.mode.kind} | ? keys${pending}${message}`;
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
