#!/usr/bin/env node
import { discover, errorMessage, parseReviewArgs } from "@pi-patches/store";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { explainResult, loadAppState, renderReadOnly } from "./app.ts";
import { runInteractive } from "./runner.ts";
import { formatSessionListRow } from "./session-list.ts";

const args = parseReviewArgs(process.argv.slice(2));
if (!args.ok) {
  console.error(errorMessage(args.error));
  process.exitCode = 2;
} else if (args.value.help) {
  console.log(helpText());
} else {
  const discovery = discover(args.value);
  if (!discovery.ok) {
    console.error(errorMessage(discovery.error));
    process.exitCode = 1;
  } else {
    let handedOffToInteractive = false;
    try {
      initTheme();
      if (args.value.list) {
        const sessions = explainResult(discovery.value.store.listSessions());
        for (const session of sessions) {
          const counts = explainResult(discovery.value.store.counts(session.id));
          console.log(formatSessionListRow(session, counts));
        }
      } else if (!discovery.value.session) {
        console.error("No pi-patches sessions found.");
        process.exitCode = 1;
      } else {
        const state = explainResult(loadAppState(discovery.value.store, discovery.value.session));
        if (process.stdout.isTTY && process.stdin.isTTY) {
          runInteractive(discovery.value, state);
          handedOffToInteractive = true;
        } else {
          console.log(renderReadOnly(state));
        }
      }
    } finally {
      if (!handedOffToInteractive) discovery.value.store.close();
    }
  }
}

function helpText(): string {
  return [
    "Usage: pi-review [--db PATH] [--session ID_OR_PREFIX] [--list]",
    "",
    "Environment:",
    "  PI_PATCHES_DB       path to .pi/patches/patches.db",
    "  PI_PATCHES_SESSION  session id or prefix"
  ].join("\n");
}
