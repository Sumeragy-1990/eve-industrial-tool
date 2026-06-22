"""Blueprint Sync Service – fetches blueprint data from ESI and updates Asset records with ME/TE.

Phase 3A: Dedicated blueprint sync using ESI /characters/{id}/blueprints/ endpoint,
which provides material_efficiency (ME) and time_efficiency (TE) that the
general asset sync doesn't capture.

The ESI blueprints endpoint returns:
  - item_id, type_id, location_id, location_flag
  - quantity (remaining runs, -1 = BPO unlimited)
  - material_efficiency (ME level, 0-20)
  - time_efficiency (TE level, 0-20)
  - runs (total runs for BPCs)
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.character import Character
from app.models.asset import Asset
from app.models.sde_item import SDEItem
from app.services.esi_client import ESIClient

logger = logging.getLogger(__name__)


async def sync_character_blueprints(
    db: AsyncSession,
    character: Character,
) -> dict:
    """Sync blueprints for a character from ESI /blueprints/ endpoint.
    
    Updates existing Asset records with ME, TE, and copy/runs info.
    Also creates Asset records for any blueprints not yet synced.
    """
    client = ESIClient(db)
    try:
        logger.info(f"Syncing blueprints for {character.character_name}")
        
        raw_blueprints = await client.get_character_blueprints(character)
        logger.info(f"Got {len(raw_blueprints)} blueprints for {character.character_name}")
        
        updated = 0
        created = 0
        type_cache = {}  # type_id -> name lookup
        
        for bp in raw_blueprints:
            item_id = bp["item_id"]
            type_id = bp["type_id"]
            me = bp.get("material_efficiency", 0)
            te = bp.get("time_efficiency", 0)
            runs = bp.get("runs", -1)  # -1 = BPO (unlimited)
            is_copy = bp.get("quantity", -1) != -1  # quantity = remaining runs, -1 = BPO
            
            # Check if Asset record exists
            stmt = select(Asset).where(Asset.id == item_id)
            result = await db.execute(stmt)
            asset = result.scalars().first()
            
            if asset:
                # Update existing asset with ME/TE data
                asset.blueprint_me = me
                asset.blueprint_te = te
                asset.blueprint_runs = runs
                asset.is_blueprint_copy = is_copy
                asset.is_blueprint = True
                updated += 1
            else:
                # Create new asset record for this blueprint
                # Resolve type name
                if type_id not in type_cache:
                    type_stmt = select(SDEItem.name).where(SDEItem.type_id == type_id)
                    type_name = await db.scalar(type_stmt)
                    type_cache[type_id] = type_name or f"Unknown ({type_id})"
                
                asset = Asset(
                    id=item_id,
                    character_id=character.character_id,
                    type_id=type_id,
                    type_name=type_cache[type_id],
                    quantity=1,
                    location_id=bp.get("location_id"),
                    location_flag=bp.get("location_flag"),
                    is_blueprint=True,
                    is_blueprint_copy=is_copy,
                    blueprint_me=me,
                    blueprint_te=te,
                    blueprint_runs=runs,
                    is_singleton=True,
                    synced_at=datetime.now(timezone.utc),
                )
                db.add(asset)
                created += 1
        
        await db.commit()
        
        return {
            "character_id": character.character_id,
            "character_name": character.character_name,
            "blueprints_found": len(raw_blueprints),
            "updated": updated,
            "created": created,
        }
    finally:
        await client.close()


async def sync_corporation_blueprints(
    db: AsyncSession,
    character: Character,
    corporation_id: int,
) -> dict:
    """Sync blueprints for a corporation from ESI /blueprints/ endpoint."""
    client = ESIClient(db)
    try:
        logger.info(f"Syncing blueprints for corp {corporation_id} via {character.character_name}")
        
        raw_blueprints = await client.get_corporation_blueprints(character, corporation_id)
        logger.info(f"Got {len(raw_blueprints)} corp blueprints")
        
        updated = 0
        created = 0
        type_cache = {}
        
        for bp in raw_blueprints:
            item_id = bp["item_id"]
            type_id = bp["type_id"]
            me = bp.get("material_efficiency", 0)
            te = bp.get("time_efficiency", 0)
            runs = bp.get("runs", -1)
            is_copy = bp.get("quantity", -1) != -1
            
            # Check if Asset record exists
            stmt = select(Asset).where(Asset.id == item_id)
            result = await db.execute(stmt)
            asset = result.scalars().first()
            
            if asset:
                asset.blueprint_me = me
                asset.blueprint_te = te
                asset.blueprint_runs = runs
                asset.is_blueprint_copy = is_copy
                asset.is_blueprint = True
                asset.corporation_id = corporation_id
                asset.is_corp_asset = True
                updated += 1
            else:
                if type_id not in type_cache:
                    type_stmt = select(SDEItem.name).where(SDEItem.type_id == type_id)
                    type_name = await db.scalar(type_stmt)
                    type_cache[type_id] = type_name or f"Unknown ({type_id})"
                
                asset = Asset(
                    id=item_id,
                    character_id=character.character_id,
                    corporation_id=corporation_id,
                    is_corp_asset=True,
                    type_id=type_id,
                    type_name=type_cache[type_id],
                    quantity=1,
                    location_id=bp.get("location_id"),
                    location_flag=bp.get("location_flag"),
                    is_blueprint=True,
                    is_blueprint_copy=is_copy,
                    blueprint_me=me,
                    blueprint_te=te,
                    blueprint_runs=runs,
                    is_singleton=True,
                    synced_at=datetime.now(timezone.utc),
                )
                db.add(asset)
                created += 1
        
        await db.commit()
        
        return {
            "corporation_id": corporation_id,
            "blueprints_found": len(raw_blueprints),
            "updated": updated,
            "created": created,
        }
    finally:
        await client.close()
