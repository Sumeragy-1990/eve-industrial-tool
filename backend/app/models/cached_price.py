"""CachedPrice model – stores market prices fetched from ESI for quick lookup."""

from sqlalchemy import Column, Integer, BigInteger, String, Float, DateTime, func, Index
from app.database import Base


class CachedPrice(Base):
    """Cached market price for a type, refreshed periodically from ESI."""

    __tablename__ = "cached_prices"

    id = Column(Integer, primary_key=True, autoincrement=True)
    type_id = Column(Integer, nullable=False, index=True, unique=True)
    type_name = Column(String(256), nullable=True)

    # Market data
    average_price = Column(Float, nullable=True)
    adjusted_price = Column(Float, nullable=True)

    # From market orders (populated by market sync)
    sell_price_min = Column(Float, nullable=True)  # Lowest sell order
    buy_price_max = Column(Float, nullable=True)   # Highest buy order
    volume = Column(BigInteger, nullable=True)

    # Cache metadata
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return f"<CachedPrice type={self.type_id} avg={self.average_price}>"
