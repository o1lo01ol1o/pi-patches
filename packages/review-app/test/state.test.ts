import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  anchorLine,
  baselineFromContent,
  checkedAnalysisRunId,
  checkedBatchId,
  checkedSessionId,
  hashContent,
  hashReviewSource,
  type Annotation,
  type AnnotationId,
  type ContentHash,
  type DiffRow,
  type FileId,
  type PatchId,
  type PatchRecord,
  type Result,
  type Seq,
  type SessionId
} from "@pi-patches/store";
import { renderFrame } from "../src/components/frame.ts";
import { renderFileTree } from "../src/components/file-tree.ts";
import { computeFrameLayout } from "../src/layout.ts";
import { buildDiffModel } from "../src/render/diff-model.ts";
import { visualRowRef } from "../src/render/diff-wrap.ts";
import { displayDiffFromUnified } from "../src/render/dataset-history.ts";
import { stripAnsi, visibleWidth } from "../src/render/ansi.ts";
import { contentHashForCurrent, currentDiffVisualMap, draftForCursor, update, viewportFromSize, type AppState, type FileState } from "../src/state.ts";

test("comment editor save result creates a draft effect", () => {
  let state = fixtureState();
  let result = update(state, { kind: "key", key: "c" });
  state = result.state;

  assert.equal(state.mode.kind, "comment");
  assert.equal(state.mode.kind === "comment" ? state.mode.initialText : "not-comment", "");
  assert.deepEqual(result.effects, []);

  result = update(state, { kind: "commentSubmitted", text: "Fix me" });
  assert.equal(result.state.mode.kind, "normal");
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, "addAnnotation");
  if (result.effects[0]?.kind === "addAnnotation") {
    assert.equal(result.effects[0].comment, "Fix me");
    assert.equal(result.effects[0].draft.snippet, "one");
    assert.equal(Number(result.effects[0].draft.anchor.start), 1);
  }
});

test("comment editor save result re-anchors and updates a stale annotation", () => {
  const draft = {
    fileId: 1 as FileId,
    anchor: {
      patchId: null,
      hash: contentHashForCurrent("one\nTWO\n"),
      start: unwrap(anchorLine(2)),
      end: unwrap(anchorLine(2))
    },
    snippet: "TWO"
  };
  const result = update(
    fixtureState({
      mode: {
        kind: "comment",
        target: { kind: "reanchor", annotationId: 1 as AnnotationId, draft, oldSnippet: "two" },
        initialText: "Old comment",
        role: { kind: "finding", priority: "P2", audience: "agent" }
      }
    }),
    { kind: "commentSubmitted", text: "Updated comment" }
  );

  assert.equal(result.state.mode.kind, "normal");
  assert.deepEqual(result.effects, [
    { kind: "reanchorAnnotation", annotationId: 1 as AnnotationId, anchor: draft.anchor, snippet: "TWO" },
    { kind: "updateAnnotation", annotationId: 1 as AnnotationId, comment: "Updated comment" },
    {
      kind: "updateAnnotationRole",
      annotationId: 1 as AnnotationId,
      role: { kind: "finding", priority: "P2", audience: "agent" }
    }
  ]);
});

test("comment editor cancel result closes without effects", () => {
  const opened = update(fixtureState(), { kind: "key", key: "c" });
  const cancelled = update(opened.state, { kind: "commentCancelled" });
  assert.equal(cancelled.state.mode.kind, "normal");
  assert.equal(cancelled.state.statusMessage, "Comment cancelled");
  assert.deepEqual(cancelled.effects, []);
});

test("submit confirmation only queues existing draft annotations", () => {
  const withoutDrafts = update(fixtureState(), { kind: "key", key: "S" });
  assert.equal(withoutDrafts.state.mode.kind, "normal");
  assert.deepEqual(withoutDrafts.effects, []);

  const withDraft = fixtureState({
    annotations: [
      {
        id: 1 as AnnotationId,
        sessionId: unwrap(checkedSessionId("state-test-session")),
        fileId: 1 as FileId,
        anchor: { patchId: null, hash: hashContent("one\ntwo\n"), start: unwrap(anchorLine(1)), end: unwrap(anchorLine(1)) },
        snippet: "one",
        comment: "Fix me",
        role: { kind: "finding", priority: "P2", audience: "agent" },
        state: { kind: "draft" },
        createdAt: 1,
        updatedAt: 1
      }
    ]
  });

  const confirm = update(withDraft, { kind: "key", key: "S" });
  assert.equal(confirm.state.mode.kind, "confirmSubmit");
  const queued = update(confirm.state, { kind: "key", key: "y" });
  assert.deepEqual(queued.effects, [{ kind: "queueDrafts", fixIntent: false, quitAfter: false }]);
});

test("submit confirmation excludes stale draft annotations", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const state = fixtureState({
    annotations: [
      {
        id: 1 as AnnotationId,
        sessionId,
        fileId: 1 as FileId,
        anchor: { patchId: null, hash: hashContent("one\ntwo\n"), start: unwrap(anchorLine(1)), end: unwrap(anchorLine(1)) },
        snippet: "one",
        comment: "Fresh",
        role: { kind: "finding", priority: "P2", audience: "agent" },
        state: { kind: "draft" },
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 2 as AnnotationId,
        sessionId,
        fileId: 1 as FileId,
        anchor: { patchId: null, hash: hashContent("old\n"), start: unwrap(anchorLine(1)), end: unwrap(anchorLine(1)) },
        snippet: "old",
        comment: "Stale",
        role: { kind: "finding", priority: "P2", audience: "agent" },
        state: { kind: "draft" },
        createdAt: 1,
        updatedAt: 1
      }
    ]
  });

  const confirm = update(state, { kind: "key", key: "S" });
  assert.equal(confirm.state.mode.kind, "confirmSubmit");
  assert.equal(confirm.state.mode.kind === "confirmSubmit" ? confirm.state.mode.count : 0, 1);
  assert.equal(confirm.state.statusMessage, "Submit 1 fresh draft comment(s)? y/n; 1 stale excluded");
});

test("q opens the four-way finish selector only when drafts exist", () => {
  const direct = update(fixtureState(), { kind: "key", key: "q" });
  assert.deepEqual(direct.effects, [{ kind: "quit" }]);

  const state = fixtureState({ annotations: [makeAnnotation()] });
  const opened = update(state, { kind: "key", key: "q" });
  assert.equal(opened.state.mode.kind, "finish");
  if (opened.state.mode.kind !== "finish") return;
  assert.deepEqual(
    {
      selected: opened.state.mode.selected,
      freshAgent: opened.state.mode.freshAgent,
      staleAgent: opened.state.mode.staleAgent,
      humanNotes: opened.state.mode.humanNotes
    },
    { selected: 0, freshAgent: 1, staleAgent: 0, humanNotes: 0 }
  );
  const returned = update(opened.state, { kind: "key", key: "Enter" });
  assert.deepEqual(returned.effects, [{ kind: "quit" }]);
});

test("finish selector separates submit, submit-and-fix, and cancel actions", () => {
  const annotations = [
    makeAnnotation({ id: 1 }),
    makeAnnotation({ id: 2, hash: hashContent("stale\n") }),
    { ...makeAnnotation({ id: 3 }), role: { kind: "callout", audience: "human" } as const }
  ];
  const opened = update(fixtureState({ annotations }), { kind: "key", key: "q" });
  assert.equal(opened.state.mode.kind, "finish");
  if (opened.state.mode.kind !== "finish") return;
  assert.equal(opened.state.mode.freshAgent, 1);
  assert.equal(opened.state.mode.staleAgent, 1);
  assert.equal(opened.state.mode.humanNotes, 1);

  const submitSelected = update(opened.state, { kind: "key", key: "ArrowDown" });
  const submit = update(submitSelected.state, { kind: "key", key: "Enter" });
  assert.deepEqual(submit.effects, [{ kind: "queueDrafts", fixIntent: false, quitAfter: true }]);

  const fixSelected = update(submitSelected.state, { kind: "key", key: "ArrowDown" });
  const fix = update(fixSelected.state, { kind: "key", key: "Enter" });
  assert.deepEqual(fix.effects, [{ kind: "queueDrafts", fixIntent: true, quitAfter: true }]);

  const cancelSelected = update(fixSelected.state, { kind: "key", key: "ArrowDown" });
  const cancelled = update(cancelSelected.state, { kind: "key", key: "Enter" });
  assert.equal(cancelled.state.mode.kind, "normal");
  assert.deepEqual(cancelled.effects, []);
});

