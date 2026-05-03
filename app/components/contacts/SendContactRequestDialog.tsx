// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// SendContactRequestDialog — pick a user from visibility-filtered autocomplete
// and send them a contact request.

import { Button, Dialog, Input } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useState, useEffect, useRef } from "react";

interface UserSuggestion {
  id: string;
  email: string;
  display_name: string | null;
}

interface SendContactRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestSent: () => void;
}

export default function SendContactRequestDialog({
  open,
  onOpenChange,
  onRequestSent,
}: SendContactRequestDialogProps) {
  const toastManager = useToastManager();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<UserSuggestion[]>([]);
  const [selected, setSelected] = useState<UserSuggestion | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced autocomplete fetch
  useEffect(() => {
    if (!open) return;
    if (selected) return; // don't re-fetch once a user is picked

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setLoadingSuggestions(true);
      try {
        const params = new URLSearchParams({ q: query });
        const res = await fetch(`/api/invitations/autocomplete?${params}`);
        if (!res.ok) return;
        const data = (await res.json()) as { users: UserSuggestion[] };
        setSuggestions(data.users);
      } catch {
        // Non-fatal — suggestions just won't appear
      } finally {
        setLoadingSuggestions(false);
      }
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, selected]);

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      setQuery("");
      setSuggestions([]);
      setSelected(null);
    }
    onOpenChange(nextOpen);
  }

  async function handleSend() {
    if (!selected) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/contacts/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_user_id: selected.id }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        toastManager.add({
          title: d.error ?? "Failed to send request",
          variant: "error",
        });
        return;
      }
      toastManager.add({ title: "Contact request sent" });
      onRequestSent();
      handleClose(false);
    } catch {
      toastManager.add({ title: "Network error", variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleClose}>
      <Dialog size="base" className="p-6">
        <Dialog.Title className="text-base font-semibold mb-4">
          Send Contact Request
        </Dialog.Title>

        <div className="flex flex-col gap-4">
          {selected ? (
            <div className="flex items-center justify-between rounded-[10px] border border-kumo-brand bg-kumo-brand/5 px-3 py-2">
              <div>
                <p className="text-sm font-medium text-text-bright">
                  {selected.display_name || selected.email}
                </p>
                {selected.display_name && (
                  <p className="text-xs text-text-muted">{selected.email}</p>
                )}
              </div>
              <button
                type="button"
                className="text-xs text-text-muted hover:text-text transition-colors"
                onClick={() => {
                  setSelected(null);
                  setQuery("");
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <div className="relative">
              <Input
                aria-label="Search users"
                placeholder="Search by name or email…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
              {(suggestions.length > 0 || loadingSuggestions) && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 rounded-[10px] border border-border bg-card shadow-lg overflow-hidden">
                  {loadingSuggestions && (
                    <p className="px-3 py-2 text-xs text-text-muted">
                      Searching…
                    </p>
                  )}
                  {!loadingSuggestions &&
                    suggestions.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm hover:bg-tx-card-hover transition-colors"
                        onClick={() => {
                          setSelected(u);
                          setSuggestions([]);
                        }}
                      >
                        <p className="text-text-bright">
                          {u.display_name || u.email}
                        </p>
                        {u.display_name && (
                          <p className="text-xs text-text-muted">{u.email}</p>
                        )}
                      </button>
                    ))}
                  {!loadingSuggestions && suggestions.length === 0 && query && (
                    <p className="px-3 py-2 text-xs text-text-muted">
                      No users found.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Dialog.Close
            render={(props) => (
              <Button
                {...props}
                variant="secondary"
                size="sm"
                type="button"
                disabled={submitting}
              >
                Cancel
              </Button>
            )}
          />
          <Button
            variant="primary"
            size="sm"
            loading={submitting}
            disabled={!selected}
            onClick={() => void handleSend()}
          >
            Send Request
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
