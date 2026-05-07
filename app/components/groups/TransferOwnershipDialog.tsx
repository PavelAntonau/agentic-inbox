// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button, Dialog } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useMemo, useState } from "react";
import { useConfirm } from "~/components/ConfirmDialog";

interface MemberLite {
  user_id: string;
  role_in_group: "admin" | "member";
  email: string | null;
  display_name: string | null;
  is_owner: boolean;
}

interface TransferOwnershipDialogProps {
  groupId: string;
  groupName: string;
  members: MemberLite[];
  actorUserId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTransferred: () => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
}

export default function TransferOwnershipDialog({
  groupId,
  groupName,
  members,
  actorUserId,
  open,
  onOpenChange,
  onTransferred,
  onDeleted,
}: TransferOwnershipDialogProps) {
  const toastManager = useToastManager();
  const confirm = useConfirm();
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Candidates: anyone except the actor themselves, with admins listed first
  const candidates = useMemo(() => {
    return [...members]
      .filter((m) => m.user_id !== actorUserId)
      .sort((a, b) => {
        if (a.role_in_group === "admin" && b.role_in_group !== "admin")
          return -1;
        if (a.role_in_group !== "admin" && b.role_in_group === "admin")
          return 1;
        return (a.display_name ?? a.email ?? "").localeCompare(
          b.display_name ?? b.email ?? "",
        );
      });
  }, [members, actorUserId]);

  const handleTransfer = async () => {
    if (!selectedUserId) {
      setError("Pick a new owner first.");
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/groups/${groupId}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_owner_user_id: selectedUserId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error ?? `Server error ${res.status}`);
      }
      toastManager.toast("Ownership transferred.");
      await onTransferred();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to transfer";
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    const confirmed = await confirm({
      title: `Delete "${groupName}"?`,
      body: "All members lose access immediately and the group cannot be recovered.",
      confirmLabel: "Delete group",
      destructive: true,
    });
    if (!confirmed) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/groups/${groupId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error ?? `Server error ${res.status}`);
      }
      toastManager.toast(`Group "${groupName}" deleted.`);
      await onDeleted();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete";
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="p-6">
        <Dialog.Title className="text-base font-semibold mb-1">
          Transfer ownership of {groupName}
        </Dialog.Title>
        <Dialog.Description className="text-sm text-text-muted mb-4">
          The new owner can manage members, invite users, and delete the group.
        </Dialog.Description>

        {error && <p className="mb-3 text-sm text-kumo-danger">{error}</p>}

        {candidates.length === 0 ? (
          <div className="rounded-[12px] bg-kumo-fill px-4 py-3 text-sm text-text-muted">
            No other members in this group. Invite someone before transferring,
            or delete the group instead.
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-[12px] border border-border">
            <ul className="divide-y divide-border">
              {candidates.map((m) => (
                <li key={m.user_id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-tx-card-hover">
                    <input
                      type="radio"
                      name="new-owner"
                      value={m.user_id}
                      checked={selectedUserId === m.user_id}
                      onChange={() => setSelectedUserId(m.user_id)}
                      className="h-4 w-4 accent-kumo-brand"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-bright">
                        {m.display_name ?? m.email}
                      </p>
                      {m.display_name && (
                        <p className="truncate text-xs text-text-muted">
                          {m.email}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 rounded-full bg-kumo-fill px-2 py-0.5 text-[11px] font-medium text-text-muted">
                      {m.role_in_group}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-2">
          <Button
            variant="secondary-destructive"
            type="button"
            disabled={isSubmitting}
            onClick={handleDelete}
          >
            Delete group
          </Button>
          <div className="flex gap-2">
            <Dialog.Close
              render={(props) => (
                <Button
                  {...props}
                  variant="ghost"
                  type="button"
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
              )}
            />
            <Button
              variant="primary"
              type="button"
              disabled={isSubmitting || !selectedUserId}
              onClick={handleTransfer}
            >
              {isSubmitting ? "Transferring…" : "Transfer ownership"}
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
