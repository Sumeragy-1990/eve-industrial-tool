"""Industry cost indices – cached ESI solar system cost indices (Bug 6).

All 6 activity cost indices per system, cached in DB and served via REST.
Use POST /sync-cost-indices to refresh from ESI.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.sde_solar_system import SDESolarSystem
from app.services.cost_index_service import (
    sync_all_cost_indices,
    get_cost_indices_by_name,
    search_systems,
    ESI_ACTIVITY_MAP,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/industry", tags=["cost_indices"])


# ── Sync endpoint ───────────────────────────────────────────────────


@router.post("/sync-cost-indices")
async def trigger_sync(
    db: AsyncSession = Depends(get_session),
):
    """Fetch ALL systems from ESI /industry/systems/ and upsert into DB.

    Returns summary of synced records.
    """
    result = await sync_all_cost_indices(db)
    if result.get("error"):
        raise HTTPException(status_code=502, detail=result["error"])
    return result


# ── System cost index lookup (all 6 activities) ─────────────────────


@router.get("/system-cost-index")
async def get_system_cost_index(
    system_name: str = Query(..., description="Solar system name (e.g. Irjunen)"),
    db: AsyncSession = Depends(get_session),
):
    """Look up a solar system by name and return ALL cost indices.

    Returns all 6 activity indices (manufacturing, research_time,
    research_material, invention, copying, reactions) from the local DB cache.

    Falls back to ESI if not found in cache, then caches the result.
    """
    # 1. Try DB cache first
    entry = await get_cost_indices_by_name(db, system_name)
    if entry:
        return {
            "system_name": entry["system_name"],
            "solar_system_id": entry["solar_system_id"],
            "region_name": entry["region_name"],
            "security_status": entry["security_status"],
            "indices": entry["indices"],
            "found": True,
            "source": "cache",
        }

    # 2. Not cached — try to find system in SDE and fetch from ESI live
    stmt = select(SDESolarSystem).where(
        SDESolarSystem.system_name.ilike(system_name)
    )
    result = await db.execute(stmt)
    system = result.scalar_one_or_none()

    if not system:
        # Try partial match
        stmt = (
            select(SDESolarSystem)
            .where(SDESolarSystem.system_name.ilike(f"%{system_name}%"))
            .limit(5)
        )
        result = await db.execute(stmt)
        systems = result.scalars().all()
        if systems:
            system = systems[0]

    if not system:
        return {
            "system_name": system_name,
            "solar_system_id": None,
            "indices": {},
            "found": False,
            "source": None,
        }

    # 3. Fetch from ESI and cache
    from app.services.esi_client import ESIClient

    client = ESIClient(db)
    try:
        all_systems = await client.get_industry_systems()
    except Exception as e:
        await client.close()
        raise HTTPException(status_code=502, detail=f"ESI error: {e}")
    finally:
        await client.close()

    # Find our system and cache it
    for s in all_systems:
        if s.get("solar_system_id") == system.system_id:
            # Build indices dict (normalize ESI names → short names)
            indices = {}
            esi_indices_raw = {}
            for idx in s.get("cost_indices", []):
                act = idx.get("activity")
                if act:
                    esi_indices_raw[act] = idx.get("cost_index")
            # Map to our normalized names
            for esi_name, col_name in ESI_ACTIVITY_MAP.items():
                if esi_name in esi_indices_raw:
                    indices[col_name] = esi_indices_raw[esi_name]

            # Cache in DB
            system_name_sde = system.system_name or s.get("system_name") or str(system.system_id)
            from datetime import datetime, timezone
            from sqlalchemy import text as sql_text

            upsert = sql_text("""
                INSERT INTO system_cost_indices
                    (solar_system_id, system_name, region_name, security_status,
                     manufacturing, research_time, research_material, invention, copying, reactions,
                     synced_at)
                VALUES (:sid, :sname, :rname, :sec,
                        :mfg, :rtime, :rmat, :inv, :copy, :react,
                        :now)
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
            await db.execute(upsert, {
                "sid": system.system_id,
                "sname": system_name_sde,
                "rname": system.region_name or s.get("region_name"),
                "sec": system.security_status or s.get("security_status"),
                "mfg": indices.get("manufacturing"),
                "rtime": indices.get("research_time"),
                "rmat": indices.get("research_material"),
                "inv": indices.get("invention"),
                "copy": indices.get("copying"),
                "react": indices.get("reactions"),
                "now": datetime.now(timezone.utc),
            })
            await db.commit()

            return {
                "system_name": system_name_sde,
                "solar_system_id": system.system_id,
                "region_name": s.get("region_name") or system.region_name,
                "security_status": s.get("security_status") or system.security_status,
                "indices": indices,
                "found": True,
                "source": "esi",
            }

    return {
        "system_name": system.system_name,
        "solar_system_id": system.system_id,
        "indices": {},
        "found": True,
        "source": None,
        "detail": "System found in SDE but no cost index data available from ESI.",
    }


# ── System search (autocomplete) ────────────────────────────────────


