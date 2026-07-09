"""Rig definitions — serve Engineering Complex rig data from DB."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_session
from app.models.rig import Rig

router = APIRouter(prefix="/api", tags=["rigs"])


@router.get("/rigs")
async def get_rigs(
    size: str = Query(None, regex="^(M|L|XL)?$"),
    db: AsyncSession = Depends(get_session),
):
    """Get all rigs, optionally filtered by structure size (M/L/XL)."""
    stmt = select(Rig).order_by(Rig.size, Rig.category, Rig.affects, Rig.tier)
    if size:
        stmt = stmt.where(Rig.size == size)
    result = await db.execute(stmt)
    rigs = result.scalars().all()
    return [r.to_dict() for r in rigs]
