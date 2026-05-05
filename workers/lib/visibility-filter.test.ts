// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { describe, expect, it } from "vitest";
import {
  filterVisibleUsers,
  sortByRelevance,
  type UserRef,
  type GroupMemberRef,
  type ActorRef,
} from "./visibility-filter";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const alice: UserRef = {
  id: "u-alice",
  email: "alice@actionnow.ai",
  display_name: "Alice",
  visibility: "everyone",
  status: "active",
};

const bob: UserRef = {
  id: "u-bob",
  email: "bob@actionnow.ai",
  display_name: "Bob",
  visibility: "everyone",
  status: "active",
};

const carol: UserRef = {
  id: "u-carol",
  email: "carol@actionnow.ai",
  display_name: "Carol",
  visibility: "contacts",
  status: "active",
};

const dave: UserRef = {
  id: "u-dave",
  email: "dave@actionnow.ai",
  display_name: null,
  visibility: "nobody",
  status: "active",
};

const disabledUser: UserRef = {
  id: "u-disabled",
  email: "disabled@actionnow.ai",
  display_name: null,
  visibility: "everyone",
  status: "disabled",
};

const actorAlice: ActorRef = {
  user_id: "u-alice",
  group_ids: ["g-eng"],
};

const groupMembers: GroupMemberRef[] = [
  { user_id: "u-alice", group_id: "g-eng" },
  { user_id: "u-bob", group_id: "g-eng" },
  { user_id: "u-carol", group_id: "g-mkt" }, // not co-member with alice
];

// ---------------------------------------------------------------------------
// filterVisibleUsers — Phase 3 (legacy, opt-in via enforceContactsAndNobody = false)
//
// V-2 (audit, agentic-inbox-hardening Phase 2): the default flipped to true.
// These tests must now pass `enforceContactsAndNobody: false` explicitly to
// exercise the legacy path; omitting the flag yields the safe Phase 6 path.
// ---------------------------------------------------------------------------

describe("filterVisibleUsers — Phase 3 legacy (enforceContactsAndNobody=false)", () => {
  it("includes self even when actor has no groups", () => {
    const result = filterVisibleUsers({
      actor: { user_id: "u-alice", group_ids: [] },
      users: [alice],
      groupMembers: [],
      enforceContactsAndNobody: false,
    });
    expect(result.map((u) => u.id)).toContain("u-alice");
  });

  it("excludes disabled users", () => {
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [disabledUser, alice],
      groupMembers,
      enforceContactsAndNobody: false,
    });
    expect(result.map((u) => u.id)).not.toContain("u-disabled");
  });

  it("includes co-members regardless of visibility value", () => {
    // Bob is co-member via g-eng — should appear even if visibility were 'nobody'
    const bobNobody: UserRef = { ...bob, visibility: "nobody" };
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, bobNobody],
      groupMembers,
      enforceContactsAndNobody: false,
    });
    expect(result.map((u) => u.id)).toContain("u-bob");
  });

  it("includes non-co-member 'everyone' users in Phase 3", () => {
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, carol],
      groupMembers,
      enforceContactsAndNobody: false,
    });
    // Carol is not in g-eng but Phase 3 doesn't enforce contacts/nobody
    expect(result.map((u) => u.id)).toContain("u-carol");
  });

  it("includes 'nobody' visibility users in Phase 3 (enforcement deferred to Phase 6)", () => {
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, dave],
      groupMembers,
      enforceContactsAndNobody: false,
    });
    expect(result.map((u) => u.id)).toContain("u-dave");
  });
});

// ---------------------------------------------------------------------------
// V-2 regression guard — default behaviour is enforce=true.
//
// agentic-inbox-hardening Phase 2 (audit-graph: Z4NSQDL0GqzAdDPL1hnbu region).
// If this test fails, the default has silently flipped back to false and
// every new call site that omits the flag has re-introduced Phase 3 mode.
// ---------------------------------------------------------------------------

describe("filterVisibleUsers — V-2 default-true safety", () => {
  it("excludes 'nobody' non-co-members when the flag is OMITTED (default=true)", () => {
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, dave],
      groupMembers,
      // enforceContactsAndNobody intentionally not passed
    });
    expect(result.map((u) => u.id)).not.toContain("u-dave");
  });

  it("excludes 'contacts' non-co-members when the flag is OMITTED (default=true)", () => {
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, carol],
      groupMembers,
      // enforceContactsAndNobody intentionally not passed
    });
    expect(result.map((u) => u.id)).not.toContain("u-carol");
  });
});

