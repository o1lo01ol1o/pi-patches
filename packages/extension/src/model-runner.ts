import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  streamSimple,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions
} from "@earendil-works/pi-ai/compat";
import { err, ok, type Result } from "@pi-patches/store";
import type { ModelInvocation, ModelOption, ModelResponse, ModelRunner } from "@pi-patches/review-app/analysis";

type Registry = Pick<ModelRegistry, "getAvailable" | "find" | "getApiKeyAndHeaders">;
type StreamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => ReturnType<typeof streamSimple>;

export class PiModelRunner implements ModelRunner {
  private readonly registry: Registry;
  private readonly stream: StreamSimple;

  constructor(registry: Registry, stream: StreamSimple = streamSimple) {
    this.registry = registry;
    this.stream = stream;
  }

  listModels(): readonly ModelOption[] {
    return this.registry.getAvailable().map((model) => ({
      provider: model.provider,
      modelId: model.id,
      thinkingLevel: model.reasoning ? "medium" : "off",
      name: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      supportsThinking: model.reasoning
    }));
  }

  async run(
    invocation: ModelInvocation,
    options: { signal?: AbortSignal; onDelta?: (text: string) => void }
  ): Promise<Result<ModelResponse>> {
    const model = this.registry.find(invocation.model.provider, invocation.model.modelId);
    if (!model) return err({ kind: "InvalidInput", field: "model", message: "selected model is no longer available" });
    if (!getSupportedThinkingLevels(model).includes(invocation.model.thinkingLevel)) {
      return err({ kind: "InvalidInput", field: "model.thinkingLevel", message: `${invocation.model.thinkingLevel} is unsupported by this model` });
    }
    const auth = await this.registry.getApiKeyAndHeaders(model);
    if (!auth.ok) return err({ kind: "Io", path: `${model.provider}/${model.id}`, message: auth.error });
    const context: Context = {
      systemPrompt: invocation.systemPrompt,
      messages: [{ role: "user", content: invocation.userPrompt, timestamp: Date.now() }]
    };
    const stream = this.stream(model, context, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: options.signal,
      maxTokens: model.maxTokens,
      reasoning: invocation.model.thinkingLevel === "off" ? undefined : invocation.model.thinkingLevel,
      maxRetries: 0
    });
    let text = "";
    try {
      for await (const event of stream) {
        if (event.type === "text_delta") {
          text += event.delta;
          options.onDelta?.(event.delta);
        } else if (event.type === "error") {
          return err({
            kind: "Io",
            path: `${model.provider}/${model.id}`,
            message: event.error.errorMessage ?? `model ${event.reason}`
          });
        } else if (event.type === "done") {
          if (event.reason !== "stop") {
            return err({ kind: "Io", path: `${model.provider}/${model.id}`, message: `model stopped with ${event.reason}` });
          }
          if (text.length === 0) {
            text = event.message.content
              .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
              .map((content) => content.text)
              .join("");
          }
        }
      }
    } catch (error) {
      return err({
        kind: "Io",
        path: `${model.provider}/${model.id}`,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    if (text.length === 0) return err({ kind: "Io", path: `${model.provider}/${model.id}`, message: "model returned no text" });
    return ok({ text, resolvedModel: invocation.model });
  }
}

export function defaultModelSelection(
  runner: ModelRunner,
  current: Model<Api> | undefined
): ModelOption | null {
  const models = runner.listModels();
  if (current) {
    const match = models.find((model) => model.provider === current.provider && model.modelId === current.id);
    if (match) return match;
  }
  return models[0] ?? null;
}
