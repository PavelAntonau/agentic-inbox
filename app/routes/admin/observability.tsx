// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Admin — Observability dashboard.
// Wraps the 4 obs panels: Active Sessions, Message Rate, Last Login, Audit Log.
// Admin-gated server-side; the admin _layout client-side guard redirects non-admins.

import ActiveSessionsPanel from "~/components/admin/obs/ActiveSessionsPanel";
import MessageRatePanel from "~/components/admin/obs/MessageRatePanel";
import LastLoginPanel from "~/components/admin/obs/LastLoginPanel";
import AuditLogBrowser from "~/components/admin/obs/AuditLogBrowser";

export function meta() {
  return [{ title: "Admin — Observability | ActionNowAI Mail" }];
}

export default function AdminObservabilityRoute() {
  // Scroll lives on the admin layout's flex-1 container now, NOT on this
  // route — `h-full overflow-y-auto` on a content-driven parent collapsed
  // to 0 and trapped scrolling inside an unreachable region.
  return (
    <div className="px-4 py-4 md:px-8 md:py-6">
      <h1 className="text-lg font-semibold text-text-bright mb-1">
        Observability
      </h1>
      <p className="text-sm text-text-muted mb-6">
        Live agent sessions, message-send rate, user login activity, and
        audit-log browser.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <ActiveSessionsPanel />
        <MessageRatePanel />
      </div>

      <div className="grid grid-cols-1 gap-4">
        <LastLoginPanel />
        <AuditLogBrowser />
      </div>
    </div>
  );
}
