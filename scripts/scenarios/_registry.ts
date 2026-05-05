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
import sAuth4 from "./s-auth-4";
import sInbox1 from "./s-inbox-1";
import sInbox2 from "./s-inbox-2";
import sInbox3 from "./s-inbox-3";
import sInbox4 from "./s-inbox-4";
import sMsg1 from "./s-msg-1";
import sMsg2 from "./s-msg-2";
import sMsg3 from "./s-msg-3";
import sMsg5 from "./s-msg-5";
import sCli1 from "./s-cli-1";
import sCli2 from "./s-cli-2";
import sCli3 from "./s-cli-3";
import sCli4 from "./s-cli-4";
import sCli5 from "./s-cli-5";
import sContacts1 from "./s-contacts-1";
import sContacts2 from "./s-contacts-2";
import sContacts3 from "./s-contacts-3";
import sContacts4 from "./s-contacts-4";
import sDraft1 from "./s-draft-1";
import sGroup1 from "./s-group-1";
import sInvitations1 from "./s-invitations-1";
import sNotifications1 from "./s-notifications-1";
import sInbox3Allowlist from "./s-inbox-3-allowlist";
import sInbox3InternalMode from "./s-inbox-3-internal-mode";
import sMailbox1 from "./s-mailbox-1";
import sMailbox2 from "./s-mailbox-2";
import sGroup2 from "./s-group-2";
import sAdmin1 from "./s-admin-1";
import sAdmin2 from "./s-admin-2";
import sAdmin3 from "./s-admin-3";
import sAdmin4 from "./s-admin-4";
import sInvitations2 from "./s-invitations-2";
import sAuthOauthToken1 from "./s-auth-oauth-token-1";
import sMsgUserToUser1 from "./s-msg-user-to-user-1";

export interface RegistryEntry {
  scenario: Scenario;
}

const ALL: Scenario[] = [
  sAuth1,
  sAuth2,
  sAuth3,
  sAuth4,
  sInbox1,
  sInbox2,
  sInbox3,
  sInbox3Allowlist,
  sInbox3InternalMode,
  sInbox4,
  sMsg1,
  sMsg2,
  sMsg3,
  sMsg5,
  sCli1,
  sCli2,
  sCli3,
  sCli4,
  sCli5,
  sContacts1,
  sContacts2,
  sContacts3,
  sContacts4,
  sDraft1,
  sGroup1,
  sGroup2,
  sInvitations1,
  sInvitations2,
  sNotifications1,
  sMailbox1,
  sMailbox2,
  sAdmin1,
  sAdmin2,
  sAdmin3,
  sAdmin4,
  sAuthOauthToken1,
  sMsgUserToUser1,
];

export async function loadScenarios(): Promise<RegistryEntry[]> {
  return ALL.map((scenario) => ({ scenario }));
}
