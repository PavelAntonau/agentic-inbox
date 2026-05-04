-- Phase 1 (mcp-oauth) — @better-auth/oauth-provider + better-auth/plugins JWT
--
-- Implements RFC 6749 / OAuth 2.1 / RFC 9728 / RFC 8707 storage:
--   jwks                — JWT signing keys (active when jwt() plugin runs without a static signing key)
--   oauth_client        — registered clients (incl. trusted Claude Code, ChatGPT desktop, Cursor, iOS app)
--   oauth_consent       — per-client per-user scope grants (PKCE-bound)
--   oauth_refresh_token — refresh-token rotation chain (RFC 6749 §6)
--   oauth_access_token  — issued bearer access tokens (JWT or opaque)
--
-- Plugin sources (verbatim):
--   node_modules/@better-auth/oauth-provider/dist/index.mjs (schema = { ... } export, ~line 2421)
--   node_modules/better-auth/dist/plugins/jwt/schema.mjs (schema = { jwks: { ... } })
--
-- Field-name mapping convention (matches existing 0005_better_auth.sql):
--   TS camelCase (better-auth API)   ↔   DB snake_case (SQLite column name)
--   Example: clientId ↔ client_id, redirectUris ↔ redirect_uris
--
-- Type mapping (better-auth → SQLite):
--   "string"                 → TEXT
--   "string[]"               → TEXT  (JSON-stringified array)
--   "json"                   → TEXT  (JSON-stringified object)
--   "boolean"                → INTEGER (0/1)
--   "date"                   → INTEGER (epoch ms; matches existing tables)
--
-- NOT NULL discipline: enforced ONLY when the plugin schema sets
--   required: true. Fields with required: false (or unset) are nullable, even
--   when always-set in practice — match the plugin's contract literally so
--   the drizzleAdapter's create-on-default semantics keep working.
--
-- Numbering note: migrations 0006..0010 in this directory belong to a prior
-- plan (rate_limit, inbox_policies, clients_and_grants, backfill, send-flag).
-- The mcp-oauth action plan's "0006_oauth_provider" / "0007_rate_limit"
-- numbering is stale; oauth_provider plus jwt land at 0011 here. Downstream
-- T3.1 (PATs) becomes 0012, T3.4 (drop agent_tokens) becomes 0013. See plan
-- progress note 3 for the renumbering.

-- 1. jwks — better-auth/plugins/jwt key storage.
--   Used while jwt() runs without a static signing key (T1.4 may switch to
--   env-supplied keys, in which case this table stays present but unused).
CREATE TABLE jwks (
  id          TEXT    PRIMARY KEY,
  public_key  TEXT    NOT NULL,
  private_key TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER
);
CREATE INDEX jwks_created_at_idx ON jwks(created_at);

-- 2. oauth_client — registered OAuth clients.
--   Logical identity is `client_id` (UNIQUE); FKs from tokens/consent target
--   that column. Public clients (PKCE-only, e.g. Claude Code desktop) leave
--   `client_secret` NULL. JSON-array fields (`redirect_uris`, `scopes`,
--   `grant_types`, `response_types`, `contacts`, `post_logout_redirect_uris`)
--   are stored as JSON-stringified TEXT.
CREATE TABLE oauth_client (
  id                          TEXT    PRIMARY KEY,
  client_id                   TEXT    NOT NULL UNIQUE,
  client_secret               TEXT,
  disabled                    INTEGER,
  skip_consent                INTEGER,
  enable_end_session          INTEGER,
  subject_type                TEXT,
  scopes                      TEXT,
  user_id                     TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at                  INTEGER,
  updated_at                  INTEGER,
  name                        TEXT,
  uri                         TEXT,
  icon                        TEXT,
  contacts                    TEXT,
  tos                         TEXT,
  policy                      TEXT,
  software_id                 TEXT,
  software_version            TEXT,
  software_statement          TEXT,
  redirect_uris               TEXT    NOT NULL,
  post_logout_redirect_uris   TEXT,
  token_endpoint_auth_method  TEXT,
  grant_types                 TEXT,
  response_types              TEXT,
  public                      INTEGER,
  type                        TEXT,
  require_pkce                INTEGER,
  reference_id                TEXT,
  metadata                    TEXT
);
CREATE INDEX oauth_client_user_id_idx ON oauth_client(user_id);

-- 3. oauth_consent — per-(client, user) scope grants.
--   Lookup pattern: WHERE client_id = ? AND user_id = ? AND reference_id = ?
--   (PKCE-bound consent, see oauth-provider/dist/index.mjs ~line 49-66).
CREATE TABLE oauth_consent (
  id           TEXT    PRIMARY KEY,
  client_id    TEXT    NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  user_id      TEXT    REFERENCES users(id) ON DELETE CASCADE,
  reference_id TEXT,
  scopes       TEXT    NOT NULL,
  created_at   INTEGER,
  updated_at   INTEGER
);
CREATE INDEX oauth_consent_client_id_idx ON oauth_consent(client_id);
CREATE INDEX oauth_consent_user_id_idx   ON oauth_consent(user_id);

-- 4. oauth_refresh_token — refresh-token rotation chain.
--   The plugin sets `revoked` (a date) on the previous refresh when issuing
--   a new one (oauth-provider ~line 427-433). session_id is SET NULL when
--   the user's browser session ends so the audit trail survives sign-out.
CREATE TABLE oauth_refresh_token (
  id           TEXT    PRIMARY KEY,
  token        TEXT    NOT NULL,
  client_id    TEXT    NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  session_id   TEXT    REFERENCES session(id) ON DELETE SET NULL,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference_id TEXT,
  expires_at   INTEGER,
  created_at   INTEGER,
  revoked      INTEGER,
  auth_time    INTEGER,
  scopes       TEXT    NOT NULL
);
CREATE INDEX oauth_refresh_token_token_idx     ON oauth_refresh_token(token);
CREATE INDEX oauth_refresh_token_client_id_idx ON oauth_refresh_token(client_id);
CREATE INDEX oauth_refresh_token_user_id_idx   ON oauth_refresh_token(user_id);

-- 5. oauth_access_token — issued access tokens (JWT or opaque).
--   `token` is UNIQUE (when set) — opaque tokens use it for lookup; JWT
--   tokens are validated by signature + aud (RFC 8707) and don't need
--   table lookup, so the column stays nullable for the future-mixed case.
--   refresh_id links back to the refresh_token that minted this access token.
CREATE TABLE oauth_access_token (
  id           TEXT    PRIMARY KEY,
  token        TEXT    UNIQUE,
  client_id    TEXT    NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  session_id   TEXT    REFERENCES session(id) ON DELETE SET NULL,
  user_id      TEXT    REFERENCES users(id) ON DELETE CASCADE,
  reference_id TEXT,
  refresh_id   TEXT    REFERENCES oauth_refresh_token(id) ON DELETE SET NULL,
  expires_at   INTEGER,
  created_at   INTEGER,
  scopes       TEXT    NOT NULL
);
CREATE INDEX oauth_access_token_client_id_idx  ON oauth_access_token(client_id);
CREATE INDEX oauth_access_token_user_id_idx    ON oauth_access_token(user_id);
CREATE INDEX oauth_access_token_expires_at_idx ON oauth_access_token(expires_at);
