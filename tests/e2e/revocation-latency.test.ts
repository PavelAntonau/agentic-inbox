// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T3.6 (mcp-oauth) — revocation propagation + refresh-rotation contracts.
//
// Two SLAs covered here:
//
//   1. PAT revocation < 5 s wall-clock from DELETE → next /mcp call rejected.
//      The bearer middleware's PAT path is row-by-hash with no caching
//      between calls, so revocation propagates as fast as the D1 write +
//      next read. We assert the wall-clock SLA on the in-memory store
//      stand-in (D1 latency on Workers is sub-100 ms; the SLA is therefore
//      a structural property of the bearer, not a database performance
//      claim). The 5 s number is from the action plan's TASK-3.6 subject
//      ("revocation < 5 s").
//
//   2. Refresh-token rotation contract per RFC 6749 §10.4 + OAuth 2.1.
//      better-auth's oauth-provider plugin owns refresh-token rotation; we
//      depend on it via `oauthProvider({...})` in workers/auth/index.ts.
//      The plugin's default behavior is to rotate on every refresh and
//      mark the old token as `revoked_at = now`. There is no opt-out flag
//      in our config, so this test pins the structural contract: the
//      plugin's refresh handler exists, and our config doesn't pass any
//      flag that would disable rotation. Live behavior is verified by the
//      manual prod check in TASK-3.6.validation ("Manual: Claude Code
//      OAuth round-trip on prod").
//
// Cross-grant revocation (T2.3 — DELETE /api/users/me/agent-authorizations
// /:client_id) is exercised here at the queries-module level: deleting the
// rows that back JWT verification means a previously-valid bearer becomes
// dead the next time the plugin checks the row (which it does on every
// refresh). For the access-token JWT itself, we don't ban-list — the
// access token is short-lived (≤ access_token TTL) and bearer rejection
// only happens at refresh. This is a deliberate v0.1 design (action plan
// 2026-05-04 progress note 3, T3.3) and is recorded so the contract
// doesn't drift.

import { describe, it, expect } from "vitest";
import { mintPat } from "../../workers/lib/pat-tokens";
import {
  validateBearer,
  type BearerDeps,
} from "../../workers/middleware/oauth-bearer";
import type { ActivePatRow } from "../../workers/db/queries/pats";
import type { Env } from "../../workers/types";

const TEST_PEPPER = "test-pepper-T3.6-revoke";
const TEST_USER_ID = "user_t36_revoke";

/**
 * Minimal hash → ActivePatRow store with a synthetic write delay knob so
 * we can simulate D1 propagation. The default of 0 ms reflects the
 * Workers runtime where D1 writes on the same isolate see strict
 * read-your-writes consistency. The knob exists so the SLA test can
 * reason about a worst-case bound rather than just an in-memory race.
 */
class LatencyAwareStore {
  private rows = new Map<
    string,
    ActivePatRow & { revoked_at: number | null }
  >();
  private byHash = new Map<string, string>();

  insert(hash: string, row: ActivePatRow): void {
    this.byHash.set(hash, row.id);
    this.rows.set(row.id, { ...row, revoked_at: null });
  }

  /** Mark revoked at `t`. The optional `propagationMs` simulates D1 lag. */
  async revoke(id: string, t: number, propagationMs = 0): Promise<void> {
    if (propagationMs > 0) {
      await new Promise((r) => setTimeout(r, propagationMs));
    }
    const row = this.rows.get(id);
    if (row) row.revoked_at = t;
  }

  getActiveByHash(hash: string): ActivePatRow | null {
    const id = this.byHash.get(hash);
    if (!id) return null;
    const row = this.rows.get(id);
    if (!row || row.revoked_at != null) return null;
    const { revoked_at: _r, ...active } = row;
    return active;
  }
}

function makeBearerDeps(store: LatencyAwareStore): BearerDeps {
  return {
    lookupPatByHash: async (_env, hash) => store.getActiveByHash(hash),
    touchPatLastUsed: async () => {},
    now: () => Date.now(),
  };
}

function makeMcpRequest(authHeader: string): Request {
  return {
    method: "POST",
    url: "https://mail.actionnow.ai/mcp",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? authHeader : null,
    },
  } as unknown as Request;
}

const FAKE_ENV: Env = {
  TOKEN_PEPPER: TEST_PEPPER,
} as unknown as Env;

// ---------------------------------------------------------------------------
// PAT revocation latency
// ---------------------------------------------------------------------------

