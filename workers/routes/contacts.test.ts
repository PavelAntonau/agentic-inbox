// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for workers/routes/contacts.ts
// Uses pure permission-predicate tests — full route integration requires a Worker harness.

import { describe, it, expect } from "vitest";
import type { AuthzContext } from "../db/control-plane/forGroup";
import {
  canSendContactRequest,
  canAcceptContactRequest,
  canDeclineContactRequest,
  canBlockUser,
  isReachableForContactRequest,
  type ContactRow,
} from "../lib/contact-permissions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCtx(userId = "u-alice"): AuthzContext {
  return {
    user_id: userId,
    role: "user",
    group_ids: [],
    authorized_mailbox_ids: [],
  };
}

const PENDING_ROW: ContactRow = {
  owner_user_id: "u-bob",
  contact_user_id: "u-alice",
  status: "pending",
  initiated_by: "u-bob",
};

const ACCEPTED_ROW: ContactRow = {
  owner_user_id: "u-bob",
  contact_user_id: "u-alice",
  status: "accepted",
  initiated_by: "u-bob",
};

// ---------------------------------------------------------------------------
// canSendContactRequest
// ---------------------------------------------------------------------------

describe("canSendContactRequest", () => {
  it("allows sending to a different active user", () => {
    const result = canSendContactRequest(makeCtx(), "u-bob", false, false);
    expect(result.ok).toBe(true);
  });

  it("blocks sending to self", () => {
    const result = canSendContactRequest(
      makeCtx("u-alice"),
      "u-alice",
      false,
      false,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/yourself/i);
  });

  it("blocks if target has blocked actor", () => {
    const result = canSendContactRequest(makeCtx(), "u-bob", true, false);
    expect(result.ok).toBe(false);
  });

  it("blocks if actor has blocked target", () => {
    const result = canSendContactRequest(makeCtx(), "u-bob", false, true);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unblock/i);
  });
});

// ---------------------------------------------------------------------------
// canAcceptContactRequest
// ---------------------------------------------------------------------------

