// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.2 (mcp-oauth) — Bearer-token validation for /mcp.
// T3.3 (mcp-oauth) — Added PAT-by-hash fallback path.
//
// Strict-MUSTs (research §2.1, action-plan-mail-actionnowai-mcp-oauth.md):
//   - WWW-Authenticate: Bearer realm="mcp", resource_metadata="..." on 401.
//   - aud == https://mail.actionnow.ai/mcp, exact-string match (single string,
//     NOT an array — array-aud is the openid-leak signature flagged by
//     T1.1 finding B and explicitly rejected by D-mcp-auth-5).
//   - iss == https://mail.actionnow.ai (baseURL).
//   - At least one mcp:* scope present. Per-tool scope checks live in
//     workers/lib/mcp-tool-policy.ts and are wired at workers/app.ts:
//     dispatchMcpRequest (T3.6, security audit Phase 4, 2026-05-06).
//   - Bearer-only on /mcp. Session cookies (`__Host-anai.session_token`) are
//     rejected outright per D-mcp-auth anti-pattern `0olzaspBOKxkzjp2AZRkV`.
//
// Bearer dispatch (T3.3):
//   - Tokens prefixed `pat_` route to the PAT path: HMAC-SHA-256 hash with
//     env.TOKEN_PEPPER → `getActivePatByHash` → mcp:* scope check → succeed
//     with `source="pat"`. `last_used_at` is updated fire-and-forget via
//     ctx.waitUntil when an ExecutionContext is supplied; otherwise awaited
//     inline (test-friendly).
//   - Anything else routes to the JWT path (existing logic).
//   - The two surfaces are non-overlapping by construction: PATs are
//     `pat_<base64url>` (no dots), JWTs are `<header>.<payload>.<signature>`
//     (mandatory dots). A token shape that satisfies neither falls through
//     the JWT path's existing `verify-failed` rejection.
//
// JWT shape (verified against `node_modules/@better-auth/oauth-provider/dist/index.mjs:320–344`):
//   sub:   user.id
//   aud:   "https://mail.actionnow.ai/mcp"  (single string when scopes omit openid)
//   azp:   client_id
//   scope: space-separated scope list
//   iss:   "https://mail.actionnow.ai"
//   iat / exp: unix seconds
//   jti:   ABSENT (signJWT only sets it when payload.jti is provided; it isn't).
//          We compute a synthetic short hash of the token string for audit.

import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/control-plane/schema";
import {
  getActivePatByHash,
  touchPatLastUsedAt,
  type ActivePatRow,
} from "../db/queries/pats";
import { hashPat, PAT_PREFIX } from "../lib/pat-tokens";
import type { Env } from "../types";
import { and, eq } from "drizzle-orm";

export const REQUIRED_AUDIENCE = "https://mail.actionnow.ai/mcp";
export const REQUIRED_ISSUER = "https://mail.actionnow.ai";
export const RESOURCE_METADATA_URL =
  "https://mail.actionnow.ai/.well-known/oauth-protected-resource";
export const SESSION_COOKIE_PREFIX = "__Host-anai.session_token";

export type BearerRejectReason =
  | "missing-bearer"
  | "session-cookie-on-mcp"
  | "malformed-token"
  | "verify-failed"
  | "wrong-issuer"
  | "wrong-audience"
  | "array-audience"
  | "no-mcp-scope"
  | "expired"
  | "missing-sub"
  | "missing-azp"
  // PAT path (T3.3)
  | "pat-not-found"
  | "pat-no-mcp-scope"
  // JWT revocation Path 2 (Phase C2 / TASK-C2.12, audit P1-1)
  | "grant-revoked";

/** Discriminator on a successful bearer validation. */
export type BearerSource = "jwt" | "pat";

export interface BearerOk {
  ok: true;
  /** "jwt" for OAuth access tokens; "pat" for hash-looked-up PATs. */
  source: BearerSource;
  /** Synthetic short hash of the token (8 hex chars) — proxy for jti. */
  jti: string;
  user_id: string;
  /** OAuth client_id for JWTs; "pat:<id>" for PATs (audit-row correlator). */
  client_id: string;
  scopes: string[];
  /** Unix seconds for JWTs; epoch ms (PAT.expires_at) for PATs; 0 if no expiry. */
  expires_at: number;
  /** Present when source === "pat". Caller wires per-row policy downstream. */
  pat_id?: string;
  /** Optional PAT mailbox scope. Enforced at workers/app.ts:dispatchMcpRequest
   *  via workers/lib/mcp-tool-policy.MAILBOX_BOUND_TOOLS (T3.6). */
  mailbox_id?: string | null;
  /** Optional PAT IP allowlist. Enforced at workers/app.ts:dispatchMcpRequest
   *  via workers/lib/mcp-tool-policy.isIpInAllowlist (T3.6). */
  ip_allowlist?: string[] | null;
}

