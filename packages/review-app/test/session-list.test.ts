import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedSessionId, type Result, type SessionRecord } from "@pi-patches/store";
import { formatSessionListRow } from "../src/session-list.ts";

test("session list rows include required session fields and counts", () => {
  const session = makeSession({ id: "019f-list-session", endedAt: null });

  assert.equal(
    formatSessionListRow(session, { files: 2, patches: 1 }),
    `${session.id}\tlive\t2023-11-14T22:13:20.000Z\t2 files\t1 patch\t/tmp/project`
  );
});

test("session list rows mark ended sessions and pluralize patch counts", () => {
  const session = makeSession({ id: "019f-ended-session", endedAt: 1_700_000_001_000 });

  assert.equal(
    formatSessionListRow(session, { files: 1, patches: 3 }),
    `${session.id}\tended\t2023-11-14T22:13:20.000Z\t1 file\t3 patches\t/tmp/project`
  );
});

function makeSession(input: { id: string; endedAt: number | null }): SessionRecord {
  return {
    id: unwrap(checkedSessionId(input.id)),
    cwd: "/tmp/project",
    sessionFile: null,
    parentSessionId: null,
    startedAt: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
    endedAt: input.endedAt
  };
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.kind}: ${JSON.stringify(result.error)}`);
}
