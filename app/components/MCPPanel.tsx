// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "~/ui";
import {
  CheckIcon,
  CopyIcon,
  PlugsIcon,
  WarningIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";
import { useMailbox } from "~/queries/mailboxes";

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

export default function MCPPanel() {
  const { mailboxId } = useParams<{ mailboxId: string }>();
  const { data: mailbox } = useMailbox(mailboxId);
  const baseUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://your-app.workers.dev";
  const mcpUrl = `${baseUrl}/mcp`;
  const mailboxLabel =
    mailbox?.name?.trim() || mailbox?.email?.trim() || "this inbox";

  // Single copy-paste-and-hand-to-the-agent command. We deliberately leave
  // OFF the Authorization header until the in-browser token flow is live —
  // a half-baked curl placeholder ("paste your CF Access cookie here")
  // was the round-3 anti-pattern. Once the token surface ships, this
  // command grows a `--header "Authorization: Bearer …"` line.
  const claudeAddCmd = `claude mcp add inbox ${mcpUrl} --transport http`;

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
            — not the whole workspace. Wire any MCP-aware AI client (Claude
            Code, Cursor, etc.) to the URL below and it can read, search, draft,
            and send mail for this mailbox using natural language.
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

        {/* Step 2 — Add it to your client (full copy-paste command) */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-text-bright block">
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue/15 text-blue text-[10px] font-bold mr-1.5">
              2
            </span>
            Add it to your AI client
          </label>
          <p className="text-xs text-text-muted leading-relaxed">
            Copy this and hand it directly to your agent — it's the full
            registration command for Claude Code:
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

        {/* Honest auth-gap notice. The user explicitly asked us to say so
            instead of papering over it with curl-and-cookie placeholders. */}
        <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-3">
          <div className="flex items-center gap-2">
            <WarningIcon
              size={16}
              weight="duotone"
              className="text-amber-500 shrink-0"
            />
            <h4 className="text-xs font-semibold text-text-bright">
              Authentication — known gap
            </h4>
          </div>
          <p className="text-[11px] text-text-muted leading-relaxed">
            The in-browser token flow isn't wired yet. Production access to this
            MCP currently rides on your Cloudflare Access browser session, which
            a headless agent won't have. Generating inbox-scoped bearer tokens
            directly from this panel is the next item on the roadmap — until it
            lands, hosted MCP clients without a CF Access session will be
            rejected at the edge.
          </p>
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
