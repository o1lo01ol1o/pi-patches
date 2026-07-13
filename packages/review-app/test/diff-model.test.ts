import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDiffModel } from "../src/render/diff-model.ts";

test("compact diff models represent every omitted unchanged region as a typed collapsed row", () => {
  const baseline = numberedLines(30);
  const current = baseline
    .replace("line 6\n", "changed 6\n")
    .replace("line 25\n", "changed 25\n");

  const model = buildDiffModel(baseline, current, "example.txt");
  const collapsed = model.rows.filter((row) => row.kind === "collapsed");

  assert.deepEqual(
    collapsed.map((row) => ({ oldStart: Number(row.oldStart), newStart: Number(row.newStart), lines: row.lines })),
    [
      { oldStart: 1, newStart: 1, lines: 2 },
      { oldStart: 10, newStart: 10, lines: 12 },
      { oldStart: 29, newStart: 29, lines: 2 }
    ]
  );
  assert.match(collapsed[1]?.text ?? "", /12 unchanged lines.*Enter\/click to expand/);
});

test("full diff models include unchanged prefix and suffix lines without collapsed rows", () => {
  const baseline = numberedLines(20);
  const current = baseline.replace("line 10\n", "changed 10\n");
  const model = buildDiffModel(baseline, current, "example.txt", { context: "full" });

  assert.equal(model.rows.some((row) => row.kind === "collapsed"), false);
  assert.ok(model.rows.some((row) => row.kind === "context" && Number(row.newLine) === 1 && row.text === "line 1"));
  assert.ok(model.rows.some((row) => row.kind === "context" && Number(row.newLine) === 20 && row.text === "line 20"));
  assert.ok(model.rows.some((row) => row.kind === "add" && Number(row.newLine) === 10 && row.text === "changed 10"));
});

test("unchanged files collapse to one gap or expand to every source line", () => {
  const content = numberedLines(5);
  const compact = buildDiffModel(content, content, "same.txt");
  const full = buildDiffModel(content, content, "same.txt", { context: "full" });

  assert.deepEqual(compact.rows.map((row) => row.kind), ["collapsed"]);
  assert.equal(compact.rows[0]?.kind === "collapsed" ? compact.rows[0].lines : 0, 5);
  assert.deepEqual(full.rows.map((row) => row.kind), ["context", "context", "context", "context", "context"]);
});

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
}
