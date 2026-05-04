// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// GrantInboxDialog — lets the user grant an inbox to a client with a chosen
// scope (read | write).  Multi-select: fetch all the user's mailboxes, exclude
// already-granted ones, and POST one grant per selection.

// TODO(post-integration): import shared types from workers/routes/clients.ts once shared types module exists

import { Button, Dialog, Loader } from "~/ui";
import { useEffect, useState } from "react";

interface Mailbox {
  id: string;
  name: string;
  email: string;
}

interface GrantInboxDialogProps {
  clientId: string;
  currentGrants: string[]; // inbox_ids already granted
  open: boolean;
  onClose: () => void;
  onGranted: () => Promise<void>;
}

type Scope = "read" | "write";

export default function GrantInboxDialog({
  clientId,
  currentGrants,
  open,
  onClose,
  onGranted,
}: GrantInboxDialogProps) {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [mailboxesLoading, setMailboxesLoading] = useState(false);
  const [mailboxesError, setMailboxesError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<Scope>("read");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch mailboxes when dialog opens
  useEffect(() => {
    if (!open) return;
    setSelectedIds(new Set());
    setScope("read");
    setError(null);
    setMailboxesLoading(true);
    setMailboxesError(null);

    fetch("/api/mailboxes")
      .then(async (r) => {
        if (!r.ok) throw new Error(`Failed to load mailboxes: ${r.status}`);
        return r.json() as Promise<Mailbox[] | { mailboxes: Mailbox[] }>;
      })
      .then((data) => {
        // API may return array directly or wrapped in { mailboxes: [] }
        const list = Array.isArray(data)
          ? data
          : ((data as { mailboxes: Mailbox[] }).mailboxes ?? []);
        // Exclude already-granted inboxes
        setMailboxes(list.filter((m) => !currentGrants.includes(m.id)));
      })
      .catch((err: unknown) => {
        setMailboxesError(
          err instanceof Error ? err.message : "Failed to load mailboxes",
        );
      })
      .finally(() => setMailboxesLoading(false));
  }, [open, currentGrants]);

  const toggleInbox = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selectedIds.size === 0) return;
    setSubmitting(true);
    setError(null);
    const failures: string[] = [];

    for (const inbox_id of selectedIds) {
      const res = await fetch(`/api/users/me/clients/${clientId}/grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inbox_id, scope }),
      }).catch(() => null);

      if (!res || !res.ok) {
        const label =
          mailboxes.find((m) => m.id === inbox_id)?.name ?? inbox_id;
        failures.push(label);
      }
    }

    setSubmitting(false);

    if (failures.length > 0) {
      setError(`Failed to grant access to: ${failures.join(", ")}`);
      return;
    }

    await onGranted();
  };

  const availableCount = mailboxes.length;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!submitting && !o) onClose();
      }}
    >
      <Dialog size="base">
        <div className="px-6 pt-6 pb-2">
          <Dialog.Title>Grant inbox access</Dialog.Title>
          <Dialog.Description className="mt-1">
            Select inboxes this client can access, then choose the permission
            level.
          </Dialog.Description>
        </div>

        <div className="flex flex-col gap-4 px-6 py-4">
          {/* Mailbox picker */}
          {mailboxesLoading ? (
            <div className="flex justify-center py-4">
              <Loader size="sm" />
            </div>
          ) : mailboxesError ? (
            <p className="text-sm text-kumo-danger">{mailboxesError}</p>
          ) : availableCount === 0 ? (
            <p className="text-sm text-text-muted">
              All inboxes are already granted, or you have no inboxes.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
              {mailboxes.map((m) => {
                const checked = selectedIds.has(m.id);
                return (
                  <li key={m.id}>
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-[8px] border border-border px-3 py-2 text-sm transition-colors hover:border-kumo-ring">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleInbox(m.id)}
                        className="accent-kumo-brand"
                        disabled={submitting}
                      />
                      <span className="flex-1 font-medium text-text-bright">
                        {m.name || m.email}
                      </span>
                      <span className="text-xs text-text-muted">{m.email}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Scope picker */}
          {availableCount > 0 && !mailboxesLoading && !mailboxesError && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-text-bright">
                Permission level
              </legend>
              {(["read", "write"] as Scope[]).map((s) => (
                <label
                  key={s}
                  className={[
                    "flex cursor-pointer items-start gap-3 rounded-[8px] border px-3 py-2 transition-colors",
                    scope === s
                      ? "border-kumo-brand bg-kumo-brand/5"
                      : "border-border hover:border-kumo-ring",
                  ].join(" ")}
                >
                  <input
                    type="radio"
                    name="grant-scope"
                    value={s}
                    checked={scope === s}
                    onChange={() => setScope(s)}
                    className="mt-0.5 accent-kumo-brand"
                    disabled={submitting}
                  />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium text-text-bright capitalize">
                      {s}
                    </span>
                    <span className="text-xs text-text-muted">
                      {s === "read"
                        ? "Can read emails and threads — cannot send or reply."
                        : "Can read and send emails, create threads, and manage drafts."}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {error && <p className="text-sm text-kumo-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <Dialog.Close
            render={(props) => (
              <Button
                {...props}
                variant="ghost"
                type="button"
                disabled={submitting}
              >
                Cancel
              </Button>
            )}
          />
          <Button
            variant="primary"
            disabled={
              submitting || selectedIds.size === 0 || availableCount === 0
            }
            onClick={() => void handleSubmit()}
          >
            {submitting
              ? "Granting…"
              : `Grant access${selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}`}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
