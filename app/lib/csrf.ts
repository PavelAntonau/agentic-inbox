// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.1 (mcp-oauth) — single-use CSRF for /consent.
//
// Design: stateless synchronizer-token pattern.
//
//   token = `${nonce}.${exp}.${b64url(HMAC-SHA-256(secret, "csrf-v1:${nonce}.${exp}.${userId}"))}`
//
//   - `nonce`  — 16 random bytes, hex-encoded (32 chars). Pure entropy.
//   - `exp`    — unix seconds when the token expires. Default 30 minutes.
//   - `userId` — the better-auth `session.user.id` of the issuing session.
//                Binding to user makes a stolen-token cross-user replay
//                impossible: the server re-derives the HMAC against the
//                CURRENT request's session.user.id and rejects on mismatch.
//
//   The HMAC input is prefixed with `csrf-v1:` so this token namespace is
//   permanently distinct from the better-auth oauth-provider's `signParams`
//   output (`utils.mjs:132`), which uses the same secret but a different
//   serialization. Cross-protocol confusion attacks against `verifyOAuthQueryParams`
//   are therefore structurally ruled out.
//
// Cookie shape: `__Host-CSRF_TOKEN=<token>; HttpOnly; Secure; SameSite=Lax;
// Path=/; Max-Age=1800`. The `__Host-` prefix is non-negotiable per CF
// Securing-MCP-Servers guide §1.1 — it forbids any Domain attribute and
// REQUIRES Secure + Path=/, all enforced by the browser. SameSite=Lax
// (rather than Strict) is intentional: the consent flow lands here from
// a top-level navigation triggered by the OAuth client's redirect, and
// Strict would drop the cookie on that initial GET. Lax is the right
// "no third-party cross-site posting" boundary for a top-level UX.
//
// Single-use: the action handler verifies the token, then unconditionally
// emits a `__Host-CSRF_TOKEN=; Max-Age=0` Set-Cookie on its response. The
// next consent attempt reissues a fresh token via the loader. Replays
// against the just-burned cookie fail because the cookie is gone.
//
// This module is the single surface for CSRF in this codebase. Reach for
// `issueCsrfToken` from a loader; `verifyCsrfFromRequest` + `burnCsrfCookie`
// from an action.

export const CSRF_COOKIE_NAME = "__Host-CSRF_TOKEN";

/** Form field name for the synchronizer token. */
export const CSRF_FORM_FIELD = "csrf_token";

/** Default token lifetime in seconds. 30 minutes. */
const DEFAULT_TTL_SEC = 30 * 60;

/** HMAC input domain separator. Keeps this token namespace distinct from
 *  better-auth's `signParams` and any other consumer of the same secret. */
const HMAC_DOMAIN = "csrf-v1:";

const NONCE_BYTES = 16;

/* -------------------------------------------------------------------------- */
/* Encoding helpers                                                           */
/* -------------------------------------------------------------------------- */

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa → base64 → strip padding, swap +/ for -_ (RFC 4648 §5).
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Encode a string as UTF-8 bytes. The cast pins the buffer type to
 *  `ArrayBuffer` (not `ArrayBufferLike`) so the result satisfies the
 *  Workers `BufferSource` constraint without runtime overhead. */
function utf8(input: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(input) as Uint8Array<ArrayBuffer>;
}

/* -------------------------------------------------------------------------- */
/* HMAC                                                                       */
/* -------------------------------------------------------------------------- */

async function hmacSha256B64Url(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, utf8(message));
  return bytesToBase64Url(new Uint8Array(sig));
}

/** Constant-time string compare for two strings of equal length. Returns
 *  `false` immediately when lengths differ — that's a structural mismatch
 *  the attacker can already see, not a secret-dependent timing leak. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface CsrfIssue {
  /** Token to embed as a hidden form field on the consent page. */
  token: string;
  /** `Set-Cookie` header value. Caller appends to the loader's Response. */
  cookie: string;
  /** Unix-seconds expiry. Surfaced for diagnostics and tests; not needed by callers. */
  exp: number;
}

export interface IssueOptions {
  /** Override the lifetime (seconds). Defaults to 1800 s = 30 min. */
  ttlSec?: number;
  /** Override the clock for tests. Defaults to `Date.now() / 1000`. */
  nowSec?: () => number;
}

/**
 * Issue a single-use CSRF token bound to `userId`.
 *
 * Returns the token (to embed in the form) and a `Set-Cookie` header value
 * (to attach to the loader's Response). The token is bound to `userId` via
 * HMAC, so a token issued to user A is structurally invalid for user B.
 *
 * The cookie is `HttpOnly` — JavaScript on the consent page CANNOT read it.
 * That's by design: the server-rendered loader embeds the matching token
 * in the form. The synchronizer pattern works without ever exposing the
 * cookie value to the page's runtime.
 */
