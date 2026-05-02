// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button, Tooltip } from "@cloudflare/kumo";
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
 */
export default function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <Tooltip content={label} side="bottom" asChild>
      <Button
        variant="ghost"
        shape="square"
        icon={isDark ? <SunIcon size={20} /> : <MoonIcon size={20} />}
        onClick={toggle}
        aria-label={label}
        className={className}
      />
    </Tooltip>
  );
}
