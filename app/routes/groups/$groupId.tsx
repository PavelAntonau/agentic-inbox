// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Badge, Button, Loader } from "~/ui";
import { useToastManager } from "~/ui/toast";
import {
  ArrowRightIcon,
  GearSixIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import InviteToGroupDialog from "~/components/groups/InviteToGroupDialog";
import TransferOwnershipDialog from "~/components/groups/TransferOwnershipDialog";
import type { GroupSummary } from "./_layout";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GroupDetail {
  id: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  created_at: number;
  actor_role_in_group: "owner" | "admin" | "member" | null;
  members: Array<{
    user_id: string;
    role_in_group: "admin" | "member";
    joined_at: number;
    email: string | null;
    display_name: string | null;
    status: string | null;
    is_owner: boolean;
  }>;
}

interface OutletContext {
  groups: GroupSummary[];
  refetchGroups: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function meta() {
  return [{ title: "Group | Agentic Inbox" }];
}

export default function GroupHome() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const { refetchGroups } = useOutletContext<OutletContext>();
  const toastManager = useToastManager();

  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [actorUserId, setActorUserId] = useState<string | null>(null);

  const fetchGroup = useCallback(async () => {
    if (!groupId) return;
    setLoading(true);
    setError(null);
    try {
      const [groupRes, meRes] = await Promise.all([
        fetch(`/api/groups/${groupId}`),
        fetch("/api/admin/me"),
      ]);
      if (groupRes.status === 404) {
        navigate("/groups", { replace: true });
        return;
      }
      if (!groupRes.ok)
        throw new Error(`Failed to load group: ${groupRes.status}`);
      const data = (await groupRes.json()) as GroupDetail;
      setGroup(data);
      if (meRes.ok) {
        const me = (await meRes.json()) as { user_id: string };
        setActorUserId(me.user_id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [groupId, navigate]);

  useEffect(() => {
    void fetchGroup();
  }, [fetchGroup]);

  const handleDelete = async () => {
    if (!groupId || !group) return;
    const confirmed = window.confirm(
      `Delete "${group.name}"? This cannot be undone.`,
    );
    if (!confirmed) return;
    const res = await fetch(`/api/groups/${groupId}`, { method: "DELETE" });
    if (res.ok) {
      toastManager.toast(`Group "${group.name}" deleted.`);
      await refetchGroups();
      navigate("/groups", { replace: true });
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toastManager.toast(data.error ?? "Failed to delete group", {
        variant: "error",
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader size="lg" />
      </div>
    );
  }

  if (error || !group) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12">
        <p className="text-kumo-danger">{error ?? "Group not found"}</p>
      </div>
    );
  }

  const isOwner = group.actor_role_in_group === "owner";
  const isAdmin =
    group.actor_role_in_group === "admin" ||
    group.actor_role_in_group === "owner";

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6 md:py-12">
      {/* Header */}
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <UsersThreeIcon size={28} className="shrink-0 text-text-muted" />
          <div>
            <h1 className="text-2xl font-bold text-text-bright">
              {group.name}
            </h1>
            {group.description && (
              <p className="mt-0.5 text-sm text-text-muted">
                {group.description}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isAdmin && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setInviteOpen(true)}
            >
              Invite
            </Button>
          )}
          {isOwner && (
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={<GearSixIcon size={18} />}
              onClick={() => setTransferOpen(true)}
              aria-label="Group settings"
            />
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="mb-6 flex flex-wrap gap-4">
        <div className="rounded-[12px] bg-card border border-border px-4 py-3">
          <p className="text-xs text-text-muted">Members</p>
          <p className="text-xl font-bold text-text-bright">
            {group.members.length}
          </p>
        </div>
        <div className="rounded-[12px] bg-card border border-border px-4 py-3">
          <p className="text-xs text-text-muted">Your role</p>
          <p className="text-sm font-semibold text-text-bright capitalize">
            {group.actor_role_in_group ?? "member"}
          </p>
        </div>
      </div>

      {/* Members preview (first 5) */}
      <div className="mb-6 rounded-[17px] bg-card border border-border">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <span className="text-sm font-semibold text-text-bright">
            Members
          </span>
          <Link
            to={`/groups/${groupId}/members`}
            className="flex items-center gap-1 text-xs text-kumo-link hover:underline"
          >
            View all <ArrowRightIcon size={12} />
          </Link>
        </div>
        <ul className="divide-y divide-border">
          {group.members.slice(0, 5).map((m) => (
            <li
              key={m.user_id}
              className="flex items-center gap-3 px-5 py-3 text-sm"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-xs font-semibold text-text-bright uppercase">
                {(m.display_name ?? m.email ?? "?")[0]}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-text-bright">
                  {m.display_name ?? m.email}
                </p>
                {m.display_name && (
                  <p className="truncate text-xs text-text-muted">{m.email}</p>
                )}
              </div>
              <Badge
                variant={
                  m.is_owner
                    ? "primary"
                    : m.role_in_group === "admin"
                      ? "secondary"
                      : "outline"
                }
              >
                {m.is_owner ? "owner" : m.role_in_group}
              </Badge>
            </li>
          ))}
        </ul>
        {group.members.length > 5 && (
          <div className="px-5 py-3 border-t border-border">
            <Link
              to={`/groups/${groupId}/members`}
              className="text-xs text-kumo-link hover:underline"
            >
              +{group.members.length - 5} more members
            </Link>
          </div>
        )}
      </div>

      {/* Danger zone (owner only) */}
      {isOwner && (
        <div className="rounded-[17px] border border-kumo-danger/30 bg-card px-5 py-4">
          <h2 className="mb-1 text-sm font-semibold text-text-bright">
            Danger zone
          </h2>
          <p className="mb-3 text-xs text-text-muted">
            Deleting a group removes all memberships and mailbox associations.
          </p>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            Delete group
          </Button>
        </div>
      )}

      {/* Dialogs */}
      <InviteToGroupDialog
        groupId={groupId!}
        groupName={group.name}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
      <TransferOwnershipDialog
        groupId={groupId!}
        groupName={group.name}
        members={group.members}
        actorUserId={actorUserId ?? ""}
        open={transferOpen}
        onOpenChange={setTransferOpen}
        onTransferred={async () => {
          await fetchGroup();
          await refetchGroups();
          setTransferOpen(false);
        }}
        onDeleted={async () => {
          await refetchGroups();
          navigate("/groups", { replace: true });
        }}
      />
    </div>
  );
}
