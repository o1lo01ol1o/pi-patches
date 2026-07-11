import type { AnalysisRun, Annotation, ImplementationReviewResult, NarrativeResult } from "@pi-patches/store";
import { hashContent } from "@pi-patches/store";
import { truncateVisible, visibleWidth } from "../render/ansi.ts";
import { computeFrameLayout } from "../layout.ts";
import { renderDiffPane } from "./diff-pane.ts";
import { renderFileTree } from "./file-tree.ts";
import { renderStatusBar } from "./status-bar.ts";
import { currentDiffVisualMap, sessionPatchPosition, type AppState } from "../state.ts";

export function renderFrame(state: AppState, width: number, height: number): string[] {
  const { rows, columns, bodyRows, bodyTop, treeWidth, diffWidth } = computeFrameLayout(width, height);
  const lines: string[] = [];

  const selectedFile = state.files[state.selectedFile];
  const selectedPath = selectedFile?.row.path ?? "no selected file";
  const showProvenance = state.dataset.source.kind === "session";
  const tintLegend = showProvenance && state.view === "cumulative" && state.renderMode === "syntax" && state.tintMode !== "off" ? " old ░▒▓█ new" : "";
  const visibleRenderMode = state.view === "history"
    ? state.dataset.source.kind === "session" && state.historyEntries.length === 0 ? "file" : "native"
    : state.renderMode;
  const tint = showProvenance && state.view === "cumulative" ? ` · tint:${state.tintMode}${tintLegend}` : "";
  const patchPosition = sessionPatchPosition(state);
  const patchNavigation = patchPosition === null
    ? ""
    : ` · patch ${patchPosition.index + 1}/${patchPosition.total}${patchPosition.following ? " · following" : ""}`;
  lines.push(pad(`${tabHeader(state)} · ${state.wrapLines ? "wrap" : "nowrap"} · ${state.view} · ${visibleRenderMode}${patchNavigation}${tint} · ${sourceLabel(state)}`, columns));
  if (rows >= 3) lines.push(pad(`File: ${selectedPath}`, columns));

  if (state.activeTab === "diff") {
    const treeLines = renderFileTree(
      state.files,
      state.selectedFile,
      state.annotations,
      state.scrollTop.tree,
      bodyRows,
      { mode: state.tintMode, colorDepth: state.colorDepth, theme: state.tintTheme, width: treeWidth }
    );
    const file = state.files[state.selectedFile];
    const fileAnnotations = file ? state.annotations.filter((annotation) => annotation.fileId === file.row.id) : [];
    const fileHistory = file ? state.historyEntries.filter((entry) => entry.fileId === file.row.id) : [];
    const selectedHistory = fileHistory.length === 0
      ? null
      : {
          entry: fileHistory[Math.max(0, Math.min(state.patchIdx, fileHistory.length - 1))],
          index: Math.max(0, Math.min(state.patchIdx, fileHistory.length - 1)),
          total: fileHistory.length
        };
    const diffLines = file
      ? renderDiffPane(file, state.patches, fileAnnotations, {
          cursorRow: Number(state.cursorRow),
          startRow: state.scrollTop.diff,
          height: bodyRows,
          view: state.view,
          renderMode: state.renderMode,
          tintMode: state.tintMode,
          colorDepth: state.colorDepth,
          tintTheme: state.tintTheme,
          patchIdx: state.patchIdx,
          historyEntry: selectedHistory,
          width: diffWidth,
          selectedRange: selectedRange(state),
          showProvenance,
          wrapLines: state.wrapLines,
          visualMap: currentDiffVisualMap(state, width, height),
          landingPhase: state.patchLanding?.phase ?? null
        })
      : ["No selected documents."];

    for (let row = 0; row < bodyRows; row++) {
      const left = pad(treeLines[row] ?? "", treeWidth);
      const right = pad(diffLines[row] ?? "", diffWidth);
      lines.push(`${left}|${right}`);
    }
  } else {
    const content = tabBody(state, columns);
    const scroll = state.analysisScroll[state.activeTab];
    for (let row = 0; row < bodyRows; row++) lines.push(pad(content[scroll + row] ?? "", columns));
  }

  if (state.mode.kind === "comment" && rows >= 2) {
    lines[rows - 2] = pad("note editor · Ctrl-P priority · Ctrl-A audience · Ctrl-T finding/callout", columns);
  } else if (state.mode.kind === "overlay") {
    lines.splice(bodyTop, bodyRows, ...overlayLines(state, columns, bodyRows));
    while (lines.length < rows - 1) lines.push(" ".repeat(columns));
  } else if (state.mode.kind === "finish") {
    lines.splice(bodyTop, bodyRows, ...finishLines(state, columns, bodyRows));
    while (lines.length < rows - 1) lines.push(" ".repeat(columns));
  } else if (state.mode.kind === "analysisRunning") {
    lines.splice(bodyTop, bodyRows, ...analysisRunningLines(state, columns, bodyRows));
    while (lines.length < rows - 1) lines.push(" ".repeat(columns));
  }

  lines.push(pad(renderStatusBar(state), columns));
  return lines.slice(0, rows).map((line) => pad(line, columns));
}

