// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// TransferMailboxOwnershipDialog — owner transfers mailbox to another user.
// Fetches workspace users from /api/admin/users for the picker.
// POSTs to /api/mailboxes/:id/transfer.

import { Button, Dialog, Loader } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useEffect, useMemo, useState } from "react";
import type { MailboxNode } from "~/routes/_app/api.tree";

interface WorkspaceUser {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  visibility: string;
}

interface TransferMailboxOwnershipDialogProps {
  mailbox: MailboxNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export default function TransferMailboxOwnershipDialog({
  mailbox,
  open,
  onOpenChange,
  onSuccess,
}: TransferMailboxOwnershipDialogProps) {
  const toastManager = useToastManager();
  const [users, setUsers] = useState<WorkspaceUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [actorUserId, setActorUserId] = useState<string>("");
  const [actorRole, setActorRole] = useState<string>("user");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedUserId("");
    setError(null);
    setLoadingUsers(true);
    Promise.all([
      fetch("/api/admin/users")
        .then((r) => r.json() as Promise<{ users: WorkspaceUser[] }>)
        .then((d) => d.users ?? [])
        .catch(() => [] as WorkspaceUser[]),
      fetch("/api/admin/me")
        .then((r) => r.json() as Promise<{ user_id: string; role: string }>)
        .catch(() => ({ user_id: "", role: "user" })),
    ])
      .then(([userList, me]) => {
        setUsers(userList);
        setActorUserId(me.user_id);
        setActorRole(me.role);
      })
      .finally(() => setLoadingUsers(false));
  }, [open]);

  const isGlobal = actorRole === "global_owner" || actorRole === "global_admin";

  // Candidates: other active users; for non-global actors exclude visibility='nobody'
  const candidates = useMemo(() => {
    return users
      .filter((u) => u.id !== actorUserId)
      .filter((u) => isGlobal || u.visibility !== "nobody")
      .sort((a, b) =>
        (a.display_name ?? a.email).localeCompare(b.display_name ?? b.email),
      );
  }, [users, actorUserId, isGlobal]);

  const handleTransfer = async () => {
    if (!selectedUserId) {
      setError("Pick a new owner first.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/mailboxes/${mailbox.id}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_owner_user_id: selectedUserId }),
      });
      if (res.ok) {
        toastManager.toast("Ownership transferred.");
        onSuccess();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to transfer ownership.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const displayName =
    mailbox.display_name || mailbox.address.split("@")[0] || mailbox.address;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!submitting) onOpenChange(o);
      }}
    >
      <Dialog size="base" className="p-6">
        <Dialog.Title className="text-base font-semibold mb-1">
          Transfer ownership of {displayName}
        </Dialog.Title>
        <Dialog.Description className="text-sm text-text-muted mb-4">
          The new owner can share, transfer, and delete this mailbox. You will
          lose those permissions.
        </Dialog.Description>

        {error && <p className="mb-3 text-sm text-kumo-danger">{error}</p>}

        {loadingUsers ? (
          <div className="flex justify-center py-4">
            <Loader size="sm" />
          </div>
        ) : candidates.length === 0 ? (
          <div className="rounded-[12px] bg-kumo-fill px-4 py-3 text-sm text-text-muted">
            No other workspace users available to transfer to.
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-[12px] border border-border">
            <ul className="divide-y divide-border">
              {candidates.map((u) => (
                <li key={u.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-tx-card-hover">
                    <input
                      type="radio"
                      name="new-owner"
                      value={u.id}
                      checked={selectedUserId === u.id}
                      onChange={() => {
                        setSelectedUserId(u.id);
                        if (error) setError(null);
                      }}
                      className="h-4 w-4 accent-kumo-brand"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-bright">
                        {u.display_name ?? u.email}
                      </p>
                      {u.display_name && (
                        <p className="truncate text-xs text-text-muted">
                          {u.email}
                        </p>
                      )}
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button
                {...props}
                variant="ghost"
                type="button"
                disabled={submitting}
              >
                Cancel
              </Button>
            )}
          />
          <Button
            variant="primary"
            type="button"
            disabled={submitting || !selectedUserId || candidates.length === 0}
            onClick={() => void handleTransfer()}
          >
            {submitting ? "Transferring…" : "Transfer ownership"}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
