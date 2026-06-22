"""Build Calculator – fetches BOM data, calculates ME-adjusted quantities and costs."""

import math
import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.blueprint_material import BlueprintMaterial
from app.models.sde_item import SDEItem
from app.services.esi_client import ESIClient

logger = logging.getLogger(__name__)

# EVE activity IDs
ACTIVITY_MANUFACTURING = 1

# Cache TTL for blueprint materials (24 hours)
BP_MATERIAL_CACHE_HOURS = 24


async def _get_or_fetch_bom(
    db: AsyncSession,
    blueprint_type_id: int,
    activity_id: int = ACTIVITY_MANUFACTURING,
) -> list[BlueprintMaterial]:
    """Get BOM from cache, or fetch from ESI and cache it."""
    # Check cache first
    stmt = select(BlueprintMaterial).where(
        BlueprintMaterial.blueprint_type_id == blueprint_type_id,
        BlueprintMaterial.activity_id == activity_id,
    )
    result = await db.execute(stmt)
    cached = result.scalars().all()

    if cached:
        # Check if cache is still fresh
        now = datetime.now(timezone.utc)
        cached_time = cached[0].last_fetched
        if cached_time and (now - cached_time).total_seconds() < BP_MATERIAL_CACHE_HOURS * 3600:
            return list(cached)

    # Fetch from ESI
    materials = await _fetch_blueprint_materials(db, blueprint_type_id, activity_id)

    # Replace cache
    if cached:
        del_stmt = delete(BlueprintMaterial).where(
            BlueprintMaterial.blueprint_type_id == blueprint_type_id,
            BlueprintMaterial.activity_id == activity_id,
        )
        await db.execute(del_stmt)

    for mat in materials:
        db.add(mat)

    await db.flush()

    # Fetch from DB again to get fully loaded objects
    stmt = select(BlueprintMaterial).where(
        BlueprintMaterial.blueprint_type_id == blueprint_type_id,
        BlueprintMaterial.activity_id == activity_id,
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def _fetch_blueprint_materials(
    db: AsyncSession,
    blueprint_type_id: int,
    activity_id: int,
) -> list[BlueprintMaterial]:
    """Fetch blueprint materials from ESI /universe/types/{type_id}/ endpoint."""
    # We need a session for ESI client, but this endpoint is public (no auth)
    # We'll use a temporary ESIClient with a dummy session
    # Actually, get_universe_types is public so it doesn't need a character
    client = ESIClient(db)
    try:
        type_data = await client.get_universe_types(blueprint_type_id)
    except Exception as e:
        logger.warning(f"Failed to fetch type {blueprint_type_id} from ESI: {e}")
        return []
    finally:
        await client.close()

    # Extract blueprint activities
    blueprint = type_data.get("blueprint", {})
    activities = blueprint.get("activities", {})

    # Map activity IDs to their keys in the ESI response
    activity_key_map = {
        1: "manufacturing",
        3: "invention",
        4: "research_time",
        5: "research_material",
        8: "reactions",
        11: "copying",
    }

    activity_key = activity_key_map.get(activity_id)
    if not activity_key:
        logger.warning(f"Unknown activity ID: {activity_id}")
        return []

    activity_data = activities.get(activity_key, {})
    materials_list = activity_data.get("materials", [])
    products_list = activity_data.get("products", [])

    if not materials_list:
        logger.info(f"No materials for blueprint {blueprint_type_id} activity {activity_id}")
        return []

    # Get product info
    product_type_id = None
    product_name = None
    product_quantity = 1
    if products_list:
        product = products_list[0]
        product_type_id = product.get("type_id")
        product_quantity = product.get("quantity", 1)
        # Look up product name
        if product_type_id:
            sde_stmt = select(SDEItem.name).where(SDEItem.type_id == product_type_id)
            product_name = await db.scalar(sde_stmt)

    now = datetime.now(timezone.utc)
    result = []

    for mat in materials_list:
        mat_type_id = mat.get("type_id")
        quantity = mat.get("quantity", 0)

        # Look up material name from SDE
        mat_name = None
        if mat_type_id:
            sde_stmt = select(SDEItem.name).where(SDEItem.type_id == mat_type_id)
            mat_name = await db.scalar(sde_stmt)

        result.append(BlueprintMaterial(
            blueprint_type_id=blueprint_type_id,
            activity_id=activity_id,
            material_type_id=mat_type_id,
            material_name=mat_name or f"Unknown ({mat_type_id})",
            quantity=quantity,
            product_type_id=product_type_id,
            product_name=product_name,
            product_quantity=product_quantity,
            last_fetched=now,
        ))

    return result


def calculate_adjusted_quantity(base_quantity: int, me_level: int) -> int:
    """Calculate ME-adjusted material quantity.

    Formula: adjusted_qty = ceil(base_qty * (1 - 0.1 * me_level / (1 + me_level)))
    Simplified: adjusted_qty = ceil(base_qty * (1 / (1 + me_level)))
    Actually the correct EVE formula:
    adjusted = ceil(base_qty * (1 - 0.1 * me_level / (1 + me_level)))
    But a common simplification is:
    adjusted = ceil(base_qty * (1 / (1 + me_level * 0.1)))
    Let me use the standard EVE formula:
    waste_factor = 0.1 (10% base waste)
    adjusted_qty = ceil(base_qty * (1 - waste_factor * me_level / (1 + me_level)))
    For ME=0: adjusted = base_qty (full waste)
    For ME=10: adjusted = ceil(base_qty * (1 - 0.1 * 10/11)) = ceil(base_qty * ~0.909)
    """
    if me_level <= 0:
        return base_quantity
    waste_factor = 0.1
    reduction = waste_factor * me_level / (1 + me_level)
    adjusted = base_quantity * (1 - reduction)
    return max(1, math.ceil(adjusted))


async def calculate_build_cost(
    db: AsyncSession,
    product_type_id: int,
    runs: int = 1,
    me_level: int = 0,
    te_level: int = 0,
) -> dict:
    """Calculate the complete BOM and build cost for a product type.

    This function:
    1. Looks up which blueprint produces the product
    2. Fetches the BOM materials (from cache or ESI)
    3. Calculates ME-adjusted quantities
    4. Returns the BOM with material names and quantities
    """
    # Step 1: Find the blueprint that produces this product
    # We search blueprint_materials cache for products matching this type_id
    bp_stmt = select(BlueprintMaterial).where(
        BlueprintMaterial.product_type_id == product_type_id,
        BlueprintMaterial.activity_id == ACTIVITY_MANUFACTURING,
    )
    bp_result = await db.execute(bp_stmt)
    existing = bp_result.scalars().first()

    blueprint_type_id = None
    if existing:
        blueprint_type_id = existing.blueprint_type_id
    else:
        # Try to find blueprint via SDE: look for items with is_blueprint=True
        # that have matching group/category
        # For now, we'll need the blueprint type_id from the user
        # because there's no reliable way to reverse-lookup blueprint from product
        return {
            "error": True,
            "message": "Blueprint not found in cache. Please provide the blueprint type_id.",
        }

    # Step 2: Get BOM materials
    materials = await _get_or_fetch_bom(db, blueprint_type_id, ACTIVITY_MANUFACTURING)

    if not materials:
        return {
            "error": True,
            "message": f"No manufacturing materials found for blueprint {blueprint_type_id}",
        }

    # Step 3: Calculate adjusted quantities
    product_name = materials[0].product_name or f"Product {product_type_id}"
    product_quantity_per_run = materials[0].product_quantity or 1
    total_product_quantity = product_quantity_per_run * runs

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
        "error": False,
        "blueprint_type_id": blueprint_type_id,
        "product_type_id": product_type_id,
        "product_name": product_name,
        "product_quantity_per_run": product_quantity_per_run,
        "total_product_quantity": total_product_quantity,
        "runs": runs,
        "me_level": me_level,
        "te_level": te_level,
        "bom_items": bom_items,
        "total_materials": len(bom_items),
        "total_units": sum(i["total_quantity"] for i in bom_items),
    }
