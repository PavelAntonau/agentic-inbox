// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "anai-theme";
const DARK_CLASS = "theme-dark";
const LIGHT_CLASS = "theme-light";

function readCurrent(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains(DARK_CLASS)
    ? "dark"
    : "light";
}

/**
 * Subscribe to the theme class on `<html>` and expose a setter that
 * persists the choice. The boot script in `root.tsx` is responsible for
 * applying the class BEFORE first paint so there's no flash of the
 * wrong theme. This hook just keeps React state in sync and writes back
 * when the user toggles.
 */
export function useTheme(): {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggle: () => void;
} {
  // Always start as "light" on the server so SSR markup matches the
  // initial client render. The mount effect immediately re-reads the
  // class set by the inline boot script and corrects state.
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    if (typeof document === "undefined") return;
    setThemeState(readCurrent());
    const obs = new MutationObserver(() => setThemeState(readCurrent()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

  const setTheme = (next: Theme) => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.classList.remove(DARK_CLASS, LIGHT_CLASS);
    root.classList.add(next === "dark" ? DARK_CLASS : LIGHT_CLASS);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage unavailable (private mode, quota) — class still
      // applies for the current session.
    }
  };

  const toggle = () => setTheme(theme === "dark" ? "light" : "dark");

  return { theme, setTheme, toggle };
}
