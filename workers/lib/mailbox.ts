// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 *
 * Resolution order for `:mailboxId`:
 *   1. D1 `mailboxes` table — matches on `id` (UUID) OR `address` (case-insensitive).
 *      When found, sets `resolvedMailboxAddress` (for DO stub creation) and
 *      `resolvedMailboxId` (D1 UUID) on the context.
 *   2. R2 bucket — legacy v1 path. The segment is treated as the email address.
 *
 * This unifies the two mailbox stacks at the request layer with no client churn.
 * UUID-form IDs from D1-backed mailboxes now resolve transparently to the correct
 * DO address without requiring the client to know the address.
 */
import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import { or, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";

export type MailboxContext = {
  Bindings: Env;
  Variables: {
    mailboxStub: DurableObjectStub<MailboxDO>;
    /** Resolved email address — used to create the DO stub. Always set. */
    resolvedMailboxAddress: string;
    /** D1 mailbox UUID — set when the mailbox was found in D1, undefined for R2-only. */
    resolvedMailboxId?: string;
  };
};

export const requireMailbox = createMiddleware<MailboxContext>(
  async (c, next) => {
    const rawId = c.req.param("mailboxId");
    if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
    const mailboxId = decodeURIComponent(rawId);

    // ── Step 1: D1 lookup (resolves both UUID and address forms) ─────────────
    if (c.env.DB) {
      const orm = drizzle(c.env.DB, { schema });
      const row = await orm
        .select({ id: schema.mailboxes.id, address: schema.mailboxes.address })
        .from(schema.mailboxes)
        .where(
          or(
            eq(schema.mailboxes.id, mailboxId),
            eq(
              sql`lower(${schema.mailboxes.address})`,
              mailboxId.toLowerCase(),
            ),
          ),
        )
        .get();

      if (row) {
        const ns = c.env.MAILBOX;
        const doId = ns.idFromName(row.address);
        const stub = ns.get(doId);
        c.set("mailboxStub", stub);
        c.set("resolvedMailboxAddress", row.address);
        c.set("resolvedMailboxId", row.id);
        return next();
      }
    }

    // ── Step 2: R2 fallback (legacy v1 — address-only) ──────────────────────
    const key = `mailboxes/${mailboxId}.json`;
    const obj = await c.env.BUCKET.head(key);
    if (!obj) {
      return c.json({ error: "Not found" }, 404);
    }

    const ns = c.env.MAILBOX;
    const id = ns.idFromName(mailboxId);
    const stub = ns.get(id);
    c.set("mailboxStub", stub);
    c.set("resolvedMailboxAddress", mailboxId);

    await next();
  },
);
