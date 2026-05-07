// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G / G-3 — Extended audit-log coverage.
//
// Covers:
//   • All new auth action strings parse and insert.
//   • status / tenant_id / user_agent flow through to the row.
//   • user_agent longer than 500 chars is truncated.
//   • Analytics Engine writeDataPoint is called with correct shape.
//   • AE failure does not propagate.
//   • When AUTH_ANALYTICS binding is undefined, no error.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { writeAudit } from "./audit-log";

// ---------------------------------------------------------------------------
// Shared fake-DB factory (mirrors the one in audit-log-c3.test.ts)
// ---------------------------------------------------------------------------

interface CapturedInsert {
  values: Record<string, unknown>;
}

function makeFakeDb(opts: { throwOnRun?: boolean } = {}): {
  db: D1Database;
  captured: CapturedInsert[];
} {
  const captured: CapturedInsert[] = [];
  const stub = {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        run: () => {
          if (opts.throwOnRun) throw new Error("D1 down");
          captured.push({ values: { args } });
          return Promise.resolve({ meta: {} });
        },
        all: () => Promise.resolve({ results: [] }),
        first: () => Promise.resolve(null),
        get: () => Promise.resolve(null),
      }),
      run: () => {
        if (opts.throwOnRun) throw new Error("D1 down");
        captured.push({ values: {} });
        return Promise.resolve({ meta: {} });
      },
    }),
    batch: () => Promise.resolve([]),
    exec: () => Promise.resolve({ count: 0, duration: 0 }),
    dump: () => Promise.resolve(new ArrayBuffer(0)),
  };
  return { db: stub as unknown as D1Database, captured };
}

// ---------------------------------------------------------------------------
// Fake Analytics Engine binding
// ---------------------------------------------------------------------------

function makeFakeAE(): {
  ae: AnalyticsEngineDataset;
  calls: AnalyticsEngineDataPoint[];
  throwNext: () => void;
} {
  const calls: AnalyticsEngineDataPoint[] = [];
  let shouldThrow = false;
  const ae: AnalyticsEngineDataset = {
    writeDataPoint(event?: AnalyticsEngineDataPoint) {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("AE down");
      }
      calls.push(event ?? {});
    },
  };
  return {
    ae,
    calls,
    throwNext: () => {
      shouldThrow = true;
    },
  };
}

