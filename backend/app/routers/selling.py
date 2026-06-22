"""Selling Tool Router – match personal inventory against market prices (Phase 4D)."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.asset import Asset
from app.models.cached_price import CachedPrice
from app.routers.auth import require_account, assert_owns_character

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/selling", tags=["selling"])


@router.get("/items")
async def api_selling_items(
    character_id: int = Query(..., description="Character ID to check assets for"),
    markdown: float = Query(10.0, description="Markdown percentage from market price"),
    min_sell_price: Optional[float] = Query(None, description="Minimum sell price filter"),
    category_filter: Optional[str] = Query(None, description="Category filter (e.g. minerals, ships, modules)"),
    sort_by: str = Query("total_value", description="Sort field: total_value, quantity, price"),
    sort_dir: str = Query("desc", description="Sort direction: asc or desc"),
    limit: int = Query(200, description="Max results"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get personal assets grouped by type_id with market prices for selling decisions.

    For each item type in the character's personal hangar:
    - Total quantity across all locations
    - Current market sell/buy prices from price cache
    - Proposed sell price = min_sell * (1 - markdown/100)
    - Total estimated value at proposed price
    """
    if markdown < 0 or markdown > 100:
        raise HTTPException(status_code=400, detail="Markdown must be between 0 and 100")

    # Security: only the account that owns this character may see its assets.
    await assert_owns_character(db, user_id, character_id)

    # Query personal assets grouped by type_id
    asset_stmt = (
        select(
            Asset.type_id,
            Asset.type_name,
            Asset.group_name,
            Asset.category_name,
            func.sum(Asset.quantity).label("total_quantity"),
            func.count(Asset.id).label("stack_count"),
        )
        .where(
            and_(
                Asset.character_id == character_id,
                Asset.is_corp_asset == False,
            )
        )
        .group_by(Asset.type_id, Asset.type_name, Asset.group_name, Asset.category_name)
    )

    # Apply category filter if specified
    if category_filter:
        if category_filter == "minerals":
            asset_stmt = asset_stmt.where(Asset.is_material == True)
        elif category_filter == "ships":
            asset_stmt = asset_stmt.where(Asset.is_ship == True)
        elif category_filter == "modules":
            asset_stmt = asset_stmt.where(Asset.is_module == True)
        elif category_filter == "drones":
            asset_stmt = asset_stmt.where(Asset.is_drone == True)
        elif category_filter == "charges":
            asset_stmt = asset_stmt.where(Asset.is_charge == True)
        elif category_filter == "implants":
            asset_stmt = asset_stmt.where(Asset.is_implant == True)

    asset_result = await db.execute(asset_stmt)
    asset_rows = asset_result.fetchall()

    if not asset_rows:
        return {
            "total": 0,
            "items": [],
            "summary": {
                "total_items": 0,
                "total_value": 0,
                "total_sell_value": 0,
                "total_buy_value": 0,
            },
        }

    # Get type_ids for price lookup
    type_ids = [row.type_id for row in asset_rows]

    # Batch lookup prices
    price_stmt = select(CachedPrice).where(CachedPrice.type_id.in_(type_ids))
    price_result = await db.execute(price_stmt)
    price_rows = price_result.scalars().all()
    price_map = {p.type_id: p for p in price_rows}

    # Build results
    markdown_factor = 1.0 - (markdown / 100.0)
    items = []

    for row in asset_rows:
        price = price_map.get(row.type_id)
        if not price:
            continue  # Skip items without market prices

        min_sell = price.sell_price_min
        max_buy = price.buy_price_max
        avg_price = price.average_price

        # Proposed sell price with markdown
        proposed_price = (min_sell * markdown_factor) if min_sell else None
        proposed_total = (proposed_price * row.total_quantity) if proposed_price else None

        # Value at current market rates
        sell_total = (min_sell * row.total_quantity) if min_sell else None
        buy_total = (max_buy * row.total_quantity) if max_buy else None

        item = {
            "type_id": row.type_id,
            "type_name": row.type_name or f"Type {row.type_id}",
            "group_name": row.group_name,
            "category_name": row.category_name,
            "quantity": row.total_quantity,
            "stacks": row.stack_count,
            "min_sell": min_sell,
            "max_buy": max_buy,
            "average_price": avg_price,
            "proposed_price": round(proposed_price, 2) if proposed_price else None,
            "proposed_total": round(proposed_total, 2) if proposed_total else None,
            "sell_total": round(sell_total, 2) if sell_total else None,
            "buy_total": round(buy_total, 2) if buy_total else None,
            "spread": (
                round(min_sell - max_buy, 2)
                if min_sell and max_buy
                else None
            ),
        }

        # Apply min_sell_price filter
        if min_sell_price is not None and (min_sell is None or min_sell < min_sell_price):
            continue

        items.append(item)

    # Sort
    reverse = sort_dir.lower() != "asc"
    if sort_by == "quantity":
        items.sort(key=lambda x: x["quantity"], reverse=reverse)
    elif sort_by == "price" or sort_by == "proposed_price":
        items.sort(key=lambda x: x["proposed_price"] or 0, reverse=reverse)
    elif sort_by == "sell_total" or sort_by == "total_value":
        items.sort(key=lambda x: x["proposed_total"] or 0, reverse=reverse)
    elif sort_by == "min_sell":
        items.sort(key=lambda x: x["min_sell"] or 0, reverse=reverse)
    elif sort_by == "spread":
        items.sort(key=lambda x: x["spread"] or 0, reverse=reverse)

    # Limit
    items = items[:limit]

    # Compute summary
    total_value = sum(i["proposed_total"] or 0 for i in items)
    total_sell_value = sum(i["sell_total"] or 0 for i in items)
    total_buy_value = sum(i["buy_total"] or 0 for i in items)

    return {
        "total": len(items),
        "items": items,
        "summary": {
            "total_items": len(items),
            "total_value": round(total_value, 2),
            "total_sell_value": round(total_sell_value, 2),
            "total_buy_value": round(total_buy_value, 2),
            "markdown_pct": markdown,
        },
    }
