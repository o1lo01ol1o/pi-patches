import type { SessionRecord } from "@pi-patches/store";

export type SessionListCounts = {
  files: number;
  patches: number;
};

export function formatSessionListRow(session: SessionRecord, counts: SessionListCounts): string {
  const status = session.endedAt === null ? "live" : "ended";
  return [
    session.id,
    status,
    new Date(session.startedAt).toISOString(),
    `${counts.files} ${plural(counts.files, "file", "files")}`,
    `${counts.patches} ${plural(counts.patches, "patch", "patches")}`,
    session.cwd
  ].join("\t");
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}