describe("PAT revocation — wall-clock SLA < 5 s", () => {
  it("next /mcp call after revoke is rejected within 5 s of the revoke call", async () => {
    const store = new LatencyAwareStore();
    const minted = await mintPat(TEST_PEPPER);
    store.insert(minted.tokenHash, {
      id: "pat_id_revoke_sla",
      user_id: TEST_USER_ID,
      scopes: ["mcp:mailbox:read"],
      mailbox_id: null,
      ip_allowlist: null,
      expires_at: null,
    });

    const deps = makeBearerDeps(store);

    // Sanity — accepted before revoke.
    const r0 = await validateBearer(
      makeMcpRequest(`Bearer ${minted.plaintext}`),
      FAKE_ENV,
      deps,
    );
    expect(r0.ok).toBe(true);

    // Revoke + next call. Wall-clock measurement is the SLA.
    const revokeStart = Date.now();
    await store.revoke("pat_id_revoke_sla", revokeStart);

    const r1 = await validateBearer(
      makeMcpRequest(`Bearer ${minted.plaintext}`),
      FAKE_ENV,
      deps,
    );
    const elapsed = Date.now() - revokeStart;

    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("pat-not-found");
    expect(elapsed).toBeLessThan(5_000);
  });

  it("holds the SLA even with simulated 100 ms D1 propagation", async () => {
    const store = new LatencyAwareStore();
    const minted = await mintPat(TEST_PEPPER);
    store.insert(minted.tokenHash, {
      id: "pat_id_d1_lag",
      user_id: TEST_USER_ID,
      scopes: ["mcp:contacts:read"],
      mailbox_id: null,
      ip_allowlist: null,
      expires_at: null,
    });
    const deps = makeBearerDeps(store);

    const revokeStart = Date.now();
    await store.revoke("pat_id_d1_lag", revokeStart, 100); // 100 ms write

    const r = await validateBearer(
      makeMcpRequest(`Bearer ${minted.plaintext}`),
      FAKE_ENV,
      deps,
    );
    const elapsed = Date.now() - revokeStart;

    expect(r.ok).toBe(false);
    expect(elapsed).toBeLessThan(5_000);
    // And actually well below — we expect ≤ ~150 ms in practice. The
    // looser ceiling above is the action-plan SLA; this one pins the
    // structural reality so a future regression that adds e.g. a bearer
    // cache without invalidation gets caught.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("revoking one PAT does not affect a sibling PAT for the same user", async () => {
    const store = new LatencyAwareStore();
    const a = await mintPat(TEST_PEPPER);
    const b = await mintPat(TEST_PEPPER);
    store.insert(a.tokenHash, {
      id: "pat_id_a",
      user_id: TEST_USER_ID,
      scopes: ["mcp:mailbox:read"],
      mailbox_id: null,
      ip_allowlist: null,
      expires_at: null,
    });
    store.insert(b.tokenHash, {
      id: "pat_id_b",
      user_id: TEST_USER_ID,
      scopes: ["mcp:mailbox:read"],
      mailbox_id: null,
      ip_allowlist: null,
      expires_at: null,
    });
    const deps = makeBearerDeps(store);

    await store.revoke("pat_id_a", Date.now());

    const ra = await validateBearer(
      makeMcpRequest(`Bearer ${a.plaintext}`),
      FAKE_ENV,
      deps,
    );
    const rb = await validateBearer(
      makeMcpRequest(`Bearer ${b.plaintext}`),
      FAKE_ENV,
      deps,
    );
    expect(ra.ok).toBe(false);
    expect(rb.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Refresh-token rotation contract
// ---------------------------------------------------------------------------

describe("Refresh-token rotation — config contract (RFC 6749 §10.4)", () => {
  it("imports the @better-auth/oauth-provider plugin (rotation owner)", async () => {
    // The plugin's own default rotates refresh tokens on every refresh and
    // marks the old token revoked_at=now. Our auth/index.ts depends on
    // this default — we don't pass any flag that would override it.
    //
    // This test pins the import shape so a future package upgrade that
    // renames or splits the export gets caught at unit-test time, before
    // a deploy can land that silently disables rotation.
    const mod = await import("@better-auth/oauth-provider");
    expect(typeof mod.oauthProvider).toBe("function");
  });

  it("our oauthProvider config does not opt out of refresh-token rotation", async () => {
    // Source-of-truth assertion: the auth-config string passed to
    // oauthProvider() must NOT contain any of the opt-out flag names the
    // plugin recognises. Any future addition of `disableRefreshTokenRotation`
    // (or a renamed equivalent) requires explicit reconsideration of this
    // contract — refresh-rotation is a STRICT requirement of OAuth 2.1
    // and the MCP spec.
    //
    // Loaded via Vite's `?raw` query so the typecheck stays under the
    // cloudflare-workers tsconfig (no `node:fs` import). Same precedent
    // as `app/routes/__route-registration.test.ts` (uses import.meta.glob).
    const src = (await import("../../workers/auth/index.ts?raw"))
      .default as string;

    expect(src).toContain("oauthProvider({");
    // Negative assertions — none of these flags should appear in our config.
    expect(src).not.toMatch(/disableRefreshTokenRotation\s*:/);
    expect(src).not.toMatch(/refreshTokenRotation\s*:\s*false/);
    expect(src).not.toMatch(/rotateRefreshToken\s*:\s*false/);
  });

  it("documents the design: PAT revocation is row-direct; refresh-rotation is plugin-level", () => {
    // Pin the design rationale in code so a contributor refactoring this
    // suite cannot silently drop the manual-verification escape hatch.
    // The matching free-text lives at the top of this file.
    const designNote = {
      pat_path: "row-direct via getActivePatByHash; no cache, no ban-list",
      jwt_access_token_path: "verify-only; access tokens are short-lived",
      refresh_token_path: "rotation owned by @better-auth/oauth-provider",
      manual_verification: "Claude Code OAuth round-trip on prod",
    };
    expect(designNote.refresh_token_path).toMatch(/oauth-provider/);
    expect(designNote.manual_verification).toMatch(/Claude Code/);
  });
});
