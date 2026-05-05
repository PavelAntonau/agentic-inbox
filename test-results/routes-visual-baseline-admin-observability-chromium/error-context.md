# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: routes.spec.ts >> visual baseline: admin-observability
- Location: test/visual/routes.spec.ts:48:3

# Error details

```
Error: expect(page).toHaveScreenshot(expected) failed

  42 pixels (ratio 0.01 of all image pixels) are different.

  Snapshot: admin-observability.png

Call log:
  - Expect "toHaveScreenshot(admin-observability.png)" with timeout 5000ms
    - verifying given screenshot expectation
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - 12060 pixels (ratio 0.02 of all image pixels) are different.
  - waiting 100ms before taking screenshot
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - 12073 pixels (ratio 0.02 of all image pixels) are different.
  - waiting 250ms before taking screenshot
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - captured a stable screenshot
  - 42 pixels (ratio 0.01 of all image pixels) are different.

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - link "ActionNow.AI home" [ref=e4] [cursor=pointer]:
        - /url: /
        - img "ActionNow.AI" [ref=e6]
      - button "Open global search" [ref=e8] [cursor=pointer]:
        - img [ref=e9]
        - generic [ref=e11]: Search mailboxes and more...
        - generic [ref=e12]: Ctrl+K
      - generic [ref=e13]:
        - 'button "Account: alice@actionnow.ai" [ref=e14] [cursor=pointer]':
          - 'generic "Account: alice@actionnow.ai" [ref=e15]':
            - generic [ref=e16]: A
        - button "Notifications" [ref=e18]:
          - img [ref=e19]
        - button "Switch to dark mode" [ref=e21] [cursor=pointer]:
          - img [ref=e22]
        - button "Settings" [ref=e24] [cursor=pointer]:
          - img [ref=e25]
    - generic [ref=e30]:
      - heading "Observability" [level=1] [ref=e31]
      - paragraph [ref=e32]: Live agent sessions, message-send rate, user login activity, and audit-log browser.
      - generic [ref=e33]:
        - generic [ref=e34]:
          - generic [ref=e35]:
            - heading "Active Agent Sessions" [level=2] [ref=e36]
            - generic [ref=e37]:
              - generic [ref=e38]: 0 active
              - generic [ref=e39]: 0 revoked
          - paragraph [ref=e40]: No active agent sessions.
        - generic [ref=e41]:
          - generic [ref=e42]:
            - heading "Email Send Rate" [level=2] [ref=e43]
            - generic [ref=e44]:
              - button "24h" [ref=e45]
              - button "7d" [ref=e46]
              - button "30d" [ref=e47]
          - generic [ref=e48]:
            - paragraph [ref=e49]: "0"
            - paragraph [ref=e50]: email actions in last 24 hours
            - paragraph [ref=e51]: Since 5/4/2026, 9:58:47 AM
      - generic [ref=e52]:
        - generic [ref=e53]:
          - heading "Last Login" [level=2] [ref=e54]
          - table [ref=e56]:
            - rowgroup [ref=e57]:
              - row "User Role Last Login" [ref=e58]:
                - columnheader "User" [ref=e59]
                - columnheader "Role" [ref=e60]
                - columnheader "Last Login" [ref=e61]
            - rowgroup [ref=e62]:
              - row "alice@actionnow.ai Owner 11h ago" [ref=e63]:
                - cell "alice@actionnow.ai" [ref=e64]:
                  - paragraph [ref=e65]: alice@actionnow.ai
                - cell "Owner" [ref=e66]:
                  - generic [ref=e67]: Owner
                - cell "11h ago" [ref=e68]
        - generic [ref=e69]:
          - generic [ref=e70]:
            - heading "Audit Log" [level=2] [ref=e71]
            - generic [ref=e72]: 4 events (last 7 days default)
          - generic [ref=e74]:
            - textbox "Filter by action" [ref=e75]:
              - /placeholder: Filter by action (e.g. email.)
            - button "Search" [ref=e76] [cursor=pointer]:
              - img [ref=e77]
              - text: Search
          - generic [ref=e79]:
            - button "email." [ref=e80]
            - button "token." [ref=e81]
            - button "contact." [ref=e82]
            - button "group." [ref=e83]
            - button "mailbox." [ref=e84]
            - button "workspace." [ref=e85]
            - button "settings." [ref=e86]
            - button "visibility." [ref=e87]
          - table [ref=e89]:
            - rowgroup [ref=e90]:
              - row "Time Action Actor Target" [ref=e91]:
                - columnheader "Time" [ref=e92]
                - columnheader "Action" [ref=e93]
                - columnheader "Actor" [ref=e94]
                - columnheader "Target" [ref=e95]
            - rowgroup [ref=e96]:
              - row "5/4/2026, 10:33:19 PM mailbox.unshare b7cb9b02-8f8a-45bf-8cd9-86cfd3178d90 mailbox:af65828aaa0fee1bc92ec73050bb634c" [ref=e97]:
                - cell "5/4/2026, 10:33:19 PM" [ref=e98]
                - cell "mailbox.unshare" [ref=e99]:
                  - generic [ref=e100]: mailbox.unshare
                - cell "b7cb9b02-8f8a-45bf-8cd9-86cfd3178d90" [ref=e101]
                - cell "mailbox:af65828aaa0fee1bc92ec73050bb634c" [ref=e102]
              - row "5/4/2026, 10:33:19 PM mailbox.share b7cb9b02-8f8a-45bf-8cd9-86cfd3178d90 mailbox:af65828aaa0fee1bc92ec73050bb634c" [ref=e103]:
                - cell "5/4/2026, 10:33:19 PM" [ref=e104]
                - cell "mailbox.share" [ref=e105]:
                  - generic [ref=e106]: mailbox.share
                - cell "b7cb9b02-8f8a-45bf-8cd9-86cfd3178d90" [ref=e107]
                - cell "mailbox:af65828aaa0fee1bc92ec73050bb634c" [ref=e108]
              - row "5/4/2026, 10:33:19 PM group.created b7cb9b02-8f8a-45bf-8cd9-86cfd3178d90 group:56f3ad42-3fee-4576-bf0e-f07a54a2d46e" [ref=e109]:
                - cell "5/4/2026, 10:33:19 PM" [ref=e110]
                - cell "group.created" [ref=e111]:
                  - generic [ref=e112]: group.created
                - cell "b7cb9b02-8f8a-45bf-8cd9-86cfd3178d90" [ref=e113]
                - cell "group:56f3ad42-3fee-4576-bf0e-f07a54a2d46e" [ref=e114]
              - row "5/4/2026, 10:33:19 PM mailbox.create b7cb9b02-8f8a-45bf-8cd9-86cfd3178d90 mailbox:af65828aaa0fee1bc92ec73050bb634c" [ref=e115]:
                - cell "5/4/2026, 10:33:19 PM" [ref=e116]
                - cell "mailbox.create" [ref=e117]:
                  - generic [ref=e118]: mailbox.create
                - cell "b7cb9b02-8f8a-45bf-8cd9-86cfd3178d90" [ref=e119]
                - cell "mailbox:af65828aaa0fee1bc92ec73050bb634c" [ref=e120]
  - generic:
    - region "Notifications"
```

