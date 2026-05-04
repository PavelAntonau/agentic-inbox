// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Canned AI responses for MOCK_MODE.
 *
 * Each function returns deterministic output keyed off the input so the same
 * email body always produces the same canned reply — important for browser-mcp
 * scenarios that snapshot the agent panel and expect stable text.
 *
 * Used by:
 *   - workers/lib/ai.ts (isPromptInjection, verifyDraft) — returns directly
 *   - workers/agent/index.ts (Kimi/streamText sites) — wraps the model
 *     factory so streamText sees a fake LanguageModelV1 yielding fixed text.
 *
 * See `.research/mock-mode-architecture.md` § 5.
 */

/** Hash a string deterministically (FNV-1a-ish) → 32-bit hex token. */
function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Mock for `isPromptInjection`. Always returns false unless the body contains
 * the literal sentinel `__MOCK_INJECT__` (so the scenario library can exercise
 * the "injection detected" branch deterministically).
 */
export function mockIsPromptInjection(bodyHtml: string): boolean {
  return bodyHtml.includes("__MOCK_INJECT__");
}

/**
 * Mock for `verifyDraft`. Returns the input unchanged unless the body
 * contains the sentinel `__MOCK_REWRITE__` (which triggers a deterministic
 * rewrite to exercise the "AI cleaned content" branch).
 */
export function mockVerifyDraft(body: string): string {
  if (body.includes("__MOCK_REWRITE__")) {
    return body.replace(/__MOCK_REWRITE__/g, "[mock-cleaned]");
  }
  return body;
}

/**
 * Canned auto-draft reply for `EmailAgent.handleNewEmail`. Deterministic from
 * the email body so scenarios can assert exact text.
 */
export function mockAutoDraftReply(emailBody: string, sender: string): string {
  const tag = hashText(emailBody).slice(0, 6);
  return [
    `Hi,`,
    ``,
    `Thanks for your email. (Mock-reply ${tag} — generated locally because`,
    `MOCK_MODE=1; replace with the real Workers AI output for production.)`,
    ``,
    `Best,`,
    `ActionNow.AI`,
  ].join("\n");
}

/**
 * Canned chat-stream message for `streamText` calls in agent/index.ts.
 * Returns one assistant message that ends the stream cleanly.
 */
export function mockChatStreamReply(userMessages: string[]): {
  role: "assistant";
  content: string;
} {
  const lastUser = userMessages[userMessages.length - 1] ?? "";
  const tag = hashText(lastUser).slice(0, 6);
  return {
    role: "assistant",
    content:
      `Mock-chat-${tag}: I received "${lastUser.slice(0, 80)}". This response is ` +
      `generated locally (MOCK_MODE=1) without calling Workers AI.`,
  };
}
