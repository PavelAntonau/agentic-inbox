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
    const result = canShare(actor(), MAILBOX, GROUP);
    expect(result.ok).toBe(true);
  });

  it("blocks non-owner who is a member of the group", () => {
    const result = canShare(actor(), OTHER_MAILBOX, GROUP);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/owner/i);
  });

  it("blocks owner who is NOT a member of the target group", () => {
    const result = canShare(
      actor({ group_ids: ["g-eng"] }),
      MAILBOX,
      OTHER_GROUP,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/member/i);
  });

  it("allows global_owner regardless of group membership", () => {
    const result = canShare(
      actor({ role: "global_owner", group_ids: [] }),
      OTHER_MAILBOX,
      OTHER_GROUP,
    );
    expect(result.ok).toBe(true);
  });

  it("allows global_admin regardless of group membership", () => {
    const result = canShare(
      actor({ role: "global_admin", group_ids: [] }),
      OTHER_MAILBOX,
      OTHER_GROUP,
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canUnshare
// ---------------------------------------------------------------------------

describe("canUnshare", () => {
  it("allows mailbox owner", () => {
    expect(canUnshare(actor(), MAILBOX, GROUP, "member").ok).toBe(true);
  });

  it("allows group owner", () => {
    const bob = actor({ user_id: "u-bob" });
    // u-bob owns OTHER_GROUP
    expect(canUnshare(bob, MAILBOX, OTHER_GROUP, "member").ok).toBe(true);
  });

  it("allows group admin", () => {
    const bob = actor({ user_id: "u-bob" });
    expect(canUnshare(bob, OTHER_MAILBOX, OTHER_GROUP, "admin").ok).toBe(true);
  });

  it("blocks a plain member who doesn't own mailbox or group", () => {
    // bob (u-bob) is neither the mailbox owner (u-alice) nor the group owner (u-alice)
    const bob = actor({ user_id: "u-bob" });
    expect(canUnshare(bob, MAILBOX, GROUP, "member").ok).toBe(false);
  });

  it("allows global_admin", () => {
    const global = actor({ role: "global_admin", user_id: "u-charlie" });
    expect(canUnshare(global, MAILBOX, GROUP, null).ok).toBe(true);
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
