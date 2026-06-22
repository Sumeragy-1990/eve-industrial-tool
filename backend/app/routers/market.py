"""Market Price Router – endpoints for cached market prices (Phase 4B) and market orders (Phase 4A)."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.cached_price import CachedPrice
from app.services.market_service import (
    refresh_all_prices,
    get_price,
    get_prices_batch,
    sync_market_orders,
    get_market_orders,
    search_market_orders_by_name,
    get_order_book,
    KEY_REGIONS,
    REGION_NAMES,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/market", tags=["market"])


@router.get("/prices/{type_id}")
async def api_get_price(
    type_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Get cached price for a single type."""
    price = await get_price(db, type_id)
    if not price:
        raise HTTPException(status_code=404, detail=f"Type {type_id} not found in price cache")
    return {
        "type_id": price.type_id,
        "type_name": price.type_name,
        "average_price": price.average_price,
        "adjusted_price": price.adjusted_price,
        "sell_price_min": price.sell_price_min,
        "buy_price_max": price.buy_price_max,
        "volume": price.volume,
        "updated_at": price.updated_at.isoformat() if price.updated_at else None,
    }


@router.get("/prices")
async def api_get_prices_batch(
    type_ids: str = Query(..., description="Comma-separated list of type IDs"),
    db: AsyncSession = Depends(get_session),
):
    """Get cached prices for multiple types (batch lookup)."""
    try:
        ids = [int(t.strip()) for t in type_ids.split(",") if t.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid type_ids parameter; expected comma-separated integers")

    if not ids:
        raise HTTPException(status_code=400, detail="No valid type_ids provided")

    prices = await get_prices_batch(db, ids)
    return {
        "total": len(prices),
        "prices": {
            str(tid): {
                "type_id": p.type_id,
                "type_name": p.type_name,
                "average_price": p.average_price,
                "adjusted_price": p.adjusted_price,
                "sell_price_min": p.sell_price_min,
                "buy_price_max": p.buy_price_max,
                "volume": p.volume,
                "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            }
            for tid, p in prices.items()
        },
    }


@router.post("/refresh")
async def api_refresh_prices(
    db: AsyncSession = Depends(get_session),
):
    """Trigger a full refresh of cached prices from ESI market data."""
    try:
        stats = await refresh_all_prices(db)
        return {
            "status": "ok",
            "stats": stats,
            "message": f"Fetched {stats['fetched']} orders, updated {stats['updated']} prices ({stats['errors']} errors)",
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Price refresh failed: {e}")


# ═══════════════════════════════════════════════════════════════
# Phase 4A: Market Order Sync Endpoints
# ═══════════════════════════════════════════════════════════════


@router.post("/orders/sync")
async def api_sync_market_orders(
    db: AsyncSession = Depends(get_session),
):
    """Trigger a full sync of market orders (all pages, buy+sell) from all key regions."""
    try:
        stats = await sync_market_orders(db)
        return {
            "status": "ok",
            "stats": stats,
            "message": (
                f"Synced {stats['regions_fetched']} regions, "
                f"stored {stats['orders_stored']} orders, "
                f"updated {stats['prices_updated']} prices "
                f"({stats['errors']} errors)"
            ),
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Market order sync failed: {e}")


@router.get("/orders/search")
async def api_search_market_orders(
    q: str = Query(..., description="Search query for type name"),
    region_id: Optional[int] = Query(None, description="Filter by region ID"),
    is_buy_order: Optional[bool] = Query(None, description="Filter by buy/sell"),
    limit: int = Query(50, description="Max results"),
    db: AsyncSession = Depends(get_session),
):
    """Search for types by name and return their market order summary."""
    try:
        results = await search_market_orders_by_name(
            db, query=q, region_id=region_id,
            is_buy_order=is_buy_order, limit=limit,
        )
        return {"total": len(results), "results": results}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Search failed: {e}")


@router.get("/orders/{type_id}")
async def api_get_market_orders(
    type_id: int,
    region_id: Optional[int] = Query(None, description="Filter by region ID"),
    is_buy_order: Optional[bool] = Query(None, description="Filter by buy/sell"),
    limit: int = Query(100, description="Max orders to return"),
    db: AsyncSession = Depends(get_session),
):
    """Get individual market orders for a specific type."""
    try:
        orders = await get_market_orders(
            db, type_id=type_id, region_id=region_id,
            is_buy_order=is_buy_order, limit=limit,
        )
        return {
            "total": len(orders),
            "orders": [
                {
                    "order_id": o.order_id,
                    "type_id": o.type_id,
                    "is_buy_order": o.is_buy_order,
                    "price": o.price,
                    "volume_remaining": o.volume_remaining,
                    "volume_total": o.volume_total,
                    "location_id": o.location_id,
                    "system_id": o.system_id,
                    "region_id": o.region_id,
                    "range": o.range,
                    "duration": o.duration,
                    "issued": o.issued.isoformat() if o.issued else None,
                }
                for o in orders
            ],
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch orders: {e}")


@router.get("/orderbook/{type_id}")
async def api_get_order_book(
    type_id: int,
    region_id: int = Query(10000002, description="Region ID (default: The Forge/Jita)"),
    limit: int = Query(50, description="Max orders per side"),
    db: AsyncSession = Depends(get_session),
):
    """Get the order book (top buy + top sell orders) for a type in a region."""
    try:
        book = await get_order_book(db, type_id=type_id, region_id=region_id, limit=limit)
        return book
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch order book: {e}")


@router.get("/regions")
async def api_get_regions():
    """Return the list of tracked market regions."""
    return {
        "regions": [
            {"id": rid, "name": REGION_NAMES.get(rid, f"Region {rid}")}
            for rid in KEY_REGIONS
        ]
    }
