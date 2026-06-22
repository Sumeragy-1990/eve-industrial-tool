"""User (account) model – owns one or more EVE characters.

Introduced by migration 011 to provide per-user data isolation. Each EVE
character is linked to exactly one user via Character.user_id. A user is created
on the first SSO login of a character that does not yet belong to any account;
further characters can be merged into an existing account while logged in.
"""

from sqlalchemy import Column, Integer, String, DateTime
from sqlalchemy import func
from sqlalchemy.orm import relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    display_name = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # One account owns many characters.
    characters = relationship("Character", back_populates="user")

    def __repr__(self):
        return f"<User {self.id} ({self.display_name})>"
