// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  index,
  type RouteConfig,
  route,
  layout,
} from "@react-router/dev/routes";

export default [
  // Three-pane Outlook shell wraps all authenticated routes except /admin/**
  layout("routes/_app.tsx", [
    index("routes/home.tsx"),
    route("mailbox/:mailboxId", "routes/mailbox.tsx", [
      index("routes/mailbox-index.tsx"),
      route("emails/:folder", "routes/email-list.tsx"),
      route("settings", "routes/settings.tsx"),
      route("search", "routes/search-results.tsx"),
    ]),
    route("groups", "routes/groups/_layout.tsx", [
      index("routes/groups/index.tsx"),
      route(":groupId", "routes/groups/$groupId.tsx"),
      route(":groupId/members", "routes/groups/$groupId/members.tsx"),
    ]),
    // Phase 6: contacts page
    route("contacts", "routes/_app/contacts.tsx"),
    // Phase 3a: profile (avatar dropdown destination, public-ish identity)
    route("profile", "routes/profile.tsx"),
    // Phase 4: account (private settings — visibility, sessions, sign-out)
    route("account", "routes/account.tsx"),
    // Rail data loader endpoint (internal, fetched by MailboxTreeRail)
    route("_app/api.tree", "routes/_app/api.tree.ts"),
  ]),
  // Admin keeps its own 2-pane layout (Phase 2 frozen)
  route("admin", "routes/admin/_layout.tsx", [
    route("users", "routes/admin/users.tsx"),
    route("settings", "routes/admin/settings.tsx"),
    // Phase 6: observability dashboard
    route("observability", "routes/admin/observability.tsx"),
  ]),
  route("i/:id", "routes/i.$id.tsx"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
