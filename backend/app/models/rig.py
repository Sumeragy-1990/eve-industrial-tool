"""Rig definitions for Engineering Complexes — database-backed."""
from sqlalchemy import Column, Integer, String, Float
from app.database import Base

class Rig(Base):
    __tablename__ = "rigs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    rig_id = Column(String(80), unique=True, nullable=False, index=True)
    name = Column(String(200), nullable=False)
    size = Column(String(10), nullable=False)  # 'M', 'L', 'XL'
    tier = Column(Integer, nullable=False, default=1)  # 1 or 2
    category = Column(String(50), nullable=False)
    # For manufacturing rigs: which ship/item size they affect
    affects = Column(String(50), nullable=True)  # 'small_ship', 'medium_ship', 'large_ship', 'capital_ship', 'component', 'equipment', 'ammo', 'drone', 'structure'
    material_bonus = Column(Float, default=0.0)
    time_bonus = Column(Float, default=0.0)
    research_bonus = Column(Float, default=0.0)  # For research rigs (ME/TE/Copy/Invention)

    def __repr__(self):
        return f"<Rig {self.rig_id} ({self.size})>"

    def to_dict(self):
        return {
            "id": self.rig_id,
            "name": self.name,
            "size": self.size,
            "tier": self.tier,
            "category": self.category,
            "affects": self.affects,
            "material_bonus": self.material_bonus,
            "time_bonus": self.time_bonus,
            "research_bonus": self.research_bonus,
        }
