"""Security regression tests: cross-account data isolation.

Mirrors the incident that triggered the fix: a second EVE player who logged in
must NOT be able to see another account's characters/data. These tests assert
the primitives that every data router relies on:

  * assert_owns_character / assert_owns_corporation -> 403 on foreign access
  * get_owned_character_ids -> disjoint per account, excludes deactivated chars
  * GET /auth/characters -> returns ONLY the session account's characters
"""

import pytest
from fastapi import FastAPI, HTTPException
from httpx import AsyncClient, ASGITransport
from sqlalchemy import update

from app.database import get_session
from app.models.character import Character
from app.routers import auth as auth_module
from app.routers.auth import (
    assert_owns_character,
    assert_owns_corporation,
    get_owned_character_ids,
    require_account,
)


# ── Helper-level ownership checks ────────────────────────────────

async def test_owns_own_character_passes(two_accounts):
    # Account 1 owns char 1001 -> no exception.
    await assert_owns_character(two_accounts, user_id=1, character_id=1001)


async def test_owns_foreign_character_forbidden(two_accounts):
    # Account 1 must NOT reach account 2's char 2002.
    with pytest.raises(HTTPException) as exc:
        await assert_owns_character(two_accounts, user_id=1, character_id=2002)
    assert exc.value.status_code == 403


async def test_owns_own_corporation_passes(two_accounts):
    await assert_owns_corporation(two_accounts, user_id=1, corporation_id=2001)


async def test_owns_foreign_corporation_forbidden(two_accounts):
    with pytest.raises(HTTPException) as exc:
        await assert_owns_corporation(two_accounts, user_id=1, corporation_id=3001)
    assert exc.value.status_code == 403


async def test_owned_character_ids_are_disjoint(two_accounts):
    ids_a = set(await get_owned_character_ids(two_accounts, user_id=1))
    ids_b = set(await get_owned_character_ids(two_accounts, user_id=2))
    assert ids_a == {1001, 1002}
    assert ids_b == {2002}
    assert ids_a.isdisjoint(ids_b)


async def test_deactivated_character_drops_out(two_accounts):
    # The incident remediation deactivates the foreign char (Variante A).
    # A deactivated character must no longer appear in the owned list.
    await two_accounts.execute(
        update(Character).where(Character.character_id == 1002).values(is_active=False)
    )
    await two_accounts.commit()
    ids_a = set(await get_owned_character_ids(two_accounts, user_id=1))
    assert ids_a == {1001}


# ── API-level: GET /auth/characters only returns own chars ───────

async def test_characters_endpoint_returns_only_own(two_accounts):
    app = FastAPI()
    app.include_router(auth_module.router)

    async def _override_session():
        yield two_accounts

    # Simulate a logged-in session for account 1.
    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[require_account] = lambda: 1

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/auth/characters")

    assert resp.status_code == 200
    names = {c["character_name"] for c in resp.json()}
    # Only account 1's characters – account 2's "BravoMain" must NOT leak.
    assert names == {"AlphaMain", "AlphaAlt"}
    assert "BravoMain" not in names
