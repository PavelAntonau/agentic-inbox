// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button, Dialog, Input, Text } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useState } from "react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface InviteToGroupDialogProps {
  groupId: string;
  groupName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function InviteToGroupDialog({
  groupId,
  groupName,
  open,
  onOpenChange,
}: InviteToGroupDialogProps) {
  const toastManager = useToastManager();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const reset = () => {
    setEmail("");
    setEmailError(null);
  };

  const validateEmail = (value: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim().toLowerCase();

    if (!trimmedEmail) {
      setEmailError("Email is required.");
      return;
    }
    if (!validateEmail(trimmedEmail)) {
      setEmailError("That doesn't look like an email.");
      return;
    }

    setEmailError(null);
    setSubmitting(true);

    try {
      const res = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId, email: trimmedEmail }),
      });

      if (res.ok) {
        // Privacy-preserving: always "Invitation sent" regardless of user existence
        toastManager.toast("Invitation sent.");
        reset();
        onOpenChange(false);
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        // Only surface format errors (400) — never reveal user existence details
        if (res.status === 400) {
          setEmailError(data.error ?? "Invalid email address.");
        } else {
          toastManager.toast(data.error ?? "Failed to send invitation", {
            variant: "error",
          });
        }
      }
    } catch {
      toastManager.toast("Network error. Please try again.", {
        variant: "error",
      });
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
            <Dialog.Title>Invite to {groupName}</Dialog.Title>
            <Dialog.Description className="mt-1">
              Enter an email address to invite someone to this group. The
              recipient will receive an email with a secure invitation link.
            </Dialog.Description>
          </div>

          <div className="flex flex-col gap-4 px-6 py-4">
            <div className="flex flex-col gap-1.5">
              <Text size="sm" className="font-medium text-text-bright">
                Email address{" "}
                <span aria-hidden="true" className="text-kumo-danger">
                  *
                </span>
              </Text>
              <Input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="colleague@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError(null);
                }}
                aria-invalid={emailError ? "true" : undefined}
                disabled={submitting}
                autoFocus
              />
              {emailError && (
                <Text size="sm" className="text-kumo-danger">
                  {emailError}
                </Text>
              )}
            </div>

            <div className="rounded-[12px] bg-kumo-fill/40 px-4 py-3">
              <Text size="sm" className="text-text-muted">
                The invitation response will always be "Invitation sent"
                regardless of whether the address is already in the workspace.
              </Text>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Dialog.Close asChild>
              <Button variant="ghost" disabled={submitting} type="button">
                Cancel
              </Button>
            </Dialog.Close>
            <Button variant="primary" disabled={submitting} type="submit">
              {submitting ? "Sending…" : "Send invitation"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
