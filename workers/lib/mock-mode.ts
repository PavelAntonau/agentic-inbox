// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * MOCK_MODE — single-source-of-truth helper for the autonomous-local-testing
 * mock layer.
 *
 * `MOCK_MODE=1` is set ONLY in `.dev.vars` (gitignored). When set:
 *   - CF Access middleware → mock shim (workers/lib/mock-access.ts)
 *   - AI calls → canned responses (workers/lib/mocks/ai-responses.ts)
 *   - env.EMAIL.send() → R2-backed outbox (workers/lib/mocks/email-binding.ts)
 *   - api.cloudflare.com calls → fixture data
 *   - /__mock/* router becomes available
 *
 * Production deploys never carry MOCK_MODE — the worker fails closed if it
 * leaks, since every mock branch double-checks against CF_ACCESS_DEV_MODE
 * AND/OR the absence of real CF credentials.
 *
 * See `.research/mock-mode-architecture.md` for the full design.
 */

/** Minimal env shape for MOCK_MODE detection — keeps callers loose-coupled. */
type MockModeEnvShape = {
  MOCK_MODE?: string;
  CF_ACCESS_DEV_MODE?: string;
  DEV_MOCK_AI?: string;
};

/**
 * The umbrella switch. Every new mock-aware code path checks this.
 * Strict equality with the string `"1"` so a stray `"true"` / `"yes"` doesn't
 * accidentally enable mock paths in production.
 */
export function isMockMode(env: MockModeEnvShape): boolean {
  return env.MOCK_MODE === "1";
}

/**
 * AI-specific gate. Backwards-compatible with the existing `DEV_MOCK_AI=true`
 * convention from `workers/lib/ai.ts`; `MOCK_MODE=1` also implies it.
 */
export function isAiMocked(env: MockModeEnvShape & { AI?: Ai }): boolean {
  return (
    env.MOCK_MODE === "1" ||
    (typeof env.DEV_MOCK_AI === "string" &&
      env.DEV_MOCK_AI.toLowerCase() === "true")
  );
}

/**
 * CF Access management API gate. Backwards-compatible with the existing
 * `CF_ACCESS_DEV_MODE === "mock" || !env.CF_ACCOUNT_ID` triggers used in
 * `workers/lib/cloudflare-access-policy.ts`; MOCK_MODE=1 makes them implicit.
 */
export function isCfAccessApiMocked(
  env: MockModeEnvShape & { CF_ACCOUNT_ID?: string },
): boolean {
  return (
    env.MOCK_MODE === "1" ||
    env.CF_ACCESS_DEV_MODE === "mock" ||
    !env.CF_ACCOUNT_ID
  );
}
