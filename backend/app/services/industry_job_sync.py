"""Industry Job sync service – fetches jobs from ESI and stores them."""

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.character import Character
from app.models.industry_job import IndustryJob
from app.models.sde_item import SDEItem
from app.services.esi_client import ESIClient

logger = logging.getLogger(__name__)

# Activity ID → name mapping
ACTIVITY_NAMES = {
    1: "Manufacturing",
    3: "Invention",
    4: "Time Efficiency Research",
    5: "Material Efficiency Research",
    8: "Reactions",
    11: "Copying",
}

# Statuses we consider "active" (not yet finished)
ACTIVE_STATUSES = {"active", "paused"}


async def _resolve_type_name(db: AsyncSession, type_id: int) -> Optional[str]:
    """Look up an item name from SDE by type_id."""
    stmt = select(SDEItem.name).where(SDEItem.type_id == type_id)
    name = await db.scalar(stmt)
    return name


async def sync_character_industry_jobs(
    db: AsyncSession,
    character: Character,
) -> dict:
    """Sync industry jobs for a single character from ESI."""
    client = ESIClient(db)
    try:
        logger.info(
            f"Syncing industry jobs for {character.character_name} (ID={character.character_id})"
        )

        jobs_data = await client.get_character_industry_jobs(character)
        logger.info(f"Got {len(jobs_data)} industry jobs from ESI for character")

        now = datetime.now(timezone.utc)
        synced_ids: list[int] = []
        type_cache: dict[int, str] = {}

        for job in jobs_data:
            job_id = job.get("job_id")
            if not job_id:
                continue

            synced_ids.append(job_id)

            # Resolve blueprint type name
            bp_type_id = job.get("blueprint_type_id")
            bp_name = type_cache.get(bp_type_id)
            if bp_name is None and bp_type_id:
                bp_name = await _resolve_type_name(db, bp_type_id)
                type_cache[bp_type_id] = bp_name or f"Unknown ({bp_type_id})"

            # Resolve product type name
            prod_type_id = job.get("product_type_id")
            prod_name = type_cache.get(prod_type_id)
            if prod_name is None and prod_type_id:
                prod_name = await _resolve_type_name(db, prod_type_id)
                type_cache[prod_type_id] = prod_name or f"Unknown ({prod_type_id})"

            # Convert ESI timestamps
            start_date = _parse_esi_time(job.get("start_date"))
            end_date = _parse_esi_time(job.get("end_date"))

            installer_name = None
            installer_id = job.get("installer_id")
            if installer_id:
                # Try to get from local characters first
                char_stmt = select(Character.character_name).where(
                    Character.character_id == installer_id
                )
                installer_name = await db.scalar(char_stmt)

            # Build the model object
            industry_job = IndustryJob(
                job_id=job_id,
                character_id=character.character_id,
                corporation_id=character.corporation_id,
                blueprint_type_id=bp_type_id,
                blueprint_type_name=bp_name or f"Unknown ({bp_type_id})",
                product_type_id=prod_type_id,
                product_type_name=prod_name,
                activity_id=job.get("activity_id"),
                runs=job.get("runs", 1),
                status=job.get("status", "unknown"),
                start_date=start_date,
                end_date=end_date,
                duration=job.get("duration"),
                location_id=job.get("location_id"),
                facility_id=job.get("facility_id"),
                cost=job.get("cost"),
                licensed_runs=job.get("licensed_runs"),
                probability=job.get("probability"),
                successful_runs=job.get("successful_runs"),
                installer_id=installer_id,
                installer_name=installer_name,
                is_corp_job=False,
                last_synced=now,
            )
            await db.merge(industry_job)

        await db.commit()

        return {
            "character_id": character.character_id,
            "character_name": character.character_name,
            "jobs_found": len(jobs_data),
            "jobs_stored": len(synced_ids),
        }
    finally:
        await client.close()


async def sync_corporation_industry_jobs(
    db: AsyncSession,
    character: Character,
    corporation_id: int,
) -> dict:
    """Sync industry jobs for a corporation (requires Director role)."""
    client = ESIClient(db)
    try:
        logger.info(
            f"Syncing corp industry jobs for corp {corporation_id} "
            f"via {character.character_name}"
        )

        jobs_data = await client.get_corporation_industry_jobs(character, corporation_id)
        logger.info(f"Got {len(jobs_data)} industry jobs from ESI for corporation")

        now = datetime.now(timezone.utc)
        synced_ids: list[int] = []
        type_cache: dict[int, str] = {}

        for job in jobs_data:
            job_id = job.get("job_id")
            if not job_id:
                continue

            synced_ids.append(job_id)

            # Resolve blueprint type name
            bp_type_id = job.get("blueprint_type_id")
            bp_name = type_cache.get(bp_type_id)
            if bp_name is None and bp_type_id:
                bp_name = await _resolve_type_name(db, bp_type_id)
                type_cache[bp_type_id] = bp_name or f"Unknown ({bp_type_id})"

            # Resolve product type name
            prod_type_id = job.get("product_type_id")
            prod_name = type_cache.get(prod_type_id)
            if prod_name is None and prod_type_id:
                prod_name = await _resolve_type_name(db, prod_type_id)
                type_cache[prod_type_id] = prod_name or f"Unknown ({prod_type_id})"

            start_date = _parse_esi_time(job.get("start_date"))
            end_date = _parse_esi_time(job.get("end_date"))

            installer_name = None
            installer_id = job.get("installer_id")
            if installer_id:
                char_stmt = select(Character.character_name).where(
                    Character.character_id == installer_id
                )
                installer_name = await db.scalar(char_stmt)

            # Determine character_id from the job (each corp job belongs to a character)
            char_id = job.get("installer_id") or character.character_id

            industry_job = IndustryJob(
                job_id=job_id,
                character_id=char_id,
                corporation_id=corporation_id,
                blueprint_type_id=bp_type_id,
                blueprint_type_name=bp_name or f"Unknown ({bp_type_id})",
                product_type_id=prod_type_id,
                product_type_name=prod_name,
                activity_id=job.get("activity_id"),
                runs=job.get("runs", 1),
                status=job.get("status", "unknown"),
                start_date=start_date,
                end_date=end_date,
                duration=job.get("duration"),
                location_id=job.get("location_id"),
                facility_id=job.get("facility_id"),
                cost=job.get("cost"),
                licensed_runs=job.get("licensed_runs"),
                probability=job.get("probability"),
                successful_runs=job.get("successful_runs"),
                installer_id=installer_id,
                installer_name=installer_name,
                is_corp_job=True,
                last_synced=now,
            )
            await db.merge(industry_job)

        await db.commit()

        return {
            "corporation_id": corporation_id,
            "jobs_found": len(jobs_data),
            "jobs_stored": len(synced_ids),
        }
    finally:
        await client.close()


def _parse_esi_time(time_str: Optional[str]) -> Optional[datetime]:
    """Parse an ESI ISO-8601 timestamp string to datetime."""
    if not time_str:
        return None
    try:
        return datetime.fromisoformat(time_str.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
