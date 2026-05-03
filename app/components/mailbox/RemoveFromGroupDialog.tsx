// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// RemoveFromGroupDialog — owner OR group admin removes a mailbox from a group.
// DELETEs /api/mailboxes/:id/share/:groupId.

import { Button, Dialog } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useState } from "react";
import type { MailboxNode } from "~/routes/_app/api.tree";

interface RemoveFromGroupDialogProps {
  mailbox: MailboxNode;
  groupId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export default function RemoveFromGroupDialog({
  mailbox,
  groupId,
  open,
  onOpenChange,
  onSuccess,
}: RemoveFromGroupDialogProps) {
  const toastManager = useToastManager();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayName =
    mailbox.display_name || mailbox.address.split("@")[0] || mailbox.address;

  const handleConfirm = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/mailboxes/${mailbox.id}/share/${groupId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toastManager.toast("Mailbox removed from group.");
        onSuccess();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to remove mailbox from group.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!submitting) onOpenChange(o);
      }}
    >
      <Dialog size="sm" className="p-6">
        <Dialog.Title className="text-base font-semibold mb-2">
          Remove from group
        </Dialog.Title>
        <Dialog.Description className="text-sm text-text-muted mb-5">
          Remove{" "}
          <span className="font-medium text-text-bright">{displayName}</span>{" "}
          from this group? Group members will lose access to it.
        </Dialog.Description>

        {error && <p className="mb-3 text-sm text-kumo-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button
                {...props}
                variant="secondary"
                size="sm"
                disabled={submitting}
                type="button"
              >
                Cancel
              </Button>
            )}
          />
          <Button
            variant="destructive"
            size="sm"
            disabled={submitting}
            onClick={() => void handleConfirm()}
          >
            {submitting ? "Removing…" : "Remove"}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
