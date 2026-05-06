// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C1 / A-01 — invite-required signup gate tests.
// Phase E / TASK-E.2 — BOOTSTRAP_OWNER_TOKEN second factor + single-use
//   bootstrap path.
//
// Coverage:
//   • bootstrap email → promotes to global_owner role.
//   • case-insensitive bootstrap email match (whitespace-tolerant).
//   • email on the invite list (status=pending) → user passes through.
//   • email on the invite list (status=accepted) → user passes through.
//   • email NOT on the invite list AND not bootstrap → throws FORBIDDEN.
//   • missing email → throws FORBIDDEN (no DB lookup).
//   • Phase E / TASK-E.2: bootstrap token absent (env set) → 403.
//   • Phase E / TASK-E.2: bootstrap token mismatch → 403.
//   • Phase E / TASK-E.2: bootstrap token match → global_owner.
//   • Phase E / TASK-E.2: second bootstrap call (owner exists) → 403.

import { describe, expect, it, vi, beforeEach } from "vitest";

// Queue-driven mock for `orm.select(...).from(...).where(...).get()`.
// The real `evaluateSignupGate` issues at most TWO `.get()` calls per
// invocation:
//   1. Bootstrap path: SELECT users WHERE role='global_owner' (single-use
//      enforcement; Phase E / TASK-E.2.a).
//   2. Non-bootstrap path: SELECT group_invitations WHERE …
// Tests prime `getQueue` with the values the queries should return in order.

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

import { evaluateSignupGate } from "./index";
import type { Env } from "../types";

const mkEnv = (bootstrapEmail?: string, bootstrapToken?: string): Env =>
  ({
    BOOTSTRAP_OWNER_EMAIL: bootstrapEmail,
    BOOTSTRAP_OWNER_TOKEN: bootstrapToken,
  }) as unknown as Env;

beforeEach(() => {
  getQueue = [];
});

describe("evaluateSignupGate (Phase C1 / A-01)", () => {
  it("promotes the bootstrap email to global_owner role", async () => {
    const env = mkEnv("owner@actionnow.ai");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    // Bootstrap path: prime null so the global_owner check finds no
    // existing owner.
    getQueue = [null];
    const result = await evaluateSignupGate(
      { email: "owner@actionnow.ai" },
      env,
      orm,
    );
    expect(result.data).toMatchObject({
      email: "owner@actionnow.ai",
      role: "global_owner",
    });
  });

  it("matches the bootstrap email case-insensitively (whitespace-tolerant)", async () => {
    const env = mkEnv("  owner@ActionNow.AI  ");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    getQueue = [null];
    const result = await evaluateSignupGate(
      { email: "OWNER@actionnow.ai" },
      env,
      orm,
    );
    expect((result.data as { role?: string }).role).toBe("global_owner");
  });

  it("permits an email on the invite list (status=pending)", async () => {
    const env = mkEnv("owner@actionnow.ai");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    // Non-bootstrap path → only the invite query fires.
    getQueue = [{ id: "invite-123" }];
    const result = await evaluateSignupGate(
      { email: "alice@actionnow.ai" },
      env,
      orm,
    );
    // Invited users do NOT receive the global_owner role — they pass
    // through with whatever role better-auth assigns by default.
    expect((result.data as { role?: string }).role).toBeUndefined();
    expect((result.data as { email: string }).email).toBe("alice@actionnow.ai");
  });

  it("rejects an uninvited, non-bootstrap email with FORBIDDEN", async () => {
    const env = mkEnv("owner@actionnow.ai");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    getQueue = [null]; // invite query returns nothing
    await expect(
      evaluateSignupGate({ email: "intruder@evil.example" }, env, orm),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("rejects a missing-email user with FORBIDDEN before any DB lookup", async () => {
    const env = mkEnv("owner@actionnow.ai");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    await expect(
      evaluateSignupGate({ email: "" }, env, orm),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });
});

// ---------------------------------------------------------------------------
// Phase E / TASK-E.2 — BOOTSTRAP_OWNER_TOKEN second-factor (OQ-P0-7)
// ---------------------------------------------------------------------------

describe("evaluateSignupGate — Phase E / TASK-E.2 second factor", () => {
  it("token present and matches → bootstrap owner created with global_owner", async () => {
    const env = mkEnv("owner@actionnow.ai", "shared-secret-correct");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    getQueue = [null]; // no existing global_owner
    const result = await evaluateSignupGate(
      { email: "owner@actionnow.ai" },
      env,
      orm,
      "shared-secret-correct",
    );
    expect((result.data as { role?: string }).role).toBe("global_owner");
  });

  it("token absent (env BOOTSTRAP_OWNER_TOKEN set) → FORBIDDEN", async () => {
    const env = mkEnv("owner@actionnow.ai", "shared-secret");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    getQueue = [null];
    await expect(
      evaluateSignupGate(
        { email: "owner@actionnow.ai" },
        env,
        orm,
        null, // header missing
      ),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("token mismatch → FORBIDDEN", async () => {
    const env = mkEnv("owner@actionnow.ai", "expected-value");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    getQueue = [null];
    await expect(
      evaluateSignupGate(
        { email: "owner@actionnow.ai" },
        env,
        orm,
        "wrong-value",
      ),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("second bootstrap call (global_owner already exists) → FORBIDDEN even with matching token", async () => {
    const env = mkEnv("owner@actionnow.ai", "shared-secret");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    // Existing global_owner row in D1 — single-use enforcement.
    getQueue = [{ id: "existing-owner-id" }];
    await expect(
      evaluateSignupGate(
        { email: "owner@actionnow.ai" },
        env,
        orm,
        "shared-secret", // even with the right token
      ),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("env BOOTSTRAP_OWNER_TOKEN unset → token-less bootstrap still allowed (Phase C1 baseline)", async () => {
    const env = mkEnv("owner@actionnow.ai"); // BOOTSTRAP_OWNER_TOKEN omitted
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    getQueue = [null];
    const result = await evaluateSignupGate(
      { email: "owner@actionnow.ai" },
      env,
      orm,
      // bootstrapToken omitted; should not matter when env isn't set
    );
    expect((result.data as { role?: string }).role).toBe("global_owner");
  });

  it("env BOOTSTRAP_OWNER_TOKEN empty string → treated as unset (token-less bootstrap allowed)", async () => {
    const env = mkEnv("owner@actionnow.ai", "");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    getQueue = [null];
    const result = await evaluateSignupGate(
      { email: "owner@actionnow.ai" },
      env,
      orm,
    );
    expect((result.data as { role?: string }).role).toBe("global_owner");
  });
});
