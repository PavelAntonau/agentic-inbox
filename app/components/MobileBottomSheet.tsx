// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// MobileBottomSheet — mobile-native bottom-sheet for auth flows.
//
// Behaviour:
//   <md  (viewport-width < 768px): renders as a bottom-sheet snapping to the
//        lower 75% of the viewport, with a drag handle, focus-trap, esc-to-
//        close, and prefers-reduced-motion support.
//   ≥md  (viewport-width ≥ 768px): renders as a regular centered card/dialog
//        so callers can keep one component across breakpoints.
//
// API:
//   <MobileBottomSheet open onOpenChange>
//     <MobileBottomSheet.Header>…</MobileBottomSheet.Header>
//     <MobileBottomSheet.Body>…</MobileBottomSheet.Body>
//   </MobileBottomSheet>

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { cn } from "~/ui/lib/cn";

// ---------------------------------------------------------------------------
// Internal context
// ---------------------------------------------------------------------------

interface BottomSheetCtx {
  onOpenChange: (open: boolean) => void;
}

const BottomSheetContext = createContext<BottomSheetCtx | null>(null);

function useBottomSheet(): BottomSheetCtx {
  const ctx = useContext(BottomSheetContext);
  if (!ctx)
    throw new Error("MobileBottomSheet sub-component used outside root");
  return ctx;
}

// ---------------------------------------------------------------------------
// Focus-trap helper
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function trapFocus(container: HTMLElement, e: globalThis.KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE),
  ).filter((n) => !n.closest("[hidden]"));
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

// ---------------------------------------------------------------------------
// MobileBottomSheetRoot
// ---------------------------------------------------------------------------

export interface MobileBottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  /** Set to true when test environment mocks window.innerWidth to a mobile
   *  value via Object.defineProperty; the component reads window.innerWidth
   *  at render time, not via matchMedia. Pass `forceMobile` to override in
   *  tests that cannot set matchMedia. */
  forceMobile?: boolean;
}

function MobileBottomSheetRoot({
  open,
  onOpenChange,
  children,
  className,
  forceMobile,
}: MobileBottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Determine breakpoint.  window.innerWidth is synchronously available in
  // jsdom / happy-dom tests whereas matchMedia is typically stubbed.
  const isMobile =
    forceMobile ??
    (typeof window !== "undefined" ? window.innerWidth < 768 : false);

  // Focus first focusable element on open.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      el?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Focus-trap + esc-to-close.
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const panel = panelRef.current;
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
        return;
      }
      trapFocus(panel, e);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  // Lock body scroll while sheet is open on mobile.
  useEffect(() => {
    if (!isMobile) return;
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open, isMobile]);

  const handleBackdropClick = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handlePanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Prevent backdrop-click handler from receiving keyboard events that
    // bubble up through the panel.
    e.stopPropagation();
  };

  const prefersReducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  if (!open) return null;

  // ── Desktop shape (≥md): centered card ──────────────────────────────────
  if (!isMobile) {
    return (
      <BottomSheetContext.Provider value={{ onOpenChange }}>
        {/* Backdrop */}
        <div
          className="fixed inset-0 z-[200] bg-black/55 dark:bg-black/75"
          aria-hidden="true"
          onClick={handleBackdropClick}
          data-testid="bottom-sheet-backdrop"
        />
        {/* Card panel */}
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          className={cn(
            "fixed left-1/2 top-1/2 z-[210] w-full max-w-md -translate-x-1/2 -translate-y-1/2",
            "rounded-2xl bg-card/95 backdrop-blur-xl border border-white/30 dark:border-white/10",
            "shadow-2xl p-6 overflow-y-auto max-h-[90vh]",
            className,
          )}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handlePanelKeyDown}
          data-testid="bottom-sheet-panel"
        >
          {children}
        </div>
      </BottomSheetContext.Provider>
    );
  }

  // ── Mobile shape (<md): bottom-sheet snapping to lower 75% ──────────────
  return (
    <BottomSheetContext.Provider value={{ onOpenChange }}>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[200] bg-black/55 dark:bg-black/75"
        aria-hidden="true"
        onClick={handleBackdropClick}
        data-testid="bottom-sheet-backdrop"
      />
      {/* Sheet panel: h-[75vh] anchored to the bottom */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className={cn(
          // Snap to lower 75% of viewport.
          "fixed bottom-0 left-0 right-0 z-[210] h-[75vh]",
          "rounded-t-2xl bg-card/95 backdrop-blur-xl border-t border-x border-white/30 dark:border-white/10",
          "shadow-2xl overflow-y-auto",
          "flex flex-col",
          !prefersReducedMotion && "transition-transform duration-300 ease-out",
          className,
        )}
        style={
          !prefersReducedMotion ? { transform: "translateY(0)" } : undefined
        }
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handlePanelKeyDown}
        data-testid="bottom-sheet-panel"
      >
        {/* Drag handle — visual affordance */}
        <div
          className="flex justify-center pt-3 pb-1 shrink-0"
          aria-hidden="true"
          data-testid="drag-handle"
        >
          <div className="w-10 h-1 rounded-full bg-kumo-subtle/60" />
        </div>
        {children}
      </div>
    </BottomSheetContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface HeaderProps {
  children: ReactNode;
  className?: string;
}

function Header({ children, className }: HeaderProps) {
  // useBottomSheet is called to ensure context exists.
  useBottomSheet();
  return (
    <div
      className={cn("px-6 pt-4 pb-2 text-center shrink-0", className)}
      data-testid="bottom-sheet-header"
    >
      {children}
    </div>
  );
}
Header.displayName = "MobileBottomSheet.Header";

interface BodyProps {
  children: ReactNode;
  className?: string;
}

function Body({ children, className }: BodyProps) {
  useBottomSheet();
  return (
    <div
      className={cn("flex-1 overflow-y-auto px-6 pb-6 pt-2", className)}
      data-testid="bottom-sheet-body"
    >
      {children}
    </div>
  );
}
Body.displayName = "MobileBottomSheet.Body";

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

export const MobileBottomSheet = Object.assign(MobileBottomSheetRoot, {
  Header,
  Body,
});
