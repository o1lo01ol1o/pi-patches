import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { checkedSessionId, dbPathForCwd, discover, err, ok, PatchStore } from "@pi-patches/store";
import { loadAppState } from "../src/app.ts";
import { createReviewComponent, dataVersionAfterRefresh, keyFromInput } from "../src/runner.ts";
import { parseSgrMouse, parseSgrMouseEvents } from "../src/mouse.ts";
import { buildDiffVisualMap, visualRowRef, wrapLineSegments } from "../src/render/diff-wrap.ts";
import {
  applyBackgroundToLine,
  changeTintWithDepth,
  detectTintTheme,
  landedTint,
  selectionTint,
  stripAnsi,
  truncateVisible,
  visibleWidth
} from "../src/render/ansi.ts";
import { enableMouseTracking, enterAltScreen } from "../src/term.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

test("parses SGR mouse press", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<0;12;3M"), { kind: "press", button: 0, x: 12, y: 3 });
});

test("parses modifier wheel events and every SGR event in a terminal chunk", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<68;12;3M"), { kind: "wheel", direction: "up", x: 12, y: 3 });
  assert.deepEqual(
    parseSgrMouseEvents("\x1b[<0;2;3M\x1b[<32;2;4M\x1b[<0;2;4m"),
    [
      { kind: "press", button: 0, x: 2, y: 3 },
      { kind: "move", button: 0, x: 2, y: 4 },
      { kind: "release", button: 0, x: 2, y: 4 }
    ]
  );
  assert.equal(parseSgrMouse("\x1b[<0;0;3M"), null);
});

test("background helper pads to requested visible width", () => {
  const line = applyBackgroundToLine("abc", 5, (text) => `\x1b[41m${text}\x1b[49m`);
  assert.equal(visibleWidth(line), 5);
  assert.equal(stripAnsi(line), "abc  ");
});

