-- Migration 012: Fix duplicate sde_blueprint_materials rows
--
-- Problem: SDEBlueprintMaterial uses auto-increment 'id' as PK, so
-- SQLAlchemy db.merge() never matches existing rows. Each SDE re-import
-- creates duplicates, causing 3x material quantities in build cost calcs.
--
-- Fix: Deduplicate existing data, then add a UNIQUE constraint on
-- (type_id, activity_id, material_type_id) so future imports can't
-- create duplicates.

BEGIN;

-- 1. Remove duplicate rows, keeping only the lowest id for each unique
--    (type_id, activity_id, material_type_id) combination.
DELETE FROM sde_blueprint_materials a
USING sde_blueprint_materials b
WHERE a.id > b.id
  AND a.type_id = b.type_id
  AND a.activity_id = b.activity_id
  AND a.material_type_id = b.material_type_id;

-- 2. Add unique constraint to prevent future duplicates.
ALTER TABLE sde_blueprint_materials
  ADD CONSTRAINT uq_sde_blueprint_materials
  UNIQUE (type_id, activity_id, material_type_id);

COMMIT;
