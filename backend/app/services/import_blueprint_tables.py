"""One-shot import for missing blueprint SDE tables (industryBlueprints, industryActivityProducts, etc.).

The initial bootstrap imported sde_items (invTypes) but failed to import the
industry-related tables because:
1. industryBlueprints.csv now has only 2 columns (typeID, maxProductionLimit)
   but the old importer expected more columns → IndexError on every row
2. The other tables (products, materials, skills, stations) were skipped because
   the bootstrap was interrupted after the invTypes import

This script downloads and imports ONLY the missing tables.
"""

import asyncio
import csv
import io
import logging
from typing import Optional

from sqlalchemy import text

import httpx

from app.database import async_session_factory
from app.models.sde_blueprint import SDEBlueprint, SDEBlueprintMaterial, SDEBlueprintProduct, SDEBlueprintSkill
from app.models.sde_solar_system import SDESolarSystem, SDERegion, SDEStation
from app.models.sde_item import SDEItem

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("import_blueprint_tables")

FUZZWORK_BASE = "https://www.fuzzwork.co.uk/dump/latest/csv"

TABLE_URLS = {
    "industryBlueprints": f"{FUZZWORK_BASE}/industryBlueprints.csv",
    "industryActivityMaterials": f"{FUZZWORK_BASE}/industryActivityMaterials.csv",
    "industryActivityProducts": f"{FUZZWORK_BASE}/industryActivityProducts.csv",
    "industryActivitySkills": f"{FUZZWORK_BASE}/industryActivitySkills.csv",
    "mapRegions": f"{FUZZWORK_BASE}/mapRegions.csv",
    "mapConstellations": f"{FUZZWORK_BASE}/mapConstellations.csv",
    "mapSolarSystems": f"{FUZZWORK_BASE}/mapSolarSystems.csv",
    "staStations": f"{FUZZWORK_BASE}/staStations.csv",
}

RACE_NAMES = {1: "Caldari", 2: "Minmatar", 3: "Amarr", 4: "Gallente"}


def parse_int(val: str) -> Optional[int]:
    if not val or val == r"\N":
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def parse_float(val: str) -> Optional[float]:
    if not val or val == r"\N":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


async def download_csv(url: str) -> list[list[str]]:
    logger.info(f"Downloading {url} ...")
    async with httpx.AsyncClient(follow_redirects=True, timeout=600) as client:
        resp = await client.get(url)
        resp.raise_for_status()
    text = resp.text
    if text.startswith('\ufeff'):
        text = text[1:]
    reader = csv.reader(io.StringIO(text))
    rows = []
    for i, row in enumerate(reader):
        if i == 0:
            continue  # skip header
        rows.append(row)
    logger.info(f"  → {len(rows)} rows")
    return rows


