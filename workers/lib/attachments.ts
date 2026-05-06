// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 *
 * Phase C3 / C3.4 (D-04 hardening): every attachment now passes a MIME
 * allowlist + 10 MB decoded-size cap before it ever touches R2. Active
 * web payloads (`text/html`, `text/javascript`, `application/xhtml+xml`,
 * SVG with embedded scripts) are refused outright. The serve path
 * (`workers/index.ts` GET attachments handler) is expected to add
 * `X-Content-Type-Options: nosniff` so a stored file CAN'T be coerced
 * into an active type by client sniffing — both layers together close
 * the stored-XSS-via-attachment vector.
 */
import type { Env } from "../types";

export interface StoredAttachment {
  id: string;
  email_id: string;
  filename: string;
  mimetype: string;
  size: number;
  content_id: string | null;
  disposition: string;
}

/**
 * 10 MB cap on the DECODED size of a single attachment. Phase C3 / C3.4.
 *
 * Why decoded, not encoded: base64 inflates by ~1.33×. A 10 MB encoded
 * blob decodes to ~7.5 MB, which is the bound that actually matters for
 * R2 + DO state size. We accept up to 10 MB after `atob`.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * MIME allowlist for stored attachments. Anything not in this set is
 * refused. Picked to match what real users send (images, PDFs,
 * spreadsheets, Office docs, archives) while excluding every active
 * web type that browsers sniff into executing.
 */
export const ATTACHMENT_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  // Images (rendered by the browser as data, NOT as code path)
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
  // PDFs (handled by the browser PDF viewer; same-origin sandbox)
  "application/pdf",
  // Plain text + CSV (treated as data when nosniff is set)
  "text/plain",
  "text/csv",
  // Microsoft Office — old + new formats
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-powerpoint",
  // Archives + opaque binary blobs (data, not code)
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);

/**
 * MIME types that are HARD-REFUSED even if they accidentally match
 * something in the allowlist or arrive with a sniff-resistant Content-
 * Type. These are the well-known stored-XSS vectors.
 */
export const ATTACHMENT_MIME_DENYLIST: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
  // SVG can embed <script> — accept it ONLY if the user later opts in
  // explicitly via a workspace setting; default deny.
  "image/svg+xml",
  // Server-side embedding chains
  "text/x-php",
  "application/x-php",
]);

export class AttachmentRejectedError extends Error {
  constructor(
    public readonly reason:
      | "mime_denied"
      | "mime_not_in_allowlist"
      | "size_exceeded"
      | "decode_failed",
    public readonly detail: string,
  ) {
    super(`Attachment rejected: ${reason} — ${detail}`);
    this.name = "AttachmentRejectedError";
  }
}

/**
 * Pure validator — no I/O. Returns the decoded byte array on success,
 * throws `AttachmentRejectedError` on any policy violation. Exported so
 * tests can exercise the predicate without R2 in the loop.
 */
export function validateAndDecodeAttachment(att: {
  content: string;
  filename?: string;
  type: string;
}): Uint8Array {
  // Normalize the MIME type — strip parameters (`charset=utf-8`) and
  // lowercase. Real-world MIME headers carry a soup of params.
  const rawType = (att.type || "").trim().toLowerCase();
  const baseType = rawType.split(";", 1)[0].trim();

  if (ATTACHMENT_MIME_DENYLIST.has(baseType)) {
    throw new AttachmentRejectedError(
      "mime_denied",
      `MIME type '${baseType}' is on the denylist (active web payload — stored-XSS vector).`,
    );
  }

  if (!ATTACHMENT_MIME_ALLOWLIST.has(baseType)) {
    throw new AttachmentRejectedError(
      "mime_not_in_allowlist",
      `MIME type '${baseType}' is not in the attachment allowlist. ` +
        `Permitted types: images (png/jpeg/gif/webp/heic/heif/bmp/tiff), ` +
        `application/pdf, text/plain, text/csv, MS Office (doc/docx/xls/xlsx/ppt/pptx), ` +
        `application/zip, application/octet-stream.`,
    );
  }

  // Defensively bound the encoded length BEFORE atob so a 1 GB base64
  // payload doesn't OOM the worker before the size check fires. atob
  // result is ~75% of input; encoded > MAX*1.34 means decoded > MAX.
  const ENCODED_HARD_CAP = Math.ceil(MAX_ATTACHMENT_BYTES * 1.34) + 16;
  if (att.content.length > ENCODED_HARD_CAP) {
    throw new AttachmentRejectedError(
      "size_exceeded",
      `Encoded length ${att.content.length} bytes exceeds the cap (decoded would exceed ${MAX_ATTACHMENT_BYTES} bytes).`,
    );
  }

  let bytes: Uint8Array;
  try {
    const binaryStr = atob(att.content);
    bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
  } catch (err) {
    throw new AttachmentRejectedError(
      "decode_failed",
      `base64 decode failed: ${(err as Error).message ?? "unknown"}`,
    );
  }

  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentRejectedError(
      "size_exceeded",
      `Decoded size ${bytes.byteLength} bytes exceeds the ${MAX_ATTACHMENT_BYTES} byte cap.`,
    );
  }

  return bytes;
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 *
 * Throws `AttachmentRejectedError` synchronously (before any R2 write)
 * if any attachment fails validation. The callers
 * (`workers/index.ts` and `workers/routes/reply-forward.ts`) treat the
 * throw as a 4xx; failing one attachment fails the whole batch by
 * design — partial-store would leave R2 with orphaned blobs.
 */
export async function storeAttachments(
  bucket: Env["BUCKET"],
  emailId: string,
  attachments?: {
    content: string;
    filename: string;
    type: string;
    disposition: string;
    contentId?: string;
  }[],
): Promise<StoredAttachment[]> {
  if (!attachments?.length) return [];

  // Validate ALL attachments first — pure CPU work, no R2 round trips.
  // If any fails we throw before writing anything.
  const decoded: Uint8Array[] = [];
  for (const att of attachments) {
    decoded.push(validateAndDecodeAttachment(att));
  }

  const results: StoredAttachment[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const bytes = decoded[i];
    const attachmentId = crypto.randomUUID();
    // Sanitize filename to prevent path traversal in R2 keys
    const safeFilename = (att.filename || "untitled").replace(
      /[\/\\:*?"<>|\x00-\x1f]/g,
      "_",
    );
    const key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;
    await bucket.put(key, bytes);
    results.push({
      id: attachmentId,
      email_id: emailId,
      filename: safeFilename,
      mimetype: (att.type || "").trim().toLowerCase().split(";", 1)[0].trim(),
      size: bytes.byteLength,
      content_id: att.contentId || null,
      disposition: att.disposition,
    });
  }
  return results;
}
