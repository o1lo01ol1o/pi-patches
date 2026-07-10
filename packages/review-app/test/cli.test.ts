import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { baselineFromContent, checkedSessionId, hashContent, PatchStore, type Result, type SessionId } from "@pi-patches/store";

test("pi-review --list prints sessions from a real database", () => {
  const fixture = makeCliFixture();
  try {
    const result = runCli(["--db", fixture.dbPath, "--list"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cli-test-session\tlive\t2023-11-14T22:13:20\.000Z\t1 file\t1 patch\t/);
    assert.match(result.stdout, new RegExp(escapeRegExp(fixture.dir)));
  } finally {
    fixture.cleanup();
  }
});

test("pi-review --list ignores session selectors and environment session filters", () => {
  const fixture = makeCliFixture();
  try {
    const result = runCli(["--db", fixture.dbPath, "--list", "--session", "missing-session"], {
      PI_PATCHES_SESSION: "also-missing"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cli-test-session\tlive\t2023-11-14T22:13:20\.000Z\t1 file\t1 patch\t/);
  } finally {
    fixture.cleanup();
  }
});

test("pi-review renders a read-only summary when stdout is not a TTY", () => {
  const fixture = makeCliFixture();
  try {
    const result = runCli(["--db", fixture.dbPath, "--session", fixture.session]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pi-review session cli-test-session/);
    assert.match(result.stdout, /1 files, 1 patches, 0 annotations/);
    assert.match(result.stdout, /src\/example\.ts  \+1 -1/);
  } finally {
    fixture.cleanup();
  }
});

type CliFixture = {
  dir: string;
  dbPath: string;
  session: SessionId;
  cleanup(): void;
};

function makeCliFixture(): CliFixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-cli-"));
  const dbPath = join(dir, ".pi", "patches", "patches.db");
  const filePath = join(dir, "src", "example.ts");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(filePath, "const value = 2;\n");
  const session = unwrap(checkedSessionId("cli-test-session"));
  const store = unwrap(PatchStore.open(dbPath, { create: true }));
  try {
    unwrap(store.upsertSession(session, dir, join(dir, "session_cli-test-session.jsonl"), 1_700_000_000_000));
    const file = unwrap(store.ensureFile(session, filePath, "src/example.ts", baselineFromContent("const value = 1;\n"), "edit", 1_700_000_000_001));
    unwrap(
      store.addPatch({
        sessionId: session,
        fileId: file.id,
        tool: "edit",
        toolCallId: "call-1",
        unifiedPatch: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n",
        displayDiff: "-1 const value = 1;\n+1 const value = 2;",
        firstChangedLine: 1,
        preHash: hashContent("const value = 1;\n"),
        postHash: hashContent("const value = 2;\n"),
        createdAt: 1_700_000_000_002
      })
    );
  } finally {
    unwrap(store.close());
  }
  return {
    dir,
    dbPath,
    session,
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["packages/review-app/src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