test("draftForCursor returns null when the cursor is on a hunk header", () => {
  const state = fixtureState({ cursorRow: 0 as DiffRow });
  assert.equal(draftForCursor(state), null);
});

test("draftForCursor anchors pure deletions to a nearby current line and preserves deleted text", () => {
  const state = fixtureState({
    files: [makeFile(1, "example.txt", "keep\nold\nnext\n", "keep\nnext\n")],
    patches: [],
    cursorRow: 2 as DiffRow
  });

  const draft = draftForCursor(state);
  assert.equal(draft?.snippet, "old");
  assert.equal(Number(draft?.anchor.start), 1);
  assert.equal(Number(draft?.anchor.end), 1);
});

test("draftForCursor snaps selections spanning deletions to current-version lines", () => {
  const state = fixtureState({
    files: [makeFile(1, "example.txt", "keep\nold\nnext\n", "keep\nnext\n")],
    patches: [],
    selection: { anchor: 2 as DiffRow, head: 3 as DiffRow }
  });

  const draft = draftForCursor(state);
  assert.equal(draft?.snippet, "old\nnext");
  assert.equal(Number(draft?.anchor.start), 2);
  assert.equal(Number(draft?.anchor.end), 2);
});

test("history mode navigates selected file patches and renders the current patch", () => {
  initTheme("dark");
  const state = fixtureState({
    view: "history",
    patches: [
      makePatch({ id: 1, seq: 1, displayDiff: "-1 zero\n+1 one" }),
      makePatch({ id: 2, seq: 2, displayDiff: "-2 two\n+2 three", createdAt: Date.UTC(2026, 0, 1, 14, 2, 31) })
    ]
  });

  const next = update(state, { kind: "key", key: "n" });
  assert.equal(next.state.patchIdx, 1);
  const clamped = update(next.state, { kind: "key", key: "n" });
  assert.equal(clamped.state.patchIdx, 1);

  const frame = stripAnsi(renderFrame(next.state, 80, 8).join("\n"));
  assert.match(frame, /patch 2\/2 · edit · 14:02:31/);
  assert.match(frame, /\+2 three/);
});

test("session patch navigation crosses file boundaries in chronological order", () => {
  const files = [
    makeFile(1, "first.txt", "zero\n", "one\n"),
    makeFile(2, "second.txt", "alpha\n", "beta\n")
  ];
  const patches = [
    makePatch({ id: 1, fileId: 1, seq: 1, displayDiff: "-1 zero\n+1 one" }),
    makePatch({ id: 2, fileId: 2, seq: 2, displayDiff: "-1 alpha\n+1 beta" }),
    makePatch({ id: 3, fileId: 1, seq: 3, displayDiff: "-1 one\n+1 final" })
  ];
  let state = fixtureState({ files, patches, view: "history", selectedFile: 0, patchIdx: 0 });

  state = update(state, { kind: "key", key: "n" }).state;
  assert.equal(state.selectedFile, 1);
  assert.equal(state.patchIdx, 0);
  assert.equal(state.followLatestPatch, false);

  state = update(state, { kind: "key", key: "n" }).state;
  assert.equal(state.selectedFile, 0);
  assert.equal(state.patchIdx, 1);
  assert.match(stripAnsi(renderFrame(state, 100, 8).join("\n")), /patch 3\/3/);

  const boundary = update(state, { kind: "key", key: "n" }).state;
  assert.equal(boundary.selectedFile, 0);
  assert.equal(boundary.patchIdx, 1);

  state = update(state, { kind: "key", key: "p" }).state;
  assert.equal(state.selectedFile, 1);
  assert.equal(state.patchIdx, 0);
});

test("follow latest advances on refresh and manual navigation disengages it", () => {
  const files = [
    makeFile(1, "first.txt", "zero\n", "one\n"),
    makeFile(2, "second.txt", "alpha\n", "beta\n")
  ];
  const patches = [
    makePatch({ id: 1, fileId: 1, seq: 1 }),
    makePatch({ id: 2, fileId: 2, seq: 2 })
  ];
  let state = fixtureState({ files, patches });

  state = update(state, { kind: "key", key: "f" }).state;
  assert.equal(state.view, "history");
  assert.equal(state.selectedFile, 1);
  assert.equal(state.followLatestPatch, true);
  assert.match(stripAnsi(renderFrame(state, 100, 8).join("\n")), /patch 2\/2 · following/);

  const refreshed = update(state, {
    kind: "dbChanged",
    snapshot: {
      files,
      patches: [
        ...patches,
        makePatch({
          id: 3,
          fileId: 1,
          seq: 3,
          displayDiff: Array.from({ length: 30 }, (_, index) => `+${index + 1} line ${index + 1}`).join("\n")
        })
      ],
      annotations: []
    }
  }).state;
  assert.equal(refreshed.selectedFile, 0);
  assert.equal(refreshed.patchIdx, 1);
  assert.equal(refreshed.followLatestPatch, true);
  assert.match(stripAnsi(renderFrame(refreshed, 100, 8).join("\n")), /patch 3\/3 · following/);

  const compact = update(refreshed, { kind: "resize", cols: 80, rows: 4 }).state;
  const positioned = { ...compact, cursorRow: 1 as DiffRow, scrollTop: { ...compact.scrollTop, diff: 1 } };
  const annotationRefresh = update(positioned, {
    kind: "dbChanged",
    snapshot: {
      files,
      patches: refreshed.patches,
      annotations: [makeAnnotation()]
    }
  }).state;
  assert.equal(Number(annotationRefresh.cursorRow), 1);
  assert.equal(annotationRefresh.scrollTop.diff, 1);
  assert.equal(annotationRefresh.followLatestPatch, true);

  const previous = update(refreshed, { kind: "key", key: "p" }).state;
  assert.equal(previous.selectedFile, 1);
  assert.equal(previous.followLatestPatch, false);

  const manualFile = update(refreshed, { kind: "key", key: "]" }).state;
  assert.equal(manualFile.selectedFile, 1);
  assert.equal(manualFile.followLatestPatch, false);
});

