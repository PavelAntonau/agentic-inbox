// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button, Input, Tooltip } from "~/ui";
import {
  CaretRightIcon,
  GearSixIcon,
  ListIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useState } from "react";
import {
  Link as RouterLink,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import { useMailbox } from "~/queries/mailboxes";
import Logo from "~/components/Logo";
import Avatar from "~/components/Avatar";
import NotificationBell from "~/components/notifications/NotificationBell";
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

  // Fetch the current user. Drives the Admin link, the avatar identity, and
  // (future) avatar uploads. The server enforces the actual auth — this is
  // only for hide/show in the nav and avatar rendering.
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

  const openSettings = () => {
    if (mailboxId) {
      navigate(
        isSettingsActive
          ? `/mailbox/${mailboxId}/emails/inbox`
          : `/mailbox/${mailboxId}/settings`,
      );
    } else if (isAdmin) {
      navigate("/admin/settings");
    }
    // Non-mailbox + non-admin: no destination yet; avatar/gear are a no-op
    // until the global profile route lands (Phase 3b).
  };

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
            className="md:hidden shrink-0"
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
                >
                  <XIcon size={14} />
                </button>
              )}
            </div>
            <Tooltip content="Search" side="bottom" asChild>
              <Button
                variant="ghost"
                shape="square"
                icon={<MagnifyingGlassIcon size={20} />}
                onClick={performSearch}
                aria-label="Search"
              />
            </Tooltip>
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
              className="md:hidden shrink-0"
            />
          )}

          <div className="flex items-center gap-1 ml-auto shrink-0">
            <Tooltip
              content={
                isAgentPanelOpen ? "Hide agent panel" : "Show agent panel"
              }
              side="bottom"
              asChild
            >
              <Button
                variant={isAgentPanelOpen ? "secondary" : "ghost"}
                shape="square"
                icon={<RobotIcon size={20} />}
                onClick={toggleAgentPanel}
                aria-label="Toggle agent panel"
                className="hidden lg:inline-flex"
              />
            </Tooltip>
            {isAdmin && (
              <RouterLink
                to="/admin/users"
                className="text-sm font-medium text-text-bright hover:text-kumo-brand px-2 py-1 rounded hover:bg-tx-card-hover transition-colors"
              >
                Admin
              </RouterLink>
            )}
            <NotificationBell />
            <ThemeToggle />
            <Tooltip content="Settings" side="bottom" asChild>
              <Button
                variant={isSettingsActive ? "secondary" : "ghost"}
                shape="square"
                icon={<GearSixIcon size={20} />}
                onClick={openSettings}
                aria-label="Settings"
              />
            </Tooltip>
            {me && (
              <Avatar
                userId={me.id}
                displayName={me.display_name}
                email={me.email}
                avatarUrl={me.avatar_url}
                size={32}
                onClick={openSettings}
                className="ml-1"
              />
            )}
          </div>
        </>
      )}

      {/* Non-mailbox routes (e.g. the empty home page when the user has no
          mailboxes yet). The gear is shown only when there is a settings
          target (admin/settings for admins). The avatar always renders so
          the user has a stable identity affordance. */}
      {!mailboxId && (
        <div className="flex items-center gap-1 ml-auto shrink-0">
          {isAdmin && (
            <RouterLink
              to="/admin/users"
              className="text-sm font-medium text-text-bright hover:text-kumo-brand px-2 py-1 rounded hover:bg-tx-card-hover transition-colors"
            >
              Admin
            </RouterLink>
          )}
          <NotificationBell />
          <ThemeToggle />
          {isAdmin && (
            <Tooltip content="Admin settings" side="bottom" asChild>
              <Button
                variant="ghost"
                shape="square"
                icon={<GearSixIcon size={20} />}
                onClick={openSettings}
                aria-label="Admin settings"
              />
            </Tooltip>
          )}
          {me && (
            <Avatar
              userId={me.id}
              displayName={me.display_name}
              email={me.email}
              avatarUrl={me.avatar_url}
              size={32}
              onClick={isAdmin ? openSettings : undefined}
              className="ml-1"
            />
          )}
        </div>
      )}
    </header>
  );
}
