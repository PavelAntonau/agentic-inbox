// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// PolicyCard — inbox policy settings panel for a given mailbox.
//
// Section 1: External inbound
//   - Toggle external_inbound_enabled
//   - When enabled: select external_allow_mode (all | allowlist)
//   - When mode='allowlist': <AllowlistEditor />
//
// Section 2: Internal inbound
//   - Select internal_inbound_mode (everyone | contacts_only | none)
//
// Section 3: Outbound (TASK-2.5)
//   - Toggle external_send_enabled
//   - When off: mailbox can only send to internal mailboxes via the short-circuit path
//   - When on: sends externally via Cloudflare Email Routing (destination must be verified)
//
// All changes PATCH /api/mailboxes/:id/policies debounced 300 ms.
// Debounce chosen over on-blur so toggle/radio changes persist immediately
// without requiring the user to click elsewhere.

// TODO(post-integration): import shared types from workers/routes/inbox-policies.ts once shared types module exists
import type { AllowlistEntry } from "./AllowlistEditor";
import AllowlistEditor from "./AllowlistEditor";
import { Select } from "~/ui";
import {
  GlobeIcon,
  LockIcon,
  PaperPlaneTiltIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

interface InboxPolicies {
  external_inbound_enabled: boolean;
  external_allow_mode: "all" | "allowlist";
  internal_inbound_mode: "everyone" | "contacts_only" | "none";
  allowlist: AllowlistEntry[];
  // Phase 2 (TASK-2.5): per-mailbox outbound external flag
  external_send_enabled: boolean;
}

interface PolicyCardProps {
  inboxId: string;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

export default function PolicyCard({ inboxId }: PolicyCardProps) {
  const [policies, setPolicies] = useState<InboxPolicies | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Fetch
  // ---------------------------------------------------------------------------

  const fetchPolicies = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/mailboxes/${inboxId}/policies`);
      if (!res.ok) throw new Error(`Failed to load policies: ${res.status}`);
      const data = (await res.json()) as InboxPolicies;
      setPolicies(data);
    } catch (err: unknown) {
      setFetchError(
        err instanceof Error ? err.message : "Failed to load policies",
      );
    } finally {
      setLoading(false);
    }
  }, [inboxId]);

  useEffect(() => {
    void fetchPolicies();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fetchPolicies]);

  // ---------------------------------------------------------------------------
  // Debounced PATCH — fires 300 ms after the last change
  // ---------------------------------------------------------------------------

  const patchPolicies = useCallback(
    (patch: Partial<Omit<InboxPolicies, "allowlist">>) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        setSaveStatus("saving");
        try {
          const res = await fetch(`/api/mailboxes/${inboxId}/policies`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
          if (!res.ok) throw new Error("save failed");
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus("idle"), 2000);
        } catch {
          setSaveStatus("error");
        }
      }, 300);
    },
    [inboxId],
  );

  // ---------------------------------------------------------------------------
  // Change handlers — update local state immediately, patch debounced
  // ---------------------------------------------------------------------------

  const setExternalEnabled = (enabled: boolean) => {
    setPolicies((p) => p && { ...p, external_inbound_enabled: enabled });
    patchPolicies({ external_inbound_enabled: enabled });
  };

  const setAllowMode = (mode: "all" | "allowlist") => {
    setPolicies((p) => p && { ...p, external_allow_mode: mode });
    patchPolicies({ external_allow_mode: mode });
  };

  const setInternalMode = (mode: "everyone" | "contacts_only" | "none") => {
    setPolicies((p) => p && { ...p, internal_inbound_mode: mode });
    patchPolicies({ internal_inbound_mode: mode });
  };

  const setExternalSendEnabled = (enabled: boolean) => {
    setPolicies((p) => p && { ...p, external_send_enabled: enabled });
    patchPolicies({ external_send_enabled: enabled });
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="h-4 w-32 animate-pulse rounded bg-border" />
      </div>
    );
  }

  if (fetchError || !policies) {
    return (
      <div className="rounded-lg border border-border bg-card p-5">
        <p className="text-sm text-kumo-danger">
          {fetchError ?? "Policy unavailable"}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <LockIcon size={16} weight="duotone" className="text-text-muted" />
          <span className="text-sm font-medium text-text-bright">
            Inbox Policies
          </span>
        </div>
        {saveStatus === "saving" && (
          <span className="text-xs text-text-muted">Saving…</span>
        )}
        {saveStatus === "saved" && (
          <span className="text-xs text-green-600">Saved</span>
        )}
        {saveStatus === "error" && (
          <span className="text-xs text-kumo-danger">Failed to save</span>
        )}
      </div>

      {/* Section 1: External inbound */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GlobeIcon size={14} weight="duotone" className="text-text-muted" />
            <span className="text-sm font-medium text-text-bright">
              External inbound
            </span>
          </div>
          {/* Toggle */}
          <button
            type="button"
            role="switch"
            aria-checked={policies.external_inbound_enabled}
            onClick={() =>
              setExternalEnabled(!policies.external_inbound_enabled)
            }
            className={[
              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent",
              "transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring",
              policies.external_inbound_enabled ? "bg-kumo-brand" : "bg-border",
            ].join(" ")}
          >
            <span
              className={[
                "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                policies.external_inbound_enabled
                  ? "translate-x-4"
                  : "translate-x-0",
              ].join(" ")}
            />
          </button>
        </div>
        <p className="text-xs text-text-muted">
          Allow emails from senders outside your workspace.
        </p>

        {policies.external_inbound_enabled && (
          <div className="flex flex-col gap-2 pl-0">
            <label className="text-xs font-medium text-text-muted">
              Who can send externally?
            </label>
            <Select
              aria-label="External allow mode"
              value={policies.external_allow_mode}
              onValueChange={(v) => setAllowMode(v as "all" | "allowlist")}
            >
              <Select.Option value="all">Anyone</Select.Option>
              <Select.Option value="allowlist">Allowlist only</Select.Option>
            </Select>

            {policies.external_allow_mode === "allowlist" && (
              <AllowlistEditor
                inboxId={inboxId}
                allowlist={policies.allowlist}
                onChange={() => void fetchPolicies()}
              />
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border" />

      {/* Section 2: Internal inbound */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <UsersIcon size={14} weight="duotone" className="text-text-muted" />
          <span className="text-sm font-medium text-text-bright">
            Internal inbound
          </span>
        </div>
        <p className="text-xs text-text-muted mb-1">
          Who can send you messages from within the workspace.
        </p>
        <Select
          aria-label="Internal inbound mode"
          value={policies.internal_inbound_mode}
          onValueChange={(v) =>
            setInternalMode(v as "everyone" | "contacts_only" | "none")
          }
        >
          <Select.Option value="everyone">Everyone</Select.Option>
          <Select.Option value="contacts_only">Contacts only</Select.Option>
          <Select.Option value="none">Nobody</Select.Option>
        </Select>
        <p className="text-xs text-text-muted">
          {policies.internal_inbound_mode === "everyone" &&
            "Any workspace member can message this inbox."}
          {policies.internal_inbound_mode === "contacts_only" &&
            "Only accepted contacts and group co-members can message this inbox."}
          {policies.internal_inbound_mode === "none" &&
            "No internal messages are accepted. Useful for outbound-only inboxes."}
        </p>
      </div>

      <div className="border-t border-border" />

      {/* Section 3: Outbound */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PaperPlaneTiltIcon
              size={14}
              weight="duotone"
              className="text-text-muted"
            />
            <span className="text-sm font-medium text-text-bright">
              Outbound
            </span>
          </div>
          {/* Toggle */}
          <button
            type="button"
            role="switch"
            aria-checked={policies.external_send_enabled}
            aria-label="Enable external sending"
            onClick={() =>
              setExternalSendEnabled(!policies.external_send_enabled)
            }
            className={[
              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent",
              "transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring",
              policies.external_send_enabled ? "bg-kumo-brand" : "bg-border",
            ].join(" ")}
          >
            <span
              className={[
                "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                policies.external_send_enabled
                  ? "translate-x-4"
                  : "translate-x-0",
              ].join(" ")}
            />
          </button>
        </div>
        <p className="text-xs text-text-muted">
          When off, this mailbox can only send to other mailboxes hosted in this
          app. Turn on to send externally via Cloudflare Email Routing
          (destination must be verified).
        </p>
      </div>
    </div>
  );
}
