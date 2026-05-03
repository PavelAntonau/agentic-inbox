// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// RevokeTokenDialog — confirm before revoking an agent token.

import { Button, Dialog } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useState } from "react";
import type { AgentToken } from "./TokenRow";

interface RevokeTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: AgentToken | null;
  onRevoked: () => void;
}

export default function RevokeTokenDialog({
  open,
  onOpenChange,
  token,
  onRevoked,
}: RevokeTokenDialogProps) {
  const toastManager = useToastManager();
  const [isRevoking, setIsRevoking] = useState(false);

  if (!token) return null;

  const handleRevoke = async () => {
    setIsRevoking(true);
    try {
      const res = await fetch(`/api/tokens/${token.id}/revoke`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toastManager.add({
          title: data.error ?? "Failed to revoke token",
          variant: "error",
        });
        return;
      }
      toastManager.add({ title: "Token revoked" });
      onOpenChange(false);
      onRevoked();
    } catch {
      toastManager.add({ title: "Failed to revoke token", variant: "error" });
    } finally {
      setIsRevoking(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
      <Dialog size="sm" className="p-6">
        <Dialog.Title className="text-base font-semibold mb-2">
          Revoke Token
        </Dialog.Title>
        <Dialog.Description className="text-sm text-kumo-subtle mb-5">
          Are you sure you want to revoke{" "}
          <strong className="text-kumo-default">
            {token.label ?? "this token"}
          </strong>
          ? Any agents using it will be disconnected immediately. This cannot be
          undone.
        </Dialog.Description>
        <div className="flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="secondary" size="sm" type="button">
                Cancel
              </Button>
            )}
          />
          <Button
            variant="destructive"
            size="sm"
            loading={isRevoking}
            onClick={handleRevoke}
          >
            Revoke
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
