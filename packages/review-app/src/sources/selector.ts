import { err, ok, type HistoryMode, type Result, type SessionId } from "@pi-patches/store";

export type InspectSourceRequest =
  | { kind: "session"; sessionId: SessionId | null }
  | { kind: "workingTree" }
  | { kind: "branch"; baseRef: string; headRef: string }
  | { kind: "commit"; sha: string }
  | { kind: "commitRange"; baseExclusive: string; headInclusive: string }
  | { kind: "pullRequest"; number: number }
  | { kind: "snapshot"; paths: readonly [string, ...string[]] };

export type InspectRequest = {
  source: InspectSourceRequest;
  historyMode: HistoryMode;
};

export type SourcePreset = "session" | "workingTree" | "baseBranch" | "commitRange" | "pullRequest" | "snapshot";
export const sourcePresetOrder: readonly SourcePreset[] = [
  "session",
  "workingTree",
  "baseBranch",
  "commitRange",
  "pullRequest",
  "snapshot"
];

export type SelectorOption<T> = {
  id: string;
  label: string;
  description?: string;
  value: T;
};

export function parseInspectArgs(input: string): Result<InspectRequest | null> {
  const tokens = tokenize(input);
  if (!tokens.ok) return tokens;
  if (tokens.value.length === 0) return ok(null);
  const historyFlag = tokens.value.indexOf("--history");
  let historyMode: HistoryMode = "squashed";
  const args = [...tokens.value];
  if (historyFlag >= 0) {
    const value = args[historyFlag + 1];
    if (value !== "squashed" && value !== "per-commit" && value !== "perCommit") {
      return err({ kind: "InvalidInput", field: "inspect.history", message: "expected squashed or per-commit" });
    }
    historyMode = value === "squashed" ? "squashed" : "perCommit";
    args.splice(historyFlag, 2);
  }
  const [kind, ...rest] = args;
  switch (kind) {
    case "session":
      if (rest.length > 1) return usage("session [id]");
      return ok({ source: { kind: "session", sessionId: (rest[0] as SessionId | undefined) ?? null }, historyMode });
    case "working-tree":
    case "workingTree":
      return rest.length === 0 ? ok({ source: { kind: "workingTree" }, historyMode }) : usage("working-tree");
    case "branch":
      return rest.length === 1 || rest.length === 2
        ? ok({ source: { kind: "branch", baseRef: rest[0], headRef: rest[1] ?? "HEAD" }, historyMode })
        : usage("branch <base> [head]");
    case "commit":
      return rest.length === 1 ? ok({ source: { kind: "commit", sha: rest[0] }, historyMode }) : usage("commit <sha>");
    case "range": {
      const pair = rest.length === 1 ? rest[0].split("..") : rest;
      return pair.length === 2 && pair.every(Boolean)
        ? ok({ source: { kind: "commitRange", baseExclusive: pair[0], headInclusive: pair[1] }, historyMode })
        : usage("range <base>..<head>");
    }
    case "pr": {
      const number = Number(rest[0]);
      return rest.length === 1 && Number.isInteger(number) && number > 0
        ? ok({ source: { kind: "pullRequest", number }, historyMode })
        : usage("pr <number>");
    }
    case "snapshot":
      return rest.length > 0
        ? ok({ source: { kind: "snapshot", paths: rest as [string, ...string[]] }, historyMode })
        : usage("snapshot <path...>");
    default:
      return err({ kind: "InvalidInput", field: "inspect.source", message: `unknown source ${kind}` });
  }
}

export function fuzzyFilter<T>(options: readonly SelectorOption<T>[], query: string): SelectorOption<T>[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return [...options];
  return options
    .map((option, index) => ({ option, index, score: fuzzyScore(`${option.label} ${option.description ?? ""}`, normalized) }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => (left.score ?? 0) - (right.score ?? 0) || left.index - right.index)
    .map((entry) => entry.option);
}

export function smartPreselection(input: {
  connectedSessionHasPatches: boolean;
  workingTreeHasChanges: boolean;
  onNonDefaultBranch: boolean;
}): SourcePreset {
  if (input.connectedSessionHasPatches) return "session";
  if (input.workingTreeHasChanges) return "workingTree";
  if (input.onNonDefaultBranch) return "baseBranch";
  return "commitRange";
}

function fuzzyScore(candidate: string, query: string): number | null {
  const text = candidate.toLocaleLowerCase();
  const exact = text.indexOf(query);
  if (exact >= 0) return exact;
  let cursor = 0;
  let gap = 0;
  for (const character of query) {
    const found = text.indexOf(character, cursor);
    if (found < 0) return null;
    gap += found - cursor;
    cursor = found + 1;
  }
  return 1000 + gap;
}

function tokenize(input: string): Result<string[]> {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of input.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote !== null) return err({ kind: "InvalidInput", field: "inspect.args", message: "unterminated escape or quote" });
  if (current.length > 0) tokens.push(current);
  return ok(tokens);
}

function usage(expected: string): Result<never> {
  return err({ kind: "InvalidInput", field: "inspect.source", message: `expected ${expected}` });
}
