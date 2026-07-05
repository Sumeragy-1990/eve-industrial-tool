"""Market Price Service – fetches and caches market prices from ESI.

Phase 4B: Price Cache Service (existing)
- Fetches market prices from ESI public endpoints
- Stores min sell / max buy per type_id
- Provides lookup for build cost + restock calculations

Phase 4A: Market Order Sync (enhancement)
- Fetches ALL pages for both buy and sell orders
- Stores individual orders in MarketOrder table
- Updates CachedPrice aggregated data from full order data
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy import select, delete, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cached_price import CachedPrice
from app.models.market_order import MarketOrder
from app.models.sde_item import SDEItem
from app.services.esi_client import ESIClient

logger = logging.getLogger(__name__)

# Cache TTL
PRICE_CACHE_HOURS = 1  # Refresh every hour

# Key regions for market data
REGION_THE_FORGE = 10000002  # Jita
REGION_HEIMATAR = 10000030   # Rens
REGION_DOMAIN = 10000043     # Amarr
REGION_SINQ_LAISON = 10000032  # Dodixie

KEY_REGIONS = [REGION_THE_FORGE, REGION_HEIMATAR, REGION_DOMAIN, REGION_SINQ_LAISON]

REGION_NAMES = {
    10000002: "The Forge (Jita)",
    10000030: "Heimatar (Rens)",
    10000043: "Domain (Amarr)",
    10000032: "Sinq Laison (Dodixie)",
}


async def refresh_all_prices(db: AsyncSession) -> dict:
    """Fetch prices from ESI markets endpoint and update cache.

    Fetches ALL pages (not just page 1) for each key region, ensuring
    that items like Jita prices are fully populated. Previously only
    page=1 was fetched, which missed large portions of the market.
    Now also fetches BUY orders so buy_price_max is populated.
    """
    client = ESIClient(db)
    stats = {"fetched": 0, "updated": 0, "errors": 0}

    try:
        for region_id in KEY_REGIONS:
            try:
                # ── Sell orders: lowest sell price ──
                sell_orders = await _fetch_all_pages(client, region_id, "sell")
                stats["fetched"] += len(sell_orders)

                min_sell = {}
                for order in sell_orders:
                    tid = order.get("type_id")
                    price = order.get("price", 0)
                    if tid not in min_sell or price < min_sell[tid]:
                        min_sell[tid] = price

                for type_id, price in min_sell.items():
                    await _upsert_price(db, type_id, sell_price_min=price)
                    stats["updated"] += 1

                # ── Buy orders: highest buy price ──
                buy_orders = await _fetch_all_pages(client, region_id, "buy")
                stats["fetched"] += len(buy_orders)

                max_buy = {}
                for order in buy_orders:
                    tid = order.get("type_id")
                    price = order.get("price", 0)
                    if tid not in max_buy or price > max_buy[tid]:
                        max_buy[tid] = price

                for type_id, price in max_buy.items():
                    await _upsert_price(db, type_id, buy_price_max=price)
                    stats["updated"] += 1

                logger.info(
                    f"Region {region_id}: {len(min_sell)} sell / {len(max_buy)} buy prices "
                    f"cached from {len(sell_orders) + len(buy_orders)} orders"
                )

            except Exception as e:
                logger.warning(f"Error fetching region {region_id}: {e}")
                stats["errors"] += 1

        await db.commit()
    finally:
        await client.close()

    return stats


async def _upsert_price(
    db: AsyncSession,
    type_id: int,
    sell_price_min: Optional[float] = None,
    buy_price_max: Optional[float] = None,
    average_price: Optional[float] = None,
):
    """Upsert a cached price entry."""
    stmt = select(CachedPrice).where(CachedPrice.type_id == type_id)
    result = await db.execute(stmt)
    existing = result.scalars().first()

    if existing:
        if sell_price_min is not None:
            existing.sell_price_min = sell_price_min
        if buy_price_max is not None:
            existing.buy_price_max = buy_price_max
        if average_price is not None:
            existing.average_price = average_price
        existing.updated_at = datetime.now(timezone.utc)
    else:
        # Get type name from SDE
        name_stmt = select(SDEItem.name).where(SDEItem.type_id == type_id)
        type_name = await db.scalar(name_stmt)

        db.add(CachedPrice(
            type_id=type_id,
            type_name=type_name or f"Unknown ({type_id})",
            sell_price_min=sell_price_min,
            buy_price_max=buy_price_max,
            average_price=average_price,
        ))


async def get_price(db: AsyncSession, type_id: int) -> Optional[CachedPrice]:
    """Get cached price for a type, returns None if not cached."""
    stmt = select(CachedPrice).where(CachedPrice.type_id == type_id)
    result = await db.execute(stmt)
    return result.scalars().first()


async def get_prices_batch(db: AsyncSession, type_ids: list[int]) -> dict[int, CachedPrice]:
    """Get cached prices for multiple types at once."""
    stmt = select(CachedPrice).where(CachedPrice.type_id.in_(type_ids))
    result = await db.execute(stmt)
    prices = result.scalars().all()
    return {p.type_id: p for p in prices}


# ═══════════════════════════════════════════════════════════════
# Phase 4A: Market Order Sync
# ═══════════════════════════════════════════════════════════════


async def sync_market_orders(db: AsyncSession) -> dict:
    """Fetch ALL pages of buy AND sell orders from all key regions.
    
    Stores individual orders in MarketOrder table and updates
    CachedPrice aggregated data.
    """
    client = ESIClient(db)
    stats = {"regions_fetched": 0, "orders_stored": 0, "prices_updated": 0, "errors": 0}

    try:
        for region_id in KEY_REGIONS:
            try:
                region_name = REGION_NAMES.get(region_id, f"Region {region_id}")
                logger.info(f"Syncing orders for {region_name}...")

                # ── Fetch sell orders (all pages) ────────────────
                sell_orders = await _fetch_all_pages(client, region_id, "sell")
                logger.info(f"  {region_name}: {len(sell_orders)} sell orders")

                # ── Fetch buy orders (all pages) ─────────────────
                buy_orders = await _fetch_all_pages(client, region_id, "buy")
                logger.info(f"  {region_name}: {len(buy_orders)} buy orders")

                all_orders = sell_orders + buy_orders
                if not all_orders:
                    logger.info(f"  {region_name}: No orders found, skipping.")
                    continue

                # ── Clear old orders for this region ─────────────
                await db.execute(
                    delete(MarketOrder).where(MarketOrder.region_id == region_id)
                )

                # ── Insert new orders ────────────────────────────
                for order_data in all_orders:
                    db.add(MarketOrder(
                        order_id=order_data["order_id"],
                        type_id=order_data["type_id"],
                        is_buy_order=order_data.get("is_buy_order", False),
                        price=order_data["price"],
                        volume_remaining=order_data.get("volume_remaining", 0),
                        volume_total=order_data.get("volume_total", 0),
                        location_id=order_data.get("location_id", 0),
                        system_id=order_data.get("system_id"),
                        region_id=region_id,
                        range=order_data.get("range"),
                        duration=order_data.get("duration"),
                        issued=(
                            datetime.fromisoformat(order_data["issued"].replace("Z", "+00:00"))
                            if order_data.get("issued") else None
                        ),
                    ))

                stats["orders_stored"] += len(all_orders)
                stats["regions_fetched"] += 1

                # ── Update aggregated CachedPrice from orders ────
                updated = await _update_aggregated_prices(db, region_id)
                stats["prices_updated"] += updated

                await db.commit()
                logger.info(f"  {region_name}: Done ({updated} prices updated)")

            except Exception as e:
                logger.warning(f"Error syncing region {region_id}: {e}", exc_info=True)
                stats["errors"] += 1
                await db.rollback()

    finally:
        await client.close()

    return stats


async def _fetch_all_pages(
    client: ESIClient, region_id: int, order_type: str
) -> list[dict]:
    """Fetch all pages of orders from ESI markets endpoint."""
    all_orders = []
    page = 1

    while True:
        order_type_param = "buy" if order_type == "buy" else "sell"
        try:
            resp = await client._http.get(
                f"https://esi.evetech.net/latest/markets/{region_id}/orders/"
                f"?order_type={order_type_param}&page={page}"
            )
            if resp.is_error:
                logger.warning(
                    f"  Page {page} failed for region {region_id} ({order_type}): {resp.status_code}"
                )
                break

            orders = resp.json()
            if not orders:
                break  # No more data

            all_orders.extend(orders)
            page += 1

        except Exception as e:
            logger.warning(f"  Page {page} error for region {region_id}: {e}")
            break

    return all_orders


async def _update_aggregated_prices(db: AsyncSession, region_id: int) -> int:
    """Update CachedPrice aggregated data from MarketOrder data for a region.
    
    For each type_id that has orders in this region, compute:
    - sell_price_min: lowest sell order price
    - buy_price_max: highest buy order price
    """
    # Get distinct type_ids that have orders in this region
    type_ids_stmt = (
        select(MarketOrder.type_id)
        .where(MarketOrder.region_id == region_id)
        .distinct()
    )
    type_ids_result = await db.execute(type_ids_stmt)
    type_ids = [row[0] for row in type_ids_result.fetchall()]

    if not type_ids:
        return 0

    updated = 0
    for type_id in type_ids:
        # Get min sell price
        sell_stmt = (
            select(MarketOrder.price)
            .where(
                and_(
                    MarketOrder.type_id == type_id,
                    MarketOrder.region_id == region_id,
                    MarketOrder.is_buy_order == False,
                    MarketOrder.volume_remaining > 0,
                )
            )
            .order_by(MarketOrder.price.asc())
            .limit(1)
        )
        min_sell = await db.scalar(sell_stmt)

        # Get max buy price
        buy_stmt = (
            select(MarketOrder.price)
            .where(
                and_(
                    MarketOrder.type_id == type_id,
                    MarketOrder.region_id == region_id,
                    MarketOrder.is_buy_order == True,
                    MarketOrder.volume_remaining > 0,
                )
            )
            .order_by(MarketOrder.price.desc())
            .limit(1)
        )
        max_buy = await db.scalar(buy_stmt)

        # Update CachedPrice
        if min_sell is not None or max_buy is not None:
            await _upsert_price(db, type_id, sell_price_min=min_sell, buy_price_max=max_buy)
            updated += 1

    return updated


async def get_market_orders(
    db: AsyncSession,
    type_id: int,
    region_id: Optional[int] = None,
    is_buy_order: Optional[bool] = None,
    limit: int = 100,
) -> list[MarketOrder]:
    """Get market orders for a specific type, with optional filters."""
    conditions = [MarketOrder.type_id == type_id]

    if region_id is not None:
        conditions.append(MarketOrder.region_id == region_id)
    if is_buy_order is not None:
        conditions.append(MarketOrder.is_buy_order == is_buy_order)

    stmt = (
        select(MarketOrder)
        .where(and_(*conditions))
        .order_by(MarketOrder.price.asc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    return result.scalars().all()


async def search_market_orders_by_name(
    db: AsyncSession,
    query: str,
    region_id: Optional[int] = None,
    is_buy_order: Optional[bool] = None,
    limit: int = 50,
) -> list[dict]:
    """Search for types by name and return their current order summary.
    
    Returns a summary per type_id: min sell, max buy, volume, order count.
    """
    # Search SDE for matching type names
    name_stmt = (
        select(SDEItem.type_id, SDEItem.name)
        .where(SDEItem.name.ilike(f"%{query}%"))
        .order_by(SDEItem.name)
        .limit(limit)
    )
    items_result = await db.execute(name_stmt)
    items = items_result.fetchall()

    if not items:
        return []

    results = []
    for type_id, type_name in items:
        conditions = [MarketOrder.type_id == type_id]
        if region_id is not None:
            conditions.append(MarketOrder.region_id == region_id)

        # Get order count
        count_stmt = select(MarketOrder).where(and_(*conditions))
        count_result = await db.execute(count_stmt)
        orders = count_result.scalars().all()

        if not orders:
            continue

        # Compute aggregates
        sell_prices = [o.price for o in orders if not o.is_buy_order and o.volume_remaining > 0]
        buy_prices = [o.price for o in orders if o.is_buy_order and o.volume_remaining > 0]

        total_volume = sum(o.volume_remaining for o in orders)
        sell_volume = sum(o.volume_remaining for o in orders if not o.is_buy_order)
        buy_volume = sum(o.volume_remaining for o in orders if o.is_buy_order)

        results.append({
            "type_id": type_id,
            "type_name": type_name,
            "sell_count": len(sell_prices),
            "buy_count": len(buy_prices),
            "min_sell": min(sell_prices) if sell_prices else None,
            "max_buy": max(buy_prices) if buy_prices else None,
            "sell_volume": sell_volume,
            "buy_volume": buy_volume,
            "total_volume": total_volume,
            "spread": (
                min(sell_prices) - max(buy_prices)
                if sell_prices and buy_prices
                else None
            ),
        })

    # Sort by total volume desc
    results.sort(key=lambda r: r["total_volume"], reverse=True)
    return results


async def get_order_book(
    db: AsyncSession,
    type_id: int,
    region_id: int = 10000002,
    limit: int = 50,
) -> dict:
    """Get the order book (top buy + top sell orders) for a type in a region."""
    # Top sell orders (cheapest first)
    sell_stmt = (
        select(MarketOrder)
        .where(
            and_(
                MarketOrder.type_id == type_id,
                MarketOrder.region_id == region_id,
                MarketOrder.is_buy_order == False,
                MarketOrder.volume_remaining > 0,
            )
        )
        .order_by(MarketOrder.price.asc())
        .limit(limit)
    )
    sells = (await db.execute(sell_stmt)).scalars().all()

    # Top buy orders (highest first)
    buy_stmt = (
        select(MarketOrder)
        .where(
            and_(
                MarketOrder.type_id == type_id,
                MarketOrder.region_id == region_id,
                MarketOrder.is_buy_order == True,
                MarketOrder.volume_remaining > 0,
            )
        )
        .order_by(MarketOrder.price.desc())
        .limit(limit)
    )
    buys = (await db.execute(buy_stmt)).scalars().all()

    def _serialize(order: MarketOrder) -> dict:
        return {
            "order_id": order.order_id,
            "price": order.price,
            "volume_remaining": order.volume_remaining,
            "volume_total": order.volume_total,
            "location_id": order.location_id,
            "range": order.range,
            "issued": order.issued.isoformat() if order.issued else None,
        }

    return {
        "type_id": type_id,
        "region_id": region_id,
        "sell_orders": [_serialize(o) for o in sells],
        "buy_orders": [_serialize(o) for o in buys],
        "sell_count": len(sells),
        "buy_count": len(buys),
        "best_sell": sells[0].price if sells else None,
        "best_buy": buys[0].price if buys else None,
    }
