"""Corp Warehouse Configuration endpoints.

Each warehouse is defined by a station/structure (location_id) plus
a hangar division (division_id). Users can name their warehouses
(e.g. "Mineralien-Lager") and mark one as the primary mineral warehouse
for restock calculations.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.corp_warehouse import CorpWarehouseConfig
from app.models.asset import Asset
from app.models.character import Character
from app.routers.auth import require_account, assert_owns_corporation

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/corp-warehouses", tags=["corp-warehouses"])


async def _owned_corp_ids(db: AsyncSession, user_id: int) -> list[int]:
    """Return distinct corporation IDs the account's characters belong to."""
    result = await db.execute(
        select(Character.corporation_id)
        .where(Character.user_id == user_id, Character.corporation_id.isnot(None))
        .distinct()
    )
    return [row[0] for row in result.all()]


@router.get("/")
async def list_warehouses(
    corporation_id: Optional[int] = Query(None, description="Filter by corporation"),
    include_inactive: bool = Query(False),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """List all warehouse configurations."""
    owned_corps = await _owned_corp_ids(db, user_id)
    stmt = select(CorpWarehouseConfig)
    if corporation_id:
        await assert_owns_corporation(db, user_id, corporation_id)
        stmt = stmt.where(CorpWarehouseConfig.corporation_id == corporation_id)
    else:
        stmt = stmt.where(CorpWarehouseConfig.corporation_id.in_(owned_corps or [0]))
    if not include_inactive:
        stmt = stmt.where(CorpWarehouseConfig.is_active == True)
    stmt = stmt.order_by(CorpWarehouseConfig.warehouse_name)

    result = await db.execute(stmt)
    warehouses = result.scalars().all()

    return [
        {
            "id": w.id,
            "corporation_id": w.corporation_id,
            "location_id": w.location_id,
            "location_name": w.location_name,
            "division_id": w.division_id,
            "division_name": w.division_name,
            "warehouse_name": w.warehouse_name,
            "is_mineral_warehouse": w.is_mineral_warehouse,
            "is_active": w.is_active,
        }
        for w in warehouses
    ]


@router.post("/")
async def create_warehouse(
    corporation_id: int = Query(...),
    location_id: int = Query(..., description="Station/structure ID"),
    division_id: int = Query(..., description="Hangar division number (1-7)"),
    warehouse_name: str = Query(..., description="User-defined warehouse name"),
    is_mineral_warehouse: bool = Query(False),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Create a new warehouse configuration."""
    await assert_owns_corporation(db, user_id, corporation_id)
    # Check for duplicate
    stmt = select(CorpWarehouseConfig).where(
        CorpWarehouseConfig.corporation_id == corporation_id,
        CorpWarehouseConfig.location_id == location_id,
        CorpWarehouseConfig.division_id == division_id,
        CorpWarehouseConfig.is_active == True,
    )
    result = await db.execute(stmt)
    existing = result.scalar_one_or_none()

    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Warehouse already exists: {existing.warehouse_name}",
        )

    # If this is mineral warehouse, unset any existing mineral warehouse for this corp
    if is_mineral_warehouse:
        reset_stmt = select(CorpWarehouseConfig).where(
            CorpWarehouseConfig.corporation_id == corporation_id,
            CorpWarehouseConfig.is_mineral_warehouse == True,
        )
        reset_result = await db.execute(reset_stmt)
        for old in reset_result.scalars().all():
            old.is_mineral_warehouse = False

    # Resolve location and division names from assets
    location_name = await _resolve_location_name(db, location_id)
    division_name = await _resolve_division_name(
        db, corporation_id, location_id, division_id
    )

    warehouse = CorpWarehouseConfig(
        corporation_id=corporation_id,
        location_id=location_id,
        location_name=location_name,
        division_id=division_id,
        division_name=division_name,
        warehouse_name=warehouse_name,
        is_mineral_warehouse=is_mineral_warehouse,
        is_active=True,
    )
    db.add(warehouse)
    await db.commit()
    await db.refresh(warehouse)

    return {
        "message": "Warehouse created",
        "warehouse": {
            "id": warehouse.id,
            "corporation_id": warehouse.corporation_id,
            "location_id": warehouse.location_id,
            "location_name": warehouse.location_name,
            "division_id": warehouse.division_id,
            "division_name": warehouse.division_name,
            "warehouse_name": warehouse.warehouse_name,
            "is_mineral_warehouse": warehouse.is_mineral_warehouse,
        },
    }


@router.put("/{warehouse_id}")
async def update_warehouse(
    warehouse_id: int,
    warehouse_name: Optional[str] = Query(None),
    is_mineral_warehouse: Optional[bool] = Query(None),
    is_active: Optional[bool] = Query(None),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Update a warehouse configuration."""
    stmt = select(CorpWarehouseConfig).where(CorpWarehouseConfig.id == warehouse_id)
    result = await db.execute(stmt)
    warehouse = result.scalar_one_or_none()

    if not warehouse:
        raise HTTPException(status_code=404, detail="Warehouse not found")

    await assert_owns_corporation(db, user_id, warehouse.corporation_id)

    if warehouse_name is not None:
        warehouse.warehouse_name = warehouse_name

    if is_mineral_warehouse is not None:
        # Unset any existing mineral warehouse for this corp
        if is_mineral_warehouse:
            reset_stmt = select(CorpWarehouseConfig).where(
                CorpWarehouseConfig.corporation_id == warehouse.corporation_id,
                CorpWarehouseConfig.is_mineral_warehouse == True,
                CorpWarehouseConfig.id != warehouse_id,
            )
            reset_result = await db.execute(reset_stmt)
            for old in reset_result.scalars().all():
                old.is_mineral_warehouse = False
        warehouse.is_mineral_warehouse = is_mineral_warehouse

    if is_active is not None:
        warehouse.is_active = is_active

    await db.commit()
    await db.refresh(warehouse)
    return {"message": "Warehouse updated"}


@router.delete("/{warehouse_id}")
async def delete_warehouse(
    warehouse_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Delete a warehouse configuration."""
    stmt = select(CorpWarehouseConfig).where(CorpWarehouseConfig.id == warehouse_id)
    result = await db.execute(stmt)
    warehouse = result.scalar_one_or_none()

    if not warehouse:
        raise HTTPException(status_code=404, detail="Warehouse not found")

    await assert_owns_corporation(db, user_id, warehouse.corporation_id)

    await db.delete(warehouse)
    await db.commit()
    return {"message": "Warehouse deleted"}


@router.get("/stock")
async def get_warehouse_stock(
    corporation_id: int = Query(...),
    warehouse_id: Optional[int] = Query(None, description="Specific warehouse or all"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get current stock levels for warehouse(s).

    Returns a summary of items grouped by type_id for the configured
    warehouse locations/divisions.
    """
    await assert_owns_corporation(db, user_id, corporation_id)
    # Get warehouse configs
    stmt = select(CorpWarehouseConfig).where(
        CorpWarehouseConfig.corporation_id == corporation_id,
        CorpWarehouseConfig.is_active == True,
    )
    if warehouse_id:
        stmt = stmt.where(CorpWarehouseConfig.id == warehouse_id)

    result = await db.execute(stmt)
    warehouses = result.scalars().all()

    if not warehouses:
        return {"warehouses": [], "total_items": 0}

    results = []
    for w in warehouses:
        # Query assets in this warehouse's location + division
        asset_query = select(
            Asset.type_id,
            Asset.type_name,
            func.sum(Asset.quantity).label("total_quantity"),
            Asset.category_name,
        ).where(
            Asset.corporation_id == corporation_id,
            Asset.is_corp_asset == True,
            Asset.location_id == w.location_id,
            Asset.division_id == w.division_id,
            Asset.is_blueprint == False,  # Exclude blueprints from stock counts
        ).group_by(
            Asset.type_id, Asset.type_name, Asset.category_name
        ).order_by(func.sum(Asset.quantity).desc())

        asset_result = await db.execute(asset_query)
        items = asset_result.all()

        results.append({
            "warehouse_id": w.id,
            "warehouse_name": w.warehouse_name,
            "location_id": w.location_id,
            "location_name": w.location_name,
            "division_id": w.division_id,
            "division_name": w.division_name,
            "is_mineral_warehouse": w.is_mineral_warehouse,
            "item_count": len(items),
            "items": [
                {
                    "type_id": i[0],
                    "type_name": i[1],
                    "total_quantity": int(i[2]),
                    "category": i[3],
                }
                for i in items
            ],
        })

    total = sum(r["item_count"] for r in results)
    return {"warehouses": results, "total_items": total}


async def _resolve_location_name(db: AsyncSession, location_id: int) -> Optional[str]:
    """Resolve a location name from the SDE stations table."""
    try:
        from app.models.sde_solar_system import SDEStation

        stmt = select(SDEStation.station_name).where(
            SDEStation.station_id == location_id
        )
        result = await db.execute(stmt)
        name = result.scalar_one_or_none()
        return name
    except Exception:
        return None


async def _resolve_division_name(
    db: AsyncSession, corporation_id: int, location_id: int, division_id: int
) -> Optional[str]:
    """Resolve a division name from stored assets."""
    try:
        from app.models.asset import Asset

        stmt = select(Asset.division_name).where(
            Asset.corporation_id == corporation_id,
            Asset.location_id == location_id,
            Asset.division_id == division_id,
            Asset.division_name.isnot(None),
        ).limit(1)
        result = await db.execute(stmt)
        name = result.scalar_one_or_none()
        return name
    except Exception:
        return None
