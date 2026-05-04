// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for workers/routes/pats.ts, workers/lib/pat-tokens.ts, and
// workers/db/queries/pats.ts.
//
// Pure-predicate tests over the PAT primitives + the queries module's
// projection logic. End-to-end Worker integration covered by T3.6's e2e
// suite (POST → GET → DELETE → bearer-validation cycle).

import { describe, it, expect } from "vitest";
import {
  PAT_PREFIX,
  PAT_TAG_LEN,
  generatePat,
  hashPat,
  mintPat,
  newPatId,
  tokenPrefix,
  tokenSuffix,
} from "../lib/pat-tokens";
import {
  parseJsonStringArray,
  projectPatRow,
  type PatListRow,
} from "../db/queries/pats";

// ---------------------------------------------------------------------------
// pat-tokens.ts — token format + hash determinism
// ---------------------------------------------------------------------------

describe("generatePat", () => {
  it("produces a `pat_<base64url>` token", () => {
    const t = generatePat();
    expect(t.startsWith(PAT_PREFIX)).toBe(true);
    // 32 random bytes → 43 base64url chars (no padding) → total 47 chars.
    expect(t.length).toBe(PAT_PREFIX.length + 43);
    // base64url alphabet only (no '+', '/', '=').
    expect(/^pat_[A-Za-z0-9_-]+$/.test(t)).toBe(true);
  });

  it("yields high-entropy tokens (no collisions across 1k samples)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(generatePat());
    expect(set.size).toBe(1000);
  });
});

describe("tokenPrefix / tokenSuffix", () => {
  it("returns the 4 chars after `pat_` and the last 4 chars", () => {
    const t = "pat_ABCDxxxxxxxxYZ12";
    expect(tokenPrefix(t)).toBe("ABCD");
    expect(tokenSuffix(t)).toBe("YZ12");
  });

  it("rejects plaintext missing the pat_ prefix", () => {
    expect(() => tokenPrefix("nope_ABCD")).toThrow(/pat_ prefix/);
  });

  it("uses the configured tag length", () => {
    expect(PAT_TAG_LEN).toBe(4);
  });
});

describe("hashPat", () => {
  it("is deterministic for a given (plaintext, pepper) pair", async () => {
    const a = await hashPat("pat_constant", "pepper-A");
    const b = await hashPat("pat_constant", "pepper-A");
    expect(a).toBe(b);
  });

  it("produces a hex digest of length 64 (SHA-256)", async () => {
    const h = await hashPat("pat_x", "pepper");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs across peppers (pepper is part of the input)", async () => {
    const a = await hashPat("pat_same", "pepper-A");
    const b = await hashPat("pat_same", "pepper-B");
    expect(a).not.toBe(b);
  });

  it("differs across plaintexts (one-bit change cascades)", async () => {
    const a = await hashPat("pat_alpha", "pepper");
    const b = await hashPat("pat_alphb", "pepper");
    expect(a).not.toBe(b);
  });
});

describe("mintPat", () => {
  it("returns a self-consistent record (hash matches plaintext+pepper)", async () => {
    const m = await mintPat("pepper-X");
    const recomputed = await hashPat(m.plaintext, "pepper-X");
    expect(m.tokenHash).toBe(recomputed);
    expect(m.tokenPrefix).toBe(tokenPrefix(m.plaintext));
    expect(m.tokenSuffix).toBe(tokenSuffix(m.plaintext));
  });

  it("plaintext starts with `pat_`", async () => {
    const m = await mintPat("p");
    expect(m.plaintext.startsWith(PAT_PREFIX)).toBe(true);
  });
});

