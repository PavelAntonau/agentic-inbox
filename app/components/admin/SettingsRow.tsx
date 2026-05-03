// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Input } from "~/ui";
import { useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";

export interface SettingRowData {
  key: string;
  value: string;
  updated_at: number;
  updated_by: string | null;
}

const SETTING_LABELS: Record<
  string,
  { label: string; units?: string; description: string }
> = {
  max_regular_users: {
    label: "Max regular users",
    description: "Maximum total regular users in the workspace",
  },
  max_global_admins: {
    label: "Max global admins",
    description: "Maximum number of global admin seats",
  },
  max_private_mailboxes_per_user: {
    label: "Max private mailboxes per user",
    description: "Maximum private mailboxes a single user may own",
  },
  max_mailboxes_per_group: {
    label: "Max mailboxes per group",
    description: "Maximum mailboxes that can be assigned to one group",
  },
  max_groups_per_mailbox: {
    label: "Max groups per mailbox",
    description: "Maximum groups a single mailbox can belong to",
  },
  agent_token_default_max_instances: {
    label: "Agent token default max instances",
    description: "Default concurrent instance cap for new agent tokens",
  },
  agent_token_idle_prune_minutes: {
    label: "Agent token idle prune",
    units: "minutes",
    description: "Minutes of inactivity before an agent instance is pruned",
  },
  default_user_visibility: {
    label: "Default user visibility",
    description: "Default visibility setting for newly created users",
  },
  group_invitation_ttl_days: {
    label: "Group invitation TTL",
    units: "days",
    description: "Days before a pending group invitation expires",
  },
};

const ENUM_OPTIONS: Record<string, string[]> = {
  default_user_visibility: ["everyone", "contacts", "nobody"],
};

const DEBOUNCE_MS = 800;

interface SettingsRowProps {
  setting: SettingRowData;
  onSaved: (key: string, value: string) => void;
}

export default function SettingsRow({ setting, onSaved }: SettingsRowProps) {
  const toastManager = useKumoToastManager();
  const [localValue, setLocalValue] = useState(setting.value);
  const [isSaving, setIsSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meta = SETTING_LABELS[setting.key];
  const enumOptions = ENUM_OPTIONS[setting.key];

  // Sync when the prop changes (e.g. after a reload)
  useEffect(() => {
    setLocalValue(setting.value);
  }, [setting.value]);

  const save = async (value: string) => {
    if (value === setting.value) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/admin/settings/${setting.key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: enumOptions ? value : Number(value) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        value?: string;
      };
      if (!res.ok || !data.ok) {
        toastManager.add({
          title: data.error ?? `Failed to save ${setting.key}`,
          variant: "error",
        });
        setLocalValue(setting.value); // revert
        return;
      }
      toastManager.add({ title: `${meta?.label ?? setting.key} saved` });
      onSaved(setting.key, data.value ?? value);
    } catch {
      toastManager.add({
        title: `Failed to save ${setting.key}`,
        variant: "error",
      });
      setLocalValue(setting.value);
    } finally {
      setIsSaving(false);
    }
  };

  const handleChange = (value: string) => {
    setLocalValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => save(value), DEBOUNCE_MS);
  };

  return (
    <div className="flex items-start justify-between gap-6 py-4 border-b border-border last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-bright">
            {meta?.label ?? setting.key}
          </span>
          {meta?.units && (
            <span className="text-xs text-text-muted">({meta.units})</span>
          )}
          {isSaving && (
            <span className="text-xs text-text-muted animate-pulse">
              Saving…
            </span>
          )}
        </div>
        <p className="text-xs text-text-muted mt-0.5">
          {meta?.description ?? setting.key}
        </p>
      </div>
      <div className="w-48 shrink-0">
        {enumOptions ? (
          <select
            value={localValue}
            onChange={(e) => handleChange(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-bright focus:outline-none focus:ring-2 focus:ring-kumo-brand"
          >
            {enumOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : (
          <Input
            type="number"
            min={0}
            value={localValue}
            onChange={(e) => handleChange(e.target.value)}
            size="sm"
            aria-label={meta?.label ?? setting.key}
          />
        )}
      </div>
    </div>
  );
}
