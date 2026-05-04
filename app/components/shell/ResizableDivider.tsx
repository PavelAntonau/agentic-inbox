// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// ResizableDivider — unified vertical divider used between every shell
// panel (UAT round 1, item 2).
//
// Visual:
//   - 1 px hairline at rest in the standard border colour. A pseudo-element
//     overlay carries the "gently curved sheet" shadow — vertical linear-
//     gradient that's darker in the middle and fades out at the top and
//     bottom edges, so the divider reads as if a softly curved sheet is
//     casting a shadow.
//   - Hover: 8 px wide hit-zone lights up with a cyan neon glow; cursor
//     becomes ew-resize and a small grab handle appears at vertical
//     centre. Dropping back to 1 px restores the rest state.
//   - Optional collapse chevron sits in the centre of the hit-zone when
//     `collapsible` is on; clicking it (without dragging) toggles the
//     adjacent panel.
//
// Behaviour:
//   - Pointer-down + drag fires onResize(dx) where dx is signed delta in
//     pixels from drag start. Caller maps dx to panel width depending on
//     which side of the panel the divider sits.
//   - A click that doesn't move (drag distance < 4 px) and lands on the
//     chevron fires onToggleCollapse instead — the same divider thus
//     handles both gestures unambiguously.

import { useEffect, useRef, useState } from "react";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";

export interface ResizableDividerProps {
  /** Which side of the divider the resizable panel sits on. */
  side: "left" | "right";
  collapsed?: boolean;
  collapsible?: boolean;
  onResize?: (dx: number) => void;
  onResizeEnd?: () => void;
  onToggleCollapse?: () => void;
  ariaLabel?: string;
}

const DRAG_THRESHOLD_PX = 4;

export default function ResizableDivider({
  side,
  collapsed,
  collapsible,
  onResize,
  onResizeEnd,
  onToggleCollapse,
  ariaLabel,
}: ResizableDividerProps) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    moved: boolean;
    active: boolean;
  }>({ startX: 0, moved: false, active: false });

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, moved: false, active: true };
    setDragging(true);
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d.active) return;
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) >= DRAG_THRESHOLD_PX) d.moved = true;
    if (collapsed) return; // can't resize a collapsed panel
    onResize?.(dx);
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (d.active && !d.moved && collapsible && onToggleCollapse) {
      // Click without drag = toggle collapse.
      onToggleCollapse();
    } else if (d.moved) {
      onResizeEnd?.();
    }
    d.active = false;
    setDragging(false);
  };

  // Safety net: if the divider's pointerup never fires (browser swallowed
  // the event because the user dragged outside the viewport, switched tabs
  // mid-drag, etc.) the previous implementation would freeze with active=true
  // and the next pointermove on the divider would resume drag from the wrong
  // anchor. Listen on the window while dragging and force a clean exit.
  useEffect(() => {
    if (!dragging) return;
    const release = () => {
      const d = dragRef.current;
      if (!d.active) return;
      if (d.moved) onResizeEnd?.();
      d.active = false;
      setDragging(false);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, [dragging, onResizeEnd]);

  // Caret faces the direction the panel will collapse OUT of (so clicking
  // it visually "pushes" the panel away).
  const Caret = (collapsed ? side === "left" : side === "right")
    ? CaretRightIcon
    : CaretLeftIcon;

  // UAT round-3 (second batch): the chevron handle stays visible at all
  // times when collapsible — at rest it's dim and small, on hover/drag it
  // brightens AND scales up to telegraph the click affordance.
  const showHandle = collapsible;
  const handleActive = hovered || dragging;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel ?? "Resize panel"}
      tabIndex={collapsible ? 0 : -1}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(e) => {
        if (!collapsible) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleCollapse?.();
        }
      }}
      className="resizable-divider relative shrink-0 select-none"
      data-hovered={showHandle ? "true" : undefined}
      data-collapsed={collapsed ? "true" : undefined}
      style={{
        width: 8,
        cursor: collapsed ? "pointer" : "ew-resize",
        // touchAction: 'none' prevents the browser from interpreting drag
        // gestures as scroll/zoom (which silently steals the pointer from
        // setPointerCapture and was the source of the "drag freezes
        // mid-resize" symptom).
        touchAction: "none",
      }}
    >
      {/* Single turquoise hairline — the curved-paper shadow lives on the
          sidebar (data-shell-sidebar) now, not on the divider, per UAT
          round-3 second batch. */}
      <span aria-hidden className="resizable-divider__line" />
      {showHandle && (
        <span
          aria-hidden
          className="resizable-divider__handle"
          data-active={handleActive ? "true" : undefined}
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
          }}
        >
          <Caret size={12} weight="bold" />
        </span>
      )}
    </div>
  );
}
