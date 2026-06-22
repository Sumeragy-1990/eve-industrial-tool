"""Repair script: Resolve category_id + category_name for assets where still NULL.

Also fixes empty category_name for ESI-fallback items by fetching
category info from /universe/categories/{category_id}/.

Usage:
    docker compose exec -T backend python -m app.scripts.repair_categories
"""

import asyncio
import logging
import httpx

from sqlalchemy import select, update
from app.database import async_session_factory
from app.models.asset import Asset

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

ESI_BASE = "https://esi.evetech.net/latest"

# Category ID → name mapping (fallback if ESI call fails)
CATEGORY_NAMES = {
    2: "Blueprint",
    3: "Skill",
    4: "Material",
    5: "Accessories",
    6: "Ship",
    7: "Module",
    8: "Charge",
    9: "Blueprint",
    10: "Fighter",
    14: "Commodity",
    16: "Reaction",
    17: "Structure",
    18: "Drone",
    20: "Implant",
    22: "Deployable",
    24: "Structure",
    25: "Planetary Interaction",
    29: "Charge",
    30: "Structure",
    32: "Structure",
    34: "Structure",
    35: "Structure",
    39: "Structure",
    40: "Structure",
    41: "Structure",
    42: "Structure",
    43: "Structure",
    46: "Structure",
    53: "Structure",
    59: "Structure",
    62: "Structure",
    63: "Structure",
    65: "Structure",
    66: "Structure",
    87: "Fighter",
    91: "Skill",
    350: "Structure",
    2100: "Expert System",
    2118: "Skin",
}

# Category ID → flag mapping
CATEGORY_FLAGS = {
    4: "is_material",
    6: "is_ship",
    7: "is_module",
    8: "is_charge",
    18: "is_drone",
    20: "is_implant",
    65: "is_structure",
}


async def fetch_category_name(http: httpx.AsyncClient, category_id: int) -> str | None:
    """Fetch category name from ESI /universe/categories/{id}/."""
    if category_id is None:
        return None
    # Try local map first
    name = CATEGORY_NAMES.get(category_id)
    if name:
        return name
    # Fallback to ESI
    try:
        resp = await http.get(f"{ESI_BASE}/universe/categories/{category_id}/")
        if resp.is_error:
            logger.warning(f"ESI returned {resp.status_code} for category {category_id}")
            return None
        data = resp.json()
        return data.get("name")
    except Exception as e:
        logger.warning(f"Failed to fetch category {category_id}: {e}")
        return None


async def fetch_type_and_group(http: httpx.AsyncClient, type_id: int) -> dict | None:
    """Fetch type info from ESI, then fetch group info to get category_id."""
    try:
        # Step 1: Get type info
        resp = await http.get(f"{ESI_BASE}/universe/types/{type_id}/")
        if resp.is_error:
            logger.warning(f"ESI returned {resp.status_code} for type {type_id}")
            return None
        type_info = resp.json()
        
        group_id = type_info.get("group_id")
        if group_id is None:
            logger.warning(f"No group_id for type {type_id}")
            return None
        
        # Step 2: Get group info (contains category_id)
        resp = await http.get(f"{ESI_BASE}/universe/groups/{group_id}/")
        if resp.is_error:
            logger.warning(f"ESI returned {resp.status_code} for group {group_id}")
            return None
        group_info = resp.json()
        
        category_id = group_info.get("category_id")
        
        # Step 3: Get category name
        category_name = await fetch_category_name(http, category_id)
        
        # Build flags
        is_ship = category_id == 6
        is_module = category_id == 7
        is_charge = category_id == 8
        is_drone = category_id == 18
        is_implant = category_id == 20
        is_structure = category_id == 65
        is_material = category_id == 4
        is_blueprint = category_id in (2, 9)
        
        return {
            "name": type_info.get("name"),
            "group_id": group_id,
            "group_name": group_info.get("name"),
            "category_id": category_id,
            "category_name": category_name,
            "meta_group_id": type_info.get("meta_group_id"),
            "volume": type_info.get("volume"),
            "is_blueprint": is_blueprint,
            "is_ship": is_ship,
            "is_module": is_module,
            "is_charge": is_charge,
            "is_drone": is_drone,
            "is_implant": is_implant,
            "is_structure": is_structure,
            "is_material": is_material,
        }
    except Exception as e:
        logger.warning(f"Failed to fetch type {type_id}: {e}")
        return None


