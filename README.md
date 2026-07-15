# pi-patches

`pi-patches` records file edits made by a running pi session, stores them in a
per-project SQLite database, and provides a mouse-aware terminal review UI. The
same UI can review a recorded session, Git changes, a pull request, or a path
snapshot. Review findings can be sent back to the originating pi conversation.

The review UI is embedded in pi by `/patches`; it never opens or rearranges
terminal windows. A standalone `pi-review` command is also available for opening
the same database from another terminal.

## Requirements

- pi with local package support
- Node.js 24 when running outside Nix
- Nix with flakes for the documented development and installation commands
- Git for working-tree, branch, commit, and range sources
- `gh` for pull-request sources

The Nix flake pins a compatible pi revision and reuses its Node and runtime
package set.

## Install In Pi

Install the repository root as a local pi package:

```sh
git clone https://github.com/o1lo01ol1o/pi-patches.git
cd pi-patches
nix develop --no-pure-eval -c pi install "$PWD"
```

Restart pi after installing or changing this checkout. Pi records the absolute
local path, so the next process start loads the current files. During development
prefer a full restart because `/reload` may retain transitive workspace modules.

Install it only for the current project with:

```sh
nix develop --no-pure-eval -c pi install -l "$PWD"
```

Run it once without installing with:

```sh
nix develop --no-pure-eval -c pi -e "$PWD/packages/extension/src/index.ts"
```

The checkout must retain its workspace dependencies. `nix develop
--no-pure-eval` installs them while allowing devenv to discover the portable
checkout root. The non-Nix equivalent is `npm install --ignore-scripts` with
Node 24.

## Recorder

The extension creates one database per project:

```text
<project>/.pi/patches/patches.db
```

It records successful pi `write` and `edit` tool mutations. For each file it
keeps the first-seen baseline and an ordered patch chain with pre/post content
hashes. Resuming a session appends to that chain, and a fork begins with a copy
of its parent's recorded state. Failed edits, unreadable pre-images, and tool
results that cannot be applied are not invented as valid patches.

The session view replays recorded patches and compares the result with the live
file. Changes made outside pi remain visible as external changes but are not
misattributed to a recorded patch. The working-tree source is the appropriate
view for all staged, unstaged, untracked, deleted, renamed, binary, and submodule
changes, regardless of which tool created them.

## Pi Commands

All commands run inside the current pi process.

### Recorder status

```text
/patches
```

Shows the current session ID, file and patch counts, queued/sent feedback counts,
and the exact `/patches connect` command for the current session.

### Connect to a session

```text
/patches connect <session-id-or-unique-prefix>
```

Opens an existing recorded session in a full-terminal overlay. Press `q` to
return to pi's editor. No subprocess or new terminal is created. Findings for an
ended session remain queued until that session is resumed.

### Inspect a source

Run `/patches inspect` without arguments to use the source picker. It recommends
the current session when it has patches, otherwise the working tree when dirty,
the base branch on a non-default branch, or a recent commit.

Direct forms use the same parser:

```text
/patches inspect session [session-id]
/patches inspect working-tree
/patches inspect staged
/patches inspect unstaged
/patches inspect branch <base> [head]
/patches inspect commit <sha>
/patches inspect range <base>..<head>
/patches inspect pr <number>
/patches inspect snapshot <path> [path ...]
```

Commit-bearing Git sources accept either history mode:

```text
--history squashed
--history per-commit
```

Examples:

```text
/patches inspect branch main HEAD --history per-commit
/patches inspect range release..HEAD --history per-commit
/patches inspect pr 123 --history per-commit
/patches inspect snapshot src test "path with spaces"
```

Source behavior:

- `session` uses the SQLite baseline, patch chain, attribution, and live disk.
- `working-tree` compares `HEAD` with the complete worktree, including staged,
  unstaged, and untracked changes.
- `staged` compares `HEAD` with the index. Worktree-only edits are excluded.
- `unstaged` compares the index with the worktree and includes untracked files.
  Index-only changes are excluded.
- `branch` compares the merge base of base/head with the selected head.
- `commit` reviews one commit.
- `range` reviews the base-exclusive to head-inclusive commit sequence.
- `pr` reads pinned PR objects without checking out or mutating the active tree.
- `snapshot` reads current path contents and has no synthetic Git history.
- `squashed` shows baseline-to-head net change.
- `per-commit` retains every selected commit, including changes later reverted.

### Switch the open source

Press `s` from any non-modal review view to open the searchable source selector
without leaving the TUI. It lists recorded sessions, complete/staged/unstaged Git
changes, base branches, recent commits, ranges, pull requests, and snapshots.
Type to filter, use the arrow keys to select, and press `Enter`. Ranges, pull
requests, and snapshots prompt for their argument; commit-bearing sources also
prompt for squashed or per-commit history.

The selector remembers the most recently viewed session source and Git source.
After both families have been visited, `s` followed by `Enter` toggles directly
to the other one, preserving its exact history choice. The active source and Git
history mode remain in the sticky header.

