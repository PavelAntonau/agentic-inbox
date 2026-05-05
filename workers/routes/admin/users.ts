// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, count, sql } from "drizzle-orm";
import * as schema from "../../db/control-plane/schema";
import type { AuthzContext } from "../../db/control-plane/forGroup";
import type { Env } from "../../types";
import { canAct } from "../../lib/peer-protection";
import { appendAudit } from "../../lib/audit-log";
import { upsertEmail } from "../../lib/cloudflare-access-policy";
import { getSettings } from "../../lib/settings-cache";
import { getEmailBinding } from "../../lib/mocks/email-binding";
import { plainTextInvite } from "../../lib/email-templates";

// Re-export type for the router
type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// -----------------------------------------------------------------------
// Helpers — admin-cap parsing (F-AU3)
// -----------------------------------------------------------------------

/**
 * Parse the `max_global_admins` setting value into a numeric cap.
 *
 * Returns a discriminated result so the caller can fail-closed on a
 * malformed setting row. Treating an unparseable value as "no cap"
 * (the previous behaviour) silently disabled the promotion limit
 * (audit F-AU3 — `NaN >= NaN === false` defeats canAct's cap check).
 *
 * Exported for unit-test access; the router itself is the only
 * production caller.
 */
export function parseAdminCap(
  raw: string | undefined,
): { ok: true; cap: number | undefined } | { ok: false; reason: "nan" } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, cap: undefined };
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return { ok: false, reason: "nan" };
  }
  return { ok: true, cap: parsed };
}

// -----------------------------------------------------------------------
// Auth guard — all admin routes require global_owner or global_admin
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
// GET / — list all users with owns_mailboxes_count
// -----------------------------------------------------------------------

router.get("/", async (c) => {
  const db = c.env.DB;
  const orm = drizzle(db, { schema });

  // Single query: users LEFT JOIN mailboxes aggregated by owner
  const rows = await orm
    .select({
      id: schema.users.id,
      email: schema.users.email,
      display_name: schema.users.display_name,
      role: schema.users.role,
      status: schema.users.status,
      last_login_at: schema.users.last_login_at,
      owns_mailboxes_count: sql<number>`count(${schema.mailboxes.id})`.as(
        "owns_mailboxes_count",
      ),
    })
    .from(schema.users)
    .leftJoin(
      schema.mailboxes,
      eq(schema.mailboxes.owner_user_id, schema.users.id),
    )
    .groupBy(schema.users.id)
    .all();

  return c.json({
    users: rows.map((r) => ({
      id: r.id,
      email: r.email,
      display_name: r.display_name,
      role: r.role,
      status: r.status,
      last_login_at: r.last_login_at,
      owns_mailboxes_count: Number(r.owns_mailboxes_count ?? 0),
    })),
  });
});

// -----------------------------------------------------------------------
// POST /invite — invite a new user
// -----------------------------------------------------------------------

