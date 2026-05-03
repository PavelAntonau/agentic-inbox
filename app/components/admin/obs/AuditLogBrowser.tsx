// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// AuditLogBrowser — paginated audit log table with filter chips.
// Uses the Phase-3 Pagination primitive from app/ui/pagination.tsx.

import { Badge, Button, Input, Loader } from "~/ui";
import { Pagination } from "~/ui/pagination";
import { useEffect, useState } from "react";
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";

interface AuditRow {
  id: number;
  at: number;
  actor_user_id: string | null;
  actor_token_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  scope_group_id: string | null;
  meta_json: string | null;
  ip: string | null;
}

interface PaginationInfo {
  page: number;
  per_page: number;
  total_count: number;
  total_pages: number;
}

interface AuditResponse {
  rows: AuditRow[];
  pagination: PaginationInfo;
}

const PER_PAGE = 50;

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

// Action prefix chips for quick filtering
const ACTION_PRESETS = [
  "email.",
  "token.",
  "contact.",
  "group.",
  "mailbox.",
  "workspace.",
  "settings.",
  "visibility.",
];

export interface AuditLogBrowserProps {
  initialActionFilter?: string;
}

export default function AuditLogBrowser({
  initialActionFilter = "",
}: AuditLogBrowserProps) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState(initialActionFilter);
  const [actorFilter, setActorFilter] = useState("");
  const [targetFilter, setTargetFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [searchInput, setSearchInput] = useState(initialActionFilter);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          page: String(page),
          per_page: String(PER_PAGE),
        });
        if (actionFilter) params.set("action", actionFilter);
        if (actorFilter) params.set("actor", actorFilter);
        if (targetFilter) params.set("target", targetFilter);
        if (groupFilter) params.set("group", groupFilter);

        const res = await fetch(`/api/admin/obs/audit?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as AuditResponse;
        if (!cancelled) {
          setRows(json.rows);
          setPagination(json.pagination);
        }
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
  }, [page, actionFilter, actorFilter, targetFilter, groupFilter]);

  function applySearch() {
    setActionFilter(searchInput.trim());
    setPage(1);
  }

  function clearFilters() {
    setActionFilter("");
    setActorFilter("");
    setTargetFilter("");
    setGroupFilter("");
    setSearchInput("");
    setPage(1);
  }

  const hasFilters = actionFilter || actorFilter || targetFilter || groupFilter;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-bright">Audit Log</h2>
        {pagination && (
          <span className="text-xs text-text-muted">
            {pagination.total_count.toLocaleString()} events (last 7 days
            default)
          </span>
        )}
      </div>

      {/* Search + filter bar */}
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="flex items-center gap-1 flex-1 min-w-[200px]">
          <Input
            aria-label="Filter by action"
            placeholder="Filter by action (e.g. email.)"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applySearch()}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={<MagnifyingGlassIcon size={14} />}
            onClick={applySearch}
          >
            Search
          </Button>
        </div>
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            icon={<XIcon size={14} />}
            onClick={clearFilters}
          >
            Clear
          </Button>
        )}
      </div>

      {/* Action preset chips */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {ACTION_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => {
              setActionFilter(actionFilter === preset ? "" : preset);
              setSearchInput(actionFilter === preset ? "" : preset);
              setPage(1);
            }}
            className={[
              "rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors",
              actionFilter === preset
                ? "border-kumo-brand bg-kumo-brand text-white"
                : "border-border text-text-muted hover:border-kumo-ring",
            ].join(" ")}
          >
            {preset}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <Loader size="base" />
        </div>
      )}

      {error && (
        <p className="text-sm text-kumo-danger py-4 text-center">{error}</p>
      )}

      {!loading && !error && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-muted border-b border-border">
                  <th className="pb-2 font-normal whitespace-nowrap">Time</th>
                  <th className="pb-2 font-normal whitespace-nowrap">Action</th>
                  <th className="pb-2 font-normal whitespace-nowrap">Actor</th>
                  <th className="pb-2 font-normal whitespace-nowrap">Target</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border last:border-0 hover:bg-tx-card-hover"
                  >
                    <td className="py-1.5 pr-3 text-text-muted whitespace-nowrap">
                      {formatDate(row.at)}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge variant="secondary">{row.action}</Badge>
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-text-muted truncate max-w-[120px]">
                      {row.actor_user_id ?? row.actor_token_id ?? "—"}
                    </td>
                    <td className="py-1.5 font-mono text-text-muted truncate max-w-[120px]">
                      {row.target_type && row.target_id
                        ? `${row.target_type}:${row.target_id}`
                        : "—"}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="py-8 text-center text-text-muted"
                    >
                      No audit events found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {pagination && pagination.total_count > PER_PAGE && (
            <div className="mt-4">
              <Pagination
                page={page}
                setPage={setPage}
                perPage={PER_PAGE}
                totalCount={pagination.total_count}
                controls="minimal"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
