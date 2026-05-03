// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// MessageRatePanel — email send rate over 24h/7d/30d windows.

import { Loader } from "~/ui";
import { useEffect, useState } from "react";

type Window = "last_24h" | "last_7d" | "last_30d";

interface WindowData {
  since: number;
  count: number;
}

interface MessageRateData {
  windows: Record<Window, WindowData>;
}

const WINDOW_LABELS: Record<Window, string> = {
  last_24h: "Last 24 hours",
  last_7d: "Last 7 days",
  last_30d: "Last 30 days",
};

const WINDOWS: Window[] = ["last_24h", "last_7d", "last_30d"];

export default function MessageRatePanel() {
  const [data, setData] = useState<MessageRateData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Window>("last_24h");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/obs/message-rate");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as MessageRateData;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeData = data?.windows[active];

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-bright">
          Email Send Rate
        </h2>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setActive(w)}
              className={[
                "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                active === w
                  ? "bg-kumo-brand text-white"
                  : "bg-kumo-fill text-text-muted hover:text-text",
              ].join(" ")}
            >
              {w === "last_24h" ? "24h" : w === "last_7d" ? "7d" : "30d"}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <Loader size="base" />
        </div>
      )}

      {error && (
        <p className="text-sm text-kumo-danger py-4 text-center">{error}</p>
      )}

      {data && !loading && activeData && (
        <div className="flex flex-col items-center gap-2 py-6">
          <p className="text-4xl font-bold text-text-bright tabular-nums">
            {activeData.count.toLocaleString()}
          </p>
          <p className="text-sm text-text-muted">
            email actions in {WINDOW_LABELS[active].toLowerCase()}
          </p>
          <p className="text-xs text-text-muted mt-1">
            Since {new Date(activeData.since).toLocaleString()}
          </p>
        </div>
      )}
    </div>
  );
}
