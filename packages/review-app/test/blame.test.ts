import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPatch, createTwoFilesPatch, structuredPatch } from "diff";
import {
  baselineFromContent,
  checkedSessionId,
  hashContent,
  type ContentHash,
  type FileId,
  type PatchId,
  type PatchRecord,
  type Result,
  type Seq
} from "@pi-patches/store";
import {
  applyExternalChanges,
  createBlameCache,
  fromBaseline,
  replayPatches,
  type AttributedLine,
  type FileVersion
} from "../src/render/blame.ts";
import { buildDiffModel, type Attribution } from "../src/render/diff-model.ts";

test("replayPatches rejects a patch whose pre_hash does not match the replay state", () => {
  const patch = makePatch({
    seq: 1,
    oldText: "one\n",
    newText: "two\n",
    preHash: hashContent("other\n")
  });

  const replay = replayPatches(baselineFromContent("one\n"), [patch]);

  assert.equal(replay.ok, false);
  if (!replay.ok) {
    assert.equal(replay.error.kind, "ChainBreak");
    assert.equal(replay.error.atSeq, 1);
    assert.equal(replay.error.expected, hashContent("other\n"));
    assert.equal(replay.error.found, hashContent("one\n"));
  }
});

test("a null pre_hash proves an absent file rather than disabling chain validation", () => {
  const patch = makePatch({
    seq: 1,
    oldText: "one\n",
    newText: "two\n",
    preHash: null
  });
  const replay = replayPatches(baselineFromContent("one\n"), [patch]);
  assert.equal(replay.ok, false);
  if (!replay.ok) {
    assert.equal(replay.error.kind, "ChainBreak");
    assert.equal(replay.error.expected, hashContent(""));
  }
});

test("replay attribution covers every changed cumulative diff row, including external edits", () => {
  const baseline = "one\ntwo\nthree\n";
  const afterPatch1 = "zero\none\ntwo\nthree\n";
  const afterPatch2 = "zero\none\nTWO\nthree\n";
  const current = "zero\none\nTWO\nthree\nfour\n";
  const patches = [
    makePatch({ seq: 1, oldText: baseline, newText: afterPatch1 }),
    makePatch({ id: 2, seq: 2, oldText: afterPatch1, newText: afterPatch2 })
  ];
  const replay = replayPatches(baselineFromContent(baseline), patches);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;

  const withExternal = applyExternalChanges(replay.value, current);
  const model = buildDiffModel(baseline, current, "example.txt", {
    currentLines: withExternal.lines,
    deletedBaselineLines: withExternal.deletedBaselineLines
  });
  const changedRows = model.rows.filter((row) => row.kind === "add" || row.kind === "del");

  assert.deepEqual(
    changedRows.map((row) => row.kind === "add" ? ["add", row.text, label(row.attribution)] : ["del", row.text, label(row.attribution)]),
    [
      ["add", "zero", "patch:1"],
      ["del", "two", "patch:2"],
      ["add", "TWO", "patch:2"],
      ["add", "four", "external"]
    ]
  );
});

test("replayPatches agrees with the independent reference replay on patch chains", () => {
  const baseline = "alpha\nbeta\ngamma\n";
  const afterPatch1 = "alpha\nBETA\ngamma\n";
  const afterPatch2 = "intro\nalpha\nBETA\ngamma\n";
  const afterPatch3 = "intro\nalpha\nBETA\nomega\n";
  const patches = [
    makePatch({ seq: 1, oldText: baseline, newText: afterPatch1 }),
    makePatch({ id: 2, seq: 2, oldText: afterPatch1, newText: afterPatch2 }),
    makePatch({ id: 3, seq: 3, oldText: afterPatch2, newText: afterPatch3 })
  ];

  const replay = replayPatches(baselineFromContent(baseline), patches);
  const reference = referenceReplay(baseline, patches);

  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.value.content, reference.content);
  assert.equal(replay.value.hash, reference.hash);
  assert.deepEqual(serializeLines(replay.value.lines), serializeLines(reference.lines));
  assert.deepEqual(serializeDeleted(replay.value.deletedBaselineLines), serializeDeleted(reference.deletedBaselineLines));
});

test("incremental blame cache agrees with full replay after every append and chain break", () => {
  const baseline = "alpha\nbeta\ngamma\n";
  const versions = [
    "alpha\nBETA\ngamma\n",
    "intro\nalpha\nBETA\ngamma\n",
    "intro\nalpha\nBETA\nomega\n"
  ];
  const patches: PatchRecord[] = [];
  let previous = baseline;
  const cache = createBlameCache();

  versions.forEach((next, index) => {
    patches.push(makePatch({ id: index + 1, seq: index + 1, oldText: previous, newText: next }));
    previous = next;
    const cached = cache.replay("file-1", baselineFromContent(baseline), patches);
    const full = replayPatches(baselineFromContent(baseline), patches);
    assert.deepEqual(cached, full);
  });

  const broken = makePatch({
    id: 4,
    seq: 4,
    oldText: previous,
    newText: `${previous}tail\n`,
    preHash: hashContent("wrong\n")
  });
  const cachedBreak = cache.replay("file-1", baselineFromContent(baseline), [...patches, broken]);
  const fullBreak = replayPatches(baselineFromContent(baseline), [...patches, broken]);
  assert.deepEqual(cachedBreak, fullBreak);

  const valid = makePatch({ id: 5, seq: 4, oldText: previous, newText: `${previous}tail\n` });
  assert.deepEqual(
    cache.replay("file-1", baselineFromContent(baseline), [...patches, valid]),
    replayPatches(baselineFromContent(baseline), [...patches, valid])
  );
});

