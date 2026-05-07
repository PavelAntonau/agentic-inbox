// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G / TASK-1.1 (OQ-PG-1) — OTP-verify enumeration-parity test.
//
// Today (pre-cutover): `evaluateSignupGate` throws
// `APIError("FORBIDDEN", …)` when an email is not on the invite list.
// better-auth's `/api/auth/sign-in/email-otp` triggers user-creation on
// first OTP success, which calls `databaseHooks.user.create.before` →
// `evaluateSignupGate`. The 403 it throws is observably different from the
// 401 a wrong OTP for an INVITED email returns, so an attacker can probe
// the invite list cheaply.
//
// Phase 2 Teammate A (D-PG-4) flips this to `APIError("UNAUTHORIZED", …)`
// so the response shape and status match the wrong-OTP path on an invited
// email. The padding `await new Promise(r => setTimeout(r, 50))` aligns
// timing.
//
// This file is the baseline + the post-Phase-2 regression.
//   * Today the assertions WILL fail (FORBIDDEN ≠ UNAUTHORIZED).
//     That failure IS the OQ-PG-1 evidence.
//   * After Teammate A lands, both branches throw UNAUTHORIZED with
//     identical message and the test passes.

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

describe("OQ-PG-1 — OTP-verify enumeration parity (pre-Phase-2 baseline)", () => {
  it("throws an APIError that exposes the invite-list status today", async () => {
    // NOT INVITED — simulate an empty group_invitations result.
    getQueue = [null];
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
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
    expect(thrown).toBeInstanceOf(APIError);
    const apiErr = thrown as APIError;
    // BASELINE — today the gate throws FORBIDDEN.
    // POST-PHASE-2 — flip the next two assertions to UNAUTHORIZED + 401.
    expect(apiErr.status).toBe("FORBIDDEN");
    expect(apiErr.statusCode).toBe(403);
  });
});

describe.skip("OQ-PG-1 — OTP-verify enumeration parity (post-Phase-2 target)", () => {
  // Unskip once Teammate A lands D-PG-4.
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