test("visible truncation preserves ANSI styling before the cut", () => {
  const line = truncateVisible("\x1b[38;2;1;2;3mabcdef\x1b[39m", 3);
  assert.equal(stripAnsi(line), "abc");
  assert.match(line, /^\x1b\[38;2;1;2;3mabc\x1b\[0m$/);
});

test("visible truncation uses terminal column width for wide graphemes", () => {
  const line = truncateVisible("🙂abc", 2);
  assert.equal(stripAnsi(line), "🙂");
  assert.equal(visibleWidth(line), 2);
});

test("diff wrapping preserves ANSI styles and hard-wraps wide or unbroken text", () => {
  const styled = wrapLineSegments("\x1b[31malpha beta gamma\x1b[39m", 6, true);
  assert.deepEqual(styled.map(stripAnsi), ["alpha", "beta", "gamma"]);
  assert.ok(styled.every((line) => visibleWidth(line) <= 6));
  assert.match(styled[1] ?? "", /^\x1b\[31m/);

  assert.deepEqual(wrapLineSegments("🙂🙂🙂abc", 6, true), ["🙂🙂🙂", "abc"]);
  assert.deepEqual(wrapLineSegments("averyveryverylongtoken", 6, true), ["averyv", "eryver", "ylongt", "oken"]);
});

test("diff visual maps resolve continuation rows back to logical rows", () => {
  const map = buildDiffVisualMap(["short", "alpha beta gamma"], () => 6, true);
  assert.deepEqual(map.starts, [0, 1, 4]);
  assert.deepEqual(visualRowRef(map, 0), { logicalRow: 0, segmentIndex: 0 });
  assert.deepEqual(visualRowRef(map, 2), { logicalRow: 1, segmentIndex: 1 });
  assert.equal(visualRowRef(map, 4), null);
});

test("change tint supports truecolor and 256-color fallback", () => {
  const truecolor = changeTintWithDepth("add", 0.5, "gradient", "truecolor");
  const fallback = changeTintWithDepth("del", 0.5, "gradient", "ansi256");
  assert.match(truecolor?.("x") ?? "", /\x1b\[48;2;\d+;\d+;\d+m/);
  assert.match(fallback?.("x") ?? "", /\x1b\[48;5;\d+m/);
});

test("selection tint follows dark and light theme backgrounds", () => {
  assert.match(selectionTint("truecolor", "dark")("x"), /48;2;58;58;74m/);
  assert.match(selectionTint("truecolor", "light")("x"), /48;2;208;208;224m/);
});

test("landed tint fades across themes with a 256-color fallback", () => {
  assert.equal(landedTint("truecolor", "dark", 0)("x"), "\x1b[48;2;47;120;72mx\x1b[49m");
  assert.equal(landedTint("truecolor", "light", 5)("x"), "\x1b[48;2;220;246;227mx\x1b[49m");
  assert.match(landedTint("ansi256", "dark", 2)("x"), /^\x1b\[48;5;\d+mx\x1b\[49m$/);
});

test("detectTintTheme derives dark and light variants from the environment", () => {
  assert.equal(detectTintTheme({ PI_PATCHES_TINT_THEME: "light" }), "light");
  assert.equal(detectTintTheme({ PI_PATCHES_TINT_THEME: "dark", COLORFGBG: "0;15" }), "dark");
  assert.equal(detectTintTheme({ TERM_BACKGROUND: "light" }), "light");
  assert.equal(detectTintTheme({ COLORFGBG: "15;0" }), "dark");
  assert.equal(detectTintTheme({ COLORFGBG: "0;15" }), "light");
});

test("terminal mode helpers separate alt-screen and mouse tracking lifetimes", () => {
  const chunks: string[] = [];
  const exitAlt = enterAltScreen((chunk) => chunks.push(chunk));
  const disableMouse = enableMouseTracking((chunk) => chunks.push(chunk));

  disableMouse();
  disableMouse();
  exitAlt();
  exitAlt();

  assert.deepEqual(chunks, [
    "\x1b[?1049h",
    "\x1b[?1002h\x1b[?1006h",
    "\x1b[?1002l\x1b[?1006l",
    "\x1b[?1049l"
  ]);
});

test("key parser maps known controls and drops unknown raw sequences", () => {
  assert.equal(keyFromInput("\t"), "tab");
  assert.equal(keyFromInput("\x05"), "ctrl+e");
  assert.equal(keyFromInput("j"), "j");
  assert.equal(keyFromInput("f"), "f");
  assert.equal(keyFromInput("w"), "w");
  assert.equal(keyFromInput("\x1b[999~"), null);
});

test("key parser decodes kitty CSI-u printable, control, arrow, and release events", () => {
  assert.equal(keyFromInput("\x1b[106u"), "j");
  assert.equal(keyFromInput("\x1b[115:83;2u"), "S");
  assert.equal(keyFromInput("\x1b[115;5u"), "ctrl+s");
  assert.equal(keyFromInput("\x1b[1;1A"), "ArrowUp");
  assert.equal(keyFromInput("\x1b[106;1:3u"), null);
});

test("db version watermark advances only after successful refresh", () => {
  assert.equal(dataVersionAfterRefresh(4, ok(4), true), 4);
  assert.equal(dataVersionAfterRefresh(4, ok(5), false), 4);
  assert.equal(dataVersionAfterRefresh(4, ok(5), true), 5);
  assert.equal(dataVersionAfterRefresh(4, err({ kind: "Busy", message: "database is locked" }), true), 4);
});

test("virtual terminal harness captures rendered text", async () => {
  const terminal = new VirtualTerminal(20, 4);
  try {
    await terminal.write("hello\r\nworld");
    assert.equal(terminal.line(0), "hello");
    assert.equal(terminal.line(1), "world");
  } finally {
    terminal.dispose();
  }
});

test("embedded review component renders and closes without owning the parent TUI", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-embedded-"));
  const dbPath = dbPathForCwd(dir);
  const session = checkedSessionId("embedded-review-session");
  assert.equal(session.ok, true);
  if (!session.ok) return;
  const setupStore = PatchStore.open(dbPath, { create: true });
  assert.equal(setupStore.ok, true);
  if (!setupStore.ok) return;
  const upserted = setupStore.value.upsertSession(session.value, dir, null);
  assert.equal(upserted.ok, true);
  setupStore.value.close();

  const opened = discover({ db: dbPath, session: session.value, list: false, help: false });
  assert.equal(opened.ok, true);
  if (!opened.ok || !opened.value.session) return;
  const initial = loadAppState(opened.value.store, opened.value.session);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  const terminal = new FakeTerminal(80, 24);
  const tui = new TUI(terminal);
  let closes = 0;
  const component = createReviewComponent(tui, opened.value, initial.value, () => closes++, { reservedRows: 2 });
  try {
    const lines = component.render(80);
    assert.equal(lines.length, 22);
    assert.match(lines.join("\n"), /cumulative · syntax/);
    assert.match(lines.join("\n"), /File: no selected file/);
    assert.deepEqual(terminal.writes, ["\x1b[?1002h\x1b[?1006h"]);
    component.handleInput?.("q");
    assert.equal(closes, 1);
    assert.equal(terminal.stopCalls, 0);
  } finally {
    component.dispose();
    component.dispose();
    assert.deepEqual(terminal.writes, ["\x1b[?1002h\x1b[?1006h", "\x1b[?1002l\x1b[?1006l"]);
    opened.value.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakeTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  readonly columns: number;
  readonly rows: number;
  stopCalls = 0;
  readonly writes: string[] = [];

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
  }

  start(): void {}
  stop(): void {
    this.stopCalls++;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}
