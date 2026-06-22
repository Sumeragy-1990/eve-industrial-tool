"""Asset query and sync endpoints."""

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.asset import Asset
from app.models.character import Character
from app.routers.auth import (
    require_account,
    assert_owns_character,
    assert_owns_corporation,
    get_owned_character_ids,
)
from app.services.asset_sync import sync_character_assets, sync_corporation_assets

logger = logging.getLogger(__name__)

# In-memory sync status tracker
_sync_status = {}

# Category filter mapping: URL param -> Asset column
CATEGORY_FILTER_MAP = {
    "ship": Asset.is_ship,
    "module": Asset.is_module,
    "charge": Asset.is_charge,
    "drone": Asset.is_drone,
    "implant": Asset.is_implant,
    "structure": Asset.is_structure,
    "material": Asset.is_material,
    "blueprint": Asset.is_blueprint,
}

router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.get("/")
async def get_assets(
    character_id: Optional[int] = Query(None, description="Filter by character (single)"),
    character_ids: Optional[str] = Query(None, description="Comma-separated character IDs for multi-select"),
    corporation_id: Optional[int] = Query(None, description="Filter by corporation"),
    is_corp: bool = Query(False, description="Show corp assets"),
    location_id: Optional[int] = Query(None, description="Filter by location"),
    type_id: Optional[int] = Query(None, description="Filter by item type"),
    search: Optional[str] = Query(None, description="Search by item name"),
    category: Optional[str] = Query(None, description="Filter by category (ship, module, etc.)"),
    division_id: Optional[int] = Query(None, description="Filter by hangar division"),
    page: int = Query(1, ge=1),
    per_page: int = Query(100, ge=1, le=500),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Query assets with filters and pagination (scoped to the current account)."""
    # Base query
    base = select(Asset)

    # Characters owned by this account – the hard security boundary.
    owned_ids = await get_owned_character_ids(db, user_id)
    if not owned_ids:
        # No characters -> nothing visible.
        return {"total": 0, "page": page, "per_page": per_page, "pages": 1, "assets": []}

    if is_corp:
        base = base.where(Asset.is_corp_asset == True)
        if corporation_id:
            await assert_owns_corporation(db, user_id, corporation_id)
            base = base.where(Asset.corporation_id == corporation_id)
        else:
            # Restrict to corporations the account actually has characters in.
            owned_corp_ids = [
                cid for (cid,) in (
                    await db.execute(
                        select(Character.corporation_id).where(
                            Character.user_id == user_id,
                            Character.corporation_id.isnot(None),
                        )
                    )
                ).all()
            ]
            if not owned_corp_ids:
                return {"total": 0, "page": page, "per_page": per_page, "pages": 1, "assets": []}
            base = base.where(Asset.corporation_id.in_(owned_corp_ids))
    else:
        base = base.where(Asset.is_corp_asset == False)
        if character_ids:
            # Multi-select: comma-separated character IDs (must all be owned).
            ids = [int(cid.strip()) for cid in character_ids.split(",") if cid.strip()]
            for cid in ids:
                await assert_owns_character(db, user_id, cid)
            base = base.where(Asset.character_id.in_(ids or [0]))
        elif character_id:
            await assert_owns_character(db, user_id, character_id)
            base = base.where(Asset.character_id == character_id)
        else:
            # No explicit selection -> only this account's characters (never global).
            base = base.where(Asset.character_id.in_(owned_ids))

    if location_id:
        base = base.where(Asset.location_id == location_id)
    if type_id:
        base = base.where(Asset.type_id == type_id)
    if division_id is not None:
        base = base.where(Asset.division_id == division_id)
    if search:
        base = base.where(Asset.type_name.ilike(f"%{search}%"))

    # Category filter using Asset's own denormalized fields
    if category:
        col = CATEGORY_FILTER_MAP.get(category)
        if col is not None:
            base = base.where(col == True)

    # Count total
    count_query = select(func.count()).select_from(base.subquery())
    total = await db.scalar(count_query) or 0

    # Fetch page
    offset = (page - 1) * per_page
    query = base.order_by(Asset.type_name).offset(offset).limit(per_page)
    result = await db.execute(query)
    assets = result.scalars().all()

    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": max(1, (total + per_page - 1) // per_page),
        "assets": [
            {
                "id": a.id,
                "type_id": a.type_id,
                "type_name": a.type_name,
                "quantity": a.quantity,
                # ── Location info ─────────────────────
                "location_id": a.location_id,
                "location_name": a.location_name,
                "location_category": a.location_category,
                "location_flag": a.location_flag,
                # ── Division / Corp ────────────────────
                "division_id": a.division_id,
                "division_name": a.division_name,
                "is_corp_asset": a.is_corp_asset,
                "character_id": a.character_id,
                "corporation_id": a.corporation_id,
                # ── Type classification ────────────────
                "category_id": a.category_id,
                "category_name": a.category_name,
                "group_id": a.group_id,
                "group_name": a.group_name,
                "meta_group_id": a.meta_group_id,
                "meta_group_name": a.meta_group_name,
                # ── Flags ─────────────────────────────
                "is_blueprint": a.is_blueprint,
                "is_blueprint_copy": a.is_blueprint_copy,
                "blueprint_runs": a.blueprint_runs,
                "is_ship": a.is_ship,
                "is_module": a.is_module,
                "is_charge": a.is_charge,
                "is_drone": a.is_drone,
                "is_implant": a.is_implant,
                "is_structure": a.is_structure,
                "is_material": a.is_material,
                # ── Physical ──────────────────────────
                "volume": a.volume,
                # ── Sync ──────────────────────────────
                "synced_at": a.synced_at.isoformat() if a.synced_at else None,
            }
            for a in assets
        ],
    }


@router.get("/locations")
async def get_locations(
    character_id: Optional[int] = Query(None),
    corporation_id: Optional[int] = Query(None, description="Corp filter (used when is_corp=true)"),
    is_corp: bool = Query(False),
    db: AsyncSession = Depends(get_session),
):
    """Get distinct locations for filter dropdown."""
    base = select(
        Asset.location_id,
        Asset.location_name,
        func.count(Asset.id).label("item_count"),
    ).where(
        Asset.location_id.isnot(None),
        Asset.location_name.isnot(None),
    )

    if is_corp:
        base = base.where(Asset.is_corp_asset == True)
        corp_filter = corporation_id or character_id
        if corp_filter:
            base = base.where(Asset.corporation_id == corp_filter)
    else:
        base = base.where(Asset.is_corp_asset == False)
        if character_id:
            base = base.where(Asset.character_id == character_id)

    base = base.group_by(Asset.location_id, Asset.location_name).order_by(
        Asset.location_name
    )
    result = await db.execute(base)
    locations = result.all()

    return [
        {"id": loc[0], "name": loc[1], "item_count": loc[2]}
        for loc in locations
    ]


@router.get("/divisions")
async def get_divisions(
    corporation_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_session),
):
    """Get distinct hangar divisions."""
    base = select(
        Asset.division_id,
        Asset.division_name,
        func.count(Asset.id).label("item_count"),
    ).where(
        Asset.division_id.isnot(None),
        Asset.is_corp_asset == True,
    )
    if corporation_id:
        base = base.where(Asset.corporation_id == corporation_id)

    base = base.group_by(Asset.division_id, Asset.division_name).order_by(
        Asset.division_id
    )
    result = await db.execute(base)
    divisions = result.all()

    return [
        {"id": d[0], "name": d[1], "item_count": d[2]}
        for d in divisions
    ]


@router.get("/categories")
async def get_categories(db: AsyncSession = Depends(get_session)):
    """Get distinct item categories from stored assets."""
    base = select(
        Asset.category_name,
        Asset.category_id,
        func.count(Asset.id).label("item_count"),
    ).where(
        Asset.category_id.isnot(None)
    ).group_by(
        Asset.category_name, Asset.category_id
    ).order_by(Asset.category_name)

    result = await db.execute(base)
    cats = result.all()

    return [
        {"id": c[1], "name": c[0], "item_count": c[2]}
        for c in cats if c[0]
    ]


@router.get("/summary")
async def get_summary(
    character_id: Optional[int] = Query(None),
    is_corp: bool = Query(False),
    db: AsyncSession = Depends(get_session),
):
    """Get asset summary stats."""
    base = select(
        Asset.type_id,
        Asset.type_name,
        func.sum(Asset.quantity).label("total_qty"),
    )

    if is_corp:
        base = base.where(Asset.is_corp_asset == True)
    else:
        base = base.where(Asset.is_corp_asset == False)
        if character_id:
            base = base.where(Asset.character_id == character_id)

    base = base.group_by(Asset.type_id, Asset.type_name).order_by(
        func.sum(Asset.quantity).desc()
    ).limit(50)

    result = await db.execute(base)
    items = result.all()

    return [
        {"type_id": i[0], "type_name": i[1], "total_quantity": int(i[2])}
        for i in items
    ]


# ── Sync Endpoints ─────────────────────────────────────────────


async def _run_sync_background(
    character_id: int,
    sync_corp: bool,
):
    """Run asset sync in background and update status."""
    _sync_status[character_id] = {
        "status": "running",
        "progress": "Starting sync...",
    }
    try:
        from app.database import async_session_factory
        from app.models.character import Character
        from sqlalchemy import select

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

            _sync_status[character_id]["progress"] = "Syncing personal assets..."
            char_result = await sync_character_assets(db, character)
            results = [char_result]

            if sync_corp and character.corporation_id:
                _sync_status[character_id]["progress"] = "Syncing corporation assets..."
                try:
                    corp_result = await sync_corporation_assets(
                        db, character, character.corporation_id
                    )
                    results.append(corp_result)
                except Exception as e:
                    logger.warning(f"Corp sync failed: {e}")
                    results.append({
                        "error": str(e),
                        "corporation_id": character.corporation_id,
                    })

            _sync_status[character_id] = {
                "status": "completed",
                "progress": "Sync complete",
                "results": results,
            }
    except Exception as e:
        logger.error(f"Background sync failed: {e}")
        _sync_status[character_id] = {
            "status": "error",
            "progress": str(e),
        }


@router.post("/sync/{character_id}")
async def trigger_sync(
    character_id: int,
    background_tasks: BackgroundTasks,
    sync_corp: bool = Query(False, description="Also sync corporation assets"),
    db: AsyncSession = Depends(get_session),
):
    """Trigger an asset sync for a character (runs in background)."""
    stmt = select(Character).where(Character.character_id == character_id)
    result = await db.execute(stmt)
    character = result.scalar_one_or_none()

    if not character:
        raise HTTPException(status_code=404, detail="Character not found")
    if not character.access_token:
        raise HTTPException(status_code=400, detail="Character has no valid token")

    # Start sync in background
    background_tasks.add_task(
        _run_sync_background, character_id, sync_corp
    )

    return {
        "status": "started",
        "message": f"Asset sync started for {character.character_name}",
    }


@router.get("/sync/{character_id}/status")
async def get_sync_status(character_id: int):
    """Get the status of a running or completed sync."""
    status = _sync_status.get(character_id, {
        "status": "unknown",
        "progress": "No sync found for this character",
    })
    return status
