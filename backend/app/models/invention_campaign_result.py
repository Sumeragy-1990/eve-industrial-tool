"""InventionCampaignResult model – individual results within an invention campaign."""

from sqlalchemy import Column, Integer, BigInteger, String, Float, DateTime, ForeignKey, func
from app.database import Base


class InventionCampaignResult(Base):
    """A single batch of invention attempts and their outcome within a campaign."""

    __tablename__ = "invention_campaign_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    campaign_id = Column(
        Integer, ForeignKey("invention_campaigns.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    # Link to industry job (if synced from ESI)
    industry_job_id = Column(BigInteger, nullable=True, unique=True)

    # Character that ran the job
    character_id = Column(BigInteger, nullable=False)

    # Blueprint info
    t1_blueprint_type_id = Column(Integer, nullable=False)
    t2_product_type_id = Column(Integer, nullable=False)
    t2_product_name = Column(String(256), nullable=True)

    # Decryptor used (if any)
    decryptor_type_id = Column(Integer, nullable=True)
    decryptor_name = Column(String(128), nullable=True)

    # Outcome
    attempts = Column(Integer, nullable=False, default=1)
    successes = Column(Integer, nullable=False, default=0)
    probability = Column(Float, nullable=True)

    # T2 BPC output
    runs = Column(Integer, nullable=False, default=1)  # T2 BPC runs per success
    me = Column(Integer, nullable=False, default=0)
    te = Column(Integer, nullable=False, default=0)

    # Cost
    cost_per_job = Column(Float, nullable=False, default=0.0)
    total_cost = Column(Float, nullable=False, default=0.0)

    # Link to BPC stock entry (when saved to stock)
    bpc_cost_id = Column(Integer, ForeignKey("user_bpc_costs.id"), nullable=True)

    # Status
    status = Column(String(32), nullable=False, default="running")
    # running | completed | failed

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    def __repr__(self):
        return (
            f"<InventionCampaignResult #{self.id} "
            f"campaign={self.campaign_id} "
            f"attempts={self.attempts} successes={self.successes}>"
        )
