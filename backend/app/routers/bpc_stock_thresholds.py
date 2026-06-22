"""BPC Stock Threshold API – per-product minimum BPC run thresholds for stock alerts."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.bpc_stock_threshold import UserBPCStockThreshold
from app.routers.auth import require_auth

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bpc-stock-thresholds", tags=["bpc-stock"])


# ── Request Models ──────────────────────────────────────────────────

class BPCStockThresholdRequest(BaseModel):
    product_type_id: int = Field(0, description="0 = global default, N = per-product override")
    min_runs: int = Field(10, ge=1, description="Minimum total BPC runs before alerting")


# ── Endpoints ───────────────────────────────────────────────────────

@router.get("/")
async def get_thresholds(
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """Get all BPC stock thresholds for the current user."""
    stmt = select(UserBPCStockThreshold).where(
        UserBPCStockThreshold.character_id == _user,
    ).order_by(UserBPCStockThreshold.product_type_id)
    result = await db.execute(stmt)
    entries = result.scalars().all()

    global_default = 10  # fallback
    overrides: dict[int, int] = {}
    for e in entries:
        if e.product_type_id == 0:
            global_default = e.min_runs
        else:
            overrides[e.product_type_id] = e.min_runs

    return {
        "global_default": global_default,
        "overrides": [
            {"product_type_id": e.product_type_id, "min_runs": e.min_runs}
            for e in entries if e.product_type_id != 0
        ],
    }


@router.put("/")
async def upsert_threshold(
    body: BPCStockThresholdRequest,
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """Create or update a BPC stock threshold."""
    stmt = select(UserBPCStockThreshold).where(
        and_(
            UserBPCStockThreshold.character_id == _user,
            UserBPCStockThreshold.product_type_id == body.product_type_id,
        )
    )
    result = await db.execute(stmt)
    existing = result.scalars().first()

    if existing:
        existing.min_runs = body.min_runs
    else:
        entry = UserBPCStockThreshold(
            character_id=_user,
            product_type_id=body.product_type_id,
            min_runs=body.min_runs,
        )
        db.add(entry)

    await db.commit()
    return {
        "status": "ok",
        "product_type_id": body.product_type_id,
        "min_runs": body.min_runs,
    }


@router.post("/batch")
async def batch_upsert_thresholds(
    thresholds: list[BPCStockThresholdRequest],
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """Create or update multiple BPC stock thresholds in one call."""
    for t in thresholds:
        stmt = select(UserBPCStockThreshold).where(
            and_(
                UserBPCStockThreshold.character_id == _user,
                UserBPCStockThreshold.product_type_id == t.product_type_id,
            )
        )
        result = await db.execute(stmt)
        existing = result.scalars().first()
        if existing:
            existing.min_runs = t.min_runs
        else:
            entry = UserBPCStockThreshold(
                character_id=_user,
                product_type_id=t.product_type_id,
                min_runs=t.min_runs,
            )
            db.add(entry)

    await db.commit()
    return {"status": "ok", "count": len(thresholds)}


@router.delete("/{product_type_id}")
async def delete_threshold(
    product_type_id: int,
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """Delete a per-product threshold (returns to global default)."""
    stmt = select(UserBPCStockThreshold).where(
        and_(
            UserBPCStockThreshold.character_id == _user,
            UserBPCStockThreshold.product_type_id == product_type_id,
        )
    )
    result = await db.execute(stmt)
    entry = result.scalars().first()
    if not entry:
        raise HTTPException(status_code=404, detail="Threshold not found")
    await db.delete(entry)
    await db.commit()
    return {"status": "deleted"}
