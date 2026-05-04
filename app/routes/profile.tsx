// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// Profile route — public-ish identity surface (Phase 4, D13).
//
// Surfaces fields that other users may see when permitted:
//   - Avatar (Phase 3b)
//   - Display name (Phase 4 — editable here)
//   - Account type (personal | company) + optional company name (Phase 4)
//
// Private settings (email, visibility, sessions, notifications) live on
// /account. Per D13, visibility is intentionally NOT on this page.

import { Button, Input, Loader, Text, useToastManager } from "~/ui";
import { useEffect, useRef, useState } from "react";
import Avatar from "~/components/Avatar";

type AccountType = "personal" | "company";

interface MeResponse {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  visibility: "everyone" | "contacts" | "nobody";
  account_type: AccountType;
  company: string | null;
  avatar_url?: string | null;
}

interface PatchProfileResponse {
  ok: boolean;
  profile: {
    id: string;
    email: string;
    display_name: string | null;
    role: string;
    visibility: "everyone" | "contacts" | "nobody";
    account_type: AccountType;
    company: string | null;
  };
}

const ACCEPT = "image/png,image/jpeg,image/webp";
const MAX_BYTES = 2 * 1024 * 1024;

const ACCOUNT_TYPE_OPTIONS: {
  value: AccountType;
  label: string;
  helper: string;
}[] = [
  {
    value: "personal",
    label: "Personal",
    helper: "Individual user. Company field hidden.",
  },
  {
    value: "company",
    label: "Company",
    helper: "Acting on behalf of an organization. Company name is shown.",
  },
];

export function meta() {
  return [{ title: "Profile | Agentic Inbox" }];
}

export default function ProfileRoute() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const toastManager = useToastManager();

  // Editable form state — initialised from /api/users/me, dirty-tracked
  // against `me` so the Save button only enables when something changed.
  const [displayName, setDisplayName] = useState("");
  const [accountType, setAccountType] = useState<AccountType>("personal");
  const [company, setCompany] = useState("");

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
        if (!cancelled) {
          setMe(data);
          setDisplayName(data.display_name ?? "");
          setAccountType(data.account_type);
          setCompany(data.company ?? "");
        }
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

  // Build the diff vs the loaded profile and PATCH only changed fields.
  const handleSave = async () => {
    if (!me) return;
    const trimmedName = displayName.trim();
    const trimmedCompany = company.trim();
    const patch: {
      display_name?: string | null;
      account_type?: AccountType;
      company?: string | null;
    } = {};
    if (trimmedName !== (me.display_name ?? "")) {
      patch.display_name = trimmedName.length === 0 ? null : trimmedName;
    }
    if (accountType !== me.account_type) {
      patch.account_type = accountType;
    }
    // Company is only meaningful for company accounts; clearing it on a
    // personal account also gets persisted so the field doesn't linger.
    const effectiveCompany =
      accountType === "company" && trimmedCompany.length > 0
        ? trimmedCompany
        : null;
    if (effectiveCompany !== (me.company ?? null)) {
      patch.company = effectiveCompany;
    }

    if (Object.keys(patch).length === 0) {
      toastManager.add({ title: "No changes to save." });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/users/me/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        toastManager.add({
          title: d.error ?? `Save failed (${res.status})`,
          variant: "error",
        });
        return;
      }
      const body = (await res.json()) as PatchProfileResponse;
      setMe((prev) =>
        prev
          ? {
              ...prev,
              display_name: body.profile.display_name,
              account_type: body.profile.account_type,
              company: body.profile.company,
            }
          : prev,
      );
      // Resync local form state to canonical server values.
      setDisplayName(body.profile.display_name ?? "");
      setAccountType(body.profile.account_type);
      setCompany(body.profile.company ?? "");
      toastManager.add({ title: "Profile saved." });
    } catch {
      toastManager.add({ title: "Network error.", variant: "error" });
    } finally {
      setSaving(false);
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

  const trimmedName = displayName.trim();
  const trimmedCompany = company.trim();
  const dirty =
    trimmedName !== (me.display_name ?? "") ||
    accountType !== me.account_type ||
    (accountType === "company" ? trimmedCompany : "") !== (me.company ?? "");

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
      <h1 className="mb-2 text-2xl font-bold text-text-bright">Profile</h1>
      <p className="mb-6 text-sm text-text-muted">
        Public-ish identity. Other users may see this when your visibility
        permits.{" "}
        <a
          href="/account"
          className="underline decoration-dotted hover:text-text-bright"
        >
          Account settings →
        </a>
      </p>

      {/* Avatar card */}
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
              PNG, JPEG, or WebP. Max 2 MB.
            </p>
          </div>
        </div>
      </section>

      {/* Profile editor */}
      <section className="mb-6 rounded-panel border border-border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold text-text-bright">Details</h2>
        <div className="space-y-4">
          <Input
            label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Shown to other users in place of your email"
            maxLength={100}
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-text-bright">
              Account type
            </legend>
            {ACCOUNT_TYPE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={[
                  "flex cursor-pointer items-start gap-3 rounded-[10px] border px-3 py-2.5 transition-colors",
                  accountType === opt.value
                    ? "border-kumo-brand bg-kumo-brand/5"
                    : "border-border hover:border-kumo-ring",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="account_type"
                  value={opt.value}
                  checked={accountType === opt.value}
                  onChange={() => setAccountType(opt.value)}
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

          {accountType === "company" ? (
            <Input
              label="Company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="ACME, Inc."
              maxLength={200}
            />
          ) : null}

          <div className="flex justify-end pt-2">
            <Button
              variant="primary"
              onClick={handleSave}
              loading={saving}
              disabled={!dirty || saving}
            >
              Save changes
            </Button>
          </div>
        </div>
      </section>

      <p className="text-xs text-text-muted">
        Sign out and visibility are in{" "}
        <a
          href="/account"
          className="underline decoration-dotted hover:text-text-bright"
        >
          Account settings
        </a>
        .
      </p>
    </div>
  );
}
