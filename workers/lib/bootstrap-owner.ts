// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import type { Env } from "../types";

/**
 * First-login flow for the pinned global owner. Idempotent.
 *
 * If env.BOOTSTRAP_OWNER_EMAIL is set AND no users row exists for that email,
 * INSERT a row with role='global_owner'. Returns the user id (or null when
 * BOOTSTRAP_OWNER_EMAIL is unset, treating it as opt-out).
 *
 * Phase 3 wires this into the authzContext middleware's "user not found"
 * branch — when the email matches the bootstrap owner, promote and continue;
 * otherwise reject as today.
 *
 * Safe to call concurrently: relies on UNIQUE(email) via lower() index to
 * collapse races to a single insert.
 */
export async function bootstrapOwner(
  db: D1Database,
  env: Env,
  loginEmail: string,
  now: number,
): Promise<string | null> {
  const target = env.BOOTSTRAP_OWNER_EMAIL?.trim();
  if (!target) return null;
  if (loginEmail.toLowerCase() !== target.toLowerCase()) return null;

  const orm = drizzle(db, { schema });
  const existing = await orm
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, loginEmail))
    .get();
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  await orm
    .insert(schema.users)
    .values({
      id,
      email: loginEmail,
      display_name: null,
      role: "global_owner",
      status: "active",
      visibility: "everyone",
      created_at: now,
      last_login_at: now,
    })
    .onConflictDoNothing()
    .run();

  // Re-read in case onConflictDoNothing collapsed a race
  const final = await orm
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, loginEmail))
    .get();
  return final?.id ?? null;
}
