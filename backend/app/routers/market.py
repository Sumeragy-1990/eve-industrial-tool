"""Market Price Router – endpoints for cached market prices (Phase 4B) and market orders (Phase 4A)."""

import asyncio
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


# Module-level flag for background refresh status
_refresh_lock = asyncio.Lock()
_refresh_running = False


@router.get("/refresh/status")
async def api_refresh_status():
    """Check whether a background price refresh is currently running."""
    global _refresh_running
    return {"running": _refresh_running}


@router.post("/refresh")
async def api_refresh_prices():
    """Trigger a full refresh of cached prices from ESI market data (async, background).

    The actual ESI fetching runs as a background asyncio task so the HTTP request
    returns immediately (202 Accepted). This avoids HTTP 504 Gateway Timeout errors
    caused by the refresh taking >60s when fetching all pages across 4 regions.
    """
    global _refresh_running
    if _refresh_running:
        return {"status": "already_running", "message": "Price refresh is already running"}
    _refresh_running = True
    asyncio.create_task(_background_price_refresh())
    return {
        "status": "accepted",
        "message": "Price refresh started in background",
    }


async def _background_price_refresh():
    """Run price refresh in its own DB session (non-blocking)."""
    global _refresh_running
    from app.database import async_session_factory

    try:
        async with async_session_factory() as db:
            stats = await refresh_all_prices(db)
            logger.info(
                "Background price refresh done: %d updated, %d errors",
                stats.get("updated", 0),
                stats.get("errors", 0),
            )
    except Exception as exc:
        logger.warning("Background price refresh failed (non-fatal): %s", exc)
    finally:
        _refresh_running = False


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
            "message": f"Synced {stats.get('synced', 0)} orders, {stats.get('errors', 0)} errors",
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Market order sync failed: {e}")


@router.get("/orders/search")
async def api_search_market_orders(
    q: str = Query(..., min_length=2, description="Search query for type name"),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_session),
):
    """Search for types by name and return their market order summary."""
    try:
        results = await search_market_orders_by_name(db, q, limit)
        return {
            "status": "ok",
            "results": results,
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Market order search failed: {e}")


@router.get("/orders/{type_id}")
async def api_get_market_orders(
    type_id: int,
    region_id: Optional[int] = None,
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_session),
):
    """Get individual market orders for a specific type."""
    try:
        orders = await get_market_orders(db, type_id, region_id, limit)
        return {
            "status": "ok",
            "orders": orders,
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Fetching market orders failed: {e}")


@router.get("/orderbook/{type_id}")
async def api_get_order_book(
    type_id: int,
    region_id: int = Query(default=10000002, description="Region ID (default: The Forge/Jita)"),
    db: AsyncSession = Depends(get_session),
):
    """Get the order book (top buy + top sell orders) for a type in a region."""
    try:
        book = await get_order_book(db, type_id, region_id)
        return {
            "status": "ok",
            "orderbook": book,
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Fetching order book failed: {e}")


@router.get("/status")
async def api_market_status(
    db: AsyncSession = Depends(get_session),
):
    """Get current market price cache status."""
    from sqlalchemy import func, select

    result = await db.execute(
        select(
            func.count(CachedPrice.type_id).label("total"),
            func.count(CachedPrice.sell_price_min).label("with_sell"),
            func.count(CachedPrice.buy_price_max).label("with_buy"),
        )
    )
    row = result.one()
    return {
        "total_cached": row.total,
        "with_sell_prices": row.with_sell,
        "with_buy_prices": row.with_buy,
    }


@router.get("/regions")
async def api_get_regions():
    return {
        "regions": [
            {"id": rid, "name": REGION_NAMES.get(rid, f"Unknown ({rid})")}
            for rid in KEY_REGIONS
        ],
    }
