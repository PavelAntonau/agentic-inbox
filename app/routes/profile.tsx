// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// Profile / account settings stub.
//
// Phase 3a delivered the avatar UI; this page is the destination for the
// avatar's profile + account dropdown items. It currently surfaces the
// identity returned by /api/users/me. Phase 3b adds avatar upload, Phase 4
// wires visibility + account-type + company fields, Phase 5/6 surface
// contacts trust controls.

import { Loader, Text } from "~/ui";
import { useEffect, useState } from "react";
import Avatar from "~/components/Avatar";

interface MeResponse {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  visibility: "everyone" | "contacts" | "nobody";
  avatar_url?: string | null;
}

export function meta() {
  return [{ title: "Profile | Agentic Inbox" }];
}

export default function ProfileRoute() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/me")
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(`Failed to load profile: ${r.status}`);
        }
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
        <Text variant="error">{error ?? "Profile unavailable"}</Text>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
      <h1 className="mb-6 text-2xl font-bold text-text-bright">Profile</h1>

      {/* Identity card */}
      <section className="mb-6 rounded-panel border border-border bg-card p-6">
        <div className="flex items-center gap-4">
          <Avatar
            userId={me.id}
            displayName={me.display_name}
            email={me.email}
            avatarUrl={me.avatar_url}
            size={72}
          />
          <div className="min-w-0">
            <div className="text-lg font-semibold text-text-bright">
              {me.display_name?.trim() || me.email}
            </div>
            <div className="text-sm text-text-muted">{me.email}</div>
            <div className="mt-1 text-xs text-text-muted">
              Role: {me.role.replace(/_/g, " ")}
            </div>
          </div>
        </div>
        <p className="mt-4 text-sm text-text-muted">
          Avatar upload, display name editing, and account-type / company fields
          land in the next iteration. For now the initial is hashed from your
          user id and stays stable across sessions.
        </p>
      </section>

      {/* Account anchor — same page for now */}
      <section
        id="account"
        className="mb-6 rounded-panel border border-border bg-card p-6"
      >
        <h2 className="mb-4 text-lg font-semibold text-text-bright">
          Account settings
        </h2>
        <dl className="grid grid-cols-[max-content,1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-text-muted">User ID</dt>
          <dd className="font-mono text-text-bright break-all">{me.id}</dd>
          <dt className="text-text-muted">Email</dt>
          <dd className="text-text-bright">{me.email}</dd>
          <dt className="text-text-muted">Visibility</dt>
          <dd className="text-text-bright">
            {me.visibility === "everyone"
              ? "Open — visible to everyone"
              : me.visibility === "contacts"
                ? "Visible to contacts only"
                : "Closed — visible to nobody"}
          </dd>
        </dl>
        <p className="mt-4 text-sm text-text-muted">
          A visibility toggle, password / session controls, and notification
          preferences arrive in a follow-up iteration.
        </p>
      </section>

      <p className="text-xs text-text-muted">
        Sign out from the avatar menu in the top-right.
      </p>
    </div>
  );
}
