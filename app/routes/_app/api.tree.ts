// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Loader for the MailboxTreeRail — returns { groups, private, followed }.
// This is a server-rendered loader so the rail data is available on first
// paint without a client-side waterfall.

import type { Route } from "./+types/api.tree";

export interface MailboxNode {
  id: string;
  address: string;
  display_name: string | null;
  owner_user_id: string;
  created_at: number;
}

export interface GroupNode {
  id: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  actor_role: "owner" | "admin" | "member" | null;
}

export interface MailboxTreePayload {
  groups: Array<{ group: GroupNode; mailboxes: MailboxNode[] }>;
  private: MailboxNode[];
  followed: MailboxNode[];
}

export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  const res = await fetch(
    new Request(new URL("/_internal/mailbox-tree", "http://localhost").href, {
      headers: { "x-internal-tree": "1" },
    }),
  ).catch(() => null);

  // The loader calls the /api/mailboxes/tree worker endpoint directly.
  // In SSR context we have no direct DB access from route loaders — we call
  // the API as a fetch so the authzContext middleware runs normally.
  // The request is made server-side so cookies are forwarded automatically
  // by the runtime (same origin).
  //
  // For the initial shell render we return a lightweight empty payload if
  // the fetch cannot resolve (e.g. during static prerender); the client
  // refetches via React Query.
  if (!res || !res.ok) {
    return {
      groups: [],
      private: [],
      followed: [],
    } satisfies MailboxTreePayload;
  }

  return (await res.json()) as MailboxTreePayload;
}
