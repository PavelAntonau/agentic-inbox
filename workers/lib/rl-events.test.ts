// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/lib/rl-events.test.ts — coverage for the Phase v1.1 G-5 AE emit
// helper. Mirrors the audit-log-g3 binding-undefined contract: a missing
// `env.AE` binding must NEVER throw — the gate path stays best-effort.

import { describe, it, expect, vi } from "vitest";
import { emitRateLimitEvent } from "./rl-events";
import type { Env } from "../types";

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
