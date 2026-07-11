# pi-patches — Session Edit Database, Review TUI, and Annotation Round-Trip

**Status:** v1 implemented; this document also specifies the v2 review-source and model-analysis expansion in §10.
**Targets:** pi v0.80.2 (`@earendil-works/pi-coding-agent`), Node ≥ 24, and pi's interactive terminal UI. The standalone `pi-review` CLI remains an optional compatibility surface.
**Reference checkout:** all `file:line` citations below refer to `~/Work/pi` (pi-mono @ `76a7f104`). All cited APIs were verified against that checkout.

---

## 1. Overview

Five cooperating components:

1. **Recorder extension** — a pi extension (in-process, TypeScript, jiti-loaded) that records every file mutation made by pi's `edit` and `write` tools into a per-project SQLite database, including a **baseline** (first-touch content) per file so the session's cumulative diff can always be reconstructed.
2. **Embedded review component** — an `@earendil-works/pi-tui` component opened inside pi with `/patches connect <session-id-or-prefix>`. It temporarily replaces pi's editor, reserves pi's footer rows, and returns to pi on `q`; it never launches another terminal or owns/stops pi's `TUI`.
3. **Annotation round-trip** — line-range comments created in the review app persist in an annotation queue in the same database; on explicit submit, the recorder extension claims the queued batch and delivers it to the model via `pi.sendUserMessage(...)` — i.e., exactly as if the user had typed it into pi.
4. **Review-source adapters (v2)** — present session history, working-tree changes, branch/commit/range changes, pull requests, and folder snapshots through one checked `ReviewDataset` boundary rather than teaching the renderer about Git or GitHub.
5. **Model analysis (v2)** — runs one of two explicitly selected tasks with a selected configured model: a descriptive **change narrative**, optionally preserving per-commit evolution, or a defect-oriented **implementation review**. These are separate requests, prompts, outputs, and persisted runs.

### Decisions (locked)

| Decision | Choice |
|---|---|
| Storage | SQLite via Node's built-in `node:sqlite` (`DatabaseSync`) — no native deps |
| Annotation delivery | Batch: comments accumulate; explicit **Submit** in the TUI sends one formatted user message |
| Bash-caused edits | v1 covers them only via **live-disk diffing**: cumulative diff = baseline vs current disk content, so later bash changes to files pi already touched appear automatically |
| TUI stack | TypeScript on `@earendil-works/pi-tui@0.80.2`, reusing pi's exported diff renderer and highlight.js pipeline |
| Pi command namespace | `/patches` only. `/review` is not registered. `/patches` reports the current id; `/patches connect <id-or-prefix>` opens the embedded TUI. |
| Terminal ownership | Embedded review reuses pi's live `TUI`; it never spawns a process or terminal window. The standalone CLI owns terminal modes only when invoked directly. |
| Model-assisted tasks | `narrative` and `implementationReview` are disjoint modes. A narrative is not a softer review, and a review is not a narrative with findings appended. |
| Model selection | Every model-assisted run records an explicit provider/model selection; the current pi model is only the initial default. |

### Non-goals (v1)

- Files changed **only** by bash (never touched by `edit`/`write`) remain invisible to the v1 session source; the v2 working-tree source covers them without inventing recorder provenance (§10.4).
- Renames and deletes as first-class events. A deleted tracked file renders as fully-removed (current content = empty).
- Automatic terminal-window creation or rearrangement. No extension command may invoke Ghostty, kitty remote control, `open`, or an equivalent launcher.
- Reintroducing a `/review` slash command. New review behavior stays under `/patches` and inside the embedded terminal interface.
- Checking out a pull request into the user's active worktree. PR materialization must be read-only or use an isolated temporary worktree (§10.4).
- Conflating descriptive change narration with implementation review. They may inspect the same `ReviewDataset`, but their task contracts and outputs remain independent (§10.6).
- Multi-writer pi sessions editing the *same* file concurrently from *different* pi processes in one cwd (rare; WAL keeps it safe, ordering per file is best-effort).

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ pi (interactive, Node 24; one terminal and one shared TUI)         │
│                                                                    │
│ recorder extension                    embedded review component     │
│ ├─ tool_call/tool_result ─────write──►┌─────────┐◄──read/write────┤
│ ├─ /patches                           │ SQLite  │  file tree/diff  │
│ ├─ /patches connect <id> ────────────►│ WAL DB  │  annotations    │
│ └─ submitter ◄────────────────────────│         │  analysis views │
│      └─ pi.sendUserMessage            └─────────┘                  │
│                                                                    │
│ v2 source adapters: session | working tree | Git history | PR     │
│ v2 model runner: narrative | implementationReview                  │
└────────────────────────────────────────────────────────────────────┘

Optional compatibility path: the standalone `pi-review` CLI creates its own
`ProcessTerminal`/`TUI` and opens a second database connection. It is not used
by `/patches connect`.
```

- **One DB per project** at `<sessionCwd>/.pi/patches/patches.db`; rows keyed by pi session id. Rationale: session discovery ("list sessions, open latest") is one SQL query; one WAL journal means one `data_version` to poll; forks are cheap row-copies; `DELETE ... CASCADE` cleanup.
- **Change signaling, DB → connections:** the embedded component opens a database connection independent of the recorder and polls `PRAGMA data_version` every 400 ms; the extension polls every 1000 ms. `data_version` increments only when *another* connection commits — precisely the "did someone else change the DB" primitive both sides need. Chosen over `fs.watch` on the `-wal` file, which can be checkpointed away and is platform-flaky.
- **Change signaling, disk → TUI:** debounced (150 ms) `fs.watch` on the parent directories of tracked files, because bash-caused edits never touch the DB; the cumulative diff is recomputed from live disk content.
- **Why the extension delivers annotations (not RPC):** pi's RPC mode is stdin/stdout of a **child process** (`rpc-client.ts` spawns `dist/cli.js`; `modes/rpc/rpc-mode.ts:762-770`) — there is no socket to attach to an already-running interactive session. An in-process extension calling `pi.sendUserMessage` (`extensions/types.ts:1232-1235`) is the only clean injection path, and it records a genuine `role:"user"` message (`agent-session.ts:1354-1385`, `source:"extension"`).
- **Why sources are adapters:** renderer state consumes checked baseline/head documents plus optional history/provenance. Session SQL, Git commands, `gh`, and filesystem snapshots remain at effect boundaries; source-specific nullability and command output never leak into `AppState`.
- **Why model tasks are separate:** source materialization is shared, but narration and review have incompatible obligations. A narrative must cover and explain all changes without manufacturing findings; an implementation review must identify actionable defects and may legitimately return no findings. Combining the prompts makes both outputs less trustworthy.

---

## 3. Repository layout & tooling

npm-workspaces monorepo in `/path/to/pi-patches`:

```
pi-patches/
├── flake.nix                     # devenv: packages = [ pkgs.nodejs_24 pkgs.sqlite ]
├── package.json                  # private: true, "workspaces": ["packages/*"]
├── tsconfig.base.json            # strict, module nodenext, verbatimModuleSyntax,
│                                 # erasableSyntaxOnly, allowImportingTsExtensions, noEmit
└── packages/
    ├── store/                    # @pi-patches/store — shared schema + data access
    │   ├── package.json          # exports TS source directly ("exports": "./src/index.ts")
    │   ├── src/{index,store,schema,rows,errors,discover}.ts
    │   │                         # rows.ts = raw row types + total row⇄domain parse/print (only home of raw shapes)
    │   └── test/store.test.ts    # node --test (+ fixtures/v1.db golden)
    ├── extension/                # @pi-patches/extension — the pi extension
    │   ├── package.json          # "pi": { "extensions": ["./src/index.ts"] }
    │   └── src/{index,recorder,submitter,format-message,commands}.ts
    └── review-app/               # @pi-patches/review-app — reusable review component + CLI
        ├── package.json          # "bin": { "pi-review": "./src/cli.ts" }
        ├── src/
        │   ├── cli.ts            # optional standalone entrypoint
        │   ├── app.ts  state.ts  runner.ts  mouse.ts  term.ts
        │   ├── sources/          # v2 checked session/Git/PR/snapshot adapters
        │   ├── analysis/         # v2 request planning, model runner, coverage, output parsers
        │   ├── components/       # file-tree, diff-pane, status-bar, help-overlay,
        │   │                     # comment-editor, annotation-list, source/model selectors
        │   └── render/{diff-model,blame,coords,highlight-cache,ansi}.ts   # pure — no IO imports
        └── test/{virtual-terminal.ts, smoke.test.ts}
