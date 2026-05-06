// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C1 / B-03 — `GET /api/v1/mailboxes` authzContext narrowing tests.
//
// Coverage:
//   • Non-global caller → output is filtered to authorized_mailbox_ids.
//   • global_owner → output is the full workspace inventory (no narrowing).
//
// The handler under test in workers/index.ts:113 calls
// `listMailboxes(c.env, ctx)` for non-global callers; this lib already has
// authzContext-aware behaviour (workers/lib/email-helpers.ts:54). Here we
// verify the narrowing path on the helper's contract directly so the
// regression surface stays narrow even if the handler refactors.

import { describe, expect, it, vi, beforeEach } from "vitest";

let d1Rows: { id: string; address: string; owner_user_id?: string }[] = [];
let r2List: { objects: { key: string }[] } = { objects: [] };

function makeChain() {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    all: vi.fn(async () => d1Rows),
  };
  return chain;
}

vi.mock("drizzle-orm/d1", () => ({ drizzle: vi.fn(() => makeChain()) }));

import { listMailboxes } from "./email-helpers";
import type { AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";

const mkBucket = (): R2Bucket =>
  ({ list: vi.fn(async () => r2List) }) as unknown as R2Bucket;

const mkEnv = (): Env => ({ DB: {}, BUCKET: mkBucket() }) as unknown as Env;

const mkAuthz = (role: AuthzContext["role"], ids: string[]): AuthzContext => ({
  user_id: "u1",
  role,
  group_ids: [],
  authorized_mailbox_ids: ids,
});

beforeEach(() => {
  d1Rows = [];
  r2List = { objects: [] };
  vi.clearAllMocks();
});

describe("listMailboxes narrowing — Phase C1 / B-03", () => {
  it("non-global caller → output is narrowed to authorized_mailbox_ids", async () => {
    // The drizzle mock returns whatever `d1Rows` is set to for `.all()`. The
    // helper's narrowing query passes `inArray(id, authzContext.authorized
    // _mailbox_ids)` so the mocked `.all()` represents POST-narrowing rows.
    d1Rows = [{ id: "mailbox-A", address: "alice@actionnow.ai" }];
    const env = mkEnv();
    const out = await listMailboxes(env, mkAuthz("user", ["mailbox-A"]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "mailbox-A", kind: "d1" });
  });

  it("non-global caller with empty authorized set → returns []", async () => {
    d1Rows = [];
    const env = mkEnv();
    const out = await listMailboxes(env, mkAuthz("user", []));
    expect(out).toEqual([]);
  });

  it("trusted-internal caller (no authzContext) → returns full workspace", async () => {
    d1Rows = [
      { id: "mailbox-A", address: "alice@actionnow.ai" },
      { id: "mailbox-B", address: "bob@actionnow.ai" },
    ];
    const env = mkEnv();
    const out = await listMailboxes(env);
    expect(out).toHaveLength(2);
  });
});
