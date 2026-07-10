# pi-patches

`pi-patches` records file edits from a running pi session into a per-project SQLite database, opens an embedded terminal review UI, reviews session/Git/PR/snapshot sources, and can send queued findings back to the same pi conversation.

The project is a TypeScript npm workspace with no build step. The flake imports the local pi checkout at `/path/to/pi` and uses pi's Node/runtime package set through `devenv`.

## Development

Enter the shell:

```sh
nix develop
```

Run the normal verification path:

```sh
nix develop -c pi-patches-check
```

That script runs:

```sh
npm run typecheck
npm test
```

The devenv npm integration installs workspace dependencies on shell entry, so a separate manual `npm install` is not normally needed.

The devenv-native test path is wired to the same check:

```sh
devenv test
```

Run the flake check to exercise the Nix-packaged verification gate:

```sh
nix flake check
```

## Install In Pi

Install this checkout as a local pi package:

```sh
cd /path/to/pi-patches
nix develop -c pi install /path/to/pi-patches
```

Restart pi after installation. Pi records the absolute local path in its user settings, so edits in this checkout are picked up on the next pi start. During development, prefer a full restart because `/reload` may retain transitive workspace modules. For a project-local installation, use:

```sh
nix develop -c pi install -l /path/to/pi-patches
```

For a single development run without installing:

```sh
nix develop -c pi -e /path/to/pi-patches/packages/extension/src/index.ts
```

The checkout must retain its installed workspace dependencies. Entering `nix develop` installs them; `npm install --ignore-scripts` is the non-Nix equivalent when using Node 24.

## Recorder Extension

The extension creates one database per project at:

```text
<project>/.pi/patches/patches.db
```

It records pi `edit` and `write` tool mutations. The session source includes tracked live-disk changes; the working-tree source covers files changed outside those tools.

## Commands

Inside pi:

```text
/patches
```

Shows the current session ID, recorder counts, and the exact pi command for opening its review.

Open that session inside pi:

```text
/patches connect <session-id-or-prefix>
```

The review component opens as a full-terminal pi overlay and returns to the editor when you press `q`. It does not launch a process or open or rearrange terminal windows. Comments submitted against an ended session remain queued until that pi session is resumed.

Inspect another source in the same embedded TUI:

```text
/patches inspect
/patches inspect working-tree
/patches inspect branch main HEAD --history per-commit
/patches inspect range <base>..<head> --history per-commit
/patches inspect pr 123 --history per-commit
/patches inspect snapshot src test
```

Run exactly one selected-model task and open its persisted result:

```text
/patches analyze
/patches analyze working-tree
```

The analysis picker keeps **Narrative** (explain every selected change, including cross-commit evolution in per-commit mode) separate from **Implementation review** (correctness verdict and actionable P0-P3 findings). Each run records the explicit provider, model, thinking level, prompt version, focus, source fingerprint, deterministic chunk manifest, and coverage.

There is intentionally no `/review` command. All interaction remains under `/patches`, inside pi's current terminal and session.

## Review App

List known sessions:

```sh
nix develop -c pi-review --list
```

Open a specific database/session:

```sh
PI_PATCHES_DB=/path/to/.pi/patches/patches.db \
PI_PATCHES_SESSION=<session-id-or-prefix> \
nix develop -c pi-review
```

Useful keys in the review UI:

```text
j/k or arrows   move
[/]             previous/next file
1/2/3/4         Diff/Notes/Narrative/Review tabs
v               visual selection
c               comment
a               annotation list
S               submit fresh agent findings
H               cumulative/history view
d               syntax/native diff rendering
w               toggle line wrapping
t               tint mode
I               review guidelines overlay
r               refresh
?               help
q               quit
```

Mouse support is enabled for the component lifetime and restored on exit. In Ghostty, wheel scrolling follows the hovered file/diff/result pane, header tabs and visible files are clickable, diff-line clicks use the current scroll offset, and left-button drag creates an exact line selection.

Diff and note text wraps by default at word boundaries, with hard wrapping for long tokens. ANSI syntax colors and wide characters are preserved. Continuation rows use `↳`; clicking or dragging one still targets its original source line, and wheel scrolling can move through every continuation. Press `w` to temporarily use clipped lines instead.

On `q`, drafts open a four-way finish selector: return without submitting, submit feedback, submit and ask pi to fix, or cancel. Human findings and callouts remain separate; stale agent findings are never queued.
