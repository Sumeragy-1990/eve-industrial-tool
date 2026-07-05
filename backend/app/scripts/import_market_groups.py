"""Standalone script: Import only invMarketGroups into sde_market_groups.

Run inside the backend container:
    python -m app.scripts.import_market_groups

Downloads invMarketGroups.csv from Fuzzwork, parses it, and inserts into
the sde_market_groups table using the existing async DB session.
"""

import asyncio
import csv
import io
import logging
from typing import Optional

import httpx

from app.database import async_session_factory
from app.services.sde_pg_importer import _parse_int
from app.models.sde_market_group import SDEMarketGroup

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

TABLE_URLS = {
    "invMarketGroups": "https://www.fuzzwork.co.uk/dump/latest/invMarketGroups.csv",
}


async def download_csv(url: str) -> str:
    logger.info(f"Downloading {url} ...")
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
    logger.info(f"Downloaded {len(resp.text)} bytes")
    return resp.text


async def main():
    csv_text = await download_csv(TABLE_URLS["invMarketGroups"])

    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    logger.info(f"Parsed {len(rows)} rows from CSV")

    async with async_session_factory() as db:
        count = 0
        for row in rows:
            try:
                mgid = _parse_int(row[0])  # marketGroupID
                if not mgid:
                    continue
                parent_id = _parse_int(row[1])  # parentGroupID
                name = row[2] if len(row) > 2 else ""
                desc = row[3] if len(row) > 3 else ""
                icon_id = _parse_int(row[4]) if len(row) > 4 else None
                has_types = _parse_int(row[5]) if len(row) > 5 else 1

                mg = SDEMarketGroup(
                    market_group_id=mgid,
                    parent_group_id=parent_id,
                    name=name,
                    description=desc,
                    icon_id=icon_id,
                    has_types=bool(has_types),
                )
                await db.merge(mg)
                count += 1

                if count % 500 == 0:
                    logger.info(f"  ... {count} market groups imported")
            except Exception as e:
                logger.warning(f"Error importing row {row[0] if row else '?'}: {e}")

        await db.commit()
        logger.info(f"Done! Imported {count} market groups.")


if __name__ == "__main__":
    asyncio.run(main())
