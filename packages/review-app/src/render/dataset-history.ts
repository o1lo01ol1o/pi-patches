import { parsePatch } from "diff";
import type { ReviewDataset } from "@pi-patches/store";
import type { DatasetHistoryEntry, FileState } from "../state.ts";

export function buildDatasetHistoryEntries(
  dataset: ReviewDataset,
  files: readonly FileState[]
): DatasetHistoryEntry[] {
  if (dataset.historyMode !== "perCommit") return [];
  const fileByPath = new Map(files.map((file) => [file.row.relPath, file.row.id]));
  return dataset.commits.flatMap((commit) => commit.changes.flatMap((change) => {
    const path = String(change.documentId);
    const fileId = fileByPath.get(path);
    if (fileId === undefined) return [];
    return [{
      fileId,
      commitSha: commit.sha,
      subject: commit.subject,
      authoredAt: commit.authoredAt,
      status: change.status,
      displayDiff: displayDiffFromUnified(change.patch, change.status, path)
    } satisfies DatasetHistoryEntry];
  }));
}

export function displayDiffFromUnified(unified: string, status: string, path: string): string {
  try {
    const lines: string[] = [];
    for (const file of parsePatch(unified)) {
      for (const hunk of file.hunks) {
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        for (const raw of hunk.lines) {
          const prefix = raw[0];
          const content = raw.slice(1);
          if (prefix === "-") {
            lines.push(`-${oldLine} ${content}`);
            oldLine++;
          } else if (prefix === "+") {
            lines.push(`+${newLine} ${content}`);
            newLine++;
          } else if (prefix === " ") {
            lines.push(` ${newLine} ${content}`);
            oldLine++;
            newLine++;
          }
        }
      }
    }
    if (lines.length > 0) return lines.join("\n");
  } catch {}
  return `+1 [${status} ${path}]`;
}
