"""Asset model – stores items found in hangars/containers."""

from sqlalchemy import Column, Integer, BigInteger, String, Boolean, DateTime, Float, Text
from sqlalchemy import func, Index
from app.database import Base


class Asset(Base):
    __tablename__ = "assets"

    id = Column(BigInteger, primary_key=True, autoincrement=False)
    # The EVE asset item_id

    character_id = Column(BigInteger, nullable=False, index=True)
    # Which character this asset belongs to (or 0 for corp)

    corporation_id = Column(BigInteger, nullable=True)
    # Corp ID if this is a corp asset

    is_corp_asset = Column(Boolean, default=False)

    type_id = Column(Integer, nullable=False, index=True)
    # EVE type_id (links to SDE)

    type_name = Column(String(256), nullable=True)
    # Resolved from SDE at sync-time

    # ── Category info (populated from SDE during sync) ──────────
    group_id = Column(Integer, nullable=True, index=True)
    group_name = Column(String(128), nullable=True)
    category_id = Column(Integer, nullable=True, index=True)
    category_name = Column(String(128), nullable=True)

    # ── Meta group (Tech I, Tech II, Faction, Officer, etc.) ────
    meta_group_id = Column(Integer, nullable=True, index=True)
    meta_group_name = Column(String(64), nullable=True)

    # Item classification flags (denormalized for fast filtering)
    is_ship = Column(Boolean, default=False, index=True)
    is_module = Column(Boolean, default=False, index=True)
    is_charge = Column(Boolean, default=False, index=True)
    is_drone = Column(Boolean, default=False, index=True)
    is_implant = Column(Boolean, default=False, index=True)
    is_structure = Column(Boolean, default=False, index=True)
    is_material = Column(Boolean, default=False, index=True)
    # ────────────────────────────────────────────────────────────

    quantity = Column(Integer, default=1)

    # ── Location info ───────────────────────────────────────────
    location_id = Column(BigInteger, nullable=True, index=True)
    location_name = Column(String(256), nullable=True)
    location_category = Column(String(32), nullable=True)
    # Type of location: "station", "structure", "solar_system", "item"

    location_flag = Column(String(64), nullable=True)
    # e.g. "Hangar", "CorpDeliveries", "Wallet", etc.

    # Physical properties
    volume = Column(Float, nullable=True)

    is_singleton = Column(Boolean, default=False)

    # Division info (for corp hangars)
    division_id = Column(Integer, nullable=True)
    division_name = Column(String(64), nullable=True)

    # Blueprint-specific
    is_blueprint = Column(Boolean, default=False)
    is_blueprint_copy = Column(Boolean, default=False, index=True)
    blueprint_me = Column(Integer, nullable=True)
    blueprint_te = Column(Integer, nullable=True)
    blueprint_runs = Column(Integer, nullable=True)

    # Container parent
    container_item_id = Column(BigInteger, nullable=True)

    # Sync metadata
    sync_batch = Column(String(32), nullable=True, index=True)
    synced_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_assets_owner_type", "character_id", "type_id"),
        Index("ix_assets_location", "location_id", "character_id"),
    )

    def __repr__(self):
        return f"<Asset type={self.type_id} qty={self.quantity} char={self.character_id}>"
