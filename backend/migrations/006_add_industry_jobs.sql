-- Migration 006: Add industry_jobs table for Phase 2A - Industry Job Tracking
-- Run: cat backend/migrations/006_add_industry_jobs.sql | docker compose exec -T db psql -U eve -d eve_industrial

BEGIN;

CREATE TABLE IF NOT EXISTS industry_jobs (
    id SERIAL PRIMARY KEY,

    -- ESI job identifier
    job_id BIGINT NOT NULL,
    character_id BIGINT NOT NULL,
    corporation_id BIGINT,

    -- Blueprint info
    blueprint_type_id INTEGER NOT NULL,
    blueprint_type_name VARCHAR(256),
    product_type_id INTEGER,
    product_type_name VARCHAR(256),

    -- Job configuration
    activity_id INTEGER,
    runs INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL,

    -- Timing
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ,
    duration BIGINT,

    -- Location
    location_id BIGINT,
    facility_id BIGINT,

    -- Cost / output
    cost DOUBLE PRECISION,
    licensed_runs INTEGER,

    -- Invention-specific
    probability DOUBLE PRECISION,
    successful_runs INTEGER,

    -- Installer
    installer_id BIGINT,
    installer_name VARCHAR(128),

    -- Sync metadata
    is_corp_job BOOLEAN DEFAULT FALSE,
    last_synced TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_industry_jobs_job_id ON industry_jobs (job_id);
CREATE INDEX IF NOT EXISTS ix_industry_jobs_character_status ON industry_jobs (character_id, status);
CREATE INDEX IF NOT EXISTS ix_industry_jobs_corp_status ON industry_jobs (corporation_id, status);

COMMIT;

-- Verify
SELECT 'industry_jobs' AS table_name, COUNT(*) AS row_count FROM industry_jobs;
