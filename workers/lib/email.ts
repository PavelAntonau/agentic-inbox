// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Phase C3 / C3.3 — single-source email canonicalization.
 *
 * Rationale (from `.research/agentic-inbox-walkthrough.md`, BUG catalog):
 *
 *   "Email case-sensitivity not normalized at 5 sites — concrete BUG with
 *    bootstrap-owner misfire scenario. The `lower(email)` UNIQUE index
 *    protects writes; reads can MISS rows when case differs from upstream
 *    input → 403s, bootstrap firing on already-promoted users."
 *
 * Sites that consume this helper:
 *
 *   1. `workers/auth/index.ts` (better-auth signup gate)
 *   2. `workers/lib/bootstrap-owner.ts` (`isBootstrapEmail`, `bootstrapOwner`)
 *   3. `workers/middleware/authz-context.ts` (CF Access JWT email lookup)
 *   4. `workers/lib/auth.ts` (`jwtEmail` extracted from JWT claims)
 *   5. Migration 0016 (`UPDATE users SET email = LOWER(email) WHERE email != LOWER(email)`)
 *      to backfill any pre-existing mixed-case rows.
 *
 * Contract:
 *   - INPUT  any string (or non-string falsy → undefined)
 *   - OUTPUT lowercase-trimmed RFC-5321-equivalent local-part + domain.
 *
 *   Local-part case-sensitivity per RFC 5321 §2.3.11 is technically allowed,
 *   but every mainstream MTA (Gmail, Microsoft 365, Postmark, Resend, CF
 *   Email Routing) treats local-parts as case-insensitive. We follow that
 *   convention and lowercase the entire address — same call the
 *   `lower(email)` UNIQUE index in D1 makes on the storage side.
 *
 *   Whitespace is also stripped; better-auth and CF Access have both been
 *   observed to surface emails with trailing newlines in development, and
 *   the bootstrap-owner predicate already had to defend against that
 *   (audit A-1 sibling).
 */
export function normalizeEmail(input: string | null | undefined): string {
  if (typeof input !== "string") return "";
  return input.trim().toLowerCase();
}

/**
 * Returns `true` when `input` is a string that, after `normalizeEmail`,
 * is non-empty and contains the canonical `@`. Cheap, intentionally
 * lax — full RFC validation is the email provider's job; the worker
 * just refuses obvious garbage.
 */
export function isEmailLike(input: string | null | undefined): boolean {
  const norm = normalizeEmail(input);
  if (norm.length === 0) return false;
  const at = norm.indexOf("@");
  return at > 0 && at < norm.length - 1;
}
