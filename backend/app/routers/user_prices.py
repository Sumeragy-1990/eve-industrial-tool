"""User Price Overrides Router – manual prices, purchase history, weighted average."""

import logging
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.user_item_price import UserItemPrice
from app.routers.auth import require_account, assert_owns_character

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/user/prices", tags=["user_prices"])


# ── Request Models ────────────────────────────────────────────────

class OverridePriceRequest(BaseModel):
    type_id: int
    override_price: Optional[float] = None
    price_source: str = "override"


class PurchaseRecordRequest(BaseModel):
    type_id: int
    quantity: int
    unit_price: float


class BatchPriceResponse(BaseModel):
    type_id: int
    override_price: Optional[float] = None
    weighted_average_price: Optional[float] = None
    price_source: Optional[str] = "jita"
    last_purchase_price: Optional[float] = None
    cumulative_qty: Optional[int] = 0


# ── Endpoints ─────────────────────────────────────────────────────


@router.get("/batch")
async def get_user_prices_batch(
    type_ids: str = Query(..., description="Comma-separated list of type IDs"),
    character_id: int = Query(0, description="Character ID (0 = global)"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get user-defined prices for a batch of type IDs."""
    if character_id != 0:
        await assert_owns_character(db, user_id, character_id)
    try:
        ids = [int(t.strip()) for t in type_ids.split(",") if t.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid type_ids")

    if not ids:
        return {"prices": {}}

    stmt = select(UserItemPrice).where(
        UserItemPrice.type_id.in_(ids),
        UserItemPrice.character_id == character_id,
    )
    result = await db.execute(stmt)
    rows = {r.type_id: r for r in result.scalars().all()}

    prices = {}
    for tid in ids:
        row = rows.get(tid)
        prices[str(tid)] = {
            "type_id": tid,
            "override_price": row.override_price if row else None,
            "weighted_average_price": row.weighted_average_price if row else None,
            "price_source": row.price_source if row else "jita",
            "last_purchase_price": row.last_purchase_price if row else None,
            "last_purchase_qty": row.last_purchase_qty if row else None,
            "cumulative_qty": row.cumulative_qty if row else 0,
            "has_override": row is not None and row.override_price is not None,
        }

    return {"prices": prices}


@router.put("/override")
async def set_override_price(
    body: OverridePriceRequest,
    character_id: int = Query(0, description="Character ID (0 = global)"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Set a manual override price for an item type."""
    if character_id != 0:
        await assert_owns_character(db, user_id, character_id)
    stmt = select(UserItemPrice).where(
        UserItemPrice.type_id == body.type_id,
        UserItemPrice.character_id == character_id,
    )
    result = await db.execute(stmt)
    row = result.scalars().first()

    if row:
        if body.override_price is not None:
            row.override_price = body.override_price
        if body.price_source:
            row.price_source = body.price_source
        row.updated_at = datetime.now(timezone.utc)
    else:
        row = UserItemPrice(
            character_id=character_id,
            type_id=body.type_id,
            override_price=body.override_price,
            price_source=body.price_source or "override",
            updated_at=datetime.now(timezone.utc),
        )
        db.add(row)

    await db.flush()
    return {"status": "ok", "type_id": body.type_id, "override_price": body.override_price}


@router.delete("/override/{type_id}")
async def remove_override_price(
    type_id: int,
    character_id: int = Query(0, description="Character ID (0 = global)"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Remove a manual override price (revert to Jita pricing)."""
    if character_id != 0:
        await assert_owns_character(db, user_id, character_id)
    stmt = select(UserItemPrice).where(
        UserItemPrice.type_id == type_id,
        UserItemPrice.character_id == character_id,
    )
    result = await db.execute(stmt)
    row = result.scalars().first()

    if row:
        row.override_price = None
        row.price_source = "jita"
        row.updated_at = datetime.now(timezone.utc)
        await db.flush()

    return {"status": "ok", "type_id": type_id, "override_price": None}


@router.post("/purchase")
async def record_purchase(
    body: PurchaseRecordRequest,
    character_id: int = Query(0, description="Character ID (0 = global)"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Record a purchase to update the weighted average price."""
    if character_id != 0:
        await assert_owns_character(db, user_id, character_id)
    stmt = select(UserItemPrice).where(
        UserItemPrice.type_id == body.type_id,
        UserItemPrice.character_id == character_id,
    )
    result = await db.execute(stmt)
    row = result.scalars().first()

    now = datetime.now(timezone.utc)

    if row:
        row.last_purchase_price = body.unit_price
        row.last_purchase_qty = body.quantity
        row.last_purchase_at = now
        row.cumulative_qty = (row.cumulative_qty or 0) + body.quantity
        row.cumulative_cost = (row.cumulative_cost or 0.0) + (body.quantity * body.unit_price)
        row.weighted_average_price = row.cumulative_cost / max(row.cumulative_qty, 1)
        row.updated_at = now
    else:
        row = UserItemPrice(
            character_id=character_id,
            type_id=body.type_id,
            last_purchase_price=body.unit_price,
            last_purchase_qty=body.quantity,
            last_purchase_at=now,
            cumulative_qty=body.quantity,
            cumulative_cost=body.quantity * body.unit_price,
            weighted_average_price=body.unit_price,
            price_source="weighted",
            updated_at=now,
        )
        db.add(row)

    await db.flush()
    return {
        "status": "ok",
        "type_id": body.type_id,
        "weighted_average_price": row.weighted_average_price,
        "cumulative_qty": row.cumulative_qty,
    }


@router.get("/all")
async def get_all_user_prices(
    character_id: int = Query(0, description="Character ID (0 = global)"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get all user price records."""
    if character_id != 0:
        await assert_owns_character(db, user_id, character_id)
    stmt = select(UserItemPrice).where(
        UserItemPrice.character_id == character_id,
    )
    result = await db.execute(stmt)
    rows = result.scalars().all()

    return {
        "total": len(rows),
        "prices": [
            {
                "type_id": r.type_id,
                "override_price": r.override_price,
                "weighted_average_price": r.weighted_average_price,
                "price_source": r.price_source,
                "last_purchase_price": r.last_purchase_price,
                "last_purchase_qty": r.last_purchase_qty,
                "cumulative_qty": r.cumulative_qty,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ],
    }
