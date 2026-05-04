// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.1 (mcp-oauth) — input sanitization for the OAuth /consent screen.
//
// The consent page renders attacker-controlled OAuth-client metadata
// (`client_name`, `client_uri`, `logo_uri`, `description`) pulled from
// `oauth_client` rows that the dynamic-client-registration endpoint may
// have written without a human in the loop. Every value MUST be sanitized
// before reaching the DOM:
//
//   - `logo_uri` and `client_uri` MUST be HTTPS URLs to a real host. Schemes
//     `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, and `about:`
//     are rejected outright (XSS via `<img src>` / `<a href>`). HTTP is
//     rejected too — mixed-content downgrades on a primary auth surface
//     are not acceptable.
//   - `client_name`, `description`, and any other free-text field is
//     escaped via `escapeHtmlText` before interpolation. React already
//     escapes for us when we render `{value}` inside JSX text, but the
//     helper here is the canonical surface for any non-React caller
//     (JSON-LD blob, server-rendered shells, the e2e test harness).
//
// Exports are intentionally narrow: one URL sanitizer, one text escaper.
// Everything else (length caps, etc.) is a presentation concern and
// belongs to the consent component, not this module.

/**
 * Allowed schemes for `logo_uri` / `client_uri`. HTTPS only.
 *
 * Per CF Securing-MCP-Servers guide §1.2 and the OWASP HTML5 cheat sheet,
 * the safest URL allowlist for content rendered into `<img src>` /
 * `<a href>` is exact-match HTTPS. We deliberately do NOT allow `mailto:`
 * or `tel:` here — those belong on profile rows, not OAuth client metadata.
 */
const ALLOWED_URL_SCHEMES = new Set(["https:"]);

/** Maximum host length we accept for an HTTPS URL (RFC 1035 §2.3.4). */
const MAX_HOST_LEN = 253;

/**
 * Sanitize a URL string, returning the parsed URL or `null` if rejected.
 *
 * Rejection conditions (any one is fatal):
 *   - empty / whitespace-only string
 *   - parse failure (URL constructor throws)
 *   - scheme not in {`https:`}
 *   - hostname empty (e.g. `https:///foo`)
 *   - hostname longer than 253 characters
 *   - hostname is a literal IP (we do NOT render IP-addressed logos —
 *     trust signal for users is the registered domain, not raw IPs)
 *
 * The return type is `URL | null` rather than `string | null` so callers
 * can introspect the parsed shape (origin, pathname) without re-parsing.
 *
 * Callers that just need a string for an `<img src>` should call
 * `.toString()` on the result, or use `safeHttpsHref` which returns
 * `string | undefined`.
 */
export function sanitizeHttpsUrl(input: unknown): URL | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) return null;

  const host = parsed.hostname;
  if (!host || host.length > MAX_HOST_LEN) return null;

  // Reject literal IPv4 / IPv6 hosts. The URL parser surfaces IPv6 as
  // bracketed (`[::1]`); IPv4 we test by structural shape (four dotted
  // decimal octets). Pure-numeric "domain" labels like `1.2.3.4` are
  // always IP literals — there is no DNS A record for them in practice.
  if (host.startsWith("[") || /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return null;

  return parsed;
}

/**
 * String form of `sanitizeHttpsUrl` for direct use in an attribute. Returns
 * the canonical normalized URL string, or `undefined` when the input is
 * invalid (so JSX can spread `{ src: safeHttpsHref(uri) }` and React drops
 * the attribute entirely).
 */
export function safeHttpsHref(input: unknown): string | undefined {
  const url = sanitizeHttpsUrl(input);
  return url ? url.toString() : undefined;
}

/**
 * HTML-escape a string for safe interpolation into HTML text content or
 * attribute values. Idempotent on already-escaped input.
 *
 * React auto-escapes `{value}` in JSX, so component code does NOT need this
 * helper for normal renders. Reach for it when:
 *   - building a server-rendered HTML shell (e.g. workers/auth/consent.ts
 *     fallback render);
 *   - writing values into a `<script type="application/json">` blob;
 *   - producing email bodies or other non-React HTML surfaces.
 *
 * The rule set covers the five characters the OWASP XSS cheat sheet flags
 * as universally unsafe: `&`, `<`, `>`, `"`, `'`. Backtick is intentionally
 * NOT escaped — IE-specific concern, irrelevant for our deploy targets.
 */
export function escapeHtmlText(input: unknown): string {
  if (input == null) return "";
  const str = typeof input === "string" ? input : String(input);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Cap a string at `max` characters for display. Returns the original when
 * already within the cap; otherwise truncates and appends a single Unicode
 * ellipsis (U+2026). Rejects non-strings (returns empty string).
 *
 * Use for `description` / `client_name` rendering — we DO show the value
 * but we cap to a UI-sane length. Values that exceed cleanly are normal
 * defensive UI; values that exceed by orders of magnitude are usually
 * a sign of a malformed registration row.
 */
export function clampLength(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  if (input.length <= max) return input;
  return input.slice(0, max - 1) + "…";
}
