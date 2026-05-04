// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "~/ui";
import {
  CheckIcon,
  CopyIcon,
  KeyIcon,
  PlugsIcon,
  RobotIcon,
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
  const tokenIssueCmd = mailboxId
    ? `curl -X POST ${baseUrl}/api/tokens/mailboxes/${mailboxId}/tokens \\
  -H "Content-Type: application/json" \\
  -H "Cookie: <your CF Access cookie>" \\
  -d '{"label":"my-claude-code","max_instances":1}'`
    : `curl -X POST ${baseUrl}/api/tokens/mailboxes/<MAILBOX_ID>/tokens \\
  -H "Content-Type: application/json" \\
  -H "Cookie: <your CF Access cookie>" \\
  -d '{"label":"my-claude-code","max_instances":1}'`;
  const claudeAddCmd = `claude mcp add inbox ${mcpUrl} \\
  --transport http \\
  --header "Authorization: Bearer <CLIENT_ID>:<CLIENT_SECRET>"`;

  return (
    <div className="flex flex-col h-full">
      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Intro — explicitly scoped to THIS inbox so users understand
            the MCP/agent are inbox-specific, not generic workspace tools. */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue/10">
              <RobotIcon size={20} weight="duotone" className="text-blue" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-bright">
                Inbox Agent &amp; MCP
              </h3>
              <p className="text-xs text-text-muted">
                Scoped to{" "}
                <span className="font-mono text-text-bright">
                  {mailboxLabel}
                </span>
              </p>
            </div>
          </div>
          <p className="text-xs text-text-muted leading-relaxed">
            This MCP server and its tools operate{" "}
            <span className="font-medium text-text-bright">
              only on this inbox
            </span>{" "}
            — not the whole workspace. Connect any MCP-aware AI client (Claude
            Code, Cursor, etc.) and it can read, search, draft, and send mail
            for this mailbox using natural language.
          </p>
        </div>

        {/* Step 1 — Server URL */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-text-bright block">
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue/15 text-blue text-[10px] font-bold mr-1.5">
              1
            </span>
            Copy the server URL
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

        {/* Step 2 — Generate a token */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-text-bright block">
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue/15 text-blue text-[10px] font-bold mr-1.5">
              2
            </span>
            Generate a connection token
          </label>
          <p className="text-xs text-text-muted leading-relaxed">
            Authentication is bearer-token: the AI client sends{" "}
            <span className="font-mono text-text-bright">
              Authorization: Bearer &lt;client_id&gt;:&lt;client_secret&gt;
            </span>
            . Issue one for this inbox by calling the token API while signed in
            (the in-app token UI is being rebuilt — for now use the curl below).
            The response includes the secret{" "}
            <span className="font-medium text-text-bright">once</span> — copy it
            immediately.
          </p>
          <div className="relative group">
            <div className="absolute right-1.5 top-1.5">
              <CopyButton text={tokenIssueCmd} />
            </div>
            <pre className="bg-bg text-text-bright font-mono text-[11px] px-3 py-2.5 pr-10 rounded-lg border border-border whitespace-pre-wrap leading-relaxed">
              {tokenIssueCmd}
            </pre>
          </div>
          <p className="text-[11px] text-text-muted leading-relaxed">
            <KeyIcon
              size={11}
              weight="bold"
              className="inline-block align-[-1px] mr-1 text-text-muted"
            />
            Token is scoped to this mailbox. Keep it secret; revoke it via{" "}
            <span className="font-mono">
              POST /api/tokens/&lt;tokenId&gt;/revoke
            </span>{" "}
            if it leaks.
          </p>
        </div>

        {/* Step 3 — Wire it into the client */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-text-bright block">
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue/15 text-blue text-[10px] font-bold mr-1.5">
              3
            </span>
            Add it to your AI client
          </label>
          <p className="text-xs text-text-muted leading-relaxed">
            Paste the token into the client's MCP config under an
            <span className="font-mono text-text-bright">
              {" "}
              Authorization
            </span>{" "}
            header. Example for Claude Code:
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
