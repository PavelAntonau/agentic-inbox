// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T3.6 (mcp-oauth) — PAT lifecycle end-to-end.
//
// Mints a PAT through the real `mintPat` primitive, stores the row in an
// in-memory Map keyed by token_hash, and drives every transition (create →
// bearer → list-projection → revoke → bearer-rejected) through the same
// modules that production wires together. The Map stands in for D1 — the
// SQL queries themselves have unit coverage in workers/routes/pats.test.ts;
// what's exercised here is the multi-component contract:
//
//   mintPat → POST projection (display-once, then prefix/suffix only)
//          → bearer middleware lookup-by-hash
//          → touchPatLastUsedAt updates the row in place
//          → revokePatForUser flips revoked_at and removes the row from
//            the active-by-hash query result
//          → bearer middleware now rejects pat-not-found
//
// "Mailbox + IP allowlist plumbing" — T3.3's bearer surface threads these
// columns through to BearerOk; T3.6 owns enforcement in a future commit.
// What's locked here is the pass-through: scoped PATs surface their
// scope-narrowing metadata to downstream policy.

import { describe, it, expect } from "vitest";
import {
  mintPat,
  hashPat,
  tokenPrefix,
  tokenSuffix,
} from "../../workers/lib/pat-tokens";
import {
  projectPatRow,
  type ActivePatRow,
} from "../../workers/db/queries/pats";
import {
  validateBearer,
  type BearerDeps,
} from "../../workers/middleware/oauth-bearer";
import type { Env } from "../../workers/types";

const TEST_PEPPER = "test-pepper-T3.6";
const TEST_USER_ID = "user_t36_alice";

// ---------------------------------------------------------------------------
// In-memory PAT store — emulates the active-by-hash query + touch + revoke
// SQL on top of a JS Map. Mirrors the D1 schema's invariants:
//   - PRIMARY KEY (id)
//   - UNIQUE (token_hash)
//   - getActivePatByHash filters: revoked_at IS NULL AND
//     (expires_at IS NULL OR expires_at > now)
// ---------------------------------------------------------------------------

interface StoredRow {
  id: string;
  user_id: string;
  label: string;
  token_hash: string;
  token_prefix: string;
  token_suffix: string;
  scopes: string[];
  mailbox_id: string | null;
  ip_allowlist: string[] | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

class InMemoryPatStore {
  private rows = new Map<string, StoredRow>(); // keyed by id
  private byHash = new Map<string, string>(); // hash → id

  insert(input: Omit<StoredRow, "last_used_at" | "revoked_at">): StoredRow {
    if (this.byHash.has(input.token_hash)) {
      throw new Error("UNIQUE token_hash violated");
    }
    const row: StoredRow = {
      ...input,
      last_used_at: null,
      revoked_at: null,
    };
    this.rows.set(row.id, row);
    this.byHash.set(row.token_hash, row.id);
    return row;
  }

  getActiveByHash(hash: string, now: number): ActivePatRow | null {
    const id = this.byHash.get(hash);
    if (!id) return null;
    const row = this.rows.get(id)!;
    if (row.revoked_at != null) return null;
    if (row.expires_at != null && row.expires_at <= now) return null;
    return {
      id: row.id,
      user_id: row.user_id,
      scopes: row.scopes,
      mailbox_id: row.mailbox_id,
      ip_allowlist: row.ip_allowlist,
      expires_at: row.expires_at,
    };
  }

  touchLastUsed(id: string, now: number): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.last_used_at = now;
  }

  revoke(id: string, userId: string, now: number): number | null {
    const row = this.rows.get(id);
    if (!row || row.user_id !== userId || row.revoked_at != null) return null;
    row.revoked_at = now;
    return now;
  }

  /** List rows for a user — newest-first; mirrors listPatsForUser. */
  listForUser(userId: string): StoredRow[] {
    return [...this.rows.values()]
      .filter((r) => r.user_id === userId)
      .sort((a, b) => b.created_at - a.created_at);
  }

  get(id: string): StoredRow | undefined {
    return this.rows.get(id);
  }
}

function makeBearerDeps(
  store: InMemoryPatStore,
  now: () => number,
): BearerDeps {
  return {
    lookupPatByHash: async (_env, hash, t) => store.getActiveByHash(hash, t),
    touchPatLastUsed: async (_env, patId, t) => store.touchLastUsed(patId, t),
    now,
  };
}

function makeMcpRequest(
  authHeader: string | undefined,
  cookieHeader?: string,
): Request {
  const headerMap = new Map<string, string>();
  if (authHeader) headerMap.set("authorization", authHeader);
  if (cookieHeader) headerMap.set("cookie", cookieHeader);
  return {
    method: "POST",
    url: "https://mail.actionnow.ai/mcp",
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
  } as unknown as Request;
}

const FAKE_ENV: Env = {
  TOKEN_PEPPER: TEST_PEPPER,
  // The PAT path never hits the JWT verification layer, so the signing key
  // can stay undefined in this suite.
} as unknown as Env;

