"""Repair script: Resolve location_name and location_category for existing assets.

Uses the same logic as _resolve_location_names and _resolve_location_categories
from asset_sync.py to fix existing data without re-syncing all corp assets.

Usage:
    docker compose exec -T backend python -m app.scripts.repair_locations
"""

import asyncio
import logging
from typing import Optional

import httpx
from sqlalchemy import select, update, bindparam

from app.database import async_session_factory
from app.models.asset import Asset

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

ESI_BASE = "https://esi.evetech.net/latest"
INT32_MAX = 2_147_483_647


async def resolve_location_names(
    http: httpx.AsyncClient, location_ids: set[int]
) -> dict[int, tuple[Optional[str], Optional[str]]]:
    """Resolve location names and categories.

    Returns {location_id: (name, category)}
    Uses the same logic as asset_sync.py _resolve_location_names and
    _resolve_location_categories.
    """
    result: dict[int, tuple[Optional[str], Optional[str]]] = {}

    if not location_ids:
        return result

    # Classify IDs by range
    station_ids = {lid for lid in location_ids if 60000000 <= lid < 61000000}
    solar_ids = {lid for lid in location_ids if 30000000 <= lid < 32000000}
    resolvable_ids = {
        lid for lid in location_ids
        if 100000 <= lid <= INT32_MAX
        and lid not in station_ids and lid not in solar_ids
    }
    big_structure_ids = {lid for lid in location_ids if lid > INT32_MAX}
    small_other = {
        lid for lid in location_ids
        if 0 < lid < 100000
        and lid not in station_ids and lid not in solar_ids
    }

    for label, id_set in [("station", station_ids), ("solar", solar_ids), ("resolvable", resolvable_ids)]:
        if not id_set:
            continue
        try:
            resp = await http.post(
                f"{ESI_BASE}/universe/names/",
                json=list(id_set),
            )
            if resp.is_error:
                logger.warning(f"ESI returned {resp.status_code} for {label} batch")
                for lid in id_set:
                    if label == "station":
                        result[lid] = (f"Station {lid}", "station")
                    elif label == "solar":
                        result[lid] = (f"Solarsystem {lid}", "solar_system")
                    else:
                        result[lid] = (f"Location {lid}", "structure")
                continue

            names = resp.json()
            name_map = {entry["id"]: entry.get("name") for entry in names}
            cat_map = {entry["id"]: entry.get("category", "item") for entry in names}

            for lid in id_set:
                name = name_map.get(lid, f"Location {lid}")
                cat = cat_map.get(lid, "item")
                result[lid] = (name, cat)
        except Exception as e:
            logger.warning(f"Failed to resolve {label} location names: {e}")
            for lid in id_set:
                if label == "station":
                    result[lid] = (f"Station {lid}", "station")
                elif label == "solar":
                    result[lid] = (f"Solarsystem {lid}", "solar_system")
                else:
                    result[lid] = (f"Location {lid}", "structure")

    # Large structure IDs (beyond int32) - placeholder names
    for lid in big_structure_ids:
        result[lid] = (f"Structure {lid}", "structure")

    # Small other IDs (containers)
    for lid in small_other:
        result[lid] = (f"Container {lid}", "item")

    return result


async def repair():
    """Main repair function."""
    async with async_session_factory() as db:
        # Find all unique location_ids that still have NULL location_name
        stmt = select(Asset.location_id).where(
            Asset.location_name.is_(None)
        ).distinct()
        result = await db.execute(stmt)
        location_ids = {row[0] for row in result if row[0] is not None}

        if not location_ids:
            logger.info("No assets with NULL location_name found! All good.")
            return

        logger.info(f"Found {len(location_ids)} unique location_ids with NULL name")

        # Resolve names from ESI
        async with httpx.AsyncClient(
            headers={"User-Agent": "EVE Industrial Tool/1.0"},
            timeout=30,
        ) as http:
            resolved = await resolve_location_names(http, location_ids)

        # Update assets
        updated = 0
        for lid, (name, category) in resolved.items():
            if name is None:
                continue
            stmt = (
                update(Asset)
                .where(Asset.location_id == lid)
                .where(Asset.location_name.is_(None))
                .values(
                    location_name=name,
                    location_category=category,
                )
            )
            await db.execute(stmt)

        await db.commit()

        # Verify
        stmt = select(Asset.location_id).where(
            Asset.location_name.is_(None)
        ).distinct()
        result = await db.execute(stmt)
        remaining = {row[0] for row in result if row[0] is not None}

        if remaining:
            logger.warning(f"Still {len(remaining)} location_ids with NULL name")
        else:
            logger.info("SUCCESS: All location names resolved!")

        logger.info(f"Updated {len(resolved)} location_ids "
                     f"({len(location_ids) - len(remaining)} resolved)")


if __name__ == "__main__":
    asyncio.run(repair())
