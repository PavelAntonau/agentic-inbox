// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button, Dialog, Input } from "~/ui";
import { useKumoToastManager } from "@cloudflare/kumo";
import { useState, type FormEvent } from "react";

interface InviteEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}

export default function InviteEmailDialog({
  open,
  onOpenChange,
  onInvited,
}: InviteEmailDialogProps) {
  const toastManager = useKumoToastManager();
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Please enter a valid email address.");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/admin/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error ?? `Server error ${res.status}`);
      }
      // Privacy: always show "sent" regardless of whether user already exists
      toastManager.add({ title: "Invitation sent" });
      setEmail("");
      onOpenChange(false);
      onInvited();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to send invitation";
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="sm" className="p-6">
        <Dialog.Title className="text-base font-semibold mb-4">
          Invite User
        </Dialog.Title>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <p className="text-sm text-kumo-danger">{error}</p>}
          <Input
            label="Email address"
            type="email"
            placeholder="someone@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
          <div className="flex justify-end gap-2 pt-2">
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="secondary" size="sm" type="button">
                  Cancel
                </Button>
              )}
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={isSubmitting}
            >
              Send Invitation
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
