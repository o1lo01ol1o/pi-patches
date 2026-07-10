import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkedSessionId,
  dbPathForCwd,
  discoverDbPath,
  discoverSession,
  parseReviewArgs,
  parseSessionIdFromSessionFile,
  PatchStore,
  type Result,
  type SessionId
} from "../src/index.ts";

test("parseReviewArgs parses flags and rejects missing values", () => {
  assert.deepEqual(unwrap(parseReviewArgs(["--db", "patches.db", "--session", "abc", "--list"])), {
    db: "patches.db",
    session: "abc",
    list: true,
    help: false
  });

  const missingDb = parseReviewArgs(["--db"]);
  assert.equal(missingDb.ok, false);
  if (!missingDb.ok) {
    assert.equal(missingDb.error.kind, "InvalidInput");
    assert.equal(missingDb.error.field, "--db");
  }

  const unknown = parseReviewArgs(["--wat"]);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.error.kind, "InvalidInput");
    assert.equal(unknown.error.field, "argv");
  }
});

test("discoverDbPath uses --db before env and walks upward from cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-discover-db-"));
  try {
    const project = join(dir, "project");
    const nested = join(project, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const walkedDb = dbPathForCwd(project);
    const explicitDb = join(dir, "explicit.db");
    const envDb = join(dir, "env.db");
    unwrap(PatchStore.open(walkedDb, { create: true })).close();

    assert.equal(discoverDbPath({ db: explicitDb }, { PI_PATCHES_DB: envDb }, nested).ok, true);
    assert.equal(unwrap(discoverDbPath({ db: explicitDb }, { PI_PATCHES_DB: envDb }, nested)), explicitDb);
    assert.equal(unwrap(discoverDbPath({}, { PI_PATCHES_DB: envDb }, nested)), envDb);
    assert.equal(unwrap(discoverDbPath({}, {}, nested)), walkedDb);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverSession selects latest live session, exact id, unique prefix, and env fallback", () => {
  const fixture = makeDiscoveryFixture();
  try {
    assert.equal(unwrap(discoverSession(fixture.store))?.id, fixture.liveNew);
    assert.equal(unwrap(discoverSession(fixture.store, fixture.ended))?.id, fixture.ended);
    assert.equal(unwrap(discoverSession(fixture.store, "019f-discover-live-n"))?.id, fixture.liveNew);
    assert.equal(unwrap(discoverSession(fixture.store, undefined, { PI_PATCHES_SESSION: "019f-discover-ended" }))?.id, fixture.ended);
  } finally {
    fixture.cleanup();
  }
});

test("discoverSession reports ambiguous and missing selectors as structured errors", () => {
  const fixture = makeDiscoveryFixture();
  try {
    const ambiguous = discoverSession(fixture.store, "019f-discover-live");
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) {
      assert.equal(ambiguous.error.kind, "InvalidInput");
      assert.equal(ambiguous.error.field, "session");
      assert.match(ambiguous.error.message, /matches 2 sessions/);
    }

    const missing = discoverSession(fixture.store, "019f-discover-missing");
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.error.kind, "NotFound");
      assert.equal(missing.error.entity, "session");
    }
  } finally {
    fixture.cleanup();
  }
});

test("parseSessionIdFromSessionFile extracts the trailing session id from pi session filenames", () => {
  assert.equal(parseSessionIdFromSessionFile("/tmp/2026-07-09_019f-discover-live-new.jsonl"), "019f-discover-live-new");
  assert.equal(parseSessionIdFromSessionFile("/tmp/not-a-pi-session.jsonl"), null);
  assert.equal(parseSessionIdFromSessionFile(undefined), null);
});

function makeDiscoveryFixture(): {
  store: PatchStore;
  liveOld: SessionId;
  liveNew: SessionId;
  ended: SessionId;
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "pi-patches-discover-session-"));
  const store = unwrap(PatchStore.open(join(dir, "patches.db"), { create: true }));
  const liveOld = unwrap(checkedSessionId("019f-discover-live-old"));
  const liveNew = unwrap(checkedSessionId("019f-discover-live-new"));
  const ended = unwrap(checkedSessionId("019f-discover-ended"));

  unwrap(store.upsertSession(liveOld, dir, join(dir, "session_019f-discover-live-old.jsonl"), 10));
  unwrap(store.upsertSession(liveNew, dir, join(dir, "session_019f-discover-live-new.jsonl"), 20));
  unwrap(store.upsertSession(ended, dir, join(dir, "session_019f-discover-ended.jsonl"), 30));
  unwrap(store.endSession(ended, 40));

  return {
    store,
    liveOld,
    liveNew,
    ended,
    cleanup(): void {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
