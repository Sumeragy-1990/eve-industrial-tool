"""UserBPCCost model – tracks what a BPC cost the user (purchase or invention)."""

from sqlalchemy import Column, Integer, Float, String, DateTime, func
from app.database import Base


class UserBPCCost(Base):
    """Per-user BPC cost tracking – supports both purchase and invention costs.

    Used by the Invention Page to show true T2 production profitability
    including the amortized BPC cost per run.
    """

    __tablename__ = "user_bpc_costs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    character_id = Column(Integer, nullable=False, index=True)

    # The blueprint type this BPC is for (the product's blueprint, e.g. T2)
    bp_type_id = Column(Integer, nullable=False, index=True)

    # The product this BPC produces
    product_type_id = Column(Integer, nullable=False)
    product_name = Column(String(256), nullable=True)

    # How the BPC was acquired
    cost_source = Column(String(32), nullable=False, default="invention")
    # "invention" | "purchase" | "contract" | "loot" | "manual"

    # The T1 blueprint used for invention (NULL if purchased)
    source_bp_type_id = Column(Integer, nullable=True)

    # Total cost to acquire this BPC
    total_cost = Column(Float, nullable=False, default=0.0)

    # Number of runs on the BPC
    runs = Column(Integer, nullable=False, default=1)

    # Cost per run = total_cost / runs
    cost_per_run = Column(Float, nullable=True)

    # ME/TE of the BPC (for invention, affected by decryptor)
    me = Column(Integer, default=0)
    te = Column(Integer, default=0)

    # Invention-specific fields
    decryptor_type_id = Column(Integer, nullable=True)
    decryptor_name = Column(String(128), nullable=True)
    invention_attempts = Column(Integer, nullable=True)
    invention_probability = Column(Float, nullable=True)

    # When this cost was recorded
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    def __repr__(self):
        return (
            f"<UserBPCCost char={self.character_id} bp={self.bp_type_id} "
            f"src={self.cost_source} cost={self.total_cost}>"
        )
