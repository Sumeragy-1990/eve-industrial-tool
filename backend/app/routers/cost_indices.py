"""Manufacturing Cost Indices – fetch and display solar system cost indices from ESI."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.services.esi_client import ESIClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/industry", tags=["cost_indices"])


@router.get("/systems")
async def get_industry_systems(
    system_name: Optional[str] = Query(None, description="Filter by system name (client-side)"),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_session),
):
    """Fetch manufacturing cost indices for all solar systems from ESI."""
    client = ESIClient(db)
    try:
        systems = await client.get_industry_systems()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ESI error: {e}")
    finally:
        await client.close()

    # Sort by manufacturing cost index (ascending = cheapest first)
    def sort_key(s):
        indices = s.get("cost_indices", [])
        for idx in indices:
            if idx.get("activity") == "manufacturing":
                return idx.get("cost_index", 1.0)
        return 1.0

    systems.sort(key=sort_key)

    # Format response
    result = []
    for s in systems[:limit]:
        system_id = s.get("solar_system_id")
        indices = {}
        for idx in s.get("cost_indices", []):
            indices[idx["activity"]] = {
                "cost_index": idx["cost_index"],
            }

        result.append({
            "solar_system_id": system_id,
            "cost_indices": indices,
            "manufacturing": indices.get("manufacturing", {}).get("cost_index", 0),
            "research_time": indices.get("research_time", {}).get("cost_index", 0),
            "research_material": indices.get("research_material", {}).get("cost_index", 0),
            "invention": indices.get("invention", {}).get("cost_index", 0),
            "copying": indices.get("copying", {}).get("cost_index", 0),
            "reactions": indices.get("reactions", {}).get("cost_index", 0),
        })

    return {
        "total": len(result),
        "systems": result,
    }


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

    # Use distinct asset locations as station list (SDE station names are empty)
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


@router.get("/systems-search")
async def search_solar_systems(
    prefix: str = Query(..., min_length=1, max_length=50, description="Prefix to search solar system names"),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_session),
):
    """Fast SDE-local search for solar systems by name prefix. Returns system_id, system_name, region_name, security_status."""
    from app.models.sde_solar_system import SDESolarSystem

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
        }
        for s in systems
    ]


@router.get("/system-cost-index")
async def get_system_cost_index(
    system_name: str = Query(..., description="Solar system name (e.g. Irjunen)"),
    db: AsyncSession = Depends(get_session),
):
    """Look up a solar system by name and return its manufacturing cost index.

    Steps:
    1. Find system_id from SDE by system_name
    2. Fetch industry systems data from ESI
    3. Return the manufacturing cost_index for that system
    """
    # 1. Lookup system_id from SDE
    from app.models.sde_solar_system import SDESolarSystem

    stmt = select(SDESolarSystem).where(SDESolarSystem.system_name.ilike(system_name))
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
        return {"system_name": system_name, "system_id": None, "cost_index": None, "found": False}

    # 2. Fetch ESI industry systems
    client = ESIClient(db)
    try:
        all_systems = await client.get_industry_systems()
    except Exception as e:
        await client.close()
        raise HTTPException(status_code=502, detail=f"ESI error: {e}")
    finally:
        await client.close()

    # 3. Find our system
    for s in all_systems:
        if s.get("solar_system_id") == system.system_id:
            indices = s.get("cost_indices", [])
            for idx in indices:
                if idx.get("activity") == "manufacturing":
                    return {
                        "system_name": system.system_name,
                        "system_id": system.system_id,
                        "cost_index": idx.get("cost_index"),
                        "cost_index_pct": round(idx.get("cost_index", 0) * 100, 4),
                        "found": True,
                    }

    return {
        "system_name": system.system_name,
        "system_id": system.system_id,
        "cost_index": None,
        "cost_index_pct": None,
        "found": True,
        "detail": "System found in SDE but no manufacturing cost index data available from ESI.",
    }
