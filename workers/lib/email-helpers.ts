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

// ── Inbound auth (SPF / DKIM / DMARC) — Phase C3 / C3.13 (P2-7) ────

/**
 * Result of evaluating an inbound email's `Authentication-Results`
 * header. CF Email Routing prepends an `Authentication-Results: ...`
 * line to every received message; this helper parses it.
 */
export interface InboundAuthVerdict {
  spf:
    | "pass"
    | "fail"
    | "softfail"
    | "neutral"
    | "none"
    | "temperror"
    | "permerror"
    | "unknown";
  dkim:
    | "pass"
    | "fail"
    | "neutral"
    | "none"
    | "temperror"
    | "permerror"
    | "unknown";
  dmarc: "pass" | "fail" | "none" | "temperror" | "permerror" | "unknown";
  /** True when the message MUST be refused (dmarc=fail OR both spf+dkim=fail). */
  reject: boolean;
  /** Human-readable summary for audit / log lines. */
  summary: string;
}

/**
 * Parse an `Authentication-Results` header value (or undefined when
 * absent) into a verdict. Tolerant to missing / malformed input —
 * `unknown` outcomes never trigger a reject.
 *
 * Decision policy (per the security audit P2-7):
 *
 *   - `dmarc=fail`                      → reject (the upstream
 *     domain has explicitly published a policy that says this
 *     message is forged; honour it).
 *   - `spf=fail` AND `dkim=fail`        → reject (both auth methods
 *     failed independently; very strong forgery signal).
 *   - any single soft-fail              → log + accept (audit trail
 *     keeps the record; we don't break legitimate inbound mail).
 *   - missing header / unknown outcomes → fail-OPEN, log a warn.
 *     Breaking inbound mail entirely is worse than admitting that
 *     CF Email Routing didn't surface a verdict on this hop.
 */
export function parseInboundAuthHeader(
  authResults: string | null | undefined,
): InboundAuthVerdict {
  const normalized = (authResults ?? "").toString();
  const find = (
    name: string,
  ):
    | InboundAuthVerdict["spf"]
    | InboundAuthVerdict["dkim"]
    | InboundAuthVerdict["dmarc"] => {
    const re = new RegExp(`\\b${name}\\s*=\\s*([a-zA-Z]+)`, "i");
    const m = normalized.match(re);
    if (!m) return "unknown";
    const v = m[1].toLowerCase();
    if (
      v === "pass" ||
      v === "fail" ||
      v === "softfail" ||
      v === "neutral" ||
      v === "none" ||
      v === "temperror" ||
      v === "permerror"
    ) {
      return v as InboundAuthVerdict["spf"];
    }
    return "unknown";
  };

  const spf = find("spf");
  const dkim = find("dkim");
  const dmarc = find("dmarc");

  let reject = false;
  if (dmarc === "fail") reject = true;
  if (spf === "fail" && dkim === "fail") reject = true;

  const summary = `spf=${spf} dkim=${dkim} dmarc=${dmarc}${reject ? " (rejected)" : ""}`;
  return { spf, dkim, dmarc, reject, summary };
}

/**
 * Convenience entry point — accepts a `parsedEmail.headers` map (the
 * shape PostalMime returns) or anything case-insensitively keyable to
 * `Authentication-Results`. Returns the same verdict object.
 */
export function verifyInboundAuth(
  headers: Record<string, string | undefined> | undefined | null,
): InboundAuthVerdict {
  if (!headers) return parseInboundAuthHeader(undefined);
  // Case-insensitive lookup — PostalMime can hand back `Authentication-Results`,
  // `authentication-results`, or both.
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "authentication-results") {
      return parseInboundAuthHeader(headers[k]);
    }
  }
  return parseInboundAuthHeader(undefined);
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

// ── Email-body sanitization (Phase C3 / C3.7, P2-D-2) ──────────────
//
// Server-side allowlist sanitizer. The DOM-based DOMPurify library is
// not usable in the Workers runtime (no document, no DOM), so this
// implementation is a hand-rolled tag/attribute allowlist that runs over
// raw HTML strings. It is the FOURTH layer of defense after:
//
//   1. Outbound `verifyDraft` (LLM cleanse + diff log)
//   2. Inbound iframe sandbox (UI defense — blocks scripts at render time)
//   3. Inline-quote `stripHtmlToText` (when injecting old-message bodies
//      into new compose context)
//
// Layer 4 fires at STORAGE time on both:
//
//   - Inbound `parsedEmail.html` (workers/index.ts receiveEmail), so the
//     stored body never contains a stored-XSS payload, even if the
//     sandbox iframe is later relaxed or the body is rendered in a new
//     surface (admin observability, audit-log, AI tool prompts).
//   - Outbound `bodyHtml` (lib/tools.ts toolSendEmail / toolSendReply,
//     lib/internal-delivery.ts deliverInternal), defending against
//     compose-side injection paths the LLM cleanse missed.
//
// Allowlist intentionally errs conservative — we keep the formatting
// tags real users send (paragraphs, lists, blockquotes, basic
// formatting, tables for newsletters/receipts, images for inline
// pictures) and drop everything else.

const SANITIZE_TAG_ALLOWLIST: ReadonlySet<string> = new Set([
  "a",
  "p",
  "div",
  "span",
  "br",
  "hr",
  "b",
  "i",
  "u",
  "em",
  "strong",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "img",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "small",
  "sup",
  "sub",
]);

const SANITIZE_ATTR_ALLOWLIST: ReadonlySet<string> = new Set([
  "href",
  "src",
  "alt",
  "title",
  "style",
  "width",
  "height",
  "colspan",
  "rowspan",
  "align",
]);

