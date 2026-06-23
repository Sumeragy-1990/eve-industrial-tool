"""SDE PostgreSQL Importer – downloads Fuzzwork's PostgreSQL dump and imports it.

This replaces the old YAML-based SDE importer with a much more complete
PostgreSQL-to-PostgreSQL import using Fuzzwork's weekly dumps.

What gets imported:
- invTypes → sde_items (complete item definitions)
- invGroups → group names + categories
- invCategories → category names
- invMetaGroups → meta group names
- invMarketGroups → market group names
- industryActivityMaterials → material requirements
- industryActivityProducts → product definitions
- industryActivitySkills → skill requirements
- industryBlueprints → blueprint definitions
- mapSolarSystems → solar system data
- mapRegions → region data
- staStations → station data
- invTypeReactions → reaction definitions (TODO)

Usage:
    from app.services.sde_pg_importer import import_sde_pg
    await import_sde_pg(db_session)
"""

import asyncio
import gzip
import io
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Optional, Callable

import httpx

from app.config import settings
from app.database import async_session_factory
from app.models.sde_item import SDEItem
from app.models.sde_blueprint import SDEBlueprint, SDEBlueprintMaterial, SDEBlueprintProduct, SDEBlueprintSkill
from app.models.sde_solar_system import SDESolarSystem, SDERegion, SDEStation

# Race name lookup (CCP raceID → display name)
RACE_NAMES = {
    1: "Caldari",
    2: "Minmatar",
    3: "Amarr",
    4: "Gallente",
}

logger = logging.getLogger(__name__)

# Fuzzwork dump URL templates (new CSV format)
FUZZWORK_BASE = "https://www.fuzzwork.co.uk/dump/latest/csv"
TABLE_URLS = {
    "invTypes": f"{FUZZWORK_BASE}/invTypes.csv",
    "invGroups": f"{FUZZWORK_BASE}/invGroups.csv",
    "invCategories": f"{FUZZWORK_BASE}/invCategories.csv",
    "invMetaGroups": f"{FUZZWORK_BASE}/invMetaGroups.csv",
    "invMarketGroups": f"{FUZZWORK_BASE}/invMarketGroups.csv",
    "industryActivityMaterials": f"{FUZZWORK_BASE}/industryActivityMaterials.csv",
    "industryActivityProducts": f"{FUZZWORK_BASE}/industryActivityProducts.csv",
    "industryActivitySkills": f"{FUZZWORK_BASE}/industryActivitySkills.csv",
    "industryBlueprints": f"{FUZZWORK_BASE}/industryBlueprints.csv",
    "mapSolarSystems": f"{FUZZWORK_BASE}/mapSolarSystems.csv",
    "mapRegions": f"{FUZZWORK_BASE}/mapRegions.csv",
    "mapConstellations": f"{FUZZWORK_BASE}/mapConstellations.csv",
    "staStations": f"{FUZZWORK_BASE}/staStations.csv",
    "invNames": f"{FUZZWORK_BASE}/invNames.csv",
    "industryActivities": f"{FUZZWORK_BASE}/industryActivities.csv",
}

# Category IDs that CCP uses
CATEGORY_SHIP = 6
CATEGORY_MODULE = 7
CATEGORY_CHARGE = 8
CATEGORY_BLUEPRINT = 9
CATEGORY_DRONE = 18
CATEGORY_IMPLANT = 20
CATEGORY_STRUCTURE = 65
CATEGORY_MATERIAL = 4


async def download_table(name: str, url: str) -> list[list[str]]:
    """Download a Fuzzwork CSV file and parse it into a list of rows.

    The dumps are standard CSV with quoted fields and header rows.
    """
    logger.info(f"Downloading {name} from {url} ...")
    async with httpx.AsyncClient(follow_redirects=True, timeout=600) as client:
        resp = await client.get(url)
        resp.raise_for_status()

    text = resp.text
    # Remove BOM if present
    if text.startswith('\ufeff'):
        text = text[1:]

    lines = text.strip().split("\n")
    if not lines:
        logger.warning(f"Empty download for {name}")
        return []

    # Skip header row (first line)
    rows = []
    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue
        parts = _parse_csv_line(line)
        rows.append(parts)

    logger.info(f"Downloaded {name}: {len(rows)} rows")
    return rows


