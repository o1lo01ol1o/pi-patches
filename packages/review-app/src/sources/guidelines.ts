import { readFileSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { err, ok, type Result } from "@pi-patches/store";

export type ReviewGuidelines = {
  projectRoot: string;
  path: string;
  contents: string;
};

export function loadReviewGuidelines(cwd: string): Result<ReviewGuidelines | null> {
  const boundary = findProjectBoundary(cwd);
  if (!boundary.ok) return boundary;
  if (boundary.value === null) return ok(null);
  const path = join(boundary.value, "REVIEW_GUIDELINES.md");
  try {
    const contents = readFileSync(path, "utf8").trim();
    return contents.length === 0 ? ok(null) : ok({ projectRoot: boundary.value, path, contents });
  } catch (error) {
    if (isMissing(error)) return ok(null);
    return err({ kind: "Io", path, message: error instanceof Error ? error.message : String(error) });
  }
}

export function findProjectBoundary(cwd: string): Result<string | null> {
  const root = parse(cwd).root;
  for (let current = cwd;; current = dirname(current)) {
    const marker = join(current, ".pi");
    try {
      if (statSync(marker).isDirectory()) return ok(current);
    } catch (error) {
      if (!isMissing(error)) {
        return err({ kind: "Io", path: marker, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (current === root) return ok(null);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
