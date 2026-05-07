// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// MCPPanel — per-inbox MCP server panel with Web | Token tabs.
//
// Phase F (one-inbox-one-client, 2026-05-06): rebuilt to surface the
// `mcp_inbox_binding` sentinel state and to drive the user's revoke
// flow. The previous panel showed only the URL + an "auth not wired"
// warning; that warning is gone now — auth IS wired, and this panel
// is where the user reads / disconnects the credential.
//
// Tabs:
//   Web   — OAuth-client flow. Trusted MCP clients (Claude Code,
//           Cursor, …) bind on first /mcp call. Shows the bound
//           client + a Disconnect button when set, otherwise the
//           "paste-this-and-go" registration command.
//   Token — Personal Access Token flow. Shows the bound PAT
//           (label + prefix..suffix + last-used) + a Revoke button
//           when set; otherwise a Mint form (label + scopes +
//           optional expiry).
//
// Both tabs read from GET /api/mailboxes/:id/mcp-credential and write
// through DELETE /api/mailboxes/:id/mcp-credential or POST
// /api/users/me/pats. Mutual exclusion is enforced server-side
// (migration 0017's PRIMARY KEY + CHECK constraint); the panel just
// reflects the resulting state.

import { Button, Tooltip } from "~/ui";
import {
  CheckIcon,
  CopyIcon,
  PlugsIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMailbox } from "~/queries/mailboxes";
import { useConfirm } from "~/components/ConfirmDialog";
import { useToastManager } from "~/ui/toast";

// ---------------------------------------------------------------------------
// Wire types — mirror workers/routes/mcp-credential.ts CredentialView
// ---------------------------------------------------------------------------

type CredentialView =
  | { kind: null }
  | {
      kind: "pat";
      pat_id: string;
      pat_label: string | null;
      pat_token_prefix: string;
      pat_token_suffix: string;
      pat_created_at: number;
      pat_last_used_at: number | null;
      pat_expires_at: number | null;
    }
  | {
      kind: "oauth";
      oauth_client_id: string;
      oauth_client_name: string | null;
      oauth_client_uri: string | null;
      oauth_client_icon: string | null;
      oauth_bound_at: number;
    };

