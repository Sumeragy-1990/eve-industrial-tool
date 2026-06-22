"""CharacterRestockList and CharacterRestockListItem models – Personal Restock Calculator (Phase 4C)."""

from sqlalchemy import Column, Integer, BigInteger, String, Boolean, Float, ForeignKey, DateTime
from sqlalchemy import func, Index
from app.database import Base


class CharacterRestockList(Base):
    """A named restock list for a character's personal hangar."""

    __tablename__ = "character_restock_lists"

    id = Column(Integer, primary_key=True, autoincrement=True)
    character_id = Column(BigInteger, nullable=False, index=True)
    name = Column(String(128), nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("ix_char_restock_lists_char", "character_id"),
    )

    def __repr__(self):
        return f"<CharacterRestockList {self.name} char={self.character_id}>"


class CharacterRestockListItem(Base):
    """An item entry in a character restock list with target quantity."""

    __tablename__ = "character_restock_list_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    restock_list_id = Column(
        Integer,
        ForeignKey("character_restock_lists.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Item identification
    type_id = Column(Integer, nullable=False)
    type_name = Column(String(256), nullable=True)

    # Target configuration
    target_quantity = Column(Integer, nullable=False, default=0)

    # Computed fields (refreshed on demand)
    current_stock = Column(Integer, nullable=True, default=0)
    gap = Column(Integer, nullable=True, default=0)
    to_buy = Column(Integer, nullable=True, default=0)

    # Market pricing
    average_price = Column(Float, nullable=True)
    estimated_cost = Column(Float, nullable=True)

    # Category grouping (for UI organisation)
    category_group = Column(String(64), nullable=True)

    # Sync metadata
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("ix_char_restock_items_list_type", "restock_list_id", "type_id", unique=True),
    )

    def __repr__(self):
        return f"<CharacterRestockListItem type={self.type_id} target={self.target_quantity}>"
