// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type AuthzContext = {
  /** D1 row id for the human user. Service tokens resolve via agent_tokens.issued_to_user. */
  user_id: string;
  role: "global_owner" | "global_admin" | "user";
  /** Groups the caller is a member of. Empty for non-grouped resources. */
  group_ids: string[];
  /** Mailboxes the caller can read/write (union over groups + own private). */
  authorized_mailbox_ids: string[];
  /** When the caller is a service token, the resolved token id. */
  agent_token_id?: string;
  /** When the caller authenticated via better-auth session cookie, the session row id.
   *  Used by GET /api/users/me/sessions to mark the current session. */
  session_id?: string;
};

/**
 * Returns a Drizzle DB handle that callers must use for all control-plane
 * queries. Phase 2.1 ships the WRAPPER; the actual `WHERE group_id IN (...)`
 * enforcement is enforced by the CI grep-lint, which forbids handlers from
 * importing `drizzle` directly. This is the chokepoint.
 */
export function forGroup(db: D1Database, ctx: AuthzContext) {
  const orm = drizzle(db, { schema });
  return {
    db: orm,
    ctx,
    schema,
  };
}

export type ForGroupHandle = ReturnType<typeof forGroup>;
