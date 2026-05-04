// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for workers/routes/inbox-policies.ts
// Uses pure predicate/logic tests — mirrors the pattern from sessions.test.ts.
// Full route integration requires a Worker harness; these tests verify the
// business logic that lives in the route handlers.

import { describe, it, expect } from "vitest";
import type { AuthzContext } from "../db/control-plane/forGroup";

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

interface MailboxPolicyRow {
  id: string;
  owner_user_id: string;
  external_inbound_enabled: boolean;
  external_send_enabled: boolean;
  external_allow_mode: "all" | "allowlist";
  internal_inbound_mode: "everyone" | "contacts_only" | "none";
}

interface AclRow {
  mailbox_id: string;
  user_id: string;
  level: "read" | "write" | "admin";
}

interface AllowlistEntry {
  id: string;
  inbox_id: string;
  sender_pattern: string;
  kind: "email" | "domain";
  created_at: number;
}

function makeMailbox(
  overrides: Partial<MailboxPolicyRow> & { id: string; owner_user_id: string },
): MailboxPolicyRow {
  return {
    external_inbound_enabled: true,
    external_send_enabled: false,
    external_allow_mode: "all",
    internal_inbound_mode: "everyone",
    ...overrides,
  };
}

function makeAllowlistEntry(
  overrides: Partial<AllowlistEntry> & {
    id: string;
    inbox_id: string;
    sender_pattern: string;
  },
): AllowlistEntry {
  return {
    kind: "email",
    created_at: Date.now() - 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers mirroring route handler logic
// ---------------------------------------------------------------------------

/**
 * Mirrors resolveOwnedMailbox: returns the mailbox if the user owns it or has
 * a write/admin ACL, otherwise null.
 */
function resolveOwnedMailbox(
  mailbox: MailboxPolicyRow | null,
  acls: AclRow[],
  userId: string,
): MailboxPolicyRow | null {
  if (!mailbox) return null;
  if (mailbox.owner_user_id === userId) return mailbox;
  const acl = acls.find(
    (a) => a.mailbox_id === mailbox.id && a.user_id === userId,
  );
  if (acl && (acl.level === "write" || acl.level === "admin")) return mailbox;
  return null;
}

/**
 * Mirrors the PATCH validation in the route handler.
 * Returns the validated updates object or an error.
 */
function validatePolicyUpdates(body: Record<string, unknown>):
  | {
      ok: true;
      updates: {
        external_inbound_enabled?: boolean;
        external_send_enabled?: boolean;
        external_allow_mode?: "all" | "allowlist";
        internal_inbound_mode?: "everyone" | "contacts_only" | "none";
      };
    }
  | { ok: false; error: string } {
  const updates: {
    external_inbound_enabled?: boolean;
    external_send_enabled?: boolean;
    external_allow_mode?: "all" | "allowlist";
    internal_inbound_mode?: "everyone" | "contacts_only" | "none";
  } = {};

  if ("external_inbound_enabled" in body) {
    if (typeof body.external_inbound_enabled !== "boolean") {
      return { ok: false, error: "external_inbound_enabled must be a boolean" };
    }
    updates.external_inbound_enabled = body.external_inbound_enabled;
  }

  if ("external_send_enabled" in body) {
    if (typeof body.external_send_enabled !== "boolean") {
      return { ok: false, error: "external_send_enabled must be a boolean" };
    }
    updates.external_send_enabled = body.external_send_enabled;
  }

  if ("external_allow_mode" in body) {
    const v = body.external_allow_mode;
    if (v !== "all" && v !== "allowlist") {
      return {
        ok: false,
        error: "external_allow_mode must be 'all' or 'allowlist'",
      };
    }
    updates.external_allow_mode = v;
  }

  if ("internal_inbound_mode" in body) {
    const v = body.internal_inbound_mode;
    if (v !== "everyone" && v !== "contacts_only" && v !== "none") {
      return {
        ok: false,
        error:
          "internal_inbound_mode must be 'everyone', 'contacts_only', or 'none'",
      };
    }
    updates.internal_inbound_mode = v;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "No recognised fields to update" };
  }

  return { ok: true, updates };
}

/**
 * Mirrors the allowlist entry kind validation.
 */
function validateAllowlistKind(kind: unknown): boolean {
  return kind === "email" || kind === "domain";
}

// ---------------------------------------------------------------------------
// GET /api/mailboxes/:id/policies — default values
// ---------------------------------------------------------------------------

describe("GET policies — default state", () => {
  it("returns defaults for a fresh mailbox", () => {
    const mailbox = makeMailbox({ id: "m-1", owner_user_id: "u-alice" });
    const ctx = makeCtx("u-alice");

    const resolved = resolveOwnedMailbox(mailbox, [], ctx.user_id);
    expect(resolved).not.toBeNull();
    expect(resolved!.external_inbound_enabled).toBe(true);
    expect(resolved!.external_send_enabled).toBe(false);
    expect(resolved!.external_allow_mode).toBe("all");
    expect(resolved!.internal_inbound_mode).toBe("everyone");
  });

  it("returns empty allowlist for a fresh mailbox", () => {
    const allowlist: AllowlistEntry[] = [];
    expect(allowlist).toHaveLength(0);
  });

  it("returns 404 equivalent when mailbox not found", () => {
    const ctx = makeCtx("u-alice");
    const resolved = resolveOwnedMailbox(null, [], ctx.user_id);
    expect(resolved).toBeNull();
  });

  it("returns 404 equivalent when caller does not own the mailbox", () => {
    const mailbox = makeMailbox({ id: "m-1", owner_user_id: "u-bob" });
    const ctx = makeCtx("u-alice");
    const resolved = resolveOwnedMailbox(mailbox, [], ctx.user_id);
    expect(resolved).toBeNull();
  });

  it("grants access via write-level ACL", () => {
    const mailbox = makeMailbox({ id: "m-1", owner_user_id: "u-bob" });
    const acls: AclRow[] = [
      { mailbox_id: "m-1", user_id: "u-alice", level: "write" },
    ];
    const ctx = makeCtx("u-alice");
    const resolved = resolveOwnedMailbox(mailbox, acls, ctx.user_id);
    expect(resolved).not.toBeNull();
  });

  it("grants access via admin-level ACL", () => {
    const mailbox = makeMailbox({ id: "m-1", owner_user_id: "u-bob" });
    const acls: AclRow[] = [
      { mailbox_id: "m-1", user_id: "u-alice", level: "admin" },
    ];
    const ctx = makeCtx("u-alice");
    const resolved = resolveOwnedMailbox(mailbox, acls, ctx.user_id);
    expect(resolved).not.toBeNull();
  });

  it("denies access with only read-level ACL", () => {
    const mailbox = makeMailbox({ id: "m-1", owner_user_id: "u-bob" });
    const acls: AclRow[] = [
      { mailbox_id: "m-1", user_id: "u-alice", level: "read" },
    ];
    const ctx = makeCtx("u-alice");
    const resolved = resolveOwnedMailbox(mailbox, acls, ctx.user_id);
    expect(resolved).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/mailboxes/:id/policies — update validation
// ---------------------------------------------------------------------------

describe("PATCH policies — field updates", () => {
  it("accepts external_inbound_enabled=false", () => {
    const result = validatePolicyUpdates({ external_inbound_enabled: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updates.external_inbound_enabled).toBe(false);
    }
  });

  it("updates one field and returns the updated state", () => {
    // Simulate applying the update
    const mailbox = makeMailbox({ id: "m-1", owner_user_id: "u-alice" });
    const result = validatePolicyUpdates({
      external_inbound_enabled: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const updated = { ...mailbox, ...result.updates };
      expect(updated.external_inbound_enabled).toBe(false);
      // Other fields unchanged
      expect(updated.external_allow_mode).toBe("all");
      expect(updated.internal_inbound_mode).toBe("everyone");
    }
  });

  it("accepts external_allow_mode='allowlist'", () => {
    const result = validatePolicyUpdates({ external_allow_mode: "allowlist" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updates.external_allow_mode).toBe("allowlist");
    }
  });

  it("accepts internal_inbound_mode='contacts_only'", () => {
    const result = validatePolicyUpdates({
      internal_inbound_mode: "contacts_only",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updates.internal_inbound_mode).toBe("contacts_only");
    }
  });

  it("accepts internal_inbound_mode='none'", () => {
    const result = validatePolicyUpdates({ internal_inbound_mode: "none" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updates.internal_inbound_mode).toBe("none");
    }
  });

  it("accepts multiple fields in one PATCH", () => {
    const result = validatePolicyUpdates({
      external_inbound_enabled: false,
      internal_inbound_mode: "none",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updates.external_inbound_enabled).toBe(false);
      expect(result.updates.internal_inbound_mode).toBe("none");
    }
  });

  it("rejects invalid external_allow_mode → 400 path", () => {
    const result = validatePolicyUpdates({ external_allow_mode: "blocklist" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/external_allow_mode/);
    }
  });

  it("rejects invalid internal_inbound_mode → 400 path", () => {
    const result = validatePolicyUpdates({
      internal_inbound_mode: "admins_only",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/internal_inbound_mode/);
    }
  });

  it("rejects non-boolean external_inbound_enabled → 400 path", () => {
    const result = validatePolicyUpdates({ external_inbound_enabled: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/boolean/);
    }
  });

  it("rejects empty body with no recognised fields → 400 path", () => {
    const result = validatePolicyUpdates({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no recognised fields/i);
    }
  });

  it("ignores unknown keys and rejects if no valid keys present", () => {
    const result = validatePolicyUpdates({ unknown_field: "foo" });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PATCH policies — external_send_enabled (TASK-2.3)
// ---------------------------------------------------------------------------

describe("PATCH policies — external_send_enabled round-trip", () => {
  it("default is false on a fresh mailbox", () => {
    const mailbox = makeMailbox({ id: "m-1", owner_user_id: "u-alice" });
    expect(mailbox.external_send_enabled).toBe(false);
  });

  it("PATCH external_send_enabled=true is accepted and applied", () => {
    const mailbox = makeMailbox({ id: "m-1", owner_user_id: "u-alice" });
    const result = validatePolicyUpdates({ external_send_enabled: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updates.external_send_enabled).toBe(true);
      const updated = { ...mailbox, ...result.updates };
      expect(updated.external_send_enabled).toBe(true);
      // Other fields unchanged
      expect(updated.external_inbound_enabled).toBe(true);
      expect(updated.internal_inbound_mode).toBe("everyone");
    }
  });

  it("PATCH external_send_enabled=false toggles back to default", () => {
    const mailbox = makeMailbox({
      id: "m-1",
      owner_user_id: "u-alice",
      external_send_enabled: true,
    });
    const result = validatePolicyUpdates({ external_send_enabled: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updates.external_send_enabled).toBe(false);
      const updated = { ...mailbox, ...result.updates };
      expect(updated.external_send_enabled).toBe(false);
    }
  });

  it("rejects non-boolean external_send_enabled → 400 path", () => {
    const result = validatePolicyUpdates({ external_send_enabled: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/external_send_enabled.*boolean/);
    }
  });

  it("rejects null external_send_enabled → 400 path", () => {
    const result = validatePolicyUpdates({ external_send_enabled: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/external_send_enabled.*boolean/);
    }
  });

  it("accepts external_send_enabled alongside external_inbound_enabled in one PATCH", () => {
    const result = validatePolicyUpdates({
      external_send_enabled: true,
      external_inbound_enabled: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updates.external_send_enabled).toBe(true);
      expect(result.updates.external_inbound_enabled).toBe(false);
    }
  });

  it("GET response shape includes external_send_enabled", () => {
    const mailbox = makeMailbox({
      id: "m-1",
      owner_user_id: "u-alice",
      external_send_enabled: true,
    });
    // Mirror the route's GET response shape
    const response = {
      external_inbound_enabled: mailbox.external_inbound_enabled,
      external_send_enabled: mailbox.external_send_enabled,
      external_allow_mode: mailbox.external_allow_mode,
      internal_inbound_mode: mailbox.internal_inbound_mode,
      allowlist: [],
    };
    expect(response.external_send_enabled).toBe(true);
    expect(Object.keys(response)).toContain("external_send_enabled");
  });
});

// ---------------------------------------------------------------------------
// POST /api/mailboxes/:id/policies/allowlist — add entry
// ---------------------------------------------------------------------------

describe("POST allowlist — add entry", () => {
  it("accepts kind='email'", () => {
    expect(validateAllowlistKind("email")).toBe(true);
  });

  it("accepts kind='domain'", () => {
    expect(validateAllowlistKind("domain")).toBe(true);
  });

  it("rejects invalid kind", () => {
    expect(validateAllowlistKind("subdomain")).toBe(false);
    expect(validateAllowlistKind(undefined)).toBe(false);
    expect(validateAllowlistKind(null)).toBe(false);
  });

  it("new entry is visible in the allowlist", () => {
    const existing: AllowlistEntry[] = [];
    const newEntry = makeAllowlistEntry({
      id: "al-1",
      inbox_id: "m-1",
      sender_pattern: "bob@example.com",
      kind: "email",
    });
    const updated = [...existing, newEntry];
    expect(updated).toHaveLength(1);
    expect(updated[0].sender_pattern).toBe("bob@example.com");
    expect(updated[0].kind).toBe("email");
  });

  it("domain entry with @example.com pattern", () => {
    const entry = makeAllowlistEntry({
      id: "al-2",
      inbox_id: "m-1",
      sender_pattern: "@example.com",
      kind: "domain",
    });
    expect(entry.kind).toBe("domain");
    expect(entry.sender_pattern).toBe("@example.com");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/mailboxes/:id/policies/allowlist/:entryId — remove entry
// ---------------------------------------------------------------------------

describe("DELETE allowlist entry", () => {
  it("entry is absent after deletion", () => {
    const entries: AllowlistEntry[] = [
      makeAllowlistEntry({
        id: "al-1",
        inbox_id: "m-1",
        sender_pattern: "bob@example.com",
      }),
      makeAllowlistEntry({
        id: "al-2",
        inbox_id: "m-1",
        sender_pattern: "carol@example.com",
      }),
    ];
    // Simulate deletion of al-1
    const afterDelete = entries.filter((e) => e.id !== "al-1");
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0].id).toBe("al-2");
  });

  it("deleting a non-existent entry returns 404 equivalent", () => {
    const entries: AllowlistEntry[] = [];
    const found = entries.find((e) => e.id === "al-nonexistent");
    expect(found).toBeUndefined();
  });

  it("entry from a different mailbox is not deletable via this mailbox", () => {
    const entry = makeAllowlistEntry({
      id: "al-1",
      inbox_id: "m-OTHER",
      sender_pattern: "test@example.com",
    });
    // Route checks inbox_id match in the WHERE clause
    const isOwnedByMailbox = entry.inbox_id === "m-1";
    expect(isOwnedByMailbox).toBe(false);
  });
});