test("file tree independently tints addition and deletion counts", () => {
  const file = { ...makeFile(), additions: 3, deletions: 2 };
  const tinted = renderFileTree(
    [file],
    0,
    [],
    0,
    1,
    { mode: "uniform", colorDepth: "truecolor", theme: "dark" }
  )[0] ?? "";
  assert.match(tinted, /\x1b\[48;2;20;82;20m\+3\x1b\[49m/);
  assert.match(tinted, /\x1b\[48;2;103;22;31m-2\x1b\[49m/);
  assert.equal(visibleWidth(tinted), visibleWidth(stripAnsi(tinted)));

  const fallback = renderFileTree(
    [file],
    0,
    [],
    0,
    1,
    { mode: "uniform", colorDepth: "ansi256", theme: "dark" }
  )[0] ?? "";
  assert.match(fallback, /\x1b\[48;5;22m\+3\x1b\[49m/);
  assert.match(fallback, /\x1b\[48;5;52m-2\x1b\[49m/);

  const untinted = renderFileTree(
    [file],
    0,
    [],
    0,
    1,
    { mode: "off", colorDepth: "truecolor", theme: "dark" }
  )[0] ?? "";
  assert.doesNotMatch(untinted, /\x1b\[48;/);
});

test("per-commit dataset history renders commit identity and native per-file diffs", () => {
  initTheme("dark");
  const displayDiff = displayDiffFromUnified(
    "--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-zero\n+one\n",
    "modified",
    "example.txt"
  );
  const state = fixtureState({
    view: "history",
    historyEntries: [
      {
        fileId: 1 as FileId,
        commitSha: "a".repeat(40),
        subject: "first commit",
        authoredAt: Date.UTC(2026, 0, 1, 10),
        status: "modified",
        displayDiff
      },
      {
        fileId: 1 as FileId,
        commitSha: "b".repeat(40),
        subject: "second commit",
        authoredAt: Date.UTC(2026, 0, 1, 11),
        status: "modified",
        displayDiff: "-1 one\n+1 two"
      }
    ]
  });
  const next = update(state, { kind: "key", key: "n" }).state;
  assert.equal(next.patchIdx, 1);
  const frame = stripAnsi(renderFrame(next, 90, 8).join("\n"));
  assert.match(frame, /2\/2 · bbbbbbbb · second commit · 11:00:00/);
  assert.match(frame, /\+1 two/);
});

test("h, l, tab, and Enter switch focus between panes", () => {
  let state = fixtureState({ focusedPane: "diff" });

  state = update(state, { kind: "key", key: "h" }).state;
  assert.equal(state.focusedPane, "tree");

  state = update(state, { kind: "key", key: "l" }).state;
  assert.equal(state.focusedPane, "diff");

  state = update(state, { kind: "key", key: "tab" }).state;
  assert.equal(state.focusedPane, "tree");

  state = update(state, { kind: "key", key: "Enter" }).state;
  assert.equal(state.focusedPane, "diff");
});

test("gg and G move to top and bottom with a pending-key indicator", () => {
  let state = fixtureState({ cursorRow: 2 as DiffRow });

  state = update(state, { kind: "key", key: "g" }).state;
  assert.equal(state.pendingKey, "g");
  assert.match(renderFrame(state, 90, 8).join("\n"), /pending g/);

  state = update(state, { kind: "key", key: "g" }).state;
  assert.equal(state.pendingKey, null);
  assert.equal(Number(state.cursorRow), 0);

  state = update(state, { kind: "key", key: "G" }).state;
  assert.equal(Number(state.cursorRow), buildDiffModel("zero\ntwo\n", "one\ntwo\n").rows.length - 1);
});

test("tick expires the pending gg key without moving the cursor", () => {
  let state = update(fixtureState({ cursorRow: 2 as DiffRow }), { kind: "key", key: "g" }).state;
  state = update(state, { kind: "tick" }).state;

  assert.equal(state.pendingKey, null);
  assert.equal(state.statusMessage, null);
  assert.equal(Number(state.cursorRow), 2);
});

test("ctrl+d and ctrl+u move by half of the current viewport body", () => {
  const baseline = Array.from({ length: 40 }, (_, index) => `old ${index}`).join("\n") + "\n";
  const current = Array.from({ length: 40 }, (_, index) => `new ${index}`).join("\n") + "\n";
  let state = fixtureState({
    files: [makeFile(1, "long.txt", baseline, current)],
    cursorRow: 0 as DiffRow
  });

  state = update(state, { kind: "resize", cols: 100, rows: 12 }).state;
  assert.equal(state.viewport.bodyRows, 9);

  state = update(state, { kind: "key", key: "ctrl+d" }).state;
  assert.equal(Number(state.cursorRow), 4);

  state = update(state, { kind: "resize", cols: 100, rows: 6 }).state;
  assert.equal(state.viewport.bodyRows, 3);

  state = update(state, { kind: "key", key: "ctrl+u" }).state;
  assert.equal(Number(state.cursorRow), 3);
});

test("resize updates viewport state and clamps scroll offsets", () => {
  const files = Array.from({ length: 12 }, (_, index) => makeFile(index + 1, `file-${index + 1}.txt`, "old\n", "new\n"));
  const state = fixtureState({
    files,
    scrollTop: { tree: 20, diff: 20 }
  });

  const resized = update(state, { kind: "resize", cols: 40, rows: 4 }).state;

  assert.deepEqual(resized.viewport, viewportFromSize(40, 4));
  assert.equal(resized.scrollTop.tree, 11);
  assert.equal(
    resized.scrollTop.diff,
    Math.max(0, currentDiffVisualMap(resized).visualRowCount - resized.viewport.bodyRows)
  );
});

test("renderFrame always matches the requested terminal dimensions", () => {
  const states = [
    fixtureState(),
    fixtureState({ mode: { kind: "overlay", which: "help" } }),
    update(fixtureState(), { kind: "key", key: "c" }).state
  ];

  for (const state of states) {
    for (const width of [1, 2, 20, 80]) {
      for (const height of [1, 2, 3, 8]) {
        const frame = renderFrame(state, width, height);
        assert.equal(frame.length, height, `height ${height}, width ${width}`);
        assert.deepEqual(
          frame.map((line) => visibleWidth(line)),
          Array.from({ length: height }, () => width),
          `line widths for height ${height}, width ${width}`
        );
      }
    }
  }
});

test("dbChanged replaces DB-backed state while preserving UI choices", () => {
  const previous = fixtureState({
    selectedFile: 3,
    annotationCursor: 3,
    focusedPane: "diff",
    renderMode: "native",
    tintMode: "uniform",
    mode: {
      kind: "comment",
      target: { kind: "new", draft: draftForCursor(fixtureState())! },
      initialText: "draft",
      role: { kind: "finding", priority: "P2", audience: "agent" }
    },
    statusMessage: "keep me"
  });
  const replacementFile = makeFile(2, "replacement.ts", "old\n", "new\n");
  const replacementAnnotation = makeAnnotation({ id: 2, fileId: replacementFile.row.id, comment: "Replacement" });

  const result = update(previous, {
    kind: "dbChanged",
    snapshot: {
      files: [replacementFile],
      patches: [makePatch({ id: 2 })],
      annotations: [replacementAnnotation]
    }
  });

  assert.deepEqual(result.effects, []);
  assert.equal(result.state.files[0]?.row.relPath, "replacement.ts");
  assert.equal(result.state.annotations[0]?.comment, "Replacement");
  assert.equal(result.state.selectedFile, 0);
  assert.equal(result.state.annotationCursor, 0);
  assert.equal(result.state.focusedPane, "diff");
  assert.equal(result.state.renderMode, "native");
  assert.equal(result.state.tintMode, "uniform");
  assert.equal(result.state.mode.kind, "normal");
  assert.equal(result.state.statusMessage, "keep me");
});

test("fileChanged refreshes one tracked file from parsed disk content", () => {
  const state = fixtureState({
    files: [
      makeFile(1, "first.txt", "zero\n", "one\n"),
      makeFile(2, "second.txt", "alpha\n", "beta\n")
    ],
    mode: {
      kind: "comment",
      target: { kind: "new", draft: draftForCursor(fixtureState())! },
      initialText: "draft",
      role: { kind: "finding", priority: "P2", audience: "agent" }
    }
  });

  const result = update(state, { kind: "fileChanged", path: "/tmp/second.txt", content: "beta\ngamma\n" });

  assert.deepEqual(result.effects, []);
  assert.equal(result.state.files[0]?.current, "one\n");
  assert.equal(result.state.files[1]?.current, "beta\ngamma\n");
  assert.equal(result.state.files[1]?.currentHash, contentHashForCurrent("beta\ngamma\n"));
  assert.equal(result.state.files[1]?.additions, 2);
  assert.equal(result.state.files[1]?.deletions, 1);
  assert.equal(result.state.mode.kind, "normal");
});

test("fileChanged ignores paths that are not tracked", () => {
  const state = fixtureState();
  const result = update(state, { kind: "fileChanged", path: "/tmp/other.txt", content: "ignored\n" });

  assert.equal(result.state, state);
  assert.deepEqual(result.effects, []);
});

test("status bar shows annotation state counts", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const state = fixtureState({
    annotations: [
      makeAnnotation({ id: 1, sessionId, state: { kind: "draft" } }),
      makeAnnotation({ id: 2, sessionId, state: { kind: "draft" } }),
      makeAnnotation({ id: 3, sessionId, state: { kind: "queued" } }),
      makeAnnotation({ id: 4, sessionId, state: { kind: "sent", sentAt: 2, batchId: unwrap(checkedBatchId("batch")) } })
    ]
  });

  assert.match(renderFrame(state, 120, 8).join("\n"), /2 drafts \| 1 queued \| 1 sent/);
});

test("file tree marks annotated and missing tracked files", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const missing = makeFile(1, "src/missing.ts", "old\n", "");
  missing.current = null;
  const state = fixtureState({
    files: [missing],
    annotations: [makeAnnotation({ id: 1, sessionId, fileId: 1 as FileId })]
  });

  const frame = stripAnsi(renderFrame(state, 100, 8).join("\n"));
  assert.match(frame, /▸ src\//);
  assert.match(frame, /> ●∅ missing\.ts \+1 -1/);
});

test("ctrl+e and ctrl+y scroll the focused pane by one row", () => {
  const files = Array.from({ length: 12 }, (_, index) => makeFile(index + 1, `file-${index + 1}.txt`, "old\n", "new\n"));
  let state = update(fixtureState({ files, focusedPane: "tree" }), { kind: "resize", cols: 80, rows: 6 }).state;

  state = update(state, { kind: "key", key: "ctrl+e" }).state;
  assert.equal(state.scrollTop.tree, 1);

  state = update(state, { kind: "key", key: "ctrl+y" }).state;
  assert.equal(state.scrollTop.tree, 0);
});

test("{ and } navigate between cumulative diff hunks", () => {
  const baseline = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n";
  const current = "A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\nk\nl\n";
  const hunkRows = buildDiffModel(baseline, current, "example.txt").rows
    .map((row, index) => (row.kind === "hunk" ? index : null))
    .filter((index): index is number => index !== null);
  let state = fixtureState({
    files: [makeFile(1, "example.txt", baseline, current)],
    patches: [],
    cursorRow: hunkRows[0] as DiffRow
  });

  state = update(state, { kind: "key", key: "}" }).state;
  assert.equal(Number(state.cursorRow), hunkRows[1]);

  state = update(state, { kind: "key", key: "{" }).state;
  assert.equal(Number(state.cursorRow), hunkRows[0]);
});

test("t cycles syntax tint mode", () => {
  const uniform = update(fixtureState(), { kind: "key", key: "t" });
  assert.equal(uniform.state.tintMode, "uniform");
  const off = update(uniform.state, { kind: "key", key: "t" });
  assert.equal(off.state.tintMode, "off");
  const gradient = update(off.state, { kind: "key", key: "t" });
  assert.equal(gradient.state.tintMode, "gradient");
});

test("long syntax lines wrap by words and w toggles clipping without changing logical rows", () => {
  initTheme("dark");
  const longLine = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu final phrase";
  let state = fixtureState({
    files: [makeFile(1, "long.ts", "before\n", `${longLine}\n`)],
    patches: [],
    tintMode: "off"
  });
  state = update(state, { kind: "resize", cols: 60, rows: 14 }).state;

  const wrappedMap = currentDiffVisualMap(state);
  assert.ok(wrappedMap.visualRowCount > wrappedMap.logicalRowCount);
  const wrappedFrame = stripAnsi(renderFrame(state, 60, 14).join("\n"));
  assert.match(wrappedFrame, /↳/);
  assert.match(wrappedFrame, /final phrase/);
  assert.match(wrappedFrame, /· wrap/);

  state = update(state, { kind: "key", key: "w" }).state;
  assert.equal(state.wrapLines, false);
  assert.equal(state.statusMessage, "Line wrap off");
  assert.equal(currentDiffVisualMap(state).visualRowCount, currentDiffVisualMap(state).logicalRowCount);
  const clippedFrame = stripAnsi(renderFrame(state, 60, 14).join("\n"));
  assert.doesNotMatch(clippedFrame, /↳/);
  assert.doesNotMatch(clippedFrame, /final phrase/);
  assert.match(clippedFrame, /· nowrap/);
});

test("mouse continuation clicks select the logical line and wheel scrolls within wrapped content", () => {
  const longLine = Array.from({ length: 30 }, (_, index) => `word-${index}`).join(" ");
  let state = fixtureState({
    files: [makeFile(1, "long.txt", "before\n", `${longLine}\n`)],
    patches: [],
    cursorRow: 0 as DiffRow,
    tintMode: "off"
  });
  state = update(state, { kind: "resize", cols: 60, rows: 7 }).state;
  const layout = computeFrameLayout(60, 7);
  const model = buildDiffModel("before\n", `${longLine}\n`, "long.txt");
  const addedRow = model.rows.findIndex((row) => row.kind === "add");
  const map = currentDiffVisualMap(state);
  const addedVisualStart = map.starts[addedRow] ?? 0;
  assert.ok((map.starts[addedRow + 1] ?? 0) - addedVisualStart > 1);

  state = {
    ...state,
    scrollTop: { ...state.scrollTop, diff: addedVisualStart }
  };
  state = update(state, {
    kind: "mouse",
    mouse: {
      kind: "press",
      button: 0,
      x: layout.treeWidth + 3,
      y: layout.bodyTop + 2
    },
    layout
  }).state;
  assert.equal(Number(state.cursorRow), addedRow);

  state = { ...state, scrollTop: { ...state.scrollTop, diff: 0 } };
  state = update(state, {
    kind: "mouse",
    mouse: { kind: "wheel", direction: "down", x: layout.treeWidth + 3, y: layout.bodyTop + 1 },
    layout
  }).state;
  assert.equal(state.scrollTop.diff, 3);
  assert.equal(state.focusedPane, "diff");
});

test("resize and wrap toggling preserve the logical row at the viewport top", () => {
  const longLine = Array.from({ length: 24 }, (_, index) => `segment-${index}`).join(" ");
  const trailing = Array.from({ length: 5 }, (_, index) => `keep-${index}`).join("\n");
  const baseline = `before\n${trailing}\n`;
  const current = `${longLine}\n${trailing}\n`;
  let state = fixtureState({
    files: [makeFile(1, "long.txt", baseline, current)],
    patches: [],
    tintMode: "off"
  });
  state = update(state, { kind: "resize", cols: 60, rows: 7 }).state;
  const beforeMap = currentDiffVisualMap(state);
  const addedRow = buildDiffModel(baseline, current, "long.txt").rows.findIndex((row) => row.kind === "add");
  state = { ...state, scrollTop: { ...state.scrollTop, diff: (beforeMap.starts[addedRow] ?? 0) + 1 } };
  assert.equal(visualRowRef(beforeMap, state.scrollTop.diff)?.logicalRow, addedRow);

  state = update(state, { kind: "resize", cols: 72, rows: 7 }).state;
  assert.equal(visualRowRef(currentDiffVisualMap(state), state.scrollTop.diff)?.logicalRow, addedRow);

  state = update(state, { kind: "key", key: "w" }).state;
  assert.equal(visualRowRef(currentDiffVisualMap(state), state.scrollTop.diff)?.logicalRow, addedRow);
});

test("native diffs and notes wrap long text instead of truncating it", () => {
  initTheme("dark");
  const longLine = "native alpha beta gamma delta epsilon zeta eta theta iota kappa final-native-tail";
  let nativeState = fixtureState({
    files: [makeFile(1, "long.txt", "before\n", `${longLine}\n`)],
    patches: [],
    renderMode: "native"
  });
  nativeState = update(nativeState, { kind: "resize", cols: 60, rows: 14 }).state;
  const nativeFrame = stripAnsi(renderFrame(nativeState, 60, 14).join("\n"));
  assert.match(nativeFrame, /↳/);
  assert.match(nativeFrame, /final-native-tail/);

  let historyState = fixtureState({
    view: "history",
    historyEntries: [{
      fileId: 1 as FileId,
      commitSha: "c".repeat(40),
      subject: "history subject with enough words to expose final-history-tail",
      authoredAt: Date.UTC(2026, 0, 1, 10),
      status: "modified",
      displayDiff: "-1 before\n+1 after"
    }]
  });
  historyState = update(historyState, { kind: "resize", cols: 60, rows: 14 }).state;
  const historyFrame = stripAnsi(renderFrame(historyState, 60, 14).join("\n"));
  assert.match(historyFrame, /↳/);
  assert.match(historyFrame, /final-history-tail/);

  const notesState = fixtureState({
    activeTab: "notes",
    annotations: [makeAnnotation({ comment: "A long review note with enough words to wrap and expose the final-note-tail" })]
  });
  const notesFrame = stripAnsi(renderFrame(notesState, 60, 12).join("\n"));
  assert.match(notesFrame, /final-note-tail/);
});

test("syntax diff renders tint and external markers", () => {
  const current = "intro\none\nTWO\n";
  const patch = makePatch({
    id: 2,
    unifiedPatch: [
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -1,2 +1,3 @@",
      "+intro",
      " one",
      " two",
      ""
    ].join("\n"),
    preHash: hashContent("one\ntwo\n"),
    postHash: hashContent("intro\none\ntwo\n")
  });
  const state = fixtureState({
    files: [makeFile(1, "example.txt", "one\ntwo\n", current)],
    patches: [patch],
    cursorRow: 0 as DiffRow
  });

  const frame = renderFrame(state, 100, 10).join("\n");
  assert.match(frame, /\x1b\[48;(?:2|5);/);
  assert.match(stripAnsi(frame), /~ \+\s+3 │ TWO/);
});

test("syntax diff falls back to uniform most-recent tint on patch chain breaks", () => {
  const state = fixtureState({
    files: [makeFile(1, "example.txt", "zero\ntwo\n", "one\ntwo\n")],
    patches: [
      makePatch({
        id: 2,
        seq: 2,
        unifiedPatch: [
          "--- a/example.txt",
          "+++ b/example.txt",
          "@@ -1,2 +1,2 @@",
          "-zero",
          "+one",
          " two",
          ""
        ].join("\n"),
        preHash: hashContent("not the baseline\n"),
        postHash: hashContent("one\ntwo\n")
      })
    ]
  });

  const frame = renderFrame(state, 100, 8).join("\n");
  assert.match(frame, /\x1b\[48;(?:2|5);/);
  assert.doesNotMatch(stripAnsi(frame), /~ \+\s+1 │ one/);
  assert.match(stripAnsi(frame), /\+ +1 │ one/);
});

test("syntax header shows the recency tint legend", () => {
  const tinted = stripAnsi(renderFrame(fixtureState(), 100, 8).join("\n"));
  assert.match(tinted, /example\.txt · cumulative · syntax · tint:gradient old ░▒▓█ new/);

  const untinted = stripAnsi(renderFrame(fixtureState({ tintMode: "off" }), 100, 8).join("\n"));
  assert.doesNotMatch(untinted, /old ░▒▓█ new/);
});

test("syntax tint renders different dark and light theme palettes", () => {
  const previousColorTerm = process.env.COLORTERM;
  process.env.COLORTERM = "truecolor";
  const patch = makePatch({
    unifiedPatch: [
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -1,2 +1,2 @@",
      "-zero",
      "+one",
      " two",
      ""
    ].join("\n"),
    preHash: hashContent("zero\ntwo\n"),
    postHash: hashContent("one\ntwo\n")
  });
  try {
    const dark = renderFrame(fixtureState({ patches: [patch], tintTheme: "dark" }), 100, 8).join("\n");
    const light = renderFrame(fixtureState({ patches: [patch], tintTheme: "light" }), 100, 8).join("\n");

    assert.match(dark, /\x1b\[48;2;20;82;20m/);
    assert.match(light, /\x1b\[48;2;125;220;125m/);
  } finally {
    if (previousColorTerm === undefined) {
      delete process.env.COLORTERM;
    } else {
      process.env.COLORTERM = previousColorTerm;
    }
  }
});

test("syntax diff uses pi highlightCode for current and baseline lines", () => {
  initTheme("dark");
  const state = fixtureState({
    files: [makeFile(1, "example.ts", "const oldValue = 1;\n", "const newValue = 2;\n")],
    patches: [
      makePatch({
        id: 2,
        unifiedPatch: [
          "--- a/example.ts",
          "+++ b/example.ts",
          "@@ -1 +1 @@",
          "-const oldValue = 1;",
          "+const newValue = 2;",
          ""
        ].join("\n"),
        preHash: hashContent("const oldValue = 1;\n"),
        postHash: hashContent("const newValue = 2;\n")
      })
    ],
    cursorRow: 0 as DiffRow,
    tintMode: "off"
  });

  const frame = renderFrame(state, 100, 8).join("\n");
  assert.match(frame, /\x1b\[38;(?:2|5);/);
  assert.match(stripAnsi(frame), /const newValue = 2;/);
});

test("annotation overlay labels stale annotations", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const state = fixtureState({
    mode: { kind: "overlay", which: "annotations" },
    annotations: [makeAnnotation({ sessionId, hash: hashContent("old\n"), comment: "Needs update" })]
  });

  const frame = renderFrame(state, 120, 8).join("\n");
  assert.match(frame, /○ draft ⚠ stale · anchored @ baseline, file now @ patch 1 Needs update/);
  assert.match(frame, /snippet: one/);
});

test("annotation overlay windows long lists around the selected annotation", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const annotations = Array.from({ length: 8 }, (_, index) =>
    makeAnnotation({ id: index + 1, sessionId, comment: `Comment ${index + 1}` })
  );
  const state = fixtureState({
    mode: { kind: "overlay", which: "annotations" },
    annotations,
    annotationCursor: 7
  });

  const frame = stripAnsi(renderFrame(state, 120, 8).join("\n"));
  assert.doesNotMatch(frame, /#1 file/);
  assert.match(frame, /> #8 P2 agent file .* Comment 8/);
});

test("help overlay documents navigation, annotations, rendering, and refresh keys", () => {
  const state = fixtureState({ mode: { kind: "overlay", which: "help" } });
  const frame = stripAnsi(renderFrame(state, 120, 12).join("\n"));
  assert.match(frame, /ctrl\+d\/ctrl\+u half-page/);
  assert.match(frame, /Annotations: j\/k select, Enter jump, e edit, u re-anchor, x delete/);
  assert.match(frame, /H history\s+n\/p previous\/next patch\s+f follow latest patch/);
  assert.match(frame, /d native\/syntax\s+w wrap\s+t tint\s+r refresh/);
  assert.match(frame, /I guidelines\s+\? help\s+q quit/);
});

test("diff pane marks stale annotation ranges with a warning marker", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const state = fixtureState({
    annotations: [makeAnnotation({ sessionId, hash: hashContent("old\n"), comment: "Needs update" })],
    tintMode: "off"
  });

  assert.match(stripAnsi(renderFrame(state, 100, 8).join("\n")), /⚠ \+\s+1 │ one/);
});

test("annotation overlay navigates and edits the selected annotation", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  let state = fixtureState({
    mode: { kind: "overlay", which: "annotations" },
    annotations: [
      makeAnnotation({ id: 1, sessionId, comment: "First" }),
      makeAnnotation({ id: 2, sessionId, comment: "Second" })
    ]
  });

  let result = update(state, { kind: "key", key: "j" });
  state = result.state;
  assert.equal(state.annotationCursor, 1);

  result = update(state, { kind: "key", key: "e" });
  state = result.state;
  assert.equal(state.mode.kind, "comment");
  assert.equal(state.mode.kind === "comment" ? state.mode.initialText : "", "Second");

  result = update(state, { kind: "commentSubmitted", text: "Second!" });
  assert.equal(result.effects[0]?.kind, "updateAnnotation");
  if (result.effects[0]?.kind === "updateAnnotation") {
    assert.equal(result.effects[0].annotationId, 2);
    assert.equal(result.effects[0].comment, "Second!");
  }
});

test("annotation overlay deletes only unsent annotations", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const draft = update(
    fixtureState({
      mode: { kind: "overlay", which: "annotations" },
      annotations: [makeAnnotation({ id: 1, sessionId, comment: "Draft" })]
    }),
    { kind: "key", key: "x" }
  );
  assert.deepEqual(draft.effects, [{ kind: "deleteAnnotation", annotationId: 1 as AnnotationId }]);

  const sent = update(
    fixtureState({
      mode: { kind: "overlay", which: "annotations" },
      annotations: [makeAnnotation({ id: 2, sessionId, comment: "Sent", state: { kind: "sent", sentAt: 2, batchId: unwrap(checkedBatchId("batch")) } })]
    }),
    { kind: "key", key: "x" }
  );
  assert.deepEqual(sent.effects, []);
  assert.equal(sent.state.statusMessage, "Sent annotations cannot be deleted");
});

test("enter on a fresh annotation jumps to its current diff row", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const secondFile = makeFile(2, "second.txt", "alpha\nold\nomega\n", "alpha\nbeta\nomega\n");
  const state = fixtureState({
    selectedFile: 0,
    mode: { kind: "overlay", which: "annotations" },
    files: [makeFile(), secondFile],
    annotations: [
      makeAnnotation({
        id: 1,
        sessionId,
        fileId: 2 as FileId,
        hash: contentHashForCurrent("alpha\nbeta\nomega\n"),
        start: 2,
        end: 2,
        comment: "Second file"
      })
    ]
  });

  const result = update(state, { kind: "key", key: "Enter" });
  assert.equal(result.state.mode.kind, "normal");
  assert.equal(result.state.selectedFile, 1);
  assert.equal(result.state.focusedPane, "diff");
  assert.equal(Number(result.state.cursorRow), 3);
  assert.equal(result.state.statusMessage, "Jumped to annotation #1");
});

test("enter on a stale annotation jumps to a best-guess mapped row", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const baseline = "one\ntwo\n";
  const current = "intro\none\ntwo\n";
  const expectedRow = buildDiffModel(baseline, current, "example.txt").rows.findIndex(
    (row) => "newLine" in row && Number(row.newLine) === 3
  );
  const state = fixtureState({
    files: [makeFile(1, "example.txt", baseline, current)],
    patches: [],
    mode: { kind: "overlay", which: "annotations" },
    annotations: [
      makeAnnotation({
        id: 1,
        sessionId,
        hash: hashContent(baseline),
        start: 2,
        end: 2,
        snippet: "two",
        comment: "Moved"
      })
    ]
  });

  const result = update(state, { kind: "key", key: "Enter" });
  assert.equal(result.state.mode.kind, "normal");
  assert.equal(result.state.focusedPane, "diff");
  assert.equal(Number(result.state.cursorRow), expectedRow);
  assert.equal(result.state.statusMessage, "Jumped to stale annotation #1 best-guess location");
});

test("u re-anchors a stale draft annotation to the current selection", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const state = fixtureState({
    mode: { kind: "overlay", which: "annotations" },
    selection: { anchor: 2 as DiffRow, head: 3 as DiffRow },
    annotations: [
      makeAnnotation({
        id: 1,
        sessionId,
        hash: hashContent("old\n"),
        comment: "Move me"
      })
    ]
  });

  const result = update(state, { kind: "key", key: "u" });
  assert.equal(result.effects[0]?.kind, "reanchorAnnotation");
  if (result.effects[0]?.kind === "reanchorAnnotation") {
    assert.equal(result.effects[0].annotationId, 1);
    assert.equal(result.effects[0].anchor.hash, contentHashForCurrent("one\ntwo\n"));
    assert.equal(Number(result.effects[0].anchor.start), 1);
    assert.equal(Number(result.effects[0].anchor.end), 2);
    assert.equal(result.effects[0].snippet, "one\ntwo");
  }
  assert.equal(result.state.statusMessage, "Re-anchoring annotation #1");
});

test("u automatically maps a stale draft annotation through later non-overlapping patches", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const current = "intro\none\ntwo\n";
  const file = makeFile(1, "example.txt", "one\ntwo\n", current);
  const patch = makePatch({
    id: 2,
    unifiedPatch: [
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -1,2 +1,3 @@",
      "+intro",
      " one",
      " two",
      ""
    ].join("\n"),
    preHash: hashContent("one\ntwo\n"),
    postHash: hashContent(current)
  });
  const state = fixtureState({
    files: [file],
    patches: [patch],
    mode: { kind: "overlay", which: "annotations" },
    annotations: [
      makeAnnotation({
        id: 1,
        sessionId,
        hash: hashContent("one\ntwo\n"),
        start: 2,
        end: 2,
        comment: "Move me"
      })
    ]
  });

  const result = update(state, { kind: "key", key: "u" });
  assert.equal(result.effects[0]?.kind, "reanchorAnnotation");
  if (result.effects[0]?.kind === "reanchorAnnotation") {
    assert.equal(Number(result.effects[0].anchor.start), 3);
    assert.equal(Number(result.effects[0].anchor.end), 3);
    assert.equal(result.effects[0].snippet, "two");
  }
});

test("u automatically maps a stale draft annotation through clean external edits", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const current = "intro\none\ntwo\n";
  const state = fixtureState({
    files: [makeFile(1, "example.txt", "one\ntwo\n", current)],
    patches: [],
    mode: { kind: "overlay", which: "annotations" },
    annotations: [
      makeAnnotation({
        id: 1,
        sessionId,
        hash: hashContent("one\ntwo\n"),
        start: 2,
        end: 2,
        comment: "External shift"
      })
    ]
  });

  const result = update(state, { kind: "key", key: "u" });
  assert.equal(result.effects[0]?.kind, "reanchorAnnotation");
  if (result.effects[0]?.kind === "reanchorAnnotation") {
    assert.equal(Number(result.effects[0].anchor.start), 3);
    assert.equal(Number(result.effects[0].anchor.end), 3);
    assert.equal(result.effects[0].snippet, "two");
  }
});

test("u refuses automatic re-anchor when external edits touch the annotated line", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const state = fixtureState({
    files: [makeFile(1, "example.txt", "one\ntwo\n", "one\nTWO\n")],
    patches: [],
    mode: { kind: "overlay", which: "annotations" },
    annotations: [
      makeAnnotation({
        id: 1,
        sessionId,
        hash: hashContent("one\ntwo\n"),
        start: 2,
        end: 2,
        snippet: "two",
        comment: "External conflict"
      })
    ]
  });

  const result = update(state, { kind: "key", key: "u" });
  assert.deepEqual(result.effects, []);
  assert.equal(result.state.mode.kind, "comment");
  assert.equal(result.state.statusMessage, "External edits changed the annotated lines; adjust re-anchor and save");
  if (result.state.mode.kind === "comment") {
    assert.equal(result.state.mode.target.kind, "reanchor");
    if (result.state.mode.target.kind === "reanchor") {
      assert.equal(result.state.mode.target.annotationId, 1);
      assert.equal(result.state.mode.target.oldSnippet, "two");
      assert.equal(result.state.mode.target.draft.snippet, "TWO");
      assert.equal(Number(result.state.mode.target.draft.anchor.start), 2);
      assert.equal(Number(result.state.mode.target.draft.anchor.end), 2);
    }
    assert.equal(result.state.mode.initialText, "External conflict");
  }
});

test("u refuses fresh or sent annotations instead of emitting reanchor effects", () => {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const fresh = update(
    fixtureState({
      mode: { kind: "overlay", which: "annotations" },
      annotations: [makeAnnotation({ id: 1, sessionId, hash: contentHashForCurrent("one\ntwo\n") })]
    }),
    { kind: "key", key: "u" }
  );
  assert.deepEqual(fresh.effects, []);
  assert.equal(fresh.state.statusMessage, "Annotation is already fresh");

  const sent = update(
    fixtureState({
      mode: { kind: "overlay", which: "annotations" },
      annotations: [
        makeAnnotation({
          id: 2,
          sessionId,
          hash: hashContent("old\n"),
          state: { kind: "sent", sentAt: 2, batchId: unwrap(checkedBatchId("batch")) }
        })
      ]
    }),
    { kind: "key", key: "u" }
  );
  assert.deepEqual(sent.effects, []);
  assert.equal(sent.state.statusMessage, "Sent annotations cannot be re-anchored");
});

test("mouse press selects files and drag extends a visual diff selection", () => {
  const layout = computeFrameLayout(80, 8);
  const secondFile = makeFile(2, "second.txt", "alpha\nold\nomega\n", "alpha\nbeta\nomega\n");
  let state = fixtureState({ files: [makeFile(), secondFile], focusedPane: "tree" });

  let result = update(state, { kind: "mouse", mouse: { kind: "press", button: 0, x: 3, y: 4 }, layout });
  state = result.state;
  assert.equal(state.selectedFile, 1);
  assert.equal(state.focusedPane, "tree");

  result = update(state, { kind: "mouse", mouse: { kind: "press", button: 0, x: layout.treeWidth + 2, y: 5 }, layout });
  state = result.state;
  assert.equal(state.focusedPane, "diff");
  assert.equal(state.mode.kind, "normal");
  assert.equal(Number(state.cursorRow), 2);

  result = update(state, { kind: "mouse", mouse: { kind: "move", button: 0, x: layout.treeWidth + 2, y: 6 }, layout });
  state = result.state;
  assert.equal(state.mode.kind, "visual");
  assert.deepEqual(state.selection && { anchor: Number(state.selection.anchor), head: Number(state.selection.head) }, { anchor: 2, head: 3 });
});

test("mouse release finalizes an active drag at the release row", () => {
  const layout = computeFrameLayout(80, 8);
  let state = fixtureState();

  state = update(state, {
    kind: "mouse",
    mouse: { kind: "press", button: 0, x: layout.treeWidth + 2, y: 3 },
    layout
  }).state;
  state = update(state, {
    kind: "mouse",
    mouse: { kind: "move", button: 0, x: layout.treeWidth + 2, y: 4 },
    layout
  }).state;
  state = update(state, {
    kind: "mouse",
    mouse: { kind: "release", button: 0, x: layout.treeWidth + 2, y: 6 },
    layout
  }).state;

  assert.equal(state.mode.kind, "visual");
  assert.equal(Number(state.selection?.head), 3);
});

test("mouse press on a directory header focuses the tree without selecting a file", () => {
  const layout = computeFrameLayout(80, 8);
  const state = fixtureState({
    files: [makeFile(1, "src/first.ts", "old\n", "new\n"), makeFile(2, "src/second.ts", "old\n", "new\n")],
    selectedFile: 1,
    focusedPane: "diff"
  });

  const result = update(state, { kind: "mouse", mouse: { kind: "press", button: 0, x: 3, y: 3 }, layout });
  assert.equal(result.state.selectedFile, 1);
  assert.equal(result.state.focusedPane, "tree");
});

test("mouse wheel scrolls the pane under the pointer", () => {
  const layout = computeFrameLayout(80, 8);
  const files = Array.from({ length: 12 }, (_, index) => makeFile(index + 1, `file-${index + 1}.txt`, "old\n", "new\n"));
  const result = update(fixtureState({ files }), {
    kind: "mouse",
    mouse: { kind: "wheel", direction: "down", x: 2, y: 4 },
    layout
  });
  assert.equal(result.state.scrollTop.tree, 3);
  assert.equal(result.state.focusedPane, "tree");
});

test("mouse file clicks use the scrolled tree row rather than viewport row", () => {
  const layout = computeFrameLayout(100, 10);
  const files = Array.from({ length: 14 }, (_, index) => makeFile(index + 1, `file-${index + 1}.txt`, "old\n", "new\n"));
  const state = fixtureState({ files, selectedFile: 0, scrollTop: { tree: 5, diff: 0 } });

  const clicked = update(state, {
    kind: "mouse",
    mouse: { kind: "press", button: 0, x: 3, y: 5 },
    layout
  }).state;

  assert.equal(clicked.selectedFile, 7);
  assert.equal(clicked.files[clicked.selectedFile].row.relPath, "file-8.txt");
  assert.equal(clicked.focusedPane, "tree");
});

test("mouse line clicks use the scrolled diff row and ignore blank body rows", () => {
  const layout = computeFrameLayout(100, 12);
  const baseline = Array.from({ length: 20 }, (_, index) => `old-${index}`).join("\n") + "\n";
  const current = Array.from({ length: 20 }, (_, index) => `new-${index}`).join("\n") + "\n";
  let state = fixtureState({
    files: [makeFile(1, "long.txt", baseline, current)],
    scrollTop: { tree: 0, diff: 6 },
    cursorRow: 0 as DiffRow
  });

  state = update(state, {
    kind: "mouse",
    mouse: { kind: "press", button: 0, x: layout.treeWidth + 3, y: 6 },
    layout
  }).state;
  assert.equal(Number(state.cursorRow), 9);
  assert.equal(state.focusedPane, "diff");

  const shortState = fixtureState({ cursorRow: 1 as DiffRow, selection: { anchor: 1 as DiffRow, head: 2 as DiffRow } });
  const blankClicked = update(shortState, {
    kind: "mouse",
    mouse: { kind: "press", button: 0, x: layout.treeWidth + 3, y: layout.statusRow },
    layout
  }).state;
  assert.equal(Number(blankClicked.cursorRow), 1);
  assert.equal(blankClicked.selection, null);
  assert.equal(blankClicked.focusedPane, "diff");
});

test("mouse wheel scrolling remains pane-local and clamps after resize", () => {
  const layout = computeFrameLayout(62, 7);
  const baseline = Array.from({ length: 30 }, (_, index) => `old-${index}`).join("\n") + "\n";
  const current = Array.from({ length: 30 }, (_, index) => `new-${index}`).join("\n") + "\n";
  const files = Array.from({ length: 12 }, (_, index) => makeFile(index + 1, `file-${index + 1}.txt`, baseline, current));
  let state = fixtureState({ files, scrollTop: { tree: 2, diff: 4 } });

  state = update(state, {
    kind: "mouse",
    mouse: { kind: "wheel", direction: "down", x: layout.treeWidth + 2, y: 3 },
    layout
  }).state;
  assert.equal(state.scrollTop.tree, 2);
  assert.equal(state.scrollTop.diff, 7);
  assert.equal(state.focusedPane, "diff");

  state = update(state, {
    kind: "mouse",
    mouse: { kind: "wheel", direction: "up", x: 2, y: 3 },
    layout
  }).state;
  assert.equal(state.scrollTop.tree, 0);
  assert.equal(state.scrollTop.diff, 7);
  assert.equal(state.focusedPane, "tree");
});

test("number keys and header clicks switch stable full-width tabs", () => {
  const layout = computeFrameLayout(100, 10);
  let state = fixtureState();
  state = update(state, { kind: "key", key: "3" }).state;
  assert.equal(state.activeTab, "narrative");

  state = update(state, {
    kind: "mouse",
    mouse: { kind: "press", button: 0, x: 30, y: 1 },
    layout
  }).state;
  assert.equal(state.activeTab, "review");

  state = update(state, {
    kind: "mouse",
    mouse: { kind: "press", button: 0, x: 10, y: 1 },
    layout
  }).state;
  assert.equal(state.activeTab, "notes");

  state = update(state, {
    kind: "mouse",
    mouse: { kind: "press", button: 0, x: 3, y: 2 },
    layout
  }).state;
  assert.equal(state.activeTab, "notes");
});

test("analysis running is an explicit cancellable reducer mode with bounded streamed output", () => {
  let result = update(fixtureState(), { kind: "analysisStarted", mode: "narrative" });
  assert.equal(result.state.activeTab, "narrative");
  assert.equal(result.state.mode.kind, "analysisRunning");

  result = update(result.state, {
    kind: "analysisProgress",
    phase: "chunk",
    completed: 2,
    total: 5,
    message: "chunk 3/5",
    delta: "x".repeat(5000)
  });
  assert.equal(result.state.mode.kind, "analysisRunning");
  if (result.state.mode.kind === "analysisRunning") {
    assert.equal(result.state.mode.outputTail.length, 4000);
  }
  const frame = stripAnsi(renderFrame(result.state, 100, 12).join("\n"));
  assert.match(frame, /Running narrative/);
  assert.match(frame, /chunk 3\/5/);

  const cancelled = update(result.state, { kind: "key", key: "Escape" });
  assert.deepEqual(cancelled.effects, [{ kind: "cancelAnalysis" }]);
  assert.equal(cancelled.state.mode.kind, "analysisRunning");

  const finished = update(cancelled.state, { kind: "analysisFinished", run: makeNarrativeRun("finished-run", 30, "Done") });
  assert.equal(finished.state.mode.kind, "normal");
  assert.equal(finished.state.statusMessage, "Narrative completed");
});

test("review guidelines are visible in a dedicated overlay from every tab", () => {
  let state = fixtureState({
    activeTab: "review",
    reviewGuidelines: { path: "/tmp/REVIEW_GUIDELINES.md", contents: "Check boundaries.\nCheck failure behavior." }
  });
  state = update(state, { kind: "key", key: "I" }).state;
  assert.deepEqual(state.mode, { kind: "overlay", which: "guidelines" });
  const frame = stripAnsi(renderFrame(state, 100, 12).join("\n"));
  assert.match(frame, /REVIEW_GUIDELINES\.md/);
  assert.match(frame, /Check boundaries\./);
});

test("generic Git diffs do not claim session provenance", () => {
  initTheme("dark");
  const sessionState = fixtureState({ patches: [] });
  const sessionFrame = stripAnsi(renderFrame(sessionState, 90, 8).join("\n"));
  assert.match(sessionFrame, /~/);

  const branchState = fixtureState({
    patches: [],
    dataset: {
      source: { kind: "branch", baseRef: "main", headRef: "HEAD" },
      historyMode: "perCommit",
      fingerprint: hashReviewSource({ branch: true }),
      documents: [],
      commits: []
    }
  });
  const branchFrame = stripAnsi(renderFrame(branchState, 90, 8).join("\n"));
  assert.doesNotMatch(branchFrame, /~/);
  assert.doesNotMatch(branchFrame, /tint:/);
});

test("analysis tabs render persisted results, browse runs, and wheel-scroll independently", () => {
  const runs = [makeNarrativeRun("new-run", 20, "Newest summary"), makeNarrativeRun("old-run", 10, "Older summary"), makeReviewRun()];
  const layout = computeFrameLayout(100, 8);
  let state = fixtureState({ activeTab: "narrative", analysisRuns: runs });

  let frame = stripAnsi(renderFrame(state, 100, 8).join("\n"));
  assert.match(frame, /Newest summary/);
  state = update(state, { kind: "key", key: "n" }).state;
  frame = stripAnsi(renderFrame(state, 100, 12).join("\n"));
  assert.match(frame, /Older summary/);

  state = update(state, {
    kind: "mouse",
    mouse: { kind: "wheel", direction: "down", x: 50, y: 5 },
    layout
  }).state;
  assert.equal(state.analysisScroll.narrative, 3);
  assert.equal(state.analysisScroll.review, 0);

  state = update(state, { kind: "key", key: "4" }).state;
  frame = stripAnsi(renderFrame(state, 100, 12).join("\n"));
  assert.match(frame, /Verdict: needs attention/);
  assert.match(frame, /\[P1\] example\.txt:1-1 Issue/);
});

function fixtureState(overrides: Partial<AppState> = {}): AppState {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  const file = makeFile();
  const patch = makePatch();
  return {
    session: {
      id: sessionId,
      cwd: "/tmp",
      sessionFile: null,
      parentSessionId: null,
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null
    },
    dataset: {
      source: { kind: "session", sessionId },
      historyMode: "squashed",
      fingerprint: hashReviewSource({ sessionId, fixture: true }),
      documents: [],
      commits: []
    },
    activeTab: "diff",
    analysisRuns: [],
    selectedAnalysisRun: { narrative: 0, implementationReview: 0 },
    analysisScroll: { notes: 0, narrative: 0, review: 0 },
    reviewGuidelines: null,
    historyEntries: [],
    files: [file],
    patches: [patch],
    annotations: [],
    viewport: viewportFromSize(80, 24),
    selectedFile: 0,
    focusedPane: "diff",
    view: "cumulative",
    renderMode: "syntax",
    wrapLines: true,
    tintMode: "gradient",
    colorDepth: "truecolor",
    tintTheme: "dark",
    patchIdx: 0,
    followLatestPatch: false,
    cursorRow: 2 as DiffRow,
    annotationCursor: 0,
    scrollTop: { tree: 0, diff: 0 },
    pendingKey: null,
    mode: { kind: "normal" },
    selection: null,
    statusMessage: null,
    ...overrides
  };
}

function makeNarrativeRun(id: string, startedAt: number, summary: string) {
  const fingerprint = hashReviewSource({ session: "state-test-session", fixture: true });
  return {
    id: unwrap(checkedAnalysisRunId(id)),
    sourceFingerprint: fingerprint,
    mode: "narrative" as const,
    model: { provider: "fake", modelId: "model", thinkingLevel: "medium" as const },
    promptVersion: "narrative/v1",
    manifest: {
      strategy: "direct" as const,
      stats: { files: 1, commits: 0, bytes: 1, diffRows: 1, estimatedTokens: 1 },
      chunks: [{ id: "direct:0", unitIds: ["document:example.txt"], documentIds: ["example.txt"], commitShas: [], estimatedTokens: 1 }],
      documentIds: ["example.txt"],
      commitShas: []
    },
    focus: null,
    status: "completed" as const,
    output: {
      mode: "narrative" as const,
      scope: "fixture",
      executiveSummary: summary,
      changeMap: [{ path: "example.txt", summary: "Changed." }],
      changes: { behavioral: ["Changed."], apiSchema: [], configuration: [], dependencies: [], tests: [], documentation: [] },
      interactions: [],
      questions: [],
      commitNarratives: [],
      crossCommitSynthesis: null
    },
    rawOutput: "{}",
    reviewVerdict: null,
    error: null,
    startedAt,
    completedAt: startedAt + 1,
    documentCoverage: [{ id: "example.txt", state: { kind: "included" as const } }],
    commitCoverage: []
  };
}

function makeReviewRun() {
  const base = makeNarrativeRun("review-run", 5, "unused");
  return {
    ...base,
    mode: "implementationReview" as const,
    promptVersion: "review/v1",
    output: {
      mode: "implementationReview" as const,
      scope: "fixture",
      verdict: "needsAttention" as const,
      findings: [{
        priority: "P1" as const,
        path: "example.txt",
        startLine: 1,
        endLine: 1,
        title: "Issue",
        scenario: "Scenario",
        impact: "Impact",
        correctiveDirection: "Direction"
      }],
      callouts: [],
      coverageSummary: "Complete",
      coverageLimited: false
    },
    reviewVerdict: "needsAttention" as const
  };
}

function makeAnnotation(overrides: Partial<{
  id: number;
  sessionId: SessionId;
  fileId: FileId;
  hash: ContentHash;
  start: number;
  end: number;
  snippet: string;
  comment: string;
  state: Annotation["state"];
}> = {}): Annotation {
  const sessionId = overrides.sessionId ?? unwrap(checkedSessionId("state-test-session"));
  const start = unwrap(anchorLine(overrides.start ?? 1));
  const end = unwrap(anchorLine(overrides.end ?? overrides.start ?? 1));
  return {
    id: (overrides.id ?? 1) as AnnotationId,
    sessionId,
    fileId: overrides.fileId ?? (1 as FileId),
    anchor: { patchId: null, hash: overrides.hash ?? hashContent("one\ntwo\n"), start, end },
    snippet: overrides.snippet ?? "one",
    comment: overrides.comment ?? "Comment",
    role: { kind: "finding", priority: "P2", audience: "agent" },
    state: overrides.state ?? { kind: "draft" },
    createdAt: 1,
    updatedAt: 1
  };
}

function makeFile(id = 1, relPath = "example.txt", baseline = "zero\ntwo\n", current = "one\ntwo\n"): FileState {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  return {
    row: {
      id: id as FileId,
      sessionId,
      path: `/tmp/${relPath}`,
      relPath,
      baseline: baselineFromContent(baseline),
      firstTouchedAt: 1,
      firstTool: "edit"
    },
    current,
    currentHash: contentHashForCurrent(current),
    additions: 1,
    deletions: 1
  };
}

function makePatch(overrides: Partial<{ id: number; fileId: number; seq: number; displayDiff: string; unifiedPatch: string; preHash: ContentHash; postHash: ContentHash; createdAt: number }> = {}): PatchRecord {
  const sessionId = unwrap(checkedSessionId("state-test-session"));
  return {
    id: (overrides.id ?? 1) as PatchId,
    sessionId,
    fileId: (overrides.fileId ?? 1) as FileId,
    seq: (overrides.seq ?? 1) as Seq,
    tool: "edit",
    toolCallId: "call-1",
    unifiedPatch: overrides.unifiedPatch ?? "",
    displayDiff: overrides.displayDiff ?? "-1 zero\n+1 one",
    firstChangedLine: 1,
    preHash: overrides.preHash ?? hashContent("zero\ntwo\n"),
    postHash: overrides.postHash ?? hashContent("one\ntwo\n"),
    createdAt: overrides.createdAt ?? 2
  };
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
