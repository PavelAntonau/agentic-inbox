// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// ClientRow — renders one Client entry inside ClientsPanel.
//
// Shows: kind icon, name, kind badge, granted-inboxes summary (expandable),
// last-seen relative, IP, UA-friendly name, "this device" badge, Revoke button,
// "Grant inbox access" button.  Revoked rows render at reduced opacity.

// TODO(post-integration): import shared types from workers/routes/clients.ts once shared types module exists
import type { Client, ClientGrant } from "./ClientsPanel";
import {
  MonitorIcon,
  PlugIcon,
  DeviceMobileIcon,
  LaptopIcon,
  SquareIcon,
  CaretDownIcon,
  CaretUpIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "~/ui";
import GrantInboxDialog from "./GrantInboxDialog";

interface ClientRowProps {
  client: Client;
  isCurrent: boolean;
  onRevoke: (clientId: string) => Promise<void>;
  onGranted: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Icon by kind
// ---------------------------------------------------------------------------

function KindIcon({ kind }: { kind: Client["kind"] }) {
  const props = {
    size: 16,
    weight: "duotone" as const,
    className: "text-text-muted shrink-0",
  };
  switch (kind) {
    case "browser":
      return <MonitorIcon {...props} />;
    case "mcp":
      return <PlugIcon {...props} />;
    case "ios":
      return <DeviceMobileIcon {...props} />;
    case "desktop":
      return <LaptopIcon {...props} />;
    default:
      return <SquareIcon {...props} />;
  }
}

// ---------------------------------------------------------------------------
// Kind badge label
// ---------------------------------------------------------------------------

function kindLabel(kind: Client["kind"]): string {
  switch (kind) {
    case "browser":
      return "Browser";
    case "mcp":
      return "MCP Agent";
    case "ios":
      return "iOS App";
    case "desktop":
      return "Desktop App";
    default:
      return "Other";
  }
}

// ---------------------------------------------------------------------------
// Relative time — reuses the same logic as account.tsx's timeAgo
// ---------------------------------------------------------------------------

function timeAgo(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ---------------------------------------------------------------------------
// Lightweight inline UA parser
// No third-party library — browser+OS detection only.
// ---------------------------------------------------------------------------

function parseUaFriendly(ua: string | null): string {
  if (!ua) return "Unknown device";
  // Browser detection (order matters — Edge before Chrome, OPR before Chrome)
  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = "Safari";

  // OS detection
  let os = "";
  if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua)) os = "iPad";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "Mac";
  else if (/Windows NT/.test(ua)) os = "Windows";
  else if (/Linux/.test(ua)) os = "Linux";

  return os ? `${browser} on ${os}` : browser;
}

// ---------------------------------------------------------------------------
// GrantsSummary — collapsible inbox-grants list
// ---------------------------------------------------------------------------

function GrantsSummary({ grants }: { grants: ClientGrant[] }) {
  const [expanded, setExpanded] = useState(false);
  if (grants.length === 0)
    return <span className="text-xs text-text-muted">No inbox access</span>;

  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-bright transition-colors"
      onClick={() => setExpanded((p) => !p)}
    >
      <span>
        {grants.length} {grants.length === 1 ? "inbox" : "inboxes"}
      </span>
      {expanded ? (
        <CaretUpIcon size={12} weight="bold" />
      ) : (
        <CaretDownIcon size={12} weight="bold" />
      )}
      {expanded && (
        <ul className="absolute z-10 mt-1 rounded-md border border-border bg-card p-2 shadow-lg">
          {grants.map((g) => (
            <li
              key={g.inbox_id}
              className="flex items-center gap-2 px-1 py-0.5 text-xs"
            >
              <span className="font-mono text-text-bright truncate max-w-[120px]">
                {g.inbox_id}
              </span>
              <span className="rounded px-1 bg-border text-text-muted">
                {g.scope}
              </span>
            </li>
          ))}
        </ul>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ClientRow
// ---------------------------------------------------------------------------

export default function ClientRow({
  client,
  isCurrent,
  onRevoke,
  onGranted,
}: ClientRowProps) {
  const [revoking, setRevoking] = useState(false);
  const [grantDialogOpen, setGrantDialogOpen] = useState(false);

  const handleRevoke = async () => {
    setRevoking(true);
    try {
      await onRevoke(client.id);
    } finally {
      setRevoking(false);
    }
  };

  const isRevoked = client.revoked_at != null;

  return (
    <li
      data-testid="client-row"
      className={[
        "flex items-start justify-between gap-3 rounded-[10px] border border-border px-3 py-2.5",
        isRevoked ? "opacity-50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Left: icon + info */}
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <div className="mt-0.5">
          <KindIcon kind={client.kind} />
        </div>
        <div className="min-w-0 flex-1">
          {/* Name row */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-text-bright">
              {client.name}
            </span>
            <span className="rounded-full bg-border px-2 py-0.5 text-xs text-text-muted">
              {kindLabel(client.kind)}
            </span>
            {isCurrent && (
              <span className="rounded-full bg-kumo-brand/10 px-2 py-0.5 text-xs font-medium text-kumo-brand">
                this device
              </span>
            )}
            {isRevoked && (
              <span className="rounded-full bg-kumo-danger/10 px-2 py-0.5 text-xs font-medium text-kumo-danger">
                Revoked
              </span>
            )}
          </div>

          {/* Meta row */}
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-text-muted relative">
            {client.last_seen_at != null && (
              <span>{timeAgo(client.last_seen_at)}</span>
            )}
            {client.ip_address && <span>{client.ip_address}</span>}
            <span className="truncate max-w-[200px]">
              {parseUaFriendly(client.user_agent)}
            </span>
          </div>

          {/* Grants summary */}
          <div className="mt-1 relative">
            <GrantsSummary grants={client.grants} />
          </div>

          {/* Revoked timestamp */}
          {isRevoked && client.revoked_at != null && (
            <p className="mt-0.5 text-xs text-text-muted">
              Revoked {timeAgo(client.revoked_at)}
            </p>
          )}
        </div>
      </div>

      {/* Right: action buttons */}
      {!isRevoked && (
        <div className="flex shrink-0 flex-col gap-1">
          {!isCurrent && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void handleRevoke()}
              disabled={revoking}
            >
              {revoking ? "…" : "Revoke"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setGrantDialogOpen(true)}
          >
            Grant inbox access
          </Button>
        </div>
      )}

      {/* Grant inbox dialog */}
      <GrantInboxDialog
        clientId={client.id}
        currentGrants={client.grants.map((g) => g.inbox_id)}
        open={grantDialogOpen}
        onClose={() => setGrantDialogOpen(false)}
        onGranted={async () => {
          setGrantDialogOpen(false);
          await onGranted();
        }}
      />
    </li>
  );
}
