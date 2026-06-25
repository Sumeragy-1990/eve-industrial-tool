"""EVE SSO OAuth2 authentication routes + per-user account model.

Security model (migration 011): every Character belongs to a User (account).
A session carries both `user_id` (the account) and `character_id` (the active
character). Data routers must enforce ownership via `require_account` +
`assert_owns_character` / `assert_owns_corporation` so a session can only ever
touch its own account's data.
"""

import time
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse, JSONResponse
from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_session
from app.models.character import Character
from app.models.user import User
from app.services.esi_client import ESIClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# ── Session helpers ─────────────────────────────────────────────


def _session_user_id(request: Request) -> Optional[int]:
    return request.session.get("user_id")


def _session_char_id(request: Request) -> Optional[int]:
    return request.session.get("character_id")


# ── Auth dependencies ───────────────────────────────────────────


async def require_auth(request: Request) -> int:
    """Gate: enforce that the request is authenticated.

    Returns the ACTIVE character_id (backwards-compatible: some routers use the
    returned value as a character_id). Use `require_account` when you need the
    owning account id for ownership checks.
    """
    char_id = request.session.get("character_id")
    user_id = request.session.get("user_id")
    if not char_id or not user_id:
        if request.url.path.startswith("/api/"):
            raise HTTPException(status_code=401, detail="Authentication required")
        raise HTTPException(status_code=302, headers={"Location": "/login"})
    return char_id


async def require_account(request: Request) -> int:
    """Gate: enforce authentication and return the session's user_id (account)."""
    user_id = request.session.get("user_id")
    if not user_id:
        if request.url.path.startswith("/api/"):
            raise HTTPException(status_code=401, detail="Authentication required")
        raise HTTPException(status_code=302, headers={"Location": "/login"})
    return user_id


async def get_owned_character_ids(db: AsyncSession, user_id: int) -> list[int]:
    """Return the character_ids owned by this account (active only)."""
    stmt = select(Character.character_id).where(
        Character.user_id == user_id,
        Character.is_active == True,
    )
    result = await db.execute(stmt)
    return [row[0] for row in result.all()]


async def assert_owns_character(db: AsyncSession, user_id: int, character_id: int) -> None:
    """Raise 403 unless `character_id` belongs to this account."""
    stmt = select(Character.id).where(
        Character.character_id == character_id,
        Character.user_id == user_id,
    )
    result = await db.execute(stmt)
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=403, detail="You do not have access to this character")


async def assert_owns_corporation(db: AsyncSession, user_id: int, corporation_id: int) -> None:
    """Raise 403 unless this account owns at least one character in that corp.

    Uses limit(1)+first() (not scalar_one_or_none): an account may own SEVERAL
    characters in the same corporation, which would otherwise raise
    MultipleResultsFound. We only care whether *any* matching character exists.
    """
    stmt = (
        select(Character.id)
        .where(
            Character.corporation_id == corporation_id,
            Character.user_id == user_id,
        )
        .limit(1)
    )
    result = await db.execute(stmt)
    if result.first() is None:
        raise HTTPException(status_code=403, detail="You do not have access to this corporation")


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_session),
) -> Character:
    """Dependency: get the full active Character object from session."""
    char_id = request.session.get("character_id")
    if not char_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    stmt = select(Character).where(
        Character.character_id == char_id,
        Character.is_active == True,
    )
    result = await db.execute(stmt)
    char = result.scalar_one_or_none()
    if not char:
        raise HTTPException(status_code=401, detail="Character not found or deactivated")
    return char


# ── OAuth client ────────────────────────────────────────────────
oauth = OAuth()
oauth.register(
    name="eveonline",
    client_id=settings.eve_client_id,
    client_secret=settings.eve_secret_key,
    authorize_url="https://login.eveonline.com/v2/oauth/authorize",
    authorize_params=None,
    access_token_url="https://login.eveonline.com/v2/oauth/token",
    access_token_params=None,
    client_kwargs={
        "scope": " ".join([
            "esi-assets.read_assets.v1",
            "esi-assets.read_corporation_assets.v1",
            "esi-corporations.read_divisions.v1",
            "esi-characters.read_corporation_roles.v1",
            "esi-characters.read_blueprints.v1",
            "esi-corporations.read_blueprints.v1",
            "esi-industry.read_character_jobs.v1",
            "esi-industry.read_corporation_jobs.v1",
            "esi-corporations.read_corporation_membership.v1",
            "esi-skills.read_skills.v1",
        ]),
    },
)


