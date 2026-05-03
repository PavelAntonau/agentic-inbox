// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// ProfileMenu — avatar-trigger dropdown.
//
// Trigger is the round Avatar (initials or uploaded picture). Popup lists:
//   - Identity header: display name + email (non-interactive)
//   - Profile          → /profile
//   - Account settings → /profile (Phase 3b will split into a separate
//                                  /account route once auth/security
//                                  controls land)
//   - Sign out         → /cdn-cgi/access/logout (Cloudflare Access logout)

import { Menu } from "@base-ui/react/menu";
import {
  IdentificationCardIcon,
  SignOutIcon,
  UserCircleIcon,
} from "@phosphor-icons/react";
import { Link as RouterLink } from "react-router";
import Avatar from "~/components/Avatar";
import { cn } from "~/ui/lib/cn";

const FROSTED_SURFACE_STYLE: React.CSSProperties = {
  backgroundColor: "color-mix(in oklab, var(--color-card) 92%, transparent)",
  backdropFilter: "blur(24px) saturate(180%)",
  WebkitBackdropFilter: "blur(24px) saturate(180%)",
};

// Avatar styling — Phase 3d: ~30 % bigger, subtle border, slight shadow
// (the user explicitly called out the avatar as wanting a more pronounced
// shadow than the surrounding ghost icons).
const AVATAR_SIZE_PX = 42;
const AVATAR_DECORATIONS = "border-2 border-text-muted/30 shadow-md";

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
        <Menu.Positioner sideOffset={8} align="end">
          <Menu.Popup
            className={cn(
              "min-w-64 origin-top-right rounded-xl border-2 border-border p-1.5",
              "shadow-2xl outline-none",
            )}
            style={FROSTED_SURFACE_STYLE}
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
              render={
                <RouterLink to="/profile#account" className="no-underline" />
              }
            >
              <span className="text-text-muted">
                <IdentificationCardIcon size={16} />
              </span>
              <span>Account settings</span>
            </Menu.Item>

            <div className="my-1 border-t border-border" />

            <Menu.Item
              className={itemClassName}
              render={
                <a href="/cdn-cgi/access/logout" className="no-underline" />
              }
            >
              <span className="text-text-muted">
                <SignOutIcon size={16} />
              </span>
              <span>Sign out</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
