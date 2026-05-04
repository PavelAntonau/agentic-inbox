// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Loader } from "~/ui";
import { useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router";

/**
 * Admin layout — role-gate redirect.
 *
 * Fetches GET /api/admin/users on mount; if the server returns 401 or 403
 * (non-global-admin/owner), redirects to /. Otherwise renders the nested
 * admin pages via <Outlet />.
 *
 * This is a client-side guard (the server enforces auth on every API call).
 * The redirect prevents non-admin users from seeing the admin shell at all.
 */
export default function AdminLayout() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/users")
      .then((res) => {
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          navigate("/", { replace: true });
        } else {
          setAllowed(true);
        }
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
  }, [navigate]);

  if (checking) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader size="lg" />
      </div>
    );
  }

  if (!allowed) return null;

  // The root shell pins height: 100vh + overflow:hidden, so admin pages
  // need their OWN scroll container — without it, long routes (Observability
  // audit-log) just clip and the user has no way to reach the rest of the
  // page (UAT round-3 batch-3 finding).
  return (
    <div className="flex flex-col h-full bg-bg overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-12">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
