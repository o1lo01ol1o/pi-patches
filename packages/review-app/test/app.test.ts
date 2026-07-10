import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCurrentFile } from "../src/app.ts";

test("readCurrentFile treats missing files as deleted and reports read failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-read-current-"));
  try {
    const filePath = join(dir, "example.txt");
    writeFileSync(filePath, "hello\n");

    const present = readCurrentFile(filePath);
    assert.deepEqual(present, { ok: true, value: "hello\n" });

    const missing = readCurrentFile(join(dir, "missing.txt"));
    assert.deepEqual(missing, { ok: true, value: null });

    const directory = readCurrentFile(dir);
    assert.equal(directory.ok, false);
    if (!directory.ok) {
      assert.equal(directory.error.kind, "Io");
      assert.equal(directory.error.path, dir);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
