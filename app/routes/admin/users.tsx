// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Badge, Button, Loader } from "~/ui";
import { useKumoToastManager } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import ConfirmRemoveDialog from "~/components/admin/ConfirmRemoveDialog";
import InviteEmailDialog from "~/components/admin/InviteEmailDialog";
import UserRow from "~/components/admin/UserRow";

// ---------------------------------------------------------------------------
// Shared types (re-exported so sub-components can import from this module)
// ---------------------------------------------------------------------------

export interface AdminUser {
  id: string;
  email: string;
  display_name: string | null;
  role: "global_owner" | "global_admin" | "user";
  status: string;
  last_login_at: number | null;
  owns_mailboxes_count: number;
}

interface UsersApiResponse {
  users: AdminUser[];
}

// ---------------------------------------------------------------------------
// Page meta
// ---------------------------------------------------------------------------

export function meta() {
  return [{ title: "Admin — Users | Agentic Inbox" }];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminUsersRoute() {
  const toastManager = useKumoToastManager();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The current user's role is inferred from which user matches the server's
  // authzContext. We read it by comparing the response with what the server
  // returns for "me". Since there's no dedicated /me endpoint, we use the
  // fact that the logged-in user will be present in the list.
  // For actor-awareness we pass the actor role down via a lightweight fetch.
  const [actorRole, setActorRole] = useState<
    "global_owner" | "global_admin" | "user"
  >("user");
  const [actorUserId, setActorUserId] = useState("");

  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<AdminUser | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch users list + actor identity in parallel
      const [usersRes, meRes] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/admin/me"),
      ]);
      if (!usersRes.ok)
        throw new Error(`Failed to load users: ${usersRes.status}`);
      const data = (await usersRes.json()) as UsersApiResponse;
      setUsers(data.users);

      if (meRes.ok) {
        const me = (await meRes.json()) as {
          user_id: string;
          role: "global_owner" | "global_admin" | "user";
        };
        setActorRole(me.role);
        setActorUserId(me.user_id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const handlePromote = async (user: AdminUser) => {
    const res = await fetch(`/api/admin/users/${user.id}/promote`, {
      method: "POST",
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      reason?: string;
      current_role?: string;
    };
    if (!res.ok || !data.ok) {
      toastManager.add({
        title:
          data.reason === "admin-cap-reached"
            ? "Admin cap reached — cannot promote"
            : (data.reason ?? "Failed to promote user"),
        variant: "error",
      });
      return;
    }
    toastManager.add({ title: `${user.email} promoted to Admin` });
    void fetchUsers();
  };

  const handleDemote = async (user: AdminUser) => {
    const res = await fetch(`/api/admin/users/${user.id}/demote`, {
      method: "POST",
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      reason?: string;
    };
    if (!res.ok || !data.ok) {
      const msg =
        data.reason === "peer-protected"
          ? "You cannot demote another admin"
          : data.reason === "cannot-modify-owner"
            ? "The workspace owner cannot be modified"
            : (data.reason ?? "Failed to demote user");
      toastManager.add({ title: msg, variant: "error" });
      return;
    }
    toastManager.add({ title: `${user.email} demoted to User` });
    void fetchUsers();
  };

  const handleRemoveClick = (user: AdminUser) => {
    setRemoveTarget(user);
    setRemoveOpen(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-panel border border-border bg-card p-6">
        <p className="text-sm text-kumo-danger">{error}</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => void fetchUsers()}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-bright">Users</h1>
          <p className="text-sm text-text-muted mt-0.5">
            {users.length} workspace member{users.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Button
          variant="primary"
          icon={<PlusIcon size={16} />}
          onClick={() => setInviteOpen(true)}
        >
          Invite
        </Button>
      </div>

      <div className="rounded-panel border border-border bg-card overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-border bg-card-light">
              <th className="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wide">
                Email
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wide">
                Display Name
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wide">
                Role
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wide">
                Status
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wide">
                Last Login
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wide">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-10 text-center text-sm text-text-muted"
                >
                  No users found.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  actorRole={actorRole}
                  actorUserId={actorUserId}
                  onPromote={handlePromote}
                  onDemote={handleDemote}
                  onRemove={handleRemoveClick}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <InviteEmailDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={() => void fetchUsers()}
      />

      <ConfirmRemoveDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        user={removeTarget}
        onRemoved={() => void fetchUsers()}
      />
    </>
  );
}
