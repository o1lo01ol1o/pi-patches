import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { err, ok, type Result } from "./errors.ts";
import { type SessionId, type SessionRecord } from "./rows.ts";
import { checkedSessionId, PatchStore } from "./store.ts";

export type ReviewArgs = {
  db?: string;
  session?: string;
  list: boolean;
  help: boolean;
};

export type Discovery = {
  dbPath: string;
  store: PatchStore;
  session: SessionRecord | null;
};

export function parseReviewArgs(argv: readonly string[]): Result<ReviewArgs> {
  const parsed: ReviewArgs = { list: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--list") {
      parsed.list = true;
      continue;
    }
    if (arg === "--db") {
      const value = argv[++index];
      if (!value) return err({ kind: "InvalidInput", field: "--db", message: "expected path" });
      parsed.db = value;
      continue;
    }
    if (arg === "--session") {
      const value = argv[++index];
      if (!value) return err({ kind: "InvalidInput", field: "--session", message: "expected id or prefix" });
      parsed.session = value;
      continue;
    }
    return err({ kind: "InvalidInput", field: "argv", message: `unknown argument ${arg}` });
  }
  return ok(parsed);
}

export function discoverDbPath(args: Pick<ReviewArgs, "db">, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Result<string> {
  if (args.db) return ok(resolve(args.db));
  if (env.PI_PATCHES_DB) return ok(resolve(env.PI_PATCHES_DB));
  const found = walkForDb(cwd);
  if (found) return ok(found);
  return err({ kind: "NotFound", entity: "patch database", id: join(cwd, ".pi/patches/patches.db") });
}

export function discoverSession(store: PatchStore, selector?: string, env: NodeJS.ProcessEnv = process.env): Result<SessionRecord | null> {
  const requested = selector ?? env.PI_PATCHES_SESSION;
  if (!requested) return store.latestLiveSession();
  const sessions = store.listSessions();
  if (!sessions.ok) return sessions;
  const exact = sessions.value.find((session) => session.id === requested);
  if (exact) return ok(exact);
  const matches = sessions.value.filter((session) => session.id.startsWith(requested));
  if (matches.length === 1) return ok(matches[0]);
  if (matches.length > 1) {
    return err({ kind: "InvalidInput", field: "session", message: `${requested} matches ${matches.length} sessions` });
  }
  const checked = checkedSessionId(requested);
  if (!checked.ok) return checked;
  return err({ kind: "NotFound", entity: "session", id: checked.value });
}

export function discover(args: ReviewArgs, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Result<Discovery> {
  const dbPath = discoverDbPath(args, env, cwd);
  if (!dbPath.ok) return dbPath;
  const store = PatchStore.open(dbPath.value);
  if (!store.ok) return store;
  if (args.list) {
    return ok({ dbPath: dbPath.value, store: store.value, session: null });
  }
  const session = discoverSession(store.value, args.session, env);
  if (!session.ok) {
    store.value.close();
    return session;
  }
  return ok({ dbPath: dbPath.value, store: store.value, session: session.value });
}

export function dbPathForCwd(cwd: string): string {
  return join(cwd, ".pi", "patches", "patches.db");
}

export function parseSessionIdFromSessionFile(sessionFile: string | undefined): SessionId | null {
  if (!sessionFile) return null;
  const basename = parse(sessionFile).name;
  const match = /_([0-9a-zA-Z-]+)$/.exec(basename);
  if (!match) return null;
  const parsed = checkedSessionId(match[1]);
  return parsed.ok ? parsed.value : null;
}

function walkForDb(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".pi", "patches", "patches.db");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
