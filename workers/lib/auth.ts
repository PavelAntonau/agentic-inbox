// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { JwtClaims } from "./mock-access";
import { normalizeEmail } from "./email";

/** Service tokens have empty `sub`; humans have a UUID. */
export function isServiceToken(jwt: JwtClaims | undefined): boolean {
  return !!jwt && jwt.sub === "";
}

/**
 * Returns the authenticated email (canonical lower-cased trim form), or
 * undefined for service tokens / missing JWT / missing-or-empty email
 * claim.
 *
 * C3.3: previously returned `jwt.email` verbatim, which let mixed-case
 * upstream values miss the `users.email` lookup in `authzContext`
 * even though storage is `lower(email)` UNIQUE. Funnel through
 * `normalizeEmail` so callers see the same form the DB stores.
 */
export function jwtEmail(jwt: JwtClaims | undefined): string | undefined {
  if (!jwt || isServiceToken(jwt)) return undefined;
  const norm = normalizeEmail(jwt.email);
  return norm.length > 0 ? norm : undefined;
}

/** Service-token client_id from the JWT (CF Access embeds it as `common_name`). */
export function serviceTokenClientId(
  jwt: JwtClaims | undefined,
): string | undefined {
  if (!jwt || !isServiceToken(jwt)) return undefined;
  return jwt.common_name;
}
