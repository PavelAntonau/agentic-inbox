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
//   - At least one mcp:* scope present. Per-tool scope checks live downstream
//     (TODO(T3.6): wire per-tool scope-to-required map at the dispatch layer).
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
  | "pat-no-mcp-scope";

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
  /** Optional PAT mailbox scope. T3.6 enforces; surfaced here for audit. */
  mailbox_id?: string | null;
  /** Optional PAT IP allowlist. T3.6 enforces; surfaced here for audit. */
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

/** Cache the JWKS per (env, raw-key) so cold-start cost only hits once. */
const jwksCache = new WeakMap<Env, ReturnType<typeof createLocalJWKSet>>();
function getJwks(env: Env): ReturnType<typeof createLocalJWKSet> {
  const cached = jwksCache.get(env);
  if (cached) return cached;
  const fresh = loadVerificationJwks(env);
  jwksCache.set(env, fresh);
  return fresh;
}

/** Synthetic 8-char hex jti from a token string (audit-only correlator). */
async function syntheticJti(token: string): Promise<string> {
  const buf = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash).slice(0, 4))
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
    const jwks = getJwks(env);
    const verified = await jwtVerify(token, jwks, {
      issuer: REQUIRED_ISSUER,
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
