// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/lib/rl-events.test.ts — coverage for the Phase v1.1 G-5 AE emit
// helper. Mirrors the audit-log-g3 binding-undefined contract: a missing
// `env.AE` binding must NEVER throw — the gate path stays best-effort.

import { describe, it, expect, vi } from "vitest";
import { emitRateLimitEvent, observeRateLimit } from "./rl-events";
import type { Env } from "../types";

function makeRl(success: boolean): RateLimit {
  return {
    limit: vi.fn(async () => ({ success })),
  } as unknown as RateLimit;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

describe("emitRateLimitEvent", () => {
  it("is a no-op when env.AE is undefined", () => {
    const env = makeEnv();
    expect(() =>
      emitRateLimitEvent(env, {
        route: "auth-rate-limit-by-email",
        actor: "user@example.com",
        outcome: "ALLOW",
        ipOrSessionId: "1.2.3.4",
        count: 1,
        latencyMs: 12,
      }),
    ).not.toThrow();
  });

  it("calls writeDataPoint with the fixed schema when AE is bound", () => {
    const writeDataPoint = vi.fn();
    const env = makeEnv({
      AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    });

    emitRateLimitEvent(env, {
      route: "/api/auth/email-otp/send-verification-otp",
      actor: "user@example.com",
      outcome: "OTP_SEND_OK",
      ipOrSessionId: "1.2.3.4",
      count: 1,
      latencyMs: 42,
    });

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: [
        "/api/auth/email-otp/send-verification-otp",
        "user@example.com",
        "OTP_SEND_OK",
      ],
      doubles: [1, 42],
      indexes: ["1.2.3.4"],
    });
  });

  it("defaults count=1 and latencyMs=0 when omitted", () => {
    const writeDataPoint = vi.fn();
    const env = makeEnv({
      AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    });

    emitRateLimitEvent(env, {
      route: "/api/messages",
      actor: "user-id-abc",
      outcome: "MESSAGE_OK",
      ipOrSessionId: "user-id-abc",
    });

    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ["/api/messages", "user-id-abc", "MESSAGE_OK"],
      doubles: [1, 0],
      indexes: ["user-id-abc"],
    });
  });

  it("swallows AE exceptions — gate path must not propagate", () => {
    const writeDataPoint = vi.fn(() => {
      throw new Error("AE backpressure");
    });
    const env = makeEnv({
      AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    });

    expect(() =>
      emitRateLimitEvent(env, {
        route: "/api/auth/sign-in/email-otp",
        actor: "user@example.com",
        outcome: "OTP_VERIFY_FAIL",
        ipOrSessionId: "1.2.3.4",
      }),
    ).not.toThrow();
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
  });
});

describe("observeRateLimit (Phase v1.1 G-5 / TASK-2.1)", () => {
  const baseEvent = {
    route: "/api/auth/email-otp/send-verification-otp",
    actor: "user@example.com",
    ipOrSessionId: "1.2.3.4",
    count: 1,
    latencyMs: 0,
  };

  it("is a no-op when the binding is undefined (tests / local-dev)", async () => {
    const writeDataPoint = vi.fn();
    const env = makeEnv({
      AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    });
    await expect(
      observeRateLimit(undefined, "1.2.3.4:/login", env, baseEvent),
    ).resolves.toBeUndefined();
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it("calls rl.limit with the composite key", async () => {
    const rl = makeRl(true);
    const env = makeEnv();
    await observeRateLimit(rl, "1.2.3.4:/login", env, baseEvent);
    expect(rl.limit).toHaveBeenCalledTimes(1);
    expect(rl.limit).toHaveBeenCalledWith({ key: "1.2.3.4:/login" });
  });

  it("does NOT emit WOULD_LIMIT when result.success is true (allow path)", async () => {
    const rl = makeRl(true);
    const writeDataPoint = vi.fn();
    const env = makeEnv({
      AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    });
    await observeRateLimit(rl, "1.2.3.4:/login", env, baseEvent);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it("emits WOULD_LIMIT when result.success is false (shadow-mode signal)", async () => {
    const rl = makeRl(false);
    const writeDataPoint = vi.fn();
    const env = makeEnv({
      AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    });
    await observeRateLimit(rl, "1.2.3.4:/login", env, baseEvent);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: [
        "/api/auth/email-otp/send-verification-otp",
        "user@example.com",
        "WOULD_LIMIT",
      ],
      doubles: [1, 0],
      indexes: ["1.2.3.4"],
    });
  });

  it("swallows binding throws — gate path must not propagate", async () => {
    const rl = {
      limit: vi.fn(async () => {
        throw new Error("RL backpressure");
      }),
    } as unknown as RateLimit;
    const writeDataPoint = vi.fn();
    const env = makeEnv({
      AE: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    });
    await expect(
      observeRateLimit(rl, "1.2.3.4:/login", env, baseEvent),
    ).resolves.toBeUndefined();
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it("does NOT enforce — observation mode always falls through (no throw, no return)", async () => {
    // Observation mode contract: regardless of binding outcome, the helper
    // resolves to undefined. The caller proceeds. TASK-2.5 will replace
    // this helper with a 429-returning branch at the same call sites.
    const rlAllow = makeRl(true);
    const rlBlock = makeRl(false);
    const env = makeEnv();
    await expect(
      observeRateLimit(rlAllow, "k", env, baseEvent),
    ).resolves.toBeUndefined();
    await expect(
      observeRateLimit(rlBlock, "k", env, baseEvent),
    ).resolves.toBeUndefined();
  });
});
