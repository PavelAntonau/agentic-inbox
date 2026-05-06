// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { describe, expect, it } from "vitest";
import {
  canShare,
  canUnshare,
  canTransfer,
  canDelete,
  type MailboxRow,
  type GroupRow,
} from "./mailbox-permissions";
import type { AuthzContext } from "../db/control-plane/forGroup";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function actor(overrides: Partial<AuthzContext> = {}): AuthzContext {
  return {
    user_id: "u-alice",
    role: "user",
    group_ids: ["g-eng"],
    authorized_mailbox_ids: ["mb-1"],
    ...overrides,
  };
}

const MAILBOX: MailboxRow = {
  id: "mb-1",
  address: "alice@actionnow.ai",
  display_name: "Alice",
  owner_user_id: "u-alice",
  created_at: 1_700_000_000,
};

const OTHER_MAILBOX: MailboxRow = {
  ...MAILBOX,
  id: "mb-2",
  owner_user_id: "u-bob",
};

const GROUP: GroupRow = {
  id: "g-eng",
  owner_user_id: "u-alice",
};

const OTHER_GROUP: GroupRow = {
  id: "g-mkt",
  owner_user_id: "u-bob",
};

// ---------------------------------------------------------------------------
// canShare
// ---------------------------------------------------------------------------

describe("canShare", () => {
  it("allows mailbox owner who is a member of the group", () => {
    // C3 (BUG cleanup): pass `null` for actorMailboxAclLevel explicitly —
    // the predicate now requires the parameter at the type level so the
    // omission can no longer slip through code review.
    const result = canShare(actor(), MAILBOX, GROUP, null);
    expect(result.ok).toBe(true);
  });

  it("blocks non-owner who is a member of the group", () => {
    const result = canShare(actor(), OTHER_MAILBOX, GROUP, null);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/owner/i);
  });

  it("blocks owner who is NOT a member of the target group", () => {
    const result = canShare(
      actor({ group_ids: ["g-eng"] }),
      MAILBOX,
      OTHER_GROUP,
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/member/i);
  });

  it("allows global_owner regardless of group membership", () => {
    const result = canShare(
      actor({ role: "global_owner", group_ids: [] }),
      OTHER_MAILBOX,
      OTHER_GROUP,
      null,
    );
    expect(result.ok).toBe(true);
  });

  it("allows global_admin regardless of group membership", () => {
    const result = canShare(
      actor({ role: "global_admin", group_ids: [] }),
      OTHER_MAILBOX,
      OTHER_GROUP,
      null,
    );
    expect(result.ok).toBe(true);
  });

  // MP-1 (audit, agentic-inbox-hardening Phase 2): admin-level mailbox ACL
  // is owner-equivalent for share/unshare. Without this, the schema's
  // mailbox_acls.level='admin' grant was effectively a no-op — see
  // workers/db/control-plane/schema.ts (mailbox_acls) for the source field.
  it("MP-1: admin-ACL grantee can share even when not the mailbox owner", () => {
    // u-alice has acl level 'admin' on OTHER_MAILBOX (owned by u-bob).
    const result = canShare(actor(), OTHER_MAILBOX, GROUP, "admin");
    expect(result.ok).toBe(true);
  });

  it("MP-1: write-level ACL grantee CANNOT share (admin only)", () => {
    const result = canShare(actor(), OTHER_MAILBOX, GROUP, "write");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/owner|admin/i);
  });

  it("MP-1: read-level ACL grantee CANNOT share", () => {
    const result = canShare(actor(), OTHER_MAILBOX, GROUP, "read");
    expect(result.ok).toBe(false);
  });

  it("MP-1: admin-ACL grantee still must be a member of the target group", () => {
    // Admin ACL on the mailbox does NOT auto-grant group membership.
    const result = canShare(
      actor({ group_ids: ["g-eng"] }),
      OTHER_MAILBOX,
      OTHER_GROUP, // g-mkt — actor is not a member
      "admin",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/member/i);
  });
});

// ---------------------------------------------------------------------------
// canUnshare
// ---------------------------------------------------------------------------

describe("canUnshare", () => {
  it("allows mailbox owner", () => {
    // C3 (BUG cleanup): pass `null` for actorMailboxAclLevel explicitly.
    expect(canUnshare(actor(), MAILBOX, GROUP, "member", null).ok).toBe(true);
  });

  it("allows group owner", () => {
    const bob = actor({ user_id: "u-bob" });
    // u-bob owns OTHER_GROUP
    expect(canUnshare(bob, MAILBOX, OTHER_GROUP, "member", null).ok).toBe(true);
  });

  it("allows group admin", () => {
    const bob = actor({ user_id: "u-bob" });
    expect(canUnshare(bob, OTHER_MAILBOX, OTHER_GROUP, "admin", null).ok).toBe(
      true,
    );
  });

  it("blocks a plain member who doesn't own mailbox or group", () => {
    // bob (u-bob) is neither the mailbox owner (u-alice) nor the group owner (u-alice)
    const bob = actor({ user_id: "u-bob" });
    expect(canUnshare(bob, MAILBOX, GROUP, "member", null).ok).toBe(false);
  });

  it("allows global_admin", () => {
    const global = actor({ role: "global_admin", user_id: "u-charlie" });
    expect(canUnshare(global, MAILBOX, GROUP, null).ok).toBe(true);
  });

  // MP-1 (audit, agentic-inbox-hardening Phase 2): admin-ACL grantee can
  // unshare even when they are not the mailbox owner, group owner, or
  // group admin.
  it("MP-1: admin-ACL grantee can unshare a mailbox they don't own", () => {
    const bob = actor({ user_id: "u-bob" });
    expect(canUnshare(bob, MAILBOX, GROUP, "member", "admin").ok).toBe(true);
  });

  it("MP-1: write-level ACL grantee CANNOT unshare (admin-only)", () => {
    const bob = actor({ user_id: "u-bob" });
    expect(canUnshare(bob, MAILBOX, GROUP, "member", "write").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canTransfer
// ---------------------------------------------------------------------------

describe("canTransfer", () => {
  it("allows mailbox owner", () => {
    expect(canTransfer(actor(), MAILBOX).ok).toBe(true);
  });

  it("blocks non-owner non-global user", () => {
    expect(canTransfer(actor({ user_id: "u-bob" }), MAILBOX).ok).toBe(false);
  });

  it("allows global_owner", () => {
    expect(
      canTransfer(
        actor({ role: "global_owner", user_id: "u-charlie" }),
        MAILBOX,
      ).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canDelete
// ---------------------------------------------------------------------------

describe("canDelete", () => {
  it("allows mailbox owner", () => {
    expect(canDelete(actor(), MAILBOX).ok).toBe(true);
  });

  it("blocks non-owner", () => {
    expect(canDelete(actor({ user_id: "u-bob" }), MAILBOX).ok).toBe(false);
  });

  it("allows global_admin", () => {
    expect(
      canDelete(actor({ role: "global_admin", user_id: "u-charlie" }), MAILBOX)
        .ok,
    ).toBe(true);
  });
});
