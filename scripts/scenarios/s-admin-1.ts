// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * S-ADMIN-1 — Admin settings GET + PATCH.
 *
 * Branches covered:
 *   GET   /api/admin/settings                       (200 — catalog of 9 SETTINGS_KEYS rows)
 *   PATCH /api/admin/settings/unknown_key            (400 — key not in catalog)
 *   PATCH /api/admin/settings/max_global_admins     (400 — value missing)
 *   PATCH /api/admin/settings/max_global_admins     (400 — value negative)
 *   PATCH /api/admin/settings/max_global_admins     (400 — value above SETTINGS_MAX_VALUES cap)
 *   PATCH /api/admin/settings/default_user_visibility (400 — bogus enum value)
 *   PATCH /api/admin/settings/max_global_admins     (200 — happy path; new value reflected in GET)
 *   PATCH /api/admin/settings/default_user_visibility (200 — enum happy path)
 *
 * Locks workers/routes/admin/settings.ts:40-194 — the GET catalog handler,
 * the PATCH key validator, the integer/enum coercion, the F-AS2 per-key
 * MAX_VALUES upper-bound enforcement, and the audit-log write.
 *
 * Alice is BOOTSTRAP_OWNER_EMAIL (.dev.vars) → global_owner via the
 * bootstrap-owner promotion path; the admin guard
 * (workers/routes/admin/settings.ts:27-34) admits her without further
 * seeding. Each PATCH writes an audit row; we don't read those back here
 * (S-ADMIN-3 covers audit-side effects via the obs/audit endpoint).
 */

import type { Scenario } from "./_types";
import { TEST_USERS, loginAs } from "./_helpers";

interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
  updated_by: string | null;
}

