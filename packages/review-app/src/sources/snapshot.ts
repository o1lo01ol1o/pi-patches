import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { err, hashReviewSource, ok, type HistoryMode, type Result, type ReviewDataset } from "@pi-patches/store";
import { makeReviewDocument, normalizedDocumentFingerprint } from "./document.ts";

export function materializeSnapshot(cwd: string, paths: readonly [string, ...string[]], historyMode: HistoryMode): Result<ReviewDataset> {
  if (historyMode !== "squashed") {
    return err({ kind: "InvalidInput", field: "historyMode", message: "snapshot supports only squashed history" });
  }
  const expanded = new Set<string>();
  try {
    for (const requested of paths) collectFiles(isAbsolute(requested) ? requested : resolve(cwd, requested), expanded);
  } catch (error) {
    const path = error instanceof SnapshotReadError ? error.path : cwd;
    return err({ kind: "Io", path, message: error instanceof Error ? error.message : String(error) });
  }
  if (expanded.size === 0) {
    return err({ kind: "InvalidInput", field: "snapshot.paths", message: "no regular files were selected" });
  }
  const documents = [];
  for (const absolute of [...expanded].sort()) {
    const relPath = relative(cwd, absolute) || absolute;
    try {
      documents.push(makeReviewDocument({
        root: cwd,
        relPath,
        baseline: { kind: "absent" },
        head: { kind: "blob", bytes: readFileSync(absolute) },
        provenance: [{ kind: "snapshot" }]
      }));
    } catch (error) {
      return err({ kind: "Io", path: absolute, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const source = { kind: "snapshot", paths } as const;
  const fingerprint = hashReviewSource({ source, historyMode, documents: documents.map(normalizedDocumentFingerprint) });
  return ok({ source, historyMode, fingerprint, documents, commits: [] });
}

function collectFiles(path: string, output: Set<string>): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new SnapshotReadError(path, error instanceof Error ? error.message : String(error));
  }
  if (stat.isFile() || stat.isSymbolicLink()) {
    output.add(path);
    return;
  }
  if (!stat.isDirectory()) throw new SnapshotReadError(path, "unsupported filesystem entry");
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    throw new SnapshotReadError(path, error instanceof Error ? error.message : String(error));
  }
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) collectFiles(child, output);
    else if (entry.isFile() || entry.isSymbolicLink()) output.add(child);
  }
}

class SnapshotReadError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}
