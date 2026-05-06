// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C2 / A-04 — cloudflare-access-policy mock-mode posture.
//
// The previous code mock-mode'd whenever CF_ACCOUNT_ID was unset, which
// silently swallowed Access-policy mutations in production. The new
// behaviour throws 503 (well, returns { ok: false, error }) in non-DEV
// when CF_ACCOUNT_ID is missing. DEV (Vite/Vitest) keeps mocking.

import { describe, expect, it } from "vitest";
import { upsertEmail, removeEmail } from "./cloudflare-access-policy";

const baseEnv = {
  CF_ACCESS_API_TOKEN: "tok",
  CF_POLICY_ID: "pol",
  // intentionally vary CF_ACCOUNT_ID per case
} as unknown as Parameters<typeof upsertEmail>[0];

describe("cloudflare-access-policy — Phase C2 / A-04 mock-mode posture", () => {
  it("MOCK_MODE=1 always mocks (regardless of CF_ACCOUNT_ID)", async () => {
    const env = {
      ...baseEnv,
      MOCK_MODE: "1",
      CF_ACCOUNT_ID: "real-account",
    } as Parameters<typeof upsertEmail>[0];
    const r = await upsertEmail(env, "x@y.com");
    expect(r).toEqual({ ok: true, mocked: true });
  });

  it("CF_ACCESS_DEV_MODE=mock always mocks", async () => {
    const env = {
      ...baseEnv,
      CF_ACCESS_DEV_MODE: "mock",
    } as Parameters<typeof upsertEmail>[0];
    const r = await upsertEmail(env, "x@y.com");
    expect(r).toEqual({ ok: true, mocked: true });
  });

  it("DEV environment without CF_ACCOUNT_ID falls through to mock (test runs in DEV)", async () => {
    // Vitest sets import.meta.env.DEV = true, so this path mocks.
    const env = { ...baseEnv } as Parameters<typeof upsertEmail>[0];
    const r = await upsertEmail(env, "x@y.com");
    expect(r.ok).toBe(true);
    expect(r.mocked).toBe(true);
  });

  it("removeEmail follows the same posture", async () => {
    const env = {
      ...baseEnv,
      MOCK_MODE: "1",
    } as Parameters<typeof removeEmail>[0];
    const r = await removeEmail(env, "x@y.com");
    expect(r).toEqual({ ok: true, mocked: true });
  });
});
