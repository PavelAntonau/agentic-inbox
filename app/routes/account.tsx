// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// Account route — private user settings (Phase 4, D13).
//
// Surfaces what is private to the user and never shown to others:
//   - Email (read-only — Cloudflare Access source of truth)
//   - Visibility (moved here from /mailbox/:id/settings)
//   - Sessions / sign-out anchor
//
// Public-ish identity (display name, avatar, account type, company) lives
// on /profile. Per D13, visibility is intentionally NOT on /profile —
// other users seeing your visibility setting would itself be a leak.

import { Button, Loader, Text, useToastManager } from "~/ui";
import { EyeIcon, SignOutIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

type Visibility = "everyone" | "contacts" | "nobody";

interface MeResponse {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  visibility: Visibility;
  account_type: "personal" | "company";
  company: string | null;
  avatar_url?: string | null;
}

const VISIBILITY_OPTIONS: {
  value: Visibility;
  label: string;
  helper: string;
}[] = [
  {
    value: "everyone",
    label: "Everyone",
    helper: "Anyone in the workspace can find and contact you.",
  },
  {
    value: "contacts",
    label: "Contacts only",
    helper: "Only your accepted contacts and group co-members can find you.",
  },
  {
    value: "nobody",
    label: "Nobody",
    helper:
      "Nobody outside your groups can find you. People who already know your address can still email you.",
  },
];

export function meta() {
  return [{ title: "Account | Agentic Inbox" }];
}

export default function AccountRoute() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const toastManager = useToastManager();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/me")
      .then(async (r) => {
        if (!r.ok) throw new Error(`Failed to load account: ${r.status}`);
        return r.json() as Promise<MeResponse>;
      })
      .then((data) => {
        if (!cancelled) setMe(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleVisibilityChange = async (next: Visibility) => {
    if (!me || next === me.visibility) return;
    const previous = me.visibility;
    setMe({ ...me, visibility: next }); // optimistic
    setSavingVisibility(true);
    try {
      const res = await fetch("/api/users/me/visibility", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      });
      if (!res.ok) {
        setMe((prev) => (prev ? { ...prev, visibility: previous } : prev));
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        toastManager.add({
          title: d.error ?? "Failed to update visibility",
          variant: "error",
        });
        return;
      }
      toastManager.add({ title: "Visibility updated" });
    } catch {
      setMe((prev) => (prev ? { ...prev, visibility: previous } : prev));
      toastManager.add({ title: "Network error", variant: "error" });
    } finally {
      setSavingVisibility(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader size="lg" />
      </div>
    );
  }

  if (error || !me) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Text variant="error">{error ?? "Account unavailable"}</Text>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
      <h1 className="mb-2 text-2xl font-bold text-text-bright">Account</h1>
      <p className="mb-6 text-sm text-text-muted">
        Private settings. Nothing on this page is shown to other users.{" "}
        <a
          href="/profile"
          className="underline decoration-dotted hover:text-text-bright"
        >
          Edit your public profile →
        </a>
      </p>

      {/* Identity (read-only) */}
      <section className="mb-6 rounded-panel border border-border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold text-text-bright">
          Identity
        </h2>
        <dl className="grid grid-cols-[max-content,1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-text-muted">Email</dt>
          <dd className="text-text-bright">{me.email}</dd>
          <dt className="text-text-muted">User ID</dt>
          <dd className="font-mono text-text-bright break-all">{me.id}</dd>
          <dt className="text-text-muted">Role</dt>
          <dd className="text-text-bright">{me.role.replace(/_/g, " ")}</dd>
        </dl>
        <p className="mt-4 text-xs text-text-muted">
          Email comes from Cloudflare Access and cannot be changed here.
        </p>
      </section>

      {/* Visibility */}
      <section className="mb-6 rounded-panel border border-border bg-card p-6">
        <div className="mb-3 flex items-center gap-2">
          <EyeIcon size={18} weight="duotone" className="text-text-muted" />
          <h2 className="text-lg font-semibold text-text-bright">Visibility</h2>
        </div>
        <p className="mb-3 text-sm text-text-muted">
          Controls who can find you in autocomplete suggestions when other users
          send invitations or add contacts. People who already know your email
          can always reach you.
        </p>
        <fieldset className="flex flex-col gap-2" disabled={savingVisibility}>
          <legend className="sr-only">Visibility</legend>
          {VISIBILITY_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={[
                "flex cursor-pointer items-start gap-3 rounded-[10px] border px-3 py-2.5 transition-colors",
                me.visibility === opt.value
                  ? "border-kumo-brand bg-kumo-brand/5"
                  : "border-border hover:border-kumo-ring",
              ].join(" ")}
            >
              <input
                type="radio"
                name="visibility"
                value={opt.value}
                checked={me.visibility === opt.value}
                onChange={() => void handleVisibilityChange(opt.value)}
                className="mt-0.5 accent-kumo-brand"
              />
              <span className="flex-1">
                <span className="block text-sm font-medium text-text-bright">
                  {opt.label}
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  {opt.helper}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>

      {/* Sign out */}
      <section className="mb-6 rounded-panel border border-border bg-card p-6">
        <div className="mb-3 flex items-center gap-2">
          <SignOutIcon size={18} weight="duotone" className="text-text-muted" />
          <h2 className="text-lg font-semibold text-text-bright">Session</h2>
        </div>
        <p className="mb-4 text-sm text-text-muted">
          Sign out of this device. Other devices keep their sessions until they
          expire on their own.
        </p>
        <Button
          variant="ghost"
          onClick={() => {
            window.location.href = "/cdn-cgi/access/logout";
          }}
        >
          Sign out
        </Button>
      </section>

      <p className="text-xs text-text-muted">
        Notification preferences land in a future iteration.
      </p>
    </div>
  );
}
