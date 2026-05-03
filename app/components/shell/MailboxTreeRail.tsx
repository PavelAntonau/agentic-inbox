// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// MailboxTreeRail — left-rail Outlook-style mailbox tree.
//
// Sections (in order):
//   1. Per-group sections with collapsible mailbox lists
//   2. "Private" section — mailboxes not in any group
//   3. "Followed" section — mailboxes followed via ACL but not owned
//
// Data is fetched from GET /api/mailboxes/tree via React Query.
// The actor identity is fetched from GET /api/admin/me (already wired in Header).
//
// Phase 3d layout: title row at top with the "+ New mailbox" CTA directly
// underneath; bottom-of-rail CTA removed; empty state collapsed to a single
// italic "No mailboxes yet" line (the duplicate logo was visually redundant
// with the header logo).

import { Loader, Button } from "~/ui";
import {
  EyeIcon,
  LockIcon,
  MailboxIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink } from "react-router";
import GroupSection from "~/components/shell/GroupSection";
import MailboxNode from "~/components/shell/MailboxNode";
import CreateMailboxDialog from "~/components/mailbox/CreateMailboxDialog";
import type { MailboxTreePayload } from "~/routes/_app/api.tree";

const TREE_QUERY_KEY = ["mailbox-tree"] as const;

async function fetchTree(): Promise<MailboxTreePayload> {
  const res = await fetch("/api/mailboxes/tree");
  if (!res.ok) throw new Error(`tree fetch failed: ${res.status}`);
  return res.json() as Promise<MailboxTreePayload>;
}

async function fetchMe(): Promise<{
  user_id: string;
  role: "global_owner" | "global_admin" | "user";
}> {
  const res = await fetch("/api/admin/me");
  if (!res.ok) return { user_id: "", role: "user" };
  return res.json() as Promise<{
    user_id: string;
    role: "global_owner" | "global_admin" | "user";
  }>;
}

export default function MailboxTreeRail() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: tree, isLoading: treeLoading } = useQuery({
    queryKey: TREE_QUERY_KEY,
    queryFn: fetchTree,
    staleTime: 30_000,
  });

  const { data: me } = useQuery({
    queryKey: ["admin-me"],
    queryFn: fetchMe,
    staleTime: 60_000,
  });

  const actorUserId = me?.user_id ?? "";
  const actorRole = me?.role ?? "user";

  const handleMutated = () => {
    qc.invalidateQueries({ queryKey: TREE_QUERY_KEY });
  };

  if (treeLoading) {
    return (
      <div className="flex items-center justify-center p-6">
        <Loader size="sm" />
      </div>
    );
  }

  const groups = tree?.groups ?? [];
  const privateMailboxes = tree?.private ?? [];
  const followedMailboxes = tree?.followed ?? [];
  const isEmpty =
    groups.length === 0 &&
    privateMailboxes.length === 0 &&
    followedMailboxes.length === 0;

  return (
    <nav
      aria-label="Mailbox tree"
      className="flex flex-col gap-1 p-2 h-full overflow-y-auto"
    >
      {/* Title row — bigger than before, with the duotone mailbox icon. */}
      <NavLink
        to="/"
        end
        className={({ isActive }) =>
          `flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] text-base font-semibold transition-colors ${
            isActive
              ? "bg-tx-card-bg text-text-bright"
              : "text-text-bright hover:bg-tx-card-hover"
          }`
        }
      >
        <MailboxIcon size={22} weight="duotone" className="shrink-0" />
        All Mailboxes
      </NavLink>

      {/* + New mailbox — moved up directly under the title. The bottom-of-rail
          CTA has been removed; this is the single primary action. */}
      <Button
        variant="ghost"
        size="sm"
        icon={<PlusIcon size={14} />}
        onClick={() => setCreateOpen(true)}
        className="w-full justify-start text-text-muted px-3"
        aria-label="Create new mailbox"
        title="Create new mailbox"
      >
        New mailbox
      </Button>

      <div className="border-t border-border my-1" />

      {/* Group sections */}
      {groups.map(({ group, mailboxes }) => (
        <GroupSection
          key={group.id}
          group={group}
          mailboxes={mailboxes}
          actorUserId={actorUserId}
          actorRole={actorRole}
          onMutated={handleMutated}
        />
      ))}

      {/* Private section */}
      {privateMailboxes.length > 0 && (
        <div className="mb-1">
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted">
            <LockIcon size={12} aria-hidden />
            <span>Private</span>
          </div>
          <ul className="space-y-0.5">
            {privateMailboxes.map((mb) => (
              <li key={mb.id}>
                <MailboxNode
                  mailbox={mb}
                  inGroup={false}
                  actorUserId={actorUserId}
                  actorRole={actorRole}
                  onMutated={handleMutated}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Followed section */}
      {followedMailboxes.length > 0 && (
        <div className="mb-1">
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted">
            <EyeIcon size={12} aria-hidden />
            <span>Followed</span>
          </div>
          <ul className="space-y-0.5">
            {followedMailboxes.map((mb) => (
              <li key={mb.id}>
                <MailboxNode
                  mailbox={mb}
                  inGroup={false}
                  actorUserId={actorUserId}
                  actorRole={actorRole}
                  onMutated={handleMutated}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Empty state — italic single line. The duplicate ActionNow logo and
          the bottom "+ New mailbox" button are both gone (Phase 3d). */}
      {isEmpty && (
        <p className="px-3 py-4 text-sm italic text-text-muted text-center">
          No mailboxes yet
        </p>
      )}

      {createOpen && (
        <CreateMailboxDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={() => {
            setCreateOpen(false);
            handleMutated();
          }}
        />
      )}
    </nav>
  );
}
