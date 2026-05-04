// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared email helpers to eliminate duplication across API routes, MCP, and agent.
 *
 * Includes: DO stub helpers, sender validation, message-ID generation,
 * threading, HTML utilities, and tool-logic (getFullEmail / getFullThread).
 */
import { drizzle } from "drizzle-orm/d1";
import { eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { MailboxDO } from "../durableObject";
import type { EmailFull } from "./schemas";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { formatQuotedDate } from "../../shared/dates";
import * as schema from "../db/control-plane/schema";

// ── DO Stub ────────────────────────────────────────────────────────

/**
 * Resolve a MailboxDO stub from a mailbox email address.
 * Replaces the repeated 3-line ns.idFromName / ns.get pattern.
 */
export function getMailboxStub(
  env: Env,
  mailboxId: string,
): DurableObjectStub<MailboxDO> {
  const ns = env.MAILBOX;
  const id = ns.idFromName(mailboxId);
  return ns.get(id);
}

// ── Mailbox Listing ────────────────────────────────────────────────

/**
 * List mailboxes from both the D1 control-plane and the legacy R2 bucket,
 * returning a unified deduplicated list.
 *
 * - When `authzContext` is provided, D1 results are filtered to only the
 *   mailboxes in `authzContext.authorized_mailbox_ids` (JWT-gated path used
 *   by MCP and authenticated API routes).
 * - When `authzContext` is absent, ALL D1 mailboxes are returned (trusted
 *   internal callers such as admin routes or tests).
 * - R2-only mailboxes (legacy v1) are always appended after D1 results.
 * - On address collision (same lowercase address in both stores) the D1 row
 *   wins and the R2 object is dropped.
 *
 * The returned shape is a superset of the old R2-only `{ id, email }` so
 * existing callers continue to work without changes.
 */
export async function listMailboxes(
  bucketOrEnv: R2Bucket | Env,
  authzContext?: import("../db/control-plane/forGroup").AuthzContext,
): Promise<
  {
    id: string;
    email: string;
    address: string;
    owner_user_id?: string;
    kind: "d1" | "r2";
  }[]
> {
  // Support both the legacy `listMailboxes(bucket)` call-style (workers/index.ts)
  // and the new `listMailboxes(env, authzContext)` call-style (tools.ts / mcp).
  // Distinguish: R2Bucket has a `.list` method; Env has `.BUCKET`.
  const bucket: R2Bucket =
    "BUCKET" in bucketOrEnv
      ? (bucketOrEnv as Env).BUCKET
      : (bucketOrEnv as R2Bucket);
  const db: D1Database | undefined =
    "DB" in bucketOrEnv ? (bucketOrEnv as Env).DB : undefined;

  const results: {
    id: string;
    email: string;
    address: string;
    owner_user_id?: string;
    kind: "d1" | "r2";
  }[] = [];

  // Seen set keyed by lowercase address — D1 rows are inserted first so they
  // win on collision.
  const seen = new Set<string>();

  // ── D1 path ────────────────────────────────────────────────────────────────
  if (db) {
    const orm = drizzle(db, { schema });

    let d1Rows: (typeof schema.mailboxes.$inferSelect)[];

    if (authzContext && authzContext.authorized_mailbox_ids.length > 0) {
      // JWT-filtered: only return mailboxes the caller is authorized for.
      d1Rows = await orm
        .select()
        .from(schema.mailboxes)
        .where(
          inArray(schema.mailboxes.id, authzContext.authorized_mailbox_ids),
        )
        .all();
    } else if (authzContext) {
      // Caller is authenticated but has no authorized mailboxes — return empty.
      d1Rows = [];
    } else {
      // No authzContext — trusted internal caller; return everything.
      d1Rows = await orm.select().from(schema.mailboxes).all();
    }

    for (const row of d1Rows) {
      const key = row.address.toLowerCase();
      seen.add(key);
      results.push({
        id: row.id,
        email: row.address,
        address: row.address,
        owner_user_id: row.owner_user_id,
        kind: "d1",
      });
    }
  }

  // ── R2 path (legacy v1) ────────────────────────────────────────────────────
  const list = await bucket.list({ prefix: "mailboxes/" });
  for (const obj of list.objects) {
    const address = obj.key.replace("mailboxes/", "").replace(".json", "");
    const key = address.toLowerCase();
    if (seen.has(key)) continue; // D1 row already covers this address
    seen.add(key);
    results.push({
      id: address,
      email: address,
      address,
      kind: "r2",
    });
  }

  return results;
}

// ── Backend Resolution ─────────────────────────────────────────────

/**
 * Resolve a destination email address to its backing storage:
 *   - "d1" → present in the control-plane mailboxes table.
 *   - "r2" → present in the legacy R2 v1 bucket only.
 *   - null → external (not one of our mailboxes).
 *
 * D1 wins on collisions: if the same address is registered in both, the D1
 * row is returned. The D1 lookup uses lower(address) to match the
 * mailboxes_address_nocase unique index.
 *
 * Used by toolSendEmail / toolSendReply (workers/lib/tools.ts) to decide
 * whether to short-circuit through deliverInternal() or fall through to
 * Cloudflare Email Routing. Phase 2's TASK-2.1 will reuse it for the
 * D1+R2 union list_mailboxes path.
 */
export async function resolveMailboxBackend(
  env: Env,
  address: string,
): Promise<
  | { kind: "d1"; row: typeof schema.mailboxes.$inferSelect }
  | { kind: "r2"; row: { id: string; address: string } }
  | null
> {
  const lowered = address.toLowerCase();

  if (env.DB) {
    const orm = drizzle(env.DB, { schema });
    const row = await orm
      .select()
      .from(schema.mailboxes)
      .where(eq(sql`lower(${schema.mailboxes.address})`, lowered))
      .get();
    if (row) return { kind: "d1", row };
  }

  if (env.BUCKET) {
    const head = await env.BUCKET.head(`mailboxes/${lowered}.json`);
    if (head) {
      return { kind: "r2", row: { id: lowered, address: lowered } };
    }
  }

  return null;
}

/**
 * Read the source mailbox's external_send_enabled flag from the D1 control
 * plane. Returns:
 *   - true / false  → source mailbox exists in D1, with that flag value.
 *   - undefined     → source mailbox is not in D1 (legacy v1 R2-only mailbox);
 *                     callers treat this as "internal-only by default".
 */
export async function readSourceExternalSendEnabled(
  env: Env,
  fromAddress: string,
): Promise<boolean | undefined> {
  if (!env.DB) return undefined;
  const lowered = fromAddress.toLowerCase();
  const orm = drizzle(env.DB, { schema });
  const row = await orm
    .select({
      external_send_enabled: schema.mailboxes.external_send_enabled,
    })
    .from(schema.mailboxes)
    .where(eq(sql`lower(${schema.mailboxes.address})`, lowered))
    .get();
  return row?.external_send_enabled;
}

// ── Sender Validation ──────────────────────────────────────────────

/**
 * Normalise to/from addresses and validate the sender matches the mailbox.
 * Returns the normalised values or throws with a user-facing message.
 */
export function validateSender(
  to: string | string[],
  from: string | { email: string; name: string },
  mailboxId: string,
): { toStr: string; fromEmail: string; fromDomain: string } {
  const toStr = (Array.isArray(to) ? to.join(", ") : to).toLowerCase();
  const fromEmail = (
    typeof from === "string" ? from : from.email
  ).toLowerCase();

  if (fromEmail !== mailboxId.toLowerCase()) {
    throw new SenderValidationError(
      "From address must match the mailbox email address",
    );
  }

  const fromDomain = fromEmail.split("@")[1];
  if (!fromDomain) {
    throw new SenderValidationError("Invalid sender email address");
  }

  return { toStr, fromEmail, fromDomain };
}

export class SenderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SenderValidationError";
  }
}

