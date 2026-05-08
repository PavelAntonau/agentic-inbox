// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/lib/global-rate-limit.test.ts — coverage for the aggregate
// backstops added on top of the per-IP / per-email defenses.

import { describe, it, expect, vi } from "vitest";
import {
  enforceGlobalOtpEdgeLimit,
  checkAndIncrementDailyOtpQuota,
  DAILY_OTP_QUOTA,
} from "./global-rate-limit";
import type { Env } from "../types";

function makeRl(success: boolean): RateLimit {
  return {
    limit: vi.fn(async () => ({ success })),
  } as unknown as RateLimit;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

// Minimal D1 mock — only the prepare/bind/first/run chain we use.
function makeD1(opts: {
  existing: { count: number; last_request: number } | null;
}) {
  const calls: string[] = [];
  let row = opts.existing;
  const stmt = (sql: string) => {
    return {
      bind: (..._args: unknown[]) => ({
        first: async () => {
          calls.push(`first:${sql}`);
          return row;
        },
        run: async () => {
          calls.push(`run:${sql}`);
          if (sql.startsWith("INSERT INTO rate_limit")) {
            row = { count: 1, last_request: Date.now() };
          } else if (sql.startsWith("UPDATE rate_limit")) {
            const newCount = (row?.count ?? 0) + 1;
            row = { count: newCount, last_request: Date.now() };
          }
          return { success: true };
        },
      }),
    };
  };
  return {
    prepare: vi.fn((sql: string) => stmt(sql)),
    _calls: calls,
    _row: () => row,
  };
}

describe("enforceGlobalOtpEdgeLimit", () => {
  it("returns null when binding is absent (tests / pre-binding deploy)", async () => {
    const env = makeEnv();
    const result = await enforceGlobalOtpEdgeLimit(env);
    expect(result).toBeNull();
  });

  it("returns null on success (allow path)", async () => {
    const rl = makeRl(true);
    const env = makeEnv({ RL_LOGIN_GLOBAL: rl });
    const result = await enforceGlobalOtpEdgeLimit(env);
    expect(result).toBeNull();
    expect(rl.limit).toHaveBeenCalledWith({ key: "global:otp-send" });
  });

  it("returns 429 on !success with Retry-After header", async () => {
    const rl = makeRl(false);
    const env = makeEnv({ RL_LOGIN_GLOBAL: rl });
    const result = await enforceGlobalOtpEdgeLimit(env);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get("Retry-After")).toBe("10");
    const body = (await result!.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("GLOBAL_RATE_LIMITED");
  });

  it("uses a CONSTANT key (the whole point — aggregate counter)", async () => {
    const rl = makeRl(true);
    const env = makeEnv({ RL_LOGIN_GLOBAL: rl });
    await enforceGlobalOtpEdgeLimit(env);
    await enforceGlobalOtpEdgeLimit(env);
    await enforceGlobalOtpEdgeLimit(env);
    const calls = (rl.limit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toEqual({ key: "global:otp-send" });
    expect(calls[1][0]).toEqual({ key: "global:otp-send" });
    expect(calls[2][0]).toEqual({ key: "global:otp-send" });
  });

  it("swallows binding throws — gate path must not propagate", async () => {
    const rl = {
      limit: vi.fn(async () => {
        throw new Error("transient infra blip");
      }),
    } as unknown as RateLimit;
    const env = makeEnv({ RL_LOGIN_GLOBAL: rl });
    const result = await enforceGlobalOtpEdgeLimit(env);
    expect(result).toBeNull();
  });
});

describe("checkAndIncrementDailyOtpQuota", () => {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  it("returns null when DB is absent (tests / pre-binding deploy)", async () => {
    const env = makeEnv();
    const result = await checkAndIncrementDailyOtpQuota(env);
    expect(result).toBeNull();
  });

  it("inserts and allows on first call (no existing row)", async () => {
    const db = makeD1({ existing: null });
    const env = makeEnv({ DB: db as unknown as D1Database });
    const result = await checkAndIncrementDailyOtpQuota(env);
    expect(result).toBeNull();
    // Verify INSERT branch was used
    expect(db._calls.some((c) => c.includes("INSERT INTO rate_limit"))).toBe(
      true,
    );
  });

  it("increments and allows when existing row is under limit", async () => {
    const db = makeD1({
      existing: { count: 100, last_request: Date.now() - 1000 },
    });
    const env = makeEnv({ DB: db as unknown as D1Database });
    const result = await checkAndIncrementDailyOtpQuota(env);
    expect(result).toBeNull();
    // Verify UPDATE branch was used
    expect(db._calls.some((c) => c.includes("UPDATE rate_limit"))).toBe(true);
  });

  it("resets the counter when last_request is older than 24h", async () => {
    const db = makeD1({
      existing: {
        count: DAILY_OTP_QUOTA + 100, // OVER the cap, but stale window
        last_request: Date.now() - ONE_DAY_MS - 10_000,
      },
    });
    const env = makeEnv({ DB: db as unknown as D1Database });
    const result = await checkAndIncrementDailyOtpQuota(env);
    expect(result).toBeNull();
    // Should have used the INSERT-with-ON-CONFLICT branch (window expired)
    expect(db._calls.some((c) => c.includes("INSERT INTO rate_limit"))).toBe(
      true,
    );
  });

  it("returns 429 when count would exceed DAILY_OTP_QUOTA", async () => {
    const db = makeD1({
      existing: { count: DAILY_OTP_QUOTA, last_request: Date.now() - 1000 },
    });
    const env = makeEnv({ DB: db as unknown as D1Database });
    const result = await checkAndIncrementDailyOtpQuota(env);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get("Retry-After")).toBeTruthy();
    const body = (await result!.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("DAILY_QUOTA_EXCEEDED");
  });

  it("fails OPEN when D1 throws — gate path must not propagate", async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: () => ({
          first: async () => {
            throw new Error("D1 outage");
          },
          run: async () => {
            throw new Error("D1 outage");
          },
        }),
      })),
    };
    const env = makeEnv({ DB: db as unknown as D1Database });
    // Suppress the console.warn that fail-open emits.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await checkAndIncrementDailyOtpQuota(env);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
