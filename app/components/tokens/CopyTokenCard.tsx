// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// CopyTokenCard — one-time secret reveal component shown immediately after
// token issuance. Displays CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET,
// the full mcp-remote snippet (OQ-V2U-1 resolved), and a download-as-JSON
// button. Never shown again after dialog close.

import { Button } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { CopyIcon, DownloadIcon, WarningIcon } from "@phosphor-icons/react";

export interface NewTokenSecret {
  id: string;
  label: string | null;
  cf_client_id: string;
  client_secret: string;
  /** ISO-8601 expiry from CF API */
  expires_at?: string;
}

interface CopyTokenCardProps {
  token: NewTokenSecret;
  /** Workspace host for the mcp-remote snippet, e.g. "inbox.actionnow.ai" */
  workspaceHost?: string;
}

const DEFAULT_HOST = "your-workspace.actionnow.ai";

function buildMcpSnippet(clientId: string, host: string): string {
  return [
    `npx -y mcp-remote https://${host}/mcp \\`,
    `  --header "CF-Access-Client-Id: \${CF_ACCESS_CLIENT_ID}" \\`,
    `  --header "CF-Access-Client-Secret: \${CF_ACCESS_CLIENT_SECRET}"`,
  ].join("\n");
}

function buildEnvBlock(clientId: string, clientSecret: string): string {
  return `CF_ACCESS_CLIENT_ID="${clientId}"\nCF_ACCESS_CLIENT_SECRET="${clientSecret}"`;
}

export default function CopyTokenCard({
  token,
  workspaceHost,
}: CopyTokenCardProps) {
  const toastManager = useToastManager();
  const host = workspaceHost ?? DEFAULT_HOST;
  const snippet = buildMcpSnippet(token.cf_client_id, host);
  const envBlock = buildEnvBlock(token.cf_client_id, token.client_secret);

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toastManager.add({ title: `${label} copied` });
    } catch {
      toastManager.add({
        title: "Copy failed — please select and copy manually",
        variant: "error",
      });
    }
  };

  const downloadJson = () => {
    const payload = {
      label: token.label,
      CF_ACCESS_CLIENT_ID: token.cf_client_id,
      CF_ACCESS_CLIENT_SECRET: token.client_secret,
      expires_at: token.expires_at,
      mcp_remote_snippet: snippet,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agent-token-${(token.label ?? token.id).replace(/\s+/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* One-time warning banner */}
      <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2.5">
        <WarningIcon
          size={16}
          className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <p className="text-sm text-amber-800 dark:text-amber-300 font-medium">
          This is the only time you&apos;ll see the secret. Save it now.
        </p>
      </div>

      {/* Credentials */}
      <div className="flex flex-col gap-2">
        <CredentialRow
          label="CF_ACCESS_CLIENT_ID"
          value={token.cf_client_id}
          onCopy={() => copyToClipboard(token.cf_client_id, "Client ID")}
        />
        <CredentialRow
          label="CF_ACCESS_CLIENT_SECRET"
          value={token.client_secret}
          onCopy={() => copyToClipboard(token.client_secret, "Client secret")}
          secret
        />
      </div>

      {/* mcp-remote snippet */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-kumo-subtle uppercase tracking-wide">
            mcp-remote snippet
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copyToClipboard(snippet, "Snippet")}
          >
            <CopyIcon size={12} />
            Copy
          </Button>
        </div>
        <pre className="rounded-lg bg-kumo-subtle/10 border border-kumo-line px-3 py-2.5 text-xs font-mono text-kumo-default overflow-x-auto whitespace-pre-wrap">
          {snippet}
        </pre>
        <p className="text-xs text-kumo-subtle">
          Set <code className="font-mono">CF_ACCESS_CLIENT_ID</code> and{" "}
          <code className="font-mono">CF_ACCESS_CLIENT_SECRET</code> as
          environment variables before running.
        </p>
      </div>

      {/* Download */}
      <Button variant="secondary" size="sm" onClick={downloadJson}>
        <DownloadIcon size={14} />
        Download as JSON
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal sub-component
// ---------------------------------------------------------------------------

interface CredentialRowProps {
  label: string;
  value: string;
  onCopy: () => void;
  secret?: boolean;
}

function CredentialRow({ label, value, onCopy, secret }: CredentialRowProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs font-medium text-kumo-subtle">{label}</p>
      <div className="flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2">
        <code className="flex-1 text-xs font-mono text-kumo-default break-all">
          {secret ? value : value}
        </code>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          onClick={onCopy}
          aria-label={`Copy ${label}`}
        >
          <CopyIcon size={12} />
        </Button>
      </div>
    </div>
  );
}
