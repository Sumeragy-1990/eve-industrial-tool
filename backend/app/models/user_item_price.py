"""UserItemPrice model – user-defined price overrides and purchase history."""

from sqlalchemy import Column, Integer, BigInteger, Float, String, DateTime, func
from app.database import Base


class UserItemPrice(Base):
    """User-defined item prices with purchase history for median calculation."""

    __tablename__ = "user_item_prices"

    id = Column(Integer, primary_key=True, autoincrement=True)
    character_id = Column(Integer, nullable=False, index=True)
    type_id = Column(Integer, nullable=False)

    # Manual override (user can set any price)
    override_price = Column(Float, nullable=True)

    # Last purchase info (for quick display)
    last_purchase_price = Column(Float, nullable=True)
    last_purchase_qty = Column(Integer, nullable=True)
    last_purchase_at = Column(DateTime(timezone=True), nullable=True)

    # Cumulative weighted average = cumulative_cost / cumulative_qty
    cumulative_qty = Column(BigInteger, default=0)
    cumulative_cost = Column(Float, default=0.0)

    # Computed weighted average price (user's historic average)
    weighted_average_price = Column(Float, nullable=True)

    # Preferred price source
    price_source = Column(String(32), default="jita")
    # "jita" | "override" | "weighted" | "min"

    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return (
            f"<UserItemPrice char={self.character_id} "
            f"type={self.type_id} override={self.override_price}>"
        )