test("generated replay chains agree with the reference across external tails and every break position", () => {
  const baselineLines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
  const baseline = `${baselineLines.join("\n")}\n`;

  for (let chainLength = 1; chainLength <= 8; chainLength++) {
    const patches: PatchRecord[] = [];
    let previousLines = baselineLines.slice();
    for (let index = 0; index < chainLength; index++) {
      const nextLines = previousLines.slice();
      const changed = (index * 3) % nextLines.length;
      nextLines[changed] = `${nextLines[changed]}-p${index + 1}`;
      const previous = `${previousLines.join("\n")}\n`;
      const next = `${nextLines.join("\n")}\n`;
      patches.push(makePatch({ id: index + 1, seq: index + 1, oldText: previous, newText: next }));
      previousLines = nextLines;
    }

    const replay = replayPatches(baselineFromContent(baseline), patches);
    assert.equal(replay.ok, true);
    if (!replay.ok) continue;
    const reference = referenceReplay(baseline, patches);
    assert.deepEqual(serializeLines(replay.value.lines), serializeLines(reference.lines));
    assert.deepEqual(serializeDeleted(replay.value.deletedBaselineLines), serializeDeleted(reference.deletedBaselineLines));

    const externalContent = `external-${chainLength}\n${replay.value.content}`;
    const replayExternal = applyExternalChanges(replay.value, externalContent);
    const referenceExternal = referenceApplyTextChange(reference, externalContent, { kind: "external" });
    assert.deepEqual(serializeLines(replayExternal.lines), serializeLines(referenceExternal.lines));

    for (let brokenIndex = 0; brokenIndex < patches.length; brokenIndex++) {
      const broken = patches.map((patch, index) =>
        index === brokenIndex ? { ...patch, preHash: hashContent(`wrong-${chainLength}-${brokenIndex}`) } : patch
      );
      const result = replayPatches(baselineFromContent(baseline), broken);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.kind, "ChainBreak");
        if (result.error.kind === "ChainBreak") assert.equal(result.error.atSeq, brokenIndex + 1);
      }
    }
  }
});

function referenceReplay(baseline: string, patches: readonly PatchRecord[]): FileVersion {
  let version = fromBaseline(baselineFromContent(baseline));
  for (const patch of patches) {
    const next = applyPatch(version.content, patch.unifiedPatch);
    if (typeof next !== "string") {
      throw new Error(`reference patch rejected at seq ${Number(patch.seq)}`);
    }
    version = referenceApplyTextChange(version, next, { kind: "patch", seq: patch.seq });
  }
  return version;
}

function referenceApplyTextChange(version: FileVersion, nextContent: string, attribution: Attribution): FileVersion {
  const patch = structuredPatch("old", "new", version.content, nextContent, "", "", { context: 0 });
  const lines: AttributedLine[] = [];
  const deletedBaselineLines = new Map(version.deletedBaselineLines);
  let oldIndex = 0;

  for (const hunk of patch.hunks) {
    const unchangedBeforeHunk = Math.max(0, hunk.oldStart - 1);
    for (; oldIndex < unchangedBeforeHunk; oldIndex++) {
      const line = version.lines[oldIndex];
      if (line) lines.push(line);
    }

    for (const rawLine of hunk.lines) {
      const marker = rawLine[0];
      const text = rawLine.slice(1);
      if (marker === " ") {
        const line = version.lines[oldIndex];
        lines.push(line ?? { text });
        oldIndex++;
      } else if (marker === "-") {
        const removed = version.lines[oldIndex];
        if (removed?.originBaselineLine !== undefined) deletedBaselineLines.set(removed.originBaselineLine, attribution);
        oldIndex++;
      } else if (marker === "+") {
        lines.push({ text, attribution });
      }
    }
  }

  for (; oldIndex < version.lines.length; oldIndex++) {
    const line = version.lines[oldIndex];
    if (line) lines.push(line);
  }

  return { content: nextContent, lines, hash: hashContent(nextContent), deletedBaselineLines };
}

function makePatch(overrides: {
  oldText: string;
  newText: string;
  id?: number;
  seq?: number;
  preHash?: ContentHash | null;
  postHash?: ContentHash;
}): PatchRecord {
  const sessionId = unwrap(checkedSessionId("blame-test-session"));
  const id = overrides.id ?? overrides.seq ?? 1;
  const seq = overrides.seq ?? id;
  return {
    id: id as PatchId,
    sessionId,
    fileId: 1 as FileId,
    seq: seq as Seq,
    tool: "edit",
    toolCallId: `call-${seq}`,
    unifiedPatch: createTwoFilesPatch("a/example.txt", "b/example.txt", overrides.oldText, overrides.newText, "", ""),
    displayDiff: "",
    firstChangedLine: 1,
    preHash: "preHash" in overrides ? (overrides.preHash ?? null) : hashContent(overrides.oldText),
    postHash: overrides.postHash ?? hashContent(overrides.newText),
    createdAt: seq
  };
}

function serializeLines(lines: readonly AttributedLine[]): Array<{ text: string; attribution: string | null; originBaselineLine: number | null }> {
  return lines.map((line) => ({
    text: line.text,
    attribution: label(line.attribution),
    originBaselineLine: line.originBaselineLine ?? null
  }));
}

function serializeDeleted(deleted: ReadonlyMap<number, Attribution>): Array<[number, string]> {
  return [...deleted.entries()].map(([line, attribution]) => [line, label(attribution) ?? "missing"]);
}

function label(attribution: Attribution | undefined): string | null {
  if (!attribution) return null;
  return attribution.kind === "external" ? "external" : `patch:${Number(attribution.seq)}`;
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
