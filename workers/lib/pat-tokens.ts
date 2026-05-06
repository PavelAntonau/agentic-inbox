// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/lib/pat-tokens.ts — Personal Access Token (PAT) primitives.
//
// Display-once flow (D-mcp-auth-2 / vWFkejELcRde8VOSt6ZwG):
//   * `generatePat()` mints a fresh `pat_<base64url(32 bytes)>` token.
//   * `hashPat(plaintext, pepper)` HMAC-SHA-256s the plaintext with the
//     server-side TOKEN_PEPPER, returns the hex digest stored in
//     `oauth_personal_access_token.token_hash`.
//   * `tokenPrefix` / `tokenSuffix` are 4-char display tags persisted alongside
//     the hash; the full token is unrecoverable from the row.
//
// T3.1 owns the create/list/revoke routes; T3.3 reuses `hashPat` from the
// bearer middleware to look up presented bearer tokens by hash.

/** Token prefix shipped on every PAT plaintext. */
export const PAT_PREFIX = "pat_";

/** Length of token_prefix / token_suffix display tags. */
export const PAT_TAG_LEN = 4;

/**
 * Mint a fresh PAT plaintext. Format: `pat_<base64url(32 bytes)>`.
 * 256 bits of randomness → infeasible to brute-force in any setting.
 *
 * `crypto.getRandomValues` is the standard Workers entropy source.
 */
export function generatePat(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return PAT_PREFIX + base64UrlEncode(bytes);
}

/**
 * HMAC-SHA-256 the plaintext with `pepper`. Returns the hex digest.
 *
 * Same construction as `workers/routes/tokens.ts`'s `hashSecret` so the two
 * surfaces share threat-model assumptions: an adversary with read-only D1
 * access cannot recover plaintext tokens; an adversary with the secrets store
 * can.
 */
export async function hashPat(
  plaintext: string,
  pepper: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(plaintext));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Display tags. `tokenPrefix(plaintext)` returns the 4 characters AFTER the
 * `pat_` prefix; `tokenSuffix(plaintext)` returns the last 4 characters of
 * the entire token. These are stored on the row so list responses can render
 * `pat_xyzw…abcd` without ever holding the full token.
 */
export function tokenPrefix(plaintext: string): string {
  if (!plaintext.startsWith(PAT_PREFIX)) {
    throw new Error("PAT plaintext must start with the pat_ prefix");
  }
  return plaintext.slice(PAT_PREFIX.length, PAT_PREFIX.length + PAT_TAG_LEN);
}

export function tokenSuffix(plaintext: string): string {
  if (plaintext.length < PAT_TAG_LEN) {
    throw new Error("PAT plaintext too short to take a suffix");
  }
  return plaintext.slice(-PAT_TAG_LEN);
}

/**
 * Mint a complete PAT record. Returns the plaintext (display-once) plus the
 * persisted columns (hash + prefix/suffix). Callers persist everything except
 * the plaintext.
 */
export async function mintPat(pepper: string): Promise<{
  plaintext: string;
  tokenHash: string;
  tokenPrefix: string;
  tokenSuffix: string;
}> {
  // Phase C3 / C3.25 BUG: drop the cargo-cult `Promise.all([single])`.
  // Awaiting a one-element array adds an extra microtask hop without
  // any concurrency benefit. The hash is the only async step; await
  // it directly.
  const plaintext = generatePat();
  const tokenHash = await hashPat(plaintext, pepper);
  return {
    plaintext,
    tokenHash,
    tokenPrefix: tokenPrefix(plaintext),
    tokenSuffix: tokenSuffix(plaintext),
  };
}

/**
 * Generate a 16-byte hex id. Mirrors `workers/routes/tokens.ts`'s `newId`
 * helper so the PAT surface inherits the same id shape used by `agent_tokens`.
 */
export function newPatId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// base64url helpers — Workers' atob/btoa speak base64, not base64url
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
