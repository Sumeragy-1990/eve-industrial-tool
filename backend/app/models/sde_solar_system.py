"""SDESolarSystem model – solar system and region data from SDE.

Enables resolving system names, region names, and security status
without hitting ESI. Used for location alias resolution and industry
cost index display.
"""

from sqlalchemy import Column, Integer, BigInteger, String, Float
from app.database import Base


class SDESolarSystem(Base):
    __tablename__ = "sde_solar_systems"

    system_id = Column(Integer, primary_key=True, autoincrement=False)
    system_name = Column(String(128), nullable=False, index=True)
    constellation_id = Column(Integer, nullable=True)
    constellation_name = Column(String(128), nullable=True)
    region_id = Column(Integer, nullable=True, index=True)
    region_name = Column(String(128), nullable=True)
    security_status = Column(Float, nullable=True)
    # -1.0 to 1.0

    def __repr__(self):
        return f"<SDESolarSystem {self.system_name} ({self.system_id})>"


class SDERegion(Base):
    __tablename__ = "sde_regions"

    region_id = Column(Integer, primary_key=True, autoincrement=False)
    region_name = Column(String(128), nullable=False, index=True)
    description = Column(String, nullable=True)

    def __repr__(self):
        return f"<SDERegion {self.region_name} ({self.region_id})>"


class SDEStation(Base):
    """Station data from SDE – enables resolving station names + system."""
    __tablename__ = "sde_stations"

    station_id = Column(BigInteger, primary_key=True, autoincrement=False)
    station_name = Column(String(256), nullable=False)
    system_id = Column(Integer, nullable=True)
    system_name = Column(String(128), nullable=True)
    region_id = Column(Integer, nullable=True)
    region_name = Column(String(128), nullable=True)
    station_type_id = Column(Integer, nullable=True)
    security = Column(Float, nullable=True)

    def __repr__(self):
        return f"<SDEStation {self.station_name} ({self.station_id})>"
