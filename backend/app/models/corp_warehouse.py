"""CorpWarehouseConfig model – defines corp hangars as named warehouses.

Each warehouse is defined by:
- A station/structure (location_id)
- A hangar division (division_id)
- An optional "is_mineral_warehouse" flag

This allows users to say "Station X, Division Y = Mineralien-Lager"
and have the restock system treat that specific hangar as a named
warehouse for stock calculations.
"""

from sqlalchemy import Column, Integer, BigInteger, String, Boolean, DateTime, func
from app.database import Base


class CorpWarehouseConfig(Base):
    __tablename__ = "corp_warehouse_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    corporation_id = Column(BigInteger, nullable=False, index=True)
    # The EVE corporation this config belongs to

    location_id = Column(BigInteger, nullable=False)
    # The station/structure ID where this warehouse lives

    location_name = Column(String(256), nullable=True)
    # Human-readable name of the location (resolved at config time)

    division_id = Column(Integer, nullable=False)
    # Hangar division number (1-7)

    division_name = Column(String(64), nullable=True)
    # Division name as returned by ESI (e.g. "Factory", "Minerals")

    warehouse_name = Column(String(128), nullable=False)
    # User-defined name for this warehouse (e.g. "Mineralien-Lager")

    is_mineral_warehouse = Column(Boolean, default=False)
    # Flag marking this as the primary mineral/material warehouse

    is_active = Column(Boolean, default=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return (
            f"<CorpWarehouseConfig {self.warehouse_name} "
            f"corp={self.corporation_id} loc={self.location_id} "
            f"div={self.division_id}>"
        )
