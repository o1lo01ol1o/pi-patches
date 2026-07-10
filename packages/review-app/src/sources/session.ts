import { existsSync, readFileSync } from "node:fs";
import {
  err,
  hashReviewSource,
  ok,
  type Attribution,
  type HistoryMode,
  type PatchStore,
  type Result,
  type ReviewDataset,
  type SessionRecord
} from "@pi-patches/store";
import { makeReviewDocument, normalizedDocumentFingerprint, type DocumentSide } from "./document.ts";

export function materializeSessionSource(
  store: PatchStore,
  session: SessionRecord,
  historyMode: HistoryMode
): Result<ReviewDataset> {
  if (historyMode !== "squashed") {
    return err({ kind: "InvalidInput", field: "historyMode", message: "session sources use their native patch history and support only squashed Git history" });
  }
  const files = store.getFiles(session.id);
  if (!files.ok) return files;
  const patches = store.getPatches(session.id);
  if (!patches.ok) return patches;
  const documents = [];
  for (const file of files.value) {
    let head: DocumentSide;
    try {
      head = existsSync(file.path) ? { kind: "blob", bytes: readFileSync(file.path) } : { kind: "absent" };
    } catch (error) {
      return err({ kind: "Io", path: file.path, message: error instanceof Error ? error.message : String(error) });
    }
    const provenance: Attribution[] = patches.value
      .filter((patch) => patch.fileId === file.id)
      .map((patch) => ({ kind: "sessionPatch", patchId: Number(patch.id), sequence: Number(patch.seq) }));
    documents.push(makeReviewDocument({
      root: session.cwd,
      relPath: file.relPath,
      baseline: file.baseline.kind === "absent"
        ? { kind: "absent" }
        : { kind: "blob", bytes: Buffer.from(file.baseline.content, "utf8") },
      head,
      provenance
    }));
  }
  const source = { kind: "session", sessionId: session.id } as const;
  const fingerprint = hashReviewSource({
    source,
    historyMode,
    documents: documents.map(normalizedDocumentFingerprint),
    patches: patches.value.map((patch) => ({
      id: patch.id,
      seq: patch.seq,
      fileId: patch.fileId,
      preHash: patch.preHash,
      postHash: patch.postHash
    }))
  });
  return ok({ source, historyMode, fingerprint, documents, commits: [] });
}
