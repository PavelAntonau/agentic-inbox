// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button, Dialog } from "~/ui";
import { useKumoToastManager } from "@cloudflare/kumo";
import { useState } from "react";
import type { AdminUser } from "~/routes/admin/users";

interface ConfirmRemoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: AdminUser | null;
  bootstrapOwnerEmail?: string;
  onRemoved: () => void;
}

export default function ConfirmRemoveDialog({
  open,
  onOpenChange,
  user,
  bootstrapOwnerEmail,
  onRemoved,
}: ConfirmRemoveDialogProps) {
  const toastManager = useKumoToastManager();
  const [isRemoving, setIsRemoving] = useState(false);

  if (!user) return null;

  const ownsMailboxes = user.owns_mailboxes_count > 0;

  const handleRemove = async () => {
    setIsRemoving(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          reason?: string;
        };
        if (data.reason === "owns-mailboxes") {
          toastManager.add({
            title: "Cannot remove — user owns mailboxes",
            variant: "error",
          });
        } else {
          toastManager.add({
            title: data.error ?? "Failed to remove user",
            variant: "error",
          });
        }
        return;
      }
      toastManager.add({ title: "User removed" });
      onOpenChange(false);
      onRemoved();
    } catch {
      toastManager.add({ title: "Failed to remove user", variant: "error" });
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
      <Dialog size="sm" className="p-6">
        <Dialog.Title className="text-base font-semibold mb-2">
          Remove User
        </Dialog.Title>

        {ownsMailboxes ? (
          <>
            <Dialog.Description className="text-sm text-text-muted mb-5">
              <strong className="text-text-bright">{user.email}</strong> owns{" "}
              {user.owns_mailboxes_count} mailbox
              {user.owns_mailboxes_count !== 1 ? "es" : ""}. Transfer them first
              (V2.4) or pick a new owner.
              {bootstrapOwnerEmail && (
                <>
                  {" "}
                  Suggested owner:{" "}
                  <span className="font-mono text-text-bright">
                    {bootstrapOwnerEmail}
                  </span>
                  .
                </>
              )}
            </Dialog.Description>
            <div className="flex justify-end">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="primary" size="sm" type="button">
                    OK
                  </Button>
                )}
              />
            </div>
          </>
        ) : (
          <>
            <Dialog.Description className="text-sm text-text-muted mb-5">
              Are you sure you want to remove{" "}
              <strong className="text-text-bright">{user.email}</strong>? This
              action cannot be undone.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={(props) => (
                  <Button
                    {...props}
                    variant="secondary"
                    size="sm"
                    type="button"
                  >
                    Cancel
                  </Button>
                )}
              />
              <Button
                variant="destructive"
                size="sm"
                loading={isRemoving}
                onClick={handleRemove}
              >
                Remove
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