const scenario: Scenario = {
  id: "S-ADMIN-1",
  description:
    "Admin settings catalog GET + PATCH validation + happy-path round-trip (integer + enum)",
  covers:
    "GET /api/admin/settings → PATCH unknown 400 → PATCH no-body 400 → PATCH negative 400 → PATCH over-cap 400 (F-AS2) → PATCH bogus enum 400 → PATCH happy 200 → GET shows new value",
  smoke: false,

  async run(ctx) {
    await loginAs(ctx, TEST_USERS.alice);

    // 1. GET /api/admin/settings — catalog of 9 keys (SETTINGS_KEYS).
    const list = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/settings');
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (list.status !== 200) {
      throw new Error(
        `GET /api/admin/settings expected 200, got ${list.status}: ${list.body.slice(0, 200)}`,
      );
    }
    const listBody = JSON.parse(list.body) as { settings: SettingRow[] };
    if (!Array.isArray(listBody.settings) || listBody.settings.length !== 9) {
      throw new Error(
        `expected 9 settings rows, got ${listBody.settings?.length}`,
      );
    }
    const keys = listBody.settings.map((r) => r.key).sort();
    const expectedKeys = [
      "agent_token_default_max_instances",
      "agent_token_idle_prune_minutes",
      "default_user_visibility",
      "group_invitation_ttl_days",
      "max_global_admins",
      "max_groups_per_mailbox",
      "max_mailboxes_per_group",
      "max_private_mailboxes_per_user",
      "max_regular_users",
    ];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`settings keys mismatch — got ${JSON.stringify(keys)}`);
    }
    ctx.log(`GET /api/admin/settings → 9 catalog rows ✓`);

    // 2. PATCH unknown key → 400.
    const unknown = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/settings/no_such_key', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 1 }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (unknown.status !== 400) {
      throw new Error(
        `PATCH unknown key expected 400, got ${unknown.status}: ${unknown.body.slice(0, 200)}`,
      );
    }
    ctx.log(`PATCH /unknown_key → 400 ✓`);

    // 3. PATCH known key with no value → 400.
    const noValue = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/settings/max_global_admins', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (noValue.status !== 400) {
      throw new Error(
        `PATCH no-value expected 400, got ${noValue.status}: ${noValue.body.slice(0, 200)}`,
      );
    }
    ctx.log(`PATCH /max_global_admins {} → 400 ✓`);

    // 4. PATCH integer key with negative → 400.
    const negative = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/settings/max_global_admins', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: -3 }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (negative.status !== 400) {
      throw new Error(
        `PATCH negative expected 400, got ${negative.status}: ${negative.body.slice(0, 200)}`,
      );
    }
    ctx.log(`PATCH /max_global_admins { value: -3 } → 400 ✓`);

    // 5. PATCH over the F-AS2 cap (max_global_admins cap = 20) → 400.
    const overCap = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/settings/max_global_admins', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 999999 }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (overCap.status !== 400) {
      throw new Error(
        `PATCH over-cap expected 400, got ${overCap.status}: ${overCap.body.slice(0, 200)}`,
      );
    }
    const overCapBody = JSON.parse(overCap.body) as { error?: string };
    if (
      typeof overCapBody.error !== "string" ||
      !overCapBody.error.toLowerCase().includes("maximum")
    ) {
      throw new Error(
        `over-cap error should mention 'maximum', got ${JSON.stringify(overCapBody)}`,
      );
    }
    ctx.log(`PATCH /max_global_admins { 999999 } → 400 (F-AS2 cap) ✓`);

    // 6. PATCH enum key with bogus value → 400.
    const bogusEnum = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/settings/default_user_visibility', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 'martian' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (bogusEnum.status !== 400) {
      throw new Error(
        `PATCH bogus enum expected 400, got ${bogusEnum.status}: ${bogusEnum.body.slice(0, 200)}`,
      );
    }
    ctx.log(`PATCH /default_user_visibility { 'martian' } → 400 ✓`);

    // 7. PATCH integer happy path: max_global_admins → 7 (within cap=20).
    const happyInt = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/settings/max_global_admins', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 7 }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (happyInt.status !== 200) {
      throw new Error(
        `PATCH happy-int expected 200, got ${happyInt.status}: ${happyInt.body.slice(0, 200)}`,
      );
    }
    const happyIntBody = JSON.parse(happyInt.body) as {
      ok: boolean;
      key: string;
      value: string;
    };
    if (
      !happyIntBody.ok ||
      happyIntBody.key !== "max_global_admins" ||
      happyIntBody.value !== "7"
    ) {
      throw new Error(
        `happy-int response shape wrong: ${JSON.stringify(happyIntBody)}`,
      );
    }
    ctx.log(`PATCH /max_global_admins { 7 } → 200 ✓`);

    // 8. PATCH enum happy path: default_user_visibility → "contacts".
    const happyEnum = (await ctx.browser.call("browser_evaluate", {
      expression: `(async () => {
        const res = await fetch('/api/admin/settings/default_user_visibility', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 'contacts' }),
        });
        return { status: res.status, body: await res.text() };
      })()`,
    })) as { status: number; body: string };
    if (happyEnum.status !== 200) {
      throw new Error(
        `PATCH happy-enum expected 200, got ${happyEnum.status}: ${happyEnum.body.slice(0, 200)}`,
      );
    }
    ctx.log(`PATCH /default_user_visibility { 'contacts' } → 200 ✓`);

    // 9. GET reflects both new values.
    const after = (await ctx.browser.call("browser_evaluate", {
      expression: `fetch('/api/admin/settings').then(r => r.json())`,
    })) as { settings: SettingRow[] };
    const cap = after.settings.find((r) => r.key === "max_global_admins");
    const vis = after.settings.find((r) => r.key === "default_user_visibility");
    if (cap?.value !== "7") {
      throw new Error(
        `expected max_global_admins=7 after PATCH, got ${cap?.value}`,
      );
    }
    if (vis?.value !== "contacts") {
      throw new Error(
        `expected default_user_visibility=contacts after PATCH, got ${vis?.value}`,
      );
    }
    ctx.log(`GET reflects PATCHed values (cap=7, visibility=contacts) ✓`);
    await ctx.screenshot("after-settings-patch");

    // Five intentional 400 probes (unknown / no-value / negative / over-cap / bogus-enum).
    // Allow ≤5 console errors.
    const consoleSnap = await ctx.captureConsole("after-admin-settings");
    if (consoleSnap.errors > 5) {
      throw new Error(
        `expected ≤5 console errors (the 5 × 400 probes), got ${consoleSnap.errors} (see ${consoleSnap.path})`,
      );
    }
    ctx.log(`console errors = ${consoleSnap.errors} (≤5 ✓)`);
  },
};

export default scenario;
