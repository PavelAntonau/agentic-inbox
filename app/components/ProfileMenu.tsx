// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// ProfileMenu — avatar-trigger dropdown.
//
// Trigger is the round Avatar (initials or uploaded picture). Popup lists:
//   - Identity header: display name + email (non-interactive)
//   - Profile          → /profile          (public-ish identity — Phase 4)
//   - Account settings → /account          (private settings — Phase 4)
//   - Sign out         → authClient.signOut() (better-auth POST /api/auth/sign-out)
//
// T3.8 (Phase 3 mcp-oauth): sign-out POSTs /api/auth/sign-out via better-auth
// instead of GET /cdn-cgi/access/logout. Clears the __Host-anai.session_token
// cookie at the better-auth layer. Do NOT regress to a CF Access href — the
// /account sign-out button already uses this pattern (account.tsx L96-104).

import { Menu } from "@base-ui/react/menu";
import {
  IdentificationCardIcon,
  SignOutIcon,
  UserCircleIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import Avatar from "~/components/Avatar";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/ui/lib/cn";

// Phase 3f: bg-card is solid globally now (see app/index.css). No inline
// surface override needed.

// Avatar styling — Phase 3e: ~30 % bigger plus a clearly visible cyan
// border and a deeper shadow (user wanted the avatar to "stand out", with
// the border in turquoise / light blue).
const AVATAR_SIZE_PX = 42;
const AVATAR_DECORATIONS = "border-2 border-cyan-400 shadow-lg";

interface ProfileMenuProps {
  userId: string;
  displayName: string | null;
  email: string;
  avatarUrl: string | null | undefined;
}

export default function ProfileMenu({
  userId,
  displayName,
  email,
  avatarUrl,
}: ProfileMenuProps) {
  const friendlyName = (displayName && displayName.trim()) || email;
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await authClient.signOut();
    } catch {
      // best-effort — redirect regardless. mirrors account.tsx handleSignOut.
    }
    window.location.href = "/login";
  };

  const itemClassName = cn(
    "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm",
    "text-text-bright outline-none",
    "data-[highlighted]:bg-tx-card-hover",
  );

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full",
          "outline-none cursor-pointer transition-transform hover:scale-105",
          "focus-visible:ring-2 focus-visible:ring-kumo-brand",
        )}
        aria-label={`Account: ${friendlyName}`}
        title={friendlyName}
      >
        <Avatar
          userId={userId}
          displayName={displayName}
          email={email}
          avatarUrl={avatarUrl}
          size={AVATAR_SIZE_PX}
          className={AVATAR_DECORATIONS}
        />
      </Menu.Trigger>
      <Menu.Portal>
        {/* z-50 wins against the sticky header's z-10 (NotificationBell uses
         * z-40 for the same reason). Without this the popup renders behind
         * the header bar. */}
        <Menu.Positioner sideOffset={8} align="end" className="z-[150]">
          <Menu.Popup
            className={cn(
              "min-w-64 origin-top-right rounded-xl border-2 border-border bg-card p-1.5",
              "shadow-2xl outline-none",
            )}
          >
            {/* Identity header — not focusable, not a Menu.Item so keyboard
                navigation skips it. */}
            <div className="flex items-center gap-2.5 px-2.5 py-2.5">
              <Avatar
                userId={userId}
                displayName={displayName}
                email={email}
                avatarUrl={avatarUrl}
                size={36}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-text-bright">
                  {friendlyName}
                </div>
                {displayName && displayName.trim() && (
                  <div className="truncate text-xs text-text-muted">
                    {email}
                  </div>
                )}
              </div>
            </div>
            <div className="my-1 border-t border-border" />

            <Menu.Item
              className={itemClassName}
              render={<RouterLink to="/profile" className="no-underline" />}
            >
              <span className="text-text-muted">
                <UserCircleIcon size={16} />
              </span>
              <span>Profile</span>
            </Menu.Item>
            <Menu.Item
              className={itemClassName}
              render={<RouterLink to="/account" className="no-underline" />}
            >
              <span className="text-text-muted">
                <IdentificationCardIcon size={16} />
              </span>
              <span>Account settings</span>
            </Menu.Item>

            <div className="my-1 border-t border-border" />

            <Menu.Item
              className={cn(itemClassName, "w-full text-left")}
              disabled={signingOut}
              onClick={() => void handleSignOut()}
            >
              <span className="text-text-muted">
                <SignOutIcon size={16} />
              </span>
              <span>{signingOut ? "Signing out…" : "Sign out"}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