router.post("/invite", async (c) => {
  const actor = c.var.authzContext!;
  const db = c.env.DB;
  const orm = drizzle(db, { schema });

  let body: { email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "Invalid email address" }, 400);
  }

  // Upsert into Cloudflare Access policy (mock-mode-safe)
  const accessResult = await upsertEmail(c.env, email);
  if (!accessResult.ok) {
    return c.json(
      { error: `Cloudflare Access update failed: ${accessResult.error}` },
      502,
    );
  }

  // Insert placeholder user row if not already present.
  // On conflict (email already in workspace), do nothing — privacy: do not
  // leak workspace membership (E15/E16).
  const existingUser = await orm
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .get();

  if (!existingUser) {
    const newId = crypto.randomUUID();
    await orm
      .insert(schema.users)
      .values({
        id: newId,
        email,
        display_name: null,
        role: "user",
        status: "active", // Will be gated by Access until first login
        visibility: "everyone",
        created_at: Date.now(),
        last_login_at: null,
      })
      .onConflictDoNothing()
      .run();

    const created = await orm
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();

    if (created) {
      await appendAudit(
        db,
        actor,
        "workspace.invite",
        { kind: "user", id: created.id },
        {
          method: "admin-invite",
          email,
          access_mocked: accessResult.mocked ?? false,
        },
      );
    }
  } else {
    // User already exists — write audit but don't leak that fact in the response
    await appendAudit(
      db,
      actor,
      "workspace.invite",
      { kind: "user", id: existingUser.id },
      {
        method: "admin-invite",
        email,
        already_existed: true,
        access_mocked: accessResult.mocked ?? false,
      },
    );
  }

  // Send the invitation email. Plain-text spec: one paragraph, one URL
  // (`/login?email=<urlencoded>`), one signature line. Sender is the apex
  // `noreply@actionnow.ai` (DKIM-aligned via Resend). Errors are logged +
  // recorded in the audit row but do NOT change the response — the privacy
  // contract (always return `ok: true`) stays intact.
  const host = new URL(c.req.url).host;
  const loginUrl = `https://${host}/login?email=${encodeURIComponent(email)}`;
  let mailSendError: string | null = null;
  try {
    const binding = getEmailBinding(c.env);
    await binding.send({
      to: email,
      from: { name: "ActionNow", email: "noreply@actionnow.ai" },
      subject: "You've been invited to ActionNow",
      text: plainTextInvite({ loginUrl }),
    });
  } catch (e) {
    mailSendError = (e as Error).message;
    console.error(
      "[admin/users/invite] send failed",
      JSON.stringify({ recipient: email, error: mailSendError }),
    );
  }

  await appendAudit(
    db,
    actor,
    "workspace.invite-mail",
    { kind: "user", id: existingUser?.id ?? "pending" },
    {
      method: "admin-invite",
      email,
      mail_send_status: mailSendError ? "failed" : "sent",
      mail_send_error: mailSendError,
    },
  );

  // Always return ok: true — privacy (E15/E16)
  return c.json({ ok: true });
});

// -----------------------------------------------------------------------
// POST /:id/promote — promote user → global_admin
// -----------------------------------------------------------------------

router.post("/:id/promote", async (c) => {
  const actor = c.var.authzContext!;
  const targetId = c.req.param("id")!;
  const db = c.env.DB;
  const orm = drizzle(db, { schema });

  const target = await orm
    .select({
      id: schema.users.id,
      role: schema.users.role,
      email: schema.users.email,
      owns_mailboxes_count: sql<number>`count(${schema.mailboxes.id})`.as(
        "owns_mailboxes_count",
      ),
    })
    .from(schema.users)
    .leftJoin(
      schema.mailboxes,
      eq(schema.mailboxes.owner_user_id, schema.users.id),
    )
    .groupBy(schema.users.id)
    .where(eq(schema.users.id, targetId))
    .get();

  if (!target) return c.json({ error: "User not found" }, 404);

  // Read settings for admin cap.
  //
  // F-AU3 (audit, agentic-inbox-hardening Phase 2): parseInt returns NaN
  // for malformed values; canAct's cap check `currentAdminCount >= adminCap`
  // then evaluates `n >= NaN === false`, silently bypassing the cap. Fail
  // closed with 500 on a non-integer value so the misconfiguration surfaces
  // immediately instead of letting an unbounded promotion through.
  const settings = await getSettings(db);
  const adminCapRow = settings.find((s) => s.key === "max_global_admins");
  const adminCapParsed = parseAdminCap(adminCapRow?.value);
  if (!adminCapParsed.ok) {
    return c.json(
      {
        error:
          "Server misconfiguration: max_global_admins is not a valid integer",
      },
      500,
    );
  }
  const adminCap = adminCapParsed.cap;

  let currentAdminCount: number | undefined;
  if (adminCap !== undefined) {
    const countResult = await orm
      .select({ cnt: count() })
      .from(schema.users)
      .where(eq(schema.users.role, "global_admin"))
      .get();
    currentAdminCount = countResult?.cnt ?? 0;
  }

  const check = canAct(
    { user_id: actor.user_id, role: actor.role, email: "" },
    {
      id: target.id,
      role: target.role,
      email: target.email,
      owns_mailboxes_count: Number(target.owns_mailboxes_count ?? 0),
    },
    "promote",
    adminCap,
    currentAdminCount,
  );

  if (!check.ok) {
    return c.json({ ok: false, reason: check.reason }, 422);
  }

  await orm
    .update(schema.users)
    .set({ role: "global_admin" })
    .where(eq(schema.users.id, targetId))
    .run();

  await appendAudit(
    db,
    actor,
    "user.promote",
    { kind: "user", id: targetId },
    {
      from: target.role,
      to: "global_admin",
    },
  );

  return c.json({ ok: true, current_role: "global_admin" });
});

