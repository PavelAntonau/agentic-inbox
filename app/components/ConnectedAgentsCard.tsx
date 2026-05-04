// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// ConnectedAgentsCard — OAuth-provider grants surfaced on /account.
//
// Backs the user-side view of `oauth_consent` rows: one card per (caller,
// client) grant. Source of truth is the Phase-2 / T2.3 endpoint pair
//   GET    /api/users/me/agent-authorizations              — list
//   DELETE /api/users/me/agent-authorizations/:clientId    — revoke (RFC 7009)
//
// Distinct from the broader ClientsPanel (D-PLAT-7), which surfaces every
// client kind (browser sessions, MCP, iOS, desktop) from /api/users/me/clients.
// This card scopes specifically to OAuth grants minted by the
// @better-auth/oauth-provider plugin so the consent flow has a clean
// user-facing revocation surface that round-trips to RFC 7009 semantics.
// Phase 3 will reconcile the two surfaces (open question carried in the
// mcp-oauth action plan).

import { Button, Loader, Text, useToastManager } from "~/ui";
import { ShieldCheckIcon, PlugIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { safeHttpsHref } from "~/lib/sanitize";

export interface AgentAuthorization {
  client_id: string;
  client_name: string | null;
  client_uri: string | null;
  client_icon: string | null;
  scopes: string[];
  granted_at: number | null;
  last_used_at: number | null;
  is_trusted: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Treat `granted_at` / `last_used_at` as either seconds or milliseconds.
// better-auth/oauth-provider writes JS-millisecond Date.now() into Drizzle
// integer columns; legacy rows or test fixtures may pass seconds. A ts < 1e12
// is unambiguously seconds-since-epoch (year 33658 in ms) — promote to ms.
function toMillis(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

function timeAgo(ts: number | null): string | null {
  if (ts == null) return null;
  const ms = toMillis(ts);
  const diffMs = Date.now() - ms;
  if (diffMs < 0) return "just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12) return `${diffMon}mo ago`;
  const diffYr = Math.floor(diffDay / 365);
  return `${diffYr}y ago`;
}

// Pretty-print an `mcp:resource:action` scope as "Resource · Action".
// Anything that doesn't match the 3-segment pattern falls through verbatim
// so unexpected scopes are visible (vs silently swallowed).
export function formatScope(scope: string): string {
  const parts = scope.split(":");
  if (parts.length !== 3 || parts[0] !== "mcp") return scope;
  const [, resource, action] = parts;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(resource)} · ${cap(action)}`;
}

// ---------------------------------------------------------------------------
// Single card
// ---------------------------------------------------------------------------

interface AgentCardProps {
  grant: AgentAuthorization;
  onRevoke: (clientId: string) => Promise<void>;
}

function AgentCard({ grant, onRevoke }: AgentCardProps) {
  const [revoking, setRevoking] = useState(false);
  const handleRevoke = async () => {
    setRevoking(true);
    try {
      await onRevoke(grant.client_id);
    } finally {
      setRevoking(false);
    }
  };

  const iconHref = safeHttpsHref(grant.client_icon);
  const grantedLabel = timeAgo(grant.granted_at);
  const lastUsedLabel = timeAgo(grant.last_used_at);
  const displayName =
    grant.client_name && grant.client_name.trim().length > 0
      ? grant.client_name
      : grant.client_id;

  return (
    <li
      data-testid="connected-agent-card"
      data-client-id={grant.client_id}
      className="flex items-start justify-between gap-3 rounded-[10px] border border-border px-3 py-2.5"
    >
      {/* Left: icon + info */}
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {iconHref ? (
            <img
              src={iconHref}
              alt=""
              className="h-8 w-8 rounded-md border border-border object-cover"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div
              data-testid="connected-agent-icon-fallback"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card"
            >
              <PlugIcon
                size={18}
                weight="duotone"
                className="text-text-muted"
              />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {/* Name row */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-text-bright">
              {displayName}
            </span>
            {grant.is_trusted ? (
              <span
                data-testid="trusted-badge"
                className="inline-flex items-center gap-1 rounded-full bg-kumo-brand/10 px-2 py-0.5 text-xs font-medium text-kumo-brand"
              >
                <ShieldCheckIcon size={11} weight="bold" />
                Trusted
              </span>
            ) : (
              <span className="rounded-full bg-border px-2 py-0.5 text-xs text-text-muted">
                Registered
              </span>
            )}
          </div>

          {/* Scopes */}
          {grant.scopes.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {grant.scopes.map((scope) => (
                <span
                  key={scope}
                  data-testid="scope-badge"
                  title={scope}
                  className="rounded bg-border/50 px-1.5 py-0.5 text-xs text-text-muted"
                >
                  {formatScope(scope)}
                </span>
              ))}
            </div>
          )}

          {/* Meta row */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-muted">
            {grantedLabel && <span>Granted {grantedLabel}</span>}
            {lastUsedLabel ? (
              <span>Last used {lastUsedLabel}</span>
            ) : (
              <span>Never used</span>
            )}
          </div>
        </div>
      </div>

      {/* Right: revoke */}
      <div className="shrink-0">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void handleRevoke()}
          disabled={revoking}
          aria-label={`Revoke ${displayName}`}
        >
          {revoking ? "Revoking…" : "Revoke"}
        </Button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function ConnectedAgentsCard() {
  const [grants, setGrants] = useState<AgentAuthorization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toastManager = useToastManager();

  const fetchGrants = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/users/me/agent-authorizations");
      if (!res.ok) {
        throw new Error(`Failed to load (${res.status})`);
      }
      const data = (await res.json()) as AgentAuthorization[];
      setGrants(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to load connected agents",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchGrants();
  }, [fetchGrants]);

  const handleRevoke = useCallback(
    async (clientId: string) => {
      try {
        const res = await fetch(
          `/api/users/me/agent-authorizations/${encodeURIComponent(clientId)}`,
          { method: "DELETE" },
        );
        if (res.status === 204) {
          toastManager.add({ title: "Agent access revoked" });
          await fetchGrants();
          return;
        }
        if (res.status === 404) {
          // Already revoked elsewhere — refresh silently.
          await fetchGrants();
          return;
        }
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toastManager.add({
          title: body.error ?? `Failed to revoke (${res.status})`,
          variant: "error",
        });
      } catch {
        toastManager.add({ title: "Network error", variant: "error" });
      }
    },
    [fetchGrants, toastManager],
  );

  return (
    <section
      data-testid="connected-agents-card"
      className="mb-6 rounded-panel border border-border bg-card p-6"
    >
      <div className="mb-1 flex items-center gap-2">
        <PlugIcon size={18} weight="duotone" className="text-text-muted" />
        <h2 className="text-lg font-semibold text-text-bright">
          Connected MCP Agents
        </h2>
        {!loading && grants.length > 0 && (
          <span className="rounded-full bg-border px-2 py-0.5 text-xs font-medium text-text-muted">
            {grants.length}
          </span>
        )}
      </div>
      <p className="mb-4 text-sm text-text-muted">
        OAuth grants from MCP clients that have been authorized to act on your
        behalf. Revoke any you don&apos;t recognise — the next request from that
        client will fail.
      </p>

      {loading ? (
        <div className="flex justify-center py-4">
          <Loader size="sm" />
        </div>
      ) : error ? (
        <Text variant="error">{error}</Text>
      ) : grants.length === 0 ? (
        <p className="py-2 text-sm text-text-muted">
          No connected MCP agents yet — install an MCP client and authorize it
          on the consent screen to see it here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {grants.map((grant) => (
            <AgentCard
              key={grant.client_id}
              grant={grant}
              onRevoke={handleRevoke}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
