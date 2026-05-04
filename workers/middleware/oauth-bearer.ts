// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.2 (mcp-oauth) — Bearer-token validation for /mcp.
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
  | "missing-azp";

export interface BearerOk {
  ok: true;
  /** Synthetic short hash of the token (8 hex chars) — proxy for jti. */
  jti: string;
  user_id: string;
  client_id: string;
  scopes: string[];
  expires_at: number;
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
 * Validate the incoming /mcp request's bearer token.
 *
 * Returns a discriminated result the caller surfaces via
 * `bearerChallengeResponse(...)`. The caller is responsible for responding
 * with the challenge — this function is pure.
 */
export async function validateBearer(
  request: Request,
  env: Env,
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
    jti: await syntheticJti(token),
    user_id: payload.sub,
    client_id: azp,
    scopes,
    expires_at: typeof payload.exp === "number" ? payload.exp : 0,
  };
}
