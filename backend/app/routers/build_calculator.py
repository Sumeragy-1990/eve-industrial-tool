"""Build Calculator routes – blueprint search, BOM viewer, build cost calculator."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.sde_item import SDEItem
from app.models.blueprint_material import BlueprintMaterial
from app.services.build_calculator import (
    calculate_build_cost,
    calculate_adjusted_quantity,
    _get_or_fetch_bom,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/build", tags=["build"])


# ── Blueprint Search ─────────────────────────────────────────────


@router.get("/blueprints/search")
async def search_blueprints(
    q: str = Query(..., min_length=1, description="Search query for blueprint name"),
    limit: int = Query(20, ge=1, le=100, description="Max results"),
    db: AsyncSession = Depends(get_session),
):
    """Search blueprints by name from SDE data."""
    stmt = (
        select(SDEItem)
        .where(
            SDEItem.is_blueprint == True,  # noqa: E712
            SDEItem.name.ilike(f"%{q}%"),
        )
        .order_by(SDEItem.name)
        .limit(limit)
    )
    result = await db.execute(stmt)
    items = result.scalars().all()

    return {
        "query": q,
        "total": len(items),
        "blueprints": [
            {
                "type_id": item.type_id,
                "name": item.name,
                "group_name": item.group_name,
                "category_name": item.category_name,
            }
            for item in items
        ],
    }


@router.get("/blueprints/by-product/{product_type_id}")
async def find_blueprint_by_product(
    product_type_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Find the blueprint that produces a given product type ID.

    Searches the blueprint_materials cache first, then tries SDE
    by looking for blueprints whose name contains the product name.
    """
    # First: check blueprint_materials cache
    stmt = (
        select(BlueprintMaterial)
        .where(
            BlueprintMaterial.product_type_id == product_type_id,
            BlueprintMaterial.activity_id == 1,  # manufacturing
        )
        .limit(1)
    )
    result = await db.execute(stmt)
    cached = result.scalars().first()

    if cached:
        return {
            "found": True,
            "blueprint_type_id": cached.blueprint_type_id,
            "blueprint_name": None,  # Not stored in BlueprintMaterial
            "product_type_id": product_type_id,
            "product_name": cached.product_name,
            "source": "cache",
        }

    # Second: search SDE for blueprints related to this product
    product_stmt = select(SDEItem.name).where(SDEItem.type_id == product_type_id)
    product_name = await db.scalar(product_stmt)

    if product_name:
        # Try to find a blueprint whose name includes the product name
        # EVE convention: Blueprint name is "Product Name Blueprint"
        bp_name = f"{product_name} Blueprint"
        bp_stmt = (
            select(SDEItem)
            .where(
                SDEItem.is_blueprint == True,  # noqa: E712
                SDEItem.name == bp_name,
            )
            .limit(1)
        )
        result = await db.execute(bp_stmt)
        bp = result.scalars().first()

        if bp:
            return {
                "found": True,
                "blueprint_type_id": bp.type_id,
                "blueprint_name": bp.name,
                "product_type_id": product_type_id,
                "product_name": product_name,
                "source": "sde_name_match",
            }

        # Fuzzy search: blueprint name contains product name
        bp_stmt2 = (
            select(SDEItem)
            .where(
                SDEItem.is_blueprint == True,  # noqa: E712
                SDEItem.name.ilike(f"%{product_name}%"),
            )
            .limit(5)
        )
        result = await db.execute(bp_stmt2)
        bps = result.scalars().all()

        if bps:
            return {
                "found": True,
                "blueprint_type_id": bps[0].type_id,
                "blueprint_name": bps[0].name,
                "product_type_id": product_type_id,
                "product_name": product_name,
                "source": "sde_fuzzy_match",
                "alternatives": [
                    {"type_id": bp.type_id, "name": bp.name} for bp in bps
                ],
            }

    return {
        "found": False,
        "message": "No blueprint found for this product. Try searching blueprints by name.",
    }


# ── BOM (Bill of Materials) ──────────────────────────────────────


@router.get("/bom/{blueprint_type_id}")
async def get_blueprint_bom(
    blueprint_type_id: int,
    me_level: int = Query(0, ge=0, le=100, description="Material Efficiency level"),
    runs: int = Query(1, ge=1, le=100000, description="Number of runs"),
    activity_id: int = Query(1, ge=1, le=20, description="Activity ID (1=manufacturing)"),
    db: AsyncSession = Depends(get_session),
):
    """Fetch the Bill of Materials for a blueprint with ME-adjusted quantities."""
    # Get blueprint name from SDE
    bp_stmt = select(SDEItem.name).where(SDEItem.type_id == blueprint_type_id)
    blueprint_name = await db.scalar(bp_stmt)

    # Fetch BOM (from cache or ESI)
    materials = await _get_or_fetch_bom(db, blueprint_type_id, activity_id)

    if not materials:
        return {
            "blueprint_type_id": blueprint_type_id,
            "blueprint_name": blueprint_name or f"Blueprint {blueprint_type_id}",
            "activity_id": activity_id,
            "runs": runs,
            "me_level": me_level,
            "materials": [],
            "total_materials": 0,
            "error": "No materials found. Try another activity or sync the blueprint first.",
        }

    # Get product info from first material
    product_name = materials[0].product_name or f"Product {materials[0].product_type_id}"
    product_type_id = materials[0].product_type_id
    product_quantity_per_run = materials[0].product_quantity or 1
    total_product_quantity = product_quantity_per_run * runs

    # Calculate adjusted quantities
    bom_items = []
    for mat in materials:
        base_qty = mat.quantity
        adjusted_qty_per_run = calculate_adjusted_quantity(base_qty, me_level)
        total_qty = adjusted_qty_per_run * runs

        bom_items.append({
            "material_type_id": mat.material_type_id,
            "material_name": mat.material_name or f"Unknown ({mat.material_type_id})",
            "base_quantity": base_qty,
            "adjusted_quantity_per_run": adjusted_qty_per_run,
            "total_quantity": total_qty,
            "runs": runs,
        })

    return {
        "blueprint_type_id": blueprint_type_id,
        "blueprint_name": blueprint_name or f"Blueprint {blueprint_type_id}",
        "activity_id": activity_id,
        "runs": runs,
        "me_level": me_level,
        "product_type_id": product_type_id,
        "product_name": product_name,
        "product_quantity_per_run": product_quantity_per_run,
        "total_product_quantity": total_product_quantity,
        "materials": bom_items,
        "total_materials": len(bom_items),
        "total_units": sum(i["total_quantity"] for i in bom_items),
    }


# ── Full Build Cost Calculation ──────────────────────────────────


@router.post("/calculate")
async def calculate_build(
    product_type_id: int,
    runs: int = Query(1, ge=1, le=100000),
    me_level: int = Query(0, ge=0, le=100),
    te_level: int = Query(0, ge=0, le=100),
    db: AsyncSession = Depends(get_session),
):
    """Calculate the full build cost for a product.

    This endpoint:
    1. Finds the blueprint that produces the given product
    2. Fetches the BOM (from cache or ESI)
    3. Calculates ME-adjusted quantities
    4. Returns the complete BOM breakdown

    Note: Market prices are not yet included (needs Phase 4B Price Cache Service).
    """
    result = await calculate_build_cost(
        db=db,
        product_type_id=product_type_id,
        runs=runs,
        me_level=me_level,
        te_level=te_level,
    )

    if result.get("error"):
        raise HTTPException(status_code=404, detail=result["message"])

    return result
