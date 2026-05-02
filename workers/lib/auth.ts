// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { JwtClaims } from "./mock-access";

/** Service tokens have empty `sub`; humans have a UUID. */
export function isServiceToken(jwt: JwtClaims | undefined): boolean {
  return !!jwt && jwt.sub === "";
}

/** Returns the authenticated email, or undefined for service tokens / missing JWT. */
export function jwtEmail(jwt: JwtClaims | undefined): string | undefined {
  if (!jwt || isServiceToken(jwt)) return undefined;
  return jwt.email;
}

/** Service-token client_id from the JWT (CF Access embeds it as `common_name`). */
export function serviceTokenClientId(
  jwt: JwtClaims | undefined,
): string | undefined {
  if (!jwt || !isServiceToken(jwt)) return undefined;
  return jwt.common_name;
}
