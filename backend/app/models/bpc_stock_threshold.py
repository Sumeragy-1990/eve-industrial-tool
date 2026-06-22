"""UserBPCStockThreshold – per-product minimum BPC run thresholds for stock alerts."""

from sqlalchemy import Column, Integer, DateTime, func
from app.database import Base


class UserBPCStockThreshold(Base):
    """Per-user BPC stock threshold.

    A row with product_type_id=0 stores the global default threshold.
    All other rows override the global default for a specific product.

    The shopper frontend compares total_bpc_runs across all owned BPCs
    against this threshold to highlight items that need more invention.
    """

    __tablename__ = "user_bpc_stock_thresholds"

    id = Column(Integer, primary_key=True, autoincrement=True)
    character_id = Column(Integer, nullable=False, index=True)

    # product_type_id = 0 → global default threshold
    # product_type_id = N → per-product override
    product_type_id = Column(Integer, nullable=False)

    # Minimum total BPC runs desired before alerting
    min_runs = Column(Integer, nullable=False, default=10)

    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        scope = "global" if self.product_type_id == 0 else f"product {self.product_type_id}"
        return (
            f"<UserBPCStockThreshold char={self.character_id} "
            f"{scope} min_runs={self.min_runs}>"
        )
