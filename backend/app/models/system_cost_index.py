"""SystemCostIndex model – cached ESI industry system cost indices (Bug 6).

Stores all 6 activity cost indices per solar system in a local table,
refreshed periodically from ESI /industry/systems/.
"""

from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, Float, DateTime, func, Index,
)
from app.database import Base


class SystemCostIndex(Base):
    """Cached cost indices for a solar system from ESI industry/systems endpoint."""

    __tablename__ = "system_cost_indices"

    solar_system_id = Column(Integer, primary_key=True, autoincrement=False)
    system_name = Column(String(128), nullable=False, index=True)
    region_name = Column(String(128), nullable=True)
    security_status = Column(Float, nullable=True)

    # Activity cost indices (6 activities total)
    manufacturing = Column(Float, nullable=True)
    research_time = Column(Float, nullable=True)      # TE Research
    research_material = Column(Float, nullable=True)  # ME Research
    invention = Column(Float, nullable=True)
    copying = Column(Float, nullable=True)
    reactions = Column(Float, nullable=True)

    # Sync metadata
    synced_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_system_cost_indices_synced", "synced_at"),
    )

    def to_dict(self) -> dict:
        """Return all cost indices as a flat dict."""
        return {
            "solar_system_id": self.solar_system_id,
            "system_name": self.system_name,
            "region_name": self.region_name,
            "security_status": self.security_status,
            "indices": {
                "manufacturing": self.manufacturing,
                "research_time": self.research_time,
                "research_material": self.research_material,
                "invention": self.invention,
                "copying": self.copying,
                "reactions": self.reactions,
            },
            "synced_at": self.synced_at.isoformat() if self.synced_at else None,
        }

    def get_index(self, activity: str) -> float | None:
        """Get a specific activity cost index by name."""
        return getattr(self, activity, None)

    def __repr__(self):
        return (
            f"<SystemCostIndex {self.system_name} "
            f"mfg={self.manufacturing} inv={self.invention}>"
        )
