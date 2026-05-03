// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";

/** All catalog keys the settings page surfaces. */
export const SETTINGS_KEYS = [
  "max_regular_users",
  "max_global_admins",
  "max_private_mailboxes_per_user",
  "max_mailboxes_per_group",
  "max_groups_per_mailbox",
  "agent_token_default_max_instances",
  "agent_token_idle_prune_minutes",
  "default_user_visibility",
  "group_invitation_ttl_days",
] as const;

export type SettingKey = (typeof SETTINGS_KEYS)[number];

export type SettingRow = {
  key: string;
  value: string;
  updated_at: number;
  updated_by: string | null;
};

/** Default values used when a key has never been written to D1. */
const DEFAULTS: Record<SettingKey, string> = {
  max_regular_users: "100",
  max_global_admins: "5",
  max_private_mailboxes_per_user: "5",
  max_mailboxes_per_group: "20",
  max_groups_per_mailbox: "10",
  agent_token_default_max_instances: "3",
  agent_token_idle_prune_minutes: "60",
  default_user_visibility: "everyone",
  group_invitation_ttl_days: "7",
};

// -----------------------------------------------------------------------
// In-memory cache — keyed by settings_version integer
// -----------------------------------------------------------------------

type CacheEntry = { version: number; rows: SettingRow[]; ts: number };
let _cache: CacheEntry | null = null;
const TTL_MS = 30_000; // 30 seconds

const VERSION_KEY = "settings_version";

async function loadFromD1(db: D1Database): Promise<SettingRow[]> {
  const orm = drizzle(db, { schema });
  const rows = await orm.select().from(schema.settings).all();

  const rowMap = new Map(rows.map((r) => [r.key, r]));

  // Build the catalog: include all known keys, applying defaults for missing ones
  return SETTINGS_KEYS.map((key) => {
    const existing = rowMap.get(key);
    if (existing) {
      return {
        key: existing.key,
        value: existing.value,
        updated_at: existing.updated_at,
        updated_by: existing.updated_by ?? null,
      };
    }
    return {
      key,
      value: DEFAULTS[key],
      updated_at: 0,
      updated_by: null,
    };
  });
}

/**
 * Get all catalog settings rows. Reads from D1 on cache miss or after 30 s TTL.
 * Uses in-memory module-level cache keyed by settings_version to avoid D1
 * reads on every request when the settings are unchanged.
 */
export async function getSettings(db: D1Database): Promise<SettingRow[]> {
  const now = Date.now();

  // Fast path: cache hit + TTL not expired
  if (_cache && now - _cache.ts < TTL_MS) {
    return _cache.rows;
  }

  // Check current version from D1 (cheap single-row read)
  const orm = drizzle(db, { schema });
  const versionRow = await orm
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, VERSION_KEY))
    .get();
  const currentVersion = versionRow ? parseInt(versionRow.value, 10) || 0 : 0;

  // If our cached version still matches, just refresh the TTL timestamp
  if (_cache && _cache.version === currentVersion) {
    _cache = { ..._cache, ts: now };
    return _cache.rows;
  }

  // Cache miss or version changed — reload from D1
  const rows = await loadFromD1(db);
  _cache = { version: currentVersion, rows, ts: now };
  return rows;
}

/**
 * Increment the settings_version counter in D1.
 * Called after any PATCH so the in-memory cache on the next request detects
 * the change and reloads within 30 s.
 */
export async function bumpVersion(
  db: D1Database,
  updatedBy?: string,
): Promise<void> {
  const orm = drizzle(db, { schema });
  const existing = await orm
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, VERSION_KEY))
    .get();

  const nextVersion = existing ? parseInt(existing.value, 10) + 1 : 1;
  const now = Date.now();

  await orm
    .insert(schema.settings)
    .values({
      key: VERSION_KEY,
      value: String(nextVersion),
      updated_at: now,
      updated_by: updatedBy ?? null,
    })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: {
        value: String(nextVersion),
        updated_at: now,
        updated_by: updatedBy ?? null,
      },
    })
    .run();

  // Invalidate the local cache so the next getSettings() call reloads
  _cache = null;
}