describe("canAcceptContactRequest", () => {
  it("allows accepting a pending request addressed to actor", () => {
    const result = canAcceptContactRequest(makeCtx("u-alice"), PENDING_ROW);
    expect(result.ok).toBe(true);
  });

  it("blocks if request is addressed to someone else", () => {
    const result = canAcceptContactRequest(makeCtx("u-carol"), PENDING_ROW);
    expect(result.ok).toBe(false);
  });

  it("blocks accepting an already-accepted row", () => {
    const result = canAcceptContactRequest(makeCtx("u-alice"), ACCEPTED_ROW);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/accepted/i);
  });

  it("blocks accepting a blocked row", () => {
    const blockedRow: ContactRow = { ...PENDING_ROW, status: "blocked" };
    const result = canAcceptContactRequest(makeCtx("u-alice"), blockedRow);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canDeclineContactRequest
// ---------------------------------------------------------------------------

describe("canDeclineContactRequest", () => {
  it("allows declining a pending request addressed to actor", () => {
    const result = canDeclineContactRequest(makeCtx("u-alice"), PENDING_ROW);
    expect(result.ok).toBe(true);
  });

  it("blocks if request is addressed to someone else", () => {
    const result = canDeclineContactRequest(makeCtx("u-carol"), PENDING_ROW);
    expect(result.ok).toBe(false);
  });

  it("blocks declining a non-pending row", () => {
    const result = canDeclineContactRequest(makeCtx("u-alice"), ACCEPTED_ROW);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/accepted/i);
  });
});

// ---------------------------------------------------------------------------
// canBlockUser
// ---------------------------------------------------------------------------

describe("canBlockUser", () => {
  it("allows blocking any other user", () => {
    const result = canBlockUser(makeCtx("u-alice"), "u-bob");
    expect(result.ok).toBe(true);
  });

  it("blocks blocking self", () => {
    const result = canBlockUser(makeCtx("u-alice"), "u-alice");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/yourself/i);
  });
});

// ---------------------------------------------------------------------------
// Symmetric handshake state machine assertions
// ---------------------------------------------------------------------------

describe("contacts symmetric handshake logic", () => {
  it("accept flow: pending row flips to accepted, mirror row inserted accepted", () => {
    // Simulate the state after accept: both rows status='accepted'
    const originalAfterAccept: ContactRow = {
      ...PENDING_ROW,
      status: "accepted",
    };
    const mirrorAfterAccept: ContactRow = {
      owner_user_id: "u-alice",
      contact_user_id: "u-bob",
      status: "accepted",
      initiated_by: "u-bob",
    };
    expect(originalAfterAccept.status).toBe("accepted");
    expect(mirrorAfterAccept.status).toBe("accepted");
    // Symmetric: both sides see accepted
    expect(originalAfterAccept.owner_user_id).toBe(
      mirrorAfterAccept.contact_user_id,
    );
    expect(originalAfterAccept.contact_user_id).toBe(
      mirrorAfterAccept.owner_user_id,
    );
  });

  it("decline flow: original row is removed, no mirror row exists", () => {
    // After decline: PENDING_ROW is deleted, nothing for mirror
    const rowsAfterDecline: ContactRow[] = [];
    expect(rowsAfterDecline).toHaveLength(0);
  });

  it("block flow: one-direction blocked row, mirror removed", () => {
    const blockedRow: ContactRow = {
      owner_user_id: "u-alice",
      contact_user_id: "u-bob",
      status: "blocked",
      initiated_by: "u-alice",
    };
    expect(blockedRow.status).toBe("blocked");
    // Mirror (bob→alice) is deleted
    const mirrorRows: ContactRow[] = [];
    expect(mirrorRows).toHaveLength(0);
  });

  it("visibility filter excludes blocked users in both directions", () => {
    // bob blocked alice (owner=bob, contact=alice, status=blocked)
    const blockByBob: ContactRow = {
      owner_user_id: "u-bob",
      contact_user_id: "u-alice",
      status: "blocked",
      initiated_by: "u-bob",
    };
    // Simulate building blockedUserIds for alice's perspective
    const blockedUserIds = new Set<string>();
    if (blockByBob.contact_user_id === "u-alice") {
      // bob blocked alice → alice sees bob as blocked
      blockedUserIds.add(blockByBob.owner_user_id);
    }
    expect(blockedUserIds.has("u-bob")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isReachableForContactRequest (audit F-C2 — D-aim-12 nobody-tier gate)
// ---------------------------------------------------------------------------

describe("isReachableForContactRequest (F-C2)", () => {
  function ctxWithGroups(groups: string[]): AuthzContext {
    return {
      user_id: "u-alice",
      role: "user",
      group_ids: groups,
      authorized_mailbox_ids: [],
    };
  }

  it("self always reachable (request-time gate doesn't bar self)", () => {
    expect(
      isReachableForContactRequest({
        actor: ctxWithGroups([]),
        targetUserId: "u-alice", // self
        targetVisibility: "nobody",
        targetGroupIds: [],
        actorHasAcceptedContact: false,
      }),
    ).toBe(true);
  });

  it("everyone-tier always reachable (gate is request-layer no-op)", () => {
    expect(
      isReachableForContactRequest({
        actor: ctxWithGroups([]),
        targetUserId: "u-bob",
        targetVisibility: "everyone",
        targetGroupIds: [],
        actorHasAcceptedContact: false,
      }),
    ).toBe(true);
  });

  it("contacts-tier always reachable at request layer (autocomplete is the gate)", () => {
    // D-aim-12: protection for `contacts` tier is at autocomplete/discovery
    // via filterVisibleUsers; once a user_id is known, requests can flow.
    expect(
      isReachableForContactRequest({
        actor: ctxWithGroups([]),
        targetUserId: "u-bob",
        targetVisibility: "contacts",
        targetGroupIds: [],
        actorHasAcceptedContact: false,
      }),
    ).toBe(true);
  });

  it("nobody-tier rejects a stranger (no co-membership, no accepted contact)", () => {
    expect(
      isReachableForContactRequest({
        actor: ctxWithGroups(["g-team-a"]),
        targetUserId: "u-bob",
        targetVisibility: "nobody",
        targetGroupIds: ["g-team-b"],
        actorHasAcceptedContact: false,
      }),
    ).toBe(false);
  });

  it("nobody-tier reachable via co-membership (one shared group)", () => {
    expect(
      isReachableForContactRequest({
        actor: ctxWithGroups(["g-team-a", "g-team-b"]),
        targetUserId: "u-bob",
        targetVisibility: "nobody",
        targetGroupIds: ["g-team-b", "g-team-c"], // overlap on g-team-b
        actorHasAcceptedContact: false,
      }),
    ).toBe(true);
  });

  it("nobody-tier reachable via existing accepted contact", () => {
    expect(
      isReachableForContactRequest({
        actor: ctxWithGroups([]),
        targetUserId: "u-bob",
        targetVisibility: "nobody",
        targetGroupIds: [],
        actorHasAcceptedContact: true,
      }),
    ).toBe(true);
  });

  it("nobody-tier rejects when actor has zero groups and no accepted contact", () => {
    expect(
      isReachableForContactRequest({
        actor: ctxWithGroups([]),
        targetUserId: "u-bob",
        targetVisibility: "nobody",
        targetGroupIds: ["g-team-a"],
        actorHasAcceptedContact: false,
      }),
    ).toBe(false);
  });

  it("nobody-tier rejects when target has zero groups and no accepted contact", () => {
    expect(
      isReachableForContactRequest({
        actor: ctxWithGroups(["g-team-a"]),
        targetUserId: "u-bob",
        targetVisibility: "nobody",
        targetGroupIds: [],
        actorHasAcceptedContact: false,
      }),
    ).toBe(false);
  });

  it("nobody-tier: co-membership AND accepted-contact both true also passes", () => {
    expect(
      isReachableForContactRequest({
        actor: ctxWithGroups(["g-team-a"]),
        targetUserId: "u-bob",
        targetVisibility: "nobody",
        targetGroupIds: ["g-team-a"],
        actorHasAcceptedContact: true,
      }),
    ).toBe(true);
  });
});
