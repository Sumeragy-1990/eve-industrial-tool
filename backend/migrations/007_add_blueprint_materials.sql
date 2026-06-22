-- Migration 007: Add blueprint_materials table for cached BOM data
-- This table stores blueprint material requirements fetched from ESI /universe/types/{id}/
-- with a 24-hour cache TTL.

CREATE TABLE IF NOT EXISTS blueprint_materials (
    id SERIAL PRIMARY KEY,
    blueprint_type_id INTEGER NOT NULL,
    activity_id INTEGER NOT NULL DEFAULT 1,
    material_type_id INTEGER NOT NULL,
    material_name VARCHAR(256),
    quantity INTEGER NOT NULL DEFAULT 0,
    product_type_id INTEGER,
    product_name VARCHAR(256),
    product_quantity INTEGER DEFAULT 1,
    last_fetched TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Unique index for upsert by bp + activity + material
CREATE UNIQUE INDEX IF NOT EXISTS ix_bp_materials_lookup
    ON blueprint_materials (blueprint_type_id, activity_id, material_type_id);

-- Index for faster product lookups
CREATE INDEX IF NOT EXISTS ix_blueprint_materials_product_type_id
    ON blueprint_materials (product_type_id);

-- Index for blueprint lookups
CREATE INDEX IF NOT EXISTS ix_blueprint_materials_blueprint_type_id
    ON blueprint_materials (blueprint_type_id);
