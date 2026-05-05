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

/**
 * Bootstrap-only handle: returns a plain Drizzle wrapper for the rare paths
 * that MUST query users / group_members BEFORE any AuthzContext exists yet.
 *
 * Audit fix CC-1 (graph: SpDzyE2nPBmE3Ix_oc6ay). Two infrastructure paths
 * legitimately need DB access without ctx because they're the code that
 * BUILDS ctx:
 *   1. `workers/middleware/authz-context.ts` — resolves session/JWT/token →
 *      user → group_ids + mailbox_ids. This is the bootstrap path.
 *   2. `workers/lib/bootstrap-owner.ts` — first-login global_owner promotion
 *      that runs BEFORE the user has a row to derive group_ids from.
 *
 * Every OTHER caller MUST go through `forGroup(db, ctx).db` so the CI
 * grep-lint can enforce the chokepoint. The lint rule (D-V2F-3) targets:
 *
 *   rg "import.*drizzle.*drizzle-orm/d1" workers/ \
 *     --include='*.ts' \
 *     | grep -v 'workers/db/control-plane/forGroup.ts\|bootstrap-owner.ts'
 *
 * (Existing direct `drizzle()` imports in those two files are the documented
 * exemption surface; everything else is a violation.)
 */
export function bootstrapDb(db: D1Database) {
  return drizzle(db, { schema });
}
