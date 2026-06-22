"""Asset synchronisation service – fetches assets from ESI and stores them."""

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.character import Character
from app.models.asset import Asset
from app.models.sde_item import SDEItem
from app.services.esi_client import ESIClient

logger = logging.getLogger(__name__)

# ── Constants ───────────────────────────────────────────────────

INT32_MAX = 2_147_483_647

# ── Helpers ────────────────────────────────────────────────────

BP_CATEGORIES = {1: "Frigate", 2: "Cruiser", 3: "Battleship", 4: "Industrial"}


def _infer_item_flags(item: dict) -> dict:
    """Derive blueprint / category flags from ESI flags."""
    flags = {}
    flag = item.get("location_flag", "")
    if "blueprint" in flag.lower():
        flags["is_blueprint"] = True
    return flags


async def _resolve_type_info(
    db: AsyncSession, type_ids: set[int], client: Optional[ESIClient] = None
) -> dict[int, dict]:
    """Resolve type names + full category + meta info.

    First tries local SDE, then falls back to ESI /universe/types/ for
    any type_ids not found in SDE (e.g. newer items).

    Returns {type_id: {name, group_id, group_name, category_id, category_name,
                       meta_group_id, meta_group_name,
                       is_ship, is_module, is_charge, is_drone,
                       is_implant, is_structure, is_material, is_blueprint,
                       volume}}
    """
    result: dict[int, dict] = {}
    if not type_ids:
        return result

    # ── Step 1: Resolve from local SDE ──────────────────────────
    stmt = select(
        SDEItem.type_id,
        SDEItem.name,
        SDEItem.group_id,
        SDEItem.group_name,
        SDEItem.category_id,
        SDEItem.category_name,
        SDEItem.meta_group_id,
        SDEItem.meta_group_name,
        SDEItem.volume,
        SDEItem.is_ship,
        SDEItem.is_module,
        SDEItem.is_charge,
        SDEItem.is_drone,
        SDEItem.is_implant,
        SDEItem.is_structure,
        SDEItem.is_material,
    ).where(SDEItem.type_id.in_(type_ids))
    rows = await db.execute(stmt)
    for row in rows:
        result[row[0]] = {
            "name": row[1],
            "group_id": row[2],
            "group_name": row[3],
            "category_id": row[4],
            "category_name": row[5],
            "meta_group_id": row[6],
            "meta_group_name": row[7],
            "volume": row[8],
            "is_ship": row[9],
            "is_module": row[10],
            "is_charge": row[11],
            "is_drone": row[12],
            "is_implant": row[13],
            "is_structure": row[14],
            "is_material": row[15],
        }

    # ── Step 2: ESI fallback for any type_ids not in SDE ────────
    if client is not None:
        missing = type_ids - set(result.keys())
        if missing:
            logger.info(f"Resolving {len(missing)} type_ids from ESI fallback")
            for tid in missing:
                try:
                    info = await client.get_universe_types(tid)
                    name = info.get("name", str(tid))
                    group_id = info.get("group_id")
                    # /universe/types/{id}/ does NOT return category_id;
                    # we need to fetch the group info separately.
                    category_id = None
                    if group_id is not None:
                        try:
                            group_info = await client.get_universe_groups(group_id)
                            category_id = group_info.get("category_id")
                        except Exception:
                            logger.warning(
                                f"Could not fetch group {group_id} for type {tid}"
                            )
                    # Map category_id to flags (same as SDE importer uses)
                    cat = category_id
                    is_ship = cat == 6
                    is_module = cat == 7
                    is_charge = cat == 8
                    is_drone = cat == 18
                    is_implant = cat == 20
                    is_structure = cat == 65
                    is_material = cat == 4
                    result[tid] = {
                        "name": name,
                        "group_id": group_id,
                        "group_name": None,  # ESI doesn't return group name directly
                        "category_id": category_id,
                        "category_name": None,  # ESI doesn't return category name directly
                        "meta_group_id": info.get("meta_group_id"),
                        "meta_group_name": None,
                        "volume": info.get("volume"),
                        "is_ship": is_ship,
                        "is_module": is_module,
                        "is_charge": is_charge,
                        "is_drone": is_drone,
                        "is_implant": is_implant,
                        "is_structure": is_structure,
                        "is_material": is_material,
                    }
                except Exception as e:
                    logger.warning(f"ESI fallback failed for type_id {tid}: {e}")
                    # Minimal info so sync doesn't break
                    result[tid] = {
                        "name": str(tid),
                        "group_id": None,
                        "group_name": None,
                        "category_id": None,
                        "category_name": None,
                        "meta_group_id": None,
                        "meta_group_name": None,
                        "volume": None,
                        "is_ship": False,
                        "is_module": False,
                        "is_charge": False,
                        "is_drone": False,
                        "is_implant": False,
                        "is_structure": False,
                        "is_material": False,
                    }

    return result


