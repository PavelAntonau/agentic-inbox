// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// AllowlistEditor — manages the inbox_external_allowlist entries for a mailbox.
// Props: inboxId, allowlist array, onChange callback (parent refresh).
//
// Add row: sender_pattern input + kind selector (email | domain) + Add button.
// Validation: email must contain @; domain must not.
// Each existing entry renders with a delete button.

// TODO(post-integration): import shared types from workers/routes/inbox-policies.ts once shared types module exists

export interface AllowlistEntry {
  id: string;
  sender_pattern: string;
  kind: "email" | "domain";
  created_at: number;
}

interface AllowlistEditorProps {
  inboxId: string;
  allowlist: AllowlistEntry[];
  onChange: () => void;
}

import { Button, Input } from "~/ui";
import { useState } from "react";
import { TrashIcon } from "@phosphor-icons/react";

type EntryKind = "email" | "domain";

function validatePattern(pattern: string, kind: EntryKind): string | null {
  const trimmed = pattern.trim();
  if (!trimmed) return "Pattern is required.";
  if (kind === "email") {
    if (!trimmed.includes("@")) return "Email pattern must contain @.";
  } else {
    if (trimmed.includes("@")) return "Domain pattern must not contain @.";
    if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmed))
      return "Enter a valid domain (e.g. example.com).";
  }
  return null;
}

export default function AllowlistEditor({
  inboxId,
  allowlist,
  onChange,
}: AllowlistEditorProps) {
  const [newPattern, setNewPattern] = useState("");
  const [newKind, setNewKind] = useState<EntryKind>("email");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleAdd = async () => {
    const validation = validatePattern(newPattern, newKind);
    if (validation) {
      setAddError(validation);
      return;
    }
    setAddError(null);
    setAdding(true);
    try {
      const res = await fetch(`/api/mailboxes/${inboxId}/policies/allowlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender_pattern: newPattern.trim(),
          kind: newKind,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setAddError(d.error ?? "Failed to add entry.");
        return;
      }
      setNewPattern("");
      onChange();
    } catch {
      setAddError("Network error. Please try again.");
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (entryId: string) => {
    setDeletingId(entryId);
    try {
      await fetch(`/api/mailboxes/${inboxId}/policies/allowlist/${entryId}`, {
        method: "DELETE",
      });
      onChange();
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-3">
      {/* Existing entries */}
      {allowlist.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {allowlist.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-2 rounded-[8px] border border-border px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="rounded px-1.5 py-0.5 text-xs bg-border text-text-muted">
                  {entry.kind}
                </span>
                <span className="text-sm text-text-bright truncate">
                  {entry.sender_pattern}
                </span>
              </div>
              <Button
                variant="ghost"
                size="xs"
                icon={<TrashIcon size={13} weight="bold" />}
                onClick={() => void handleDelete(entry.id)}
                disabled={deletingId === entry.id}
                aria-label={`Remove ${entry.sender_pattern}`}
              >
                {deletingId === entry.id ? "…" : "Remove"}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Add new entry */}
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          {/* Kind selector */}
          <div className="flex rounded-md border border-border overflow-hidden shrink-0">
            {(["email", "domain"] as EntryKind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setNewKind(k);
                  setAddError(null);
                }}
                className={[
                  "px-2.5 py-1.5 text-xs font-medium transition-colors",
                  newKind === k
                    ? "bg-kumo-brand text-white"
                    : "text-text-muted hover:bg-border",
                ].join(" ")}
              >
                {k}
              </button>
            ))}
          </div>

          {/* Pattern input */}
          <Input
            placeholder={
              newKind === "email" ? "user@example.com" : "example.com"
            }
            value={newPattern}
            onChange={(e) => {
              setNewPattern(e.target.value);
              if (addError) setAddError(null);
            }}
            disabled={adding}
            className="flex-1"
            aria-invalid={addError ? "true" : undefined}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd();
            }}
          />

          <Button
            variant="secondary"
            onClick={() => void handleAdd()}
            disabled={adding || !newPattern.trim()}
          >
            {adding ? "Adding…" : "Add"}
          </Button>
        </div>
        {addError && <p className="text-xs text-kumo-danger">{addError}</p>}
      </div>
    </div>
  );
}
