// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// Profile route — identity surface (Phase 3b avatar upload landed here).
//
// Phase 3b — avatar upload + persistence.
// Phase 4   — display name editing, account-type, optional company.
// Phase 5/6 — surfaces only the contact-trust controls; visibility lives
//             on /account, not here, per D13.

import { Button, Loader, Text, useToastManager } from "~/ui";
import { useEffect, useRef, useState } from "react";
import Avatar from "~/components/Avatar";

interface MeResponse {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  visibility: "everyone" | "contacts" | "nobody";
  avatar_url?: string | null;
}

const ACCEPT = "image/png,image/jpeg,image/webp";
const MAX_BYTES = 2 * 1024 * 1024;

export function meta() {
  return [{ title: "Profile | Agentic Inbox" }];
}

export default function ProfileRoute() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const toastManager = useToastManager();

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

  const handlePick = () => {
    fileRef.current?.click();
  };

  const handleFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = ""; // allow re-uploading the same file
    if (!file) return;

    if (!ACCEPT.split(",").includes(file.type)) {
      toastManager.add({
        title: "Use a PNG, JPEG, or WebP image.",
        variant: "error",
      });
      return;
    }
    if (file.size > MAX_BYTES) {
      toastManager.add({ title: "Max size is 2 MB.", variant: "error" });
      return;
    }

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/users/me/avatar", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        toastManager.add({
          title: d.error ?? `Upload failed (${res.status})`,
          variant: "error",
        });
        return;
      }
      const body = (await res.json()) as { avatar_url: string };
      setMe((prev) => (prev ? { ...prev, avatar_url: body.avatar_url } : prev));
      toastManager.add({ title: "Profile photo updated." });
    } catch {
      toastManager.add({ title: "Network error.", variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/users/me/avatar", { method: "DELETE" });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        toastManager.add({
          title: d.error ?? `Remove failed (${res.status})`,
          variant: "error",
        });
        return;
      }
      setMe((prev) => (prev ? { ...prev, avatar_url: null } : prev));
      toastManager.add({ title: "Profile photo removed." });
    } catch {
      toastManager.add({ title: "Network error.", variant: "error" });
    } finally {
      setBusy(false);
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
        <Text variant="error">{error ?? "Profile unavailable"}</Text>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
      <h1 className="mb-6 text-2xl font-bold text-text-bright">Profile</h1>

      {/* Identity card with avatar upload */}
      <section className="mb-6 rounded-panel border border-border bg-card p-6">
        <div className="flex items-start gap-5">
          <Avatar
            userId={me.id}
            displayName={me.display_name}
            email={me.email}
            avatarUrl={me.avatar_url}
            size={88}
          />
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold text-text-bright">
              {me.display_name?.trim() || me.email}
            </div>
            <div className="text-sm text-text-muted">{me.email}</div>
            <div className="mt-1 text-xs text-text-muted">
              Role: {me.role.replace(/_/g, " ")}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={handlePick}
                loading={busy}
                disabled={busy}
              >
                {me.avatar_url ? "Change photo" : "Upload photo"}
              </Button>
              {me.avatar_url ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRemove}
                  disabled={busy}
                >
                  Remove
                </Button>
              ) : null}
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                onChange={handleFile}
                className="hidden"
              />
            </div>
            <p className="mt-2 text-xs text-text-muted">
              PNG, JPEG, or WebP. Max 2 MB. Visible to other users when your
              profile is set to "Everyone" or "Contacts".
            </p>
          </div>
        </div>
        <p className="mt-5 text-sm text-text-muted">
          Display name editing, company / account-type fields land in the next
          iteration. Visibility lives in{" "}
          <a
            href="/account"
            className="underline decoration-dotted hover:text-text-bright"
          >
            Account settings
          </a>
          .
        </p>
      </section>

      {/* Account anchor — same page for now; /account route lands in Phase 4 */}
      <section
        id="account"
        className="mb-6 rounded-panel border border-border bg-card p-6"
      >
        <h2 className="mb-4 text-lg font-semibold text-text-bright">
          Account snapshot
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
          The dedicated /account route (visibility, sessions, notifications)
          lands in Phase 4.
        </p>
      </section>

      <p className="text-xs text-text-muted">
        Sign out from the avatar menu in the top-right.
      </p>
    </div>
  );
}