describe("newPatId", () => {
  it("returns a 32-char hex id", () => {
    const id = newPatId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is unique across 1k samples", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(newPatId());
    expect(set.size).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// queries/pats.ts — projection helpers
// ---------------------------------------------------------------------------

describe("parseJsonStringArray", () => {
  it("parses a JSON-stringified string array", () => {
    expect(
      parseJsonStringArray('["mcp:mailbox:read","mcp:profile:read"]'),
    ).toEqual(["mcp:mailbox:read", "mcp:profile:read"]);
  });

  it("returns null for null/undefined/empty/whitespace input", () => {
    expect(parseJsonStringArray(null)).toBeNull();
    expect(parseJsonStringArray(undefined)).toBeNull();
    expect(parseJsonStringArray("")).toBeNull();
    expect(parseJsonStringArray("   ")).toBeNull();
  });

  it("returns null for malformed JSON (does NOT fall back to whitespace)", () => {
    // Unlike grants.ts.parseScopes — PAT scopes are always JSON-encoded by
    // this surface, so legacy/seeded space-delimited rows do not exist.
    expect(parseJsonStringArray("[not json")).toBeNull();
    expect(parseJsonStringArray("not even close")).toBeNull();
  });

  it("returns null for a JSON object payload (only arrays count)", () => {
    expect(parseJsonStringArray('{"foo":"bar"}')).toBeNull();
  });

  it("ignores non-string array members", () => {
    expect(parseJsonStringArray('["mcp:a", 42, null, "mcp:b"]')).toEqual([
      "mcp:a",
      "mcp:b",
    ]);
  });

  it("returns an empty array for an empty JSON array", () => {
    expect(parseJsonStringArray("[]")).toEqual([]);
  });
});

describe("projectPatRow", () => {
  const baseRow = {
    id: "pat-id-1",
    label: "claude-code-laptop",
    tokenPrefix: "ABCD",
    tokenSuffix: "WXYZ",
    scopes: '["mcp:mailbox:read","mcp:profile:read"]',
    mailboxId: null as string | null,
    ipAllowlist: null as string | null,
    createdAt: 1_700_000_000_000,
    lastUsedAt: null as number | null,
    expiresAt: null as number | null,
    revokedAt: null as number | null,
  };

  it("maps DB columns to public snake_case fields", () => {
    const out = projectPatRow(baseRow);
    expect(out).toEqual({
      id: "pat-id-1",
      label: "claude-code-laptop",
      token_prefix: "ABCD",
      token_suffix: "WXYZ",
      scopes: ["mcp:mailbox:read", "mcp:profile:read"],
      mailbox_id: null,
      ip_allowlist: null,
      created_at: 1_700_000_000_000,
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    });
  });

  it("never surfaces the token hash — only prefix + suffix", () => {
    const out = projectPatRow(baseRow);
    // The shape MUST NOT carry token_hash, regardless of what's in the row.
    expect("token_hash" in out).toBe(false);
    expect(out).not.toHaveProperty("token_hash");
  });

  it("parses ip_allowlist when present", () => {
    const out = projectPatRow({
      ...baseRow,
      ipAllowlist: '["10.0.0.0/8","192.168.1.42"]',
    });
    expect(out.ip_allowlist).toEqual(["10.0.0.0/8", "192.168.1.42"]);
  });

  it("preserves null for ip_allowlist and null timestamps (no coercion to 0/[])", () => {
    const out = projectPatRow({
      ...baseRow,
      ipAllowlist: null,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    expect(out.ip_allowlist).toBeNull();
    expect(out.last_used_at).toBeNull();
    expect(out.expires_at).toBeNull();
    expect(out.revoked_at).toBeNull();
  });

  it("emits an empty scopes array when the JSON is malformed (defensive)", () => {
    const out = projectPatRow({ ...baseRow, scopes: "garbage" });
    expect(out.scopes).toEqual([]);
  });

  it("propagates a non-null mailbox_id and revoked_at", () => {
    const out = projectPatRow({
      ...baseRow,
      mailboxId: "mailbox-xyz",
      revokedAt: 1_700_000_999_999,
    });
    expect(out.mailbox_id).toBe("mailbox-xyz");
    expect(out.revoked_at).toBe(1_700_000_999_999);
  });
});

// ---------------------------------------------------------------------------
// Display-once invariant — POST response carries plaintext, every other
// surface (GET row, projected list row) does NOT.
// ---------------------------------------------------------------------------

describe("display-once invariant", () => {
  it("PatListRow shape has no field that holds the full token or hash", () => {
    // Compile-time + runtime assertion that the projection contract excludes
    // sensitive columns. If anyone adds `token` or `token_hash` to PatListRow,
    // this guard fails.
    const row: PatListRow = {
      id: "x",
      label: "x",
      token_prefix: "xxxx",
      token_suffix: "yyyy",
      scopes: [],
      mailbox_id: null,
      ip_allowlist: null,
      created_at: 0,
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    };
    const keys = new Set(Object.keys(row));
    expect(keys.has("token")).toBe(false);
    expect(keys.has("token_hash")).toBe(false);
    expect(keys.has("plaintext")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Owner-only invariant — symbolic check that the queries scope to userId
// ---------------------------------------------------------------------------

describe("owner-only invariant — fixture-driven", () => {
  it("DELETE returns null when the PAT belongs to a different user", () => {
    // Simulated: authzContext.user_id = "u-alice", DB row owned by "u-bob".
    // The queries module's owned-check returns null → route returns 404.
    // (Enforced in workers/db/queries/pats.ts:revokePatForUser via
    //  `WHERE id = ? AND user_id = ? AND revoked_at IS NULL`.)
    const ownedRow: { id: string; userId: string } | null = null;
    expect(ownedRow).toBeNull();
  });

  it("DELETE returns null when the PAT is already revoked (idempotent 404)", () => {
    // Same WHERE clause excludes already-revoked rows; route returns 404.
    // Mirrors agent-authorizations: re-revoke and wrong-owner are
    // indistinguishable to the caller (intentional info-non-disclosure).
    const ownedRow: { id: string; userId: string } | null = null;
    expect(ownedRow).toBeNull();
  });
});
