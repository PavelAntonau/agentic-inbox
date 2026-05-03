// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button, Dialog, Input } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useState } from "react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CreateGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CreateGroupDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateGroupDialogProps) {
  const toastManager = useToastManager();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setDescription("");
    setNameError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Group name is required.");
      return;
    }
    if (trimmedName.length > 100) {
      setNameError("Name must be 100 characters or fewer.");
      return;
    }
    setNameError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          description: description.trim() || null,
        }),
      });
      if (res.ok) {
        toastManager.toast(`Group "${trimmedName}" created.`);
        reset();
        await onCreated();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toastManager.toast(data.error ?? "Failed to create group", {
          variant: "error",
        });
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
            <Dialog.Title>Create group</Dialog.Title>
            <Dialog.Description className="mt-1">
              Groups let you share mailboxes and collaborate with teammates.
            </Dialog.Description>
          </div>

          <div className="flex flex-col gap-4 px-6 py-4">
            {/* Name */}
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-text-bright">
                Name{" "}
                <span aria-hidden="true" className="text-kumo-danger">
                  *
                </span>
              </p>
              <Input
                placeholder="e.g. Engineering"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (nameError) setNameError(null);
                }}
                aria-invalid={nameError ? "true" : undefined}
                disabled={submitting}
                autoFocus
              />
              {nameError && (
                <p className="text-sm text-kumo-danger">{nameError}</p>
              )}
            </div>

            {/* Description */}
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-text-bright">
                Description{" "}
                <span className="font-normal text-text-muted">(optional)</span>
              </p>
              <textarea
                className="w-full resize-none rounded-[10px] border border-border bg-bg px-3 py-2 text-sm text-text-bright placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-kumo-brand/30 disabled:opacity-50"
                placeholder="What's this group for?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={500}
                disabled={submitting}
              />
              <p className="text-right text-sm text-text-muted">
                {description.length}/500
              </p>
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
            <Button variant="primary" disabled={submitting} type="submit">
              {submitting ? "Creating…" : "Create group"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
