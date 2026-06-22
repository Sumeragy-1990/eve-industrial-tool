-- Migration 010: Add Character Restock Lists
-- Phase 4C: Personal hangar restock calculator

CREATE TABLE IF NOT EXISTS character_restock_lists (
    id SERIAL PRIMARY KEY,
    character_id BIGINT NOT NULL,
    name VARCHAR(128) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_char_restock_lists_char ON character_restock_lists(character_id);

CREATE TABLE IF NOT EXISTS character_restock_list_items (
    id SERIAL PRIMARY KEY,
    restock_list_id INTEGER NOT NULL REFERENCES character_restock_lists(id) ON DELETE CASCADE,
    type_id INTEGER NOT NULL,
    type_name VARCHAR(256),
    target_quantity INTEGER NOT NULL DEFAULT 0,
    current_stock INTEGER DEFAULT 0,
    gap INTEGER DEFAULT 0,
    to_buy INTEGER DEFAULT 0,
    average_price FLOAT,
    estimated_cost FLOAT,
    category_group VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_char_restock_items_list ON character_restock_list_items(restock_list_id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_char_restock_items_list_type ON character_restock_list_items(restock_list_id, type_id);

COMMENT ON TABLE character_restock_lists IS 'Personal hangar restock lists per character';
COMMENT ON TABLE character_restock_list_items IS 'Items in a character restock list with target quantities';