def _parse_csv_line(line: str) -> list[str]:
    """Parse a CSV line handling quoted fields and escaped quotes."""
    parts = []
    current = []
    in_quotes = False
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == '"' and not in_quotes:
            in_quotes = True
        elif ch == '"' and in_quotes:
            if i + 1 < len(line) and line[i + 1] == '"':
                # Escaped quote ""
                current.append('"')
                i += 1
            else:
                in_quotes = False
        elif ch == ',' and not in_quotes:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    parts.append("".join(current))
    return parts


def _parse_int(val: str) -> Optional[int]:
    if not val or val == r"\N":
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def _parse_float(val: str) -> Optional[float]:
    if not val or val == r"\N":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _parse_bool(val: str) -> bool:
    return val.lower() in ("true", "t", "1") if val else False


async def import_sde_pg(
    db_session=None,
    progress_callback: Optional[Callable[[str, int], None]] = None,
) -> dict:
    """Main import function using Fuzzwork PostgreSQL dumps.

    Downloads all tables from Fuzzwork, parses them, and inserts into
    the local database. Much more complete than the old YAML importer.

    Returns stats dict with counts per table.
    """
    own_session = False
    if db_session is None:
        db_session = async_session_factory()
        own_session = True

    stats = {"total_errors": 0}

    try:
        # ── Step 1: Download lookup tables ──────────────────────
        if progress_callback:
            progress_callback("Downloading lookup tables...", 0)

        groups_raw = await download_table("invGroups", TABLE_URLS["invGroups"])
        categories_raw = await download_table("invCategories", TABLE_URLS["invCategories"])
        meta_groups_raw = await download_table("invMetaGroups", TABLE_URLS["invMetaGroups"])

        # Build lookup dicts
        group_names: dict[int, str] = {}
        group_categories: dict[int, int] = {}
        for row in groups_raw:
            gid = _parse_int(row[0])  # groupID
            if gid:
                group_names[gid] = row[2] if len(row) > 2 else ""  # groupName
                group_categories[gid] = _parse_int(row[1]) if len(row) > 1 else None  # categoryID

        category_names: dict[int, str] = {}
        for row in categories_raw:
            cid = _parse_int(row[0])  # categoryID
            if cid:
                category_names[cid] = row[1] if len(row) > 1 else ""  # categoryName

        meta_group_names: dict[int, str] = {}
        for row in meta_groups_raw:
            mgid = _parse_int(row[0])  # metaGroupID
            if mgid:
                meta_group_names[mgid] = row[1] if len(row) > 1 else ""  # metaGroupName

        # ── Step 2: Download and import invTypes ────────────────
        if progress_callback:
            progress_callback("Downloading item definitions...", 10)

        types_raw = await download_table("invTypes", TABLE_URLS["invTypes"])
        stats["types_imported"] = 0
        stats["types_skipped"] = 0
        stats["types_errors"] = 0

        type_id_to_name: dict[int, str] = {}

        for row in types_raw:
            try:
                type_id = _parse_int(row[0])
                if not type_id:
                    stats["types_skipped"] += 1
                    continue

                # Current Fuzzwork invTypes.csv columns:
                # 0:typeID 1:groupID 2:typeName 3:description 4:mass
                # 5:volume 6:capacity 7:portionSize 8:raceID 9:basePrice
                # 10:published 11:marketGroupID 12:iconID 13:soundID 14:graphicID
                name = row[2] if len(row) > 2 else ""
                if not name:
                    stats["types_skipped"] += 1
                    continue

                group_id = _parse_int(row[1]) if len(row) > 1 else None
                description = row[3] if len(row) > 3 else ""

                # Determine category from group lookup (category_id not in invTypes anymore)
                category_id = None
                if group_id:
                    category_id = group_categories.get(group_id)

                group_name = group_names.get(group_id, "")
                category_name = category_names.get(category_id, "")
                # NOTE: metaGroupID is NOT in current invTypes.csv (row[13] is soundID).
                # Could be derived from invMetaTypes table if needed later.
                meta_group_id = None
                meta_group_name = ""

                # Race / faction
                race_id = _parse_int(row[8]) if len(row) > 8 else None
                race_name = RACE_NAMES.get(race_id) if race_id else None

                mass = _parse_float(row[4]) if len(row) > 4 else None
                volume = _parse_float(row[5]) if len(row) > 5 else None
                capacity = _parse_float(row[6]) if len(row) > 6 else None
                radius = None  # Not in current Fuzzwork CSV

                tech_level = 1  # Not in current Fuzzwork CSV; derived from metaGroup later
                market_group_id = _parse_int(row[11]) if len(row) > 11 else None
                icon_id = _parse_int(row[12]) if len(row) > 12 else None
                graphic_id = _parse_int(row[14]) if len(row) > 14 else None

                # Determine item category flags
                is_bp = category_id == CATEGORY_BLUEPRINT
                is_ship = category_id == CATEGORY_SHIP
                is_module = category_id == CATEGORY_MODULE
                is_charge = category_id == CATEGORY_CHARGE
                is_drone = category_id == CATEGORY_DRONE
                is_implant = category_id == CATEGORY_IMPLANT
                is_structure = category_id == CATEGORY_STRUCTURE
                is_material = category_id == CATEGORY_MATERIAL
                is_skill = group_id == 505  # Skill group

                item = SDEItem(
                    type_id=type_id,
                    name=name,
                    description=description,
                    group_id=group_id,
                    group_name=group_name,
                    category_id=category_id,
                    category_name=category_name,
                    market_group_id=market_group_id,
                    meta_group_id=meta_group_id,
                    meta_group_name=meta_group_name,
                    race_id=race_id,
                    race_name=race_name,
                    mass=mass,
                    volume=volume,
                    capacity=capacity,
                    radius=radius,
                    tech_level=tech_level or 1,
                    is_blueprint=is_bp,
                    is_skill=is_skill,
                    is_ship=is_ship,
                    is_module=is_module,
                    is_charge=is_charge,
                    is_drone=is_drone,
                    is_implant=is_implant,
                    is_structure=is_structure,
                    is_material=is_material,
                    icon_id=icon_id,
                    graphic_id=graphic_id,
                )
                await db_session.merge(item)
                type_id_to_name[type_id] = name
                stats["types_imported"] += 1

                if progress_callback and stats["types_imported"] % 5000 == 0:
                    progress_caption = f"Importing items... ({stats['types_imported']} so far)"
                    progress_callback(progress_caption, 20)

            except Exception as e:
                logger.warning(f"Error importing type row: {e}")
                stats["types_errors"] += 1

        await db_session.commit()
        logger.info(f"Types imported: {stats['types_imported']}")

        # ── Step 3: Download and import blueprints ──────────────
        if progress_callback:
            progress_callback("Downloading blueprint data...", 40)

        bp_raw = await download_table("industryBlueprints", TABLE_URLS["industryBlueprints"])
        bp_materials_raw = await download_table("industryActivityMaterials", TABLE_URLS["industryActivityMaterials"])
        bp_products_raw = await download_table("industryActivityProducts", TABLE_URLS["industryActivityProducts"])
        bp_skills_raw = await download_table("industryActivitySkills", TABLE_URLS["industryActivitySkills"])
        activities_raw = await download_table("industryActivities", TABLE_URLS["industryActivities"])

        # Build (type_id, activity_id) → time_seconds lookup
        activity_times: dict = {}
        for _row in activities_raw:
            _t = _parse_int(_row[0])
            _a = _parse_int(_row[1])
            _s = _parse_int(_row[2])
            if _t and _a and _s:
                activity_times[(_t, _a)] = _s

        stats["blueprints"] = 0
        stats["materials"] = 0
        stats["products"] = 0
        stats["skills"] = 0

        # Blueprint definitions
        # NOTE: Fuzzwork's industryBlueprints.csv now has only 2 columns:
        #   typeID, maxProductionLimit
        # The product mapping (type_id → product_type_id) comes from
        # industryActivityProducts.csv (processed below).
        for row in bp_raw:
            try:
                type_id = _parse_int(row[0])
                if not type_id:
                    continue
                max_prod = _parse_int(row[1]) if len(row) > 1 else None
                bp = SDEBlueprint(
                    type_id=type_id,
                    product_type_id=None,  # resolved from industryActivityProducts below
                    product_name=None,
                    activity_id=1,  # industryBlueprints only contains manufacturing
                    max_production_limit=max_prod,
                    manufacturing_time=activity_times.get((type_id, 1)),
                    tech_level=None,
                    is_reaction=False,
                )
                await db_session.merge(bp)
                stats["blueprints"] += 1
            except Exception as e:
                logger.warning(f"Error importing blueprint {row[0] if row else '?'}: {e}")

        await db_session.commit()

        # Blueprint materials
        # FIX: Previously used merge() with an autoincrement PK, which never matched
        # existing rows → every import appended duplicates (2x, 3x, etc.).
        # Solution: DELETE all existing rows for affected blueprint_type_ids first,
        # then bulk-insert fresh data. This is safe because we re-import the full CSV.
        affected_bp_ids = set()
        mat_rows_to_insert = []
        for row in bp_materials_raw:
            try:
                type_id = _parse_int(row[0])
                activity_id = _parse_int(row[1])
                material_type_id = _parse_int(row[2])
                quantity = _parse_int(row[3])
                if not all([type_id, activity_id, material_type_id, quantity]):
                    continue
                affected_bp_ids.add(type_id)
                mat_rows_to_insert.append({
                    "blueprint_type_id": type_id,
                    "activity_id": activity_id,
                    "material_type_id": material_type_id,
                    "material_name": type_id_to_name.get(material_type_id, ""),
                    "quantity": quantity,
                })
            except Exception:
                pass

        # Wipe existing rows for all blueprint_type_ids we are about to import
        if affected_bp_ids:
            from sqlalchemy import delete as sa_delete
            from app.models.sde_blueprint import SDEBlueprintMaterial as _Mat
            await db_session.execute(
                sa_delete(_Mat).where(_Mat.blueprint_type_id.in_(list(affected_bp_ids)))
            )
            await db_session.commit()

        # Bulk-insert fresh rows
        for row_data in mat_rows_to_insert:
            db_session.add(SDEBlueprintMaterial(**row_data))
            stats["materials"] += 1

        await db_session.commit()

        # Blueprint products
        for row in bp_products_raw:
            try:
                type_id = _parse_int(row[0])
                activity_id = _parse_int(row[1])
                product_type_id = _parse_int(row[2])
                quantity = _parse_int(row[3])
                if not all([type_id, activity_id, product_type_id, quantity]):
                    continue

                prob = _parse_float(row[4]) if len(row) > 4 else None
                prod = SDEBlueprintProduct(
                    type_id=type_id,
                    activity_id=activity_id,
                    product_type_id=product_type_id,
                    product_name=type_id_to_name.get(product_type_id, ""),
                    quantity=quantity,
                    probability=prob,
                )
                await db_session.merge(prod)
                stats["products"] += 1
            except Exception:
                pass

        await db_session.commit()

        # Blueprint skills
        # FIX: merge() with autoincrement PK always inserts → duplicates after re-import.
        # Solution: DELETE all existing rows for affected type_ids first, then bulk-INSERT.
        affected_skill_bp_ids = set()
        skill_rows_to_insert = []
        for row in bp_skills_raw:
            try:
                type_id = _parse_int(row[0])
                activity_id = _parse_int(row[1])
                skill_type_id = _parse_int(row[2])
                level = _parse_int(row[3])
                if not all([type_id, activity_id, skill_type_id, level]):
                    continue
                affected_skill_bp_ids.add(type_id)
                skill_rows_to_insert.append({
                    "type_id": type_id,
                    "activity_id": activity_id,
                    "skill_type_id": skill_type_id,
                    "skill_name": type_id_to_name.get(skill_type_id, ""),
                    "level": level,
                })
            except Exception:
                pass

        if affected_skill_bp_ids:
            from sqlalchemy import delete as sa_delete
            from app.models.sde_blueprint import SDEBlueprintSkill as _Skill
            await db_session.execute(
                sa_delete(_Skill).where(_Skill.type_id.in_(list(affected_skill_bp_ids)))
            )
            await db_session.commit()

        for row_data in skill_rows_to_insert:
            db_session.add(SDEBlueprintSkill(**row_data))
            stats["skills"] += 1

        await db_session.commit()

        if progress_callback:
            progress_callback("Downloading solar system data...", 60)

        # ── Step 4: Solar systems and regions ───────────────────
        regions_raw = await download_table("mapRegions", TABLE_URLS["mapRegions"])
        const_raw = await download_table("mapConstellations", TABLE_URLS["mapConstellations"])
        systems_raw = await download_table("mapSolarSystems", TABLE_URLS["mapSolarSystems"])

        stats["regions"] = 0
        stats["systems"] = 0

        region_names: dict[int, str] = {}
        for row in regions_raw:
            rid = _parse_int(row[0])
            if rid:
                name = row[1] if len(row) > 1 else ""  # regionName
                region_names[rid] = name
                region = SDERegion(region_id=rid, region_name=name)
                await db_session.merge(region)
                stats["regions"] += 1

        const_names: dict[int, str] = {}
        const_regions: dict[int, int] = {}
        for row in const_raw:
            cid = _parse_int(row[1])  # constellationID
            if cid:
                const_names[cid] = row[2] if len(row) > 2 else ""  # constellationName
                const_regions[cid] = _parse_int(row[0])  # regionID

        for row in systems_raw:
            try:
                sid = _parse_int(row[2])  # solarSystemID
                if not sid:
                    continue
                name = row[3] if len(row) > 3 else ""  # solarSystemName
                const_id = _parse_int(row[1]) if len(row) > 1 else None  # constellationID
                sec = _parse_float(row[21]) if len(row) > 21 else None  # security

                const_name = const_names.get(const_id, "")
                reg_id = const_regions.get(const_id)
                reg_name = region_names.get(reg_id, "")

                system = SDESolarSystem(
                    system_id=sid,
                    system_name=name,
                    constellation_id=const_id,
                    constellation_name=const_name,
                    region_id=reg_id,
                    region_name=reg_name,
                    security_status=sec,
                )
                await db_session.merge(system)
                stats["systems"] += 1
            except Exception as e:
                logger.warning(f"Error importing system: {e}")

        await db_session.commit()

        if progress_callback:
            progress_callback("Downloading station data...", 80)

        # ── Step 5: Stations ─────────────────────────────────────
        stations_raw = await download_table("staStations", TABLE_URLS["staStations"])
        stats["stations"] = 0

        for row in stations_raw:
            try:
                station_id = _parse_int(row[0])  # stationID
                if not station_id:
                    continue
                name = row[11] if len(row) > 11 else ""  # stationName
                system_id = _parse_int(row[8]) if len(row) > 8 else None  # solarSystemID
                station_type_id = _parse_int(row[6]) if len(row) > 6 else None  # stationTypeID

                # Resolve system/region names
                system_name = ""
                region_id = None
                region_name = ""
                sec = None

                if system_id:
                    # Simple lookup from memory
                    stmt = f"SELECT system_name, region_id, region_name, security_status "\
                           f"FROM sde_solar_systems WHERE system_id = {system_id}"
                    try:
                        result = await db_session.execute(stmt)
                        row_sys = result.fetchone()
                        if row_sys:
                            system_name = row_sys[0] or ""
                            region_id = row_sys[1]
                            region_name = row_sys[2] or ""
                            sec = row_sys[3]
                    except Exception:
                        pass

                station = SDEStation(
                    station_id=station_id,
                    station_name=name,
                    system_id=system_id,
                    system_name=system_name,
                    region_id=region_id,
                    region_name=region_name,
                    station_type_id=station_type_id,
                    security=sec,
                )
                await db_session.merge(station)
                stats["stations"] += 1
            except Exception:
                pass

        await db_session.commit()

        if progress_callback:
            progress_callback("SDE import complete!", 100)

        logger.info(f"SDE PG import complete: {json.dumps(stats)}")
        return stats

    except Exception as e:
        logger.error(f"SDE PG import failed: {e}", exc_info=True)
        stats["total_errors"] += 1
        raise
    finally:
        if own_session:
            await db_session.close()


async def run_import():
    """Run the SDE import as a standalone script."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    logger.info("Starting SDE PostgreSQL import ...")
    from app.database import init_db
    await init_db()
    stats = await import_sde_pg()
    logger.info(f"Done! Stats: {json.dumps(stats)}")


if __name__ == "__main__":
    asyncio.run(run_import())
