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
import { appendAudit } from "../../lib/audit-log";

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

  await appendAudit(
    db,
    actor,
    "settings.update",
    { kind: "setting", id: key },
    {
      from: previousValue,
      to: coercedValue,
    },
  );

  return c.json({ ok: true, key, value: coercedValue });
});

export default router;
