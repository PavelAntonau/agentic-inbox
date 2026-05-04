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

import { useRef, useState } from "react";
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

  // Caret faces the direction the panel will collapse OUT of (so clicking
  // it visually "pushes" the panel away).
  const Caret = (collapsed ? side === "left" : side === "right")
    ? CaretRightIcon
    : CaretLeftIcon;

  const showHandle = hovered || dragging;

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
      }}
    >
      {/* Hairline + curved-sheet shadow — pure CSS, see app/index.css. */}
      <span aria-hidden className="resizable-divider__line" />
      <span aria-hidden className="resizable-divider__glow" />
      {collapsible && showHandle && (
        <span
          aria-hidden
          className="resizable-divider__handle"
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
