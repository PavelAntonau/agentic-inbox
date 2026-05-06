// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../db/control-plane/schema";
import type { AuthzContext } from "../../db/control-plane/forGroup";
import type { Env } from "../../types";
import {
  getSettings,
  bumpVersion,
  SETTINGS_KEYS,
} from "../../lib/settings-cache";
import { writeAudit } from "../../lib/audit-log";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// -----------------------------------------------------------------------
// Auth guard — all admin settings routes require global_owner or global_admin
// -----------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  if (ctx.role !== "global_owner" && ctx.role !== "global_admin") {
    return c.json({ error: "Forbidden — admin required" }, 403);
  }
  return next();
});

// -----------------------------------------------------------------------
// GET / — return all settings catalog rows
// -----------------------------------------------------------------------

router.get("/", async (c) => {
  const rows = await getSettings(c.env.DB);
  return c.json({ settings: rows });
});

// -----------------------------------------------------------------------
// Enum values for keys that have a constrained set
// -----------------------------------------------------------------------

const ENUM_KEYS: Record<string, string[]> = {
  default_user_visibility: ["everyone", "contacts", "nobody"],
};

// -----------------------------------------------------------------------
// F-AS2 (audit, agentic-inbox-hardening Phase 2): per-key upper-bound
// caps for integer settings.
//
// Without these, an authenticated admin can set any integer-typed setting
// to MAX_INT, which is functionally unbounded and exploitable on the
// downstream consumers (e.g. max_regular_users = 10^9 → invitation handler
// admits unlimited new users; group_invitation_ttl_days = 10^9 → invitations
// never expire).
//
// The four explicit caps are taken from the audit report. The remaining
// integer keys get conservative defaults — they are not exploitable in the
// same way, but a 100-mailbox-per-user limit (vs MAX_INT) is sane defense
// in depth and keeps the cap surface uniform.
// -----------------------------------------------------------------------

export const SETTINGS_MAX_VALUES: Record<string, number> = {
  // Audit-named caps (workers/db/control-plane/.research → F-AS2)
  max_regular_users: 10000,
  max_global_admins: 20,
  group_invitation_ttl_days: 365,
  agent_token_idle_prune_minutes: 44640, // 31 days

  // Conservative caps for the rest of the integer catalog
  max_private_mailboxes_per_user: 1000,
  max_mailboxes_per_group: 1000,
  max_groups_per_mailbox: 1000,
  agent_token_default_max_instances: 100,
};

// -----------------------------------------------------------------------
// PATCH /:key — update a single setting value
// -----------------------------------------------------------------------

router.patch("/:key", async (c) => {
  const actor = c.var.authzContext!;
  const key = c.req.param("key")!;
  const db = c.env.DB;

  // Validate key is in catalog
  if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
    return c.json({ error: `Unknown setting key: ${key}` }, 400);
  }

  let body: { value?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (body.value === undefined || body.value === null) {
    return c.json({ error: "Missing value in body" }, 400);
  }

  // Validate type: enum keys need a string from the allowed set;
  // all other keys are integers.
  let coercedValue: string;

  if (ENUM_KEYS[key]) {
    if (
      typeof body.value !== "string" ||
      !ENUM_KEYS[key].includes(body.value)
    ) {
      return c.json(
        {
          error: `Invalid value for ${key}. Allowed: ${ENUM_KEYS[key].join(", ")}`,
        },
        400,
      );
    }
    coercedValue = body.value;
  } else {
    // Integer key
    const parsed =
      typeof body.value === "number"
        ? body.value
        : parseInt(String(body.value), 10);
    if (isNaN(parsed) || parsed < 0) {
      return c.json(
        { error: `Value for ${key} must be a non-negative integer` },
        400,
      );
    }
    // F-AS2 — enforce per-key upper bound.
    const maxAllowed = SETTINGS_MAX_VALUES[key];
    if (maxAllowed !== undefined && parsed > maxAllowed) {
      return c.json(
        {
          error: `Value for ${key} exceeds maximum allowed (${maxAllowed})`,
        },
        400,
      );
    }
    coercedValue = String(parsed);
  }

  const orm = drizzle(db, { schema });
  const now = Date.now();

  // Read existing value for audit (from/to)
  const existing = await orm
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();
  const previousValue = existing?.value ?? null;

  await orm
    .insert(schema.settings)
    .values({
      key,
      value: coercedValue,
      updated_at: now,
      updated_by: actor.user_id,
    })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: {
        value: coercedValue,
        updated_at: now,
        updated_by: actor.user_id,
      },
    })
    .run();

  // Bump version so in-memory cache invalidates within 30 s
  await bumpVersion(db, actor.user_id);

  await writeAudit(db, {
    action: "settings.update",
    target: { kind: "setting", id: key },
    actor,
    meta: {
      from: previousValue,
      to: coercedValue,
    },
  });

  return c.json({ ok: true, key, value: coercedValue });
});

export default router;
