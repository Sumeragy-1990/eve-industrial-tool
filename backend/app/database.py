"""Database engine and session management."""

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

engine = create_async_engine(settings.database_url, echo=settings.debug)
async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_session() -> AsyncSession:
    """Dependency that yields a database session."""
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db():
    """Create all tables on startup."""
    async with engine.begin() as conn:
        from app.models.user import User  # noqa
        from app.models.character import Character  # noqa
        from app.models.asset import Asset  # noqa
        from app.models.sde_item import SDEItem  # noqa
        from app.models.corp_member import CorpMember  # noqa
        from app.models.restock import RestockList, RestockListItem  # noqa
        from app.models.industry_job import IndustryJob  # noqa
        from app.models.blueprint_material import BlueprintMaterial  # noqa
        from app.models.cached_price import CachedPrice  # noqa
        from app.models.market_order import MarketOrder  # noqa
        from app.models.character_restock import CharacterRestockList, CharacterRestockListItem  # noqa
        from app.models.location_alias import LocationAlias  # noqa
        from app.models.corp_warehouse import CorpWarehouseConfig  # noqa
        from app.models.user_item_price import UserItemPrice  # noqa
        from app.models.bpc_cost import UserBPCCost  # noqa
        from app.models.bpc_stock_threshold import UserBPCStockThreshold  # noqa
        from app.models.sde_blueprint import SDEBlueprint, SDEBlueprintMaterial, SDEBlueprintProduct, SDEBlueprintSkill  # noqa
        from app.models.sde_solar_system import SDESolarSystem, SDERegion, SDEStation  # noqa

        await conn.run_sync(Base.metadata.create_all)
