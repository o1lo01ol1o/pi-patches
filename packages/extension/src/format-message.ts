import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import type { ClaimedFeedback, ContentHash } from "@pi-patches/store";

export type BatchFormatOptions = {
  currentHashes?: ReadonlyMap<string, ContentHash | null>;
};

export function formatBatch(rows: readonly ClaimedFeedback[], options: BatchFormatOptions = {}): string {
  const ordered = [...rows].sort(compareClaimedAnnotations);
  const lines: string[] = [];
  lines.push(
    `Code review findings on the selected changes (${ordered.length} ${ordered.length === 1 ? "finding" : "findings"}).`
  );
  if (ordered.some((row) => row.fixIntent)) {
    lines.push("Fix each item in priority order. Report fixed and deferred item numbers, then state the verification you ran.");
  } else {
    lines.push("Address each item, then briefly state what you changed per item number.");
  }
  lines.push("");

  ordered.forEach((row, index) => {
    const headerRange =
      row.anchor.start === row.anchor.end ? `${row.anchor.start}` : `${row.anchor.start}-${row.anchor.end}`;
    const priority = row.role.kind === "finding" ? row.role.priority : "P3";
    lines.push(`## ${index + 1}. ${row.file.relPath}:${headerRange} [${priority}]`);
    const currentHash = options.currentHashes?.get(row.file.path);
    if (currentHash !== undefined && currentHash !== row.anchor.hash) {
      const anchor = row.anchorSeq === 0 ? "baseline" : `patch ${row.anchorSeq}`;
      lines.push(`(note: anchored @ ${anchor}; file has changed since)`);
    }
    const fence = fenceFor(row.snippet);
    const language = languageForPath(row.file.relPath);
    lines.push(`${fence}${language}`);
    lines.push(row.snippet);
    lines.push(fence);
    lines.push(row.comment);
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

function compareClaimedAnnotations(left: ClaimedFeedback, right: ClaimedFeedback): number {
  const byPriority = priorityRank(left) - priorityRank(right);
  if (byPriority !== 0) return byPriority;
  const byPath = left.file.relPath.localeCompare(right.file.relPath);
  if (byPath !== 0) return byPath;
  const byStart = Number(left.anchor.start) - Number(right.anchor.start);
  if (byStart !== 0) return byStart;
  return Number(left.id) - Number(right.id);
}

function priorityRank(annotation: ClaimedFeedback): number {
  if (annotation.role.kind !== "finding") return 4;
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[annotation.role.priority];
}

function fenceFor(snippet: string): string {
  const runs = snippet.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  return "`".repeat(longest + 1);
}

function languageForPath(path: string): string {
  return getLanguageFromPath(path) ?? "";
}
