import assert from "node:assert/strict";
import { test } from "node:test";
import { createTwoFilesPatch } from "diff";
import {
  checkedSessionId,
  hashContent,
  type ContentHash,
  type FileId,
  type PatchId,
  type PatchRecord,
  type Result,
  type Seq
} from "@pi-patches/store";
import { mapRangeThroughPatches, mapRangeThroughTexts, patchesAfterAnchor } from "../src/render/reanchor.ts";

test("maps a range through insertions before it", () => {
  const patch = makePatch({
    unifiedPatch: [
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -1,3 +1,4 @@",
      "+intro",
      " one",
      " two",
      " three",
      ""
    ].join("\n")
  });

  assert.deepEqual(mapRangeThroughPatches({ start: 2, end: 3 }, [patch]), {
    kind: "mapped",
    range: { start: 3, end: 4 }
  });
});

test("reports a conflict when a patch overlaps the anchored lines", () => {
  const patch = makePatch({
    unifiedPatch: [
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      ""
    ].join("\n")
  });

  const mapped = mapRangeThroughPatches({ start: 2, end: 2 }, [patch]);
  assert.equal(mapped.kind, "conflict");
  if (mapped.kind === "conflict") assert.equal(mapped.patch.id, patch.id);
});

test("maps a range through external text insertions", () => {
  assert.deepEqual(mapRangeThroughTexts({ start: 2, end: 2 }, "one\ntwo\n", "intro\none\ntwo\n"), {
    kind: "mapped",
    range: { start: 3, end: 3 }
  });
});

test("reports a conflict when external text rewrites the anchored line", () => {
  const mapped = mapRangeThroughTexts({ start: 2, end: 2 }, "one\ntwo\n", "one\nTWO\n");
  assert.equal(mapped.kind, "conflict");
});

test("selects patches after the anchor patch id", () => {
  const first = makePatch({ id: 1 });
  const second = makePatch({ id: 2 });
  assert.deepEqual(patchesAfterAnchor([first, second], Number(first.id)), [second]);
  assert.equal(patchesAfterAnchor([first, second], 99), null);
});

test("generated clean chains compose like a direct map and preserve anchored text", () => {
  const baselineLines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
  const baseline = `${baselineLines.join("\n")}\n`;
  const anchor = { start: 8, end: 10 };
  const expectedSnippet = baselineLines.slice(anchor.start - 1, anchor.end);

  for (let prepended = 0; prepended <= 4; prepended++) {
    for (let removedBefore = 0; removedBefore <= 3; removedBefore++) {
      const afterFirstLines = [
        ...Array.from({ length: prepended }, (_, index) => `intro-${index + 1}`),
        ...baselineLines
      ];
      const afterFirst = `${afterFirstLines.join("\n")}\n`;
      const afterSecondLines = [
        ...afterFirstLines.slice(removedBefore),
        `tail-${prepended}-${removedBefore}`
      ];
      const afterSecond = `${afterSecondLines.join("\n")}\n`;
      const patches = [
        patchBetween(1, baseline, afterFirst),
        patchBetween(2, afterFirst, afterSecond)
      ];

      const composed = mapRangeThroughPatches(anchor, patches);
      const direct = mapRangeThroughTexts(anchor, baseline, afterSecond);
      assert.deepEqual(composed, direct);
      assert.equal(composed.kind, "mapped");
      if (composed.kind !== "mapped") continue;
      assert.deepEqual(
        afterSecondLines.slice(composed.range.start - 1, composed.range.end),
        expectedSnippet
      );
    }
  }
});

test("generated rewrites conflict exactly when they overlap the anchored range", () => {
  const baselineLines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
  const baseline = `${baselineLines.join("\n")}\n`;
  const anchor = { start: 5, end: 7 };

  for (let changedLine = 1; changedLine <= baselineLines.length; changedLine++) {
    const nextLines = baselineLines.slice();
    nextLines[changedLine - 1] = `changed-${changedLine}`;
    const mapped = mapRangeThroughPatches(anchor, [patchBetween(changedLine, baseline, `${nextLines.join("\n")}\n`)]);
    const overlaps = changedLine >= anchor.start && changedLine <= anchor.end;
    assert.equal(mapped.kind === "conflict", overlaps, `changed line ${changedLine}`);
  }
});

function patchBetween(id: number, oldText: string, newText: string): PatchRecord {
  return makePatch({
    id,
    unifiedPatch: createTwoFilesPatch("a/example.txt", "b/example.txt", oldText, newText, "", "")
  });
}

function makePatch(overrides: Partial<{ id: number; unifiedPatch: string }> = {}): PatchRecord {
  const sessionId = unwrap(checkedSessionId("reanchor-test-session"));
  return {
    id: (overrides.id ?? 1) as PatchId,
    sessionId,
    fileId: 1 as FileId,
    seq: (overrides.id ?? 1) as Seq,
    tool: "edit",
    toolCallId: "call-1",
    unifiedPatch: overrides.unifiedPatch ?? "",
    displayDiff: "",
    firstChangedLine: 1,
    preHash: hashContent("one\ntwo\n") as ContentHash,
    postHash: hashContent("one\ntwo\n") as ContentHash,
    createdAt: 1
  };
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