@router.get("/systems-search")
async def search_solar_systems(
    prefix: str = Query(..., min_length=1, max_length=50, description="Prefix to search solar system names"),
    limit: int = Query(20, ge=1, le=100),
    include_indices: bool = Query(False, description="Include cost indices in results (slower)"),
    db: AsyncSession = Depends(get_session),
):
    """Search solar systems by name prefix from cached cost_indices table.

    Returns basic info (system_id, system_name, region_name, security_status)
    and optionally all cost indices if include_indices=true.

    Falls back to SDE table if cost indices haven't been synced yet.
    """
    # Try from cached cost_indices table first
    results = await search_systems(db, prefix, limit)

    if results:
        if not include_indices:
            # Strip indices for lighter response
            for r in results:
                r.pop("indices", None)
                r.pop("synced_at", None)
                r["has_indices"] = True
        return results

    # Fallback: read from SDE
    stmt = (
        select(SDESolarSystem)
        .where(SDESolarSystem.system_name.ilike(prefix + "%"))
        .order_by(SDESolarSystem.system_name)
        .limit(limit)
    )
    result = await db.execute(stmt)
    systems = result.scalars().all()

    return [
        {
            "system_id": s.system_id,
            "system_name": s.system_name,
            "region_name": s.region_name,
            "security_status": s.security_status,
            "has_indices": False,
        }
        for s in systems
    ]


# ── Legacy industry systems list (sorted by manufacturing cost) ─────


@router.get("/systems")
async def get_industry_systems(
    system_name: Optional[str] = Query(None, description="Filter by system name (client-side)"),
    limit: int = Query(50, ge=1, le=500),
    force_refresh: bool = Query(False, description="Force refresh from ESI before returning"),
    db: AsyncSession = Depends(get_session),
):
    """List solar systems with their cost indices, sorted by manufacturing cost (cheapest first).

    Reads from local DB cache by default. Use force_refresh=true to trigger ESI sync.
    """
    # Optional: force fresh sync from ESI
    if force_refresh:
        await sync_all_cost_indices(db)

    # Read from DB
    from app.models.system_cost_index import SystemCostIndex

    stmt = select(SystemCostIndex)
    if system_name:
        stmt = stmt.where(SystemCostIndex.system_name.ilike(f"%{system_name}%"))
    stmt = stmt.order_by(SystemCostIndex.manufacturing.asc().nulls_last())
    stmt = stmt.limit(limit)

    result = await db.execute(stmt)
    entries = result.scalars().all()

    systems = []
    for e in entries:
        d = e.to_dict()
        # Flatten top-level convenience fields (backward compat)
        d["manufacturing"] = d["indices"].get("manufacturing")
        d["research_time"] = d["indices"].get("research_time")
        d["research_material"] = d["indices"].get("research_material")
        d["invention"] = d["indices"].get("invention")
        d["copying"] = d["indices"].get("copying")
        d["reactions"] = d["indices"].get("reactions")
        systems.append(d)

    # If DB is empty (first run), fall back to ESI live and cache
    if not systems:
        logger.info("No cached cost indices found, fetching from ESI...")
        try:
            await sync_all_cost_indices(db)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"ESI error: {e}")

        # Read again
        stmt2 = select(SystemCostIndex)
        if system_name:
            stmt2 = stmt2.where(SystemCostIndex.system_name.ilike(f"%{system_name}%"))
        stmt2 = stmt2.order_by(SystemCostIndex.manufacturing.asc().nulls_last())
        stmt2 = stmt2.limit(limit)
        result2 = await db.execute(stmt2)
        entries2 = result2.scalars().all()
        for e in entries2:
            d = e.to_dict()
            d["manufacturing"] = d["indices"].get("manufacturing")
            d["research_time"] = d["indices"].get("research_time")
            d["research_material"] = d["indices"].get("research_material")
            d["invention"] = d["indices"].get("invention")
            d["copying"] = d["indices"].get("copying")
            d["reactions"] = d["indices"].get("reactions")
            systems.append(d)

    return {
        "total": len(systems),
        "systems": systems,
    }


# ── Stations (unchanged) ────────────────────────────────────────────


@router.get("/stations")
async def get_industry_stations(
    search: Optional[str] = Query(None, description="Search by station name or system name"),
    limit: int = Query(100, ge=1, le=1000),
    db: AsyncSession = Depends(get_session),
):
    """
    List NPC stations from the SDE for facility selection.
    Returns station_id, station_name, system_name, region_name, security.
    Supports optional search filter.
    """
    where_clause = ""
    params = {"limit": limit}
    if search:
        where_clause = "AND location_name ILIKE :search"
        params["search"] = f"%{search}%"

    sql = text(f"""
        SELECT DISTINCT ON (location_name)
               location_name AS station_name,
               location_id
        FROM assets
        WHERE location_name IS NOT NULL
          AND location_name != ''
          {where_clause}
        ORDER BY location_name
        LIMIT :limit
    """)
    result = await db.execute(sql, params)
    rows = result.fetchall()

    stations = []
    for row in rows:
        stations.append({
            "station_name": row.station_name,
            "location_id": row.location_id,
        })

    return {
        "total": len(stations),
        "stations": stations,
    }
