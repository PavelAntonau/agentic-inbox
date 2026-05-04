// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface SignatureSettings {
  enabled: boolean;
  text: string;
  html?: string;
}

export interface MailboxSettings {
  fromName?: string;
  forwarding?: { enabled: boolean; email: string };
  signature?: SignatureSettings;
  autoReply?: { enabled: boolean; subject: string; message: string };
  agentSystemPrompt?: string;
}

export interface Mailbox {
  id: string;
  email: string;
  // name may be absent on D1 mailboxes returned by the unified /api/v1/mailboxes
  // endpoint; consumers should fall back to the local part of `email`.
  name?: string;
  // address is the canonical RFC-5321 email address (same as email for most mailboxes).
  // Present on unified /api/v1/mailboxes D1+R2 union responses.
  address?: string;
  // owner_user_id is only present on D1 mailboxes.
  owner_user_id?: string;
  // kind distinguishes D1 (new stack) from R2 (v1 legacy) mailboxes.
  kind?: "d1" | "r2";
  settings?: MailboxSettings;
}

export interface Email {
  id: string;
  thread_id?: string | null;
  folder_id?: string | null;
  subject: string;
  sender: string;
  recipient: string;
  cc?: string;
  bcc?: string;
  date: string;
  read: boolean;
  starred: boolean;
  body?: string | null;
  in_reply_to?: string | null;
  email_references?: string | null;
  message_id?: string | null;
  raw_headers?: string | null;
  attachments?: Attachment[];
  snippet?: string | null;
  // Thread aggregate fields (only present in threaded list view)
  thread_count?: number;
  thread_unread_count?: number;
  participants?: string;
  needs_reply?: boolean;
  has_draft?: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  mimetype: string;
  size: number;
  content_id?: string;
  disposition?: string;
}

export interface Folder {
  id: string;
  name: string;
  unreadCount: number;
}
