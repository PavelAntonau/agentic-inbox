// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for workers/routes/tokens.ts
// Uses a lightweight fetch-based integration harness — no real D1/DO bindings.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthzContext } from "../db/control-plane/forGroup";

// ---------------------------------------------------------------------------
// Pure logic tests for permission predicates used by the router
// (router integration tests require a full Worker harness; these cover
// the business-logic surface exercised by the router.)
// ---------------------------------------------------------------------------

import {
  canIssueToken,
  canListTokens,
  canRevokeToken,
  type MailboxRow,
  type AgentTokenRow,
} from "../lib/mailbox-token-permissions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function actor(overrides: Partial<AuthzContext> = {}): AuthzContext {
  return {
    user_id: "u-alice",
    role: "user",
    group_ids: [],
    authorized_mailbox_ids: ["mb-1"],
    ...overrides,
  };
}

const MAILBOX: MailboxRow = { id: "mb-1", owner_user_id: "u-alice" };
const OTHER_MAILBOX: MailboxRow = { id: "mb-2", owner_user_id: "u-bob" };

const ALICE_TOKEN: AgentTokenRow = {
  id: "tok-1",
  mailbox_id: "mb-1",
  issued_to_user: "u-alice",
  revoked_at: null,
};

const BOB_TOKEN: AgentTokenRow = {
  id: "tok-2",
  mailbox_id: "mb-2",
  issued_to_user: "u-bob",
  revoked_at: null,
};

// ---------------------------------------------------------------------------
// Issue token — canIssueToken
// ---------------------------------------------------------------------------

describe("token issue permission", () => {
  it("owner can issue on own mailbox", () => {
    expect(canIssueToken(actor(), MAILBOX).ok).toBe(true);
  });

  it("non-owner cannot issue on another mailbox", () => {
    // alice is NOT u-bob, so she can't issue on mb-2
    expect(canIssueToken(actor(), OTHER_MAILBOX).ok).toBe(false);
  });

  it("global_admin can issue on any mailbox", () => {
    expect(
      canIssueToken(
        actor({ role: "global_admin", user_id: "u-admin" }),
        OTHER_MAILBOX,
      ).ok,
    ).toBe(true);
  });

  it("global_owner can issue on any mailbox", () => {
    expect(
      canIssueToken(
        actor({ role: "global_owner", user_id: "u-owner" }),
        OTHER_MAILBOX,
      ).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// List tokens — canListTokens
// ---------------------------------------------------------------------------

describe("token list permission", () => {
  it("owner can list tokens for own mailbox", () => {
    expect(canListTokens(actor(), MAILBOX).ok).toBe(true);
  });

  it("group member with authorized mailbox can list", () => {
    // actor has mb-1 in authorized_mailbox_ids
    expect(canListTokens(actor(), MAILBOX).ok).toBe(true);
  });

  it("actor without access cannot list", () => {
    const result = canListTokens(
      actor({ user_id: "u-charlie", authorized_mailbox_ids: [] }),
      OTHER_MAILBOX,
    );
    expect(result.ok).toBe(false);
  });

  it("global can list any", () => {
    expect(
      canListTokens(
        actor({
          role: "global_admin",
          user_id: "u-admin",
          authorized_mailbox_ids: [],
        }),
        OTHER_MAILBOX,
      ).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Revoke token — canRevokeToken
// ---------------------------------------------------------------------------

describe("token revoke permission", () => {
  it("mailbox owner can revoke any token on their mailbox", () => {
    expect(canRevokeToken(actor(), MAILBOX, ALICE_TOKEN).ok).toBe(true);
  });

  it("token issuer can revoke their own token", () => {
    // alice issued ALICE_TOKEN — she can revoke it even on bob's mailbox
    expect(canRevokeToken(actor(), OTHER_MAILBOX, ALICE_TOKEN).ok).toBe(true);
  });

  it("third party cannot revoke", () => {
    // charlie is not owner of mb-2 and did not issue BOB_TOKEN
    const result = canRevokeToken(
      actor({ user_id: "u-charlie" }),
      OTHER_MAILBOX,
      BOB_TOKEN,
    );
    expect(result.ok).toBe(false);
  });

  it("global_owner can revoke any token", () => {
    expect(
      canRevokeToken(
        actor({ role: "global_owner", user_id: "u-admin" }),
        OTHER_MAILBOX,
        BOB_TOKEN,
      ).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mock service-token helpers
// ---------------------------------------------------------------------------

import {
  mockCreateServiceToken,
  mockDeleteServiceToken,
} from "../lib/cloudflare-access-service-tokens";

describe("mockCreateServiceToken", () => {
  it("returns a token with client_id and client_secret", () => {
    const result = mockCreateServiceToken({ name: "mb-1:u-alice:my-agent" });
    expect(result.client_id).toBeTruthy();
    expect(result.client_secret).toMatch(/^mock-secret-/);
    expect(result.name).toBe("mb-1:u-alice:my-agent");
  });

  it("defaults duration to 2160h", () => {
    const result = mockCreateServiceToken({ name: "test" });
    // expires_at should be ~90 days in the future
    const diffHours =
      (new Date(result.expires_at).getTime() - Date.now()) / 3_600_000;
    expect(diffHours).toBeGreaterThan(2000);
    expect(diffHours).toBeLessThan(2200);
  });

  it("respects custom duration", () => {
    const result = mockCreateServiceToken({ name: "test", duration: "720h" });
    const diffHours =
      (new Date(result.expires_at).getTime() - Date.now()) / 3_600_000;
    expect(diffHours).toBeGreaterThan(700);
    expect(diffHours).toBeLessThan(740);
  });
});

describe("mockDeleteServiceToken", () => {
  it("returns the id passed in", () => {
    const result = mockDeleteServiceToken("cf-tok-123");
    expect(result.id).toBe("cf-tok-123");
  });
});
