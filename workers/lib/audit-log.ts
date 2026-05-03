// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/control-plane/schema";
import type { AuthzContext } from "../db/control-plane/forGroup";

/**
 * Append a row to the audit_log table.
 *
 * Designed to be fire-and-forget in most callers — errors are logged but
 * do NOT propagate, so an audit failure never blocks the actual operation.
 *
 * @param db     D1Database binding
 * @param actor  Resolved authzContext for the requesting user
 * @param action Dot-namespaced action string (e.g. 'workspace.invite', 'settings.update')
 * @param target { kind: string; id: string } — what was acted on
 * @param meta   Optional free-form metadata (from/to values, method, etc.)
 */
export async function appendAudit(
  db: D1Database,
  actor: AuthzContext,
  action: string,
  target: { kind: string; id: string },
  meta?: Record<string, unknown>,
): Promise<void> {
  const orm = drizzle(db, { schema });
  await orm
    .insert(schema.audit_log)
    .values({
      at: Date.now(),
      actor_user_id: actor.agent_token_id ? null : actor.user_id,
      actor_token_id: actor.agent_token_id ?? null,
      action,
      target_type: target.kind,
      target_id: target.id,
      scope_group_id: null,
      meta_json: meta ? JSON.stringify(meta) : null,
      ip: null,
    })
    .run();
}
