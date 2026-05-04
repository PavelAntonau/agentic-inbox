// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import type { Email } from "~/types";

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";

export interface ComposeOptions {
  mode: ComposeMode;
  originalEmail?: Email | null;
  /** When editing a draft, this holds the draft email to pre-fill the composer */
  draftEmail?: Email | null;
}

interface UIState {
  // Side panel state
  selectedEmailId: string | null;
  isComposing: boolean;
  _previousEmailId: string | null;
  selectEmail: (id: string | null) => void;
  startCompose: (options?: ComposeOptions) => void;
  closePanel: () => void;
  closeCompose: () => void;

  // Compose options
  composeOptions: ComposeOptions;

  // Mobile sidebar
  isSidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;

  // Agent panel
  isAgentPanelOpen: boolean;
  toggleAgentPanel: () => void;
  // True once the user has manually re-opened the agent panel during the
  // currently-selected email view. Sticky for the lifetime of that email
  // view so subsequent re-renders don't auto-close again. Resets when the
  // selected email changes or is cleared.
  userOpenedAgentDuringEmail: boolean;

  // Legacy dialog support (kept for non-split views)
  isComposeModalOpen: boolean;
  openComposeModal: (options?: ComposeOptions) => void;
  closeComposeModal: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  selectedEmailId: null,
  isComposing: false,
  _previousEmailId: null,
  composeOptions: { mode: "new", originalEmail: null },
  isComposeModalOpen: false,
  isSidebarOpen: false,
  isAgentPanelOpen: true,
  userOpenedAgentDuringEmail: false,

  selectEmail: (id) =>
    set((state) => {
      // Opening or switching emails: auto-collapse the agent panel unless the
      // user already manually re-opened it during this email view (sticky).
      if (id !== null && id !== state.selectedEmailId) {
        const shouldAutoCollapse =
          state.isAgentPanelOpen && !state.userOpenedAgentDuringEmail;
        return {
          selectedEmailId: id,
          isComposing: false,
          isAgentPanelOpen: shouldAutoCollapse ? false : state.isAgentPanelOpen,
          userOpenedAgentDuringEmail: false,
        };
      }
      // Clearing the selection (or selecting same id) resets the sticky flag.
      return {
        selectedEmailId: id,
        isComposing: false,
        userOpenedAgentDuringEmail: false,
      };
    }),

  startCompose: (options) =>
    set((state) => {
      const mode = options?.mode || "new";
      const isReplyOrForward =
        mode === "reply" || mode === "reply-all" || mode === "forward";
      return {
        isComposing: true,
        _previousEmailId: state.selectedEmailId,
        // Keep selectedEmailId when replying/forwarding so the thread stays visible
        selectedEmailId: isReplyOrForward ? state.selectedEmailId : null,
        composeOptions: options || { mode: "new", originalEmail: null },
        isSidebarOpen: false,
      };
    }),

  closePanel: () =>
    set({
      selectedEmailId: null,
      isComposing: false,
      _previousEmailId: null,
      composeOptions: { mode: "new" as const, originalEmail: null },
      userOpenedAgentDuringEmail: false,
    }),

  closeCompose: () =>
    set((state) => ({
      isComposing: false,
      selectedEmailId: state._previousEmailId,
      _previousEmailId: null,
      composeOptions: { mode: "new" as const, originalEmail: null },
    })),

  openSidebar: () => set({ isSidebarOpen: true }),
  closeSidebar: () => set({ isSidebarOpen: false }),
  toggleSidebar: () => set({ isSidebarOpen: !get().isSidebarOpen }),

  toggleAgentPanel: () =>
    set((state) => {
      const next = !state.isAgentPanelOpen;
      // If the user is manually re-opening the panel while an email is open,
      // mark the sticky flag so a subsequent selectEmail/refresh doesn't
      // auto-close it again.
      const sticky =
        next && state.selectedEmailId !== null
          ? true
          : state.userOpenedAgentDuringEmail;
      return { isAgentPanelOpen: next, userOpenedAgentDuringEmail: sticky };
    }),

  openComposeModal: (options) =>
    set({
      composeOptions: options || { mode: "new", originalEmail: null },
      isComposeModalOpen: true,
    }),

  closeComposeModal: () =>
    set({
      isComposeModalOpen: false,
      composeOptions: { mode: "new", originalEmail: null },
    }),
}));
