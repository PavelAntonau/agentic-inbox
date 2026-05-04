// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// ActiveSessionsPanel — shows AgentTokenLimiter + RevocationCache snapshots.

import { Badge, Loader } from "~/ui";
import { useEffect, useState } from "react";

interface InstanceRecord {
  instance_id: string;
  fingerprint: string;
  last_seen_at: number;
}

interface TokenEntry {
  token_id: string;
  instance_count: number;
  instances: InstanceRecord[];
}

interface ActiveSessionsData {
  revoked_token_count: number;
  revoked_cf_client_ids: string[];
  active_token_entries: TokenEntry[];
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

export default function ActiveSessionsPanel() {
  const [data, setData] = useState<ActiveSessionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/obs/active-sessions");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ActiveSessionsData;
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

  const totalActive = data?.active_token_entries.reduce(
    (sum, t) => sum + t.instance_count,
    0,
  );

  return (
    <div className="obs-tile rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-bright">
          Active Agent Sessions
        </h2>
        {data && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{totalActive ?? 0} active</Badge>
            <Badge variant="destructive">
              {data.revoked_token_count} revoked
            </Badge>
          </div>
        )}
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <Loader size="base" />
        </div>
      )}

      {error && (
        <p className="text-sm text-kumo-danger py-4 text-center">{error}</p>
      )}

      {data && !loading && (
        <>
          {data.active_token_entries.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-6">
              No active agent sessions.
            </p>
          ) : (
            <div className="space-y-3">
              {data.active_token_entries.map((entry) => (
                <div
                  key={entry.token_id}
                  className="rounded-[10px] border border-border bg-bg p-3"
                >
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-mono text-text-muted truncate max-w-[220px]">
                      {entry.token_id}
                    </p>
                    <Badge variant="secondary">
                      {entry.instance_count}{" "}
                      {entry.instance_count === 1 ? "instance" : "instances"}
                    </Badge>
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-text-muted">
                        <th className="text-left font-normal pb-1">
                          Fingerprint
                        </th>
                        <th className="text-right font-normal pb-1">
                          Last seen
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.instances.map((inst) => (
                        <tr key={inst.instance_id}>
                          <td className="font-mono text-text truncate max-w-[200px]">
                            {inst.fingerprint || inst.instance_id.slice(0, 8)}
                          </td>
                          <td className="text-right text-text-muted">
                            {relativeTime(inst.last_seen_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {data.revoked_cf_client_ids.length > 0 && (
            <details className="mt-4">
              <summary className="text-xs text-text-muted cursor-pointer">
                {data.revoked_cf_client_ids.length} revoked client IDs in cache
              </summary>
              <ul className="mt-2 space-y-1">
                {data.revoked_cf_client_ids.map((id) => (
                  <li key={id} className="font-mono text-xs text-text-muted">
                    {id}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
