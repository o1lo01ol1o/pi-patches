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

This checkout currently imports the sibling pi checkout at
`/path/to/pi` through `flake.nix` and reuses its Node and runtime
package set.

## Install In Pi

Install the repository root as a local pi package:

```sh
cd /path/to/pi-patches
nix develop -c pi install /path/to/pi-patches
```

Restart pi after installing or changing this checkout. Pi records the absolute
local path, so the next process start loads the current files. During development
prefer a full restart because `/reload` may retain transitive workspace modules.

Install it only for the current project with:

```sh
nix develop -c pi install -l /path/to/pi-patches
```

Run it once without installing with:

```sh
nix develop -c pi -e /path/to/pi-patches/packages/extension/src/index.ts
```

The checkout must retain its workspace dependencies. `nix develop` installs
them. The non-Nix equivalent is `npm install --ignore-scripts` with Node 24.

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
/patches inspect branch <base> [head]
/patches inspect commit <sha>
/patches inspect range <base>..<head>
/patches inspect pr <number>
/patches inspect snapshot <path> [path ...]
```

Git sources accept either history mode:

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
- `working-tree` compares the complete current worktree with `HEAD`.
- `branch` compares the merge base of base/head with the selected head.
- `commit` reviews one commit.
- `range` reviews the base-exclusive to head-inclusive commit sequence.
- `pr` reads pinned PR objects without checking out or mutating the active tree.
- `snapshot` reads current path contents and has no synthetic Git history.
- `squashed` shows baseline-to-head net change.
- `per-commit` retains every selected commit, including changes later reverted.

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
d                syntax/native diff rendering
w                toggle line wrapping
t                gradient/uniform/off tint mode
r                refresh
I                review guidelines overlay
?                help
q                finish or quit
```

Session patch history is one chronological stream across all files. `n` and `p`
move through global patch sequence and select each patch's file. `f` switches to
history, jumps to the newest patch, and follows patches appended by the connected
session. Manual patch or file navigation disables following. Annotation-only
refreshes preserve the current cursor and scroll instead of forcing a tail jump.
Each landing replays the selected file through that patch and shows the complete
post-patch file, with the cursor positioned at the first changed line. Lines
touched by the landed patch briefly fade from a theme-aware green background;
unchanged lines remain untinted. A broken replay chain is reported explicitly
instead of displaying a partial or guessed file. Snapshots, syntax highlighting,
and visual row maps are cached, so animation frames compose only the visible rows.
For per-commit Git sources, `n`/`p` browse the selected file's commit history and
retain native per-commit diffs; `f` is unavailable.

Syntax mode highlights source code and, for session cumulative diffs, attributes
lines to patch recency. Tint mode cycles between a recency gradient, a uniform
change background, and no background. The selected file is highlighted across
the full tree width. Other file rows apply the active tint mode independently to
non-zero green `+N` and red `-N` counters, so a modified file can display both
colors.

Useful markers:

```text
>   selected file or logical diff row
●   annotation on a file/line
⚠   stale annotation range
~   live external change not attributed to a recorded patch
∅   tracked file missing from disk
↳   wrapped continuation of the preceding logical diff row
```

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
nix develop -c pi-review --list
nix develop -c pi-review --db /path/to/.pi/patches/patches.db --list
```

Open a specific session:

```sh
nix develop -c pi-review \
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
nix develop
```

Run typechecking and all workspace tests:

```sh
nix develop -c pi-patches-check
```

The script runs:

```sh
npm run typecheck
npm test
```

Equivalent and packaging gates are:

```sh
devenv test
nix flake check
```

The repository is a TypeScript npm workspace with no compilation step at runtime.
The test suite covers store invariants, recorder behavior, source materialization,
analysis contracts, reducer transitions, mouse/keyboard handling, wrapping,
large-file/diff performance, and embedded terminal cleanup.
