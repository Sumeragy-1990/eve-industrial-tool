"""BlueprintMaterial model – cached Bill of Materials from ESI blueprint data."""

from sqlalchemy import Column, Integer, BigInteger, String, Float, DateTime, func, Index
from app.database import Base


class BlueprintMaterial(Base):
    """Cached blueprint material (BOM) data fetched from ESI.

    Each row represents one material required by a blueprint for a given activity.
    """

    __tablename__ = "blueprint_materials"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # Which blueprint
    blueprint_type_id = Column(Integer, nullable=False, index=True)

    # Activity (1=manufacturing, 3=invention, 4=time eff, 5=mat eff, 8=reactions, 11=copying)
    activity_id = Column(Integer, nullable=False, default=1)

    # The material itself
    material_type_id = Column(Integer, nullable=False)
    material_name = Column(String(256), nullable=True)

    # Quantity required for one run (base, before ME)
    quantity = Column(Integer, nullable=False, default=0)

    # Product info (what this blueprint produces for this activity)
    product_type_id = Column(Integer, nullable=True)
    product_name = Column(String(256), nullable=True)
    product_quantity = Column(Integer, nullable=True, default=1)

    # Cache metadata
    last_fetched = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_bp_materials_lookup", "blueprint_type_id", "activity_id", "material_type_id", unique=True),
    )

    def __repr__(self):
        return f"<BlueprintMaterial bp={self.blueprint_type_id} mat={self.material_type_id} qty={self.quantity}>"
