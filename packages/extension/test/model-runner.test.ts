import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions
} from "@earendil-works/pi-ai/compat";
import type { ModelInvocation } from "@pi-patches/review-app/analysis";
import { PiModelRunner, defaultModelSelection } from "../src/model-runner.ts";

const model: Model<Api> = {
  id: "selected-model",
  name: "Selected Model",
  api: "openai-responses",
  provider: "fake-provider",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_000
};

test("PiModelRunner lists configured models and streams the explicitly selected model", async () => {
  const calls: Array<{ model: Model<Api>; context: Context; options?: SimpleStreamOptions }> = [];
  const registry = fakeRegistry(model);
  const runner = new PiModelRunner(registry, (selected, context, options) => {
    calls.push({ model: selected, context, options });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const partial = assistant("");
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "{\"ok\":", partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "true}", partial });
      stream.push({ type: "text_end", contentIndex: 0, content: "{\"ok\":true}", partial });
      stream.push({ type: "done", reason: "stop", message: assistant("{\"ok\":true}") });
    });
    return stream;
  });
  const deltas: string[] = [];
  const result = await runner.run(invocation(), { onDelta: (delta) => deltas.push(delta) });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.text, "{\"ok\":true}");
  assert.deepEqual(result.value.resolvedModel, invocation().model);
  assert.deepEqual(deltas, ["{\"ok\":", "true}"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, model);
  assert.equal(calls[0].context.systemPrompt, "system");
  assert.equal(calls[0].context.messages[0]?.role, "user");
  assert.equal(calls[0].options?.reasoning, "high");
  assert.equal(calls[0].options?.apiKey, "secret");
  assert.deepEqual(runner.listModels()[0], {
    provider: "fake-provider",
    modelId: "selected-model",
    thinkingLevel: "medium",
    name: "Selected Model",
    contextWindow: 32_000,
    maxOutputTokens: 4_000,
    supportsThinking: true
  });
});

test("PiModelRunner rejects unsupported thinking without changing selection defaults", async () => {
  const plain = { ...model, reasoning: false };
  const runner = new PiModelRunner(fakeRegistry(plain), () => {
    throw new Error("stream must not run");
  });
  const selected = defaultModelSelection(runner, plain);
  assert.equal(selected?.provider, plain.provider);
  assert.equal(selected?.modelId, plain.id);
  assert.equal(selected?.thinkingLevel, "off");

  const result = await runner.run(invocation(), {});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "InvalidInput");
    assert.equal(result.error.kind === "InvalidInput" ? result.error.field : null, "model.thinkingLevel");
  }
});

function fakeRegistry(available: Model<Api>) {
  return {
    getAvailable: () => [available],
    find: (provider: string, id: string) => provider === available.provider && id === available.id ? available : undefined,
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret", headers: { "x-test": "yes" } })
  };
}

function invocation(): ModelInvocation {
  return {
    mode: "narrative",
    phase: "direct",
    promptVersion: "test/v1",
    model: { provider: model.provider, modelId: model.id, thinkingLevel: "high" },
    systemPrompt: "system",
    userPrompt: "user"
  };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}