// ── Message ID ─────────────────────────────────────────────────────

/**
 * Generate an internal UUID and a proper RFC 2822 Message-ID.
 */
export function generateMessageId(fromDomain: string): {
  messageId: string;
  outgoingMessageId: string;
} {
  const messageId = crypto.randomUUID();
  const outgoingMessageId = `${messageId}@${fromDomain}`;
  return { messageId, outgoingMessageId };
}

// ── Threading ──────────────────────────────────────────────────────

/**
 * Build the References chain and In-Reply-To from an original email.
 */
export function buildReferencesChain(original: EmailFull): {
  originalMsgId: string;
  references: string[];
  threadId: string;
} {
  const originalMsgId = original.message_id || original.id;
  let existingRefs: string[] = [];
  if (original.email_references) {
    try {
      existingRefs = JSON.parse(original.email_references);
    } catch {
      // Malformed JSON in email_references — treat as empty
    }
  }
  const references = [...existingRefs, originalMsgId].filter(Boolean);
  const threadId = original.thread_id || original.id;
  return { originalMsgId, references, threadId };
}

/**
 * Build threading headers (In-Reply-To + References) for the email binding.
 */
export function buildThreadingHeaders(
  originalMsgId: string,
  references: string[],
): Record<string, string> {
  return {
    "In-Reply-To": `<${originalMsgId}>`,
    ...(references.length > 0
      ? { References: references.map((r) => `<${r}>`).join(" ") }
      : {}),
  };
}

