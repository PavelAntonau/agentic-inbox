// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button } from "~/ui";
import { ListIcon, SignOutIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import { authClient } from "~/lib/auth-client";
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
  const location = useLocation();
  const { toggleSidebar } = useUIStore();

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

  // UAT round-3 batch-4: this header is workspace-scoped now. The agent
  // toggle and the mailbox-settings link both moved into the inbox folder
  // header (email-list.tsx) — everything specific to one mailbox lives
  // alongside the inbox itself, not in the global chrome.
  //   Avatar  →  Bell  →  Theme  →  Settings (workspace-only)
  // Defensive sign-out (post-CF-Access cutover, 2026-05-07): when `me`
  // is null because /api/users/me 401'd (orphaned/expired session), the
  // ProfileMenu's sign-out is invisible exactly when needed most. Show a
  // small icon-only sign-out instead so the user can always recover. The
  // useAuthGuard hook in _app/admin layouts will hard-redirect to /login
  // for new visits — this handles the brief window where the user is
  // already inside the shell when their session goes invalid, and any
  // unguarded route surface (e.g. /login itself, where Header still
  // renders but we suppress the fallback to avoid a double sign-out).
  const onLoginPage = location.pathname.startsWith("/login");
  const handleFallbackSignOut = async () => {
    try {
      await authClient.signOut();
    } catch {
      // best-effort — redirect regardless
    }
    window.location.href = "/login";
  };

  const rightCluster = (
    <div className="flex items-center gap-1.5 ml-auto shrink-0">
      {me ? (
        <ProfileMenu
          userId={me.id}
          displayName={me.display_name}
          email={me.email}
          avatarUrl={me.avatar_url}
        />
      ) : (
        !onLoginPage && (
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            icon={<SignOutIcon size={20} />}
            onClick={handleFallbackSignOut}
            aria-label="Sign out"
            title="Sign out"
            className={HEADER_GHOST_BTN_CLASS}
          />
        )
      )}
      <NotificationBell />
      <ThemeToggle />
      <SettingsMenu isAdmin={isAdmin} isSettingsActive={isSettingsActive} />
    </div>
  );

  return (
    <header className="flex items-center gap-3 px-3 py-1.5 bg-card border-b border-border sticky top-0 z-10 md:px-5 md:gap-4">
      {/* Logo — always visible. Height 58 (25% shorter — Phase 4 UAT round
          1 item 3 trim; the breadcrumb that previously sat to the right of
          the logo and the open-inbox indicator have both been removed). */}
      <Logo height={58} className="shrink-0 mr-2" />

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
