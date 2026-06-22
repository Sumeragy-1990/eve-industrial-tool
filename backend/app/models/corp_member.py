"""CorpMember model – tracks corp members' location and status."""

from sqlalchemy import Column, Integer, BigInteger, String, Boolean, DateTime, Float
from sqlalchemy import func, Index
from app.database import Base


class CorpMember(Base):
    __tablename__ = "corp_members"

    id = Column(Integer, primary_key=True, autoincrement=True)
    corporation_id = Column(BigInteger, nullable=False, index=True)
    character_id = Column(BigInteger, nullable=False, index=True)
    character_name = Column(String(128), nullable=False)

    # Location tracking
    location_id = Column(BigInteger, nullable=True)
    location_name = Column(String(256), nullable=True)
    ship_type_id = Column(Integer, nullable=True)
    ship_name = Column(String(128), nullable=True)

    # Online status
    is_online = Column(Boolean, default=False)
    last_login = Column(DateTime(timezone=True), nullable=True)
    last_logout = Column(DateTime(timezone=True), nullable=True)
    logins_since_start = Column(Integer, nullable=True)

    # Sync metadata
    synced_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_corp_members_corp_char", "corporation_id", "character_id", unique=True),
    )

    def __repr__(self):
        return f"<CorpMember {self.character_name} corp={self.corporation_id}>"
