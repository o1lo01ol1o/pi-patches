import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  checkedBatchId,
  errorMessage,
  hashContent,
  type ClaimedFeedback,
  type ContentHash
} from "@pi-patches/store";
import { formatBatch } from "./format-message.ts";
import type { RecorderState } from "./recorder.ts";

export function pollQueuedAnnotations(pi: ExtensionAPI, ctx: ExtensionContext, state: RecorderState): void {
  if (state.sending) return;
  const version = state.store.dataVersion();
  if (!version.ok) {
    ctx.ui.notify(`pi-patches: ${errorMessage(version.error)}`, "error");
    return;
  }
  if (version.value === state.lastDataVersion) return;
  const scanVersion = version.value;
  state.sending = true;
  try {
    const batch = checkedBatchId(randomUUID());
    if (!batch.ok) {
      ctx.ui.notify(`pi-patches: ${errorMessage(batch.error)}`, "error");
      return;
    }
    const feedback = state.store.claimQueuedFeedback(state.sessionId, batch.value);
    if (!feedback.ok) {
      ctx.ui.notify(`pi-patches: ${errorMessage(feedback.error)}`, "error");
      return;
    }
    const claimed: ClaimedFeedback[] = feedback.value;
    state.lastDataVersion = scanVersion;
    if (claimed.length === 0) return;
    const currentHashes = currentHashesFor(claimed, (path, error) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-patches: could not read ${path} while checking annotation freshness: ${message}`, "warning");
    });
    const message = formatBatch(claimed, { currentHashes });
    if (ctx.isIdle()) {
      pi.sendUserMessage(message);
    } else {
      pi.sendUserMessage(message, { deliverAs: "steer" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`pi-patches submit failed: ${message}`, "error");
  } finally {
    state.sending = false;
  }
}

function currentHashesFor(
  rows: readonly ClaimedFeedback[],
  onReadError: (path: string, error: unknown) => void
): Map<string, ContentHash | null> {
  const hashes = new Map<string, ContentHash | null>();
  for (const row of rows) {
    if (!row.checkDisk) continue;
    if (hashes.has(row.file.path)) continue;
    try {
      if (!existsSync(row.file.path)) {
        hashes.set(row.file.path, null);
        continue;
      }
      hashes.set(row.file.path, hashContent(readFileSync(row.file.path, "utf8")));
    } catch (error) {
      hashes.set(row.file.path, null);
      onReadError(row.file.path, error);
    }
  }
  return hashes;
}