function tabHeader(state: AppState): string {
  return ([
    ["diff", "Diff"],
    ["notes", "Notes"],
    ["narrative", "Narrative"],
    ["review", "Review"]
  ] as const).map(([tab, label]) => state.activeTab === tab ? `[${label}]` : ` ${label} `).join("|");
}

function sourceLabel(state: AppState): string {
  const source = state.dataset.source;
  switch (source.kind) {
    case "session": return `session ${source.sessionId}`;
    case "workingTree": return "working tree";
    case "branch": return `${shortRef(source.baseRef)}..${shortRef(source.headRef)}`;
    case "commit": return `commit ${shortRef(source.sha)}`;
    case "commitRange": return `${shortRef(source.baseExclusive)}..${shortRef(source.headInclusive)}`;
    case "pullRequest": return `PR #${source.number}`;
    case "snapshot": return `snapshot ${source.paths.length} path(s)`;
  }
}

function shortRef(value: string): string {
  return /^[0-9a-f]{40,64}$/.test(value) ? value.slice(0, 8) : value;
}

function tabBody(state: AppState, width: number): string[] {
  switch (state.activeTab) {
    case "notes":
      return wrapLines(annotationRows(state).map((row) => row.text), width);
    case "narrative":
      return renderAnalysisRun(state, "narrative", width);
    case "review":
      return renderAnalysisRun(state, "implementationReview", width);
    case "diff":
      return [];
  }
}

function renderAnalysisRun(state: AppState, mode: "narrative" | "implementationReview", width: number): string[] {
  const runs = state.analysisRuns.filter((run) => run.mode === mode);
  const index = state.selectedAnalysisRun[mode];
  const run = runs[index];
  if (!run) return [mode === "narrative" ? "No narrative runs for this source." : "No implementation review runs for this source."];
  const header = [
    `${index + 1}/${runs.length} · ${run.model.provider}/${run.model.modelId} · thinking:${run.model.thinkingLevel} · ${run.status} · ${new Date(run.startedAt).toISOString()}`,
    `${run.promptVersion} · source ${run.sourceFingerprint.slice(0, 12)}`,
    ""
  ];
  if (run.status !== "completed" || run.output === null) {
    return wrapLines([...header, run.error ?? `Run is ${run.status}.`], width);
  }
  return run.output.mode === "narrative"
    ? wrapLines([...header, ...narrativeLines(run.output)], width)
    : wrapLines([...header, ...reviewLines(run.output)], width);
}

function narrativeLines(result: NarrativeResult): string[] {
  return [
    "Executive summary",
    result.executiveSummary,
    "",
    "Change map",
    ...result.changeMap.map((entry) => `${entry.path}: ${entry.summary}`),
    "",
    ...categoryLines("Behavior", result.changes.behavioral),
    ...categoryLines("API and schema", result.changes.apiSchema),
    ...categoryLines("Configuration", result.changes.configuration),
    ...categoryLines("Dependencies", result.changes.dependencies),
    ...categoryLines("Tests", result.changes.tests),
    ...categoryLines("Documentation", result.changes.documentation),
    ...categoryLines("Interactions", result.interactions),
    ...categoryLines("Open factual questions", result.questions),
    ...(result.commitNarratives.length === 0 ? [] : ["Commits", ...result.commitNarratives.map((commit) => `${shortRef(commit.sha)}: ${commit.summary}`), ""]),
    ...(result.crossCommitSynthesis === null ? [] : ["Across commits", result.crossCommitSynthesis])
  ];
}

