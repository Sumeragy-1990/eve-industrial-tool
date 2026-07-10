-- Migration 013: Add system_cost_indices table (Bug 6)
-- Caches ESI /industry/systems/ data locally for fast lookup.
-- All 6 activity cost indices per solar system.

CREATE TABLE IF NOT EXISTS system_cost_indices (
    solar_system_id INTEGER PRIMARY KEY,
    system_name VARCHAR(128) NOT NULL,
    region_name VARCHAR(128),
    security_status DOUBLE PRECISION,

    -- Activity cost indices (NULL if not provided by ESI)
    manufacturing DOUBLE PRECISION,
    research_time DOUBLE PRECISION,       -- TE Research (Time Efficiency)
    research_material DOUBLE PRECISION,   -- ME Research (Material Efficiency)
    invention DOUBLE PRECISION,
    copying DOUBLE PRECISION,
    reactions DOUBLE PRECISION,

    -- Sync metadata
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_system_cost_indices_name ON system_cost_indices (system_name);
CREATE INDEX IF NOT EXISTS ix_system_cost_indices_synced ON system_cost_indices (synced_at);

COMMENT ON TABLE system_cost_indices IS 'Cached ESI industry system cost indices for all solar systems';
COMMENT ON COLUMN system_cost_indices.solar_system_id IS 'EVE solar system ID';
COMMENT ON COLUMN system_cost_indices.system_name IS 'Solar system name (from SDE)';
COMMENT ON COLUMN system_cost_indices.manufacturing IS 'Manufacturing cost index';
COMMENT ON COLUMN system_cost_indices.research_time IS 'Time Efficiency research cost index';
COMMENT ON COLUMN system_cost_indices.research_material IS 'Material Efficiency research cost index';
COMMENT ON COLUMN system_cost_indices.invention IS 'Invention cost index';
COMMENT ON COLUMN system_cost_indices.copying IS 'Copying cost index';
COMMENT ON COLUMN system_cost_indices.reactions IS 'Reactions cost index';
