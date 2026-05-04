// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// ResizablePanel — width + collapse state for a shell panel paired with
// a ResizableDivider. Persists width and collapsed flag to localStorage
// keyed by `storageKey` so the layout survives reloads.
//
// Renders the panel itself plus its divider; caller decides which side
// the divider sits on. Collapsed state animates width to 0; click on the
// divider's chevron toggles. Drag on the divider resizes within the
// configured min/max.

import { useCallback, useEffect, useRef, useState } from "react";
import ResizableDivider from "./ResizableDivider";

interface ResizablePanelProps {
  /** localStorage key — width + collapsed flag persist here. */
  storageKey: string;
  /** Default width in px (used when nothing is in localStorage). */
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** "left" panel: divider sits on its right edge. "right": vice versa. */
  side: "left" | "right";
  collapsible?: boolean;
  className?: string;
  children: React.ReactNode;
  ariaLabel?: string;
}

interface PersistedState {
  width: number;
  collapsed: boolean;
}

function loadState(
  key: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
): PersistedState {
  if (typeof window === "undefined") {
    return { width: defaultWidth, collapsed: false };
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { width: defaultWidth, collapsed: false };
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const width = clamp(
      Number(parsed.width) || defaultWidth,
      minWidth,
      maxWidth,
    );
    return { width, collapsed: !!parsed.collapsed };
  } catch {
    return { width: defaultWidth, collapsed: false };
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

export default function ResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  side,
  collapsible = true,
  className,
  children,
  ariaLabel,
}: ResizablePanelProps) {
  const initial = useRef<PersistedState | null>(null);
  if (initial.current === null) {
    initial.current = loadState(storageKey, defaultWidth, minWidth, maxWidth);
  }
  const [width, setWidth] = useState(initial.current.width);
  const [collapsed, setCollapsed] = useState(initial.current.collapsed);
  const dragStartWidth = useRef<number>(initial.current.width);

  const persist = useCallback(
    (next: Partial<PersistedState>) => {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({
            width: next.width ?? width,
            collapsed: next.collapsed ?? collapsed,
          }),
        );
      } catch {
        // localStorage unavailable / quota — silent.
      }
    },
    [storageKey, width, collapsed],
  );

  useEffect(() => {
    persist({ width, collapsed });
  }, [width, collapsed, persist]);

  const handleResize = (dx: number) => {
    // Left panel: drag right grows. Right panel: drag right shrinks.
    const signed = side === "left" ? dx : -dx;
    setWidth(clamp(dragStartWidth.current + signed, minWidth, maxWidth));
  };
  const handleResizeEnd = () => {
    dragStartWidth.current = width;
  };
  const handleToggleCollapse = () => {
    setCollapsed((c) => !c);
  };

  const effectiveWidth = collapsed ? 0 : width;

  const panel = (
    <div
      className={className}
      style={{
        width: effectiveWidth,
        transition: collapsed ? "width 180ms ease" : undefined,
        overflow: "hidden",
        flexShrink: 0,
      }}
      data-collapsed={collapsed ? "true" : undefined}
      aria-hidden={collapsed ? "true" : undefined}
    >
      {children}
    </div>
  );

  const divider = (
    <ResizableDivider
      side={side}
      collapsed={collapsed}
      collapsible={collapsible}
      onResize={handleResize}
      onResizeEnd={handleResizeEnd}
      onToggleCollapse={handleToggleCollapse}
      ariaLabel={ariaLabel}
    />
  );

  return side === "left" ? (
    <>
      {panel}
      {divider}
    </>
  ) : (
    <>
      {divider}
      {panel}
    </>
  );
}
