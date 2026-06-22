-- Migration 005: Add restock_lists and restock_list_items tables
-- Run: cat backend/migrations/005_add_restock_tables.sql | docker compose exec -T db psql -U eve -d eve_industrial

BEGIN;

-- Restock lists (named shopping lists per corporation)
CREATE TABLE IF NOT EXISTS restock_lists (
    id SERIAL PRIMARY KEY,
    corporation_id BIGINT NOT NULL,
    name VARCHAR(128) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_restock_lists_corp ON restock_lists (corporation_id);

-- Restock list items (individual items with target quantities)
CREATE TABLE IF NOT EXISTS restock_list_items (
    id SERIAL PRIMARY KEY,
    restock_list_id INTEGER NOT NULL REFERENCES restock_lists(id) ON DELETE CASCADE,
    type_id INTEGER NOT NULL,
    type_name VARCHAR(256),
    target_quantity INTEGER NOT NULL DEFAULT 0,
    current_stock INTEGER DEFAULT 0,
    gap INTEGER DEFAULT 0,
    to_buy INTEGER DEFAULT 0,
    average_price DOUBLE PRECISION,
    estimated_cost DOUBLE PRECISION,
    category_group VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_restock_items_list ON restock_list_items (restock_list_id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_restock_items_list_type
    ON restock_list_items (restock_list_id, type_id);

COMMIT;

-- Verify
SELECT 'restock_lists' AS table_name, COUNT(*) AS row_count FROM restock_lists
UNION ALL
SELECT 'restock_list_items', COUNT(*) FROM restock_list_items;