# Test source

```ts
  1  | // Copyright (c) 2026 ActionNow.AI
  2  | // Licensed under the Apache 2.0 license
  3  | //
  4  | // Phase 7 T7.3 — visual baseline locked at MTV2 launch.
  5  | //
  6  | // Replaces the upstream-default 5-route spec (home / mailbox / settings /
  7  | // search-results / not-found) with the actual MTV2 route surface. Routes
  8  | // that need an authenticated identity inject the mock-Access cookie set
  9  | // for alice@actionnow.ai (global_owner per BOOTSTRAP_OWNER_EMAIL).
  10 | //
  11 | // To re-lock baselines: `npm run test:visual:update`.
  12 | 
  13 | import { test, expect } from "@playwright/test";
  14 | 
  15 | const ALICE_COOKIE = {
  16 |   name: "x-mock-user-email",
  17 |   value: encodeURIComponent("alice@actionnow.ai"),
  18 |   url: "http://localhost:5173",
  19 | };
  20 | 
  21 | interface RouteSpec {
  22 |   name: string;
  23 |   path: string;
  24 |   /** Inject alice cookie before navigating. Default: true. */
  25 |   auth?: boolean;
  26 | }
  27 | 
  28 | const routes: RouteSpec[] = [
  29 |   // Public surfaces
  30 |   { name: "login", path: "/login", auth: false },
  31 |   { name: "not-found", path: "/this-route-does-not-exist", auth: false },
  32 | 
  33 |   // Outlook three-pane shell (alice = global_owner)
  34 |   { name: "home", path: "/" },
  35 |   { name: "contacts", path: "/contacts" },
  36 | 
  37 |   // Groups + invitations
  38 |   { name: "groups", path: "/groups" },
  39 | 
  40 |   // Admin panel
  41 |   { name: "admin-users", path: "/admin/users" },
  42 |   { name: "admin-settings", path: "/admin/settings" },
  43 |   { name: "admin-tokens", path: "/admin/tokens" },
  44 |   { name: "admin-observability", path: "/admin/observability" },
  45 | ];
  46 | 
  47 | for (const route of routes) {
  48 |   test(`visual baseline: ${route.name}`, async ({ page, context }) => {
  49 |     if (route.auth !== false) {
  50 |       await context.addCookies([ALICE_COOKIE]);
  51 |     } else {
  52 |       await context.clearCookies();
  53 |     }
  54 |     await page.goto(route.path);
  55 |     await page.waitForLoadState("networkidle");
> 56 |     await expect(page).toHaveScreenshot(`${route.name}.png`);
     |                        ^ Error: expect(page).toHaveScreenshot(expected) failed
  57 |   });
  58 | }
  59 | 
```