@router.get("/login")
async def login(request: Request):
    """Redirect to EVE SSO for a normal (fresh) login."""
    # A normal login is never an "add to current account" flow.
    request.session.pop("add_intent", None)
    redirect_uri = settings.eve_callback_url
    return await oauth.eveonline.authorize_redirect(request, redirect_uri)


@router.get("/login/add")
async def login_add(request: Request):
    """Redirect to EVE SSO to ADD a character to the currently logged-in account.

    Only meaningful when already authenticated; otherwise behaves like a normal
    login (the resulting character gets its own fresh account).
    """
    if request.session.get("user_id"):
        request.session["add_intent"] = True
    else:
        request.session.pop("add_intent", None)
    redirect_uri = settings.eve_callback_url
    return await oauth.eveonline.authorize_redirect(request, redirect_uri)


@router.get("/logout")
async def logout(request: Request):
    """Clear session and redirect to login page."""
    request.session.clear()
    return RedirectResponse(url="/login", status_code=302)


@router.get("/me")
async def me(request: Request, db: AsyncSession = Depends(get_session)):
    """Get current authenticated character + account from session."""
    char_id = request.session.get("character_id")
    if not char_id:
        return JSONResponse({"authenticated": False}, status_code=401)
    stmt = select(Character).where(
        Character.character_id == char_id,
        Character.is_active == True,
    )
    result = await db.execute(stmt)
    char = result.scalar_one_or_none()
    if not char:
        request.session.clear()
        return JSONResponse({"authenticated": False}, status_code=401)
    return {
        "authenticated": True,
        "id": char.id,
        "user_id": char.user_id,
        "character_id": char.character_id,
        "character_name": char.character_name,
        "corporation_id": char.corporation_id,
        "corporation_name": char.corporation_name,
        "has_corp_roles": char.has_corp_roles,
    }


