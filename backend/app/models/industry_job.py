"""IndustryJob model – tracks manufacturing, invention, and other industry jobs."""

from sqlalchemy import Column, Integer, BigInteger, String, Boolean, Float, DateTime, func, Index
from app.database import Base


class IndustryJob(Base):
    """An industry job (manufacturing, invention, reactions, etc.) synced from ESI."""

    __tablename__ = "industry_jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # ESI primary key
    job_id = Column(BigInteger, unique=True, nullable=False, index=True)

    # Ownership
    character_id = Column(BigInteger, nullable=False, index=True)
    corporation_id = Column(BigInteger, nullable=True)

    # Blueprint info
    blueprint_type_id = Column(Integer, nullable=False)
    blueprint_type_name = Column(String(256), nullable=True)
    product_type_id = Column(Integer, nullable=True)
    product_type_name = Column(String(256), nullable=True)

    # Job details
    activity_id = Column(Integer, nullable=True)
    runs = Column(Integer, nullable=False, default=1)
    status = Column(String(32), nullable=False, index=True)  # active/delivered/cancelled/paused/ready

    # Timing
    start_date = Column(DateTime(timezone=True), nullable=True)
    end_date = Column(DateTime(timezone=True), nullable=True)
    duration = Column(BigInteger, nullable=True)  # job duration in seconds

    # Location
    location_id = Column(BigInteger, nullable=True)
    facility_id = Column(BigInteger, nullable=True)

    # Cost / output
    cost = Column(Float, nullable=True)
    licensed_runs = Column(Integer, nullable=True)

    # Invention-specific
    probability = Column(Float, nullable=True)
    successful_runs = Column(Integer, nullable=True)

    # Installer
    installer_id = Column(BigInteger, nullable=True)
    installer_name = Column(String(128), nullable=True)

    # Sync metadata
    is_corp_job = Column(Boolean, default=False)
    last_synced = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_industry_jobs_character", "character_id", "status"),
        Index("ix_industry_jobs_corp", "corporation_id", "status"),
    )

    def __repr__(self):
        return f"<IndustryJob {self.job_id} type={self.blueprint_type_id} status={self.status}>"
