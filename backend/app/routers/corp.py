"""Corporation endpoints – member tracking, hangar overview, restock tools."""

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.character import Character
from app.models.corp_member import CorpMember
from app.routers.auth import require_account, assert_owns_character, assert_owns_corporation
from app.services.corp_member_sync import sync_corp_members


async def _owned_corp_ids(db: AsyncSession, user_id: int) -> list[int]:
    rows = await db.execute(
        select(Character.corporation_id).where(
            Character.user_id == user_id,
            Character.corporation_id.isnot(None),
        )
    )
    return [cid for (cid,) in rows.all()]

logger = logging.getLogger(__name__)

# In-memory sync status tracker
_sync_status = {}

router = APIRouter(prefix="/api/corp", tags=["corporation"])


# ── Member List ────────────────────────────────────────────────


@router.get("/members")
async def get_members(
    corporation_id: Optional[int] = Query(None, description="Filter by corporation"),
    is_online: Optional[bool] = Query(None, description="Filter by online status"),
    search: Optional[str] = Query(None, description="Search by character name"),
    page: int = Query(1, ge=1),
    per_page: int = Query(100, ge=1, le=500),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Query corporation members (only corps the account has characters in)."""
    base = select(CorpMember)

    if corporation_id:
        await assert_owns_corporation(db, user_id, corporation_id)
        base = base.where(CorpMember.corporation_id == corporation_id)
    else:
        owned_corps = await _owned_corp_ids(db, user_id)
        base = base.where(CorpMember.corporation_id.in_(owned_corps or [0]))
    if is_online is not None:
        base = base.where(CorpMember.is_online == is_online)
    if search:
        base = base.where(CorpMember.character_name.ilike(f"%{search}%"))

    # Count total
    count_query = select(func.count()).select_from(base.subquery())
    total = await db.scalar(count_query) or 0

    # Fetch page
    offset = (page - 1) * per_page
    query = base.order_by(CorpMember.character_name).offset(offset).limit(per_page)
    result = await db.execute(query)
    members = result.scalars().all()

    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": max(1, (total + per_page - 1) // per_page),
        "members": [
            {
                "character_id": m.character_id,
                "character_name": m.character_name,
                "corporation_id": m.corporation_id,
                "location_id": m.location_id,
                "location_name": m.location_name,
                "ship_type_id": m.ship_type_id,
                "ship_name": m.ship_name,
                "is_online": m.is_online,
                "last_login": m.last_login.isoformat() if m.last_login else None,
                "last_logout": m.last_logout.isoformat() if m.last_logout else None,
                "logins_since_start": m.logins_since_start,
                "synced_at": m.synced_at.isoformat() if m.synced_at else None,
            }
            for m in members
        ],
    }


@router.get("/members/stats")
async def get_member_stats(
    corporation_id: Optional[int] = Query(None),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get corporation member statistics (only owned corps)."""
    base = select(CorpMember)
    if corporation_id:
        await assert_owns_corporation(db, user_id, corporation_id)
        base = base.where(CorpMember.corporation_id == corporation_id)
    else:
        owned_corps = await _owned_corp_ids(db, user_id)
        base = base.where(CorpMember.corporation_id.in_(owned_corps or [0]))

    result = await db.execute(base)
    members = result.scalars().all()

    total = len(members)
    online = sum(1 for m in members if m.is_online)
    offline = total - online

    return {
        "total": total,
        "online": online,
        "offline": offline,
    }


# ── Sync ────────────────────────────────────────────────────────


async def _run_member_sync_background(
    character_id: int,
    corporation_id: int,
):
    """Run corp member sync in background and update status."""
    _sync_status[character_id] = {
        "status": "running",
        "progress": "Starting member sync...",
    }
    try:
        from app.database import async_session_factory

        async with async_session_factory() as db:
            stmt = select(Character).where(Character.character_id == character_id)
            result = await db.execute(stmt)
            character = result.scalar_one_or_none()

            if not character:
                _sync_status[character_id] = {
                    "status": "error",
                    "progress": "Character not found",
                }
                return

            _sync_status[character_id]["progress"] = "Fetching corp members..."
            sync_result = await sync_corp_members(db, character, corporation_id)

            _sync_status[character_id] = {
                "status": "completed",
                "progress": "Member sync complete",
                "results": sync_result,
            }
    except Exception as e:
        logger.error(f"Background member sync failed: {e}")
        _sync_status[character_id] = {
            "status": "error",
            "progress": str(e),
        }


@router.post("/members/sync")
async def trigger_member_sync(
    character_id: int = Query(..., description="Character ID with Director role"),
    corporation_id: int = Query(..., description="Corporation ID to sync"),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Trigger a corp member sync (runs in background)."""
    await assert_owns_character(db, user_id, character_id)
    await assert_owns_corporation(db, user_id, corporation_id)
    stmt = select(Character).where(Character.character_id == character_id)
    result = await db.execute(stmt)
    character = result.scalar_one_or_none()

    if not character:
        raise HTTPException(status_code=404, detail="Character not found")
    if not character.access_token:
        raise HTTPException(status_code=400, detail="Character has no valid token")

    # Start sync in background
    background_tasks.add_task(
        _run_member_sync_background, character_id, corporation_id
    )

    return {
        "status": "started",
        "message": f"Member sync started for {character.character_name}",
    }


@router.get("/members/sync/{character_id}/status")
async def get_member_sync_status(character_id: int):
    """Get the status of a running or completed member sync."""
    status = _sync_status.get(character_id, {
        "status": "unknown",
        "progress": "No sync found for this character",
    })
    return status
