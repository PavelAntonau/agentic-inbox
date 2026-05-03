// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// GlobalSearch — Spotlight-style command palette for the top bar.
//
// Phase 3f MVP: trigger button (centered in the header) + ⌘K / Ctrl+K
// shortcut + modal that fuzzy-matches mailbox names / emails. Click a
// result to navigate. Future iterations will broaden the index to emails,
// contacts, and a semantic-search backend.

import { Dialog } from "~/ui";
import { EnvelopeIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { MailboxNode, MailboxTreePayload } from "~/routes/_app/api.tree";

const SEARCH_QUERY_KEY = ["global-search-tree"] as const;

async function fetchTree(): Promise<MailboxTreePayload> {
  const res = await fetch("/api/mailboxes/tree");
  if (!res.ok) throw new Error(`tree fetch failed: ${res.status}`);
  return res.json() as Promise<MailboxTreePayload>;
}

function flattenMailboxes(tree: MailboxTreePayload | undefined): MailboxNode[] {
  if (!tree) return [];
  const fromGroups = (tree.groups ?? []).flatMap((g) => g.mailboxes ?? []);
  return [...fromGroups, ...(tree.private ?? []), ...(tree.followed ?? [])];
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ??
    navigator.platform ??
    "";
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export default function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(isMacPlatform());
  }, []);

  // Cmd+K / Ctrl+K — open. Esc handled by Dialog itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset + autofocus when the modal opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const id = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [open]);

  const { data: tree } = useQuery({
    queryKey: SEARCH_QUERY_KEY,
    queryFn: fetchTree,
    staleTime: 60_000,
    enabled: open,
  });

  const mailboxes = useMemo(() => flattenMailboxes(tree), [tree]);

  const filtered = useMemo<MailboxNode[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return mailboxes.slice(0, 8);
    return mailboxes
      .filter((m) => {
        const display = (m.display_name ?? "").toLowerCase();
        const address = (m.address ?? "").toLowerCase();
        return display.includes(q) || address.includes(q);
      })
      .slice(0, 8);
  }, [mailboxes, query]);

  const handleSelect = (mb: MailboxNode) => {
    setOpen(false);
    navigate(`/mailbox/${mb.id}/emails/inbox`);
  };

  const shortcutLabel = isMac ? "⌘K" : "Ctrl+K";

  return (
    <>
      {/* Trigger — looks like a search input, behaves like a button. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open global search"
        title={`Search (${shortcutLabel})`}
        className="flex items-center gap-2.5 w-full max-w-md px-3 py-1.5 rounded-lg border border-border bg-card-light hover:bg-tx-card-hover transition-colors text-text-muted shadow-sm cursor-pointer"
      >
        <MagnifyingGlassIcon size={16} className="shrink-0" />
        <span className="text-sm flex-1 text-left truncate">
          Search mailboxes and more...
        </span>
        <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium bg-card border border-border text-text-muted shrink-0">
          {shortcutLabel}
        </kbd>
      </button>

      {/* Modal — Spotlight-style command palette. */}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog size="lg" className="p-0 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
            <MagnifyingGlassIcon
              size={18}
              className="text-text-muted shrink-0"
            />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search mailboxes..."
              className="flex-1 bg-transparent outline-none text-text-bright placeholder:text-text-muted text-sm"
              aria-label="Search query"
            />
            <kbd className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-card-light border border-border text-text-muted shrink-0">
              esc
            </kbd>
          </div>

          <div className="max-h-96 overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <div className="px-3 py-10 text-center text-sm text-text-muted">
                {mailboxes.length === 0
                  ? "No mailboxes yet — create one from the rail."
                  : `No mailbox matches "${query.trim()}"`}
              </div>
            ) : (
              <ul className="space-y-0.5">
                {filtered.map((mb) => (
                  <li key={mb.id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(mb)}
                      className="flex items-center gap-3 w-full px-3 py-2 rounded-md text-left hover:bg-tx-card-hover transition-colors cursor-pointer"
                    >
                      <span className="text-text-muted shrink-0">
                        <EnvelopeIcon size={16} />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-text-bright truncate">
                          {mb.display_name?.trim() || mb.address}
                        </span>
                        {mb.display_name?.trim() &&
                          mb.display_name.trim() !== mb.address && (
                            <span className="block text-xs text-text-muted truncate">
                              {mb.address}
                            </span>
                          )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="px-4 py-2 border-t border-border text-[11px] text-text-muted flex items-center justify-between">
            <span>
              Searching mailboxes — emails, contacts and semantic search coming
              soon.
            </span>
            <span className="hidden sm:inline">
              <kbd className="px-1 py-0.5 rounded bg-card-light border border-border">
                {shortcutLabel}
              </kbd>{" "}
              to reopen
            </span>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}
