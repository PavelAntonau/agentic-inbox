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

import { Loader, Button } from "~/ui";
import {
  LockIcon,
  EnvelopeIcon,
  PlusIcon,
  EyeIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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

  return (
    <nav
      aria-label="Mailbox tree"
      className="flex flex-col gap-1 p-2 h-full overflow-y-auto"
    >
      {/* Home link */}
      <NavLink
        to="/"
        end
        className={({ isActive }) =>
          `flex items-center gap-2 px-3 py-2 rounded-[10px] text-sm transition-colors ${
            isActive
              ? "bg-tx-card-bg font-semibold text-text-bright"
              : "text-text hover:bg-tx-card-hover"
          }`
        }
      >
        <EnvelopeIcon size={16} className="shrink-0" />
        All Mailboxes
      </NavLink>

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

      {/* Empty state */}
      {groups.length === 0 &&
        privateMailboxes.length === 0 &&
        followedMailboxes.length === 0 && (
          <p className="px-3 py-4 text-sm text-text-muted text-center">
            No mailboxes yet
          </p>
        )}

      {/* Create mailbox button */}
      <div className="mt-auto pt-2 border-t border-border">
        <Button
          variant="ghost"
          size="sm"
          icon={<PlusIcon size={14} />}
          onClick={() => setCreateOpen(true)}
          className="w-full justify-start text-text-muted"
        >
          New mailbox
        </Button>
      </div>

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
