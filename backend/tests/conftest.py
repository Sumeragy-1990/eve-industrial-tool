"""Pytest fixtures for the backend security tests.

These tests are fully self-contained: they run against an in-memory SQLite
database and never touch PostgreSQL, EVE SSO, or the network. They verify the
core multi-account data-isolation contract introduced by migration 011
(see plans/security_multi-account_fix.md).
"""

import pytest_asyncio
from sqlalchemy.ext.asyncio import (
    create_async_engine,
    AsyncSession,
    async_sessionmaker,
)

from app.database import Base

# Importing the models registers them on the shared declarative Base so that
# create_all() builds the `users` and `characters` tables (and their FK).
from app.models.user import User  # noqa: E402,F401
from app.models.character import Character  # noqa: E402,F401


@pytest_asyncio.fixture
async def db_session():
    """Yield a fresh in-memory SQLite AsyncSession with the schema created."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        # Only the two tables we imported above are created – enough to test
        # the ownership helpers without dragging in the whole schema.
        await conn.run_sync(
            lambda c: Base.metadata.create_all(
                c, tables=[User.__table__, Character.__table__]
            )
        )
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def two_accounts(db_session):
    """Seed two distinct accounts with their own characters.

    Account 1 (Alpha): chars 1001 (corp 2001), 1002 (corp 2001)
    Account 2 (Bravo): char 2002 (corp 3001)
    """
    db_session.add_all([
        User(id=1, display_name="Alpha"),
        User(id=2, display_name="Bravo"),
    ])
    await db_session.flush()
    db_session.add_all([
        Character(character_id=1001, character_name="AlphaMain",
                  corporation_id=2001, user_id=1, is_active=True),
        Character(character_id=1002, character_name="AlphaAlt",
                  corporation_id=2001, user_id=1, is_active=True),
        Character(character_id=2002, character_name="BravoMain",
                  corporation_id=3001, user_id=2, is_active=True),
    ])
    await db_session.commit()
    return db_session
