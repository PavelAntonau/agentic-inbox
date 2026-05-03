// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// TokenRow — single row in a token list table.

import { Badge, Button } from "~/ui";
import { TrashIcon } from "@phosphor-icons/react";

export interface AgentToken {
  id: string;
  cf_client_id: string | null;
  label: string | null;
  max_instances: number;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  /** Only present on admin-wide list */
  mailbox_id?: string;
  issued_to_user?: string;
}

interface TokenRowProps {
  token: AgentToken;
  onRevoke: (token: AgentToken) => void;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function TokenRow({ token, onRevoke }: TokenRowProps) {
  const isRevoked = !!token.revoked_at;

  return (
    <tr className="border-b border-kumo-line last:border-0">
      <td className="py-3 pr-4">
        <p className="text-sm font-medium text-kumo-default">
          {token.label ?? "(no label)"}
        </p>
        {token.cf_client_id && (
          <p className="text-xs text-kumo-subtle font-mono mt-0.5 truncate max-w-48">
            {token.cf_client_id}
          </p>
        )}
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
        {isRevoked ? (
          <Badge variant="destructive">Revoked</Badge>
        ) : (
          <Badge variant="success">Active</Badge>
        )}
      </td>
      <td className="py-3 text-right">
        {!isRevoked && (
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            aria-label="Revoke token"
            onClick={() => onRevoke(token)}
          >
            <TrashIcon size={14} />
          </Button>
        )}
      </td>
    </tr>
  );
}
