"""SDEMarketGroup model – market group hierarchy imported from CCP's SDE."""

from sqlalchemy import Column, Integer, String, Text, Boolean
from app.database import Base


class SDEMarketGroup(Base):
    __tablename__ = "sde_market_groups"

    market_group_id = Column(Integer, primary_key=True, autoincrement=False)
    parent_group_id = Column(Integer, nullable=True, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    icon_id = Column(Integer, nullable=True)
    has_types = Column(Boolean, default=True)

    def __repr__(self):
        return f"<SDEMarketGroup {self.name} (id={self.market_group_id})>"
