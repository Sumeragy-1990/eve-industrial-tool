"""InventionCampaign model – tracks a multi-run invention campaign from a T1 BPO."""

from sqlalchemy import Column, Integer, BigInteger, String, Float, DateTime, ForeignKey, func
from app.database import Base


class InventionCampaign(Base):
    """An invention campaign: a structured plan to invent a specific T2 BPC."""

    __tablename__ = "invention_campaigns"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)

    # Campaign metadata
    name = Column(String(256), nullable=False)
    status = Column(String(32), nullable=False, default="active", index=True)
    # active | paused | completed | archived

    # Blueprint info
    t1_blueprint_type_id = Column(Integer, nullable=False)
    t1_blueprint_name = Column(String(256), nullable=True)
    t2_product_type_id = Column(Integer, nullable=False)
    t2_product_name = Column(String(256), nullable=True)
    activity_id = Column(Integer, nullable=False, default=3)  # 3 = invention

    # Decryptor (optional)
    decryptor_type_id = Column(Integer, nullable=True)
    decryptor_name = Column(String(128), nullable=True)

    # Character running the invention jobs
    character_id = Column(BigInteger, nullable=False, index=True)

    # Cost inputs (per job, at campaign creation time)
    cost_index = Column(Float, nullable=False, default=0.01)
    install_fee_per_job = Column(Float, nullable=False, default=0.0)
    material_cost_per_job = Column(Float, nullable=False, default=0.0)
    decryptor_cost_per_job = Column(Float, nullable=False, default=0.0)
    total_cost_per_job = Column(Float, nullable=False, default=0.0)

    # Probability / expected output
    probability = Column(Float, nullable=False, default=0.0)
    expected_cost_per_success = Column(Float, nullable=False, default=0.0)
    runs_per_success = Column(Integer, nullable=False, default=1)
    cost_per_t2_run = Column(Float, nullable=False, default=0.0)

    # Target
    target_runs = Column(Integer, nullable=False, default=1)

    # Sync tracking
    last_synced = Column(DateTime(timezone=True), nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return (
            f"<InventionCampaign #{self.id} '{self.name}' "
            f"T1={self.t1_blueprint_type_id} T2={self.t2_product_type_id} "
            f"status={self.status}>"
        )
