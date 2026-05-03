// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// DeleteMailboxDialog — owner deletes a mailbox via DELETE /api/mailboxes/:id.

import { Button, Dialog } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useState } from "react";
import type { MailboxNode } from "~/routes/_app/api.tree";

interface DeleteMailboxDialogProps {
  mailbox: MailboxNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export default function DeleteMailboxDialog({
  mailbox,
  open,
  onOpenChange,
  onSuccess,
}: DeleteMailboxDialogProps) {
  const toastManager = useToastManager();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayName =
    mailbox.display_name || mailbox.address.split("@")[0] || mailbox.address;

  const handleDelete = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/mailboxes/${mailbox.id}`, {
        method: "DELETE",
      });
      if (res.ok || res.status === 204) {
        toastManager.toast("Mailbox deleted.");
        onSuccess();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to delete mailbox.");
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
          Delete mailbox
        </Dialog.Title>
        <Dialog.Description className="text-sm text-text-muted mb-5">
          Permanently delete{" "}
          <span className="font-medium text-text-bright">{displayName}</span> (
          {mailbox.address})? This action cannot be undone.
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
            onClick={() => void handleDelete()}
          >
            {submitting ? "Deleting…" : "Delete mailbox"}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
