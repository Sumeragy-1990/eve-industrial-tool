"""Location Alias endpoints – user-defined names for structures/locations.

EVE's /universe/names/ endpoint cannot resolve player structure IDs
(ID >= 1 trillion). This system lets users assign custom names, colors,
and metadata to any location, including player structures, stations,
and solar systems. These aliases are used throughout the UI to show
meaningful location names instead of "Structure 1234567890123".
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.location_alias import LocationAlias
from app.models.sde_solar_system import SDEStation, SDESolarSystem

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/location-aliases", tags=["location-aliases"])


@router.get("/")
async def list_aliases(
    location_id: Optional[int] = Query(None, description="Filter by location ID"),
    include_deleted: bool = Query(False),
    db: AsyncSession = Depends(get_session),
):
    """List all location aliases."""
    stmt = select(LocationAlias)
    if not include_deleted:
        stmt = stmt.where(LocationAlias.is_deleted == False)
    if location_id:
        stmt = stmt.where(LocationAlias.location_id == location_id)
    stmt = stmt.order_by(LocationAlias.custom_name)

    result = await db.execute(stmt)
    aliases = result.scalars().all()

    return [
        {
            "id": a.id,
            "location_id": a.location_id,
            "custom_name": a.custom_name,
            "color": a.color,
            "solar_system_id": a.solar_system_id,
            "structure_type_id": a.structure_type_id,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in aliases
    ]


@router.post("/")
async def create_alias(
    location_id: int = Query(..., description="The EVE location_id"),
    custom_name: str = Query(..., description="User-defined display name"),
    color: Optional[str] = Query(None, description="Optional hex color or name"),
    solar_system_id: Optional[int] = Query(None, description="Solar system ID"),
    structure_type_id: Optional[int] = Query(None, description="Structure type ID"),
    db: AsyncSession = Depends(get_session),
):
    """Create or update a location alias."""
    # Check if alias already exists
    stmt = select(LocationAlias).where(
        LocationAlias.location_id == location_id,
        LocationAlias.is_deleted == False,
    )
    result = await db.execute(stmt)
    existing = result.scalar_one_or_none()

    if existing:
        existing.custom_name = custom_name
        existing.color = color
        existing.solar_system_id = solar_system_id
        existing.structure_type_id = structure_type_id
        await db.commit()
        await db.refresh(existing)
        return {"message": "Alias updated", "alias": _serialize_alias(existing)}

    alias = LocationAlias(
        location_id=location_id,
        custom_name=custom_name,
        color=color,
        solar_system_id=solar_system_id,
        structure_type_id=structure_type_id,
    )
    db.add(alias)
    await db.commit()
    await db.refresh(alias)
    return {"message": "Alias created", "alias": _serialize_alias(alias)}


@router.put("/{alias_id}")
async def update_alias(
    alias_id: int,
    custom_name: Optional[str] = Query(None),
    color: Optional[str] = Query(None),
    solar_system_id: Optional[int] = Query(None),
    structure_type_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_session),
):
    """Update an existing location alias."""
    stmt = select(LocationAlias).where(LocationAlias.id == alias_id)
    result = await db.execute(stmt)
    alias = result.scalar_one_or_none()

    if not alias:
        raise HTTPException(status_code=404, detail="Alias not found")

    if custom_name is not None:
        alias.custom_name = custom_name
    if color is not None:
        alias.color = color
    if solar_system_id is not None:
        alias.solar_system_id = solar_system_id
    if structure_type_id is not None:
        alias.structure_type_id = structure_type_id

    await db.commit()
    await db.refresh(alias)
    return {"message": "Alias updated", "alias": _serialize_alias(alias)}


@router.delete("/{alias_id}")
async def delete_alias(
    alias_id: int,
    hard: bool = Query(False, description="Hard delete (permanent)"),
    db: AsyncSession = Depends(get_session),
):
    """Delete a location alias (soft by default)."""
    stmt = select(LocationAlias).where(LocationAlias.id == alias_id)
    result = await db.execute(stmt)
    alias = result.scalar_one_or_none()

    if not alias:
        raise HTTPException(status_code=404, detail="Alias not found")

    if hard:
        await db.delete(alias)
    else:
        alias.is_deleted = True

    await db.commit()
    return {"message": "Alias deleted"}


@router.get("/resolve")
async def resolve_location(
    location_id: int = Query(..., description="Location ID to resolve"),
    db: AsyncSession = Depends(get_session),
):
    """Resolve a location ID to a display name.

    Priority:
    1. Location alias (user-defined)
    2. SDE station name
    3. ESI universe/names fallback (via existing location_names in assets)
    4. "Structure {id}" fallback for large IDs
    """
    # Priority 1: Check for alias
    stmt = select(LocationAlias).where(
        LocationAlias.location_id == location_id,
        LocationAlias.is_deleted == False,
    )
    result = await db.execute(stmt)
    alias = result.scalar_one_or_none()

    if alias:
        return {
            "location_id": location_id,
            "name": alias.custom_name,
            "source": "alias",
            "color": alias.color,
            "solar_system_id": alias.solar_system_id,
            "structure_type_id": alias.structure_type_id,
        }

    # Priority 2: Check SDE stations
    stmt = select(SDEStation).where(SDEStation.station_id == location_id)
    result = await db.execute(stmt)
    station = result.scalar_one_or_none()

    if station:
        return {
            "location_id": location_id,
            "name": station.station_name,
            "source": "sde_station",
            "system_id": station.system_id,
            "system_name": station.system_name,
            "region_id": station.region_id,
            "region_name": station.region_name,
        }

    # Priority 3: Check solar systems
    stmt = select(SDESolarSystem).where(SDESolarSystem.system_id == location_id)
    result = await db.execute(stmt)
    system = result.scalar_one_or_none()

    if system:
        return {
            "location_id": location_id,
            "name": system.system_name,
            "source": "sde_solar_system",
            "region_name": system.region_name,
            "security_status": system.security_status,
        }

    # Priority 4: Fallback based on ID range
    if location_id >= 1_000_000_000_000:
        name = f"Structure {location_id}"
    elif 60_000_000 <= location_id < 61_000_000:
        name = f"Station {location_id}"
    elif 30_000_000 <= location_id < 32_000_000:
        name = f"System {location_id}"
    else:
        name = f"Location {location_id}"

    return {
        "location_id": location_id,
        "name": name,
        "source": "id_fallback",
    }


@router.get("/resolve-batch")
async def resolve_locations_batch(
    location_ids: str = Query(..., description="Comma-separated location IDs"),
    db: AsyncSession = Depends(get_session),
):
    """Resolve multiple location IDs at once.

    This is more efficient for the asset sync to display proper names.
    """
    ids = [int(x.strip()) for x in location_ids.split(",") if x.strip()]
    results = {}

    for lid in ids:
        result = await resolve_location(location_id=lid, db=db)
        results[lid] = result

    return {"locations": results}


def _serialize_alias(alias: LocationAlias) -> dict:
    return {
        "id": alias.id,
        "location_id": alias.location_id,
        "custom_name": alias.custom_name,
        "color": alias.color,
        "solar_system_id": alias.solar_system_id,
        "structure_type_id": alias.structure_type_id,
        "created_at": alias.created_at.isoformat() if alias.created_at else None,
    }
