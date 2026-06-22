-- Migration 008: Add cached_prices table for market price cache (Phase 4B)

CREATE TABLE IF NOT EXISTS cached_prices (
    id SERIAL PRIMARY KEY,
    type_id INTEGER NOT NULL,
    type_name VARCHAR(256),
    average_price DOUBLE PRECISION,
    adjusted_price DOUBLE PRECISION,
    sell_price_min DOUBLE PRECISION,
    buy_price_max DOUBLE PRECISION,
    volume BIGINT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_cached_prices_type_id ON cached_prices (type_id);

COMMENT ON TABLE cached_prices IS 'Cached market prices from ESI, refreshed periodically';
COMMENT ON COLUMN cached_prices.type_id IS 'EVE type ID (item type)';
COMMENT ON COLUMN cached_prices.type_name IS 'Human-readable type name from SDE';
COMMENT ON COLUMN cached_prices.average_price IS 'ESI average_price (regional average)';
COMMENT ON COLUMN cached_prices.adjusted_price IS 'ESI adjusted_price';
COMMENT ON COLUMN cached_prices.sell_price_min IS 'Lowest sell order across key trade hubs';
COMMENT ON COLUMN cached_prices.buy_price_max IS 'Highest buy order across key trade hubs';
COMMENT ON COLUMN cached_prices.volume IS 'Total volume traded';
