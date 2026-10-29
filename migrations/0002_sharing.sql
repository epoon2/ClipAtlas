-- Sharing: shared spaces, their people, invite links and earlier versions, and view-only links.
-- The Worker also makes these tables the first time sharing is used (src/share.js), so applying this is optional.
CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '', items INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS space_members (space_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, added_at INTEGER NOT NULL, accepted INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (space_id, user_id));
CREATE TABLE IF NOT EXISTS space_removed (space_id TEXT NOT NULL, user_id TEXT NOT NULL, removed_at INTEGER NOT NULL, PRIMARY KEY (space_id, user_id));
CREATE TABLE IF NOT EXISTS space_history (space_id TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL, saved_at INTEGER NOT NULL, saved_by TEXT NOT NULL DEFAULT '', items INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (space_id, revision));
CREATE INDEX IF NOT EXISTS space_members_by_user ON space_members(user_id);
CREATE TABLE IF NOT EXISTS space_invites (token TEXT PRIMARY KEY, space_id TEXT NOT NULL, role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS space_invites_by_space ON space_invites(space_id);
CREATE TABLE IF NOT EXISTS share_links (token TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, space_id TEXT NOT NULL DEFAULT '', collection TEXT NOT NULL DEFAULT '', include_notes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS share_links_by_owner ON share_links(owner_id);
CREATE INDEX IF NOT EXISTS share_links_by_space ON share_links(space_id);
