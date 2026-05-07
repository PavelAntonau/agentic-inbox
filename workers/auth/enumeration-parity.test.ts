// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G / TASK-1.1 (OQ-PG-1) — OTP-verify enumeration-parity regression.
//
// Phase 2 Teammate A (D-PG-4) flipped `evaluateSignupGate`'s non-bootstrap
// deny paths from `APIError("FORBIDDEN", …)` to `APIError("UNAUTHORIZED", …)`
// so the response shape and status match the wrong-OTP path on an invited
// email.  The padding `await new Promise(r => setTimeout(r, 50))` aligns
// timing on every branch (permit and deny) so response timing does not
// reveal which branch was taken.
//
// This file is the post-Phase-2 regression; the pre-Phase-2 baseline that
// asserted FORBIDDEN was deleted — its purpose was to document the bug,
// which is now fixed.

import { describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";

import { evaluateSignupGate } from "./index";
import type { Env } from "../types";

let getQueue: Array<{ id: string } | null> = [];

function makeOrm() {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    get: vi.fn(async () => getQueue.shift() ?? null),
  };
  return chain;
}

const env: Env = {
  // No bootstrap email — keep this branch out of the test.
  BOOTSTRAP_OWNER_EMAIL: undefined,
} as unknown as Env;

describe("OQ-PG-1 — OTP-verify enumeration parity (post-Phase-2)", () => {
  it("throws UNAUTHORIZED with the same shape as wrong-OTP on invited", async () => {
    getQueue = [null];
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    const start = Date.now();
    let thrown: unknown;
    try {
      await evaluateSignupGate(
        { email: "not-invited@example.invalid" },
        env,
        orm,
      );
    } catch (e) {
      thrown = e;
    }
    const elapsed = Date.now() - start;
    expect(thrown).toBeInstanceOf(APIError);
    const apiErr = thrown as APIError;
    expect(apiErr.status).toBe("UNAUTHORIZED");
    expect(apiErr.statusCode).toBe(401);
    // Phase 2 D-PG-4 timing pad: gate-failure path waits ≥ 50 ms.
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});