Loading keeps the current dataset active until the replacement is complete.
`Escape` cancels a pending switch, and a Git/database error leaves the prior
source untouched. Wrap, tint, render mode, pane focus, and terminal geometry are
preserved; file/history cursors, annotations, and analysis runs are replaced with
the selected source's fingerprint-bound state. Draft notes remain stored against
their original source and are never copied to another diff.

`r` re-materializes the active non-session source at its own boundary, so a
staged refresh still reads `HEAD -> INDEX` and an unstaged refresh still reads
`INDEX -> WORKTREE`. Only the selected source is materialized; selector entries
do not keep inactive large diffs in memory.

### Analyze a source

```text
/patches analyze
/patches analyze <same source arguments as inspect>
```

Without arguments, the command opens the source picker. It then asks for exactly
one task, model, supported thinking level, and optional one-run focus:

- **Narrative** explains all selected changes and how they relate. In
  `per-commit` mode it covers every commit and adds cross-commit synthesis.
- **Implementation review** evaluates correctness and produces actionable P0-P3
  findings plus separate human callouts. It does not double as a narrative.

The selected model is used only for that analysis and does not change pi's chat
model. Runs persist the mode, provider/model, thinking level, prompt version,
focus, source fingerprint, deterministic chunk plan, coverage, status, and typed
result. Large inputs are chunked and synthesized rather than silently truncated.
Cancellation or provider/parser failure remains a failed or cancelled run, not a
partial success. Narrative and Review tabs keep their histories independently;
use `n`/`p` on those tabs to browse prior runs.

If `REVIEW_GUIDELINES.md` exists at the project boundary, `I` displays it and
implementation review includes it. Narrative does not silently treat it as a
narrative prompt. Pull-request analysis revalidates the pinned source before a
successful run completes.

There is intentionally no `/review` command. The upstream terminal-spawning
workflow is not registered.

## Review UI

The first row contains stable Diff, Notes, Narrative, and Review tabs. The Diff
tab has a file tree on the left and the selected diff on the right. The status
bar reports draft, queued, and sent counts plus the current mode and transient
messages. A second sticky header row shows the selected file's absolute path; it
does not move when either pane scrolls.

### Navigation

```text
j/k or arrows    move the logical diff row
ctrl+d/ctrl+u    move by half a page
ctrl+e/ctrl+y    scroll the focused pane by one visual row
gg/G             first/last diff row
{/}              previous/next hunk
[/]              previous/next file
h/l              focus file tree/diff
Tab              switch focused pane
Enter            focus the diff
1/2/3/4          Diff/Notes/Narrative/Review tabs
Escape           close a mode or cancel a selection
```

### Views And Rendering

```text
H                cumulative/history view
n/p              previous/next patch or history entry
f                follow the latest session patch
s                switch session/Git source
d                syntax/native diff rendering
e                expand/collapse the selected file
w                toggle line wrapping
t                gradient/uniform/off tint mode
r                refresh
I                review guidelines overlay
?                key bindings
q                finish or quit
```

Session patch history is one chronological stream across all files. `n` and `p`
move through global patch sequence and select each patch's file. `f` switches to
history, jumps to the newest patch, and follows patches appended by the connected
session. Manual patch or file navigation disables following. Annotation-only
refreshes preserve the current cursor and scroll instead of forcing a tail jump.
Each landing replays the selected file through that patch and shows the complete
post-patch file, with the cursor positioned at the first changed line. Every
replay-attributed line keeps a theme-aware green tint based on the stored age of
all contributing patches: oldest is lightest, newest is most saturated, and
intermediate intensity is interpolated from persisted patch timestamps. Opening
the TUI or browsing with `n`/`p` does not reset those colors. Only a genuinely
new patch appended while `f` is following receives the brief just-landed pulse,
after which its stable age tint remains. A broken replay chain is reported
explicitly instead of displaying a partial or guessed file. Snapshots, syntax
highlighting, and visual row maps are cached, so animation frames compose only
the visible rows.
For per-commit Git sources, `n`/`p` browse the selected file's commit history and
retain native per-commit diffs; `f` is unavailable.

Syntax mode highlights source code and, for session cumulative diffs, attributes
lines to persisted patch age. Tint mode cycles between an age gradient, a uniform
change background, and no background. The selected file is highlighted across
the full tree width. Other file rows apply the active tint mode independently to
non-zero green `+N` and red `-N` counters, so a modified file can display both
colors.

### Expand File Context

Cumulative diffs start in compact patch-context mode. Every omitted unchanged
prefix, inter-hunk region, and suffix is represented by an explicit collapsed
row. Press `e` to toggle the selected file between patch context and the complete
current file. Press `Enter` or left-click a collapsed row to expand and land on
the first revealed source line. Expansion is tracked independently per file, and
the sticky path header reports `context:patches` or `context:full`.

Full-file context works in both syntax and native rendering. Revealed unchanged
lines retain source line numbers, syntax highlighting, wrapping, mouse hit
testing, selection, and comment anchoring. Collapsing preserves the current
source coordinate by returning to the collapsed row that owns it. Jumping to an
annotation outside compact patch context automatically re-expands that file.
Switching review sources clears expansion state because it is bound to the old
dataset.