```

**Zero build step, everywhere.**
- The extension is loaded by pi through **jiti**, which imports TypeScript directly and resolves the extension's own `node_modules` in Node mode (`extensions/loader.ts:381-397`). Workspace symlinks make `@pi-patches/store` (also shipped as TS source) resolvable.
- The review app runs on Node ≥ 23.6/24 **native type stripping**; hence `erasableSyntaxOnly` (no enums/namespaces), explicit `.ts` extensions on relative imports, and `tsc` used for typecheck only (`npm run typecheck` → `tsc --build`).

**Dependencies (pinned to the installed pi):**
- `@earendil-works/pi-tui@0.80.2` (review app).
- `@earendil-works/pi-coding-agent@0.80.2` (review app runtime for `renderDiff`/theme/highlight; extension declares it as a regular dep for standalone typecheck, but at runtime jiti's alias map resolves it to **pi's own live instance** — `loader.ts:76-126` — which is what makes theme sharing and `generateDiffString` value-imports safe inside the extension).
- `diff@^8` (review app's `structuredPatch`; the extension gets diff functionality via pi's exports instead).
- devDeps: `@xterm/headless@5.5.0` (vendored VirtualTerminal test harness), `@types/node`.

**Verified exports we rely on** (from `@earendil-works/pi-coding-agent` package root, `src/index.ts`; the package `exports` map only exposes `"."`, so deep imports are not an option):
- `generateDiffString(old, new, contextLines=4) → { diff, firstChangedLine }` (`src/index.ts:249`; impl `core/tools/edit-diff.ts:380-503`) — pi's line-numbered display diff.
- `generateUnifiedPatch(path, old, new, context=4)` (`edit-diff.ts:369-374`) — real unified diff via `Diff.createTwoFilesPatch`.
- `renderDiff(diffText, {filePath?}) → string` (`src/index.ts:348`; impl `modes/interactive/components/diff.ts:79`) — ANSI-colored rendering **of the display-diff format** (not raw unified patches), with intra-line word-diff via `Diff.diffWords` + `theme.inverse` (`diff.ts:26-66`).
- Theme block (`src/index.ts:366-375`): `initTheme`, `Theme`, `getLanguageFromPath` (extension→language map, `theme.ts:1152`), `highlightCode(code, lang) → string[]` (highlight.js → ANSI, `theme.ts:1128`).
- `withFileMutationQueue` (`src/index.ts:298`) — not needed by us (we never mutate watched files), listed for awareness.

**Two snippets must be vendored** (verified not exported/published):
- `applyBackgroundToLine(line, width, bgFn)` — exists in pi-tui `src/utils.ts:893` but is absent from the package index. ~15 lines; reimplement in `render/ansi.ts`.
- The `VirtualTerminal` test harness (`packages/tui/test/virtual-terminal.ts`) — pi-tui publishes `dist/**` only. ~100 lines; vendor into `review-app/test/`.

**flake.nix change:** replace the placeholder devenv module (`pkgs.hello`, `processes.hello`) with `packages = [ pkgs.nodejs_24 pkgs.sqlite ];` (the `sqlite` CLI is the Phase-1 verification tool). Node 24 matches pi's own runtime, making `node:sqlite` availability a non-issue.

---

## 4. SQLite schema

Opened with pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);   -- schema_version = '1'

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,   -- pi session id (uuidv7, sessionManager.getSessionId())
  cwd               TEXT NOT NULL,
  session_file      TEXT,               -- pi session .jsonl path (NULL if ephemeral)
  parent_session_id TEXT,               -- set when created by fork
  started_at        INTEGER NOT NULL,   -- ms epoch
  last_event_at     INTEGER,
  ended_at          INTEGER             -- NULL while live; used by "open latest"
);

CREATE TABLE files (
  id               INTEGER PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path             TEXT NOT NULL,       -- absolute, resolved against session cwd
  rel_path         TEXT NOT NULL,       -- for display
  baseline_content BLOB,                -- content at first touch; NULL iff baseline_missing=1
  baseline_hash    TEXT,                -- sha256 hex of baseline_content
  baseline_missing INTEGER NOT NULL DEFAULT 0,  -- 1 = file did not exist (created this session)
  first_touched_at INTEGER NOT NULL,
  first_tool       TEXT NOT NULL CHECK (first_tool IN ('edit','write')),
  UNIQUE(session_id, path),
  -- baseline is a sum (Absent | Present{content,hash}) encoded across three columns;
  -- the CHECK makes the illegal mixed states unrepresentable in the DB itself:
  CHECK ((baseline_missing = 1 AND baseline_content IS NULL AND baseline_hash IS NULL)
      OR (baseline_missing = 0 AND baseline_content IS NOT NULL AND baseline_hash IS NOT NULL))
);

CREATE TABLE patches (
  id                 INTEGER PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_id            INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,  -- per-session monotonic (MAX(seq)+1 on open: resume-safe)
  tool               TEXT NOT NULL CHECK (tool IN ('edit','write')),
  tool_call_id       TEXT,              -- links back to the pi session entry
  unified_patch      TEXT NOT NULL,     -- generateUnifiedPatch output (durable machine artifact)
  display_diff       TEXT NOT NULL,     -- generateDiffString().diff (renderDiff's input format)
  first_changed_line INTEGER,
  pre_hash           TEXT,
  post_hash          TEXT,
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_patches ON patches(session_id, seq);   -- monotonicity is a constraint, not a convention

CREATE TABLE annotations (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  -- THE ANCHOR: annotations are pinned to the exact file VERSION they were written against.
  anchor_patch_id INTEGER REFERENCES patches(id) ON DELETE CASCADE,
                                        -- newest patch applied at creation; NULL = anchored at baseline
  anchor_hash     TEXT NOT NULL,        -- content hash of the anchor version (patch post_hash, or
                                        -- disk hash if external edits were present at creation)
  start_line      INTEGER NOT NULL CHECK (start_line >= 1),  -- 1-based, in ANCHOR-version coordinates
  end_line        INTEGER NOT NULL CHECK (end_line >= start_line),
  snippet         TEXT NOT NULL,        -- the anchor version's lines (what the reviewer actually saw)
  comment         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','sent')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  batch_id        TEXT,                 -- shared uuid per submitted batch
  -- sent-ness is a sum, not three independent nullables:
  CHECK ((status = 'sent' AND sent_at IS NOT NULL AND batch_id IS NOT NULL)
      OR (status <> 'sent' AND sent_at IS NULL AND batch_id IS NULL))
);
CREATE INDEX idx_ann_status ON annotations(session_id, status);
```

**Staleness is derived, never stored** (single source of truth): an annotation is **fresh** iff `anchor_hash` equals the hash of the file's current content (disk), and **stale** otherwise. Because every intervening version is in the DB (the patch chain, plus at most one external diff at the end), staleness isn't just detectable — it is *explainable*: "anchored at patch 3, file is now at patch 7 (+ external edits)".

**Why both `unified_patch` and `display_diff`:** `renderDiff` consumes only the line-numbered display format (`diff.ts:8-12` parses `"+123 content"`), while the unified patch is the durable, tool-agnostic artifact (applies with `git apply`/`patch`). They are cheap; store both.

**Annotation status flow:** `draft` (created/edited in TUI) → `queued` (user hits Submit; `queued` *means* user-approved) → `sent` (extension delivered it). Three states suffice.

### 4.1 Domain types & the row boundary (correct-by-construction rules)

The DB is a boundary. Raw row shapes exist **only** inside `packages/store` (`rows.ts`); everything the store returns is a checked domain type, produced by a total parse `Row → Result<Domain, StoreError>`. No caller ever sees a nullable column or a status string.

```ts
// Branded primitives — argument-swap and unit-confusion bugs become type errors.
type SessionId   = string & { __brand: "SessionId" };
type BatchId     = string & { __brand: "BatchId" };
type ContentHash = string & { __brand: "ContentHash" };   // lowercase sha256 hex
type Seq         = number & { __brand: "Seq" };
type PatchId     = number & { __brand: "PatchId" };
type BaselineLine = number & { __brand: "BaselineLine" }; // 1-based, baseline coords
type CurrentLine  = number & { __brand: "CurrentLine" };  // 1-based, live-file coords
type AnchorLine   = number & { __brand: "AnchorLine" };   // 1-based, coords in an annotation's anchor version
type DiffRow      = number & { __brand: "DiffRow" };      // 0-based index into diff row model
// (TerminalRow lives in the review app; conversions between spaces are named total
//  functions in render/coords.ts — never raw arithmetic at call sites.)

// Sums, not products-of-nullables (mirrors the SQL CHECK constraints exactly):
type Baseline        = { kind: "absent" } | { kind: "present"; content: string; hash: ContentHash };
type AnnotationState =
  | { kind: "draft" }
  | { kind: "queued" }
  | { kind: "sent"; sentAt: number; batchId: BatchId };
type Attribution     = { kind: "patch"; seq: Seq } | { kind: "external" };

// The version an annotation is pinned to. Staleness/freshness is DERIVED, never stored:
type Anchor    = { patchId: PatchId | null /* null = baseline */; hash: ContentHash;
                   start: AnchorLine; end: AnchorLine };
