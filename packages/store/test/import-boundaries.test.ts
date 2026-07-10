import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const pureModules = [
  "packages/store/src/schema.ts",
  "packages/store/src/rows.ts",
  "packages/extension/src/format-message.ts",
  ...readdirSync("packages/review-app/src/render")
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join("packages/review-app/src/render", entry))
];

test("pure boundary modules do not import filesystem or sqlite effects", () => {
  const offenders = pureModules.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return forbiddenImports(source).map((specifier) => `${path}: ${specifier}`);
  });

  assert.deepEqual(offenders, []);
});

function forbiddenImports(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier === "node:fs" || specifier === "node:sqlite") specifiers.push(specifier);
  }
  return specifiers;
}
