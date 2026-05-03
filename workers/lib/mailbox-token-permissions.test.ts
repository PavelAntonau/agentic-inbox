// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { describe, expect, it } from "vitest";
import {
  canIssueToken,
  canListTokens,
  canRevokeToken,
  type MailboxRow,
  type AgentTokenRow,
} from "./mailbox-token-permissions";
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
  owner_user_id: "u-alice",
};

const OTHER_MAILBOX: MailboxRow = {
  id: "mb-2",
  owner_user_id: "u-bob",
};

const TOKEN: AgentTokenRow = {
  id: "tok-1",
  mailbox_id: "mb-1",
  issued_to_user: "u-alice",
  revoked_at: null,
};

const OTHER_TOKEN: AgentTokenRow = {
  id: "tok-2",
  mailbox_id: "mb-2",
  issued_to_user: "u-bob",
  revoked_at: null,
};

// ---------------------------------------------------------------------------
// canIssueToken
// ---------------------------------------------------------------------------

describe("canIssueToken", () => {
  it("allows mailbox owner", () => {
    expect(canIssueToken(actor(), MAILBOX).ok).toBe(true);
  });

  it("blocks non-owner non-global user", () => {
    // u-alice is NOT the owner of mb-2 (u-bob is)
    const result = canIssueToken(actor(), OTHER_MAILBOX);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/owner/i);
  });

  it("allows global_owner regardless of ownership", () => {
    expect(
      canIssueToken(
        actor({ role: "global_owner", user_id: "u-charlie" }),
        OTHER_MAILBOX,
      ).ok,
    ).toBe(true);
  });

  it("allows global_admin regardless of ownership", () => {
    expect(
      canIssueToken(
        actor({ role: "global_admin", user_id: "u-charlie" }),
        OTHER_MAILBOX,
      ).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canListTokens
// ---------------------------------------------------------------------------

describe("canListTokens", () => {
  it("allows mailbox owner", () => {
    expect(canListTokens(actor(), MAILBOX).ok).toBe(true);
  });

  it("allows actor with mailbox in authorized_mailbox_ids (group member)", () => {
    // u-alice has mb-1 authorized via group
    expect(canListTokens(actor(), MAILBOX).ok).toBe(true);
  });

  it("blocks actor without access to mailbox — actor is different from owner and not in group", () => {
    // u-charlie has no authorized mailboxes and is not owner of mb-2
    const result = canListTokens(
      actor({ user_id: "u-charlie", authorized_mailbox_ids: [] }),
      OTHER_MAILBOX,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/access/i);
  });

  it("allows global_admin", () => {
    expect(
      canListTokens(
        actor({
          role: "global_admin",
          user_id: "u-charlie",
          authorized_mailbox_ids: [],
        }),
        OTHER_MAILBOX,
      ).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canRevokeToken
// ---------------------------------------------------------------------------

describe("canRevokeToken", () => {
  it("allows mailbox owner to revoke any token on their mailbox", () => {
    expect(canRevokeToken(actor(), MAILBOX, TOKEN).ok).toBe(true);
  });

  it("allows the user the token was issued to", () => {
    // u-alice issued TOKEN but u-bob is NOT the owner of mb-2
    // Here alice can revoke her own token even if on someone else's mailbox
    expect(canRevokeToken(actor(), OTHER_MAILBOX, TOKEN).ok).toBe(true);
  });

  it("blocks a third party who is neither owner nor token issuer", () => {
    // u-charlie is not the owner of mb-2 nor was OTHER_TOKEN issued to charlie
    const result = canRevokeToken(
      actor({ user_id: "u-charlie" }),
      OTHER_MAILBOX,
      OTHER_TOKEN,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/owner/i);
  });

  it("allows global_owner to revoke any token", () => {
    expect(
      canRevokeToken(
        actor({ role: "global_owner", user_id: "u-charlie" }),
        OTHER_MAILBOX,
        OTHER_TOKEN,
      ).ok,
    ).toBe(true);
  });

  it("allows global_admin to revoke any token", () => {
    expect(
      canRevokeToken(
        actor({ role: "global_admin", user_id: "u-charlie" }),
        OTHER_MAILBOX,
        OTHER_TOKEN,
      ).ok,
    ).toBe(true);
  });
});
