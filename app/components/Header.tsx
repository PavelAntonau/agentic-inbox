// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button } from "~/ui";
import { CaretRightIcon, ListIcon, RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import { useMailbox } from "~/queries/mailboxes";
import GlobalSearch from "~/components/GlobalSearch";
import Logo from "~/components/Logo";
import NotificationBell from "~/components/notifications/NotificationBell";
import ProfileMenu from "~/components/ProfileMenu";
import SettingsMenu from "~/components/SettingsMenu";
import ThemeToggle from "~/components/ThemeToggle";

interface MeResponse {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  visibility: "everyone" | "contacts" | "nobody";
  // Future: avatar_url, account_type, company.
  avatar_url?: string | null;
}

// Phase 3d/3e: every ghost icon button in the bar gets a slight shadow +
// the dark-mode-aware bright text colour. We also override `hover:bg-
// kumo-tint` (baked at the light-mode value, near-white in dark mode —
// caused the sun-icon-on-dark "white halo" bug) with `hover:bg-card-light`
// which IS theme-aware. tailwind-merge dedupes the conflicting hover bg.
const HEADER_GHOST_BTN_CLASS = "text-text-bright shadow-sm hover:bg-card-light";

export default function Header() {
  const { mailboxId } = useParams<{ mailboxId: string }>();
  // Breadcrumb: resolve mailbox display name so header shows context
  // even though the rail now owns full mailbox identity on desktop.
  const { data: currentMailbox } = useMailbox(mailboxId);
  const location = useLocation();
  const { toggleSidebar, toggleAgentPanel, isAgentPanelOpen } = useUIStore();

  // Fetch the current user. Drives the SettingsMenu admin grouping, the
  // avatar identity, and (future) avatar uploads. Server enforces the actual
  // auth — this is only for hide/show in the nav and avatar rendering.
  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/me")
      .then((r) => (r.ok ? (r.json() as Promise<MeResponse>) : null))
      .then((data) => {
        if (!cancelled && data) setMe(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const adminRole = me?.role ?? null;
  const isAdmin = adminRole === "global_owner" || adminRole === "global_admin";

  const isSettingsActive = location.pathname.includes("/settings");

  // Phase 3d/3e/3f: shared right-cluster order is
  //   Avatar  →  Robot panel  →  Bell  →  Theme  →  Settings
  const rightCluster = (
    <div className="flex items-center gap-1.5 ml-auto shrink-0">
      {me && (
        <ProfileMenu
          userId={me.id}
          displayName={me.display_name}
          email={me.email}
          avatarUrl={me.avatar_url}
        />
      )}
      {mailboxId && (
        <Button
          variant={isAgentPanelOpen ? "secondary" : "ghost"}
          shape="square"
          icon={<RobotIcon size={20} />}
          onClick={toggleAgentPanel}
          aria-label={
            isAgentPanelOpen ? "Hide agent panel" : "Show agent panel"
          }
          title={isAgentPanelOpen ? "Hide agent panel" : "Show agent panel"}
          className={`hidden lg:inline-flex ${HEADER_GHOST_BTN_CLASS}`}
        />
      )}
      <NotificationBell />
      <ThemeToggle />
      <SettingsMenu
        mailboxId={mailboxId}
        isAdmin={isAdmin}
        isSettingsActive={isSettingsActive}
      />
    </div>
  );

  return (
    <header className="flex items-center gap-3 px-3 py-2.5 bg-card border-b border-border sticky top-0 z-10 md:px-5 md:gap-4">
      {/* Logo — always visible. Height 77 (~20 % smaller than the 96 px
          Phase 1 size — top bar was looking too tall). */}
      <Logo height={77} className="shrink-0 mr-2" />

      {/* Breadcrumb — shows current mailbox context on desktop. */}
      {mailboxId && currentMailbox && (
        <div className="hidden md:flex items-center gap-1 text-sm text-text-muted shrink-0">
          <CaretRightIcon size={12} aria-hidden />
          <span className="font-medium text-text-bright max-w-[180px] truncate">
            {currentMailbox.settings?.fromName ||
              (currentMailbox.name !== currentMailbox.email
                ? currentMailbox.name
                : currentMailbox.email.split("@")[0])}
          </span>
        </div>
      )}

      {/* Mobile sidebar toggle — only when in a mailbox. */}
      {mailboxId && (
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          icon={<ListIcon size={20} />}
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
          className={`md:hidden shrink-0 ${HEADER_GHOST_BTN_CLASS}`}
        />
      )}

      {/* Phase 3f: global search bar — Spotlight-style, centered in the
          panel. Replaces the per-mailbox search input that used to live
          here. ⌘K / Ctrl+K opens the modal. */}
      <div className="flex flex-1 justify-center min-w-0">
        <GlobalSearch />
      </div>

      {rightCluster}
    </header>
  );
}
