// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Single source of truth for the primary mail domain. New personal
// mailboxes are HARDCODED to this domain — the user types only the
// local-part; the suffix is non-editable on the client and validated
// on the server.

export const PRIMARY_MAIL_DOMAIN = "actionnow.ai";

// Local-part format. Pragmatic subset of RFC 5321:
//   - allowed characters: a-z 0-9 . _ + -
//   - 1..64 chars
//   - no leading/trailing dot
//   - no consecutive dots
const LOCAL_PART_RE = /^(?!\.)(?!.*\.\.)[a-z0-9._+\-]{1,64}(?<!\.)$/;

export function isValidLocalPart(s: string): boolean {
  return LOCAL_PART_RE.test(s);
}

export function composeAddress(localPart: string): string {
  return `${localPart.trim().toLowerCase()}@${PRIMARY_MAIL_DOMAIN}`;
}

export function addressIsPrimaryDomain(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at < 0) return false;
  return address.slice(at + 1).toLowerCase() === PRIMARY_MAIL_DOMAIN;
}

export function localPartFromAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  return address.slice(0, at);
}
