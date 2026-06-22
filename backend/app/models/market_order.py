"""MarketOrder model – stores individual market orders from ESI (Phase 4A)."""

from sqlalchemy import Column, Integer, BigInteger, String, Float, Boolean, DateTime, func, Index
from app.database import Base


class MarketOrder(Base):
    """Individual market order fetched from ESI `/markets/{region_id}/orders/`."""

    __tablename__ = "market_orders"

    id = Column(Integer, primary_key=True, autoincrement=True)
    order_id = Column(BigInteger, nullable=False, unique=True)
    type_id = Column(Integer, nullable=False, index=True)
    is_buy_order = Column(Boolean, nullable=False, default=False)

    # Price & volume
    price = Column(Float, nullable=False)
    volume_remaining = Column(Integer, nullable=False)
    volume_total = Column(Integer, nullable=False)

    # Location
    location_id = Column(BigInteger, nullable=False)
    system_id = Column(Integer, nullable=True)
    region_id = Column(Integer, nullable=False, index=True)

    # Order details
    range = Column(String(32), nullable=True)
    duration = Column(Integer, nullable=True)
    issued = Column(DateTime(timezone=True), nullable=True)

    # Cache metadata
    fetched_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_market_orders_type_region", "type_id", "region_id"),
        Index("ix_market_orders_type_buy", "type_id", "is_buy_order"),
    )

    def __repr__(self):
        return (
            f"<MarketOrder order={self.order_id} type={self.type_id} "
            f"{'buy' if self.is_buy_order else 'sell'} {self.price} ISK>"
        )
