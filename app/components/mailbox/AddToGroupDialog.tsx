// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// AddToGroupDialog — owner adds a mailbox to one of their groups.
// Fetches the actor's groups from /api/groups, then POSTs to
// /api/mailboxes/:id/share.

import { Button, Dialog, Loader } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useEffect, useState } from "react";
import type { MailboxNode } from "~/routes/_app/api.tree";

interface Group {
  id: string;
  name: string;
}

interface AddToGroupDialogProps {
  mailbox: MailboxNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export default function AddToGroupDialog({
  mailbox,
  open,
  onOpenChange,
  onSuccess,
}: AddToGroupDialogProps) {
  const toastManager = useToastManager();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoadingGroups(true);
    setSelectedGroupId("");
    setError(null);
    fetch("/api/groups")
      .then((r) => r.json() as Promise<{ groups: Group[] }>)
      .then((data) => setGroups(data.groups ?? []))
      .catch(() => setGroups([]))
      .finally(() => setLoadingGroups(false));
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedGroupId) {
      setError("Pick a group first.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/mailboxes/${mailbox.id}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: selectedGroupId }),
      });
      if (res.ok) {
        toastManager.toast("Mailbox added to group.");
        onSuccess();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to share mailbox.");
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
      <Dialog size="base">
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="px-6 pt-6 pb-2">
            <Dialog.Title>Share mailbox with group</Dialog.Title>
            <Dialog.Description className="mt-1">
              Choose a group to share{" "}
              <span className="font-medium text-text-bright">
                {displayName}
              </span>{" "}
              with. Every group member will get read + write access.
            </Dialog.Description>
          </div>

          <div className="px-6 py-4">
            {loadingGroups ? (
              <div className="flex justify-center py-4">
                <Loader size="sm" />
              </div>
            ) : groups.length === 0 ? (
              <p className="text-sm text-text-muted">
                You are not a member of any groups yet. Create or join a group
                first.
              </p>
            ) : (
              <div className="max-h-60 overflow-y-auto rounded-[12px] border border-border">
                <ul className="divide-y divide-border">
                  {groups.map((g) => (
                    <li key={g.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-tx-card-hover">
                        <input
                          type="radio"
                          name="group"
                          value={g.id}
                          checked={selectedGroupId === g.id}
                          onChange={() => {
                            setSelectedGroupId(g.id);
                            if (error) setError(null);
                          }}
                          className="h-4 w-4 accent-kumo-brand"
                        />
                        <span className="text-sm font-medium text-text-bright">
                          {g.name}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {error && <p className="mt-3 text-sm text-kumo-danger">{error}</p>}
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Dialog.Close
              render={(props) => (
                <Button
                  {...props}
                  variant="ghost"
                  disabled={submitting}
                  type="button"
                >
                  Cancel
                </Button>
              )}
            />
            <Button
              variant="primary"
              disabled={submitting || !selectedGroupId || groups.length === 0}
              type="submit"
            >
              {submitting ? "Sharing…" : "Share"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
