"""Restock Calculator – Corp restock list management and gap analysis."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.restock import RestockList, RestockListItem
from app.models.asset import Asset
from app.models.sde_item import SDEItem
from app.models.character import Character
from app.routers.auth import require_account, assert_owns_corporation

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/restock", tags=["restock"])


async def _owned_corp_ids(db: AsyncSession, user_id: int) -> list[int]:
    """Return distinct corporation IDs the account's characters belong to."""
    result = await db.execute(
        select(Character.corporation_id)
        .where(Character.user_id == user_id, Character.corporation_id.isnot(None))
        .distinct()
    )
    return [row[0] for row in result.all()]


async def _assert_list_owned(db: AsyncSession, user_id: int, rl) -> None:
    """Raise 403 unless the account owns a character in the list's corporation."""
    await assert_owns_corporation(db, user_id, rl.corporation_id)


# ── Helper: Calculate stock, gap, to_buy for one item ──────────


async def _calculate_item_gap(
    db: AsyncSession,
    corporation_id: int,
    type_id: int,
    target_quantity: int,
) -> dict:
    """Calculate current stock, gap, and to_buy for a single type_id.

    current_stock = SUM(quantity) from corp assets where type_id matches.
    gap = max(0, target_quantity - current_stock)
    to_buy = gap
    """
    # Sum quantity of this type_id in corp assets
    stock_query = select(func.coalesce(func.sum(Asset.quantity), 0)).where(
        Asset.corporation_id == corporation_id,
        Asset.is_corp_asset == True,
        Asset.type_id == type_id,
    )
    current_stock = await db.scalar(stock_query) or 0

    gap = max(0, target_quantity - current_stock)
    to_buy = gap

    return {
        "current_stock": current_stock,
        "gap": gap,
        "to_buy": to_buy,
    }


# ── CRUD: Restock Lists ────────────────────────────────────────