export interface BearerErr {
  ok: false;
  reason: BearerRejectReason;
  /** RFC 6750 §3 error code, machine-readable; null for non-bearer issues. */
  bearer_error: "invalid_token" | "insufficient_scope" | null;
  /** Human-readable detail (debug only — never returned to clients verbatim). */
  detail?: string;
}

export type BearerResult = BearerOk | BearerErr;

/**
 * Build a 401 response with the spec-required `WWW-Authenticate` header.
 *
 * Per RFC 9728 §5.1 + Cloudflare's Securing-MCP-Servers guide §2.4, the
 * server MUST surface the resource-metadata URL so clients can discover the
 * authorization server without out-of-band configuration.
 */
export function bearerChallengeResponse(
  reason: BearerRejectReason,
  bearer_error: "invalid_token" | "insufficient_scope" | null,
): Response {
  const params: string[] = [
    'realm="mcp"',
    `resource_metadata="${RESOURCE_METADATA_URL}"`,
  ];
  if (bearer_error) {
    params.push(`error="${bearer_error}"`);
    params.push(`error_description="${reason}"`);
  }
  return new Response(
    JSON.stringify({ error: bearer_error ?? "unauthorized", reason }),
    {
      status: bearer_error === "insufficient_scope" ? 403 : 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer ${params.join(", ")}`,
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * Parse the static signing key from `env.OAUTH_JWT_SIGNING_KEY` and build a
 * jose JWKSet usable for verification. Mirrors the parsing path in
 * `workers/auth/index.ts:loadStaticSigningKey` but consumes the public half.
 */
function loadVerificationJwks(env: Env): ReturnType<typeof createLocalJWKSet> {
  const raw = env.OAUTH_JWT_SIGNING_KEY;
  if (!raw) {
    throw new Error(
      "OAUTH_JWT_SIGNING_KEY missing — cannot verify /mcp bearer",
    );
  }
  const wrapper = JSON.parse(raw) as {
    kid: string;
    alg: "EdDSA";
    crv: "Ed25519";
    publicJwk: Record<string, string>;
  };
  return createLocalJWKSet({
    keys: [
      {
        ...wrapper.publicJwk,
        kid: wrapper.kid,
        alg: wrapper.alg,
        use: "sig",
      },
    ],
  });
}

/**
 * Cache the JWKS by a hash of the signing-key string so a key rotation
 * automatically invalidates the cache.
 *
 * Phase C3 / TASK-C3.10 — A-10 fix. The previous implementation keyed on
 * `WeakMap<Env>` identity, which is per-isolate and never invalidates when
 * the operator rotates `OAUTH_JWT_SIGNING_KEY` via `wrangler secret put`.
 * After a rotation the next /mcp request would read the new env var, recompute
 * the JWKS, and overwrite the cache entry — but on a long-lived isolate the
 * old `Env` reference (with the new value) would still match the WeakMap
 * entry that was populated under the OLD key, so we'd verify against stale
 * material until the isolate cycled. Switching the cache key to a digest of
 * the raw secret means a rotation is observed immediately on the next
 * request: a different secret hashes to a different cache key, so the old
 * entry is dead and the new one is computed once.
 *
 * The cache is bounded to one entry per active key (and at most a handful of
 * stale entries during the brief overlap of a rotation, garbage-collected on
 * the next eviction pass below) so the unbounded-growth risk is nil.
 */
type JwksCacheEntry = {
  hash: string;
  jwks: ReturnType<typeof createLocalJWKSet>;
};
let jwksCacheEntry: JwksCacheEntry | null = null;

async function hashSigningKey(raw: string): Promise<string> {
  const buf = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getJwks(
  env: Env,
): Promise<ReturnType<typeof createLocalJWKSet>> {
  const raw = env.OAUTH_JWT_SIGNING_KEY;
  if (!raw) {
    throw new Error(
      "OAUTH_JWT_SIGNING_KEY missing — cannot verify /mcp bearer",
    );
  }
  const hash = await hashSigningKey(raw);
  if (jwksCacheEntry && jwksCacheEntry.hash === hash) {
    return jwksCacheEntry.jwks;
  }
  const fresh = loadVerificationJwks(env);
  jwksCacheEntry = { hash, jwks: fresh };
  return fresh;
}

/**
 * Test-only escape hatch — clear the in-process JWKS cache so consecutive
 * tests can rotate the signing key without leaking state across `it()`
 * blocks. Production code must NEVER call this.
 */
export function __clearJwksCacheForTests(): void {
  jwksCacheEntry = null;
}

/**
 * Synthetic 16-char hex jti from a token string (audit-only correlator).
 *
 * Phase C2 / A-08: widened from 8 hex chars (32-bit) to 16 hex chars
 * (64-bit). At 8 hex chars the birthday-collision probability hits ~50%
 * around 65k tokens; at 16 hex chars it's negligible across the full
 * audit_log lifetime. We can't mint a real jti at sign time without
 * forking better-auth's `signJWT`, so a wider hash gives the same
 * audit-correlation guarantee without changing the JWT shape.
 */
async function syntheticJti(token: string): Promise<string> {
  const buf = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Optional dependency injection for testability and side-effect routing.
 *
 * Production wiring uses the defaults (real D1 ORM via `drizzle(env.DB)`).
 * Tests inject in-memory stubs for `lookupPatByHash` + `touchPatLastUsed`
 * to exercise the PAT path without spinning up a D1 fixture.
 *
 * `ctx.waitUntil` is honored when present so the `last_used_at` write
 * doesn't block the /mcp response. Without `ctx`, the touch is awaited
 * inline (deterministic for tests).
 */
export interface BearerDeps {
  lookupPatByHash?: (
    env: Env,
    hash: string,
    now: number,
  ) => Promise<ActivePatRow | null>;
  touchPatLastUsed?: (env: Env, patId: string, now: number) => Promise<void>;
  /**
   * Phase C2 / TASK-C2.12: tombstone lookup for the JWT revocation Path 2.
   * Returns the most-recent `revoked_at` (epoch ms) for `(userId, clientId)`,
   * or null when no tombstone exists. The bearer middleware rejects JWTs
   * whose `iat * 1000` is at or below `revoked_at`.
   */
  lookupGrantTombstone?: (
    env: Env,
    userId: string,
    clientId: string,
  ) => Promise<number | null>;
  now?: () => number;
  ctx?: { waitUntil(p: Promise<unknown>): void };
}

async function defaultLookupPatByHash(
  env: Env,
  hash: string,
  now: number,
): Promise<ActivePatRow | null> {
  const orm = drizzle(env.DB, { schema });
  return getActivePatByHash(orm, hash, now);
}

async function defaultTouchPatLastUsed(
  env: Env,
  patId: string,
  now: number,
): Promise<void> {
  const orm = drizzle(env.DB, { schema });
  await touchPatLastUsedAt(orm, patId, now);
}

/**
 * Phase C2 / TASK-C2.12 default tombstone lookup. One PK-indexed lookup
 * per /mcp request; the table is keyed (user_id, client_id) PRIMARY KEY
 * so this is a point read.
 *
 * Returns null when env.DB is not a real D1Database (test stubs that pass
 * an empty {} object) — keeps the existing happy-path / rejection-path
 * tests working without each one having to inject `lookupGrantTombstone`
 * via deps. In production env.DB is always real, so the guard is a
 * test-only escape hatch, not a security carve-out.
 */
async function defaultLookupGrantTombstone(
  env: Env,
  userId: string,
  clientId: string,
): Promise<number | null> {
  if (typeof env.DB?.prepare !== "function") return null;
  const orm = drizzle(env.DB, { schema });
  const row = await orm
    .select({ revoked_at: schema.oauth_grant_tombstone.revoked_at })
    .from(schema.oauth_grant_tombstone)
    .where(
      and(
        eq(schema.oauth_grant_tombstone.user_id, userId),
        eq(schema.oauth_grant_tombstone.client_id, clientId),
      ),
    )
    .get();
  return row ? Number(row.revoked_at) : null;
}

/**
 * Validate an incoming PAT bearer (T3.3).
 *
 * Pre-conditions: caller has already verified the token has the `pat_`
 * prefix and stripped the `Bearer ` scheme. Returns a discriminated
 * BearerResult; the caller surfaces failures via `bearerChallengeResponse`.
 *
 * Side effects: on success, schedules a `last_used_at` update via
 * `ctx.waitUntil` (if provided) or awaits it inline. Failures of the touch
 * write are logged and swallowed — they MUST NOT invalidate the bearer.
 */
async function validatePatBearer(
  token: string,
  env: Env,
  deps: BearerDeps,
): Promise<BearerResult> {
  // Mirror T3.1's `routes/pats.ts`: both surfaces MUST throw when
  // TOKEN_PEPPER is unset — fail-closed. A misdeploy that loses the secret
  // surfaces as a 500, not as silent degradation to a known-bad pepper.
  const pepper = env.TOKEN_PEPPER;
  if (!pepper) {
    throw new Error(
      "TOKEN_PEPPER must be set as a Worker secret in production",
    );
  }

  const now = (deps.now ?? Date.now)();
  const hash = await hashPat(token, pepper);
  const lookup = deps.lookupPatByHash ?? defaultLookupPatByHash;
  const pat = await lookup(env, hash, now);

  // Single failure mode — "no active row matched". Covers unknown hash,
  // revoked, and expired uniformly so the /mcp surface never leaks which
  // class of failure occurred (RFC 6750 §3 invalid_token discipline).
  if (!pat) {
    return {
      ok: false,
      reason: "pat-not-found",
      bearer_error: "invalid_token",
    };
  }

  if (!pat.scopes.some((s) => s.startsWith("mcp:"))) {
    return {
      ok: false,
      reason: "pat-no-mcp-scope",
      bearer_error: "insufficient_scope",
      detail: `scopes=${pat.scopes.join(",")}`,
    };
  }

  // Fire-and-forget: never block the /mcp response on the touch write.
  const touch = deps.touchPatLastUsed ?? defaultTouchPatLastUsed;
  const touchPromise = touch(env, pat.id, now).catch((e) => {
    console.error("mcp.pat.touch_failed", (e as Error).message);
  });
  if (deps.ctx) {
    deps.ctx.waitUntil(touchPromise);
  } else {
    await touchPromise;
  }

  return {
    ok: true,
    source: "pat",
    jti: await syntheticJti(token),
    user_id: pat.user_id,
    client_id: `pat:${pat.id}`,
    scopes: pat.scopes,
    expires_at: pat.expires_at ?? 0,
    pat_id: pat.id,
    mailbox_id: pat.mailbox_id,
    ip_allowlist: pat.ip_allowlist,
  };
}

/**
 * Validate the incoming /mcp request's bearer token.
 *
 * Returns a discriminated result the caller surfaces via
 * `bearerChallengeResponse(...)`. The caller is responsible for responding
 * with the challenge — this function is pure for the JWT path; the PAT
 * path issues a fire-and-forget `last_used_at` write (see BearerDeps).
 *
 * Dispatch by prefix: `pat_*` → PAT-by-hash; otherwise → JWT verify.
 */
export async function validateBearer(
  request: Request,
  env: Env,
  deps: BearerDeps = {},
): Promise<BearerResult> {
  // Anti-pattern guard: session cookies on /mcp are forbidden (D-mcp-auth
  // anti-pattern 0olzaspBOKxkzjp2AZRkV — bearer-only on /mcp).
  const cookieHeader = request.headers.get("cookie") ?? "";
  if (
    cookieHeader.split(/;\s*/).some((c) => c.startsWith(SESSION_COOKIE_PREFIX))
  ) {
    return {
      ok: false,
      reason: "session-cookie-on-mcp",
      bearer_error: "invalid_token",
      detail: "Session cookies must not authenticate /mcp",
    };
  }

  const auth = request.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return {
      ok: false,
      reason: "missing-bearer",
      bearer_error: "invalid_token",
    };
  }
  const token = auth.slice(7).trim();
  if (!token) {
    return {
      ok: false,
      reason: "missing-bearer",
      bearer_error: "invalid_token",
    };
  }

  // T3.3 — PAT-by-hash dispatch. PATs are `pat_<base64url>` (no dots),
  // structurally distinct from JWTs (`<header>.<payload>.<signature>`), so
  // the prefix is a reliable router. Tokens that match neither shape fall
  // through the JWT path's `verify-failed` rejection.
  if (token.startsWith(PAT_PREFIX)) {
    return validatePatBearer(token, env, deps);
  }

  let payload: JWTPayload;
  try {
    const jwks = await getJwks(env);
    const verified = await jwtVerify(token, jwks, {
      issuer: REQUIRED_ISSUER,
      // Phase C3 / TASK-C3.11 (A-09) — pin the algorithm. Without this jose
      // accepts any algorithm signed by a key in the JWKS; an attacker who
      // can substitute a JWKS entry for a different alg (e.g. HS256 with a
      // shared secret leaked elsewhere) would otherwise verify successfully.
      // Our better-auth oauth-provider only ever issues EdDSA tokens (Ed25519
      // per `node_modules/@better-auth/oauth-provider/dist/index.mjs`), so
      // anything else is a forgery attempt.
      algorithms: ["EdDSA"],
      // Do NOT pass `audience:` here — jose's audience match accepts arrays
      // and intersects on membership, which is exactly the leniency we want
      // to reject. We enforce exact-string match below.
    });
    payload = verified.payload;
  } catch (e) {
    // jose attaches a stable `code` to its error subclasses — much more
    // reliable than message regex (the human-readable text varies per jose
    // version). See `node_modules/jose/dist/util/errors.*` for the full list.
    const err = e as { code?: string; claim?: string; message?: string };
    if (err.code === "ERR_JWT_EXPIRED") {
      return {
        ok: false,
        reason: "expired",
        bearer_error: "invalid_token",
        detail: err.message,
      };
    }
    if (err.code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && err.claim === "iss") {
      return {
        ok: false,
        reason: "wrong-issuer",
        bearer_error: "invalid_token",
        detail: err.message,
      };
    }
    return {
      ok: false,
      reason: "verify-failed",
      bearer_error: "invalid_token",
      detail: err.message,
    };
  }

  if (!payload.aud) {
    return {
      ok: false,
      reason: "wrong-audience",
      bearer_error: "invalid_token",
    };
  }
  if (Array.isArray(payload.aud)) {
    return {
      ok: false,
      reason: "array-audience",
      bearer_error: "invalid_token",
      detail: "aud must be a single string; openid scope leak rejected",
    };
  }
  if (payload.aud !== REQUIRED_AUDIENCE) {
    return {
      ok: false,
      reason: "wrong-audience",
      bearer_error: "invalid_token",
      detail: `aud=${payload.aud}`,
    };
  }

  if (typeof payload.sub !== "string" || !payload.sub) {
    return { ok: false, reason: "missing-sub", bearer_error: "invalid_token" };
  }

  // azp (authorized party) carries the OAuth client_id. The plugin always
  // sets it — its absence indicates a token from a different issuer.
  const azp = (payload as { azp?: unknown }).azp;
  if (typeof azp !== "string" || !azp) {
    return { ok: false, reason: "missing-azp", bearer_error: "invalid_token" };
  }

  const scopeStr = typeof payload.scope === "string" ? payload.scope : "";
  const scopes = scopeStr.split(/\s+/).filter(Boolean);
  if (!scopes.some((s) => s.startsWith("mcp:"))) {
    return {
      ok: false,
      reason: "no-mcp-scope",
      bearer_error: "insufficient_scope",
      detail: `scope=${scopeStr}`,
    };
  }

  // Phase C2 / TASK-C2.12 — JWT revocation Path 2 (audit P1-1).
  //
  // The grant-tombstone read closes the window between "user revoked the
  // grant" and "the still-valid JWT expires". oauth_grant_tombstone is
  // populated atomically by revokeAgentAuthorization (workers/db/queries/
  // grants.ts) inside the same d1.batch that deletes the consent + tokens.
  // We compare `bearer.iat * 1000 <= revoked_at`: a token issued at or
  // before the revoke moment is rejected; one issued after a previous
  // revoke (i.e., the user re-granted, then a fresh JWT was minted) is
  // honoured because revoked_at moves forward on each revoke (ON CONFLICT
  // DO UPDATE in the migration).
  //
  // Cost: one PK lookup per /mcp request. Negligible vs the JWKS verify.
  if (typeof payload.iat === "number") {
    const lookupTombstone =
      deps.lookupGrantTombstone ?? defaultLookupGrantTombstone;
    const revokedAtMs = await lookupTombstone(env, payload.sub, azp);
    if (revokedAtMs !== null && payload.iat * 1000 <= revokedAtMs) {
      return {
        ok: false,
        reason: "grant-revoked",
        bearer_error: "invalid_token",
        detail: `iat=${payload.iat}; revoked_at=${revokedAtMs}`,
      };
    }
  }

  return {
    ok: true,
    source: "jwt",
    jti: await syntheticJti(token),
    user_id: payload.sub,
    client_id: azp,
    scopes,
    expires_at: typeof payload.exp === "number" ? payload.exp : 0,
  };
}
