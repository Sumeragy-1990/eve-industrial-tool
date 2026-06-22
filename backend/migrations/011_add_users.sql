-- Migration 011: Multi-Character Accounts (Security: per-user data isolation)
-- Introduces a `users` table and links every character to an owning user.
--
-- Background: the tool had NO account concept – every logged-in session saw the
-- global pool of all characters (cross-account data leak). This migration adds
-- ownership so each user only sees their own characters/assets/blueprints.
--
-- Data migration strategy: VARIANTE A (approved)
--   All existing characters belong to the operator -> assign them to user id 1.
--   The foreign character (added by mistake) is deactivated SEPARATELY afterwards
--   (its character_id must be confirmed first), so that player re-logs in and the
--   new callback flow creates a fresh, isolated account for them.

-- ── 1. users table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id           SERIAL PRIMARY KEY,
    display_name VARCHAR(128),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE users IS 'Accounts. One user owns one or more EVE characters.';

-- ── 2. characters get an owner + SSO owner hash ─────────────────
ALTER TABLE characters ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE characters ADD COLUMN IF NOT EXISTS owner_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS ix_characters_user_id ON characters(user_id);

COMMENT ON COLUMN characters.user_id IS 'Owning account (users.id). NULL only transiently before migration.';
COMMENT ON COLUMN characters.owner_hash IS 'EVE SSO CharacterOwnerHash (changes on character transfer; diagnostics only).';

-- ── 3. VARIANTE A: assign all existing characters to the operator ──
INSERT INTO users (id, display_name) VALUES (1, 'Operator')
    ON CONFLICT (id) DO NOTHING;

UPDATE characters SET user_id = 1 WHERE user_id IS NULL;

-- Keep the SERIAL sequence ahead of the explicit id=1 insert above,
-- so future auto-generated user ids don't collide with id 1.
SELECT setval(
    pg_get_serial_sequence('users', 'id'),
    GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1)
);

-- ── 4. (MANUAL, run separately once the foreign character_id is confirmed) ──
-- Identify the most recently added character (likely the foreign one):
--   SELECT character_id, character_name, created_at
--   FROM characters ORDER BY created_at DESC LIMIT 5;
-- Then deactivate it:
--   UPDATE characters SET is_active = false WHERE character_id = <FOREIGN_CHARACTER_ID>;
