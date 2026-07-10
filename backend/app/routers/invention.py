"""Invention routes – T2 invention cost/profit calculator (Phase 3C)."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
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


# ── Blueprint Search (T1 + T2 reverse lookup) ────────────────────


@router.get("/blueprints/search")
async def search_invention_blueprints(
    q: str = Query(..., min_length=1, description="Search query for T1 blueprint or T2 item name"),
    limit: int = Query(20, ge=1, le=100, description="Max results"),
    db: AsyncSession = Depends(get_session),
):
    """Search T1 blueprints by name. If no T1 found, resolves T2 item → T1 blueprint.

    This allows users to search for e.g. 'Wolf' and get the Rifter Blueprint
    as the T1 source for invention.
    """
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

    blueprints = [
        {
            "type_id": item.type_id,
            "name": item.name,
            "group_name": item.group_name,
            "category_name": item.category_name,
            "t2_resolved": False,
        }
        for item in items
    ]

    # Always also try T2 item → T1 blueprint reverse lookup
    # (runs regardless of direct results, so "Wolf" finds Rifter even though Wolf BP exists)
    sql = text("""
        SELECT DISTINCT inv.type_id, t1.name, t1.group_name, t1.category_name,
               t2.name AS t2_item_name
        FROM sde_items t2
        JOIN sde_blueprint_products mfg
            ON mfg.product_type_id = t2.type_id AND mfg.activity_id = 1
        JOIN sde_blueprint_products inv
            ON inv.product_type_id = mfg.type_id AND inv.activity_id = 8
        JOIN sde_items t1 ON t1.type_id = inv.type_id
        WHERE t2.name ILIKE :q
        LIMIT :limit
    """)
    rows = await db.execute(sql, {"q": f"%{q}%", "limit": limit})
    for row in rows:
        # Avoid duplicates (if T1 BP was already found by name)
        already = any(b["type_id"] == row.type_id for b in blueprints)
        if not already:
            blueprints.append({
                "type_id": row.type_id,
                "name": row.name,
                "group_name": row.group_name,
                "category_name": row.category_name,
                "t2_resolved": True,
                "t2_item_name": row.t2_item_name,
            })

    return {
        "query": q,
        "total": len(blueprints),
        "blueprints": blueprints,
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