@router.get("/lists")
async def get_restock_lists(
    corporation_id: Optional[int] = Query(None, description="Filter by corporation"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get all restock lists with optional filters."""
    owned_corps = await _owned_corp_ids(db, user_id)
    base = select(RestockList)

    if corporation_id:
        await assert_owns_corporation(db, user_id, corporation_id)
        base = base.where(RestockList.corporation_id == corporation_id)
    else:
        base = base.where(RestockList.corporation_id.in_(owned_corps or [0]))
    if is_active is not None:
        base = base.where(RestockList.is_active == is_active)

    # Count total
    count_query = select(func.count()).select_from(base.subquery())
    total = await db.scalar(count_query) or 0

    # Fetch page
    offset = (page - 1) * per_page
    query = base.order_by(RestockList.name).offset(offset).limit(per_page)
    result = await db.execute(query)
    lists = result.scalars().all()

    # Get item count per list
    lists_data = []
    for rl in lists:
        item_count_query = select(func.count()).where(
            RestockListItem.restock_list_id == rl.id
        )
        item_count = await db.scalar(item_count_query) or 0
        lists_data.append({
            "id": rl.id,
            "corporation_id": rl.corporation_id,
            "name": rl.name,
            "is_active": rl.is_active,
            "item_count": item_count,
            "created_at": rl.created_at.isoformat() if rl.created_at else None,
            "updated_at": rl.updated_at.isoformat() if rl.updated_at else None,
        })

    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": max(1, (total + per_page - 1) // per_page),
        "lists": lists_data,
    }


@router.post("/lists", status_code=201)
async def create_restock_list(
    corporation_id: int = Query(..., description="Corporation ID"),
    name: str = Query(..., min_length=1, max_length=128, description="List name"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Create a new restock list."""
    await assert_owns_corporation(db, user_id, corporation_id)
    rl = RestockList(
        corporation_id=corporation_id,
        name=name.strip(),
    )
    db.add(rl)
    await db.flush()
    await db.refresh(rl)

    return {
        "id": rl.id,
        "corporation_id": rl.corporation_id,
        "name": rl.name,
        "is_active": rl.is_active,
        "created_at": rl.created_at.isoformat() if rl.created_at else None,
    }


@router.get("/lists/{list_id}")
async def get_restock_list(
    list_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get a single restock list with its items."""
    stmt = select(RestockList).where(RestockList.id == list_id)
    result = await db.execute(stmt)
    rl = result.scalar_one_or_none()

    if not rl:
        raise HTTPException(status_code=404, detail="Restock list not found")

    await _assert_list_owned(db, user_id, rl)

    # Fetch items
    items_stmt = select(RestockListItem).where(
        RestockListItem.restock_list_id == list_id
    ).order_by(RestockListItem.category_group, RestockListItem.type_name)
    items_result = await db.execute(items_stmt)
    items = items_result.scalars().all()

    return {
        "id": rl.id,
        "corporation_id": rl.corporation_id,
        "name": rl.name,
        "is_active": rl.is_active,
        "created_at": rl.created_at.isoformat() if rl.created_at else None,
        "updated_at": rl.updated_at.isoformat() if rl.updated_at else None,
        "items": [
            {
                "id": i.id,
                "type_id": i.type_id,
                "type_name": i.type_name,
                "target_quantity": i.target_quantity,
                "current_stock": i.current_stock,
                "gap": i.gap,
                "to_buy": i.to_buy,
                "average_price": i.average_price,
                "estimated_cost": i.estimated_cost,
                "category_group": i.category_group,
            }
            for i in items
        ],
    }


@router.put("/lists/{list_id}")
async def update_restock_list(
    list_id: int,
    name: Optional[str] = Query(None, max_length=128),
    is_active: Optional[bool] = Query(None),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Update a restock list's name or active status."""
    stmt = select(RestockList).where(RestockList.id == list_id)
    result = await db.execute(stmt)
    rl = result.scalar_one_or_none()

    if not rl:
        raise HTTPException(status_code=404, detail="Restock list not found")

    await _assert_list_owned(db, user_id, rl)

    if name is not None:
        rl.name = name.strip()
    if is_active is not None:
        rl.is_active = is_active

    await db.flush()
    await db.refresh(rl)

    return {
        "id": rl.id,
        "corporation_id": rl.corporation_id,
        "name": rl.name,
        "is_active": rl.is_active,
        "updated_at": rl.updated_at.isoformat() if rl.updated_at else None,
    }


@router.delete("/lists/{list_id}", status_code=204)
async def delete_restock_list(
    list_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Delete a restock list and all its items."""
    stmt = select(RestockList).where(RestockList.id == list_id)
    result = await db.execute(stmt)
    rl = result.scalar_one_or_none()

    if not rl:
        raise HTTPException(status_code=404, detail="Restock list not found")

    await _assert_list_owned(db, user_id, rl)

    # Delete items first (CASCADE should handle this, but explicit is safer)
    del_items = delete(RestockListItem).where(
        RestockListItem.restock_list_id == list_id
    )
    await db.execute(del_items)

    # Delete the list
    await db.delete(rl)
    await db.flush()

    return None  # 204 No Content


# ── CRUD: Restock List Items ───────────────────────────────────


@router.post("/lists/{list_id}/items", status_code=201)
async def add_restock_item(
    list_id: int,
    type_id: int = Query(..., description="EVE type ID of the item"),
    target_quantity: int = Query(..., ge=0, description="Target stock quantity"),
    category_group: Optional[str] = Query(None, max_length=64),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Add an item to a restock list with a target quantity."""
    # Verify list exists
    stmt = select(RestockList).where(RestockList.id == list_id)
    result = await db.execute(stmt)
    rl = result.scalar_one_or_none()

    if not rl:
        raise HTTPException(status_code=404, detail="Restock list not found")

    await _assert_list_owned(db, user_id, rl)

    # Check for duplicate type_id in this list
    dup_stmt = select(RestockListItem).where(
        RestockListItem.restock_list_id == list_id,
        RestockListItem.type_id == type_id,
    )
    dup_result = await db.execute(dup_stmt)
    if dup_result.scalar_one_or_none():
        raise HTTPException(
            status_code=409,
            detail=f"Item type_id {type_id} already exists in this list",
        )

    # Look up item name from SDE
    sde_stmt = select(SDEItem).where(SDEItem.type_id == type_id)
    sde_result = await db.execute(sde_stmt)
    sde_item = sde_result.scalar_one_or_none()
    type_name = sde_item.name if sde_item else f"Unknown ({type_id})"

    # Calculate current stock
    gap_data = await _calculate_item_gap(
        db, rl.corporation_id, type_id, target_quantity
    )

    item = RestockListItem(
        restock_list_id=list_id,
        type_id=type_id,
        type_name=type_name,
        target_quantity=target_quantity,
        current_stock=gap_data["current_stock"],
        gap=gap_data["gap"],
        to_buy=gap_data["to_buy"],
        category_group=category_group,
    )
    db.add(item)
    await db.flush()
    await db.refresh(item)

    return {
        "id": item.id,
        "type_id": item.type_id,
        "type_name": item.type_name,
        "target_quantity": item.target_quantity,
        "current_stock": item.current_stock,
        "gap": item.gap,
        "to_buy": item.to_buy,
        "category_group": item.category_group,
    }


@router.put("/lists/{list_id}/items/{item_id}")
async def update_restock_item(
    list_id: int,
    item_id: int,
    target_quantity: Optional[int] = Query(None, ge=0),
    category_group: Optional[str] = Query(None, max_length=64),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Update an item's target quantity or category group."""
    stmt = select(RestockListItem).where(
        RestockListItem.id == item_id,
        RestockListItem.restock_list_id == list_id,
    )
    result = await db.execute(stmt)
    item = result.scalar_one_or_none()

    if not item:
        raise HTTPException(status_code=404, detail="Restock item not found")

    # Get corporation_id from the parent list
    list_stmt = select(RestockList).where(RestockList.id == list_id)
    list_result = await db.execute(list_stmt)
    rl = list_result.scalar_one_or_none()

    if not rl:
        raise HTTPException(status_code=404, detail="Restock list not found")
    await _assert_list_owned(db, user_id, rl)

    if target_quantity is not None:
        item.target_quantity = target_quantity

    if category_group is not None:
        item.category_group = category_group

    # Recalculate gap if target changed
    if target_quantity is not None and rl:
        gap_data = await _calculate_item_gap(
            db, rl.corporation_id, item.type_id, item.target_quantity
        )
        item.current_stock = gap_data["current_stock"]
        item.gap = gap_data["gap"]
        item.to_buy = gap_data["to_buy"]

    await db.flush()
    await db.refresh(item)

    return {
        "id": item.id,
        "type_id": item.type_id,
        "type_name": item.type_name,
        "target_quantity": item.target_quantity,
        "current_stock": item.current_stock,
        "gap": item.gap,
        "to_buy": item.to_buy,
        "average_price": item.average_price,
        "estimated_cost": item.estimated_cost,
        "category_group": item.category_group,
    }


@router.delete("/lists/{list_id}/items/{item_id}", status_code=204)
async def delete_restock_item(
    list_id: int,
    item_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Remove an item from a restock list."""
    # Verify the parent list is owned by this account
    list_stmt = select(RestockList).where(RestockList.id == list_id)
    list_result = await db.execute(list_stmt)
    rl = list_result.scalar_one_or_none()
    if not rl:
        raise HTTPException(status_code=404, detail="Restock list not found")
    await _assert_list_owned(db, user_id, rl)

    stmt = select(RestockListItem).where(
        RestockListItem.id == item_id,
        RestockListItem.restock_list_id == list_id,
    )
    result = await db.execute(stmt)
    item = result.scalar_one_or_none()

    if not item:
        raise HTTPException(status_code=404, detail="Restock item not found")

    await db.delete(item)
    await db.flush()

    return None  # 204 No Content


# ── Calculation ────────────────────────────────────────────────


@router.post("/lists/{list_id}/calculate")
async def calculate_restock_list(
    list_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Recalculate current_stock, gap, and to_buy for all items in a list."""
    # Verify list exists
    stmt = select(RestockList).where(RestockList.id == list_id)
    result = await db.execute(stmt)
    rl = result.scalar_one_or_none()

    if not rl:
        raise HTTPException(status_code=404, detail="Restock list not found")

    await _assert_list_owned(db, user_id, rl)

    # Fetch all items
    items_stmt = select(RestockListItem).where(
        RestockListItem.restock_list_id == list_id
    )
    items_result = await db.execute(items_stmt)
    items = items_result.scalars().all()

    updated_count = 0
    for item in items:
        gap_data = await _calculate_item_gap(
            db, rl.corporation_id, item.type_id, item.target_quantity
        )
        item.current_stock = gap_data["current_stock"]
        item.gap = gap_data["gap"]
        item.to_buy = gap_data["to_buy"]
        updated_count += 1

    await db.flush()

    return {
        "list_id": list_id,
        "list_name": rl.name,
        "items_updated": updated_count,
        "message": f"Recalculated {updated_count} items",
    }


# ── Summary ─────────────────────────────────────────────────────


@router.get("/lists/{list_id}/summary")
async def get_restock_summary(
    list_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get a summary of total costs and items to buy for a restock list."""
    stmt = select(RestockList).where(RestockList.id == list_id)
    result = await db.execute(stmt)
    rl = result.scalar_one_or_none()

    if not rl:
        raise HTTPException(status_code=404, detail="Restock list not found")

    await _assert_list_owned(db, user_id, rl)

    # Fetch items
    items_stmt = select(RestockListItem).where(
        RestockListItem.restock_list_id == list_id,
    )
    items_result = await db.execute(items_stmt)
    items = items_result.scalars().all()

    total_items = len(items)
    items_to_buy = sum(1 for i in items if i.to_buy and i.to_buy > 0)
    total_to_buy = sum(i.to_buy or 0 for i in items)
    total_estimated_cost = sum(i.estimated_cost or 0 for i in items)

    # Group by category_group
    categories = {}
    for i in items:
        cat = i.category_group or "Other"
        if cat not in categories:
            categories[cat] = {
                "items": 0,
                "to_buy": 0,
                "estimated_cost": 0.0,
            }
        categories[cat]["items"] += 1
        categories[cat]["to_buy"] += i.to_buy or 0
        categories[cat]["estimated_cost"] += i.estimated_cost or 0.0

    return {
        "list_id": rl.id,
        "list_name": rl.name,
        "corporation_id": rl.corporation_id,
        "total_items": total_items,
        "items_to_buy": items_to_buy,
        "total_to_buy_units": total_to_buy,
        "total_estimated_cost": total_estimated_cost,
        "categories": categories,
    }


# ── Batch Add from Template ─────────────────────────────────────


RESTOCK_CATEGORIES = {
    "minerals": [
        (34, "Tritanium"),
        (35, "Pyerite"),
        (36, "Mexallon"),
        (37, "Isogen"),
        (38, "Nocxium"),
        (39, "Zydrine"),
        (40, "Megacyte"),
        (11399, "Morphite"),
    ],
    "moon_goop": [
        (4247, "Tungsten Carbide"),
        (4246, "Titanium Diborite"),
        (4248, "Vanadium Hafnite"),
        (4261, "Cobalt Benzene"),
        (4260, "Boron Nitride"),
        (4257, "Solerium"),
        (4256, "Fernite Carbide"),
        (4258, "Fernite Alloy"),
        (4263, "Carbon-86"),
    ],
    "planet_tech": [
        (3828, "Transmitter"),
        (9832, "Coolant"),
        (9830, "Rocket Fuel"),
        (9836, "Noble Gas"),
        (2312, "Mechanical Parts"),
        (2317, "Construction Blocks"),
        (2319, "Nanites"),
        (9848, "Polymer"),
        (2328, "Biocells"),
        (2321, "Oxygen"),
        (2327, "Water"),
        (2329, "Precious Metals"),
        (2322, "Electrolytes"),
        (2324, "Toxic Metals"),
        (2309, "Industrial Fibers"),
        (2310, "Reactive Metals"),
        (2311, "Platinum"),
        (9838, "Supertensile Plastics"),
        (9838, "Oxides"),
        (9838, "Motors"),
        (9838, "Hermetic Membranes"),
    ],
    "datacores": [
        (20424, "Datacore - Amarrian Starship Engineering"),
        (20425, "Datacore - Caldari Starship Engineering"),
        (20426, "Datacore - Gallentean Starship Engineering"),
        (20427, "Datacore - Minmatar Starship Engineering"),
        (20428, "Datacore - Mechanical Engineering"),
        (20429, "Datacore - Rocket Science"),
        (20430, "Datacore - Graviton Physics"),
        (20431, "Datacore - Laser Physics"),
        (20432, "Datacore - Electromagnetic Physics"),
        (20433, "Datacore - Plasma Physics"),
        (20434, "Datacore - Nuclear Physics"),
        (20435, "Datacore - Quantum Physics"),
        (20436, "Datacore - Electronic Engineering"),
        (20437, "Datacore - High Energy Physics"),
        (20438, "Datacore - Nanite Engineering"),
        (20439, "Datacore - Hydromagnetic Physics"),
    ],
    "decryptors": [
        (34204, "Decryptor - Sacred Manifesto"),
        (34205, "Decryptor - Rundown Memo"),
        (34206, "Decryptor - Circuitry Schematics"),
        (34207, "Decryptor - Active Modulation Cryto"),
        (34208, "Decryptor - Optimized Micro Assembly"),
        (34209, "Decryptor - Curious Augmenter"),
        (34210, "Decryptor - Acliptic Quad"),
        (34211, "Decryptor - Neural Network Analyzer"),
        (34212, "Decryptor - Symbiotic Leech"),
        (34213, "Decryptor - Tenacious Decryptor"),
        (34214, "Decryptor - Attainable Decryptor"),
        (34215, "Decryptor - Parasitic Cryptographer"),
    ],
}


@router.post("/lists/{list_id}/add-template")
async def add_template_to_list(
    list_id: int,
    template: str = Query(..., description="Template name: minerals, moon_goop, planet_tech, datacores, decryptors"),
    target_quantity: int = Query(1000, ge=1, description="Default target quantity for each item"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Add a predefined category template to a restock list."""
    if template not in RESTOCK_CATEGORIES:
        valid = ", ".join(RESTOCK_CATEGORIES.keys())
        raise HTTPException(
            status_code=400,
            detail=f"Unknown template '{template}'. Valid: {valid}",
        )

    # Verify list exists
    stmt = select(RestockList).where(RestockList.id == list_id)
    result = await db.execute(stmt)
    rl = result.scalar_one_or_none()

    if not rl:
        raise HTTPException(status_code=404, detail="Restock list not found")

    await _assert_list_owned(db, user_id, rl)

    added = 0
    skipped = 0
    for type_id, type_name in RESTOCK_CATEGORIES[template]:
        # Check for duplicate
        dup_stmt = select(RestockListItem).where(
            RestockListItem.restock_list_id == list_id,
            RestockListItem.type_id == type_id,
        )
        dup_result = await db.execute(dup_stmt)
        if dup_result.scalar_one_or_none():
            skipped += 1
            continue

        # Calculate current stock
        gap_data = await _calculate_item_gap(
            db, rl.corporation_id, type_id, target_quantity
        )

        item = RestockListItem(
            restock_list_id=list_id,
            type_id=type_id,
            type_name=type_name,
            target_quantity=target_quantity,
            current_stock=gap_data["current_stock"],
            gap=gap_data["gap"],
            to_buy=gap_data["to_buy"],
            category_group=template,
        )
        db.add(item)
        added += 1

    await db.flush()

    return {
        "list_id": list_id,
        "template": template,
        "added": added,
        "skipped": skipped,
        "message": f"Added {added} items from '{template}' template ({skipped} skipped as duplicates)",
    }


# ── Copy to Clipboard / Buy Text ────────────────────────────────


@router.get("/lists/{list_id}/buy-text")
async def get_buy_text(
    list_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Generate a copyable buy order text for all items with a gap."""
    stmt = select(RestockList).where(RestockList.id == list_id)
    result = await db.execute(stmt)
    rl = result.scalar_one_or_none()

    if not rl:
        raise HTTPException(status_code=404, detail="Restock list not found")

    await _assert_list_owned(db, user_id, rl)

    items_stmt = select(RestockListItem).where(
        RestockListItem.restock_list_id == list_id,
        RestockListItem.to_buy > 0,
    ).order_by(RestockListItem.category_group, RestockListItem.type_name)
    items_result = await db.execute(items_stmt)
    items = items_result.scalars().all()

    lines = [f"=== {rl.name} - Restock Buy List ===", ""]
    current_cat = None

    for i in items:
        cat = i.category_group or "Other"
        if cat != current_cat:
            lines.append(f"--- {cat.upper()} ---")
            current_cat = cat
        price_str = f" @ {i.average_price:,.2f} ISK" if i.average_price else ""
        cost_str = f" = {i.estimated_cost:,.2f} ISK" if i.estimated_cost else ""
        lines.append(f"{i.type_name} x{i.to_buy}{price_str}{cost_str}")

    lines.append("")
    total_cost = sum(i.estimated_cost or 0 for i in items)
    lines.append(f"Total Estimated Cost: {total_cost:,.2f} ISK")
    lines.append("=== END ===")

    return {
        "list_id": list_id,
        "list_name": rl.name,
        "text": "\n".join(lines),
        "total_items": len(items),
        "total_cost": total_cost,
    }
