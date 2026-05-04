// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Scenario registry — explicit static import of every scenario module so
 * `tsx` doesn't need to glob the filesystem at runtime.
 *
 * Add new scenarios here. Order is preserved when running `--all`.
 */

import type { Scenario } from "./_types";

import sAuth1 from "./s-auth-1";
import sAuth2 from "./s-auth-2";
import sAuth3 from "./s-auth-3";
import sInbox1 from "./s-inbox-1";
import sInbox2 from "./s-inbox-2";
import sMsg1 from "./s-msg-1";
import sMsg2 from "./s-msg-2";
import sMsg5 from "./s-msg-5";
import sCli1 from "./s-cli-1";
import sCli2 from "./s-cli-2";

export interface RegistryEntry {
  scenario: Scenario;
}

const ALL: Scenario[] = [
  sAuth1,
  sAuth2,
  sAuth3,
  sInbox1,
  sInbox2,
  sMsg1,
  sMsg2,
  sMsg5,
  sCli1,
  sCli2,
];

export async function loadScenarios(): Promise<RegistryEntry[]> {
  return ALL.map((scenario) => ({ scenario }));
}
