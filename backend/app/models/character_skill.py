"""CharacterSkill model – cached character skill levels for invention calculations."""

from sqlalchemy import Column, Integer, BigInteger, DateTime, func, UniqueConstraint
from app.database import Base


class CharacterSkill(Base):
    """Cached skill levels for a character, used by invention probability calc."""

    __tablename__ = "character_skills"

    id = Column(Integer, primary_key=True, autoincrement=True)
    character_id = Column(BigInteger, nullable=False, index=True)
    skill_type_id = Column(Integer, nullable=False)
    skill_level = Column(Integer, nullable=False, default=0)

    last_synced = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("character_id", "skill_type_id", name="uq_char_skill"),
    )

    def __repr__(self):
        return f"<CharacterSkill char={self.character_id} type={self.skill_type_id} lv={self.skill_level}>"
