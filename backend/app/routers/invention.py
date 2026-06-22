"""Invention routes – T2 invention cost/profit calculator (Phase 3C)."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.sde_item import SDEItem
from app.models.cached_price import CachedPrice
from app.services.invention_service import (
    invent_calculate,
    DECRYPTORS,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/invention", tags=["invention"])


# ── Blueprint Search (T1 blueprints only) ─────────────────────────


@router.get("/blueprints/search")
async def search_invention_blueprints(
    q: str = Query(..., min_length=1, description="Search query for T1 blueprint name"),
    limit: int = Query(20, ge=1, le=100, description="Max results"),
    db: AsyncSession = Depends(get_session),
):
    """Search T1 blueprints by name from SDE data (for invention calculator)."""
    stmt = (
        select(SDEItem)
        .where(
            SDEItem.is_blueprint == True,  # noqa: E712
            SDEItem.name.ilike(f"%{q}%"),
        )
        .order_by(SDEItem.name)
        .limit(limit)
    )
    result = await db.execute(stmt)
    items = result.scalars().all()

    return {
        "query": q,
        "total": len(items),
        "blueprints": [
            {
                "type_id": item.type_id,
                "name": item.name,
                "group_name": item.group_name,
                "category_name": item.category_name,
            }
            for item in items
        ],
    }


# ── Decryptors ────────────────────────────────────────────────────


@router.get("/decryptors")
async def get_decryptors(
    db: AsyncSession = Depends(get_session),
):
    """Return all decryptor definitions with current market prices."""
    result = []
    for d in DECRYPTORS:
        price = None
        stmt = select(CachedPrice).where(CachedPrice.type_id == d["type_id"])
        r = await db.execute(stmt)
        cp = r.scalars().first()
        if cp:
            price = cp.sell_price_min or cp.average_price or cp.adjusted_price
        result.append({
            "type_id": d["type_id"],
            "name": d["name"],
            "prob": d["prob"],
            "runs": d["runs"],
            "me": d["me"],
            "te": d["te"],
            "price": round(price, 2) if price else None,
        })
    return {"decryptors": result}


# ── Calculate Invention ───────────────────────────────────────────


@router.get("/calculate")
async def calculate_invention(
    t1_blueprint_type_id: int = Query(..., description="T1 blueprint type ID"),
    skill_encryption: int = Query(5, ge=0, le=5, description="Encryption skill level"),
    skill_datacore_1: int = Query(5, ge=0, le=5, description="First datacore skill level"),
    skill_datacore_2: int = Query(5, ge=0, le=5, description="Second datacore skill level"),
    decryptor_type_id: Optional[int] = Query(None, description="Decryptor type ID (optional)"),
    system_cost_index: float = Query(0.01, ge=0, le=1.0, description="System cost index (0.00-1.00)"),
    runs: int = Query(1, ge=1, le=100, description="Number of invention attempts"),
    db: AsyncSession = Depends(get_session),
):
    """Calculate invention cost, probability, and profit for a T1 blueprint."""
    try:
        result = await invent_calculate(
            db=db,
            t1_blueprint_type_id=t1_blueprint_type_id,
            skill_encryption=skill_encryption,
            skill_datacore_1=skill_datacore_1,
            skill_datacore_2=skill_datacore_2,
            decryptor_type_id=decryptor_type_id,
            system_cost_index=system_cost_index,
            runs=runs,
        )
        if "error" in result:
            raise HTTPException(status_code=404, detail=result["error"])
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Invention calculation failed")
        raise HTTPException(status_code=500, detail=str(e))
