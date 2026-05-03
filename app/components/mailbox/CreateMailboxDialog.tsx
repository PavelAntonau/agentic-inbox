// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// CreateMailboxDialog — creates a personal mailbox via POST /api/mailboxes.
// Sharing with a group is a separate action (AddToGroupDialog).

import { Button, Dialog, Input } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useState } from "react";

interface CreateMailboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export default function CreateMailboxDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateMailboxDialogProps) {
  const toastManager = useToastManager();
  const [address, setAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setAddress("");
    setDisplayName("");
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedAddress = address.trim().toLowerCase();
    if (!trimmedAddress || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedAddress)) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: trimmedAddress,
          display_name: displayName.trim() || undefined,
        }),
      });
      if (res.ok) {
        toastManager.toast("Mailbox created.");
        reset();
        onCreated();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to create mailbox.");
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
        if (!submitting) {
          if (!o) reset();
          onOpenChange(o);
        }
      }}
    >
      <Dialog size="base">
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="px-6 pt-6 pb-2">
            <Dialog.Title>New mailbox</Dialog.Title>
            <Dialog.Description className="mt-1">
              Create a personal mailbox. Share it with a group later from the
              mailbox tree.
            </Dialog.Description>
          </div>

          <div className="flex flex-col gap-4 px-6 py-4">
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-text-bright">
                Email address{" "}
                <span aria-hidden="true" className="text-kumo-danger">
                  *
                </span>
              </p>
              <Input
                placeholder="info@yourdomain.com"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  if (error) setError(null);
                }}
                aria-invalid={error ? "true" : undefined}
                disabled={submitting}
                autoFocus
              />
              {error && <p className="text-sm text-kumo-danger">{error}</p>}
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-text-bright">
                Display name{" "}
                <span className="font-normal text-text-muted">(optional)</span>
              </p>
              <Input
                placeholder="Info"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={submitting}
              />
            </div>
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
              disabled={submitting || !address.trim()}
              type="submit"
            >
              {submitting ? "Creating…" : "Create mailbox"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
