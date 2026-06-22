"""One-time migration: Add race_id/race_name to existing sde_items from invTypes.csv.

Downloads the latest invTypes.csv from Fuzzwork, parses type_id+raceID,
and updates the sde_items table. This avoids a full SDE re-import.
"""

import asyncio
import csv
import io
import logging

import httpx
from sqlalchemy import text

from app.database import async_session_factory

logger = logging.getLogger(__name__)

# Race name lookup (CCP raceID → display name)
RACE_NAMES = {
    1: "Caldari",
    2: "Minmatar",
    3: "Amarr",
    4: "Gallente",
}

INVTYPES_URL = "https://www.fuzzwork.co.uk/dump/latest/csv/invTypes.csv"


async def ensure_columns(session):
    """Add race_id/race_name columns if they don't exist yet."""
    for col, col_type in [("race_id", "INTEGER"), ("race_name", "VARCHAR(32)")]:
        stmt = text(f"ALTER TABLE sde_items ADD COLUMN IF NOT EXISTS {col} {col_type}")
        await session.execute(stmt)
    await session.commit()
    logger.info("Columns race_id/race_name ensured on sde_items")


async def update_race_data():
    """Download invTypes.csv and update race_id/race_name in sde_items."""
    logger.info("Downloading invTypes.csv from Fuzzwork ...")
    async with httpx.AsyncClient(follow_redirects=True, timeout=600) as client:
        resp = await client.get(INVTYPES_URL)
        resp.raise_for_status()

    csv_text = resp.text
    if csv_text.startswith('\ufeff'):
        csv_text = csv_text[1:]

    reader = csv.DictReader(io.StringIO(csv_text))
    
    # Build lookup: type_id → race_id
    race_map: dict[int, int] = {}
    total = 0
    for row in reader:
        type_id_str = row.get("typeID", "").strip()
        race_id_str = row.get("raceID", "").strip()
        if type_id_str and race_id_str:
            try:
                type_id = int(type_id_str)
                race_id = int(float(race_id_str))  # handle "1.0" format
                if race_id > 0:
                    race_map[type_id] = race_id
            except (ValueError, TypeError):
                pass
        total += 1

    logger.info(f"Parsed {total} types, found {len(race_map)} with raceID")

    # Update sde_items using bulk VALUES-based UPDATE
    async with async_session_factory() as session:
        await ensure_columns(session)

        items = list(race_map.items())
        updated = 0
        errors = 0
        chunk_size = 500

        for i in range(0, len(items), chunk_size):
            chunk = items[i:i + chunk_size]
            
            # Build VALUES clause for bulk UPDATE
            value_rows = []
            params = {}
            for idx, (type_id, race_id) in enumerate(chunk):
                race_name = RACE_NAMES.get(race_id)
                if not race_name:
                    continue
                t = f"t{idx}"
                value_rows.append(f"(:{t}_tid, :{t}_rid, :{t}_rnm)")
                params[f"{t}_tid"] = str(type_id)
                params[f"{t}_rid"] = str(race_id)
                params[f"{t}_rnm"] = race_name

            if not value_rows:
                continue

            stmt = text(f"""
                UPDATE sde_items AS s
                SET race_id = v.race_id::int, race_name = v.race_name
                FROM (VALUES {', '.join(value_rows)}) AS v(type_id, race_id, race_name)
                WHERE s.type_id = v.type_id::int
            """)
            result = await session.execute(stmt, params)
            await session.commit()
            updated += result.rowcount
            logger.info(f"Progress: {updated}/{len(race_map)} updated (chunk {i // chunk_size + 1})")

        logger.info(f"Done! Updated: {updated}, Errors: {errors}")
        return {"updated": updated, "errors": errors, "total_races": len(race_map)}


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    from app.database import init_db
    await init_db()
    result = await update_race_data()
    logger.info(f"Result: {result}")


if __name__ == "__main__":
    asyncio.run(main())
