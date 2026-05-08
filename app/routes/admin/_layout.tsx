// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Loader } from "~/ui";
import { useEffect, useState } from "react";
import { Outlet, useNavigate, useLocation } from "react-router";
import Header from "~/components/Header";

/**
 * Admin layout — auth + role gate redirect.
 *
 * Fetches GET /api/admin/users on mount and branches on the response:
 *   401            → unauthenticated. Hard-redirect to /login?from=<path>
 *                    (post-CF-Access cutover, no server-side gate is left;
 *                    /  would just hit the same 401 chain).
 *   403            → authenticated but not admin. SPA-redirect to /.
 *   network error  → SPA-redirect to /. Data fetches inside the layout
 *                    will re-trigger the auth path on the next attempt.
 *   2xx            → render <Outlet />.
 *
 * The Worker enforces auth on every data API; this is a UX recovery
 * affordance, not a security boundary.
 */
export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [checking, setChecking] = useState(true);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/users")
      .then((res) => {
        if (cancelled) return;
        if (res.status === 401) {
          const target = location.pathname + location.search + location.hash;
          const from = encodeURIComponent(target);
          window.location.replace(`/login?from=${from}`);
          return;
        }
        if (res.status === 403) {
          // Authenticated but lacks the admin role — bounce to home.
          navigate("/", { replace: true });
          return;
        }
        setAllowed(true);
      })
      .catch(() => {
        if (!cancelled) navigate("/", { replace: true });
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, location.pathname, location.search, location.hash]);

  if (checking) {
    // Header is rendered above the loader so the admin shell looks
    // continuous from the moment the redirect-check resolves.
    return (
      <>
        <Header />
        <div className="flex items-center justify-center py-20">
          <Loader size="lg" />
        </div>
      </>
    );
  }

  if (!allowed) return null;

  // The root shell pins height: 100vh + overflow:hidden, so admin pages
  // need their OWN scroll container — without it, long routes (Observability
  // audit-log) just clip and the user has no way to reach the rest of the
  // page (UAT round-3 batch-3 finding).
  return (
    <>
      <Header />
      <div className="flex flex-col h-full bg-bg overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-12">
            <Outlet />
          </div>
        </div>
      </div>
    </>
  );
}