Useful markers:

```text
>   selected file or logical diff row
●   annotation on a file/line
⚠   stale annotation range
~   live external change not attributed to a recorded patch
∅   tracked file missing from disk
↳   wrapped continuation of the preceding logical diff row
```

The status bar always shows `? keys`; press `?` from any main tab to open the
complete key-binding overlay. Press `?`, `Esc`, or `q` to close it.

Diffs, notes, guidelines, analysis output, and annotation lists wrap by default.
Wrapping prefers word boundaries, hard-wraps an oversized token, preserves ANSI
syntax colors, and uses terminal cell width for wide characters. A continuation
row still maps to its original logical/source line for cursor movement, selection,
comments, and mouse hit-testing. Press `w` for clipped lines.

### Mouse

Mouse reporting is enabled only for the component lifetime and restored on every
exit path. In Ghostty and other SGR-mouse terminals:

- click a header tab to switch views;
- click a visible file to select it;
- click a diff line or continuation to select its logical source line;
- click a collapsed unchanged region to expand the complete file;
- drag with the left button to create or extend an exact line selection;
- wheel over the file tree, diff, or full-width result to scroll that pane;
- scrolled and resized panes use their current offsets for every hit test.

### Comments And Annotations

```text
v                start/stop visual line selection
c                comment on the current line or selected range
a                open the annotation list
S                submit eligible fresh findings
```

The comment editor controls are:

```text
Ctrl-S           save
Ctrl-P           cycle P0/P1/P2/P3 priority
Ctrl-A           toggle agent/human audience
Ctrl-T           toggle finding/human callout
Enter            insert a newline
Escape           cancel
```

In the annotation list:

```text
j/k or arrows    select
Enter            jump to the current or best-guess stale location
e                edit an unsent annotation
u                re-anchor a stale draft
x                delete an unsent annotation
Escape/q/?       close
```

Annotations are anchored to a content hash, patch (when applicable), line range,
and snippet. Later non-overlapping patches or external edits can be re-anchored
automatically; overlapping changes require an explicit replacement range. Sent
annotations are immutable. Fresh agent findings are delivered in priority, path,
and line order with the code snippet and a claim-time stale warning when needed.
Human findings and callouts remain separate from fix-directed agent feedback.
The extension polls queued feedback for its session: it sends a normal user
message while pi is idle and uses pi's steer path when generation is in progress.
A claimed batch is not delivered twice.

Pressing `q` with drafts opens a four-way finish selector:

1. return without submitting;
2. submit feedback and return;
3. submit and ask pi to fix;
4. cancel.

Stale agent findings are excluded from submission until re-anchored or removed.
The submit-and-fix path asks pi to address findings in priority order and report
verification. Human notes are preserved independently.

## Standalone Review App

```text
pi-review [--db PATH] [--session ID_OR_PREFIX] [--list] [--help]
```

List sessions in a database:

```sh
nix develop --no-pure-eval -c pi-review --list
nix develop --no-pure-eval -c pi-review --db /path/to/.pi/patches/patches.db --list
```

Open a specific session:

```sh
nix develop --no-pure-eval -c pi-review \
  --db /path/to/.pi/patches/patches.db \
  --session <session-id-or-unique-prefix>
```

Equivalent environment variables are:

```sh
PI_PATCHES_DB=/path/to/.pi/patches/patches.db
PI_PATCHES_SESSION=<session-id-or-unique-prefix>
```

Without `--db`, discovery walks upward from the current directory for
`.pi/patches/patches.db`. Without a session selector it opens the newest live
session. An ambiguous prefix is rejected. `--list` prints session ID, live/ended
state, start time, file count, patch count, and project directory. When stdin or
stdout is not a TTY, `pi-review` prints a read-only summary rather than starting
the interactive terminal UI.

The embedded `/patches connect` form is preferred when reviewing from pi. Use
standalone `pi-review` when a separate terminal is explicitly useful.

## Persistence And Freshness

The database stores sessions, files, patches, annotations, source-scoped notes,
analysis runs, outcomes, and coverage. SQLite constraints reject cross-session
ownership, invalid patch sequences, illegal baseline states, invalid annotation
roles, and illegal sent/draft state combinations.

Git/PR/snapshot notes and analysis are keyed by an immutable source fingerprint
covering the normalized source descriptor, pinned refs, file identities/content,
rename metadata, and ordered commits. If that source changes, prior results remain
available but are stale; they are not rewritten to look current.

## Development

Enter the development shell:

```sh
nix develop --no-pure-eval
```

Run typechecking and all workspace tests:

```sh
nix develop --no-pure-eval -c pi-patches-check
```

The script runs:

```sh
npm run typecheck
npm test
```

Equivalent and packaging gates are:

```sh
devenv test
nix flake check --no-pure-eval
```

The repository is a TypeScript npm workspace with no compilation step at runtime.
The test suite covers store invariants, recorder behavior, source materialization,
analysis contracts, reducer transitions, mouse/keyboard handling, wrapping,
large-file/diff performance, and embedded terminal cleanup.