async def repair():
    """Main repair function — fixes NULL category_id AND empty category_name."""
    async with async_session_factory() as db:
        # Find all unique type_ids that still have NULL category_id
        stmt = select(Asset.type_id).where(
            Asset.category_id.is_(None)
        ).distinct()
        result = await db.execute(stmt)
        missing_cat_ids = [row[0] for row in result]
        
        # Also find type_ids with NULL/empty category_name but valid category_id
        # (these are ESI-fallback items that need category names)
        stmt = select(Asset.type_id).where(
            (Asset.category_name.is_(None) | (Asset.category_name == ''))
            & (Asset.category_id.isnot(None))
        ).distinct()
        result = await db.execute(stmt)
        missing_cat_names = [row[0] for row in result]
        
        # Combine unique type_ids
        all_type_ids = list(set(missing_cat_ids + missing_cat_names))
        
        if not all_type_ids:
            logger.info("No assets with NULL category_id or empty category_name found! All good.")
            return
        
        logger.info(
            f"Found {len(all_type_ids)} unique type_ids to repair "
            f"({len(missing_cat_ids)} with NULL category_id, "
            f"{len(missing_cat_names)} with empty category_name)"
        )
        
        # Fetch info from ESI
        async with httpx.AsyncClient(headers={"User-Agent": "EVE Industrial Tool/1.0"}, timeout=30) as http:
            for tid in all_type_ids:
                info = await fetch_type_and_group(http, tid)
                if info is None:
                    logger.warning(f"Could not resolve type_id {tid} from ESI")
                    continue
                
                logger.info(
                    f"Type {tid}: {info['name']} → "
                    f"group={info['group_id']} ({info['group_name']}), "
                    f"category={info['category_id']} ({info['category_name']})"
                )
                
                # Update ALL assets with this type_id
                update_values = {
                    Asset.type_name: info["name"],
                    Asset.group_id: info["group_id"],
                    Asset.group_name: info["group_name"],
                    Asset.category_id: info["category_id"],
                    Asset.category_name: info["category_name"],
                    Asset.meta_group_id: info["meta_group_id"],
                    Asset.volume: info["volume"],
                    Asset.is_blueprint: info["is_blueprint"],
                    Asset.is_ship: info["is_ship"],
                    Asset.is_module: info["is_module"],
                    Asset.is_charge: info["is_charge"],
                    Asset.is_drone: info["is_drone"],
                    Asset.is_implant: info["is_implant"],
                    Asset.is_structure: info["is_structure"],
                    Asset.is_material: info["is_material"],
                }
                stmt = (
                    update(Asset)
                    .where(Asset.type_id == tid)
                    .values(**{k.key: v for k, v in update_values.items()})
                )
                await db.execute(stmt)
                await db.commit()
                logger.info(f"Updated assets for type_id {tid}")
        
        # Verify
        stmt = select(Asset.type_id).where(
            Asset.category_id.is_(None)
        ).distinct()
        result = await db.execute(stmt)
        still_null_cat = [row[0] for row in result]
        
        stmt = select(Asset.type_id).where(
            (Asset.category_name.is_(None) | (Asset.category_name == ''))
            & (Asset.category_id.isnot(None))
        ).distinct()
        result = await db.execute(stmt)
        still_empty_name = [row[0] for row in result]
        
        if still_null_cat:
            logger.warning(f"Still {len(still_null_cat)} type_ids with NULL category_id: {still_null_cat}")
        else:
            logger.info("SUCCESS: All assets now have category_id populated!")
            
        if still_empty_name:
            logger.warning(f"Still {len(still_empty_name)} type_ids with empty category_name")
        else:
            logger.info("SUCCESS: All assets now have category_name populated!")


if __name__ == "__main__":
    asyncio.run(repair())