async def main():
    # Build type_id → name lookup from existing sde_items
    async with async_session_factory() as db:
        logger.info("Building type_id → name lookup from sde_items ...")
        from sqlalchemy import text
        result = await db.execute(text("SELECT type_id, name FROM sde_items"))
        type_id_to_name: dict[int, str] = {}
        for row in result.all():
            type_id_to_name[row[0]] = row[1]
        logger.info(f"  → {len(type_id_to_name)} items loaded")

        # ── 1. Import industryBlueprints → sde_blueprints ──────
        logger.info("=== Importing industryBlueprints → sde_blueprints ===")
        bp_raw = await download_csv(TABLE_URLS["industryBlueprints"])
        count = 0
        errors = 0
        for row in bp_raw:
            try:
                type_id = parse_int(row[0])
                if not type_id:
                    continue
                max_prod = parse_int(row[1]) if len(row) > 1 else None
                bp = SDEBlueprint(
                    type_id=type_id,
                    product_type_id=None,
                    product_name=None,
                    activity_id=1,
                    max_production_limit=max_prod,
                    manufacturing_time=None,
                    tech_level=None,
                    is_reaction=False,
                )
                # Check if product info exists in sde_blueprint_products
                result = await db.execute(
                    text("SELECT product_type_id, product_name FROM sde_blueprint_products WHERE type_id = :tid AND activity_id = 1"),
                    {"tid": type_id},
                )
                prod_row = result.fetchone()
                if prod_row and prod_row[0]:
                    bp.product_type_id = prod_row[0]
                    bp.product_name = prod_row[1] or type_id_to_name.get(prod_row[0], "")
                await db.merge(bp)
                count += 1
            except Exception as e:
                logger.warning(f"  Error importing blueprint: {e}")
                errors += 1
        await db.commit()
        logger.info(f"  Imported: {count}, Errors: {errors}")

        # ── 2. Import industryActivityProducts → sde_blueprint_products ──
        logger.info("=== Importing industryActivityProducts → sde_blueprint_products ===")
        prod_raw = await download_csv(TABLE_URLS["industryActivityProducts"])
        count = 0
        errors = 0
        for row in prod_raw:
            try:
                type_id = parse_int(row[0])
                activity_id = parse_int(row[1])
                product_type_id = parse_int(row[2])
                quantity = parse_int(row[3])
                if not all([type_id, activity_id, product_type_id, quantity]):
                    continue
                prob = parse_float(row[4]) if len(row) > 4 else None
                prod = SDEBlueprintProduct(
                    type_id=type_id,
                    activity_id=activity_id,
                    product_type_id=product_type_id,
                    product_name=type_id_to_name.get(product_type_id, ""),
                    quantity=quantity,
                    probability=prob,
                )
                await db.merge(prod)
                count += 1
            except Exception:
                errors += 1
        await db.commit()
        logger.info(f"  Imported: {count}, Errors: {errors}")

        # ── 3. Update sde_blueprints.product_type_id/product_name from products ──
        logger.info("=== Updating sde_blueprints with product info from sde_blueprint_products ===")
        await db.execute(text("""
            UPDATE sde_blueprints sb
            SET
                product_type_id = sbp.product_type_id,
                product_name = sbp.product_name
            FROM sde_blueprint_products sbp
            WHERE sbp.type_id = sb.type_id
              AND sbp.activity_id = 1
              AND sb.product_type_id IS NULL
        """))
        await db.commit()
        r = await db.execute(text("SELECT COUNT(*) FROM sde_blueprints WHERE product_type_id IS NOT NULL"))
        logger.info(f"  Updated: {r.scalar()} blueprints with product info")

        # ── 4. Import industryActivityMaterials → sde_blueprint_materials ──
        # NOTE: Uses TRUNCATE + bulk INSERT instead of db.merge() because the
        # SDEBlueprintMaterial model has an auto-increment 'id' PK without a
        # natural-key unique constraint on (type_id, activity_id, material_type_id),
        # so merge() always inserts new rows, creating duplicates on re-import.
        # Migration 012 adds the UNIQUE constraint; this code then bulk-inserts
        # and relies on ON CONFLICT DO NOTHING for idempotency.
        logger.info("=== Importing industryActivityMaterials → sde_blueprint_materials ===")
        mat_raw = await download_csv(TABLE_URLS["industryActivityMaterials"])
        count = 0
        errors = 0
        # Truncate before re-import to guarantee clean data
        await db.execute(text("TRUNCATE TABLE sde_blueprint_materials RESTART IDENTITY CASCADE"))
        values = []
        for row in mat_raw:
            try:
                type_id = parse_int(row[0])
                activity_id = parse_int(row[1])
                material_type_id = parse_int(row[2])
                quantity = parse_int(row[3])
                if not all([type_id, activity_id, material_type_id, quantity]):
                    continue
                mat_name = type_id_to_name.get(material_type_id, "")
                values.append(
                    f"({type_id},{activity_id},{material_type_id},"
                    f"'{mat_name.replace(chr(39), chr(39)+chr(39))}',{quantity},false)"
                )
                count += 1
            except Exception:
                errors += 1
        # Bulk insert via raw SQL for performance (~300K rows)
        if values:
            batch_size = 5000
            for i in range(0, len(values), batch_size):
                batch = values[i:i + batch_size]
                sql = (
                    "INSERT INTO sde_blueprint_materials "
                    "(type_id, activity_id, material_type_id, material_name, quantity, is_optional) "
                    "VALUES " + ",".join(batch) + " ON CONFLICT ON CONSTRAINT uq_sde_blueprint_materials "
                    "DO UPDATE SET quantity = EXCLUDED.quantity, material_name = EXCLUDED.material_name"
                )
                await db.execute(text(sql))
        await db.commit()
        logger.info(f"  Imported: {count}, Errors: {errors}")

        # ── 5. Import industryActivitySkills → sde_blueprint_skills ──
        logger.info("=== Importing industryActivitySkills → sde_blueprint_skills ===")
        sk_raw = await download_csv(TABLE_URLS["industryActivitySkills"])
        count = 0
        errors = 0
        for row in sk_raw:
            try:
                type_id = parse_int(row[0])
                activity_id = parse_int(row[1])
                skill_type_id = parse_int(row[2])
                level = parse_int(row[3])
                if not all([type_id, activity_id, skill_type_id, level]):
                    continue
                skill = SDEBlueprintSkill(
                    type_id=type_id,
                    activity_id=activity_id,
                    skill_type_id=skill_type_id,
                    skill_name=type_id_to_name.get(skill_type_id, ""),
                    level=level,
                )
                await db.merge(skill)
                count += 1
            except Exception:
                errors += 1
        await db.commit()
        logger.info(f"  Imported: {count}, Errors: {errors}")

        # ── 6. Import solar systems + stations (also missing) ──
        logger.info("=== Importing mapRegions → sde_regions ===")
        regions_raw = await download_csv(TABLE_URLS["mapRegions"])
        region_names: dict[int, str] = {}
        count = 0
        for row in regions_raw:
            rid = parse_int(row[0])
            if rid:
                name = row[2] if len(row) > 2 else ""
                region_names[rid] = name
                region = SDERegion(region_id=rid, region_name=name)
                await db.merge(region)
                count += 1
        await db.commit()
        logger.info(f"  Imported: {count} regions")

        logger.info("=== Importing mapConstellations ===")
        const_raw = await download_csv(TABLE_URLS["mapConstellations"])
        const_names: dict[int, str] = {}
        const_regions: dict[int, int] = {}
        for row in const_raw:
            cid = parse_int(row[0])
            if cid:
                const_names[cid] = row[2] if len(row) > 2 else ""
                const_regions[cid] = parse_int(row[1]) if len(row) > 1 else None

        logger.info("=== Importing mapSolarSystems → sde_solar_systems ===")
        sys_raw = await download_csv(TABLE_URLS["mapSolarSystems"])
        count = 0
        errors = 0
        for row in sys_raw:
            try:
                sid = parse_int(row[0])
                if not sid:
                    continue
                name = row[2] if len(row) > 2 else ""
                const_id = parse_int(row[1]) if len(row) > 1 else None
                sec = parse_float(row[25]) if len(row) > 25 else None
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
                await db.merge(system)
                count += 1
            except Exception as e:
                logger.warning(f"  Error importing system: {e}")
                errors += 1
        await db.commit()
        logger.info(f"  Imported: {count}, Errors: {errors}")

        logger.info("=== Importing staStations → sde_stations ===")
        st_raw = await download_csv(TABLE_URLS["staStations"])
        count = 0
        errors = 0
        for row in st_raw:
            try:
                station_id = parse_int(row[0])
                if not station_id:
                    continue
                name = row[4] if len(row) > 4 else ""
                system_id = parse_int(row[3]) if len(row) > 3 else None
                station_type_id = parse_int(row[5]) if len(row) > 5 else None
                system_name = ""
                region_id = None
                region_name = ""
                sec = None
                if system_id:
                    result = await db.execute(
                        text("SELECT system_name, region_id, region_name, security_status FROM sde_solar_systems WHERE system_id = :sid"),
                        {"sid": system_id},
                    )
                    sr = result.fetchone()
                    if sr:
                        system_name = sr[0] or ""
                        region_id = sr[1]
                        region_name = sr[2] or ""
                        sec = sr[3]
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
                await db.merge(station)
                count += 1
            except Exception:
                errors += 1
        await db.commit()
        logger.info(f"  Imported: {count}, Errors: {errors}")

        # ── Final summary ──
        tables = [
            "sde_blueprints", "sde_blueprint_products", "sde_blueprint_materials",
            "sde_blueprint_skills", "sde_solar_systems", "sde_regions", "sde_stations",
        ]
        for t in tables:
            r = await db.execute(text(f"SELECT COUNT(*) FROM {t}"))
            logger.info(f"  {t}: {r.scalar()} rows")

    logger.info("=== Import complete! ===")


if __name__ == "__main__":
    asyncio.run(main())
