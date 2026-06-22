"""SDEItem model – items imported from CCP's Static Data Export."""

from sqlalchemy import Column, Integer, String, Float, Boolean, Text, BigInteger
from app.database import Base


class SDEItem(Base):
    __tablename__ = "sde_items"

    type_id = Column(Integer, primary_key=True, autoincrement=False)
    # CCP's type_id

    name = Column(String(256), nullable=False, index=True)
    # e.g. "Tritanium", "Rifter", "Damage Control II"

    description = Column(Text, nullable=True)

    group_id = Column(Integer, nullable=True, index=True)
    group_name = Column(String(128), nullable=True)

    category_id = Column(Integer, nullable=True, index=True)
    category_name = Column(String(128), nullable=True)

    # Market / meta
    market_group_id = Column(Integer, nullable=True)
    meta_group_id = Column(Integer, nullable=True)
    meta_group_name = Column(String(64), nullable=True)

    # Race / faction (for ship race grouping like EVE Market)
    race_id = Column(Integer, nullable=True, index=True)
    race_name = Column(String(32), nullable=True)

    # Physical properties
    mass = Column(Float, nullable=True)
    volume = Column(Float, nullable=True)
    capacity = Column(Float, nullable=True)
    radius = Column(Float, nullable=True)

    # Tech level
    tech_level = Column(Integer, nullable=True)
    is_blueprint = Column(Boolean, default=False)
    is_skill = Column(Boolean, default=False)
    is_ship = Column(Boolean, default=False)
    is_module = Column(Boolean, default=False)
    is_charge = Column(Boolean, default=False)
    is_drone = Column(Boolean, default=False)
    is_implant = Column(Boolean, default=False)
    is_structure = Column(Boolean, default=False)
    is_material = Column(Boolean, default=False)

    # Icon / graphic
    icon_id = Column(Integer, nullable=True)
    graphic_id = Column(Integer, nullable=True)

    def __repr__(self):
        return f"<SDEItem {self.name} (type_id={self.type_id})>"
