// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/routes/threads.ts — Thread CAS API (D-PLAT-5).
//
// Mounts at /api/mailboxes (see app.ts, registered as threadsRouter).
//
// Endpoints:
//   GET  /api/mailboxes/:mid/threads/:tid
//   POST /api/mailboxes/:mid/threads/:tid/messages

import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import * as cpSchema from "../db/control-plane/schema";
import type { AuthzContext } from "../db/control-plane/forGroup";
import { ThreadNotFoundError, ConflictError } from "../durableObject/index";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import { Folders } from "../../shared/folders";
import { emitRateLimitEvent } from "../lib/rl-events";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ── Auth guard ─────────────────────────────────────────────────────

router.use("*", async (c, next) => {
  if (!c.var.authzContext) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ── Helpers ────────────────────────────────────────────────────────

function getMailboxStub(
  env: Env,
  mailboxId: string,
): DurableObjectStub<MailboxDO> {
  return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

/**
 * Fetch inbox policy from D1 control plane.
 * Returns null if the mailbox row or the new policy columns are absent
 * (TASK-2.1 parallel-mode safety: fall back to permissive).
 */
async function fetchInboxPolicy(
  env: Env,
  mailboxId: string,
): Promise<{
  external_inbound_enabled: boolean;
  external_allow_mode: "all" | "allowlist";
  internal_inbound_mode: "everyone" | "contacts_only" | "none";
} | null> {
  try {
    const db = drizzle(env.DB, { schema: cpSchema });
    const row = await db
      .select({
        external_inbound_enabled: cpSchema.mailboxes.external_inbound_enabled,
        external_allow_mode: cpSchema.mailboxes.external_allow_mode,
        internal_inbound_mode: cpSchema.mailboxes.internal_inbound_mode,
      })
      .from(cpSchema.mailboxes)
      .where(eq(cpSchema.mailboxes.id, mailboxId))
      .get();
    return row ?? null;
  } catch {
    // Defensive: if columns aren't present yet (TASK-2.1 not integrated),
    // fall back to permissive — never throw.
    return null;
  }
}

/**
 * Check whether sender has an accepted contact relationship with
 * the recipient inbox owner.
 * Used for internal_inbound_mode = 'contacts_only'.
 */
async function senderIsContact(
  env: Env,
  senderUserId: string,
  recipientMailboxId: string,
): Promise<boolean> {
  try {
    const db = drizzle(env.DB, { schema: cpSchema });
    // Find the recipient inbox owner.
    const mailboxRow = await db
      .select({ owner_user_id: cpSchema.mailboxes.owner_user_id })
      .from(cpSchema.mailboxes)
      .where(eq(cpSchema.mailboxes.id, recipientMailboxId))
      .get();
    if (!mailboxRow) return false;

    const recipientUserId = mailboxRow.owner_user_id;
    if (senderUserId === recipientUserId) return true; // self-send always passes

    // Check accepted contact relationship (symmetric: either direction).
    const fwd = await db
      .select({ status: cpSchema.contacts.status })
      .from(cpSchema.contacts)
      .where(
        and(
          eq(cpSchema.contacts.owner_user_id, senderUserId),
          eq(cpSchema.contacts.contact_user_id, recipientUserId),
          eq(cpSchema.contacts.status, "accepted"),
        ),
      )
      .get();
    if (fwd) return true;

    const rev = await db
      .select({ status: cpSchema.contacts.status })
      .from(cpSchema.contacts)
      .where(
        and(
          eq(cpSchema.contacts.owner_user_id, recipientUserId),
          eq(cpSchema.contacts.contact_user_id, senderUserId),
          eq(cpSchema.contacts.status, "accepted"),
        ),
      )
      .get();
    return !!rev;
  } catch {
    return false;
  }
}

// ── GET /api/mailboxes/:mid/threads/:tid ───────────────────────────

router.get("/:mid/threads/:tid", async (c) => {
  const mailboxId = c.req.param("mid");
  const threadId = c.req.param("tid");

  const stub = getMailboxStub(c.env, mailboxId);
  const thread = await (stub as unknown as MailboxDO).getThread(threadId);

  if (!thread) return c.json({ error: "Thread not found" }, 404);

  return c.json({
    id: thread.id,
    subject: thread.subject,
    version: thread.version,
    tip_message_id: thread.tip_message_id,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    parent_thread_id: thread.parent_thread_id,
  });
});

// ── POST /api/mailboxes/:mid/threads/:tid/messages ─────────────────

router.post("/:mid/threads/:tid/messages", async (c) => {
  // Phase v1.1 G-5 / TASK-1.4 — gate-entry timestamp for AE latency.
  // Post-auth route: shard on user_id (session id), not IP.
  const t0 = Date.now();
  const mailboxId = c.req.param("mid");
  const threadId = c.req.param("tid");
  const ctx = c.var.authzContext!;

  // D-PLAT-5: If-Match is required.
  const ifMatch = c.req.header("If-Match");
  if (!ifMatch) {
    return c.json({ error: "if_match_required" }, 412);
  }

  const expectedVersion = parseInt(ifMatch, 10);
  if (isNaN(expectedVersion) || expectedVersion < 0) {
    return c.json({ error: "if_match_required" }, 412);
  }

  // Parse request body.
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // D-PLAT-4 send-side: internal_inbound_mode enforcement.
  // The recipient inbox is mailboxId. Sender is the authenticated user.
  const policy = await fetchInboxPolicy(c.env, mailboxId);
  if (policy) {
    const mode = policy.internal_inbound_mode;
    if (mode === "none") {
      return c.json({ error: "inbox_policy_rejected" }, 403);
    }
    if (mode === "contacts_only") {
      const isContact = await senderIsContact(c.env, ctx.user_id, mailboxId);
      if (!isContact) {
        return c.json({ error: "inbox_policy_rejected" }, 403);
      }
    }
    // mode === 'everyone' → permit
  }
  // policy === null → permissive (TASK-2.1 not yet integrated)

  // Build message payload.
  const now = new Date().toISOString();
  const message = {
    id: typeof body.id === "string" ? body.id : undefined,
    folder_id:
      typeof body.folder_id === "string" ? body.folder_id : Folders.INBOX,
    subject: typeof body.subject === "string" ? body.subject : null,
    sender: typeof body.sender === "string" ? body.sender : ctx.user_id,
    recipient: typeof body.recipient === "string" ? body.recipient : mailboxId,
    cc: typeof body.cc === "string" ? body.cc : null,
    bcc: typeof body.bcc === "string" ? body.bcc : null,
    date: typeof body.date === "string" ? body.date : now,
    body: typeof body.body === "string" ? body.body : null,
    in_reply_to: typeof body.in_reply_to === "string" ? body.in_reply_to : null,
    email_references:
      typeof body.email_references === "string" ? body.email_references : null,
    message_id: typeof body.message_id === "string" ? body.message_id : null,
    raw_headers: typeof body.raw_headers === "string" ? body.raw_headers : null,
    read: body.read === true,
  };

  const stub = getMailboxStub(c.env, mailboxId);

  try {
    const result = await (stub as unknown as MailboxDO).appendToThread(
      threadId,
      expectedVersion,
      message,
    );
    // Phase v1.1 G-5 / TASK-1.4 — AE emit on message append success.
    // Schema: blobs=[route,actor,outcome] / doubles=[count,latency_ms] / indexes=[ip_or_session_id]
    emitRateLimitEvent(c.env, {
      route: "/api/messages",
      actor: ctx.user_id,
      outcome: "MESSAGE_OK",
      ipOrSessionId: ctx.user_id,
      count: 1,
      latencyMs: Date.now() - t0,
    });
    return c.json(
      {
        id: result.tip_message_id,
        version: result.version,
        tip_message_id: result.tip_message_id,
      },
      201,
    );
  } catch (err) {
    if (err instanceof ThreadNotFoundError) {
      // Phase v1.1 G-5 / TASK-1.4 — AE emit on message append fail.
      emitRateLimitEvent(c.env, {
        route: "/api/messages",
        actor: ctx.user_id,
        outcome: "MESSAGE_FAIL",
        ipOrSessionId: ctx.user_id,
        count: 1,
        latencyMs: Date.now() - t0,
      });
      return c.json({ error: "Thread not found" }, 404);
    }
    if (err instanceof ConflictError) {
      emitRateLimitEvent(c.env, {
        route: "/api/messages",
        actor: ctx.user_id,
        outcome: "MESSAGE_FAIL",
        ipOrSessionId: ctx.user_id,
        count: 1,
        latencyMs: Date.now() - t0,
      });
      return c.json(
        {
          error: "stale",
          current_version: err.current_version,
          current_tip: err.current_tip,
        },
        409,
      );
    }
    emitRateLimitEvent(c.env, {
      route: "/api/messages",
      actor: ctx.user_id,
      outcome: "MESSAGE_FAIL",
      ipOrSessionId: ctx.user_id,
      count: 1,
      latencyMs: Date.now() - t0,
    });
    throw err;
  }
});

export default router;