async def _resolve_location_names(
    client: ESIClient, location_ids: set[int], character: Optional[Character] = None
) -> dict[int, str]:
    """Resolve location names via ESI universe/names endpoint.

    Returns {location_id: "Location Name"} for resolvable location IDs.
    Uses ID range heuristics + ESI resolution with graceful fallback.

    NOTE: ESI /universe/names/ uses int32 internally, so IDs larger than
    2,147,483,647 (e.g. Upwell structure IDs) WILL cause a 400 error.
    We filter those out and try to resolve via /universe/structures/{id}/
    if a character (with auth) is provided.
    """
    result: dict[int, str] = {}
    if not location_ids:
        return result

    # Known resolvable ranges (all fit within int32)
    station_ids = {lid for lid in location_ids if 60000000 <= lid < 61000000}
    solar_ids = {lid for lid in location_ids if 30000000 <= lid < 32000000}
    # Other IDs that fit within int32 (structures, characters, etc.)
    other_ids = {
        lid for lid in location_ids
        if 100000 <= lid <= INT32_MAX
        and lid not in station_ids and lid not in solar_ids
    }
    # IDs beyond int32 (large structure IDs) – cannot be resolved via /universe/names/
    big_structure_ids = {
        lid for lid in location_ids
        if lid > INT32_MAX
    }

    # Try ESI resolution for known resolvable ranges
    for label, id_set in [("station", station_ids), ("solar", solar_ids), ("other", other_ids)]:
        if not id_set:
            continue
        try:
            names = await client.get_universe_names(list(id_set))
            for entry in names:
                result[entry["id"]] = entry.get("name", str(entry["id"]))
        except Exception as e:
            logger.warning(f"Failed to resolve {label} location names: {e}")
            # Fallback: name by ID range
            for lid in id_set:
                if label == "station":
                    result[lid] = f"Station {lid}"
                elif label == "solar":
                    result[lid] = f"Solarsystem {lid}"
                else:
                    result[lid] = f"Location {lid}"

    # Try to resolve large structure IDs via authenticated /universe/structures/{id}/
    if character and big_structure_ids:
        logger.info(f"Resolving {len(big_structure_ids)} large structure names via ESI auth")
        for sid in sorted(big_structure_ids):
            try:
                struct_info = await client.get_universe_structure(character, sid)
                struct_name = struct_info.get("name")
                if struct_name:
                    result[sid] = struct_name
                    logger.debug(f"Resolved structure {sid} → '{struct_name}'")
                else:
                    result[sid] = f"Structure {sid}"
            except Exception as e:
                logger.debug(f"Could not resolve structure {sid}: {e}")
                result[sid] = f"Structure {sid}"

    # Fallback for any remaining big structure IDs (if character wasn't provided)
    for lid in big_structure_ids:
        if lid not in result:
            result[lid] = f"Structure {lid}"

    # Handle small IDs that are not stations/solar (e.g. container item IDs)
    small_other = {
        lid for lid in location_ids
        if 0 < lid < 100000
        and lid not in station_ids and lid not in solar_ids
    }
    for lid in small_other:
        result[lid] = f"Container {lid}"

    return result


async def _resolve_location_categories(
    client: ESIClient, location_ids: set[int]
) -> dict[int, str]:
    """Resolve location category types via ESI universe/names endpoint.

    Returns {location_id: "station"|"structure"|"solar_system"|"item"|...}
    Falls back to guessing based on ID range.
    Filters out IDs that cannot be resolved (beyond int32 max).
    """
    result: dict[int, str] = {}
    if not location_ids:
        return result

    # Filter out IDs that are definitely not universe entities or beyond int32
    resolvable = {
        lid for lid in location_ids
        if 100000 <= lid <= INT32_MAX
    }

    if resolvable:
        ids_list = list(resolvable)
        try:
            names = await client.get_universe_names(ids_list)
            for entry in names:
                result[entry["id"]] = entry.get("category", "item")
        except Exception as e:
            logger.warning(f"Failed to resolve location categories: {e}")

    # Fill in fallbacks for any missing IDs
    for lid in location_ids:
        if lid not in result:
            if lid > INT32_MAX:
                result[lid] = "structure"
            elif 60000000 <= lid < 61000000:
                result[lid] = "station"
            elif 30000000 <= lid < 32000000:
                result[lid] = "solar_system"
            elif lid >= 100000:
                result[lid] = "structure"
            else:
                result[lid] = "item"

    return result


