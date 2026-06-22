"""SDEBlueprint model – blueprint manufacturing and reaction data.

This table stores the material requirements and product information
for all blueprints, imported from CCP's SDE. It enables offline
BOM calculation without hitting ESI for every blueprint lookup.

Data source: industryActivityMaterials, industryActivityProducts,
industryActivity, and industryBlueprints tables from the Fuzzwork
PostgreSQL SDE dump.
"""

from sqlalchemy import Column, Integer, String, Float, Boolean, BigInteger, ForeignKey
from app.database import Base


class SDEBlueprint(Base):
    """Blueprint definition – links a blueprint type to its product."""
    __tablename__ = "sde_blueprints"

    type_id = Column(Integer, primary_key=True, autoincrement=False)
    # The blueprint's type_id

    product_type_id = Column(Integer, nullable=True)
    # The type_id this blueprint produces

    product_name = Column(String(256), nullable=True)
    # Product name (denormalized for fast display)

    activity_id = Column(Integer, primary_key=True, autoincrement=False)
    # 1=Manufacturing, 3=Invention, 4=Time Efficiency,
    # 5=Material Efficiency, 8=Reactions, 11=Copying

    max_production_limit = Column(Integer, nullable=True)
    # Max runs per job (-1 = unlimited for BPO)

    manufacturing_time = Column(Integer, nullable=True)
    # Base time in seconds

    tech_level = Column(Integer, nullable=True)
    # 1=T1, 2=T2, 3=Storyline/Officer/Faction

    is_reaction = Column(Boolean, default=False)

    def __repr__(self):
        return f"<SDEBlueprint type={self.type_id} act={self.activity_id}>"


class SDEBlueprintMaterial(Base):
    """Material requirements for a blueprint activity."""
    __tablename__ = "sde_blueprint_materials"

    id = Column(Integer, primary_key=True, autoincrement=True)
    type_id = Column(Integer, nullable=False, index=True)
    # Blueprint type_id

    activity_id = Column(Integer, nullable=False)
    # Activity (1=manu, 3=invention, etc.)

    material_type_id = Column(Integer, nullable=False)
    # The required material's type_id

    material_name = Column(String(256), nullable=True)
    # Denormalized material name

    quantity = Column(Integer, nullable=False)
    # Base quantity per run

    is_optional = Column(Boolean, default=False)
    # True for decryptors in invention, etc. (can be omitted)

    def __repr__(self):
        return (
            f"<SDEBlueprintMaterial bp={self.type_id} "
            f"mat={self.material_type_id} qty={self.quantity}>"
        )


class SDEBlueprintProduct(Base):
    """Product output details for a blueprint activity."""
    __tablename__ = "sde_blueprint_products"

    id = Column(Integer, primary_key=True, autoincrement=True)
    type_id = Column(Integer, nullable=False, index=True)
    # Blueprint type_id

    activity_id = Column(Integer, nullable=False)
    # Activity

    product_type_id = Column(Integer, nullable=False)
    product_name = Column(String(256), nullable=True)
    quantity = Column(Integer, nullable=False)
    # Quantity per run (before skills/rigs)

    probability = Column(Float, nullable=True)
    # Invention success probability (0.0-1.0)

    def __repr__(self):
        return (
            f"<SDEBlueprintProduct bp={self.type_id} "
            f"prod={self.product_type_id} qty={self.quantity}>"
        )


class SDEBlueprintSkill(Base):
    """Skill requirements for a blueprint activity."""
    __tablename__ = "sde_blueprint_skills"

    id = Column(Integer, primary_key=True, autoincrement=True)
    type_id = Column(Integer, nullable=False, index=True)
    # Blueprint type_id

    activity_id = Column(Integer, nullable=False)
    skill_type_id = Column(Integer, nullable=False)
    skill_name = Column(String(128), nullable=True)
    level = Column(Integer, nullable=False)
    # Required skill level

    def __repr__(self):
        return (
            f"<SDEBlueprintSkill bp={self.type_id} "
            f"skill={self.skill_type_id} lvl={self.level}>"
        )
