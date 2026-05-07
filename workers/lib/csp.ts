// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Phase E / TASK-E.1 — nonce-based CSP for `script-src`.
 *
 * Replaces the `'unsafe-inline'` relaxation Phase C3 had to ship to keep
 * RR7 hydration working. The middleware in `workers/app.ts` now:
 *
 *   1. Generates a fresh per-request nonce.
 *   2. After the route handler runs, if the response is HTML, walks every
 *      `<script>` tag with HTMLRewriter and stamps `nonce="<value>"` on it.
 *      That covers RR7's hydration tags (router context + serialized loader
 *      data) AND ReactDOM's bootstrap script — neither needs entry.server.tsx
 *      cooperation.
 *   3. Emits `script-src 'self' 'nonce-<value>' 'strict-dynamic'` in the CSP
 *      header, with `'unsafe-inline'` REMOVED. `'strict-dynamic'` then
 *      transitively trusts any script the nonce'd scripts load (the RR7
 *      hydration tag pulls in the entry-client ES module + its dependency
 *      graph), so we don't need to enumerate the build's chunk hashes.
 *
 * `style-src 'self' 'unsafe-inline'` is preserved — Tailwind generates a CSS
 * file but a handful of inline `<style>` declarations remain (the dev /login
 * picker is the visible one). OWASP-accepted relaxation; no XSS surface
 * because the inline styles are server-rendered constants, never user
 * content.
 */

const NONCE_BYTES = 16;

/**
 * 16 bytes of crypto-random → base64url (`+/` → `-_`, no `=` padding).
 *
 * Length: ~22 chars. Per CSP3 §6.6.3.1 the nonce SHOULD be ≥ 128 bits;
 * 16 bytes hits that bar exactly.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Render the CSP directive string for a given nonce.
 *
 * When `nonce` is null we emit a fail-CLOSED `script-src 'self'
 * 'strict-dynamic'` — no source list catches inline scripts because
 * 'strict-dynamic' overrides whitelisted host expressions. That deliberately
 * breaks any HTML route that forgets to wire its nonce: the rewritten
 * `<script>` tags will lack a nonce, the browser will refuse them, and the
 * regression surfaces immediately in the visual / scenario suite.
 *
 * `'unsafe-inline'` is INTENTIONALLY ABSENT from script-src. That was the
 * Phase C3 carry-forward this task closes.
 */
export function buildCspDirectives(nonce: string | null): string {
  // Phase G-2 / G T3.5 cutover (2026-05-07) — Turnstile widget loader and
  // verify endpoint must be allowlisted alongside the nonce baseline.
  // The widget loads `https://challenges.cloudflare.com/turnstile/v0/api.js`
  // (script-src), renders an iframe pointing at challenges.cloudflare.com
  // (frame-src), and POSTs the user's challenge response from the client
  // (connect-src). img-src adds `https:` so React-rendered avatars and
  // external mailbox imagery render.
  const scriptSrc =
    nonce !== null
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://challenges.cloudflare.com`
      : "script-src 'self' 'strict-dynamic' https://challenges.cloudflare.com";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** Hono context variable name carrying the per-request nonce. */
export const CSP_NONCE_VAR = "cspNonce" as const;