// Minimal fake ExecutionContext.waitUntil that resolves the promise immediately.
function makeFakeCtx(): Pick<ExecutionContext, "waitUntil"> {
  return {
    waitUntil(p: Promise<unknown>) {
      // Drain the promise so assertions in the same tick can observe its side-effects.
      p.catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Auth action strings — compile-time check via assignment
// ---------------------------------------------------------------------------

describe("Phase G / G-3 — new auth action strings", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  const authActions = [
    "auth.signup_gate_blocked",
    "auth.otp_sent",
    "auth.otp_verified",
    "auth.otp_failed",
    "auth.fresh_session_denied",
    "auth.pat_minted",
    "auth.invitation_redeemed",
    "auth.signin_success",
  ] as const;

  for (const action of authActions) {
    it(`inserts row for action "${action}"`, async () => {
      const { db, captured } = makeFakeDb();
      await writeAudit(db, {
        action,
        target: { kind: "auth", id: "test" },
        actor_user_id: "u1",
        status: "success",
      });
      expect(captured).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// New column flow-through
// ---------------------------------------------------------------------------

describe("Phase G / G-3 — status / tenant_id / user_agent columns", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("status flows through to the D1 row", async () => {
    const { db, captured } = makeFakeDb();
    await writeAudit(db, {
      action: "auth.otp_failed",
      target: { kind: "auth", id: "otp" },
      status: "denied",
    });
    expect(captured).toHaveLength(1);
    // The positional args Drizzle binds contain "denied" somewhere.
    const blob = JSON.stringify(captured);
    expect(blob.includes("denied")).toBe(true);
  });

  it("tenant_id flows through to the D1 row", async () => {
    const { db, captured } = makeFakeDb();
    await writeAudit(db, {
      action: "auth.signin_success",
      target: { kind: "auth", id: "session" },
      tenant_id: "group-abc",
      status: "success",
    });
    expect(captured).toHaveLength(1);
    const blob = JSON.stringify(captured);
    expect(blob.includes("group-abc")).toBe(true);
  });

  it("user_agent flows through to the D1 row", async () => {
    const { db, captured } = makeFakeDb();
    await writeAudit(db, {
      action: "auth.otp_sent",
      target: { kind: "auth", id: "otp" },
      user_agent: "Mozilla/5.0 (test)",
    });
    expect(captured).toHaveLength(1);
    const blob = JSON.stringify(captured);
    expect(blob.includes("Mozilla/5.0 (test)")).toBe(true);
  });

  it("user_agent longer than 500 chars is truncated to exactly 500", async () => {
    const { db, captured } = makeFakeDb();
    const longUA = "A".repeat(800);
    await writeAudit(db, {
      action: "auth.otp_sent",
      target: { kind: "auth", id: "otp" },
      user_agent: longUA,
    });
    expect(captured).toHaveLength(1);
    const blob = JSON.stringify(captured);
    // 800-char run must not be present
    expect(blob.includes("A".repeat(800))).toBe(false);
    // 500-char run must be present
    expect(blob.includes("A".repeat(500))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analytics Engine mirror
// ---------------------------------------------------------------------------

describe("Phase G / G-3 — Analytics Engine writeDataPoint mirror", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("calls writeDataPoint with correct indexes, doubles, and blobs", async () => {
    const { db } = makeFakeDb();
    const { ae, calls } = makeFakeAE();
    const ctx = makeFakeCtx();

    await writeAudit(db, {
      action: "auth.otp_failed",
      target: { kind: "auth", id: "otp-target" },
      actor_user_id: "user-1",
      ip: "1.2.3.4",
      status: "denied",
      tenant_id: "group-xyz",
      user_agent: "TestAgent/1.0",
      analyticsEngine: ae,
      ctx,
    });

    // waitUntil drains the promise synchronously in our fake, so calls is populated.
    expect(calls).toHaveLength(1);
    const dp = calls[0];
    expect(dp.indexes).toEqual(["auth.otp_failed", "denied", "group-xyz"]);
    expect(dp.doubles).toHaveLength(1);
    expect(typeof dp.doubles![0]).toBe("number");
    expect(dp.blobs).toEqual([
      "user-1", // actor_user_id
      "", // actor_token_id (not set)
      "auth", // target.kind
      "otp-target", // target.id
      "1.2.3.4", // ip
      "TestAgent/1.0", // user_agent
    ]);
  });

  it("indexes use 'null' string when status/tenant_id are absent", async () => {
    const { db } = makeFakeDb();
    const { ae, calls } = makeFakeAE();
    const ctx = makeFakeCtx();

    await writeAudit(db, {
      action: "auth.otp_sent",
      target: { kind: "auth", id: "x" },
      analyticsEngine: ae,
      ctx,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].indexes).toEqual(["auth.otp_sent", "null", "null"]);
  });

  it("AE writeDataPoint failure does not propagate or throw", async () => {
    const { db } = makeFakeDb();
    const { ae, throwNext } = makeFakeAE();
    const ctx = makeFakeCtx();
    throwNext();

    await expect(
      writeAudit(db, {
        action: "auth.signin_success",
        target: { kind: "auth", id: "s" },
        analyticsEngine: ae,
        ctx,
        status: "success",
      }),
    ).resolves.toBeUndefined();
  });

  it("no error when analyticsEngine binding is undefined", async () => {
    const { db } = makeFakeDb();
    await expect(
      writeAudit(db, {
        action: "auth.pat_minted",
        target: { kind: "auth", id: "p" },
        // analyticsEngine intentionally omitted
      }),
    ).resolves.toBeUndefined();
  });

  it("no error when ctx is undefined", async () => {
    const { db } = makeFakeDb();
    const { ae } = makeFakeAE();
    await expect(
      writeAudit(db, {
        action: "auth.invitation_redeemed",
        target: { kind: "auth", id: "i" },
        analyticsEngine: ae,
        // ctx intentionally omitted
      }),
    ).resolves.toBeUndefined();
  });
});