// -----------------------------------------------------------------------
// POST /:id/demote — demote global_admin → user
// -----------------------------------------------------------------------

router.post("/:id/demote", async (c) => {
  const actor = c.var.authzContext!;
  const targetId = c.req.param("id")!;
  const db = c.env.DB;
  const orm = drizzle(db, { schema });

  const target = await orm
    .select({
      id: schema.users.id,
      role: schema.users.role,
      email: schema.users.email,
      owns_mailboxes_count: sql<number>`count(${schema.mailboxes.id})`.as(
        "owns_mailboxes_count",
      ),
    })
    .from(schema.users)
    .leftJoin(
      schema.mailboxes,
      eq(schema.mailboxes.owner_user_id, schema.users.id),
    )
    .groupBy(schema.users.id)
    .where(eq(schema.users.id, targetId))
    .get();

  if (!target) return c.json({ error: "User not found" }, 404);

  const check = canAct(
    { user_id: actor.user_id, role: actor.role, email: "" },
    {
      id: target.id,
      role: target.role,
      email: target.email,
      owns_mailboxes_count: Number(target.owns_mailboxes_count ?? 0),
    },
    "demote",
  );

  if (!check.ok) {
    return c.json({ ok: false, reason: check.reason }, 422);
  }

  await orm
    .update(schema.users)
    .set({ role: "user" })
    .where(eq(schema.users.id, targetId))
    .run();

  await appendAudit(
    db,
    actor,
    "user.demote",
    { kind: "user", id: targetId },
    {
      from: target.role,
      to: "user",
    },
  );

  return c.json({ ok: true, current_role: "user" });
});

// -----------------------------------------------------------------------
// DELETE /:id — remove a user
// -----------------------------------------------------------------------

router.delete("/:id", async (c) => {
  const actor = c.var.authzContext!;
  const targetId = c.req.param("id")!;
  const db = c.env.DB;
  const orm = drizzle(db, { schema });

  const target = await orm
    .select({
      id: schema.users.id,
      role: schema.users.role,
      email: schema.users.email,
      owns_mailboxes_count: sql<number>`count(${schema.mailboxes.id})`.as(
        "owns_mailboxes_count",
      ),
    })
    .from(schema.users)
    .leftJoin(
      schema.mailboxes,
      eq(schema.mailboxes.owner_user_id, schema.users.id),
    )
    .groupBy(schema.users.id)
    .where(eq(schema.users.id, targetId))
    .get();

  if (!target) return c.json({ error: "User not found" }, 404);

  const check = canAct(
    { user_id: actor.user_id, role: actor.role, email: "" },
    {
      id: target.id,
      role: target.role,
      email: target.email,
      owns_mailboxes_count: Number(target.owns_mailboxes_count ?? 0),
    },
    "remove",
  );

  if (!check.ok) {
    if (check.reason === "owns-mailboxes") {
      return c.json(
        {
          ok: false,
          reason: "owns-mailboxes",
          owns_mailboxes_count: Number(target.owns_mailboxes_count ?? 0),
          message: `User owns ${target.owns_mailboxes_count} mailbox(es). Transfer them first.`,
        },
        409,
      );
    }
    return c.json({ ok: false, reason: check.reason }, 422);
  }

  // Audit before delete (the row will no longer exist)
  await appendAudit(
    db,
    actor,
    "user.remove",
    { kind: "user", id: targetId },
    {
      email: target.email,
      role: target.role,
    },
  );

  await orm.delete(schema.users).where(eq(schema.users.id, targetId)).run();

  return c.json({ ok: true });
});

export default router;