function reviewLines(result: ImplementationReviewResult): string[] {
  return [
    `Verdict: ${result.verdict === "needsAttention" ? "needs attention" : "correct"}${result.coverageLimited ? " (coverage limited)" : ""}`,
    result.coverageSummary,
    "",
    "Findings",
    ...(result.findings.length === 0 ? ["No findings."] : result.findings.flatMap((finding, index) => [
      `${index + 1}. [${finding.priority}] ${finding.path}:${finding.startLine}-${finding.endLine} ${finding.title}`,
      `Scenario: ${finding.scenario}`,
      `Impact: ${finding.impact}`,
      `Direction: ${finding.correctiveDirection}`,
      ""
    ])),
    "Human callouts",
    ...(result.callouts.length === 0 ? ["No callouts."] : result.callouts.map((callout) => {
      const location = callout.path === null ? "" : ` ${callout.path}${callout.startLine === null ? "" : `:${callout.startLine}-${callout.endLine}`}`;
      return `${location.trim()}: ${callout.message}`.trim();
    }))
  ];
}

function categoryLines(title: string, values: readonly string[]): string[] {
  return values.length === 0 ? [] : [title, ...values.map((value) => `- ${value}`), ""];
}

function wrapLines(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => wrapLine(line, Math.max(12, width)));
}

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const output: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    const breakAt = Math.max(1, remaining.lastIndexOf(" ", width));
    output.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  output.push(remaining);
  return output;
}

function selectedRange(state: AppState): { start: number; end: number } | null {
  if (!state.selection) return null;
  const anchor = Number(state.selection.anchor);
  const head = Number(state.selection.head);
  return anchor <= head ? { start: anchor, end: head } : { start: head, end: anchor };
}

function overlayLines(state: AppState, width: number, height: number): string[] {
  if (state.mode.kind !== "overlay") return [];
  if (state.mode.which === "help") {
    return padWindow([
      "Keys",
      "j/k or arrows move   ctrl+d/ctrl+u half-page   ctrl+e/ctrl+y scroll",
      "gg/G top/bottom      {/} hunk                  [/ ] file",
      "h/l/tab focus        Enter focus diff           v visual selection",
      "c comment            a annotations              S submit drafts",
      "H history   n/p previous/next patch   f follow latest patch",
      "d native/syntax   w wrap   t tint   r refresh",
      "I guidelines   ? help   q quit   Esc close",
      "Annotations: j/k select, Enter jump, e edit, u re-anchor, x delete"
    ], width, height);
  }
  if (state.mode.which === "guidelines") {
    const guidelines = state.reviewGuidelines;
    return padWindow(
      guidelines === null
        ? ["No REVIEW_GUIDELINES.md for this project."]
        : [guidelines.path, "", ...wrapLines(guidelines.contents.split(/\r?\n/), width)],
      width,
      height
    );
  }
  return padWindow(renderAnnotations(state, width, height), width, height);
}

function renderAnnotations(state: AppState, width: number, height: number): string[] {
  if (state.annotations.length === 0) return ["No annotations."];
  const rows = annotationRows(state).flatMap((row) =>
    wrapLine(row.text, Math.max(12, width)).map((text) => ({ text, annotationIndex: row.annotationIndex }))
  );
  const cursorLine = Math.max(0, rows.findIndex((row) => row.annotationIndex === state.annotationCursor));
  const start = Math.max(0, Math.min(cursorLine - Math.floor(height / 2), Math.max(0, rows.length - height)));
  return rows.slice(start, start + height).map((row) => row.text);
}

function annotationRows(state: AppState): Array<{ text: string; annotationIndex: number | null }> {
  if (state.annotations.length === 0) return [{ text: "No notes for this source.", annotationIndex: null }];
  const findings = state.annotations
    .map((annotation, index) => ({ annotation, index }))
    .filter(({ annotation }) => annotation.role.kind === "finding");
  const callouts = state.annotations
    .map((annotation, index) => ({ annotation, index }))
    .filter(({ annotation }) => annotation.role.kind === "callout");
  const rows: Array<{ text: string; annotationIndex: number | null }> = [];
  if (findings.length > 0) rows.push({ text: "Findings", annotationIndex: null });
  for (const item of findings) rows.push(...annotationDisplayRows(state, item.annotation, item.index));
  if (callouts.length > 0) rows.push({ text: "Human callouts", annotationIndex: null });
  for (const item of callouts) rows.push(...annotationDisplayRows(state, item.annotation, item.index));
  return rows;
}

