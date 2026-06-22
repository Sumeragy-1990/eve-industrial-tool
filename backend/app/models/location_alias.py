"""LocationAlias model – user-defined names for structures/stations/locations.

EVE's /universe/names/ endpoint cannot resolve player structure IDs
(ID >= 1 trillion). This model lets users assign custom names, colors,
and metadata to any location, including player structures, stations,
and solar systems.
"""

from sqlalchemy import Column, Integer, BigInteger, String, Boolean, DateTime, func
from app.database import Base


class LocationAlias(Base):
    __tablename__ = "location_aliases"

    id = Column(Integer, primary_key=True, autoincrement=True)
    location_id = Column(BigInteger, nullable=False, index=True)
    # The EVE location_id (station, structure, solar system, etc.)

    custom_name = Column(String(256), nullable=False)
    # User-defined display name (e.g. "Main HQ", "Mineral Warehouse")

    color = Column(String(16), nullable=True)
    # Optional hex color or Bootstrap color name for UI highlighting

    solar_system_id = Column(BigInteger, nullable=True)
    # Solar system this location belongs to (for player structures)

    structure_type_id = Column(Integer, nullable=True)
    # Type ID if this is a known structure type (e.g. Fortizar, Athanor)

    is_deleted = Column(Boolean, default=False)
    # Soft-delete flag so we don't lose user data

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return f"<LocationAlias {self.custom_name} (loc={self.location_id})>"