@router.get("/callback")
async def callback(request: Request, db: AsyncSession = Depends(get_session)):
    """Handle EVE SSO callback.

    Account rules:
      1. Login without a session -> new account (the character is its Main).
      1.1 Unless the character already belongs to an account -> log into THAT
          account (so the user lands in their own data, never someone else's).
      2. Login while logged in via "Add account" -> attach the character to the
         CURRENT account. If the character already belongs to a DIFFERENT
         account, do NOT silently steal it; defer to an explicit merge.
    """
    add_intent = bool(request.session.pop("add_intent", False))
    current_user_id = request.session.get("user_id")  # may be None

    try:
        token = await oauth.eveonline.authorize_access_token(request)
    except Exception as e:
        err_msg = str(e).replace(" ", "+")
        return RedirectResponse(url=f"/login?error={err_msg}", status_code=302)

    access_token = token.get("access_token")
    refresh_token = token.get("refresh_token")
    expires_in = token.get("expires_in", 1200)

    if not access_token:
        return RedirectResponse(url="/login?error=No+access+token+received", status_code=302)

    # Verify the token and get character info
    async with httpx.AsyncClient() as client:
        verify_resp = await client.get(
            "https://login.eveonline.com/oauth/verify",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if verify_resp.is_error:
            return RedirectResponse(
                url="/login?error=Token+verification+failed",
                status_code=302,
            )
        char_info = verify_resp.json()

    character_id = char_info["CharacterID"]
    character_name = char_info["CharacterName"]
    granted_scopes = char_info.get("Scopes", "")
    owner_hash = char_info.get("CharacterOwnerHash")

    # Fetch public character info
    corp_id = None
    corp_name = None
    async with httpx.AsyncClient() as client:
        char_resp = await client.get(
            f"https://esi.evetech.net/latest/characters/{character_id}/"
        )
        if char_resp.is_success:
            char_data = char_resp.json()
            corp_id = char_data.get("corporation_id")
            corp_resp = await client.get(
                f"https://esi.evetech.net/latest/corporations/{corp_id}/"
            )
            if corp_resp.is_success:
                corp_name = corp_resp.json().get("name")

    # Look up existing character
    stmt = select(Character).where(Character.character_id == character_id)
    result = await db.execute(stmt)
    character = result.scalar_one_or_none()

    expires_at = datetime.fromtimestamp(time.time() + expires_in, tz=timezone.utc)

    if character:
        existing_owner = character.user_id

        # ── Merge conflict: char belongs to a DIFFERENT account ──
        if (
            existing_owner is not None
            and add_intent
            and current_user_id
            and existing_owner != current_user_id
        ):
            # Refresh the character's tokens (we just authenticated as it) but do
            # NOT change ownership. Stash a pending merge for explicit confirmation.
            character.character_name = character_name
            character.corporation_id = corp_id
            character.corporation_name = corp_name
            character.access_token = access_token
            character.refresh_token = refresh_token or character.refresh_token
            character.token_expires_at = expires_at
            character.scopes = granted_scopes
            character.owner_hash = owner_hash
            character.is_active = True
            await db.commit()
            request.session["merge_conflict"] = {
                "character_id": character_id,
                "character_name": character_name,
                "from_user": existing_owner,
                "to_user": current_user_id,
            }
            # Land on the account dashboard, which hosts the merge-confirmation UI.
            return RedirectResponse(url="/?merge_conflict=1", status_code=302)

        # Determine the target account
        if existing_owner is not None:
            # Regel 1.1 (login) or same-account add: land in the char's account.
            target_user_id = existing_owner
        elif add_intent and current_user_id:
            # Orphan char (pre-migration) explicitly added to current account.
            target_user_id = current_user_id
        else:
            # Orphan char logging in fresh -> give it its own account.
            new_user = User()
            db.add(new_user)
            await db.flush()
            target_user_id = new_user.id

        character.user_id = target_user_id
        character.character_name = character_name
        character.corporation_id = corp_id
        character.corporation_name = corp_name
        character.access_token = access_token
        character.refresh_token = refresh_token or character.refresh_token
        character.token_expires_at = expires_at
        character.scopes = granted_scopes
        character.owner_hash = owner_hash
        character.is_active = True
    else:
        # Brand-new character
        if add_intent and current_user_id:
            target_user_id = current_user_id
        else:
            new_user = User()
            db.add(new_user)
            await db.flush()
            target_user_id = new_user.id

        character = Character(
            character_id=character_id,
            character_name=character_name,
            corporation_id=corp_id,
            corporation_name=corp_name,
            access_token=access_token,
            refresh_token=refresh_token,
            token_expires_at=expires_at,
            scopes=granted_scopes,
            owner_hash=owner_hash,
            is_active=True,
            user_id=target_user_id,
        )
        db.add(character)

    await db.commit()
    await db.refresh(character)

    # ── Check corporation roles (Director, etc.) ─────────────
    try:
        esi = ESIClient(db)
        roles = await esi.get_character_roles(character)
        await esi.close()

        director_roles = [
            r for r in roles
            if r.get("role", "").lower() in ("director", "senior_officer", "junior_officer", "personnel_manager")
        ]
        if director_roles:
            character.has_corp_roles = True
            logger.info(
                f"{character.character_name} has corp roles: "
                f"{[r['role'] for r in director_roles]}"
            )
        await db.commit()
    except Exception as e:
        logger.warning(f"Could not check corp roles for {character_name}: {e}")

    # Set session: account + active character
    request.session["user_id"] = target_user_id
    request.session["character_id"] = character_id
    request.session["character_name"] = character_name

    return RedirectResponse(url="/blueprints", status_code=302)


@router.get("/characters")
async def list_characters(
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """List the characters of the CURRENT account only."""
    stmt = (
        select(Character)
        .where(Character.user_id == user_id, Character.is_active == True)
        .order_by(Character.character_name)
    )
    result = await db.execute(stmt)
    chars = result.scalars().all()
    return [
        {
            "id": c.id,
            "character_id": c.character_id,
            "character_name": c.character_name,
            "corporation_id": c.corporation_id,
            "corporation_name": c.corporation_name,
            "has_corp_roles": c.has_corp_roles,
            "assets_last_synced": c.assets_last_synced.isoformat()
                if c.assets_last_synced else None,
            "scopes": c.scopes.split() if c.scopes else [],
        }
        for c in chars
    ]


@router.get("/merge/pending")
async def merge_pending(
    request: Request,
    user_id: int = Depends(require_account),
):
    """Return details of a pending merge conflict for the current account."""
    conflict = request.session.get("merge_conflict")
    if not conflict or conflict.get("to_user") != user_id:
        return {"pending": False}
    return {
        "pending": True,
        "character_id": conflict["character_id"],
        "character_name": conflict["character_name"],
    }


@router.post("/merge")
async def merge_accounts(
    request: Request,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Confirm a pending merge: move the other account's characters into this one.

    Only valid right after a `merge_conflict` was recorded for THIS account in the
    callback (i.e. the user re-authenticated as a character of the other account,
    proving control). Merges the two accounts and deletes the now-empty source.
    """
    conflict = request.session.get("merge_conflict")
    if not conflict or conflict.get("to_user") != user_id:
        raise HTTPException(status_code=400, detail="No pending merge for this account")

    from_user = conflict["from_user"]
    if from_user == user_id:
        request.session.pop("merge_conflict", None)
        return {"message": "Nothing to merge"}

    # Move all characters of the source account into the current account.
    await db.execute(
        update(Character).where(Character.user_id == from_user).values(user_id=user_id)
    )
    # Remove the now-empty source account.
    await db.execute(delete(User).where(User.id == from_user))
    await db.commit()

    request.session.pop("merge_conflict", None)
    return {"message": "Accounts merged"}


@router.post("/merge/cancel")
async def merge_cancel(
    request: Request,
    user_id: int = Depends(require_account),
):
    """Discard a pending merge conflict."""
    request.session.pop("merge_conflict", None)
    return {"message": "Merge cancelled"}


@router.post("/characters/{character_id}/refresh")
async def refresh_character(
    character_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Force refresh a character's tokens (re-login). Must own the character."""
    await assert_owns_character(db, user_id, character_id)
    stmt = select(Character).where(Character.character_id == character_id)
    result = await db.execute(stmt)
    character = result.scalar_one_or_none()
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")
    character.access_token = None
    character.refresh_token = None
    character.token_expires_at = None
    await db.commit()
    return {"message": "Token cleared. Please re-login."}


@router.delete("/characters/{character_id}")
async def remove_character(
    request: Request,
    character_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Remove a character from the CURRENT account. Must own the character.

    Soft-delete (plan §8.3): the character is deactivated and its OAuth tokens
    are cleared (so no unused refresh token lingers). History/references are
    preserved. A later SSO re-login reactivates the character into its account.
    """
    await assert_owns_character(db, user_id, character_id)
    stmt = select(Character).where(Character.character_id == character_id)
    result = await db.execute(stmt)
    character = result.scalar_one_or_none()
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    character.is_active = False
    character.access_token = None
    character.refresh_token = None
    character.token_expires_at = None
    await db.commit()

    # If this was the active character of the session, drop it so the UI does
    # not keep pointing at a removed character.
    if request.session.get("character_id") == character_id:
        remaining = await get_owned_character_ids(db, user_id)
        if remaining:
            request.session["character_id"] = remaining[0]
        else:
            request.session.pop("character_id", None)
            request.session.pop("character_name", None)

    return {"message": f"Character {character_id} removed"}


@router.delete("/account")
async def delete_account(
    request: Request,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Delete the CURRENT account (self-service).

    Removes the whole account the session belongs to: every owned character is
    deactivated, its tokens cleared, and detached from the account (user_id =
    NULL) so the foreign key no longer references the user row, which is then
    deleted. Finally the session is cleared. A subsequent SSO login of any of
    these characters creates a brand-new, separate account (see callback rules).
    """
    # Orphan + deactivate + clear tokens for all of this account's characters
    # BEFORE deleting the user row (characters.user_id FK references users.id).
    await db.execute(
        update(Character)
        .where(Character.user_id == user_id)
        .values(
            is_active=False,
            user_id=None,
            access_token=None,
            refresh_token=None,
            token_expires_at=None,
        )
    )
    await db.execute(delete(User).where(User.id == user_id))
    await db.commit()

    request.session.clear()
    return {"message": "Account deleted"}
