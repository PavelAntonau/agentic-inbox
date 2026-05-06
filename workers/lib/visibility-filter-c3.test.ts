// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C3 / TASK-C3.5 — `canSeeUser` predicate coverage.
//
// `canSeeUser` is the per-pair version of `filterVisibleUsers`. The avatar
// route handlers in `workers/app.ts` use it to gate `/avatars/:userId{,/original}`
// fetches. The full Phase 6 rule set must round-trip correctly:
//
//   1. Self → always.
//   2. Co-members → always.
//   3. Accepted contacts → always.
//   4. visibility='everyone' AND active → visible.
//   5. visibility='nobody' for non-self / non-co-member → hidden.
//   6. Blocked (either direction) → hidden.
//   7. Disabled accounts → hidden (except self).

import { describe, expect, it } from "vitest";
import { canSeeUser, type UserRef, type ActorRef } from "./visibility-filter";

function actor(opts: Partial<ActorRef> = {}): ActorRef {
  return { user_id: "alice", group_ids: [], ...opts };
}

function user(opts: Partial<UserRef> & { id: string }): UserRef {
  return {
    email: `${opts.id}@x`,
    display_name: opts.id,
    visibility: "everyone",
    status: "active",
    ...opts,
  };
}

const empty = {
  acceptedContactIds: new Set<string>(),
  blockedUserIds: new Set<string>(),
  targetGroupIds: [] as string[],
};

describe("canSeeUser — Phase C3 / TASK-C3.5", () => {
  it("self is always visible regardless of visibility", () => {
    const r = canSeeUser({
      actor: actor({ user_id: "alice" }),
      target: user({ id: "alice", visibility: "nobody" }),
      ...empty,
    });
    expect(r).toBe(true);
  });

  it("everyone-visibility user is visible to a stranger", () => {
    const r = canSeeUser({
      actor: actor({ user_id: "alice" }),
      target: user({ id: "bob", visibility: "everyone" }),
      ...empty,
    });
    expect(r).toBe(true);
  });

  it("nobody-visibility user is HIDDEN from a stranger", () => {
    const r = canSeeUser({
      actor: actor({ user_id: "alice" }),
      target: user({ id: "bob", visibility: "nobody" }),
      ...empty,
    });
    expect(r).toBe(false);
  });

  it("contacts-visibility user is HIDDEN from a non-contact", () => {
    const r = canSeeUser({
      actor: actor({ user_id: "alice" }),
      target: user({ id: "bob", visibility: "contacts" }),
      ...empty,
    });
    expect(r).toBe(false);
  });

  it("contacts-visibility user is visible to an accepted contact", () => {
    const r = canSeeUser({
      actor: actor({ user_id: "alice" }),
      target: user({ id: "bob", visibility: "contacts" }),
      targetGroupIds: [],
      acceptedContactIds: new Set(["bob"]),
      blockedUserIds: new Set(),
    });
    expect(r).toBe(true);
  });

  it("nobody-visibility user is visible to a co-member (groups override)", () => {
    const r = canSeeUser({
      actor: actor({ user_id: "alice", group_ids: ["g1"] }),
      target: user({ id: "bob", visibility: "nobody" }),
      targetGroupIds: ["g1"],
      acceptedContactIds: new Set(),
      blockedUserIds: new Set(),
    });
    expect(r).toBe(true);
  });

  it("blocked target is HIDDEN even with visibility=everyone", () => {
    const r = canSeeUser({
      actor: actor({ user_id: "alice" }),
      target: user({ id: "bob", visibility: "everyone" }),
      targetGroupIds: [],
      acceptedContactIds: new Set(),
      blockedUserIds: new Set(["bob"]),
    });
    expect(r).toBe(false);
  });

  it("blocked target is HIDDEN even when they're in the actor's contacts", () => {
    // Defense in depth — the blocked-set takes precedence over the
    // contact-set in case state was inconsistent.
    const r = canSeeUser({
      actor: actor({ user_id: "alice" }),
      target: user({ id: "bob", visibility: "contacts" }),
      targetGroupIds: [],
      acceptedContactIds: new Set(["bob"]),
      blockedUserIds: new Set(["bob"]),
    });
    expect(r).toBe(false);
  });

  it("disabled account is HIDDEN even with visibility=everyone", () => {
    const r = canSeeUser({
      actor: actor({ user_id: "alice" }),
      target: user({
        id: "bob",
        visibility: "everyone",
        status: "disabled",
      }),
      ...empty,
    });
    expect(r).toBe(false);
  });

  it("self is visible even when disabled (no recursion lock-out)", () => {
    const r = canSeeUser({
      actor: actor({ user_id: "alice" }),
      target: user({
        id: "alice",
        visibility: "nobody",
        status: "disabled",
      }),
      ...empty,
    });
    expect(r).toBe(true);
  });
});