// ---------------------------------------------------------------------------
// Lifecycle: mint → use → revoke → reject
// ---------------------------------------------------------------------------

describe("PAT lifecycle — mint, project, bearer, list, revoke", () => {
  it("end-to-end: mint a PAT, use it on /mcp, list shows display tags only, revoke makes it dead", async () => {
    const store = new InMemoryPatStore();
    const clock = { t: 1_700_000_000_000 };
    const now = () => clock.t;

    // 1. Mint via the real primitive — the route layer would persist this
    //    plus the prefix/suffix display tags.
    const minted = await mintPat(TEST_PEPPER);
    expect(minted.plaintext).toMatch(/^pat_[A-Za-z0-9_-]+$/);
    expect(minted.tokenPrefix).toBe(tokenPrefix(minted.plaintext));
    expect(minted.tokenSuffix).toBe(tokenSuffix(minted.plaintext));
    // Hash determinism: server-side recompute matches mint output.
    expect(minted.tokenHash).toBe(await hashPat(minted.plaintext, TEST_PEPPER));

    // 2. Persist as if POST /api/users/me/pats had succeeded.
    const inserted = store.insert({
      id: "pat_id_alice_1",
      user_id: TEST_USER_ID,
      label: "Test PAT — alice@actionnow.ai",
      token_hash: minted.tokenHash,
      token_prefix: minted.tokenPrefix,
      token_suffix: minted.tokenSuffix,
      scopes: ["mcp:mailbox:read", "mcp:contacts:read"],
      mailbox_id: null,
      ip_allowlist: null,
      created_at: clock.t,
      expires_at: null,
    });

    // 3. The display-once contract: POST response carried the plaintext;
    //    every subsequent projection MUST surface only prefix/suffix.
    const projected = projectPatRow({
      id: inserted.id,
      label: inserted.label,
      tokenPrefix: inserted.token_prefix,
      tokenSuffix: inserted.token_suffix,
      scopes: JSON.stringify(inserted.scopes),
      mailboxId: inserted.mailbox_id,
      ipAllowlist: inserted.ip_allowlist
        ? JSON.stringify(inserted.ip_allowlist)
        : null,
      createdAt: inserted.created_at,
      lastUsedAt: inserted.last_used_at,
      expiresAt: inserted.expires_at,
      revokedAt: inserted.revoked_at,
    });
    expect(projected.token_prefix).toBe(minted.tokenPrefix);
    expect(projected.token_suffix).toBe(minted.tokenSuffix);
    // The full plaintext token never leaks through the projection.
    expect(JSON.stringify(projected)).not.toContain(minted.plaintext);

    // 4. Use the bearer on /mcp.
    clock.t += 5_000;
    const deps = makeBearerDeps(store, now);
    const r = await validateBearer(
      makeMcpRequest(`Bearer ${minted.plaintext}`),
      FAKE_ENV,
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("pat");
      expect(r.user_id).toBe(TEST_USER_ID);
      expect(r.client_id).toBe(`pat:${inserted.id}`);
      expect(r.pat_id).toBe(inserted.id);
      expect(r.scopes).toEqual(["mcp:mailbox:read", "mcp:contacts:read"]);
      expect(r.mailbox_id).toBeNull();
      expect(r.ip_allowlist).toBeNull();
    }

    // 5. last_used_at flipped within the bearer call (touch awaited inline
    //    when ctx is absent). The 1-second SLA in the action plan
    //    (see T3.6 commentary, ~line 460) is satisfied trivially in-process.
    expect(store.get(inserted.id)?.last_used_at).toBe(clock.t);

    // 6. Revoke — flip revoked_at.
    clock.t += 1_000;
    const revokedAt = store.revoke(inserted.id, TEST_USER_ID, clock.t);
    expect(revokedAt).toBe(clock.t);

    // 7. Subsequent bearer call must reject pat-not-found uniformly.
    clock.t += 100;
    const r2 = await validateBearer(
      makeMcpRequest(`Bearer ${minted.plaintext}`),
      FAKE_ENV,
      deps,
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.reason).toBe("pat-not-found");
      expect(r2.bearer_error).toBe("invalid_token");
    }

    // 8. Re-revoke is idempotent at the row level: returns null because
    //    revoked_at is already set.
    expect(store.revoke(inserted.id, TEST_USER_ID, clock.t)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scoped PATs — mailbox_id + ip_allowlist plumb through to BearerOk
// ---------------------------------------------------------------------------

describe("PAT lifecycle — scoping metadata threads to BearerOk", () => {
  it("surfaces mailbox_id and ip_allowlist when set on the PAT row", async () => {
    const store = new InMemoryPatStore();
    const clock = { t: 1_710_000_000_000 };
    const now = () => clock.t;

    const minted = await mintPat(TEST_PEPPER);
    store.insert({
      id: "pat_id_scoped_42",
      user_id: TEST_USER_ID,
      label: "Mailbox-scoped PAT",
      token_hash: minted.tokenHash,
      token_prefix: minted.tokenPrefix,
      token_suffix: minted.tokenSuffix,
      scopes: ["mcp:mailbox:write"],
      mailbox_id: "mbox_42",
      ip_allowlist: ["10.0.0.0/8", "192.168.1.1"],
      created_at: clock.t,
      expires_at: null,
    });

    const r = await validateBearer(
      makeMcpRequest(`Bearer ${minted.plaintext}`),
      FAKE_ENV,
      makeBearerDeps(store, now),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mailbox_id).toBe("mbox_42");
      expect(r.ip_allowlist).toEqual(["10.0.0.0/8", "192.168.1.1"]);
      // Per-tool / per-IP enforcement is deferred to the dispatch boundary;
      // T3.6's contract here is just "the metadata reaches the caller".
    }
  });

  it("rejects insufficient_scope when no mcp:* scope is present (still touches no row)", async () => {
    const store = new InMemoryPatStore();
    const clock = { t: 1_720_000_000_000 };
    const now = () => clock.t;

    const minted = await mintPat(TEST_PEPPER);
    store.insert({
      id: "pat_id_no_mcp",
      user_id: TEST_USER_ID,
      label: "Profile-only PAT",
      token_hash: minted.tokenHash,
      token_prefix: minted.tokenPrefix,
      token_suffix: minted.tokenSuffix,
      scopes: ["profile:read", "email:read"],
      mailbox_id: null,
      ip_allowlist: null,
      created_at: clock.t,
      expires_at: null,
    });

    const r = await validateBearer(
      makeMcpRequest(`Bearer ${minted.plaintext}`),
      FAKE_ENV,
      makeBearerDeps(store, now),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("pat-no-mcp-scope");
      expect(r.bearer_error).toBe("insufficient_scope");
    }
    // Insufficient-scope rejection MUST NOT touch last_used_at — see
    // workers/middleware/oauth-bearer.test.ts L520 for the contract.
    expect(store.get("pat_id_no_mcp")?.last_used_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Expiry — getActiveByHash filters expires_at <= now uniformly with revoke
// ---------------------------------------------------------------------------

describe("PAT lifecycle — expiry collapses into pat-not-found", () => {
  it("an expired PAT is indistinguishable from a revoked / unknown PAT", async () => {
    const store = new InMemoryPatStore();
    const clock = { t: 1_730_000_000_000 };
    const now = () => clock.t;

    const minted = await mintPat(TEST_PEPPER);
    store.insert({
      id: "pat_id_expiring",
      user_id: TEST_USER_ID,
      label: "Short-lived PAT",
      token_hash: minted.tokenHash,
      token_prefix: minted.tokenPrefix,
      token_suffix: minted.tokenSuffix,
      scopes: ["mcp:mailbox:read"],
      mailbox_id: null,
      ip_allowlist: null,
      created_at: clock.t,
      expires_at: clock.t + 60_000, // expires 60 s from now
    });

    const deps = makeBearerDeps(store, now);

    // Pre-expiry: works.
    const r1 = await validateBearer(
      makeMcpRequest(`Bearer ${minted.plaintext}`),
      FAKE_ENV,
      deps,
    );
    expect(r1.ok).toBe(true);

    // Skip past expiry — clock advances 70 s; the where-clause filters out.
    clock.t += 70_000;
    const r2 = await validateBearer(
      makeMcpRequest(`Bearer ${minted.plaintext}`),
      FAKE_ENV,
      deps,
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      // Single failure mode by design — RFC 6750 §3 invalid_token discipline
      // says we don't tell the caller WHY (revoked vs expired vs unknown).
      expect(r2.reason).toBe("pat-not-found");
      expect(r2.bearer_error).toBe("invalid_token");
    }
  });
});

// ---------------------------------------------------------------------------
// Owner isolation — cross-user revoke cannot touch foreign PATs
// ---------------------------------------------------------------------------

describe("PAT lifecycle — owner-only revoke", () => {
  it("revoke from a non-owner returns null and leaves the row active", async () => {
    const store = new InMemoryPatStore();
    const clock = { t: 1_740_000_000_000 };
    const now = () => clock.t;

    const minted = await mintPat(TEST_PEPPER);
    store.insert({
      id: "pat_id_alices_pat",
      user_id: "user_alice",
      label: "Alice's PAT",
      token_hash: minted.tokenHash,
      token_prefix: minted.tokenPrefix,
      token_suffix: minted.tokenSuffix,
      scopes: ["mcp:mailbox:read"],
      mailbox_id: null,
      ip_allowlist: null,
      created_at: clock.t,
      expires_at: null,
    });

    // Bob attempts to revoke Alice's PAT — info-non-disclosure:
    // returns null (404 at the route layer), no state change.
    expect(store.revoke("pat_id_alices_pat", "user_bob", clock.t)).toBeNull();

    // Bearer still works — the row was untouched.
    const r = await validateBearer(
      makeMcpRequest(`Bearer ${minted.plaintext}`),
      FAKE_ENV,
      makeBearerDeps(store, now),
    );
    expect(r.ok).toBe(true);
  });
});
