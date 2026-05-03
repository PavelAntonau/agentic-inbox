// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button, Input } from "~/ui";
import {
  CaretRightIcon,
  ListIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useState } from "react";
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import { useMailbox } from "~/queries/mailboxes";
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
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const { mailboxId } = useParams<{ mailboxId: string }>();
  const navigate = useNavigate();
  // Breadcrumb: resolve mailbox display name so header shows context
  // even though the rail now owns full mailbox identity on desktop.
  const { data: currentMailbox } = useMailbox(mailboxId);
  const location = useLocation();
  const [searchParams] = useSearchParams();
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

  // Sync search input with URL query param so it stays populated
  const urlQuery = searchParams.get("q") || "";
  useEffect(() => {
    if (location.pathname.includes("/search") && urlQuery) {
      setSearchQuery(urlQuery);
    }
  }, [urlQuery, location.pathname]);

  const performSearch = () => {
    if (mailboxId && searchQuery.trim()) {
      const q = searchQuery.trim();
      navigate(`/mailbox/${mailboxId}/search?q=${encodeURIComponent(q)}`);
      setIsSearchExpanded(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    if (location.pathname.includes("/search") && mailboxId) {
      navigate(`/mailbox/${mailboxId}/emails/inbox`);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      performSearch();
    }
    if (e.key === "Escape") {
      if (searchQuery) {
        clearSearch();
      } else {
        setIsSearchExpanded(false);
      }
    }
  };

  const isSettingsActive = location.pathname.includes("/settings");

  // Phase 3d: shared right-cluster order is
  //   Avatar  →  Robot panel  →  Bell  →  Theme  →  Settings
  // The user asked for "user first, then notifications, then the theme
  // switcher" — avatar moves all the way left in the cluster, robot stays
  // adjacent (lg-only), and the gear stays at the right edge.
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
    <header className="flex items-center gap-2 px-3 py-2.5 bg-card border-b border-border sticky top-0 z-10 md:px-5 md:gap-4">
      {/* Logo — always visible. Height 77 (~20 % smaller than the 96 px
          Phase 1 size — top bar was looking too tall). */}
      <Logo height={77} className="shrink-0 mr-2" />

      {/* Breadcrumb — shows current mailbox context on desktop.
          The left rail owns full mailbox-tree navigation; the breadcrumb
          here gives a compact identity reminder in the header bar. */}
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

      {mailboxId && (
        <>
          {/* Hamburger menu - mobile only */}
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

          {/* Search - full on desktop, collapsible on mobile */}
          <div
            className={`flex-1 max-w-lg transition-all flex items-center gap-1 ${
              isSearchExpanded ? "flex" : "hidden md:flex"
            }`}
          >
            <div className="flex-1 relative flex items-center">
              <Input
                className="w-full"
                aria-label="Search emails"
                placeholder="Search emails... (try from:name, is:unread, has:attachment)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-muted hover:text-text-bright hover:bg-tx-card-hover transition-colors"
                  aria-label="Clear search"
                  title="Clear search"
                >
                  <XIcon size={14} />
                </button>
              )}
            </div>
            <Button
              variant="ghost"
              shape="square"
              icon={<MagnifyingGlassIcon size={20} />}
              onClick={performSearch}
              aria-label="Search"
              title="Search"
              className={HEADER_GHOST_BTN_CLASS}
            />
          </div>

          {/* Search toggle button - mobile only, hidden when search is expanded */}
          {!isSearchExpanded && (
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={<MagnifyingGlassIcon size={20} />}
              onClick={() => setIsSearchExpanded(true)}
              aria-label="Search"
              title="Search"
              className={`md:hidden shrink-0 ${HEADER_GHOST_BTN_CLASS}`}
            />
          )}

          {rightCluster}
        </>
      )}

      {!mailboxId && rightCluster}
    </header>
  );
}