interface MintedPat {
  pat: { id: string; label: string };
  token: string;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

const credentialKey = (mailboxId: string | undefined) =>
  ["mcp-credential", mailboxId ?? "_disabled"] as const;

function useMcpCredential(mailboxId: string | undefined) {
  return useQuery<CredentialView>({
    queryKey: credentialKey(mailboxId),
    enabled: !!mailboxId,
    queryFn: async () => {
      const r = await fetch(`/api/mailboxes/${mailboxId}/mcp-credential`);
      if (!r.ok) {
        throw new Error(`Failed to load MCP credential (${r.status})`);
      }
      return (await r.json()) as CredentialView;
    },
  });
}

function useRevokeMcpCredential(mailboxId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<void, Error>({
    mutationFn: async () => {
      const r = await fetch(`/api/mailboxes/${mailboxId}/mcp-credential`, {
        method: "DELETE",
      });
      if (!r.ok && r.status !== 204) {
        const detail = (await r.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(detail.error ?? `Revoke failed (${r.status})`);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: credentialKey(mailboxId) });
    },
  });
}

interface MintArgs {
  label: string;
  expires_at: number | null;
}

function useMintMailboxPat(mailboxId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<MintedPat, Error, MintArgs>({
    mutationFn: async (args) => {
      const r = await fetch(`/api/users/me/pats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: args.label,
          scopes: ["mcp:read", "mcp:write"],
          mailbox_id: mailboxId,
          expires_at: args.expires_at,
        }),
      });
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        if (r.status === 409) {
          throw new Error(
            detail.detail ??
              "This inbox already has an active MCP credential. Revoke it first.",
          );
        }
        throw new Error(detail.error ?? `Mint failed (${r.status})`);
      }
      return (await r.json()) as MintedPat;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: credentialKey(mailboxId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Reusable atoms
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable or permission denied — ignore silently
    }
  };

  return (
    <Tooltip content={copied ? "Copied!" : "Copy"} asChild>
      <Button
        variant="ghost"
        shape="square"
        size="sm"
        icon={
          copied ? (
            <CheckIcon size={12} weight="bold" className="text-green-500" />
          ) : (
            <CopyIcon size={12} />
          )
        }
        onClick={handleCopy}
        aria-label="Copy to clipboard"
      />
    </Tooltip>
  );
}

const TOOLS = [
  { name: "list_mailboxes", desc: "List all mailboxes" },
  { name: "list_emails", desc: "List emails in a folder" },
  { name: "get_email", desc: "Read a full email with body" },
  { name: "get_thread", desc: "Load a conversation thread" },
  { name: "search_emails", desc: "Search emails by query" },
  { name: "draft_reply", desc: "Draft a reply to an email" },
  { name: "send_reply", desc: "Send a reply" },
  { name: "send_email", desc: "Send a new email" },
  { name: "mark_email_read", desc: "Mark email as read/unread" },
  { name: "move_email", desc: "Move email to a folder" },
];

function formatDateOrNever(ms: number | null): string {
  if (ms === null) return "Never";
  return new Date(ms).toLocaleString();
}

// ---------------------------------------------------------------------------
// Tab bodies
// ---------------------------------------------------------------------------

function WebTabBody({
  mailboxId,
  credential,
  claudeAddCmd,
}: {
  mailboxId: string;
  credential: CredentialView | undefined;
  claudeAddCmd: string;
}) {
  const confirm = useConfirm();
  const toastManager = useToastManager();
  const revoke = useRevokeMcpCredential(mailboxId);

  if (credential?.kind === "oauth") {
    const clientLabel =
      credential.oauth_client_name?.trim() ?? credential.oauth_client_id;
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-bg p-4 space-y-2">
          <div className="flex items-center gap-2">
            {credential.oauth_client_icon ? (
              <img
                src={credential.oauth_client_icon}
                alt=""
                className="h-6 w-6 rounded"
              />
            ) : (
              <PlugsIcon size={20} className="text-blue" weight="duotone" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text-bright truncate">
                {clientLabel}
              </p>
              <p className="text-[11px] text-text-muted truncate">
                {credential.oauth_client_uri ?? credential.oauth_client_id}
              </p>
            </div>
          </div>
          <p className="text-[11px] text-text-muted">
            Bound at {formatDateOrNever(credential.oauth_bound_at)}.
          </p>
        </div>

        <Button
          variant="destructive"
          size="sm"
          disabled={revoke.isPending}
          onClick={() => {
            void (async () => {
              const ok = await confirm({
                title: "Disconnect this client?",
                body: "Future /mcp calls from this client will be rejected until you bind a fresh one. Existing bearer tokens become invalid immediately.",
                confirmLabel: "Disconnect",
                destructive: true,
              });
              if (!ok) return;
              try {
                await revoke.mutateAsync();
                toastManager.toast("MCP client disconnected.");
              } catch (err) {
                toastManager.toast(
                  err instanceof Error ? err.message : "Failed to disconnect",
                  { variant: "error" },
                );
              }
            })();
          }}
        >
          {revoke.isPending ? "Disconnecting…" : "Disconnect"}
        </Button>
      </div>
    );
  }

  if (credential?.kind === "pat") {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-3 space-y-1.5">
        <p className="text-xs font-semibold text-text-bright">
          This inbox is bound to a Personal Access Token.
        </p>
        <p className="text-[11px] text-text-muted leading-relaxed">
          Each inbox can only be bound to one MCP credential at a time. Revoke
          the PAT under the Token tab to free this inbox for an OAuth-based AI
          client.
        </p>
      </div>
    );
  }

  // No credential yet → show paste-and-go command
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-text-muted leading-relaxed">
        Paste the command below into Claude Code or another MCP-aware AI client.
        The first /mcp call binds this inbox to that client; no other client can
        use this inbox until you disconnect.
      </p>
      <div className="relative group">
        <div className="absolute right-1.5 top-1.5">
          <CopyButton text={claudeAddCmd} />
        </div>
        <pre className="bg-bg text-text-bright font-mono text-[11px] px-3 py-2.5 pr-10 rounded-lg border border-border whitespace-pre-wrap leading-relaxed">
          {claudeAddCmd}
        </pre>
      </div>
    </div>
  );
}

function TokenTabBody({
  mailboxId,
  credential,
}: {
  mailboxId: string;
  credential: CredentialView | undefined;
}) {
  const confirm = useConfirm();
  const toastManager = useToastManager();
  const revoke = useRevokeMcpCredential(mailboxId);
  const mint = useMintMailboxPat(mailboxId);

  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<"none" | "7d" | "30d" | "90d">("90d");
  const [mintedToken, setMintedToken] = useState<string | null>(null);

  if (credential?.kind === "oauth") {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-3 space-y-1.5">
        <p className="text-xs font-semibold text-text-bright">
          This inbox is bound to a web OAuth client.
        </p>
        <p className="text-[11px] text-text-muted leading-relaxed">
          Disconnect the client under the Web tab to free this inbox; you can
          then mint a Personal Access Token here.
        </p>
      </div>
    );
  }

  if (credential?.kind === "pat") {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-bg p-4 space-y-2">
          <p className="text-sm font-semibold text-text-bright">
            {credential.pat_label ?? "Personal Access Token"}
          </p>
          <p className="text-[11px] text-text-muted font-mono">
            pat_{credential.pat_token_prefix}…{credential.pat_token_suffix}
          </p>
          <div className="grid grid-cols-2 gap-2 text-[11px] text-text-muted">
            <span>Created: {formatDateOrNever(credential.pat_created_at)}</span>
            <span>
              Last used: {formatDateOrNever(credential.pat_last_used_at)}
            </span>
            <span className="col-span-2">
              Expires: {formatDateOrNever(credential.pat_expires_at)}
            </span>
          </div>
        </div>

        <Button
          variant="destructive"
          size="sm"
          disabled={revoke.isPending}
          onClick={() => {
            void (async () => {
              const ok = await confirm({
                title: "Revoke this token?",
                body: "Existing AI clients using this token will be cut off immediately. You can mint a fresh one afterwards.",
                confirmLabel: "Revoke",
                destructive: true,
              });
              if (!ok) return;
              try {
                await revoke.mutateAsync();
                toastManager.toast("Personal Access Token revoked.");
              } catch (err) {
                toastManager.toast(
                  err instanceof Error ? err.message : "Failed to revoke",
                  { variant: "error" },
                );
              }
            })();
          }}
        >
          {revoke.isPending ? "Revoking…" : "Revoke token"}
        </Button>
      </div>
    );
  }

  // No credential — show mint form
  const expiryMs = (() => {
    if (expiry === "none") return null;
    const days = expiry === "7d" ? 7 : expiry === "30d" ? 30 : 90;
    return Date.now() + days * 24 * 60 * 60 * 1000;
  })();

  return (
    <div className="space-y-4">
      {mintedToken ? (
        <div className="space-y-2 rounded-lg border border-green-500/40 bg-green-500/5 px-3 py-3">
          <p className="text-xs font-semibold text-text-bright">
            Token minted — copy it now.
          </p>
          <p className="text-[11px] text-text-muted leading-relaxed">
            This is the only time the full token will be displayed. Paste it
            into your MCP client's Authorization header now; you won't be able
            to read it again later.
          </p>
          <div className="relative group">
            <div className="absolute right-1.5 top-1.5">
              <CopyButton text={mintedToken} />
            </div>
            <pre className="bg-bg text-text-bright font-mono text-[11px] px-3 py-2.5 pr-10 rounded-lg border border-border whitespace-pre-wrap break-all leading-relaxed">
              {mintedToken}
            </pre>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMintedToken(null)}
          >
            Done
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <label
              htmlFor="pat-label"
              className="text-xs font-semibold text-text-bright block"
            >
              Token label
            </label>
            <input
              id="pat-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Claude Code on laptop"
              maxLength={120}
              className="w-full bg-bg text-text-bright text-[11px] px-3 py-2 rounded-lg border border-border"
            />
            <p className="text-[11px] text-text-muted">
              Helps you recognise the token later. Required.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-text-bright block">
              Expiry
            </label>
            <div className="flex flex-wrap gap-1.5">
              {(["7d", "30d", "90d", "none"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setExpiry(v)}
                  className={[
                    "rounded-lg border px-2.5 py-1 text-[11px] transition-colors",
                    expiry === v
                      ? "border-blue bg-blue/10 text-text-bright"
                      : "border-border text-text-muted hover:border-kumo-ring",
                  ].join(" ")}
                >
                  {v === "none"
                    ? "No expiry"
                    : v === "7d"
                      ? "7 days"
                      : v === "30d"
                        ? "30 days"
                        : "90 days"}
                </button>
              ))}
            </div>
          </div>

          <Button
            variant="primary"
            size="sm"
            disabled={mint.isPending || label.trim() === ""}
            onClick={() => {
              void (async () => {
                try {
                  const result = await mint.mutateAsync({
                    label: label.trim(),
                    expires_at: expiryMs,
                  });
                  setMintedToken(result.token);
                  setLabel("");
                } catch (err) {
                  toastManager.toast(
                    err instanceof Error ? err.message : "Failed to mint",
                    { variant: "error" },
                  );
                }
              })();
            }}
          >
            {mint.isPending ? "Minting…" : "Mint token"}
          </Button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function MCPPanel() {
  const { mailboxId } = useParams<{ mailboxId: string }>();
  const { data: mailbox } = useMailbox(mailboxId);
  const { data: credential } = useMcpCredential(mailboxId);

  const baseUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://your-app.workers.dev";
  const mcpUrl = `${baseUrl}/mcp`;
  const mailboxLabel =
    mailbox?.name?.trim() || mailbox?.email?.trim() || "this inbox";
  const claudeAddCmd = `claude mcp add inbox ${mcpUrl} --transport http`;

  // Tab state — default to whichever side already has a binding so the
  // user lands on the right surface to disconnect / inspect. New users
  // (no binding yet) land on Web because that's the headline flow.
  const [tab, setTab] = useState<"web" | "token">(() =>
    credential?.kind === "pat" ? "token" : "web",
  );

  if (!mailboxId) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Intro — explicit that the Agent + MCP are scoped to THIS inbox.
            The tab strip in AgentSidebar also shows the mailbox label so
            the scoping is unambiguous from any entry point. */}
        <div className="space-y-2">
          <p className="text-xs text-text-muted leading-relaxed">
            The agent and MCP server on this tab operate{" "}
            <span className="font-medium text-text-bright">
              only on {mailboxLabel}
            </span>{" "}
            — not the whole workspace. Each inbox can only be bound to{" "}
            <span className="font-medium text-text-bright">
              one MCP credential at a time
            </span>{" "}
            (one OAuth client OR one Personal Access Token).
          </p>
        </div>

        {/* Step 1 — Server URL */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-text-bright block">
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue/15 text-blue text-[10px] font-bold mr-1.5">
              1
            </span>
            Server URL
          </label>
          <div className="relative group">
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
              <CopyButton text={mcpUrl} />
            </div>
            <div className="bg-bg text-text-bright font-mono text-[11px] px-3 py-2.5 pr-10 rounded-lg border border-border break-all leading-relaxed">
              {mcpUrl}
            </div>
          </div>
        </div>

        {/* Step 2 — credential tabs */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-text-bright block">
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue/15 text-blue text-[10px] font-bold mr-1.5">
              2
            </span>
            Credential
          </label>

          <div
            className="flex gap-1 border-b border-border"
            role="tablist"
            aria-label="MCP credential type"
          >
            {(["web", "token"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={[
                  "px-3 py-1.5 text-xs font-medium transition-colors",
                  tab === t
                    ? "border-b-2 border-blue text-text-bright -mb-px"
                    : "text-text-muted hover:text-text-bright",
                ].join(" ")}
              >
                {t === "web" ? "Web (OAuth)" : "Token (PAT)"}
                {credential?.kind === "oauth" && t === "web" && (
                  <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
                )}
                {credential?.kind === "pat" && t === "token" && (
                  <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
                )}
              </button>
            ))}
          </div>

          <div className="pt-3">
            {tab === "web" ? (
              <WebTabBody
                mailboxId={mailboxId}
                credential={credential}
                claudeAddCmd={claudeAddCmd}
              />
            ) : (
              <TokenTabBody mailboxId={mailboxId} credential={credential} />
            )}
          </div>
        </div>

        {/* Available tools */}
        <div className="space-y-2">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-text-muted px-0.5 flex items-center gap-1.5">
            <PlugsIcon size={12} weight="bold" />
            Available Tools
          </h4>
          <div className="border border-border rounded-lg divide-y divide-border">
            {TOOLS.map((tool) => (
              <div
                key={tool.name}
                className="flex items-center gap-2.5 px-3 py-2"
              >
                <WrenchIcon
                  size={12}
                  weight="bold"
                  className="text-blue shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-mono font-medium text-text-bright">
                    {tool.name}
                  </span>
                </div>
                <span className="text-[11px] text-text-muted shrink-0">
                  {tool.desc}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
