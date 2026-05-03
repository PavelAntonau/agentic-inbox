// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Admin — Agent Tokens (admin-wide list across all mailboxes).
// Accessible to global_owner / global_admin only (enforced server-side;
// the admin layout client-side guard redirects others to /).

import { Button, Loader } from "~/ui";
import { useCallback, useEffect, useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import TokenRow, { type AgentToken } from "~/components/tokens/TokenRow";
import RevokeTokenDialog from "~/components/tokens/RevokeTokenDialog";

export function meta() {
  return [{ title: "Admin — Agent Tokens | Agentic Inbox" }];
}

interface TokensApiResponse {
  tokens: AgentToken[];
}

export default function AdminTokensRoute() {
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<AgentToken | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/tokens");
      if (!res.ok) throw new Error(`Failed to load tokens: ${res.status}`);
      const data = (await res.json()) as TokensApiResponse;
      setTokens(data.tokens);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTokens();
  }, [fetchTokens]);

  const handleRevoke = (token: AgentToken) => {
    setRevokeTarget(token);
    setRevokeOpen(true);
  };

  const activeCount = tokens.filter((t) => !t.revoked_at).length;
  const revokedCount = tokens.filter((t) => !!t.revoked_at).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-kumo-default">Agent Tokens</h1>
          <p className="text-sm text-kumo-subtle mt-1">
            All service tokens issued across every mailbox.
            {!loading && (
              <>
                {" "}
                {activeCount} active, {revokedCount} revoked.
              </>
            )}
          </p>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <Loader size="lg" />
        </div>
      )}

      {error && <p className="text-sm text-kumo-danger py-4">{error}</p>}

      {!loading && !error && tokens.length === 0 && (
        <p className="text-sm text-kumo-subtle py-8 text-center">
          No agent tokens have been issued yet.
        </p>
      )}

      {!loading && !error && tokens.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-kumo-line bg-kumo-base">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-kumo-line">
                <th className="py-3 pr-4 text-left text-xs font-semibold text-kumo-subtle uppercase tracking-wide">
                  Label / Client ID
                </th>
                <th className="py-3 pr-4 text-left text-xs font-semibold text-kumo-subtle uppercase tracking-wide">
                  Mailbox
                </th>
                <th className="py-3 pr-4 text-left text-xs font-semibold text-kumo-subtle uppercase tracking-wide">
                  Max
                </th>
                <th className="py-3 pr-4 text-left text-xs font-semibold text-kumo-subtle uppercase tracking-wide">
                  Issued
                </th>
                <th className="py-3 pr-4 text-left text-xs font-semibold text-kumo-subtle uppercase tracking-wide">
                  Last seen
                </th>
                <th className="py-3 pr-4 text-left text-xs font-semibold text-kumo-subtle uppercase tracking-wide">
                  Status
                </th>
                <th className="py-3" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <AdminTokenRow
                  key={token.id}
                  token={token}
                  onRevoke={handleRevoke}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RevokeTokenDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        token={revokeTarget}
        onRevoked={fetchTokens}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin-specific row — includes mailbox_id column
// ---------------------------------------------------------------------------

interface AdminTokenRowProps {
  token: AgentToken;
  onRevoke: (token: AgentToken) => void;
}

function AdminTokenRow({ token, onRevoke }: AdminTokenRowProps) {
  const isRevoked = !!token.revoked_at;

  function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return (
    <tr className="border-b border-kumo-line last:border-0">
      <td className="py-3 pr-4">
        <p className="text-sm font-medium text-kumo-default">
          {token.label ?? "(no label)"}
        </p>
        {token.cf_client_id && (
          <p className="text-xs text-kumo-subtle font-mono mt-0.5 truncate max-w-40">
            {token.cf_client_id}
          </p>
        )}
      </td>
      <td className="py-3 pr-4 text-xs text-kumo-subtle font-mono">
        {token.mailbox_id ?? "—"}
      </td>
      <td className="py-3 pr-4 text-sm text-kumo-subtle">
        {token.max_instances}
      </td>
      <td className="py-3 pr-4 text-sm text-kumo-subtle">
        {formatDate(token.created_at)}
      </td>
      <td className="py-3 pr-4 text-sm text-kumo-subtle">
        {token.last_seen_at ? formatDate(token.last_seen_at) : "—"}
      </td>
      <td className="py-3 pr-4">
        <span
          className={[
            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
            isRevoked
              ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400"
              : "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400",
          ].join(" ")}
        >
          {isRevoked ? "Revoked" : "Active"}
        </span>
      </td>
      <td className="py-3 text-right">
        {!isRevoked && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRevoke(token)}
            aria-label="Revoke token"
          >
            Revoke
          </Button>
        )}
      </td>
    </tr>
  );
}