type Freshness =
  | { kind: "fresh" }                                        // anchor.hash === hash(current disk content)
  | { kind: "stale"; anchorSeq: Seq | 0; headSeq: Seq | 0; external: boolean };
// An AnchorLine converts to a CurrentLine only through freshness (identity when fresh)
// or through explicit re-anchoring (§6.6) — there is no unchecked cast between the two.
```

Rules the implementation must keep:
- **Legal transitions only.** There is no generic `updateStatus`. The API's shape *is* the state machine: `queueAllDrafts` (`draft → queued`, `UPDATE … WHERE status='draft'`), `claimQueued` (`queued → sent`, inside `BEGIN IMMEDIATE`), and edit/delete guarded by `WHERE status <> 'sent'`. A transition that skips a state is unwritable through the API, and the CHECK constraints back it at the SQL layer.
- **Only fresh annotations queue.** `draft → queued` requires a freshness witness: the TUI computes `Freshness` against live disk and passes the current `ContentHash`; `queueAllDrafts` re-verifies `anchor_hash` matches per row and skips (reports) mismatches. Stale drafts must first be re-anchored (`reanchorAnnotation`, §6.6) or deleted — sending comments about code that no longer exists is unrepresentable in the normal flow (the claim-time race note in §7 covers the one unavoidable window).
- **Round-trip law**, property-tested: for every domain value `v`, `parseRow(writeRow(v)) ≡ Ok(v)`. Golden fixture: a committed `fixtures/v1.db` built by the schema's own DDL; tests parse it, and a schema refactor that changes the on-disk shape must fail the golden test, not a downstream consumer.
- **Append-only migrations.** `schema.ts` exports `migrations: readonly string[]`; `meta.schema_version` = number applied. Old migrations are never edited; new ones are appended. A fresh DB and a migrated DB must produce byte-identical normalized `sqlite_master` SQL (tested).
- **Structured errors.** Store operations return typed results (`ChainBreak {atSeq, expected, found}`, `Busy`, `CorruptRow {table, id, field}` …) — matchable and testable, never bare strings. The extension logs them; the TUI displays them in the status bar.
- **Pure core, effects at the edge.** Hashing, diff-model construction, blame replay, message formatting, row parse/print, and coordinate mapping are pure functions of values. IO is confined to named edge modules: `store.ts` (the `node:sqlite` connection), extension hook bodies, `cli.ts`/`term.ts`/`mouse.ts`, and the TUI effect runner. `schema.ts`, `rows.ts`, `format-message.ts`, and all of `render/*` import neither `node:fs` nor `node:sqlite` — enforced by an import-direction lint, not convention.

### 4.2 `PatchStore` (shared data-access class, `packages/store`)

Used identically by both processes; all methods are single-statement or short-transaction, synchronous (`DatabaseSync`).

- Lifecycle: `PatchStore.open(dbPath, {create?: boolean})`, `close()`.
- Writer (extension): `upsertSession(id, cwd, sessionFile)`, `touchSession(id)`, `endSession(id)`, `forkSession(fromId, toId)` (row-copy `files` + `patches` + `annotations` with `file_id` remap; sets `parent_session_id`), `ensureFile(sessionId, absPath, relPath, baseline: Baseline, tool)`, `addPatch({...})`, `claimQueued(sessionId, batchId)` — **one `BEGIN IMMEDIATE` transaction**: `SELECT ... WHERE status='queued'` → `UPDATE ... SET status='sent', batch_id=?, sent_at=?` → return rows.
- Writer (TUI): annotation CRUD (`addAnnotation` — takes an `Anchor`, `updateAnnotation` (comment text), `reanchorAnnotation(id, newAnchor, newSnippet)` — the only way to move an annotation between versions, `deleteAnnotation` — non-`sent` only), `queueAllDrafts(sessionId, freshnessByFile)`.
- Reader: `listSessions()`, `latestLiveSession()` (newest `ended_at IS NULL`, falling back to newest `last_event_at`), `getFiles(sessionId)`, `getPatches(sessionId, fileId?)`, `getAnnotations(sessionId, status?)`.
- Signaling: `dataVersion()` → `PRAGMA data_version`.

### 4.3 DB discovery (`discover.ts`)

Priority: `--db <path>` flag → `PI_PATCHES_DB` env → walk up from `process.cwd()` looking for `.pi/patches/patches.db`. Session selection: `--session <id-prefix>` → `PI_PATCHES_SESSION` env → `latestLiveSession()`. `pi-review --list` prints all sessions (id, started, #files, #patches, live/ended).

---

## 5. Recorder extension (`packages/extension`)

Entry point: default-exported factory `(pi: ExtensionAPI) => void` (`extensions/types.ts:1423-1424`). **No resources opened in the factory** — pi may invoke factories in runs that never start a session (`docs/extensions.md:219-224`). All state lives in a module-level holder, created in `session_start` and nulled in `session_shutdown`; **every hook guards on the holder existing** (shutdown fires on quit/reload/new/resume/fork and signals, possibly more than once — handlers must be idempotent).

```ts
interface State {
  store: PatchStore;
  sessionId: SessionId;
  seq: Seq;                                      // MAX(seq)+1 at open
  preImages: Map<string /*toolCallId*/, { absPath: string; content: string | null }>;
  pollTimer: NodeJS.Timeout;
  lastDataVersion: number;
  sending: boolean;
}
```

### 5.1 Hook wiring

**`session_start`** (`types.ts:546-552`; reasons `startup|reload|new|resume|fork`):
1. `mkdir -p <ctx.cwd>/.pi/patches`; `PatchStore.open(..., {create: true})`.
2. `upsertSession(ctx.sessionManager.getSessionId(), ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionFile())`.
3. Reason handling: `startup|new|reload` → fresh/`touch`; `resume` → same uuid, row exists, just `touchSession` (**the DB is the state; nothing to rebuild** — pi does not replay tool events on resume, verified); `fork` → parse parent session id from `event.previousSessionFile` basename (session files are named `<timestamp>_<sessionId>.jsonl`, `session-manager.ts:846-847`) and `forkSession(parentId, newId)` so the fork inherits the cumulative diff; if unparseable, start fresh and log.
4. Start the submitter poll timer (§5.2).

**`tool_call`** (fires before execution; `types.ts:865-873`): for `edit` and `write` only (`isToolCallEventType`, `types.ts:977-990`): resolve `input.path` against cwd, read the file (`null` on ENOENT), `preImages.set(event.toolCallId, {absPath, content})`. Memory-only; entries for blocked/failed calls are dropped on the matching `tool_result` or on `agent_end`.

**`tool_result`** (`types.ts:875-932`; completion order under parallel tools — safe because pi serializes per-file via `withFileMutationQueue`, `edit.ts:312` / `write.ts:203`):
- Skip if `event.isError`.
- **edit** (`isEditToolResult`): `details: EditToolDetails = { diff, patch, firstChangedLine }` (`core/tools/edit.ts:61-68`, populated at `edit.ts:350-360`). First touch → `ensureFile` with baseline = pre-image content. Then `addPatch({tool:'edit', unified_patch: details.patch, display_diff: details.diff, first_changed_line: details.firstChangedLine, tool_call_id, pre_hash, post_hash})`. `post_hash` = hash of pre-image with `details.patch` applied — or, simpler and adequate, hash of a fresh disk read (safe: pi's mutation queue has completed this file's write).
- **write** (`isWriteToolResult`): `details` is `undefined` **by design** (`write.ts:184,223-224` — write never reads the old file). Compute everything: `pre = preImages.get(toolCallId)?.content ?? null`; `post = event.input.content` (`tool_result` events carry `input`, `types.ts:875-881` — no disk read needed); `unified = generateUnifiedPatch(absPath, pre ?? "", post)`; `{diff, firstChangedLine} = generateDiffString(pre ?? "", post)`. First touch → `ensureFile` with `baseline = pre`, `baseline_missing = (pre === null)`.
- Both: `touchSession`, delete the `preImages` entry.

**`session_shutdown`** (`types.ts:593-598`): idempotent — `clearInterval`, `endSession`, `store.close()`, holder = null.

**Not hooked:** `bash` (user decision — live-disk diffing covers tracked files; the v2 working-tree adapter covers files with no recorder baseline, §10.4), renames/deletes.

### 5.2 Annotation submitter

Every 1000 ms (skipped while `sending`):
1. `v = store.dataVersion()`; if unchanged, return.
2. `rows = store.claimQueued(sessionId, randomUUID())` — atomic claim; empty → return.
3. `msg = formatBatch(rows)` (§7).
4. Deliver: `ctx.isIdle() ? pi.sendUserMessage(msg) : pi.sendUserMessage(msg, { deliverAs: "steer" })`. The `deliverAs` guard is mandatory — `sendUserMessage` **throws** if called mid-stream without it (`agent-session.ts:1043-1046`). When idle it triggers a new turn; as steer it is delivered after the current tool calls, before the next LLM call (`docs/extensions.md:1356-1360`).

Crash-window semantics: rows are marked `sent` inside the claim transaction, *before* the send call. A crash between claim and send loses at most one batch (visible: `sent` rows with a `batch_id` the user never saw answered). Chosen over the opposite order, which risks duplicate delivery. The TUI surfaces `sent` batches, so a lost batch is recoverable by re-annotating (v1-acceptable; see §9).

### 5.3 Commands

- **`/patches`** — report the current session id, recorder counts, and `Open review: /patches connect <session-id>`.
- **`/patches connect <session-id-or-prefix>`** — resolve the session inside the current project's patch DB, open an independent read/write store connection, load `AppState`, and pass `createReviewComponent(...)` to `ctx.ui.custom()`. `q` calls the custom UI's `done`; component disposal clears timers/watchers/overlays, and the command closes only its independent DB connection. It must not stop pi's shared `TUI`.
- **`/patches inspect [source...]`** (v2) — open the source selector when no source arguments are supplied, or directly materialize a checked non-session source (§10.4). This remains distinct from `connect`, whose argument is always a recorded pi session id/prefix.
- **`/patches analyze`** (v2) — from an open dataset, choose model and exactly one analysis mode (`narrative` or `implementationReview`) and show the persisted result in the terminal interface (§10.6). Direct non-interactive argument forms may be added, but the TUI selector is the owning interaction.

The extension never registers `/review` and never launches another process or terminal window.

---

## 6. Review component and standalone app (`packages/review-app`)

### 6.1 Boot & terminal contract

**Embedded path (default):** `/patches connect` resolves the DB/session and loads state before calling `ctx.ui.custom()`. The factory receives pi's already-running `TUI`, returns `createReviewComponent(...)`, and reserves two terminal rows for pi's footer. The component may call `tui.requestRender()` and use overlays, but it must not call `tui.start()`, `tui.stop()`, enter an alternate screen, change raw mode, or install process-level signal/resize handlers. Its idempotent `dispose()` owns only component-local intervals, file watchers, input listeners, and overlays.

**Standalone compatibility path:** `cli.ts` parses argv (`--db`, `--session`, `--list`, `--help`) → discovers DB/session (§4.3) → calls **`initTheme()`** → opens `PatchStore` → installs process cleanup → enters terminal modes → builds the same reusable component → starts its own `TUI`.

Standalone-only terminal modes (`term.ts`):
- **Enter:** `\x1b[?1049h` (alt screen — pi-tui itself never uses it; it renders inline into scrollback, verified no `?1049` in the package) → `tui.start()` (raw mode, bracketed paste, kitty keyboard protocol negotiation with `modifyOtherKeys` fallback — all free from `ProcessTerminal`, `terminal.ts:134-167,220,320`) → `\x1b[?1002h\x1b[?1006h` (SGR mouse + drag tracking; pi-tui has **no** mouse support of its own, verified).
- **Exit** — one idempotent `cleanup()` wired to quit, `SIGINT`, `SIGTERM`, `uncaughtException`, and `process.on("exit")`: `\x1b[?1002l\x1b[?1006l` → `tui.stop()` (restores cursor/raw/bracketed-paste, pops kitty protocol, drains input — `terminal.ts:406-452`) → `\x1b[?1049l`. Every exit path routes through `cleanup()`; no bare `process.exit` elsewhere.

In standalone mode the component renders exactly `stdout.rows` lines. In embedded mode it renders `max(3, tui.terminal.rows - reservedFooterRows)` lines so pi's footer remains on screen. Every composed line must pass through an ANSI-aware width clamp — pi-tui throws on any line wider than the terminal (`tui.ts:1520-1546`).

### 6.2 Layout & components

`AppRoot` (single `Component` implementing the fixed grid; overlays via `tui.showOverlay`, whose focus stack handles input routing, `tui.ts:493`):

```
┌ files (max(24, 30%)) ┬ diff pane ──────────────────────────────┐
│ ▸ src/               │  src/store.ts   cumulative · syntax     │
│   ● store.ts  +42 -7 │   12  12  const db = new DatabaseSync(  │
│     cli.ts    +3  -0 │   13  13─ db.exec("journal_mode=WAL")   │
│   … (windowed)       │   --  14+ db.exec("PRAGMA journal_…")   │ ← add/del bg tint,
│                      │  ~~~~~~~~~~ selection = selectedBg ~~~~ │   hljs fg colors
├──────────────────────┴─────────────────────────────────────────┤
│ status: session 0197… · 5 files · 12 patches · 2 drafts  ?=help│
└────────────────────────────────────────────────────────────────┘
```

- **File tree pane** — windowed list of changed files grouped by directory, per-file `+adds -dels`, `●` marker when the file has annotations, `∅` when currently missing on disk. Windowing modeled on pi's `TreeList` (`modes/interactive/components/tree-selector.ts:667-674,1322` — the reference for scroll-window math and horizontal pan via `sliceByColumn`).
- **Diff pane** — the selected file's diff, two view modes (§6.4), cursor row + visual selection + annotation markers in a gutter column.
- **Status bar** — session, counts, pending-key indicator, transient confirmations ("Submit 3 comments? y/n").
- **Overlays** — help (keymap), comment editor (§6.6), annotation list.

### 6.3 State & refresh

```ts
interface AppState {
  files: FileState[];                    // FileState = { row, baseline, current, currentHash, diffModel? }
  selectedFile: number;
  focusedPane: "tree" | "diff";
  view: "cumulative" | "history";        // history = individual patches
  renderMode: "syntax" | "native";       // native = pi's renderDiff verbatim
  patchIdx: number;                      // history view
  cursorRow: DiffRow; scrollTop: { tree: number; diff: number };
  mode: Mode;
  selection: { anchor: DiffRow; head: DiffRow } | null;
  annotations: Annotation[];                             // checked domain values, not rows
}

// One constructor per legal UI state — overlay/confirm are modes, not boolean flags:
type Mode =
  | { kind: "normal" } | { kind: "visual" }
  | { kind: "confirmSubmit"; count: number }
  | { kind: "overlay"; which: "help" | "annotations" | { editor: AnnotationDraft } };
```

The comment-editor overlay hosts pi-tui's stateful `Editor` component — that is edge/IO territory; the reducer sees only `overlayResult` events (save/cancel with the final text), never keystrokes bound for the editor.

Refresh triggers: DB `data_version` poll at 400 ms (new patches/files/annotation-status changes → reload rows, invalidate affected `FileState`); debounced `fs.watch` per tracked file (live-disk re-read → recompute cumulative diff — this is how bash edits appear); `r` = manual full refresh.

**Architecture: pure reducer, effect edge.** All inputs are parsed into one closed event sum, and the app is a total function over it:

```ts
type AppEvent =
  | { kind: "key"; key: KeyId } | { kind: "mouse"; ev: MouseEvent }
  | { kind: "dbChanged"; snapshot: DbSnapshot } | { kind: "fileChanged"; path: string; content: string | null }
  | { kind: "resize"; cols: number; rows: number } | { kind: "tick" };

update : (AppState, AppEvent) → { state: AppState; effects: Effect[] }   // pure, exhaustive match
// Effect = WriteAnnotation | QueueDrafts | ReadFile | Quit | …  — executed by runner.ts
render : (AppState, width, height) → string[]                            // pure
```

Unknown input sequences parse to *no* event (dropped explicitly), so `update` never sees raw bytes. This makes the whole UI unit-testable without a terminal — feed events, assert states — with the VirtualTerminal smoke test only covering the real IO shell. Mode-dependent keys (`normal` vs `visual` vs overlay) are dispatched by exhaustive match on the mode sum; adding a mode is a compile error at every dispatch site, not a runtime surprise.

### 6.4 Diff model & rendering

**Model** (`render/diff-model.ts`): `Diff.structuredPatch(baselineOr"", currentOr"", {context: 3})` → flat row array `{ kind: "hunk"|"context"|"add"|"del", oldLine?: BaselineLine, newLine?: CurrentLine, text, attribution?: Attribution }` (§4.1 types). `newLine` is the coordinate a new annotation's anchor range is built from (at creation time the anchor version *is* the current version, so `AnchorLine` = `CurrentLine` by the freshness witness). Selections spanning `del` rows snap to the enclosing new-file range (nearest rows carrying `newLine`); a pure-deletion selection anchors to the preceding `newLine` with the deleted text as the snippet.

**Line attribution (session blame)** (`render/blame.ts`): each `add`/`del` row carries the `seq` of the patch that caused it, computed by replaying the file's stored `unified_patch` chain from `baseline_content` with `Diff.applyPatch`:
- Maintain `Array<{ line: string; seq: number | 0 }>` (0 = baseline). Applying patch `seq`: removed lines are dropped and recorded in a deletion map `origBaselineLine → seq` (only lines that trace back to baseline matter — cumulative `del` rows are by definition baseline lines); added lines enter the array with `seq`.
- After the replay, cumulative `add` rows look up attribution by current line number; `del` rows by baseline line number in the deletion map.
- **Chain validation:** before applying patch `seq`, compare `hash(replayState)` with the stored `pre_hash`. On mismatch (bash modified the file between patches) reconcile by diffing `replayState` against the next patch's implied pre-image is *not* attempted — instead the replay restarts from that patch's post-state (reconstructable from the following patch's pre-image or, for the last patch, disk) and all rows whose attribution was lost degrade to the nearest known `seq`. If the chain is unrecoverable, the file degrades to uniform (most-recent) tinting — never wrong colors, just less information.
- **External changes:** after replaying all patches, if `hash(replayState) ≠ currentHash`, rows produced by diffing `replayState` vs disk are attributed `seq = "external"` (bash/manual edits) and render in the most-recent bucket with a `~` gutter marker.
- Cached per `(baselineHash, lastPatchId, currentHash)`; incremental — a new patch appends one replay step.
- **The replay is a fold with stated laws.** `step : (FileVersion, Patch) → Result<FileVersion, ChainBreak>` where `FileVersion = { lines: Array<{text, attribution}>, hash }`; `blame = foldM(step, fromBaseline(file))`. Laws, kept as executable tests:
  1. *Chain integrity:* `step(v, p)` succeeds iff `v.hash === p.pre_hash`, and then `result.hash === p.post_hash` (the store's hashes are the proof obligations; a violation is a structured `ChainBreak`, never a wrong answer).
  2. *Attribution totality:* every `add`/`del` row of the cumulative diff receives exactly one `Attribution`.
  3. *Model agreement:* the incremental (cached) blame equals the naive full-replay blame on every update — the naive version is kept in the codebase as the executable reference model and the two are property-tested against generated patch chains (including chains with injected external edits and breaks).

**Syntax mode** (default): per visible row —
1. Gutter `±NNNN │` colored with `theme.fg("toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext")` (same tokens pi's own diff renderer uses, `diff.ts`).
2. Content from the highlight cache: `highlightCode(entireFileContent, getLanguageFromPath(path))` split into lines — current-version lines for `add`/`context` rows, baseline-version lines for `del` rows.
3. **Recency-gradient background tint** applied with the vendored `applyBackgroundToLine`, using our own SGR constants (truecolor + 256-color fallback) — pi's theme has **no** diff-background tokens (its `ThemeBg` union is selection/message/tool backgrounds only, `theme.ts:154-160`). **Verified safe to compose:** `theme.fg` and `highlightCode` emit `\x1b[39m` (fg-only reset, `theme.ts:354`) — never `\x1b[0m` — so a row-level background survives intra-line syntax colors.
   - The tint intensity encodes **change recency**: additions run light-green → saturated green, deletions light-pink → saturated red; the most recent changes are fully saturated.
   - `t = rank(row.seq) / (distinctSeqCount − 1)` where ranks are the **normalized order** of the distinct patch `seq`s contributing rows to the current file view (oldest = 0, newest = 1; single-patch files render fully saturated; `seq = "external"` counts as newest).
   - Color = `lerpRgb(lightEndpoint, fullEndpoint, t)` per theme variant — dark theme endpoints keep background lightness low enough that hljs foreground colors stay readable (e.g. adds `#1c2e1c → #145214`, dels `#331f24 → #67161f`); light theme uses literal light-green→green (`#e6f7e6 → #7ddc7d`) and light-pink→red (`#fdeef0 → #f5919e`). Endpoints are constants in `render/ansi.ts`, quantized to the 256-color cube when truecolor is unavailable.
   - The diff pane header shows a legend: `old ░▒▓█ new`.
   - Gradient applies to syntax mode only; native mode is pi's verbatim `renderDiff` (uniform colors by design). `t` key cycles tint: `gradient → uniform → off`.
4. Selection rows override the tint with `theme.getBgAnsi("selectedBg")`; annotated ranges get a `●` gutter marker, external (bash/manual) changes a `~` marker.

**Native mode** (`d` toggles): `renderDiff(displayDiff, {filePath})` verbatim — pixel-identical to pi's chat rendering, including intra-line word-diff inverse. Cumulative native view feeds `generateDiffString(baseline, current).diff` into it; history view feeds the stored `display_diff` per patch.

**History view** (`H` toggles): the selected file's patches in `seq` order, one at a time (`n`/`p`), header `patch 3/7 · edit · 14:02:31`, rendered in native mode.

**Caches** (all keyed by content hash, sha256 computed once per read): highlighted-lines LRU (~20 versions ≈ current+baseline per file), diff model per `(baselineHash, currentHash)`, `renderDiff` output per patch id. Composition of the ~50 visible rows happens per frame, uncached — string concat of pre-rendered pieces, well under a millisecond; pi-tui coalesces renders to ~60 fps and wraps frames in synchronized-output (`\x1b[?2026`, `tui.ts:1286-1308`), so the app stays flicker-free.

### 6.5 Input

**Keyboard** (decoded by pi-tui: kitty CSI-u protocol with legacy fallback; match via `matchesKey(data, "ctrl+d")` etc., `keys.ts:820`):

| Key | Action | Key | Action |
|---|---|---|---|
| `j` / `k` / arrows | cursor down/up | `v` | visual-line mode (Esc cancels) |
| `gg` / `G` | top / bottom (pending-key, 500 ms) | `c` | comment on selection (or cursor line) |
| `ctrl+d` / `ctrl+u` | half-page | `a` | annotation list overlay |
| `ctrl+e` / `ctrl+y` | scroll one line | `e` / `x` | edit / delete annotation (non-sent) |
| | | `u` | re-anchor stale annotation onto current patch |
| `h` / `l`, `tab` | pane focus | `S` | submit: all drafts → queued (y/n confirm) |
| `[` / `]` | prev / next file | `H` | cumulative ⇄ history view |
| `{` / `}` | prev / next hunk | `d` | syntax ⇄ native render mode |
| `n` / `p` | prev / next patch (history) | `t` | tint cycle: gradient → uniform → off |
| `enter` | tree → focus diff | `r` | refresh |
| `q` | quit (Esc unwinds modes first) | `?` | help overlay |

**Mouse** (`mouse.ts`): registered via `tui.addInputListener` (runs before focus dispatch, `tui.ts:649`); pi-tui's `StdinBuffer` already reassembles split SGR sequences into whole chunks (`stdin-buffer.ts:102-120`), so matching `^\x1b\[<(\d+);(\d+);(\d+)([Mm])$` per chunk is reliable. Consumed sequences never reach focused components.
- The embedded component enables SGR button-motion and coordinate reporting on entry (`1002` + `1006`) and disables exactly those modes on disposal. It does not assume pi or Ghostty has already enabled mouse reporting, and it never changes raw mode, alternate-screen state, or the keyboard protocol.
- Button 0 press → hit-test against the two-row header and live pane geometry: tab label = switch view; tree row = select the exact visible file (`treeScrollTop + row`); diff row = move to the exact visible line (`diffScrollTop + row`). Blank body rows and the status row never snap to the last file or line.
- Motion flag (bit 32) while left button held → extend selection (auto-enters visual mode); release (`m`) finalizes.
- Wheel (64/65, including modifier bits) → scroll only the pane or full-width result view under the pointer by a viewport-adaptive step, clamped independently for the file tree, diff, Notes, Narrative, and Review views. Multiple SGR events arriving in one terminal input chunk are all decoded in order.

### 6.6 Comment entry & annotation list

`c` opens an overlay hosting pi-tui's `Editor` (full multiline editing, undo, kill-ring) with header `<rel_path>:<start>-<end>` and the selected snippet shown above. `Esc` cancels; `ctrl+s` saves an annotation with `status='draft'` and an **anchor pinned to the version on screen**: `anchor_patch_id` = the file's newest patch id (NULL if only the baseline exists), `anchor_hash` = hash of the current disk content (which is the patch's `post_hash` unless external edits are present), range in that version's coordinates, snippet = the anchored lines.

**Staleness display.** Freshness is recomputed on every refresh (it is derived data, §4). Stale annotations are visually distinct everywhere they appear: dimmed `⚠` gutter marker in the diff pane and a badge in the annotation list — `⚠ stale · anchored @ patch 3, file now @ patch 7 (+external)` — with the anchored snippet shown verbatim so it's obvious *what* the comment was about even though the code moved on.

**Re-anchor or remove.** On a stale annotation, `u` attempts to **update it onto the current patch** by mapping its range through the recorded history — this is exact, not heuristic, because every intervening version is stored: `mapRange(range, patch)` shifts lines before/after each hunk by that hunk's delta and flags a **conflict** when a hunk overlaps the range; `mapThroughChain = mapRange` composed over `anchor_patch_id+1 … head` plus the external diff, if any.
- **Clean mapping** → `reanchorAnnotation(id, {patchId: head, hash: currentHash, range: mapped}, newSnippet)`; the annotation is fresh again, pinned to the current patch.
- **Conflict** (the commented lines were themselves rewritten) → the comment editor reopens at the best-guess location showing old snippet vs. current lines; the user adjusts the selection/text and saves (a re-anchor), or deletes with `x`. No silent re-pointing, ever.

The annotation list overlay (`a`) is a windowed list with status glyphs (`○ draft · ◐ queued · ● sent`) plus the staleness badge; `enter` jumps to the annotation's location (fresh: exact; stale: best-guess mapped row); `e` edits text, `u` re-anchors, `x` deletes.

`S` prompts `Submit N comments? (y/n)` in the status bar — **fresh drafts only**; if stale drafts exist it warns `2 stale annotations need update (u) or removal (x)` and excludes them. `y` → `queueAllDrafts(...)`. Delivery is the extension's job (§5.2); the TUI shows the status flip to `sent` on its next poll.

---

## 7. Batch message format (`format-message.ts`)

One user message per submitted batch, items ordered by file then `start_line`:

````markdown
Code review feedback on this session's changes (3 comments). Address each item,
then briefly state what you changed per item number.

## 1. src/store.ts:42-48
```ts
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
```
The connection leaks if the pragma throws — wrap in try/finally or close on error.

## 2. src/cli.ts:107
```ts
  process.exit(0);
```
Exiting here skips the alt-screen restore; route through cleanup().

## 3. packages/store/src/schema.ts:12-19
(note: this file changed after the comment was written; the snippet shows the commented version)
```sql
CREATE TABLE annotations (
  ...
```
Add ON DELETE CASCADE here too.
````

Rules:
- Header: `## <n>. <rel_path>:<start>` or `:<start>-<end>`.
- Fence language from `getLanguageFromPath(rel_path)`; fences widened if the snippet contains backticks.
- Snippet = the stored anchor-version snapshot (what the reviewer actually saw).
- **Staleness (race window only):** the TUI refuses to queue stale drafts (§6.6), so at claim time annotations are normally fresh. If the model edited the file *between* queueing and claiming, the extension detects `anchor_hash` ≠ current disk hash and emits the parenthesized staleness note with the anchored patch number ("anchored @ patch 3; file has changed since"). It never re-points a comment itself — curation is the reviewer's job, in the TUI.

In v2, agent-audience findings retain this numbered format but are grouped P0→P3.
Human-audience findings and callouts appear under `Human Reviewer Callouts
(Non-Blocking)` and are excluded from fix intent. Verdict and source fingerprint
are batch-level metadata, not repeated on every item (§10.2-§10.3).

---

## 8. Verification plan (per implementation phase)

**Phase 0 — scaffold.** `nix develop` → `node -v` = v24.x; `npm install`; `npm run typecheck` green.

**Phase 1 — store + recorder.** Unit tests (`node --test`, tmp DBs): row⇄domain round-trip property (`parseRow(writeRow(v)) ≡ Ok(v)` over generated domain values), golden `fixtures/v1.db` parse, rejection tests (rows violating each CHECK constraint fail at the SQL layer; corrupt rows parse to structured `CorruptRow` errors), illegal status transitions unwritable through the API, baseline capture, seq monotonicity across reopen (UNIQUE constraint), `forkSession` copies, `claimQueued` atomicity from two connections, `data_version` cross-connection signaling. Integration, in a scratch project:
```
pi -e …/packages/extension/src/index.ts -p "create hello.txt containing 'hi', then edit it to say 'hello world'"
sqlite3 .pi/patches/patches.db "SELECT tool, seq, first_changed_line FROM patches ORDER BY seq"
```
Expect `write` (seq 1, file row with `baseline_missing=1`) then `edit` (seq 2); the stored `unified_patch` applies cleanly to the stored baseline **and reproduces `post_hash`** (chain-integrity law on real data); resuming the session (`pi -c`) and editing again appends seq 3 under the **same** session id.

**Phase 2 — read-only TUI.** Pure-core unit tests first (no terminal, no DB): blame laws — chain integrity, attribution totality, and incremental-vs-naive model agreement on generated patch chains (§6.4); reducer tests — event sequences into `update` assert resulting `AppState` (visual-mode entry/exit, selection snapping over `del` rows, mode unwinding on Esc, submit confirmation flow). Then, interactively inside pi: `/patches connect <id>` shows tree + diff; `d` (native mode) output visually matches pi's own edit rendering in the chat; a live edit appears in ≤ 0.5 s; a `sed -i` bash edit to a tracked file appears via fs.watch **and renders fully saturated with a `~` marker (external = newest)**; on a file edited by three successive patches, the three change regions show visibly increasing tint saturation in patch order, and the newest patch is fully red/green; window resize re-lays out; `q` restores pi's editor and footer without stopping or corrupting the shared terminal. Repeat the rendering/cleanup smoke through standalone `pi-review` for compatibility.

**Phase 3 — mouse + annotations.** Drag-select 3 lines → `c` → type → `ctrl+s`; `sqlite3 … "SELECT anchor_patch_id,start_line,end_line,status FROM annotations"` shows the draft pinned to the file's head patch; close/reopen `/patches connect` → annotation reloads fresh; wheel scrolls the hovered pane where mouse input is available; deletion-row selection snaps per §6.4. **Staleness lifecycle:** annotate a line, let pi edit elsewhere in the file → `u` re-anchors cleanly (range shifts by the hunk delta, verified against the visible line); annotate a line, let pi rewrite that exact line → annotation shows the stale badge, `u` reports a conflict and opens the editor, `x` deletes; `S` with a stale draft present warns and excludes it. Pure-core tests: `mapRange`/`mapThroughChain` laws — composition over the chain equals direct anchor-vs-head mapping when clean; conflict iff some hunk overlaps the range; on clean maps, extracting the mapped lines from the head version yields text consistent with the per-patch line movements (property-tested on generated chains).

**Phase 4 — submit end-to-end.** With pi idle: `S`/`y` → message arrives as a user turn, model addresses numbered items, rows flip to `sent` with one shared `batch_id`, TUI reflects it. With pi mid-stream: delivered as steer without throwing. Double-`S` race produces exactly one batch (claim transaction).

**Phase 5 — embedded integration and polish.** `/patches` reports the current id and `/patches connect <id-or-prefix>` opens the reusable component through `ctx.ui.custom()`. Component disposal clears only owned timers/watchers/listeners; `q` restores pi's editor/footer. Prove no terminal-launch commands or `/review` registration exist. Help overlay complete; standalone `pi-review --list` remains compatible; README reflects the embedded default.

---

## 9. Risks & open questions

1. **Version skew with the installed pi.** The review app pins `pi-coding-agent@0.80.2` for `renderDiff`/theme; if the user's pi upgrades, `details.diff`/`patch` shapes or theme tokens could drift. Mitigations: the durable artifact is the raw unified patch (tool-agnostic); pins are updated deliberately. The extension side is immune (jiti resolves pi's own live instance).
2. **Annotation coordinate drift — largely closed by patch anchoring.** Annotations are pinned to an exact stored version (`anchor_patch_id` + `anchor_hash`), staleness is derived, re-anchoring maps ranges exactly through the recorded patch chain, and stale drafts cannot be queued (§4.1, §6.6). Residual risk is only the queue→claim race, which degrades to an explicit staleness note (§7) — never a silently wrong location.
3. **Embedded height/input ownership.** pi retains footer rows and owns raw mode, keyboard negotiation, and terminal lifecycle. The review component reserves the footer, never starts/stops the shared `TUI`, and removes its input listeners/overlays on disposal. The component explicitly brackets SGR mouse reporting for its own lifetime, so Ghostty wheel, click, and drag input works without terminal-specific setup; keyboard review remains fully supported.
4. **Claim/send crash window.** At most one batch can be marked `sent` but never delivered (§5.2). v2 option: a `delivering` intermediate status with recovery on next `session_start`.
5. **`session_shutdown` multiplicity & stale contexts.** Shutdown fires for quit/reload/new/resume/fork and signals; handlers are idempotent and every hook guards on live state. Captured `pi`/`ctx` are invalid after session replacement (`docs/extensions.md:1183-1224`) — the extension only uses the `ctx` passed to the current event.
6. **Bash-only files in session source.** They remain absent from the recorded-session adapter when pi never touched them. The v2 working-tree adapter covers them without inventing patch provenance or inserting synthetic `first_tool` values (§10.4).
7. **`node:sqlite` maturity.** Stable enough on Node 24 (pi's runtime); the API surface used is minimal (`DatabaseSync`, prepared statements, `exec`). If a wall is hit, the `PatchStore` interface isolates a swap to `better-sqlite3`.
8. **Model/provider capability drift.** Available model ids, thinking levels, context limits, and streaming APIs can change with pi/provider versions. `ModelRunner` is a capability boundary; every run records the resolved model and prompt version, and unsupported selections fail before any completed run is stored.
9. **Large or adversarial histories.** Git ranges and session diffs may exceed one model context or make full diff construction expensive. Deterministic hierarchical planning, explicit coverage, immutable fingerprints, and viewport-bounded caches are acceptance requirements (§10.7), not optional optimizations.

---

## 10. v2 review sources, structured findings, and model analysis

This section incorporates the useful product semantics from Earendil's default
`pi-review` extension without adopting its `/review` command or session-tree
workflow. Reference inspected: `earendil-works/pi-review` commit
`6557ef20e2376b9606a814cd9b485bbcd82e2e30`.

### 10.1 Locked semantics

1. **One terminal interface.** Every interactive operation stays under `/patches`
   and uses pi's embedded custom UI. No source or analysis mode launches a child
   terminal, changes the active worktree, or registers `/review`.
2. **Source, history, and task are independent dimensions.** A selected source
   determines which bytes changed; history mode determines whether those bytes
   are viewed as one net change or as an ordered commit sequence; analysis mode
   determines what the selected model is asked to produce.
3. **Two model tasks only.** `narrative` explains all selected changes.
   `implementationReview` evaluates the implementation for defects. Neither mode
   may silently append the other mode's output.
4. **Explicit model selection.** Every run records provider, model id, and
   thinking level. The current pi model may be preselected, but the user confirms
   or changes it before execution.
5. **Coverage is observable.** A successful run records which files and commits
   were presented to the model. Context-window pressure may cause chunking, never
   silent omission.
6. **Outputs are immutable evidence.** A completed model run is stored with its
   source fingerprint, prompt version, model selection, focus instructions,
   coverage, timestamps, and output. Re-running creates a new row.
7. **Mouse interaction is first-class.** In Ghostty and other SGR-capable
   terminals, scrolling is pane-local and viewport-aware, file and tab clicks map
   to the exact visible row, line clicks preserve diff coordinates under scroll,
   and drag selection remains usable. Every mouse mode enabled by the component is
   disabled when it returns to pi.

### 10.2 Findings, callouts, and verdict

Review notes gain typed disposition metadata:

```ts
type Priority = "P0" | "P1" | "P2" | "P3";
type ReviewNoteRole =
  | { kind: "finding"; priority: Priority; audience: "agent" | "human" }
  | { kind: "callout"; audience: "human" };
type Verdict = "correct" | "needsAttention";

type ReviewOutcome = {
  sourceFingerprint: SourceFingerprint;
  verdict: Verdict;
  recordedAt: number;
};
```

`callout + agent`, `callout + priority`, and a finding without a priority are
illegal states. The SQL migration mirrors the sum with `kind`, `priority`, and
`audience` columns plus a `CHECK` that admits exactly the cases above. Existing
annotations migrate to `{kind:"finding", priority:"P2", audience:"agent"}`.

The TUI exposes priority and audience while creating/editing a note, displays
priority in the diff gutter and annotation list, and orders findings by priority,
then file/range/id. Human callouts render in a separate non-blocking section.
They are never turned into fix instructions merely because they exist.

Verdict belongs to the reviewed source fingerprint, not to an individual note or
pi session. `correct` is valid only when there are no unresolved findings of any
priority; human callouts alone do not change the verdict. The store API enforces
this invariant when recording an outcome.

### 10.3 Finish-review actions

`q` closes immediately when there are no unsaved/unsent notes. Otherwise it opens
an embedded finish selector:

1. **Return without submitting** — preserve drafts and return to pi.
2. **Submit feedback and return** — queue fresh agent-audience findings; preserve
   human callouts separately; stale findings remain drafts and are reported.
3. **Submit and ask pi to fix findings** — queue the same fresh agent findings and
   add an explicit fix intent to the delivered batch. The agent receives findings
   in P0→P3 order and must report fixed/deferred items plus verification.
4. **Cancel** — return to the review component.

This is not an `/end-review` command and does not navigate pi's session tree.
The existing annotation state machine and freshness checks remain authoritative;
the finish selector cannot bypass `draft → queued → sent` or send stale notes.

### 10.4 Review sources and history

The renderer consumes one checked dataset rather than SQL/Git/GitHub-specific
records:

```ts
type ReviewSource =
  | { kind: "session"; sessionId: SessionId }
  | { kind: "workingTree"; base: "HEAD" }
  | { kind: "branch"; baseRef: string; headRef: string }
  | { kind: "commit"; sha: string }
  | { kind: "commitRange"; baseExclusive: string; headInclusive: string }
  | { kind: "pullRequest"; number: number; baseRef: string; headRef: string }
  | { kind: "snapshot"; paths: NonEmptyArray<string> };

type HistoryMode = "squashed" | "perCommit";

type ReviewDocument = {
  id: DocumentId;
  path: string;
  relPath: string;
  baseline: Baseline;
  head: { content: string | null; hash: ContentHash };
  provenance: readonly Attribution[];
};

type CommitChange = {
  sha: string;
  parents: readonly string[];
  subject: string;
  authoredAt: number;
  documents: readonly DocumentId[];
};

type ReviewDataset = {
  source: ReviewSource;
  historyMode: HistoryMode;
  fingerprint: SourceFingerprint;
  documents: readonly ReviewDocument[];
  commits: readonly CommitChange[];
};
```

`HistoryMode.perCommit` is accepted only for sources with a non-empty Git commit
sequence (`branch`, `commitRange`, and pull requests; a single `commit` is a
one-element sequence). `workingTree`, `snapshot`, and session patch history use
their native history views and cannot masquerade as Git commits.

Adapters live at effect boundaries:

- **Session:** existing SQLite baseline/current/patch chain and exact attribution.
- **Working tree:** staged, unstaged, deleted, renamed, and untracked files against
  `HEAD`; binary/submodule entries are explicit non-text documents, never dropped.
- **Branch/range/commit:** resolve refs once, pin SHAs, enumerate status/renames,
  and read both sides with Git plumbing commands. `perCommit` retains ordered
  commit metadata and each commit's diff in addition to the net baseline/head.
- **Pull request:** fetch metadata/refs with `gh`/Git, then materialize through
  object reads or an isolated worktree under ignored repo-local scratch state.
  Never run `gh pr checkout` in the active worktree. Re-check source SHAs before
  publishing a run.
- **Snapshot:** read the requested paths as a current-state corpus. It has no
  synthetic diff and is valid for narrative/review only when the request clearly
  states that it is a snapshot analysis.

Source fingerprinting hashes the normalized source descriptor, pinned refs,
document paths/content hashes, rename metadata, and ordered commit SHAs. A source
change marks prior notes/outcomes/model runs stale; it never mutates their recorded
fingerprint.

### 10.5 Source selector, guidelines, and focus

`/patches inspect` opens a searchable source selector. The stable preset order is
session, working tree, base branch, commit/range, pull request, and snapshot.
Smart preselection does not reorder it:

1. current connected session when it has patches;
2. working tree when it has changes;
3. base branch when HEAD is on a non-default branch;
4. recent commit otherwise.

Branch and commit pickers support fuzzy filtering; default branch is labeled and
sorted first, current branch is not offered as its own base, and commit entries
show short SHA plus subject. Direct arguments and selector results pass through
the same total parser/validator.

The project boundary loader walks upward from cwd to the directory owning `.pi`.
If `REVIEW_GUIDELINES.md` exists beside that `.pi` directory, its non-empty
contents are loaded as the project's review checklist. Read failures are surfaced
as structured errors rather than silently treated as no guidelines.

Guidelines are visible in a TUI overlay and are included in
`implementationReview` requests. They are not silently repurposed as narrative
instructions. A persisted project-level review instruction may augment them. A
one-off `focus` string is valid for either analysis mode, belongs only to one run,
and never mutates shared settings.

### 10.6 Selected-model analysis: narrative versus review

The request type makes task conflation unrepresentable:

```ts
type ModelSelection = {
  provider: string;
  modelId: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
};

type NarrativeRequest = {
  mode: "narrative";
  dataset: ReviewDataset;
  model: ModelSelection;
  focus?: string;
};

type ImplementationReviewRequest = {
  mode: "implementationReview";
  dataset: ReviewDataset;
  model: ModelSelection;
  focus?: string;
  guidelines: string | null;
};

type AnalysisRequest = NarrativeRequest | ImplementationReviewRequest;
```

Model selection is a TUI picker backed by pi's configured/available model list.
The current model is preselected. Running an analysis must not change pi's active
chat model, navigate the session tree, or inject a user message into the coding
conversation. A dedicated `ModelRunner` capability receives the checked request
and streams progress/output back to the component; tests use a deterministic fake.

#### Narrative contract

The narrative explains what changed and how the pieces relate. It must not assign
P0-P3 priorities, issue a correctness verdict, or present defect findings.
Required output:

1. scope and source identity;
2. executive summary;
3. subsystem/file change map;
4. behavioral, API/schema, configuration, dependency, test, and documentation
   changes that actually occur;
5. interactions and cross-cutting themes;
6. unresolved factual questions, without converting them into findings.

For `historyMode:"squashed"`, the narrative describes the net baseline→head
change. For `historyMode:"perCommit"`, it additionally describes every selected
commit in order and then synthesizes **across commits**: feature evolution,
dependencies between commits, later corrections/reverts, migrations staged over
multiple commits, and the final net effect. A per-commit narrative is incomplete
if any selected commit lacks coverage, even when its net diff is later reverted.

#### Implementation-review contract

The review evaluates whether the selected implementation is correct, safe, and
maintainable. It may return zero findings. Required output:

1. scope and source identity;
2. verdict (`correct` or `needs attention`);
3. every discrete actionable finding with P0-P3, shortest useful file/range,
   scenario, impact, and corrective direction;
4. separate human reviewer callouts that do not affect the verdict;
5. explicit coverage summary.

Findings must be introduced by the selected change, supported by the presented
source, and overlap the reviewed diff where a diff exists. Review output does not
need to narrate every benign change. Commit history may provide attribution and
intent evidence, but selecting `perCommit` does not turn the review into a
narrative.

The two modes have separate prompt versions, output parsers, result types, TUI
tabs, and persisted rows. Running one never automatically runs or appends the
other. The user may run both against the same immutable source fingerprint and
compare them side-by-side.

### 10.7 Large scopes, chunking, and coverage

The planner computes a deterministic manifest before invoking a model. It counts
files, commits, bytes, diff rows, and estimated tokens, then chooses direct or
hierarchical execution:

- Direct: one request when the checked bundle fits the selected model's budget.
- Hierarchical: stable chunks by commit and/or subsystem/file, followed by a final
  synthesis over typed chunk results. Chunk boundaries and source order are
  persisted.

No mode may silently truncate. Oversized binary/generated/vendor files are listed
with explicit exclusion reasons and require user acknowledgement when exclusion
would violate requested coverage. A run records a coverage certificate containing
every source document and, in per-commit mode, every commit, with status
`included | summarized | excluded(reason) | failed(error)`.

Narrative success requires all selected documents and commits to be `included` or
`summarized`. Implementation review may complete with explicit exclusions, but
its verdict is then qualified as coverage-limited in the UI and persisted result.
Cancellation and provider errors leave a failed/cancelled run; partial output is
never presented as a completed narrative or review.

### 10.8 Persistence and TUI surfaces

Append-only migrations add:

- note disposition columns with the sum `CHECK` from §10.2;
- review source descriptors and pinned fingerprints;
- outcomes keyed by source fingerprint;
- analysis runs containing mode, model selection, prompt version, focus, status,
  output, optional review verdict, and timestamps;
- normalized run-document and run-commit coverage rows.

Serialized source descriptors/model responses are parsed into checked domain
types at the store boundary. Raw provider text is retained for diagnostics, but
the UI consumes a successfully parsed `NarrativeResult` or
`ImplementationReviewResult`, never ad hoc string scraping.

The embedded component adds unframed views/tabs for Diff, Notes, Narrative, and
Review. Source and model selection use focused searchable selectors. Running and
cancellation states are explicit modes in the reducer; only one analysis run may
own a component at a time, while completed runs remain browseable by timestamp,
model, source fingerprint, and mode.

The selected file's absolute `FileRecord.path` occupies a dedicated sticky header
row with the full terminal width available to it. It remains fixed while either
pane scrolls. The corresponding file row uses the theme-aware selection
background across the complete tree width, without changing its marker, click
target, or row geometry.

The same component owns mouse reporting for its lifetime. Header tabs, visible
file rows, and visible diff lines are clickable; drag selection uses exact line
coordinates; wheel events scroll the hovered split pane or active full-width
result view. Mouse hit-testing always uses the current responsive layout and
scroll offsets, and terminal mouse modes are restored on every disposal path.

Diff and note text is soft-wrapped by default so no content is lost at the right
edge. Wrapping prefers word boundaries, preserves ANSI styling and terminal cell
width for wide graphemes, and hard-wraps an individual token when it cannot fit.
Syntax and native/history diff views expose `w` as a wrap/no-wrap toggle. A
continuation row is a visual projection of its logical diff row: clicking or
dragging any continuation selects the same source line, annotations remain keyed
to logical diff/current-file coordinates, and wheel scrolling can traverse every
continuation without skipping the remainder of a long line. Resize and wrap-mode
changes preserve the logical row at the top of the viewport where possible.

Session patch history is one chronological stream across all tracked files.
`n` and `p` move to the next or previous patch in session sequence order and
select that patch's file; navigation clamps at stream boundaries. `f` enters
history at the newest patch and enables an explicit follow-latest state. While
following, a database refresh that appends patches advances to the new tail.
Manual patch or file navigation disables following. Git per-commit history keeps
its source-local commit navigation and does not claim to follow live patches.
The title exposes global patch position and whether follow mode is active.

File rows render addition and deletion counts as separate change surfaces:
non-zero `+N` uses the add background and non-zero `-N` uses the delete
background from the active dark/light and truecolor/256-color tint palette. A
file with both kinds shows both colors; tint-off mode removes both backgrounds
without changing markers, hit regions, text width, or file ordering. The selected
row's full-width selection background takes precedence over its count tints so
the active file has one coherent highlight.

### 10.9 Explicit non-adoptions from upstream `pi-review`

- no `/review` or `/end-review` commands;
- no fresh code-review branch in pi's session tree;
- no automatic PR checkout in the active worktree;
- no combined prompt that performs narrative and defect review together;
- no silent fallback when Git, GitHub, guideline loading, model output parsing,
  or coverage fails;
- no verbatim dependency on a monolithic review rubric: prompts are local,
  versioned, tested contracts derived from the result types above.

### 10.10 v2 verification gates

**Phase 6 — findings and finish flow.** Fresh/migrated schema equivalence; row
round-trips for every legal note role; SQL rejection of illegal role combinations;
priority ordering; verdict invariant; reducer tests for all finish choices,
stale-note exclusion, callout separation, and cancel/return behavior.

**Phase 7 — sources and selectors.** Golden repositories cover staged/unstaged/
untracked/deleted/renamed files, merge bases, a single commit, ranges with reverts,
merge commits, binary/submodule entries, and snapshots. Adapter output is checked
against independent Git plumbing commands. PR tests prove the active worktree HEAD
and index are unchanged. Fuzzy selectors and smart preselection are pure tests.

**Phase 8 — selected-model analysis.** Deterministic fake-model tests prove the
selected provider/model/thinking level reaches the runner without changing pi's
active model. Narrative parser rejects findings/verdict sections; review parser
requires verdict and validates priorities/locations. `squashed` and `perCommit`
goldens prove that per-commit narrative covers every commit and includes a
cross-commit synthesis while review remains defect-oriented.

**Phase 9 — scale and failure.** Force hierarchical execution with tiny token
budgets; prove stable chunk plans, full document/commit coverage, explicit
exclusions, cancellation, retry boundaries, parse failures, stale fingerprints,
and no false-complete result. Benchmark first-open and cached navigation on large
datasets; cached interaction must remain viewport-bounded. Mouse tests cover
multi-event chunks, modifier wheels, independent pane scrolling, scrolled file
and line clicks, blank-row clicks, drag/release selection, responsive resize, and
enable/disable cleanup. Wrapping tests cover ANSI spans, wide graphemes, unbroken
tokens, syntax and native/history views, wrap toggling, continuation hit-testing,
visual-row wheel scrolling, and cached large-diff rendering.
Session-history reducer tests cover cross-file previous/next navigation, boundary
clamping, follow-tail refresh, and manual follow disengagement. File-tree tests
cover simultaneous add/delete backgrounds, tint-off behavior, and ANSI-safe
terminal widths. Frame tests keep the absolute path in the sticky header while
the diff is scrolled and require the selected file highlight to fill the tree
track without changing total frame width.

**Phase 10 — live acceptance.** In a real isolated pi TTY: inspect a recorded
session, working tree, branch range, and non-destructive PR source; create
prioritized agent findings and human callouts; exercise each finish action; run
both analysis modes with an explicitly selected model; verify persisted model/
prompt/source/coverage metadata; press `q` and confirm pi's editor/footer/terminal
are restored with no child process or worktree mutation.
