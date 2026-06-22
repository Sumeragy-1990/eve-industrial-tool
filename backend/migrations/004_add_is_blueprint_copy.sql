-- Migration 004: Add is_blueprint_copy column for BPO vs BPC distinction
-- Run: docker compose exec -T db psql -U eve -d eve_industrial < backend/migrations/004_add_is_blueprint_copy.sql

BEGIN;

-- Add column (IF NOT EXISTS for idempotency)
ALTER TABLE assets ADD COLUMN IF NOT EXISTS is_blueprint_copy BOOLEAN DEFAULT FALSE;

-- Create index
CREATE INDEX IF NOT EXISTS ix_assets_is_blueprint_copy ON assets (is_blueprint_copy);

-- Backfill is_blueprint_copy for existing blueprint items:
-- In EVE: BPO (Original) = is_singleton = false, BPC (Copy) = is_singleton = true
UPDATE assets
SET is_blueprint_copy = is_singleton
WHERE is_blueprint = TRUE
  AND is_blueprint_copy IS DISTINCT FROM is_singleton;

-- Also backfill blueprint_runs from quantity for existing blueprints:
-- In ESI: quantity = -1 means BPO (unlimited), positive = BPC remaining runs
-- Since old data stored quantity = 1 for all, we use is_singleton as heuristic:
-- BPO (is_singleton=false) → blueprint_runs = -1 (unlimited)
-- BPC (is_singleton=true)  → blueprint_runs = NULL (unknown runs, needs re-sync)
UPDATE assets
SET blueprint_runs = CASE WHEN is_singleton = FALSE THEN -1 ELSE NULL END
WHERE is_blueprint = TRUE
  AND (blueprint_runs IS NULL OR blueprint_runs = 1);

COMMIT;

-- Verify
SELECT 
  is_blueprint_copy,
  COUNT(*) AS count,
  MIN(type_name) AS example
FROM assets
WHERE is_blueprint = TRUE
GROUP BY is_blueprint_copy
ORDER BY is_blueprint_copy;

SELECT 'blueprint_runs distribution' AS check_name,
  blueprint_runs,
  COUNT(*)
FROM assets
WHERE is_blueprint = TRUE
GROUP BY blueprint_runs
ORDER BY blueprint_runs;
