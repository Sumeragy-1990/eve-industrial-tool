-- Migration 009: Add market_orders table for individual order sync (Phase 4A)

CREATE TABLE IF NOT EXISTS market_orders (
    id SERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL UNIQUE,
    type_id INTEGER NOT NULL,
    is_buy_order BOOLEAN NOT NULL DEFAULT FALSE,

    -- Price & volume
    price DOUBLE PRECISION NOT NULL,
    volume_remaining INTEGER NOT NULL,
    volume_total INTEGER NOT NULL,

    -- Location
    location_id BIGINT NOT NULL,
    system_id INTEGER,
    region_id INTEGER NOT NULL,

    -- Order details
    range VARCHAR(32),
    duration INTEGER,
    issued TIMESTAMP WITH TIME ZONE,

    -- Cache metadata
    fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_market_orders_type_id ON market_orders (type_id);
CREATE INDEX IF NOT EXISTS ix_market_orders_region_id ON market_orders (region_id);
CREATE INDEX IF NOT EXISTS ix_market_orders_type_region ON market_orders (type_id, region_id);
CREATE INDEX IF NOT EXISTS ix_market_orders_type_buy ON market_orders (type_id, is_buy_order);

COMMENT ON TABLE market_orders IS 'Individual market orders from ESI, refreshed periodically';
COMMENT ON COLUMN market_orders.order_id IS 'Unique ESI order ID';
COMMENT ON COLUMN market_orders.type_id IS 'EVE type ID (item type)';
COMMENT ON COLUMN market_orders.is_buy_order IS 'True for buy orders, false for sell orders';
COMMENT ON COLUMN market_orders.price IS 'Order price per unit in ISK';
COMMENT ON COLUMN market_orders.volume_remaining IS 'Remaining volume (unfulfilled)';
COMMENT ON COLUMN market_orders.volume_total IS 'Original total volume';
COMMENT ON COLUMN market_orders.location_id IS 'Location (station or structure) ID';
COMMENT ON COLUMN market_orders.system_id IS 'Solar system ID';
COMMENT ON COLUMN market_orders.region_id IS 'Region ID (trade hub)';
COMMENT ON COLUMN market_orders.range IS 'Order range (e.g. station, region, solar_system)';
COMMENT ON COLUMN market_orders.duration IS 'Order duration in days';
COMMENT ON COLUMN market_orders.issued IS 'When the order was issued';
