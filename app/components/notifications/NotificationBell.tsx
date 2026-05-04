// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// NotificationBell — top-bar bell + unread badge + dropdown of pending group
// invitations. Polls /api/notifications/unseen every 30 s + on window focus
// (D-V2U-3 — polling deferred WebSocket/SSE). Dropdown closes on outside
// click / Escape. Accept/Decline calls the invitations endpoints; the local
// list refreshes after each action.

import { Loader } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { BellIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import InvitationCard, { type UnseenInvitation } from "./InvitationCard";

interface UnseenResponse {
  invitations: UnseenInvitation[];
}

const POLL_INTERVAL_MS = 30_000;

export default function NotificationBell() {
  const toastManager = useToastManager();
  const [invitations, setInvitations] = useState<UnseenInvitation[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const fetchUnseen = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications/unseen");
      if (!res.ok) {
        // Silent on auth — bell just shows zero unread
        setInvitations([]);
        return;
      }
      const data = (await res.json()) as UnseenResponse;
      setInvitations(data.invitations ?? []);
    } catch {
      setInvitations([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + interval + on-focus refresh
  useEffect(() => {
    void fetchUnseen();
    const interval = setInterval(() => void fetchUnseen(), POLL_INTERVAL_MS);
    const onFocus = () => void fetchUnseen();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchUnseen]);

  // Close dropdown on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleAccept = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/invitations/${id}/accept`, {
        method: "POST",
      });
      if (res.ok) {
        toastManager.toast("Joined group.");
        await fetchUnseen();
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toastManager.toast(data.error ?? "Failed to accept", {
          variant: "error",
        });
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleDecline = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/invitations/${id}/decline`, {
        method: "POST",
      });
      if (res.ok) {
        toastManager.toast("Invitation declined.");
        await fetchUnseen();
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toastManager.toast(data.error ?? "Failed to decline", {
          variant: "error",
        });
      }
    } finally {
      setBusyId(null);
    }
  };

  const unreadCount = invitations.length;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={
          unreadCount === 0
            ? "Notifications"
            : `Notifications (${unreadCount} unread)`
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-9 w-9 items-center justify-center rounded-[10px] text-text-muted hover:bg-tx-card-hover hover:text-text-bright transition-colors"
      >
        <BellIcon size={20} aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            data-testid="notification-bell-badge"
            className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-kumo-danger px-1 text-[10px] font-semibold leading-none text-white"
            aria-hidden="true"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="absolute right-0 top-full z-[150] mt-2 w-80 rounded-[17px] bg-bg border border-border shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold text-text-bright">
              Notifications
            </span>
            {loading && <Loader size="sm" />}
          </div>

          <div className="max-h-96 overflow-y-auto p-2">
            {invitations.length === 0 && !loading && (
              <p className="px-3 py-6 text-center text-xs text-text-muted">
                You're all caught up.
              </p>
            )}
            {invitations.length > 0 && (
              <ul className="flex flex-col gap-2">
                {invitations.map((inv) => (
                  <li key={inv.id}>
                    <InvitationCard
                      invitation={inv}
                      busy={busyId === inv.id}
                      onAccept={handleAccept}
                      onDecline={handleDecline}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
