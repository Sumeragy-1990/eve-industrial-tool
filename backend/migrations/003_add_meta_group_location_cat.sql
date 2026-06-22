-- Migration 003: Add meta_group, location_category, volume columns
-- Run: docker compose exec -T db psql -U eve -d eve_industrial < backend/migrations/003_add_meta_group_location_cat.sql

BEGIN;

-- Add new columns (IF NOT EXISTS for idempotency)
ALTER TABLE assets ADD COLUMN IF NOT EXISTS meta_group_id INTEGER;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS meta_group_name VARCHAR(64);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS location_category VARCHAR(32);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS volume DOUBLE PRECISION;

-- Create indexes for new columns
CREATE INDEX IF NOT EXISTS ix_assets_meta_group_id ON assets (meta_group_id);
CREATE INDEX IF NOT EXISTS ix_assets_location_category ON assets (location_category);

-- Backfill category_id, category_name, meta_group_id, meta_group_name, volume
-- from sde_items for existing assets that have NULL values
UPDATE assets a
SET
    category_id    = COALESCE(a.category_id, s.category_id),
    category_name  = COALESCE(NULLIF(a.category_name, ''), s.category_name),
    meta_group_id  = s.meta_group_id,
    meta_group_name = s.meta_group_name,
    volume         = s.volume
FROM sde_items s
WHERE a.type_id = s.type_id
  AND (
    a.category_id IS NULL
    OR a.category_name IS NULL OR a.category_name = ''
    OR a.meta_group_id IS NULL
    OR a.volume IS NULL
  );

-- Backfill is_* classification flags for assets that have all FALSE
-- (only if they haven't been set yet, i.e. all are FALSE)
UPDATE assets a
SET
    is_blueprint = COALESCE(NULLIF(a.is_blueprint, FALSE), s.is_blueprint),
    is_ship      = COALESCE(NULLIF(a.is_ship, FALSE), s.is_ship),
    is_module    = COALESCE(NULLIF(a.is_module, FALSE), s.is_module),
    is_charge    = COALESCE(NULLIF(a.is_charge, FALSE), s.is_charge),
    is_drone     = COALESCE(NULLIF(a.is_drone, FALSE), s.is_drone),
    is_implant   = COALESCE(NULLIF(a.is_implant, FALSE), s.is_implant),
    is_structure = COALESCE(NULLIF(a.is_structure, FALSE), s.is_structure),
    is_material  = COALESCE(NULLIF(a.is_material, FALSE), s.is_material)
FROM sde_items s
WHERE a.type_id = s.type_id
  AND a.is_blueprint = FALSE
  AND a.is_ship = FALSE
  AND a.is_module = FALSE
  AND a.is_charge = FALSE
  AND a.is_drone = FALSE
  AND a.is_implant = FALSE
  AND a.is_structure = FALSE
  AND a.is_material = FALSE;

COMMIT;

-- Verify counts
SELECT 'category_id NULL' AS check_name, COUNT(*) FROM assets WHERE category_id IS NULL
UNION ALL
SELECT 'meta_group_id NULL', COUNT(*) FROM assets WHERE meta_group_id IS NULL
UNION ALL
SELECT 'location_name NULL', COUNT(*) FROM assets WHERE location_name IS NULL
UNION ALL
SELECT 'location_category NULL', COUNT(*) FROM assets WHERE location_category IS NULL
UNION ALL
SELECT 'is_blueprint false', COUNT(*) FROM assets WHERE type_name ILIKE '%blueprint%' AND is_blueprint = FALSE
UNION ALL
SELECT 'is_blueprint true', COUNT(*) FROM assets WHERE is_blueprint = TRUE;
