// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Per-mailbox agent tokens page.
// Visible to the mailbox owner and group admins with access (enforced server-side).
// Accessible at: /mailbox/:mailboxId/tokens

import { Button, Loader } from "~/ui";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { PlusIcon } from "@phosphor-icons/react";
import TokenRow, { type AgentToken } from "~/components/tokens/TokenRow";
import IssueTokenDialog from "~/components/tokens/IssueTokenDialog";
import RevokeTokenDialog from "~/components/tokens/RevokeTokenDialog";

export function meta() {
  return [{ title: "Agent Tokens | Agentic Inbox" }];
}

interface TokensApiResponse {
  tokens: AgentToken[];
}

export default function MailboxTokensRoute() {
  const { mailboxId } = useParams<{ mailboxId: string }>();

  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [issueOpen, setIssueOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AgentToken | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);

  const fetchTokens = useCallback(async () => {
    if (!mailboxId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tokens/mailboxes/${mailboxId}/tokens`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as TokensApiResponse;
      setTokens(data.tokens);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load tokens");
    } finally {
      setLoading(false);
    }
  }, [mailboxId]);

  useEffect(() => {
    void fetchTokens();
  }, [fetchTokens]);

  const handleRevoke = (token: AgentToken) => {
    setRevokeTarget(token);
    setRevokeOpen(true);
  };

  const activeCount = tokens.filter((t) => !t.revoked_at).length;

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-kumo-default">Agent Tokens</h1>
          <p className="text-sm text-kumo-subtle mt-0.5">
            Manage MCP service tokens for this mailbox.
            {!loading && activeCount > 0 && <> {activeCount} active.</>}
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setIssueOpen(true)}>
          <PlusIcon size={14} />
          Issue Token
        </Button>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <Loader size="lg" />
        </div>
      )}

      {error && <p className="text-sm text-kumo-danger py-4">{error}</p>}

      {!loading && !error && tokens.length === 0 && (
        <div className="rounded-xl border border-kumo-line bg-kumo-base py-12 text-center">
          <p className="text-sm text-kumo-subtle">
            No tokens yet. Issue one to connect an AI agent via MCP.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() => setIssueOpen(true)}
          >
            <PlusIcon size={14} />
            Issue Token
          </Button>
        </div>
      )}

      {!loading && !error && tokens.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-kumo-line bg-kumo-base">
          <table className="w-full min-w-[540px]">
            <thead>
              <tr className="border-b border-kumo-line">
                <th className="py-3 pr-4 pl-4 text-left text-xs font-semibold text-kumo-subtle uppercase tracking-wide">
                  Label / Client ID
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
                <th className="py-3 pr-4" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <TokenRow
                  key={token.id}
                  token={token}
                  onRevoke={handleRevoke}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {mailboxId && (
        <IssueTokenDialog
          open={issueOpen}
          onOpenChange={setIssueOpen}
          mailboxId={mailboxId}
          onIssued={fetchTokens}
        />
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
