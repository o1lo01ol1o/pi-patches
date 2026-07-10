import { resolve } from "node:path";
import {
  checkedDocumentId,
  hashBytes,
  hashContent,
  type Attribution,
  type Baseline,
  type ContentHash,
  type ReviewDocument
} from "@pi-patches/store";

export type DocumentSide =
  | { kind: "absent" }
  | { kind: "blob"; bytes: Uint8Array; submodule?: false }
  | { kind: "submodule"; oid: string };

export function makeReviewDocument(input: {
  root: string;
  relPath: string;
  baseline: DocumentSide;
  head: DocumentSide;
  renamedFrom?: string | null;
  provenance: readonly Attribution[];
}): ReviewDocument {
  const idResult = checkedDocumentId(input.relPath);
  if (!idResult.ok) throw new Error("document path must be non-empty");
  const path = resolve(input.root, input.relPath);
  const baselineSubmodule = input.baseline.kind === "submodule";
  const headSubmodule = input.head.kind === "submodule";
  if (baselineSubmodule || headSubmodule) {
    return {
      kind: "submodule",
      id: idResult.value,
      path,
      relPath: input.relPath,
      baseline: opaqueSide(input.baseline),
      head: opaqueHead(input.head),
      renamedFrom: input.renamedFrom ?? null,
      provenance: input.provenance
    };
  }
  const baselineText = decodeTextSide(input.baseline);
  const headText = decodeTextSide(input.head);
  if (baselineText.kind === "binary" || headText.kind === "binary") {
    return {
      kind: "binary",
      id: idResult.value,
      path,
      relPath: input.relPath,
      baseline: opaqueSide(input.baseline),
      head: opaqueHead(input.head),
      renamedFrom: input.renamedFrom ?? null,
      provenance: input.provenance
    };
  }
  const baseline: Baseline = baselineText.kind === "absent"
    ? { kind: "absent" }
    : { kind: "present", content: baselineText.content, hash: hashContent(baselineText.content) };
  const headContent = headText.kind === "absent" ? null : headText.content;
  return {
    kind: "text",
    id: idResult.value,
    path,
    relPath: input.relPath,
    baseline,
    head: { content: headContent, hash: hashContent(headContent ?? "") },
    renamedFrom: input.renamedFrom ?? null,
    provenance: input.provenance
  };
}

export function normalizedDocumentFingerprint(document: ReviewDocument): unknown {
  return document.kind === "text"
    ? {
        kind: document.kind,
        id: document.id,
        relPath: document.relPath,
        renamedFrom: document.renamedFrom,
        baselineHash: document.baseline.kind === "present" ? document.baseline.hash : null,
        baselinePresent: document.baseline.kind === "present",
        headHash: document.head.hash,
        headPresent: document.head.content !== null,
        provenance: document.provenance
      }
    : {
        kind: document.kind,
        id: document.id,
        relPath: document.relPath,
        renamedFrom: document.renamedFrom,
        baselineHash: document.baseline.kind === "present" ? document.baseline.hash : null,
        baselinePresent: document.baseline.kind === "present",
        headHash: document.head.hash,
        headPresent: document.head.present,
        provenance: document.provenance
      };
}

function decodeTextSide(side: DocumentSide):
  | { kind: "absent" }
  | { kind: "text"; content: string }
  | { kind: "binary" } {
  if (side.kind === "absent") return side;
  if (side.kind === "submodule") return { kind: "binary" };
  if (side.bytes.includes(0)) return { kind: "binary" };
  try {
    return { kind: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(side.bytes) };
  } catch {
    return { kind: "binary" };
  }
}

function opaqueSide(side: DocumentSide): { kind: "absent" } | { kind: "present"; hash: ContentHash } {
  if (side.kind === "absent") return side;
  return { kind: "present", hash: sideHash(side) };
}

function opaqueHead(side: DocumentSide): { present: boolean; hash: ContentHash } {
  return side.kind === "absent"
    ? { present: false, hash: hashContent("") }
    : { present: true, hash: sideHash(side) };
}

function sideHash(side: Exclude<DocumentSide, { kind: "absent" }>): ContentHash {
  return side.kind === "submodule" ? hashContent(`submodule:${side.oid}`) : hashBytes(side.bytes);
}
