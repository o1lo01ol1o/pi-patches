import type {
  AnalysisMode,
  ImplementationReviewResult,
  ModelSelection,
  NarrativeResult,
  Result,
  ReviewDataset
} from "@pi-patches/store";

export type NarrativeRequest = {
  mode: "narrative";
  dataset: ReviewDataset;
  model: ModelSelection;
  focus?: string;
};

export type ImplementationReviewRequest = {
  mode: "implementationReview";
  dataset: ReviewDataset;
  model: ModelSelection;
  focus?: string;
  guidelines: string | null;
};

export type AnalysisRequest = NarrativeRequest | ImplementationReviewRequest;
export type AnalysisOutput = NarrativeResult | ImplementationReviewResult;

export type ModelOption = ModelSelection & {
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
};

export type ModelInvocation = {
  mode: AnalysisMode;
  phase: "direct" | "chunk" | "reduce" | "synthesis";
  promptVersion: string;
  model: ModelSelection;
  systemPrompt: string;
  userPrompt: string;
};

export type ModelResponse = {
  text: string;
  resolvedModel: ModelSelection;
};

export interface ModelRunner {
  listModels(): readonly ModelOption[];
  run(
    invocation: ModelInvocation,
    options: { signal?: AbortSignal; onDelta?: (text: string) => void }
  ): Promise<Result<ModelResponse>>;
}

export type AnalysisProgress = {
  phase: ModelInvocation["phase"];
  completed: number;
  total: number;
  message: string;
  delta?: string;
};

export type AnalysisExecutionOptions = {
  maxInputTokens?: number;
  maxChunkTokens?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
  validateSourceBeforeComplete?: () => Result<void>;
};

export type AnalysisExecution = {
  output: AnalysisOutput;
  rawOutput: string;
  documentCoverage: Array<{ id: string; state: { kind: "included" | "summarized" } }>;
  commitCoverage: Array<{ id: string; state: { kind: "included" | "summarized" } }>;
  promptVersion: string;
};