// Tags whose ENTIRE contents are dropped (script bodies, style sheets,
// embedded objects, iframes). Closing tag is also removed.
const SANITIZE_DESTRUCTIVE_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "frame",
  "frameset",
  "noscript",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "applet",
  "meta",
  "link",
]);

// `style` attribute deny-substrings (case-insensitive). Drops the entire
// style attribute if any of these appear; we don't try to surgically
// edit a CSS declaration list because the parser surface for that is
// nontrivial and the false-positive rate is tolerable for email bodies.
const STYLE_DENY_PATTERNS = [
  /javascript:/i,
  /expression\s*\(/i,
  /url\s*\(\s*["']?\s*javascript:/i,
  /url\s*\(\s*["']?\s*data:text\/html/i,
  /-moz-binding/i,
  /behavior\s*:/i,
  /@import/i,
];

/**
 * Returns true when the given URL is safe for an `href` or `src`. Allows
 * `http(s):`, `mailto:`, `cid:` (inline images), and protocol-relative
 * + absolute-path forms. Refuses `javascript:`, `data:` (except images),
 * `file:`, `vbscript:`, etc.
 */
function isSafeUrl(url: string, attrName: "href" | "src" | string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  // Strip control characters that browsers helpfully ignore inside URL schemes.
  // eslint-disable-next-line no-control-regex
  const stripped = trimmed.replace(/[\x00-\x1f\x7f]/g, "").toLowerCase();
  if (
    stripped.startsWith("javascript:") ||
    stripped.startsWith("vbscript:") ||
    stripped.startsWith("file:")
  ) {
    return false;
  }
  // data: is allowed only as `data:image/...` for `src`. data:text/html
  // is the classic stored-XSS vector.
  if (stripped.startsWith("data:")) {
    if (attrName !== "src") return false;
    return /^data:image\/(png|jpeg|jpg|gif|webp|bmp);base64,/i.test(stripped);
  }
  return true;
}

/**
 * Sanitize an HTML email body using a fixed tag/attribute allowlist.
 *
 * Pure CPU; no I/O. Idempotent (sanitize(sanitize(x)) === sanitize(x)).
 *
 * Returns "" when the input is null/undefined/empty so callers can pass
 * a possibly-missing body without a guard.
 */
export function sanitizeEmailHtml(input: string | null | undefined): string {
  if (typeof input !== "string" || input.length === 0) return "";

  let html = input;

  // 1. Drop destructive tags + their contents in one sweep. Includes
  // unclosed cases ("<script ... <p>") — replace up to the next `</tag>`
  // OR end of input.
  for (const tag of SANITIZE_DESTRUCTIVE_TAGS) {
    const re = new RegExp(
      `<\\s*${tag}\\b[^>]*>([\\s\\S]*?)<\\s*/\\s*${tag}\\s*>`,
      "gi",
    );
    html = html.replace(re, "");
    // self-closing or unterminated forms — drop the open tag.
    const reOpen = new RegExp(`<\\s*${tag}\\b[^>]*/?>`, "gi");
    html = html.replace(reOpen, "");
  }

  // 2. Drop HTML comments — they can hide IE conditional script
  // execution and just generally aren't useful in stored bodies.
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  // 3. Walk every remaining tag and apply the tag/attribute allowlist.
  // Two regex passes: one for opening + self-closing, one for closing.
  html = html.replace(
    /<\s*\/\s*([a-zA-Z][a-zA-Z0-9]*)\s*>/g,
    (_m, name: string) => {
      const lc = name.toLowerCase();
      if (!SANITIZE_TAG_ALLOWLIST.has(lc)) return "";
      return `</${lc}>`;
    },
  );

  html = html.replace(
    /<\s*([a-zA-Z][a-zA-Z0-9]*)\s*([^>]*?)(\/?)\s*>/g,
    (_m, name: string, attrs: string, selfClose: string) => {
      const lc = name.toLowerCase();
      if (!SANITIZE_TAG_ALLOWLIST.has(lc)) return "";

      // Parse attrs: name=("..."|'...'|bare), space-separated. Tolerant
      // to malformed input; unknown shapes get dropped.
      const cleaned: string[] = [];
      const attrRe =
        /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
      let match: RegExpExecArray | null;
      while ((match = attrRe.exec(attrs)) !== null) {
        const rawName = match[1].toLowerCase();
        const value = match[2] ?? match[3] ?? match[4] ?? "";

        // Drop event handlers wholesale (onclick, onerror, onload, …).
        if (rawName.startsWith("on")) continue;
        // xmlns and xml:* attributes can be used to smuggle SVG-script
        // namespaces; drop wholesale.
        if (rawName.startsWith("xmlns") || rawName.startsWith("xml:")) continue;
        if (!SANITIZE_ATTR_ALLOWLIST.has(rawName)) continue;

        // URL-bearing attrs: validate the protocol.
        if (rawName === "href" || rawName === "src") {
          if (!isSafeUrl(value, rawName)) continue;
        }

        // `style`: drop the whole attr if any deny-pattern fires.
        if (rawName === "style") {
          if (STYLE_DENY_PATTERNS.some((p) => p.test(value))) continue;
        }

        // Re-encode quotes in the value to prevent attribute-context escape.
        const escaped = value
          .replace(/"/g, "&quot;")
          .replace(/&(?!(?:amp|quot|apos|lt|gt|#)\b)/g, "&amp;");
        cleaned.push(`${rawName}="${escaped}"`);
      }

      const sc = selfClose ? "/" : "";
      return cleaned.length > 0
        ? `<${lc} ${cleaned.join(" ")}${sc}>`
        : `<${lc}${sc}>`;
    },
  );

  return html;
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
