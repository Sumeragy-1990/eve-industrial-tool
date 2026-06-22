"""BPC Cost API – store/query what a BPC cost the user (Phase 3C Invention Page)."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.bpc_cost import UserBPCCost
from app.routers.auth import require_auth

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bpc-costs", tags=["bpc-costs"])


# ── Request Models ──────────────────────────────────────────────────

class BPCCostSaveRequest(BaseModel):
    bp_type_id: int
    product_type_id: int
    product_name: Optional[str] = None
    cost_source: str = "invention"  # invention | purchase | contract | loot | manual
    total_cost: float = 0.0
    runs: int = 1
    me: int = 0
    te: int = 0
    source_bp_type_id: Optional[int] = None
    decryptor_type_id: Optional[int] = None
    decryptor_name: Optional[str] = None
    invention_attempts: Optional[int] = None
    invention_probability: Optional[float] = None


# ── Endpoints ───────────────────────────────────────────────────────

@router.post("/")
async def save_bpc_cost(
    body: BPCCostSaveRequest,
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """Save or update a BPC cost entry for the current user."""
    cost_per_run = body.total_cost / max(body.runs, 1)

    stmt = select(UserBPCCost).where(
        and_(
            UserBPCCost.character_id == _user,
            UserBPCCost.bp_type_id == body.bp_type_id,
            UserBPCCost.product_type_id == body.product_type_id,
        )
    )
    result = await db.execute(stmt)
    existing = result.scalars().first()

    if existing:
        existing.total_cost = body.total_cost
        existing.runs = body.runs
        existing.cost_per_run = round(cost_per_run, 2)
        existing.me = body.me
        existing.te = body.te
        existing.cost_source = body.cost_source
        existing.source_bp_type_id = body.source_bp_type_id
        existing.decryptor_type_id = body.decryptor_type_id
        existing.decryptor_name = body.decryptor_name
        existing.invention_attempts = body.invention_attempts
        existing.invention_probability = body.invention_probability
        if body.product_name:
            existing.product_name = body.product_name
    else:
        entry = UserBPCCost(
            character_id=_user,
            bp_type_id=body.bp_type_id,
            product_type_id=body.product_type_id,
            product_name=body.product_name,
            cost_source=body.cost_source,
            total_cost=body.total_cost,
            runs=body.runs,
            cost_per_run=round(cost_per_run, 2),
            me=body.me,
            te=body.te,
            source_bp_type_id=body.source_bp_type_id,
            decryptor_type_id=body.decryptor_type_id,
            decryptor_name=body.decryptor_name,
            invention_attempts=body.invention_attempts,
            invention_probability=body.invention_probability,
        )
        db.add(entry)

    await db.commit()
    return {"status": "ok", "cost_per_run": round(cost_per_run, 2)}


@router.get("/")
async def get_bpc_costs(
    bp_type_id: Optional[int] = Query(None, description="Filter by blueprint type"),
    product_type_id: Optional[int] = Query(None, description="Filter by product type"),
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """Get all BPC cost entries for the current user, optionally filtered."""
    stmt = select(UserBPCCost).where(UserBPCCost.character_id == _user)

    if bp_type_id is not None:
        stmt = stmt.where(UserBPCCost.bp_type_id == bp_type_id)
    if product_type_id is not None:
        stmt = stmt.where(UserBPCCost.product_type_id == product_type_id)

    stmt = stmt.order_by(UserBPCCost.created_at.desc())
    result = await db.execute(stmt)
    entries = result.scalars().all()

    return {
        "entries": [
            {
                "id": e.id,
                "bp_type_id": e.bp_type_id,
                "product_type_id": e.product_type_id,
                "product_name": e.product_name,
                "cost_source": e.cost_source,
                "total_cost": e.total_cost,
                "runs": e.runs,
                "cost_per_run": e.cost_per_run,
                "me": e.me,
                "te": e.te,
                "source_bp_type_id": e.source_bp_type_id,
                "decryptor_type_id": e.decryptor_type_id,
                "decryptor_name": e.decryptor_name,
                "invention_attempts": e.invention_attempts,
                "invention_probability": e.invention_probability,
                "created_at": e.created_at.isoformat() if e.created_at else None,
            }
            for e in entries
        ]
    }


@router.delete("/{bp_type_id}/{product_type_id}")
async def delete_bpc_cost(
    bp_type_id: int,
    product_type_id: int,
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """Delete a BPC cost entry."""
    stmt = select(UserBPCCost).where(
        and_(
            UserBPCCost.character_id == _user,
            UserBPCCost.bp_type_id == bp_type_id,
            UserBPCCost.product_type_id == product_type_id,
        )
    )
    result = await db.execute(stmt)
    entry = result.scalars().first()
    if not entry:
        raise HTTPException(status_code=404, detail="BPC cost entry not found")
    await db.delete(entry)
    await db.commit()
    return {"status": "deleted"}