async def _get_division_map(
    client: ESIClient, character: Character, corporation_id: int
) -> dict[int, str]:
    """Fetch hangar division names from corporation."""
    try:
        divisions = await client.get_corporation_divisions(
            character, corporation_id
        )
        hangars = divisions.get("hangar", [])
        return {h["division"]: h["name"] for h in hangars}
    except Exception as e:
        logger.warning(f"Could not fetch divisions: {e}")
        return {}


# ── Main Sync Logic ────────────────────────────────────────────


async def sync_character_assets(
    db: AsyncSession,
    character: Character,
) -> dict:
    """Full sync of character's personal assets."""
    client = ESIClient(db)
    try:
        logger.info(f"Starting asset sync for {character.character_name}")

        raw_assets = await client.get_character_assets(character)
        logger.info(f"Got {len(raw_assets)} raw assets for {character.character_name}")

        # Parse assets
        batch_id = uuid.uuid4().hex[:8]
        type_ids = {a["type_id"] for a in raw_assets}
        location_ids = {
            a["location_id"] for a in raw_assets if a.get("location_id")
        }

        type_info = await _resolve_type_info(db, type_ids, client=client)
        # Character assets rarely have structure IDs > INT32_MAX, but pass character anyway
        location_names = await _resolve_location_names(client, location_ids, character=character)
        location_categories = await _resolve_location_categories(client, location_ids)

        # Collect IDs for later deletion of old batch
        new_ids = []

        for item in raw_assets:
            asset_id = item["item_id"]
            new_ids.append(asset_id)
            flags = _infer_item_flags(item)
            info = type_info.get(item["type_id"], {})
            loc_id = item.get("location_id")

            # Determine if item is a blueprint
            is_blueprint = flags.get("is_blueprint", False) or info.get("is_blueprint", False)

            if is_blueprint:
                # Blueprint: quantity from ESI = remaining runs (-1 = BPO unlimited)
                is_blueprint_copy = item.get("is_blueprint_copy", False)
                blueprint_runs = item.get("quantity", -1)
                item_qty = 1  # Each blueprint is a unique item
            else:
                is_blueprint_copy = False
                blueprint_runs = None
                item_qty = item.get("quantity", 1)

            asset_obj = Asset(
                id=asset_id,
                character_id=character.character_id,
                corporation_id=None,
                is_corp_asset=False,
                type_id=item["type_id"],
                type_name=info.get("name"),
                group_id=info.get("group_id"),
                group_name=info.get("group_name"),
                category_id=info.get("category_id"),
                category_name=info.get("category_name"),
                meta_group_id=info.get("meta_group_id"),
                meta_group_name=info.get("meta_group_name"),
                is_ship=info.get("is_ship", False),
                is_module=info.get("is_module", False),
                is_charge=info.get("is_charge", False),
                is_drone=info.get("is_drone", False),
                is_implant=info.get("is_implant", False),
                is_structure=info.get("is_structure", False),
                is_material=info.get("is_material", False),
                quantity=item_qty,
                volume=info.get("volume"),
                location_id=loc_id,
                location_name=location_names.get(loc_id),
                location_category=location_categories.get(loc_id),
                location_flag=item.get("location_flag"),
                is_singleton=item.get("is_singleton", False),
                is_blueprint=is_blueprint,
                is_blueprint_copy=is_blueprint_copy,
                blueprint_runs=blueprint_runs,
                sync_batch=batch_id,
                synced_at=datetime.now(timezone.utc),
            )
            await db.merge(asset_obj)

        # Remove stale assets (no longer in ESI)
        if new_ids:
            delete_stmt = delete(Asset).where(
                Asset.character_id == character.character_id,
                Asset.is_corp_asset == False,
                Asset.id.notin_(new_ids),
            )
            await db.execute(delete_stmt)

        # Update last sync time
        character.assets_last_synced = datetime.now(timezone.utc)
        await db.merge(character)
        await db.commit()

        return {
            "character_id": character.character_id,
            "character_name": character.character_name,
            "assets_found": len(raw_assets),
            "batch_id": batch_id,
        }
    finally:
        await client.close()


