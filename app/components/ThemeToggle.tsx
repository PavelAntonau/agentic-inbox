// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button } from "~/ui";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useTheme } from "~/hooks/useTheme";

type ThemeToggleProps = {
  className?: string;
};

/**
 * Sun/moon button that toggles between light and dark mode. Reads + writes
 * `<html>` class via {@link useTheme} so all `theme-dark:` Tailwind utilities
 * + the SW palette CSS-variable overrides update at once. Choice persists
 * across sessions in `localStorage["anai-theme"]`.
 *
 * The base ghost-button colour token (`text-kumo-default`) is baked to the
 * light-mode value (see app/index.css — `@theme inline` defines kumo
 * tokens at compile time, so they don't follow `.theme-dark`). We force
 * `text-text-bright` (which IS dark-mode-aware via `:root.theme-dark`) so
 * the icon stays legible on both backgrounds.
 *
 * No custom Tooltip wrapper — Phase 3d removed every header tooltip per
 * user directive ("just stick to the browser's default and remove the
 * rest"). The native browser tooltip fires from the `title` attribute.
 */
export default function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <Button
      variant="ghost"
      shape="square"
      icon={isDark ? <SunIcon size={20} /> : <MoonIcon size={20} />}
      onClick={toggle}
      aria-label={label}
      title={label}
      className={`text-text-bright shadow-sm hover:bg-card-light ${className ?? ""}`.trim()}
    />
  );
}