// ── Draft-follows-in_reply_to ──────────────────────────────────────

/**
 * If the given email is a draft with an in_reply_to, resolve the real original.
 * Used by reply/forward routes to avoid threading against the draft itself.
 */
export async function resolveOriginalEmail(
  stub: DurableObjectStub<MailboxDO>,
  email: EmailFull,
): Promise<EmailFull> {
  if (email.folder_id === Folders.DRAFT && email.in_reply_to) {
    const realOriginal = (await stub.getEmail(
      email.in_reply_to,
    )) as EmailFull | null;
    if (realOriginal) return realOriginal;
  }
  return email;
}

// ── HTML Utilities ─────────────────────────────────────────────────

/**
 * Escape all five OWASP-recommended HTML special characters in plain text.
 * Safe for use in both text content and attribute contexts.
 */
export function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convert plain text to a simple HTML block with preserved whitespace.
 * Uses both `white-space:pre-wrap` (modern clients) and `<br>` tags
 * (clients that strip inline styles, e.g. Outlook) as a belt-and-suspenders approach.
 */
export function textToHtml(text: string): string {
  if (!text) return "";
  const escaped = escapeHtml(text).replace(/\n/g, "<br>");
  return `<div style="white-space:pre-wrap">${escaped}</div>`;
}

/**
 * Strip HTML tags and normalize whitespace to produce plain text.
 * Removes <style> and <script> blocks first to avoid injecting their
 * content into the output.
 */
export function stripHtmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Format a date string for use in quoted reply blocks.
 * @deprecated Use `formatQuotedDate` from `shared/dates` directly.
 */
export const formatEmailDate = formatQuotedDate;

/**
 * Build a quoted reply block HTML string from original email data.
 */
export function buildQuotedReplyBlock(original: {
  date?: string;
  sender?: string;
  body?: string;
}): string {
  if (!original.body) return "";

  // HTML-escape sender and date to prevent injection
  const originalSender = escapeHtml(original.sender || "unknown");
  const originalDate = escapeHtml(formatEmailDate(original.date || ""));

  // Sanitize the body to plain text to prevent stored XSS.
  // The original HTML renders safely in the sandboxed iframe, but quoted
  // reply blocks are injected into the compose editor and outgoing emails
  // where raw HTML would execute. Convert to escaped plain text instead.
  const plainBody = stripHtmlToText(original.body);
  const bodyToQuote = escapeHtml(plainBody).replace(/\n/g, "<br>");

  return `<br><blockquote style="border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;">On ${originalDate}, ${originalSender} wrote:<br><br>${bodyToQuote}</blockquote>`;
}

// ── Tool Logic (getFullEmail / getFullThread) ──────────────────────

type MailboxThreadReaderStub = {
  getThreadEmails: (threadId: string) => Promise<EmailFull[]>;
};

/**
 * Fetch a single email and return it with both HTML and plain-text body.
 * Returns null if the email is not found.
 */
export async function getFullEmail(
  stub: DurableObjectStub<MailboxDO>,
  emailId: string,
) {
  const email = (await stub.getEmail(emailId)) as EmailFull | null;
  if (!email) return null;

  const textBody = email.body ? stripHtmlToText(email.body) : "";
  return { ...email, body_text: textBody, body_html: email.body };
}

/**
 * Fetch all emails in a thread with full bodies in a single DO call.
 * Uses `getThreadEmails` which runs 2 SQL queries (emails + attachments)
 * instead of the previous N+1 pattern (1 list query + N getEmail calls).
 */
export async function getFullThread(
  stub: DurableObjectStub<MailboxDO>,
  threadId: string,
) {
  const threadStub = stub as unknown as MailboxThreadReaderStub;
  const emails = await threadStub.getThreadEmails(threadId);

  const enriched = emails.map((email) => {
    const textBody = email.body ? stripHtmlToText(email.body) : "";
    return { ...email, body_text: textBody };
  });

  // Already sorted ASC by the DO query, but ensure consistency
  enriched.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  return {
    thread_id: threadId,
    message_count: enriched.length,
    messages: enriched,
  };
}
