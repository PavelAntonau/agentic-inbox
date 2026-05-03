// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button, Loader } from "~/ui";
import { useCallback, useEffect, useState } from "react";
import SettingsRow, {
  type SettingRowData,
} from "~/components/admin/SettingsRow";

export function meta() {
  return [{ title: "Admin — Settings | Agentic Inbox" }];
}

interface SettingsApiResponse {
  settings: SettingRowData[];
}

export default function AdminSettingsRoute() {
  const [settings, setSettings] = useState<SettingRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings");
      if (!res.ok) throw new Error(`Failed to load settings: ${res.status}`);
      const data = (await res.json()) as SettingsApiResponse;
      // Filter out internal version key (settings_version) — UI catalog only
      setSettings(data.settings.filter((s) => s.key !== "settings_version"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const handleSaved = (key: string, value: string) => {
    setSettings((prev) =>
      prev.map((s) =>
        s.key === key ? { ...s, value, updated_at: Date.now() } : s,
      ),
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-panel border border-border bg-card p-6">
        <p className="text-sm text-kumo-danger">{error}</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => void fetchSettings()}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-text-bright">
          Workspace Settings
        </h1>
        <p className="text-sm text-text-muted mt-0.5">
          Live-configurable limits and defaults for the workspace.
        </p>
      </div>

      <div className="rounded-panel border border-border bg-card px-5 py-2">
        {settings.length === 0 ? (
          <p className="text-sm text-text-muted py-8 text-center">
            No settings configured.
          </p>
        ) : (
          settings.map((setting) => (
            <SettingsRow
              key={setting.key}
              setting={setting}
              onSaved={handleSaved}
            />
          ))
        )}
      </div>
    </>
  );
}
