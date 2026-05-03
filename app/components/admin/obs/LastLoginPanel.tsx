// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// LastLoginPanel — table of users + last_login_at + relative time.

import { Badge, Loader } from "~/ui";
import { useEffect, useState } from "react";

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: "global_owner" | "global_admin" | "user";
  status: "active" | "disabled";
  last_login_at: number | null;
}

interface LastLoginData {
  users: UserRow[];
}

function relativeTime(ms: number | null): string {
  if (ms === null) return "Never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

const ROLE_LABELS: Record<UserRow["role"], string> = {
  global_owner: "Owner",
  global_admin: "Admin",
  user: "User",
};

export default function LastLoginPanel() {
  const [data, setData] = useState<LastLoginData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/obs/last-login");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as LastLoginData;
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

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-semibold text-text-bright mb-4">
        Last Login
      </h2>

      {loading && (
        <div className="flex justify-center py-8">
          <Loader size="base" />
        </div>
      )}

      {error && (
        <p className="text-sm text-kumo-danger py-4 text-center">{error}</p>
      )}

      {data && !loading && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted border-b border-border">
                <th className="pb-2 font-normal">User</th>
                <th className="pb-2 font-normal">Role</th>
                <th className="pb-2 font-normal text-right">Last Login</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="py-2 pr-4">
                    <p className="text-text-bright truncate max-w-[200px]">
                      {user.display_name || user.email}
                    </p>
                    {user.display_name && (
                      <p className="text-xs text-text-muted">{user.email}</p>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <Badge
                      variant={
                        user.role === "global_owner"
                          ? "primary"
                          : user.role === "global_admin"
                            ? "secondary"
                            : "secondary"
                      }
                    >
                      {ROLE_LABELS[user.role]}
                    </Badge>
                  </td>
                  <td className="py-2 text-right text-text-muted">
                    {relativeTime(user.last_login_at)}
                  </td>
                </tr>
              ))}
              {data.users.length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="py-8 text-center text-text-muted text-sm"
                  >
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
