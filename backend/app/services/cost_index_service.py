"""Cost Index Service – sync and lookup ESI industry system cost indices (Bug 6).

Caches ESI /industry/systems/ data in system_cost_indices table.
Provides modular lookup by system name or ID, returning all 6 activity indices.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.system_cost_index import SystemCostIndex
from app.services.esi_client import ESIClient

logger = logging.getLogger(__name__)

# ── Sync ────────────────────────────────────────────────────────────

# Map ESI activity names (from /industry/systems/) to our column names
# ESI uses: manufacturing, researching_time_efficiency, researching_material_efficiency,
#           copying, invention, reaction
ESI_ACTIVITY_MAP = {
    "manufacturing": "manufacturing",
    "researching_time_efficiency": "research_time",
    "researching_material_efficiency": "research_material",
    "invention": "invention",
    "copying": "copying",
    "reaction": "reactions",
}


async def sync_all_cost_indices(db: AsyncSession) -> dict:
    """Fetch all systems from ESI /industry/systems/ and upsert into DB.

    Returns summary dict with total_synced and errors.
    """
    # Pre-load SDE system names for name resolution
    sde_systems = {}
    try:
        from app.models.sde_solar_system import SDESolarSystem
        stmt = select(SDESolarSystem)
        result = await db.execute(stmt)
        for row in result.scalars().all():
            sde_systems[row.system_id] = row
    except Exception:
        logger.warning("Could not load SDE systems for name resolution")

    client = ESIClient(db)
    try:
        systems = await client.get_industry_systems()
    except Exception as e:
        logger.exception("ESI industry systems fetch failed")
        return {"total_synced": 0, "error": str(e)}
    finally:
        await client.close()

    if not systems:
        return {"total_synced": 0, "error": "Empty response from ESI"}

    synced = 0
    now = datetime.now(timezone.utc)

    for s in systems:
        system_id = s.get("solar_system_id")
        if not system_id:
            continue

        # Build index columns from ESI cost_indices array
        index_values = {}
        for idx in s.get("cost_indices", []):
            activity = idx.get("activity")
            col = ESI_ACTIVITY_MAP.get(activity)
            if col:
                index_values[col] = idx.get("cost_index")

        # Resolve system name from SDE (ESI doesn't return names)
        sde_sys = sde_systems.get(system_id)
        system_name = sde_sys.system_name if sde_sys else s.get("system_name") or _resolve_system_name(system_id)
        region_name = sde_sys.region_name if sde_sys else s.get("region_name")
        security_status = sde_sys.security_status if sde_sys else s.get("security_status")

        # Upsert via INSERT … ON CONFLICT
        stmt = text("""
            INSERT INTO system_cost_indices
                (solar_system_id, system_name, region_name, security_status,
                 manufacturing, research_time, research_material, invention, copying, reactions,
                 synced_at)
            VALUES (
                :sid, :sname, :rname, :sec,
                :mfg, :rtime, :rmat, :inv, :copy, :react,
                :synced
            )
            ON CONFLICT (solar_system_id) DO UPDATE SET
                system_name = EXCLUDED.system_name,
                region_name = COALESCE(EXCLUDED.region_name, system_cost_indices.region_name),
                security_status = EXCLUDED.security_status,
                manufacturing = EXCLUDED.manufacturing,
                research_time = EXCLUDED.research_time,
                research_material = EXCLUDED.research_material,
                invention = EXCLUDED.invention,
                copying = EXCLUDED.copying,
                reactions = EXCLUDED.reactions,
                synced_at = EXCLUDED.synced_at
        """)

        await db.execute(stmt, {
            "sid": system_id,
            "sname": system_name,
            "rname": region_name,
            "sec": security_status,
            "mfg": index_values.get("manufacturing"),
            "rtime": index_values.get("research_time"),
            "rmat": index_values.get("research_material"),
            "inv": index_values.get("invention"),
            "copy": index_values.get("copying"),
            "react": index_values.get("reactions"),
            "synced": now,
        })
        synced += 1

    await db.commit()
    logger.info("Synced %d system cost indices from ESI", synced)
    return {"total_synced": synced, "error": None}


def _resolve_system_name(system_id: int) -> str:
    """Fallback: build a placeholder name if SDE data not available."""
    return f"System-{system_id}"


# ── Lookup ──────────────────────────────────────────────────────────

async def get_cost_indices_by_system_id(
    db: AsyncSession, system_id: int
) -> Optional[SystemCostIndex]:
    """Look up cost indices for a system by its solar_system_id."""
    stmt = select(SystemCostIndex).where(
        SystemCostIndex.solar_system_id == system_id
    )
    result = await db.execute(stmt)
    return result.scalars().first()


async def get_cost_indices_by_name(
    db: AsyncSession, system_name: str
) -> Optional[dict]:
    """Look up cost indices for a system by name (exact or partial match).

    Returns the to_dict() of the best match, or None.
    """
    # Exact match first
    stmt = select(SystemCostIndex).where(
        SystemCostIndex.system_name.ilike(system_name)
    )
    result = await db.execute(stmt)
    entry = result.scalars().first()

    if not entry:
        # Try partial match
        stmt = (
            select(SystemCostIndex)
            .where(SystemCostIndex.system_name.ilike(f"%{system_name}%"))
            .order_by(SystemCostIndex.system_name)
            .limit(5)
        )
        result = await db.execute(stmt)
        entry = result.scalars().first()

    if entry:
        return entry.to_dict()
    return None


async def search_systems(
    db: AsyncSession, prefix: str, limit: int = 20
) -> list[dict]:
    """Search systems by name prefix – returns basic info + all cost indices."""
    stmt = (
        select(SystemCostIndex)
        .where(SystemCostIndex.system_name.ilike(prefix + "%"))
        .order_by(SystemCostIndex.system_name)
        .limit(limit)
    )
    result = await db.execute(stmt)
    entries = result.scalars().all()
    return [e.to_dict() for e in entries]


async def get_stale_systems(
    db: AsyncSession, max_age_hours: int = 24
) -> list[SystemCostIndex]:
    """Find systems whose indices haven't been synced in N hours."""
    from sqlalchemy import func as sqlfunc
    cutoff = datetime.now(timezone.utc) - __import__("datetime").timedelta(hours=max_age_hours)
    stmt = (
        select(SystemCostIndex)
        .where(SystemCostIndex.synced_at < cutoff)
    )
    result = await db.execute(stmt)
    return result.scalars().all()
