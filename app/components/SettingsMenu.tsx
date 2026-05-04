// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// SettingsMenu — gear-icon dropdown with permission-filtered items.
//
// Replaces the Phase 3a "gear button navigates straight to mailbox/.../settings"
// behaviour. Items are filtered by:
//   - Whether we are inside a mailbox (mailboxId !== null)
//   - Whether the actor is admin (global_owner / global_admin)
// The trigger is hidden when no items would be shown so we never render an
// empty popover.

import { Menu } from "@base-ui/react/menu";
import {
  ChartLineIcon,
  EnvelopeIcon,
  GearSixIcon,
  SlidersIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import { cn } from "~/ui/lib/cn";

// Phase 3f: popups are fully opaque now. The previous 92 %/97 % alpha-
// mixed surface was rejected by the user as "ghost-like" — bg-card was
// switched to solid in app/index.css globally. No inline override needed.

interface SettingsMenuProps {
  mailboxId: string | undefined;
  isAdmin: boolean;
  isSettingsActive: boolean;
}

interface MenuItemSpec {
  key: string;
  label: string;
  to: string;
  icon: ReactNode;
}

interface MenuGroupSpec {
  label?: string;
  items: MenuItemSpec[];
}

export default function SettingsMenu({
  mailboxId,
  isAdmin,
  isSettingsActive,
}: SettingsMenuProps) {
  const groups: MenuGroupSpec[] = [];

  if (mailboxId) {
    groups.push({
      label: "Mailbox",
      items: [
        {
          key: "mailbox-settings",
          label: "Mailbox settings",
          to: `/mailbox/${mailboxId}/settings`,
          icon: <EnvelopeIcon size={16} />,
        },
      ],
    });
  }

  if (isAdmin) {
    // Tokens link removed — entire agent-token surface is being phased out
    // (user directive 2026-05-03). The /admin/tokens + /mailbox/:id/tokens
    // routes + the API mount are unwired; a connection-status indicator will
    // replace it in a follow-up.
    groups.push({
      label: "Workspace",
      items: [
        {
          key: "admin-users",
          label: "User management",
          to: "/admin/users",
          icon: <UsersIcon size={16} />,
        },
        {
          key: "admin-settings",
          label: "Workspace settings",
          to: "/admin/settings",
          icon: <SlidersIcon size={16} />,
        },
        {
          key: "admin-observability",
          label: "Observability",
          to: "/admin/observability",
          icon: <ChartLineIcon size={16} />,
        },
      ],
    });
  }

  // No items at all — render nothing rather than an empty popover.
  if (groups.length === 0) return null;

  // hover:bg-card-light (NOT bg-kumo-tint) — kumo-tint is `@theme inline` baked
  // at the light-mode value and produces a white halo in dark mode (same root
  // cause as the Phase 3e sun-hover bug). bg-card-light follows the active theme.
  const triggerClassName = cn(
    "inline-flex h-9 w-9 items-center justify-center rounded-lg",
    "text-text-bright hover:bg-card-light shadow-sm",
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-kumo-ring",
    "cursor-pointer transition-colors",
    isSettingsActive && "bg-kumo-base",
  );

  return (
    <Menu.Root>
      <Menu.Trigger
        className={triggerClassName}
        aria-label="Settings"
        title="Settings"
      >
        <GearSixIcon size={20} />
      </Menu.Trigger>
      <Menu.Portal>
        {/* z-50 wins against the sticky header's z-10 (NotificationBell uses
         * z-40 for the same reason). Without this the popup renders behind
         * the header bar. */}
        <Menu.Positioner sideOffset={8} align="end" className="z-50">
          <Menu.Popup
            className={cn(
              "min-w-56 origin-top-right rounded-xl border-2 border-border bg-card p-1.5",
              "shadow-2xl outline-none",
            )}
          >
            {groups.map((group, gi) => (
              <div key={group.label ?? gi}>
                {gi > 0 && <div className="my-1.5 border-t border-border" />}
                {group.label && (
                  <div className="px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-text-muted">
                    {group.label}
                  </div>
                )}
                {group.items.map((item) => (
                  <Menu.Item
                    key={item.key}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm",
                      "text-text-bright outline-none",
                      "data-[highlighted]:bg-tx-card-hover",
                    )}
                    render={
                      <RouterLink to={item.to} className="no-underline" />
                    }
                  >
                    <span className="text-text-muted">{item.icon}</span>
                    <span>{item.label}</span>
                  </Menu.Item>
                ))}
              </div>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
