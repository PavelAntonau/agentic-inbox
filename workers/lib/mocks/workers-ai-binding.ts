// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Workers AI factory swap for MOCK_MODE.
 *
 * `createWorkersAI({ binding: env.AI })` is the production factory used by
 * `workers/agent/index.ts`. In MOCK_MODE we return a drop-in replacement —
 * a function `(modelId) => LanguageModelV3` that yields a deterministic
 * canned response without ever calling Workers AI.
 *
 * The mock conforms to the AI SDK v6 `LanguageModelV3` interface (the
 * version `workers-ai-provider@3.x` actually emits — verified via
 * `node_modules/workers-ai-provider/dist/index.js` which sets
 * `specificationVersion = "v3"`). `streamText` and `generateText` see a
 * real-shaped model and produce real-shaped results, so the call sites in
 * `workers/agent/index.ts` (`onChatMessage`, `handleNewEmail`) keep
 * working with NO logic changes — only the factory swap.
 *
 * See `.research/mock-mode-architecture.md` § 5.
 */

import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import type { Env } from "../../types";
import { isAiMocked } from "../mock-mode";
import { mockAutoDraftReply, mockChatStreamReply } from "./ai-responses";

// AI SDK v6 model parts — narrow shape we emit. Exact union types live in
// `@ai-sdk/provider`; here we only need text-start / text-delta / text-end
// / finish, which is the minimum streamText / generateText accept.
type V3StreamPart =
  | { type: "stream-start"; warnings: never[] }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | {
      type: "finish";
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      finishReason: "stop";
    };

interface V3GenerateResult {
  content: Array<{ type: "text"; text: string }>;
  finishReason: "stop";
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  warnings: never[];
}

interface V3StreamResult {
  stream: ReadableStream<V3StreamPart>;
}

interface V3CallOptions {
  prompt?: Array<{
    role: string;
    content?: unknown;
  }>;
}

interface V3LanguageModel {
  readonly specificationVersion: "v3";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]>;
  doGenerate(options: V3CallOptions): Promise<V3GenerateResult>;
  doStream(options: V3CallOptions): Promise<V3StreamResult>;
}

/**
 * Returns the factory used by `workers/agent/index.ts`. Real `createWorkersAI`
 * in production; a deterministic mock factory in MOCK_MODE.
 *
 * Call site signature is unchanged: `const workersai = getWorkersAiFactory(env);`
 * then `workersai("@cf/...")` returns a `LanguageModelV3`.
 */
export function getWorkersAiFactory(
  env: Env,
): (modelId: string) => LanguageModel {
  if (!isAiMocked(env)) {
    return createWorkersAI({ binding: env.AI }) as unknown as (
      modelId: string,
    ) => LanguageModel;
  }
  return (modelId: string) =>
    mockLanguageModel(modelId) as unknown as LanguageModel;
}

/**
 * Pull the last user-text out of a v3 prompt array. Each `prompt[i].content`
 * is either a string OR an array of `{type: "text", text}` parts (AI SDK v6).
 */
function extractUserTexts(
  prompt: V3CallOptions["prompt"] | undefined,
): string[] {
  if (!prompt) return [];
  const out: string[] = [];
  for (const m of prompt) {
    if (m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") {
      out.push(c);
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          out.push((part as { text: string }).text);
        }
      }
    }
  }
  return out;
}

function pickReplyText(prompt: V3CallOptions["prompt"] | undefined): string {
  const userTexts = extractUserTexts(prompt);
  // Branch: auto-draft (the prompt has the auto-draft sentinel) → use the
  // mock auto-draft reply. Chat → use mock chat stream reply.
  const lastUser = userTexts[userTexts.length - 1] ?? "";
  if (
    lastUser.includes("[Auto-triggered]") ||
    lastUser.includes("draft a reply")
  ) {
    return mockAutoDraftReply(lastUser, "mock@local");
  }
  return mockChatStreamReply(userTexts).content;
}

function mockLanguageModel(modelId: string): V3LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "mock-workers-ai",
    modelId,
    supportedUrls: {},

    async doGenerate(options) {
      const text = pickReplyText(options.prompt);
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: {
          inputTokens: 0,
          outputTokens: text.length,
          totalTokens: text.length,
        },
        warnings: [],
      };
    },

    async doStream(options) {
      const text = pickReplyText(options.prompt);
      const id = "mock-text-1";
      const stream = new ReadableStream<V3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id });
          // Single-chunk delta keeps the protocol minimal but valid.
          controller.enqueue({ type: "text-delta", id, delta: text });
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({
            type: "finish",
            usage: {
              inputTokens: 0,
              outputTokens: text.length,
              totalTokens: text.length,
            },
            finishReason: "stop",
          });
          controller.close();
        },
      });
      return { stream };
    },
  };
}
