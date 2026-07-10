import { createTwoFilesPatch } from "diff";
import type { ReviewDataset, ReviewDocument } from "@pi-patches/store";

export type AnalysisManifest = {
  strategy: "direct" | "hierarchical";
  stats: {
    files: number;
    commits: number;
    bytes: number;
    diffRows: number;
    estimatedTokens: number;
  };
  chunks: readonly AnalysisChunk[];
  documentIds: readonly string[];
  commitShas: readonly string[];
};

export type AnalysisChunk = {
  id: string;
  content: string;
  unitIds: readonly string[];
  documentIds: readonly string[];
  commitShas: readonly string[];
  estimatedTokens: number;
};

type Unit = {
  id: string;
  content: string;
  documentIds: string[];
  commitShas: string[];
};

export function planAnalysis(
  dataset: ReviewDataset,
  options: { maxInputTokens: number; maxChunkTokens: number }
): AnalysisManifest {
  const documentUnits = dataset.documents.map(documentUnit);
  const commitUnits = dataset.historyMode === "perCommit" ? dataset.commits.map(commitUnit) : [];
  const units = [...documentUnits, ...commitUnits];
  const combined = units.map((unit) => unit.content).join("\n\n");
  const stats = {
    files: dataset.documents.length,
    commits: dataset.historyMode === "perCommit" ? dataset.commits.length : 0,
    bytes: Buffer.byteLength(combined),
    diffRows: countDiffRows(dataset),
    estimatedTokens: estimateTokens(combined)
  };
  const documentIds = dataset.documents.map((document) => String(document.id));
  const commitShas = dataset.historyMode === "perCommit" ? dataset.commits.map((commit) => commit.sha) : [];
  if (stats.estimatedTokens <= options.maxInputTokens) {
    return {
      strategy: "direct",
      stats,
      chunks: [{ id: "direct:0", content: combined, unitIds: units.map((unit) => unit.id), documentIds, commitShas, estimatedTokens: stats.estimatedTokens }],
      documentIds,
      commitShas
    };
  }
  const split = units.flatMap((unit) => splitUnit(unit, options.maxChunkTokens));
  const chunks: AnalysisChunk[] = [];
  let current: Unit[] = [];
  let currentTokens = 0;
  for (const unit of split) {
    const tokens = estimateTokens(unit.content);
    if (current.length > 0 && currentTokens + tokens > options.maxChunkTokens) {
      chunks.push(packChunk(chunks.length, current));
      current = [];
      currentTokens = 0;
    }
    current.push(unit);
    currentTokens += tokens;
  }
  if (current.length > 0) chunks.push(packChunk(chunks.length, current));
  return { strategy: "hierarchical", stats, chunks, documentIds, commitShas };
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value) / 4));
}

function documentUnit(document: ReviewDocument): Unit {
  const body = document.kind === "text"
    ? {
        kind: document.kind,
        id: document.id,
        path: document.relPath,
        renamedFrom: document.renamedFrom,
        baseline: document.baseline.kind === "present" ? document.baseline.content : null,
        head: document.head.content,
        diff: createTwoFilesPatch(
          document.renamedFrom ?? document.relPath,
          document.relPath,
          document.baseline.kind === "present" ? document.baseline.content : "",
          document.head.content ?? "",
          "baseline",
          "head",
          { context: 3 }
        ),
        provenance: document.provenance
      }
    : {
        kind: document.kind,
        id: document.id,
        path: document.relPath,
        renamedFrom: document.renamedFrom,
        baseline: document.baseline,
        head: document.head,
        provenance: document.provenance
      };
  return { id: `document:${document.id}`, content: `DOCUMENT\n${JSON.stringify(body)}`, documentIds: [String(document.id)], commitShas: [] };
}

function commitUnit(commit: ReviewDataset["commits"][number]): Unit {
  const body = {
    sha: commit.sha,
    parents: commit.parents,
    subject: commit.subject,
    authoredAt: commit.authoredAt,
    changes: commit.changes
  };
  return { id: `commit:${commit.sha}`, content: `COMMIT\n${JSON.stringify(body)}`, documentIds: commit.documents.map(String), commitShas: [commit.sha] };
}

function splitUnit(unit: Unit, maxTokens: number): Unit[] {
  if (estimateTokens(unit.content) <= maxTokens) return [unit];
  const maxBytes = Math.max(64, maxTokens * 4 - 256 - Buffer.byteLength(unit.id));
  const lines = unit.content.split("\n");
  const parts: string[] = [];
  let current = "";
  for (const line of lines) {
    if (Buffer.byteLength(line) > maxBytes) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      for (let offset = 0; offset < line.length; offset += maxBytes) parts.push(line.slice(offset, offset + maxBytes));
      continue;
    }
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (current.length > 0 && Buffer.byteLength(candidate) > maxBytes) {
      parts.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts.map((content, index) => ({
    ...unit,
    id: `${unit.id}:part-${index + 1}-of-${parts.length}`,
    content: `SLICE ${index + 1}/${parts.length} OF ${unit.id}\n${content}`
  }));
}

function packChunk(index: number, units: readonly Unit[]): AnalysisChunk {
  const content = units.map((unit) => unit.content).join("\n\n");
  return {
    id: `chunk:${index + 1}`,
    content,
    unitIds: units.map((unit) => unit.id),
    documentIds: unique(units.flatMap((unit) => unit.documentIds)),
    commitShas: unique(units.flatMap((unit) => unit.commitShas)),
    estimatedTokens: estimateTokens(content)
  };
}

function countDiffRows(dataset: ReviewDataset): number {
  const documentRows = dataset.documents.reduce((count, document) => {
    if (document.kind !== "text") return count + 1;
    const baseline = document.baseline.kind === "present" ? document.baseline.content : "";
    const head = document.head.content ?? "";
    return count + createTwoFilesPatch(document.relPath, document.relPath, baseline, head).split("\n").length;
  }, 0);
  const commitRows = dataset.historyMode === "perCommit"
    ? dataset.commits.reduce((count, commit) => count + commit.changes.reduce((inner, change) => inner + change.patch.split("\n").length, 0), 0)
    : 0;
  return documentRows + commitRows;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
