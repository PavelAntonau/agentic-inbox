// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// BlockUserDialog — confirmation modal for blocking a user.

import { Button, Dialog } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useState } from "react";

interface BlockUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetUserId: string;
  targetDisplayName: string;
  onBlocked: () => void;
}

export default function BlockUserDialog({
  open,
  onOpenChange,
  targetUserId,
  targetDisplayName,
  onBlocked,
}: BlockUserDialogProps) {
  const toastManager = useToastManager();
  const [blocking, setBlocking] = useState(false);

  async function handleBlock() {
    setBlocking(true);
    try {
      const res = await fetch(`/api/contacts/${targetUserId}/block`, {
        method: "POST",
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        toastManager.add({
          title: d.error ?? "Failed to block user",
          variant: "error",
        });
        return;
      }
      toastManager.add({ title: `${targetDisplayName} has been blocked` });
      onBlocked();
    } catch {
      toastManager.add({ title: "Network error", variant: "error" });
    } finally {
      setBlocking(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="p-6">
        <Dialog.Title className="text-base font-semibold mb-2">
          Block {targetDisplayName}?
        </Dialog.Title>
        <Dialog.Description className="text-sm text-text-muted mb-6">
          Blocking will prevent{" "}
          <strong className="text-text-bright">{targetDisplayName}</strong> from
          sending you contact requests or appearing in your autocomplete
          results. This action can be undone by removing the block.
        </Dialog.Description>

        <div className="flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button
                {...props}
                variant="secondary"
                size="sm"
                type="button"
                disabled={blocking}
              >
                Cancel
              </Button>
            )}
          />
          <Button
            variant="primary"
            size="sm"
            loading={blocking}
            onClick={() => void handleBlock()}
          >
            Block user
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
