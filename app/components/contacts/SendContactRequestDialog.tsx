// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// SendContactRequestDialog — pick a user from visibility-filtered autocomplete
// (/api/users/search) OR look them up by exact email (/api/users/discover-by-email).
//
// Phase 5 (D11): the by-email path is constant-shape on the server — every
// outcome (match-and-visible, match-and-hidden, no-match) returns 200 {ok:true}.
// The UI accordingly always shows the same success toast; the sender CANNOT
// distinguish "request sent" from "user is hidden" from "no such user".

import { Button, Dialog, Input } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useState, useEffect, useRef } from "react";

interface UserSuggestion {
  id: string;
  email: string;
  display_name: string | null;
  account_type?: "personal" | "company";
  company?: string | null;
  avatar_url?: string | null;
}

interface SendContactRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestSent: () => void;
}

type Mode = "name" | "email";

export default function SendContactRequestDialog({
  open,
  onOpenChange,
  onRequestSent,
}: SendContactRequestDialogProps) {
  const toastManager = useToastManager();
  const [mode, setMode] = useState<Mode>("name");

  // by-name state
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<UserSuggestion[]>([]);
  const [selected, setSelected] = useState<UserSuggestion | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  // by-email state
  const [emailInput, setEmailInput] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced autocomplete fetch (by-name mode only)
  useEffect(() => {
    if (!open) return;
    if (mode !== "name") return;
    if (selected) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.trim().length < 2) {
      setSuggestions([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoadingSuggestions(true);
      try {
        const params = new URLSearchParams({ q: query });
        const res = await fetch(`/api/users/search?${params}`);
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
  }, [query, open, selected, mode]);

  function resetState() {
    setQuery("");
    setSuggestions([]);
    setSelected(null);
    setEmailInput("");
  }

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      resetState();
      setMode("name");
    }
    onOpenChange(nextOpen);
  }

  async function handleSendByName() {
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

  async function handleSendByEmail() {
    const trimmed = emailInput.trim();
    if (!trimmed || !trimmed.includes("@")) {
      toastManager.add({
        title: "Enter a valid email address",
        variant: "error",
      });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/users/discover-by-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      // D11: server returns 200 {ok:true} on every outcome (match-and-visible,
      // match-and-hidden, no-match). The UI MUST show the same success toast
      // in all cases so the sender cannot distinguish them.
      if (!res.ok) {
        // Only network / 4xx-validation failures land here; the constant-shape
        // success path is always 200.
        toastManager.add({
          title: "Failed to send request",
          variant: "error",
        });
        return;
      }
      toastManager.add({
        title:
          "If that email belongs to someone, they'll receive your request.",
      });
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

        {/* Mode toggle */}
        <div className="flex gap-1 mb-4 border-b border-border">
          {(["name", "email"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                resetState();
              }}
              className={[
                "px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px",
                mode === m
                  ? "border-kumo-brand text-text-bright"
                  : "border-transparent text-text-muted hover:text-text",
              ].join(" ")}
            >
              {m === "name" ? "By name" : "By email"}
            </button>
          ))}
        </div>

        {mode === "name" && (
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
                  {selected.company && (
                    <p className="text-xs text-text-muted">
                      {selected.company}
                    </p>
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
                    {!loadingSuggestions &&
                      suggestions.length === 0 &&
                      query.trim().length >= 2 && (
                        <p className="px-3 py-2 text-xs text-text-muted">
                          No users found.
                        </p>
                      )}
                  </div>
                )}
                <p className="text-xs text-text-muted mt-2">
                  Only users who allow discovery by name appear here.
                </p>
              </div>
            )}
          </div>
        )}

        {mode === "email" && (
          <div className="flex flex-col gap-4">
            <div>
              <Input
                aria-label="Email address"
                type="email"
                placeholder="someone@example.com"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                autoFocus
              />
              <p className="text-xs text-text-muted mt-2">
                Enter the exact email address. We won't tell you whether it's
                registered — for the recipient's privacy, the request goes
                through silently if there's a match.
              </p>
            </div>
          </div>
        )}

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
            disabled={
              mode === "name"
                ? !selected
                : !emailInput.trim() || !emailInput.includes("@")
            }
            onClick={() => {
              if (mode === "name") void handleSendByName();
              else void handleSendByEmail();
            }}
          >
            Send Request
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
