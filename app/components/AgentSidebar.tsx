// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Loader } from "~/ui";
import { PlugsIcon, RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useMailbox } from "~/queries/mailboxes";
import MCPPanel from "./MCPPanel";

function LazyAgentPanel() {
  const [AgentChat, setAgentChat] = useState<React.ComponentType | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    import("~/components/AgentPanel")
      .then((mod) => {
        setAgentChat(() => mod.default);
      })
      .catch((err) => {
        console.error("Failed to load AgentPanel:", err);
        setLoadError("Failed to load agent panel");
      });
  }, []);

  if (loadError) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-xs text-red-500">{loadError}</span>
      </div>
    );
  }
  if (!AgentChat) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <Loader size="base" />
        <span className="text-xs text-text-muted">Loading agent...</span>
      </div>
    );
  }
  return <AgentChat />;
}

export default function AgentSidebar() {
  const [activeTab, setActiveTab] = useState<"agent" | "mcp">("agent");
  const { mailboxId } = useParams<{ mailboxId: string }>();
  const { data: mailbox } = useMailbox(mailboxId);
  const mailboxLabel = mailbox?.name?.trim() || mailbox?.email?.trim() || null;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar — Agent | MCP, plus a trailing inbox-name pill so the
          scoping ("this agent + MCP belong to <mailbox>") is unambiguous
          from any entry point (UAT round-3 second batch directive). */}
      <div className="flex items-center border-b border-border shrink-0 px-1 gap-1">
        <button
          type="button"
          onClick={() => setActiveTab("agent")}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
            activeTab === "agent"
              ? "border-blue text-text-bright"
              : "border-transparent text-text-muted hover:text-text-bright"
          }`}
        >
          <RobotIcon
            size={14}
            weight={activeTab === "agent" ? "fill" : "regular"}
          />
          Agent
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("mcp")}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
            activeTab === "mcp"
              ? "border-blue text-text-bright"
              : "border-transparent text-text-muted hover:text-text-bright"
          }`}
        >
          <PlugsIcon
            size={14}
            weight={activeTab === "mcp" ? "fill" : "regular"}
          />
          MCP
        </button>
        {mailboxLabel && (
          <span
            className="ml-auto mr-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue/10 text-blue text-[11px] font-medium border border-blue/25 max-w-[60%] truncate"
            title={`Scoped to ${mailboxLabel}`}
          >
            <span className="opacity-70 shrink-0">for</span>
            <span className="truncate font-mono">{mailboxLabel}</span>
          </span>
        )}
      </div>

      {/* Tab content — keep agent mounted so chat isn't lost */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className={activeTab === "agent" ? "h-full" : "hidden"}>
          <LazyAgentPanel />
        </div>
        {activeTab === "mcp" && <MCPPanel />}
      </div>
    </div>
  );
}
