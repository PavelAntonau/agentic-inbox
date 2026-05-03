// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Loader } from "~/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { UsersThreeIcon, PlusIcon } from "@phosphor-icons/react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GroupSummary {
  id: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  member_count: number;
  actor_role_in_group: "owner" | "admin" | "member" | null;
  created_at: number;
}

interface GroupsApiResponse {
  groups: GroupSummary[];
}

// ---------------------------------------------------------------------------
// Groups layout — left rail + outlet
// ---------------------------------------------------------------------------

export default function GroupsLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/groups");
      if (res.status === 401 || res.status === 403) {
        navigate("/", { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`Failed to load groups: ${res.status}`);
      const data = (await res.json()) as GroupsApiResponse;
      setGroups(data.groups);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    void fetchGroups();
  }, [fetchGroups]);

  const isActive = (groupId: string) =>
    location.pathname.includes(`/groups/${groupId}`);

  return (
    <div className="flex min-h-screen bg-bg">
      {/* Left rail */}
      <aside className="hidden w-60 shrink-0 border-r border-border md:flex md:flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold text-text-bright">Groups</span>
          <Link
            to="/groups"
            className="flex h-7 w-7 items-center justify-center rounded-[10px] text-text-muted hover:bg-tx-card-hover hover:text-text-bright transition-colors"
            aria-label="All groups"
          >
            <PlusIcon size={16} />
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto py-2">
          {loading && (
            <div className="flex justify-center py-8">
              <Loader size="sm" />
            </div>
          )}
          {error && (
            <p className="px-4 py-3 text-xs text-kumo-danger">{error}</p>
          )}
          {!loading && !error && groups.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-text-muted">
              No groups yet
            </p>
          )}
          {groups.map((g) => (
            <Link
              key={g.id}
              to={`/groups/${g.id}`}
              className={[
                "flex items-center gap-2.5 px-4 py-2 text-sm transition-colors",
                isActive(g.id)
                  ? "bg-tx-card-active text-text-bright font-medium"
                  : "text-text hover:bg-tx-card-hover hover:text-text-bright",
              ].join(" ")}
            >
              <UsersThreeIcon size={16} className="shrink-0 text-text-muted" />
              <span className="truncate">{g.name}</span>
              {g.actor_role_in_group === "owner" && (
                <span className="ml-auto shrink-0 text-[10px] font-medium text-text-muted">
                  owner
                </span>
              )}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Content area */}
      <main className="flex-1 overflow-auto">
        <Outlet context={{ groups, refetchGroups: fetchGroups }} />
      </main>
    </div>
  );
}
