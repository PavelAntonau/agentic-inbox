// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// useAuthGuard — client-side auth probe that hard-redirects to /login when
// no authenticated session is present.
//
// Why this exists:
//
// After the 2026-05-07 post-CF-Access cutover (commit bc7297e), the static
// SPA shell (`/`, `/threads`, `/mailbox/*`, etc.) is publicly cacheable —
// CF Access no longer gates the zone. Workers data endpoints still 401
// without a valid better-auth session cookie, so no data leaks; but the
// HTML/JS bundle loads in incognito with no auth, leaving the user staring
// at an empty React shell with no recovery path. That UX hole reads as a
// public exposure even though it isn't.
//
// This hook restores the redirect-to-login behaviour at the SPA boundary.
// It runs once on mount of any layout that wraps protected routes (the
// `_app` shell and the `admin/_layout` shell). On 401/403 from
// `/api/users/me` it does a hard `window.location.replace("/login?from=...")`
// — replace (not push) so the broken URL doesn't pollute history; `from`
// preserves the original target so post-login can bounce back.
//
// The Worker is and remains the source of truth for authorization. This
// hook is purely a UX recovery affordance — it does NOT introduce any new
// security boundary, and removing it would not expose any data.

import { useEffect } from "react";
import { useLocation } from "react-router";

interface UseAuthGuardOptions {
  /**
   * If true, skip the redirect (the layout already does its own guard).
   * Used by `admin/_layout.tsx` which has tighter checks against admin role.
   */
  skip?: boolean;
}

export function useAuthGuard(opts: UseAuthGuardOptions = {}): void {
  const location = useLocation();
  useEffect(() => {
    if (opts.skip) return;
    let cancelled = false;
    fetch("/api/users/me", { credentials: "include" })
      .then((res) => {
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          // Hard redirect — replace, not push. Preserve target via `?from=`.
          const target = location.pathname + location.search + location.hash;
          // Avoid an infinite-redirect loop: if we somehow ended up on
          // /login itself wrapped by a guarded layout, do nothing.
          if (location.pathname.startsWith("/login")) return;
          const from = encodeURIComponent(target);
          window.location.replace(`/login?from=${from}`);
        }
      })
      .catch(() => {
        // Network error / offline — silent. Data fetches inside the layout
        // will re-trigger the redirect on the next attempt; we don't want
        // to bounce users to /login on a transient blip.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