// ---------------------------------------------------------------------------
// filterVisibleUsers — Phase 6 full enforcement
// ---------------------------------------------------------------------------

describe("filterVisibleUsers — Phase 6 full enforcement", () => {
  it("excludes 'nobody' users who are NOT co-members (E15)", () => {
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, dave],
      groupMembers,
      enforceContactsAndNobody: true,
    });
    // Dave is nobody and not in g-eng
    expect(result.map((u) => u.id)).not.toContain("u-dave");
  });

  it("excludes 'contacts' users who are NOT co-members and NOT accepted contacts", () => {
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, carol],
      groupMembers,
      enforceContactsAndNobody: true,
    });
    // Carol has contacts visibility and is NOT a co-member of alice, not in contacts
    expect(result.map((u) => u.id)).not.toContain("u-carol");
  });

  it("includes 'contacts' users who ARE in actor's accepted contacts list", () => {
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, carol],
      groupMembers,
      acceptedContactIds: new Set(["u-carol"]),
      enforceContactsAndNobody: true,
    });
    // Carol is an accepted contact so should be visible
    expect(result.map((u) => u.id)).toContain("u-carol");
  });

  it("still includes 'nobody' co-members in Phase 6", () => {
    const daveCoMember: GroupMemberRef = {
      user_id: "u-dave",
      group_id: "g-eng",
    };
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, dave],
      groupMembers: [...groupMembers, daveCoMember],
      enforceContactsAndNobody: true,
    });
    expect(result.map((u) => u.id)).toContain("u-dave");
  });

  it("excludes blocked users even if they have visibility='everyone'", () => {
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, bob],
      groupMembers,
      blockedUserIds: new Set(["u-bob"]),
      enforceContactsAndNobody: true,
    });
    // Bob is blocked — should not appear even though visibility='everyone'
    expect(result.map((u) => u.id)).not.toContain("u-bob");
  });

  it("excludes users who blocked the actor", () => {
    // 'blockedUserIds' carries BOTH directions: actor blocked them OR they blocked actor
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, carol],
      groupMembers,
      blockedUserIds: new Set(["u-carol"]), // carol blocked alice
      enforceContactsAndNobody: true,
    });
    expect(result.map((u) => u.id)).not.toContain("u-carol");
  });

  it("includes 'everyone' users regardless of contact status", () => {
    const eve: UserRef = {
      id: "u-eve",
      email: "eve@actionnow.ai",
      display_name: "Eve",
      visibility: "everyone",
      status: "active",
    };
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [alice, eve],
      groupMembers,
      enforceContactsAndNobody: true,
    });
    expect(result.map((u) => u.id)).toContain("u-eve");
  });

  it("always includes self regardless of block or visibility", () => {
    const aliceNobody: UserRef = { ...alice, visibility: "nobody" };
    const result = filterVisibleUsers({
      actor: actorAlice,
      users: [aliceNobody],
      groupMembers,
      blockedUserIds: new Set(["u-alice"]), // self blocked somehow — still included
      enforceContactsAndNobody: true,
    });
    expect(result.map((u) => u.id)).toContain("u-alice");
  });
});

// ---------------------------------------------------------------------------
// sortByRelevance
// ---------------------------------------------------------------------------

describe("sortByRelevance", () => {
  it("ranks exact email-prefix match first", () => {
    const users = [bob, alice];
    const coMemberIds = new Set<string>();
    const result = sortByRelevance(users, "ali", coMemberIds);
    expect(result[0].id).toBe("u-alice");
  });

  it("ranks co-members above non-co-members with same prefix score", () => {
    const userA: UserRef = {
      id: "u-x",
      email: "xavier@actionnow.ai",
      display_name: null,
      visibility: "everyone",
      status: "active",
    };
    const userB: UserRef = {
      id: "u-y",
      email: "yvonne@actionnow.ai",
      display_name: null,
      visibility: "everyone",
      status: "active",
    };
    // yvonne is a co-member, xavier is not
    const coMemberIds = new Set(["u-y"]);
    const result = sortByRelevance([userA, userB], "a", coMemberIds);
    // Neither starts with 'a', so co-member ranking applies
    expect(result[0].id).toBe("u-y");
  });

  it("falls back to email alpha sort for equal-rank entries", () => {
    const users = [bob, alice];
    const result = sortByRelevance(users, "zzz", new Set());
    // Neither matches 'zzz'; alphabetical by email → alice < bob
    expect(result[0].id).toBe("u-alice");
  });
});
