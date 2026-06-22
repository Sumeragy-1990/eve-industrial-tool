"""Character model – stores EVE characters linked to this tool."""

from sqlalchemy import Column, Integer, BigInteger, String, Boolean, DateTime, Text, ForeignKey
from sqlalchemy import func
from sqlalchemy.orm import relationship
from app.database import Base


class Character(Base):
    __tablename__ = "characters"

    id = Column(Integer, primary_key=True, autoincrement=True)
    character_id = Column(BigInteger, unique=True, nullable=False, index=True)
    character_name = Column(String(128), nullable=False)
    corporation_id = Column(BigInteger, nullable=True)
    corporation_name = Column(String(128), nullable=True)

    # Owning account (migration 011). Nullable only transiently before migration;
    # the callback always sets it for new characters.
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    user = relationship("User", back_populates="characters")

    # EVE SSO CharacterOwnerHash (changes on character transfer; diagnostics only).
    owner_hash = Column(String(64), nullable=True)

    # OAuth tokens
    access_token = Column(Text, nullable=True)
    refresh_token = Column(Text, nullable=True)
    token_expires_at = Column(DateTime(timezone=True), nullable=True)

    # Scopes granted
    scopes = Column(Text, nullable=True)  # comma-separated

    # Character roles (checked after login)
    has_corp_roles = Column(Boolean, default=False)

    # Sync tracking
    assets_last_synced = Column(DateTime(timezone=True), nullable=True)
    is_active = Column(Boolean, default=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return f"<Character {self.character_name} ({self.character_id})>"
