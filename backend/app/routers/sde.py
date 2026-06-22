"""SDE update endpoint + item search – the "Update Button" mechanism."""

import asyncio
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.sde_item import SDEItem
from app.services.sde_importer import import_sde

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sde", tags=["sde"])

# Track import progress / status
_import_status = {
    "running": False,
    "last_run": None,
    "stats": None,
    "error": None,
}


@router.get("/status")
async def get_sde_status():
    """Get SDE import status."""
    return {
        **(_import_status),
        "last_run": _import_status["last_run"].isoformat()
            if _import_status["last_run"] else None,
    }


@router.post("/update")
async def trigger_sde_update(db: AsyncSession = Depends(get_session)):
    """Trigger a full SDE re-import (download + parse + store)."""
    if _import_status["running"]:
        raise HTTPException(status_code=409, detail="SDE import already running")

    _import_status["running"] = True
    _import_status["error"] = None

    try:
        logger.info("SDE update triggered via API")

        def progress(count):
            logger.info(f"SDE import progress: {count} items processed")

        stats = await import_sde(
            db_session=db,
            progress_callback=progress,
        )

        _import_status["last_run"] = datetime.now()
        _import_status["stats"] = stats
        _import_status["error"] = None

        return {
            "message": "SDE import completed",
            "stats": stats,
        }
    except Exception as e:
        logger.error(f"SDE import failed: {e}")
        _import_status["error"] = str(e)
        raise HTTPException(status_code=500, detail=f"SDE import failed: {e}")
    finally:
        _import_status["running"] = False


@router.get("/items/search")
async def search_items(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(20, ge=1, le=100, description="Max results"),
    db: AsyncSession = Depends(get_session),
):
    """Search SDE items by name (case-insensitive)."""
    stmt = (
        select(SDEItem)
        .where(SDEItem.name.ilike(f"%{q}%"))
        .order_by(SDEItem.name)
        .limit(limit)
    )
    result = await db.execute(stmt)
    items = result.scalars().all()

    return {
        "query": q,
        "total": len(items),
        "items": [
            {
                "type_id": item.type_id,
                "name": item.name,
                "group_name": item.group_name,
                "category_name": item.category_name,
            }
            for item in items
        ],
    }


@router.get("/items/browse")
async def browse_items(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(50, ge=1, le=200, description="Items per page"),
    category: Optional[str] = Query(None, description="Category name filter"),
    group: Optional[str] = Query(None, description="Group name filter (partial match)"),
    search: Optional[str] = Query(None, description="Search by name (partial match)"),
    sort_by: str = Query("name", description="Sort field: name, type_id, volume, mass"),
    sort_dir: str = Query("asc", description="Sort direction: asc or desc"),
    db: AsyncSession = Depends(get_session),
):
    """Browse all SDE items with pagination, filters, and details."""
    query = select(SDEItem)

    # Apply filters
    if category:
        query = query.where(SDEItem.category_name.ilike(f"%{category}%"))
    if group:
        query = query.where(SDEItem.group_name.ilike(f"%{group}%"))
    if search:
        query = query.where(SDEItem.name.ilike(f"%{search}%"))

    # Count total
    count_stmt = select(func.count()).select_from(query.subquery())
    count_result = await db.execute(count_stmt)
    total = count_result.scalar() or 0

    # Apply sorting
    sort_col = getattr(SDEItem, sort_by, SDEItem.name)
    if sort_dir.lower() == "desc":
        sort_col = sort_col.desc()
    query = query.order_by(sort_col)

    # Paginate
    query = query.offset((page - 1) * per_page).limit(per_page)

    result = await db.execute(query)
    items = result.scalars().all()

    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": (total + per_page - 1) // per_page,
        "items": [
            {
                "type_id": item.type_id,
                "name": item.name,
                "group_name": item.group_name,
                "category_name": item.category_name,
                "volume": item.volume,
                "mass": item.mass,
                "capacity": item.capacity,
                "tech_level": item.tech_level,
                "meta_group_name": item.meta_group_name,
                "is_blueprint": item.is_blueprint,
                "is_ship": item.is_ship,
                "is_module": item.is_module,
                "is_charge": item.is_charge,
                "is_drone": item.is_drone,
                "is_implant": item.is_implant,
                "is_material": item.is_material,
                "is_structure": item.is_structure,
            }
            for item in items
        ],
    }
