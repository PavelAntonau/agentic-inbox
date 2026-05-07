// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button, Loader } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { ArrowLeftIcon, UserPlusIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import InviteToGroupDialog from "~/components/groups/InviteToGroupDialog";
import MemberRow from "~/components/groups/MemberRow";
import TransferOwnershipDialog from "~/components/groups/TransferOwnershipDialog";
import { useConfirm } from "~/components/ConfirmDialog";
import type { GroupSummary } from "../_layout";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemberDetail {
  user_id: string;
  role_in_group: "admin" | "member";
  joined_at: number;
  email: string | null;
  display_name: string | null;
  status: string | null;
  is_owner: boolean;
}

interface MembersApiResponse {
  group_id: string;
  owner_user_id: string;
  members: MemberDetail[];
}

interface OutletContext {
  groups: GroupSummary[];
  refetchGroups: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function meta() {
  return [{ title: "Members | ActionNowAI Mail" }];
}

export default function GroupMembersRoute() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const { refetchGroups } = useOutletContext<OutletContext>();
  const toastManager = useToastManager();
  const confirm = useConfirm();

  const [members, setMembers] = useState<MemberDetail[]>([]);
  const [ownerUserId, setOwnerUserId] = useState<string>("");
  const [groupName, setGroupName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actorUserId, setActorUserId] = useState<string>("");
  const [actorRole, setActorRole] = useState<
    "global_owner" | "global_admin" | "user"
  >("user");

  const [inviteOpen, setInviteOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const fetchMembers = useCallback(async () => {
    if (!groupId) return;
    setLoading(true);
    setError(null);
    try {
      const [membersRes, meRes, groupRes] = await Promise.all([
        fetch(`/api/groups/${groupId}/members`),
        fetch("/api/admin/me"),
        fetch(`/api/groups/${groupId}`),
      ]);
      if (membersRes.status === 404) {
        navigate("/groups", { replace: true });
        return;
      }
      if (!membersRes.ok)
        throw new Error(`Failed to load members: ${membersRes.status}`);
      const data = (await membersRes.json()) as MembersApiResponse;
      setMembers(data.members);
      setOwnerUserId(data.owner_user_id);
      if (meRes.ok) {
        const me = (await meRes.json()) as {
          user_id: string;
          role: "global_owner" | "global_admin" | "user";
        };
        setActorUserId(me.user_id);
        setActorRole(me.role);
      }
      if (groupRes.ok) {
        const g = (await groupRes.json()) as { name: string };
        setGroupName(g.name);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [groupId, navigate]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  const handleRoleChange = async (
    userId: string,
    newRole: "admin" | "member",
  ) => {
    const res = await fetch(`/api/groups/${groupId}/members/${userId}/role`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) {
      toastManager.toast(`Role updated to ${newRole}.`);
      await fetchMembers();
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toastManager.toast(data.error ?? "Failed to update role", {
        variant: "error",
      });
    }
  };

  const handleRemove = async (userId: string) => {
    const isLeave = userId === actorUserId;
    const member = members.find((m) => m.user_id === userId);
    const label = member?.display_name ?? member?.email ?? "this member";

    if (member?.is_owner) {
      toastManager.toast(
        "You must transfer ownership or delete the group before leaving.",
        { variant: "warning" },
      );
      setTransferOpen(true);
      return;
    }

    const confirmed = isLeave
      ? await confirm({
          title: "Leave this group?",
          body: "You will lose access to its inboxes immediately.",
          confirmLabel: "Leave",
          destructive: true,
        })
      : await confirm({
          title: `Remove ${label}?`,
          body: `${label} will lose access to this group's inboxes immediately.`,
          confirmLabel: "Remove",
          destructive: true,
        });
    if (!confirmed) return;

    const res = await fetch(`/api/groups/${groupId}/members/${userId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      toastManager.toast(isLeave ? "You left the group." : `${label} removed.`);
      if (isLeave) {
        await refetchGroups();
        navigate("/groups", { replace: true });
      } else {
        await fetchMembers();
      }
    } else {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (data.code === "owner-must-transfer") {
        toastManager.toast(
          "Transfer ownership or delete the group before leaving.",
          { variant: "warning" },
        );
        setTransferOpen(true);
      } else {
        toastManager.toast(data.error ?? "Failed to remove member", {
          variant: "error",
        });
      }
    }
  };

  const isGlobal = actorRole === "global_owner" || actorRole === "global_admin";
  const actorMember = members.find((m) => m.user_id === actorUserId);
  const actorIsOwner = actorUserId === ownerUserId;
  const actorIsAdmin = actorMember?.role_in_group === "admin";
  const canInvite = actorIsOwner || actorIsAdmin || isGlobal;

  // Pin actor's own row first, then owner, then admins, then members alpha
  const sortedMembers = [...members].sort((a, b) => {
    if (a.user_id === actorUserId) return -1;
    if (b.user_id === actorUserId) return 1;
    if (a.is_owner && !b.is_owner) return -1;
    if (!a.is_owner && b.is_owner) return 1;
    if (a.role_in_group === "admin" && b.role_in_group !== "admin") return -1;
    if (a.role_in_group !== "admin" && b.role_in_group === "admin") return 1;
    return (a.display_name ?? a.email ?? "").localeCompare(
      b.display_name ?? b.email ?? "",
    );
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12">
        <p className="text-kumo-danger">{error}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6 md:py-12">
      {/* Back + header */}
      <div className="mb-6 flex items-center gap-3">
        <Link
          to={`/groups/${groupId}`}
          className="flex h-8 w-8 items-center justify-center rounded-[10px] text-text-muted hover:bg-tx-card-hover hover:text-text-bright transition-colors"
          aria-label="Back to group"
        >
          <ArrowLeftIcon size={18} />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-text-bright">
            {groupName ? `${groupName} — Members` : "Members"}
          </h1>
          <p className="text-xs text-text-muted">
            {members.length} member{members.length !== 1 ? "s" : ""}
          </p>
        </div>
        {canInvite && (
          <Button
            variant="secondary"
            size="sm"
            icon={<UserPlusIcon size={16} />}
            onClick={() => setInviteOpen(true)}
          >
            Invite
          </Button>
        )}
      </div>

      {/* Member list */}
      <div className="rounded-[17px] bg-card border border-border divide-y divide-border">
        {sortedMembers.map((m) => (
          <MemberRow
            key={m.user_id}
            member={m}
            ownerUserId={ownerUserId}
            actorUserId={actorUserId}
            actorIsOwner={actorIsOwner}
            actorIsAdmin={actorIsAdmin}
            isGlobal={isGlobal}
            onRoleChange={handleRoleChange}
            onRemove={handleRemove}
            onTransferOwnership={() => setTransferOpen(true)}
          />
        ))}
      </div>

      {/* Dialogs */}
      <InviteToGroupDialog
        groupId={groupId!}
        groupName={groupName}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
      <TransferOwnershipDialog
        groupId={groupId!}
        groupName={groupName}
        members={members}
        actorUserId={actorUserId}
        open={transferOpen}
        onOpenChange={setTransferOpen}
        onTransferred={async () => {
          await fetchMembers();
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
