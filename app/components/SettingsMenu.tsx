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
  KeyIcon,
  SlidersIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import { cn } from "~/ui/lib/cn";

// Near-solid glass surface for popovers. The user explicitly asked for
// "barely noticeable" translucency — Phase 3d's 92 % was still too see-
// through, so 97 % gives a hint of frost without ghosting. Lighter blur
// since aggressive blur is wasted on a mostly-opaque element.
const FROSTED_SURFACE_STYLE: React.CSSProperties = {
  backgroundColor: "color-mix(in oklab, var(--color-card) 97%, transparent)",
  backdropFilter: "blur(14px) saturate(160%)",
  WebkitBackdropFilter: "blur(14px) saturate(160%)",
};

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
          key: "admin-tokens",
          label: "Tokens",
          to: "/admin/tokens",
          icon: <KeyIcon size={16} />,
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

  const triggerClassName = cn(
    "inline-flex h-9 w-9 items-center justify-center rounded-lg",
    "text-text-bright hover:bg-kumo-tint shadow-sm",
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
        <Menu.Positioner sideOffset={8} align="end">
          <Menu.Popup
            className={cn(
              "min-w-56 origin-top-right rounded-xl border-2 border-border p-1.5",
              "shadow-2xl outline-none",
            )}
            style={FROSTED_SURFACE_STYLE}
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