function annotationDisplayRows(
  state: AppState,
  annotation: Annotation,
  index: number
): Array<{ text: string; annotationIndex: number | null }> {
  const marker = index === state.annotationCursor ? ">" : " ";
  const status = annotationStatusLabel(annotation);
  const freshness = annotationFreshnessLabel(state, annotation);
  const role = annotation.role.kind === "callout"
    ? "callout"
    : `${annotation.role.priority} ${annotation.role.audience}`;
  const line = `${marker} #${annotation.id} ${role} file ${annotation.fileId}:${annotation.anchor.start}-${annotation.anchor.end} ${status} ${freshness} ${annotation.comment}`;
  const result: Array<{ text: string; annotationIndex: number | null }> = [{ text: line, annotationIndex: index }];
  if (freshness.startsWith("⚠ stale")) {
    result.push({ text: `  snippet: ${oneLineSnippet(annotation.snippet)}`, annotationIndex: null });
  }
  return result;
}

function finishLines(state: AppState, width: number, height: number): string[] {
  if (state.mode.kind !== "finish") return [];
  const selected = state.mode.selected;
  const choices = [
    "Return without submitting",
    `Submit feedback and return (${state.mode.freshAgent} fresh agent finding(s))`,
    `Submit and ask pi to fix (${state.mode.freshAgent} fresh agent finding(s))`,
    "Cancel"
  ];
  const lines = [
    "Finish review",
    `${state.mode.staleAgent} stale agent finding(s) remain drafts · ${state.mode.humanNotes} human note(s) preserved`,
    "",
    ...choices.map((choice, index) => `${index === selected ? ">" : " "} ${choice}`)
  ];
  return padWindow(lines, width, height);
}

function analysisRunningLines(state: AppState, width: number, height: number): string[] {
  if (state.mode.kind !== "analysisRunning") return [];
  const progress = state.mode.total <= 0
    ? state.mode.message
    : `${state.mode.message} (${state.mode.completed}/${state.mode.total})`;
  const streamed = state.mode.outputTail.length === 0
    ? ["Waiting for model output..."]
    : wrapLines(state.mode.outputTail.split(/\r?\n/), width);
  return padWindow([
    state.mode.analysisMode === "narrative" ? "Running narrative" : "Running implementation review",
    `${state.mode.phase} · ${progress}`,
    "Esc cancels",
    "",
    ...streamed.slice(-Math.max(1, height - 4))
  ], width, height);
}

function annotationStatusLabel(annotation: Annotation): string {
  switch (annotation.state.kind) {
    case "draft":
      return "○ draft";
    case "queued":
      return "◐ queued";
    case "sent":
      return `● sent ${annotation.state.batchId}`;
  }
}

function annotationFreshnessLabel(state: AppState, annotation: Annotation): string {
  const file = state.files.find((candidate) => candidate.row.id === annotation.fileId);
  if (!file) return "⚠ stale · file no longer tracked";
  if (file.currentHash === annotation.anchor.hash) return "fresh";
  const filePatches = state.patches.filter((patch) => patch.fileId === annotation.fileId);
  const anchor =
    annotation.anchor.patchId === null
      ? "baseline"
      : `patch ${filePatches.find((patch) => patch.id === annotation.anchor.patchId)?.seq ?? "?"}`;
  const headPatch = filePatches[filePatches.length - 1];
  const head = headPatch ? `patch ${headPatch.seq}` : "baseline";
  const headHash = headPatch?.postHash ?? (file.row.baseline.kind === "present" ? file.row.baseline.hash : hashContent(""));
  const external = headHash !== file.currentHash ? " (+external)" : "";
  return `⚠ stale · anchored @ ${anchor}, file now @ ${head}${external}`;
}

function oneLineSnippet(snippet: string): string {
  return snippet.split(/\r?\n/).join("\\n");
}

function padWindow(lines: readonly string[], width: number, height: number): string[] {
  const padded = lines.slice(0, height).map((line) => pad(line, width));
  while (padded.length < height) padded.push(" ".repeat(width));
  return padded;
}

function pad(input: string, width: number): string {
  const truncated = truncateVisible(input, width);
  const padding = Math.max(0, width - visibleWidth(truncated));
  return `${truncated}${" ".repeat(padding)}`;
}
