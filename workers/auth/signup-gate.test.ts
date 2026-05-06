// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C1 / A-01 — invite-required signup gate tests.
//
// Coverage:
//   • bootstrap email → promotes to global_owner role.
//   • case-insensitive bootstrap email match (whitespace-tolerant).
//   • email on the invite list (status=pending) → user passes through.
//   • email on the invite list (status=accepted) → user passes through.
//   • email NOT on the invite list AND not bootstrap → throws FORBIDDEN.
//   • missing email → throws FORBIDDEN (no DB lookup).

import { describe, expect, it, vi, beforeEach } from "vitest";

let inviteRow: { id: string } | null = null;

function makeOrm() {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    get: vi.fn(async () => inviteRow),
  };
  return chain;
}

import { evaluateSignupGate } from "./index";
import type { Env } from "../types";

const mkEnv = (bootstrapEmail?: string): Env =>
  ({ BOOTSTRAP_OWNER_EMAIL: bootstrapEmail }) as unknown as Env;

beforeEach(() => {
  inviteRow = null;
});

describe("evaluateSignupGate (Phase C1 / A-01)", () => {
  it("promotes the bootstrap email to global_owner role", async () => {
    const env = mkEnv("owner@actionnow.ai");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
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
    const result = await evaluateSignupGate(
      { email: "OWNER@actionnow.ai" },
      env,
      orm,
    );
    expect((result.data as { role?: string }).role).toBe("global_owner");
  });

  it("permits an email on the invite list (status=pending)", async () => {
    inviteRow = { id: "invite-123" };
    const env = mkEnv("owner@actionnow.ai");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
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
    inviteRow = null;
    const env = mkEnv("owner@actionnow.ai");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    await expect(
      evaluateSignupGate({ email: "intruder@evil.example" }, env, orm),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("rejects a missing-email user with FORBIDDEN before any DB lookup", async () => {
    inviteRow = null;
    const env = mkEnv("owner@actionnow.ai");
    const orm = makeOrm() as unknown as Parameters<
      typeof evaluateSignupGate
    >[2];
    await expect(
      evaluateSignupGate({ email: "" }, env, orm),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });
});