async def sync_corporation_assets(
    db: AsyncSession,
    character: Character,
    corporation_id: int,
) -> dict:
    """Full sync of corporation assets using a Director character."""
    client = ESIClient(db)
    try:
        logger.info(
            f"Starting corp asset sync for corp {corporation_id} "
            f"via {character.character_name}"
        )

        raw_assets = await client.get_corporation_assets(
            character, corporation_id
        )
        logger.info(f"Got {len(raw_assets)} raw corp assets")

        division_map = await _get_division_map(
            client, character, corporation_id
        )

        batch_id = uuid.uuid4().hex[:8]
        type_ids = {a["type_id"] for a in raw_assets}
        location_ids = {
            a["location_id"] for a in raw_assets if a.get("location_id")
        }

        # Build office item → station mapping.
        # Corp hangar items (CorpSAG*) inside NPC stations have location_id = office item_id,
        # not the station_id itself. The office item (location_flag="OfficeFolder") stores
        # the actual station_id in its location_id field.
        office_to_station = {}
        for item in raw_assets:
            if item.get("location_flag") == "OfficeFolder":
                off_loc_id = item.get("location_id")
                if off_loc_id and 60000000 <= off_loc_id < 61000000:
                    office_to_station[item["item_id"]] = off_loc_id

        # Replace office item IDs with actual station IDs so location
        # resolution works correctly (station names/categories).
        resolved_location_ids = set()
        for lid in location_ids:
            if lid in office_to_station:
                resolved_location_ids.add(office_to_station[lid])
            else:
                resolved_location_ids.add(lid)

        type_info = await _resolve_type_info(db, type_ids, client=client)
        # Pass character to resolve large structure IDs (> INT32_MAX) via /universe/structures/{id}/
        location_names = await _resolve_location_names(client, resolved_location_ids, character=character)
        location_categories = await _resolve_location_categories(client, resolved_location_ids)

        new_ids = []

        for item in raw_assets:
            asset_id = item["item_id"]
            new_ids.append(asset_id)
            flags = _infer_item_flags(item)
            # Parse division from location_flag (e.g., "CorpSAG1" → division 1)
            # ESI does NOT return a "division_id" field in corp assets
            location_flag = item.get("location_flag", "")
            div_id = None
            if location_flag.startswith("CorpSAG"):
                try:
                    div_id = int(location_flag.replace("CorpSAG", ""))
                except (ValueError, TypeError):
                    pass
            div_name = division_map.get(div_id) if div_id else None
            info = type_info.get(item["type_id"], {})
            loc_id = item.get("location_id")
            # If this location is an office container inside an NPC station,
            # use the station's location info instead
            if loc_id in office_to_station:
                loc_id = office_to_station[loc_id]

            # Determine if item is a blueprint
            is_blueprint = flags.get("is_blueprint", False) or info.get("is_blueprint", False)

            if is_blueprint:
                # Blueprint: quantity from ESI = remaining runs (-1 = BPO unlimited)
                is_blueprint_copy = item.get("is_blueprint_copy", False)
                blueprint_runs = item.get("quantity", -1)
                item_qty = 1  # Each blueprint is a unique item
            else:
                is_blueprint_copy = False
                blueprint_runs = None
                item_qty = item.get("quantity", 1)

            asset_obj = Asset(
                id=asset_id,
                character_id=character.character_id,
                corporation_id=corporation_id,
                is_corp_asset=True,
                type_id=item["type_id"],
                type_name=info.get("name"),
                group_id=info.get("group_id"),
                group_name=info.get("group_name"),
                category_id=info.get("category_id"),
                category_name=info.get("category_name"),
                meta_group_id=info.get("meta_group_id"),
                meta_group_name=info.get("meta_group_name"),
                is_ship=info.get("is_ship", False),
                is_module=info.get("is_module", False),
                is_charge=info.get("is_charge", False),
                is_drone=info.get("is_drone", False),
                is_implant=info.get("is_implant", False),
                is_structure=info.get("is_structure", False),
                is_material=info.get("is_material", False),
                quantity=item_qty,
                volume=info.get("volume"),
                location_id=loc_id,
                location_name=location_names.get(loc_id),
                location_category=location_categories.get(loc_id),
                location_flag=item.get("location_flag"),
                is_singleton=item.get("is_singleton", False),
                division_id=div_id,
                division_name=div_name,
                is_blueprint=is_blueprint,
                is_blueprint_copy=is_blueprint_copy,
                blueprint_runs=blueprint_runs,
                sync_batch=batch_id,
                synced_at=datetime.now(timezone.utc),
            )
            await db.merge(asset_obj)

        # Remove stale corp assets
        if new_ids:
            delete_stmt = delete(Asset).where(
                Asset.corporation_id == corporation_id,
                Asset.is_corp_asset == True,
                Asset.id.notin_(new_ids),
            )
            await db.execute(delete_stmt)

        await db.commit()

        return {
            "corporation_id": corporation_id,
            "assets_found": len(raw_assets),
            "batch_id": batch_id,
        }
    finally:
        await client.close()
