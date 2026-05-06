// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C1 / C-01 — OAuth-JWT mailbox-narrowing tests.
//
// The narrowing logic in workers/app.ts:dispatchMcpRequest builds an
// authzContext from `bearer.user_id` (with PAT mailbox_id intersection)
// and asserts the resolved mailbox is in `authorized_mailbox_ids` (or the
// caller is global). buildAuthzContextFromUserId is the load-bearing
// helper — covered here in the four shapes the dispatch enforces:
//   • JWT same-mailbox → authzContext narrowing returns the row.
//   • JWT cross-mailbox → authzContext does NOT include the row.
//   • JWT global_owner → role short-circuits the check.
//   • PAT mailbox_id intersection narrows authorized_mailbox_ids.
//
// The dispatch wiring itself (extractToolCall + resolveMailboxToId +
// insufficientScopeResponse) is covered separately by mcp-tool-policy
// tests; here we cover only the new C-01 ingredient.

import { describe, expect, it, vi, beforeEach } from "vitest";

type QueueEntry =
  | { kind: "get"; result: unknown }
  | { kind: "all"; result: unknown };

let queryQueue: QueueEntry[] = [];

function makeChain() {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    get: vi.fn(async () => {
      const next = queryQueue.shift();
      if (!next || next.kind !== "get")
        throw new Error(`Unexpected .get() (queue=${JSON.stringify(next)})`);
      return next.result;
    }),
    all: vi.fn(async () => {
      const next = queryQueue.shift();
      if (!next || next.kind !== "all")
        throw new Error(`Unexpected .all() (queue=${JSON.stringify(next)})`);
      return next.result;
    }),
  };
  return chain;
}

vi.mock("drizzle-orm/d1", () => ({ drizzle: vi.fn(() => makeChain()) }));

import { buildAuthzContextFromUserId } from "./mcp-list-mailboxes";
import type { Env } from "../types";

const env = { DB: {} } as unknown as Env;

beforeEach(() => {
  queryQueue = [];
  vi.clearAllMocks();
});

describe("buildAuthzContextFromUserId — Phase C1 / C-01 narrowing", () => {
  it("JWT same-mailbox: authorized_mailbox_ids includes the resolved row id", async () => {
    queryQueue = [
      { kind: "get", result: { id: "u1", role: "user", status: "active" } },
      { kind: "all", result: [] }, // group_members
      { kind: "all", result: [{ id: "mailbox-A" }] }, // own mailboxes
    ];
    const ctx = await buildAuthzContextFromUserId(env, "u1");
    expect(ctx).not.toBeNull();
    expect(ctx!.authorized_mailbox_ids).toEqual(["mailbox-A"]);
    // Dispatch's narrow check: includes(resolvedId) — ✓ for same mailbox.
    expect(ctx!.authorized_mailbox_ids.includes("mailbox-A")).toBe(true);
  });

  it("JWT cross-mailbox: authorized set does NOT contain the foreign mailbox", async () => {
    queryQueue = [
      { kind: "get", result: { id: "u1", role: "user", status: "active" } },
      { kind: "all", result: [] }, // group_members
      { kind: "all", result: [{ id: "mailbox-A" }] }, // own mailboxes
    ];
    const ctx = await buildAuthzContextFromUserId(env, "u1");
    expect(ctx).not.toBeNull();
    expect(ctx!.authorized_mailbox_ids.includes("mailbox-OTHER")).toBe(false);
  });

  it("JWT global_owner: role bypasses the narrow check at the dispatch layer", async () => {
    queryQueue = [
      {
        kind: "get",
        result: { id: "owner", role: "global_owner", status: "active" },
      },
      { kind: "all", result: [] },
      { kind: "all", result: [] }, // owns nothing — would 403 if not global
    ];
    const ctx = await buildAuthzContextFromUserId(env, "owner");
    expect(ctx).not.toBeNull();
    expect(ctx!.role).toBe("global_owner");
    // Dispatch checks `isGlobal(role)` BEFORE authorized_mailbox_ids — even
    // an empty authorized set passes for global roles. The role assertion
    // here is the load-bearing fact for the cross-mailbox-as-global case.
  });

  it("PAT mailbox_id intersection narrows authorized_mailbox_ids to the binding", async () => {
    queryQueue = [
      { kind: "get", result: { id: "u1", role: "user", status: "active" } },
      { kind: "all", result: [] },
      { kind: "all", result: [{ id: "mailbox-A" }, { id: "mailbox-B" }] },
    ];
    // PAT mailbox_id = "mailbox-A" should narrow to ["mailbox-A"], dropping
    // the unrelated "mailbox-B" the user owns. A PAT call to mailbox-B then
    // fails the dispatch's `includes(resolvedId)` check.
    const ctx = await buildAuthzContextFromUserId(env, "u1", "mailbox-A");
    expect(ctx).not.toBeNull();
    expect(ctx!.authorized_mailbox_ids).toEqual(["mailbox-A"]);
  });
});