export async function issueCsrfToken(
  secret: string,
  userId: string,
  opts: IssueOptions = {},
): Promise<CsrfIssue> {
  if (!secret) throw new Error("issueCsrfToken: secret is required");
  if (!userId) throw new Error("issueCsrfToken: userId is required");

  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const ttl = opts.ttlSec ?? DEFAULT_TTL_SEC;
  if (ttl <= 0) throw new Error("issueCsrfToken: ttlSec must be positive");

  const exp = nowSec() + ttl;

  const nonceBytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const nonce = bytesToHex(nonceBytes);

  const sig = await hmacSha256B64Url(
    secret,
    `${HMAC_DOMAIN}${nonce}.${exp}.${userId}`,
  );
  const token = `${nonce}.${exp}.${sig}`;

  // __Host- prefix REQUIRES: no Domain, Path=/, Secure. SameSite=Lax allows
  // the top-level OAuth redirect from the client to keep the cookie. HttpOnly
  // means JS on the consent page cannot read this — server-rendered hidden
  // input carries the matching value.
  const cookie =
    `${CSRF_COOKIE_NAME}=${token}` +
    `; Path=/` +
    `; Max-Age=${ttl}` +
    `; HttpOnly` +
    `; Secure` +
    `; SameSite=Lax`;

  return { token, cookie, exp };
}

/**
 * Burn the CSRF cookie. Returns a `Set-Cookie` header value that clears
 * `__Host-CSRF_TOKEN`. Always emit this on the action's response — both
 * on success and on rejection — so a replayed action sees no cookie at all.
 */
export function burnCsrfCookie(): string {
  return (
    `${CSRF_COOKIE_NAME}=` +
    `; Path=/` +
    `; Max-Age=0` +
    `; HttpOnly` +
    `; Secure` +
    `; SameSite=Lax`
  );
}

export interface VerifyOptions {
  /** Override the clock for tests. */
  nowSec?: () => number;
}

/**
 * Verify a token against the user-bound HMAC and the expiration.
 *
 * Returns `true` IFF:
 *   - the token parses as `nonce.exp.sig`;
 *   - `exp` is a finite integer in the future;
 *   - the HMAC re-derived against (nonce, exp, userId, secret) matches the
 *     supplied `sig` in constant time.
 *
 * This DOES NOT compare against a cookie value. The synchronizer-token
 * check (cookie value === form value) is a separate, cheaper test the
 * caller MUST perform before invoking this — see `verifyCsrfFromRequest`.
 */
export async function verifyCsrfToken(
  token: string,
  secret: string,
  userId: string,
  opts: VerifyOptions = {},
): Promise<boolean> {
  if (!token || !secret || !userId) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [nonce, expStr, sig] = parts;
  if (!nonce || !expStr || !sig) return false;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || !Number.isInteger(exp)) return false;

  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  if (exp <= nowSec()) return false;

  const expected = await hmacSha256B64Url(
    secret,
    `${HMAC_DOMAIN}${nonce}.${exp}.${userId}`,
  );
  return constantTimeEqual(sig, expected);
}

/**
 * Read the `__Host-CSRF_TOKEN` value from a `Cookie` header string, or
 * `null` when absent / malformed. Cookie parsing is intentionally minimal
 * — we look for our exact name; we don't honor `Cookie2` / quoted-string
 * RFC 6265 oddities that don't appear in browser-emitted Cookie headers.
 */
export function readCsrfCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === CSRF_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * One-shot CSRF check for an action handler.
 *
 * Reads the cookie + the `csrf_token` field, asserts they are equal in
 * constant time (synchronizer-token check), then re-verifies the HMAC
 * against `userId` (binding check). Returns `true` IFF both gates pass.
 *
 * Caller MUST burn the cookie via `burnCsrfCookie()` regardless of the
 * outcome — even on rejection, so a replay of the same form does not
 * find a still-valid cookie sitting on the client.
 */
export async function verifyCsrfFromRequest(
  request: Request,
  formToken: string | null | undefined,
  secret: string,
  userId: string,
  opts: VerifyOptions = {},
): Promise<boolean> {
  const cookieToken = readCsrfCookie(request.headers.get("cookie"));
  if (!cookieToken || !formToken) return false;
  if (!constantTimeEqual(cookieToken, formToken)) return false;
  return verifyCsrfToken(cookieToken, secret, userId, opts);
}
