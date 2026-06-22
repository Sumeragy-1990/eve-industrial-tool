"""SDE Importer – downloads CCP's Static Data Export and imports items into DB.

Usage (standalone):
    python -m app.services.sde_importer

Or call import_sde() from the API endpoint.
"""

import asyncio
import io
import json
import logging
import os
import tempfile
import zipfile
from pathlib import Path
from typing import Optional

import httpx

from app.config import settings
from app.database import async_session_factory, init_db
from app.models.sde_item import SDEItem

logger = logging.getLogger(__name__)

# Files inside the SDE zip that we care about
SDE_FILES = {
    "types": "fsd/types.yaml",  # primary item DB
    "groups": "fsd/groups.yaml",
    "categories": "fsd/categories.yaml",
    "meta_groups": "fsd/metaGroups.yaml",
    "market_groups": "fsd/marketGroups.yaml",
}

# Category IDs that CCP uses
CATEGORY_SHIP = 6
CATEGORY_MODULE = 7
CATEGORY_CHARGE = 8
CATEGORY_BLUEPRINT = 9
CATEGORY_Drone = 18
CATEGORY_IMPLANT = 20
CATEGORY_STRUCTURE = 65
CATEGORY_MATERIAL = 4


async def download_sde() -> bytes:
    """Download the latest SDE zip from CCP's CDN."""
    url = settings.sde_download_url
    logger.info(f"Downloading SDE from {url} ...")
    async with httpx.AsyncClient(follow_redirects=True, timeout=300) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        logger.info(f"SDE downloaded ({len(resp.content)} bytes)")
        return resp.content


def _try_parse_yaml_or_json(content: str) -> dict:
    """Try to parse content as JSON first (newer SDE), fallback to YAML."""
    # Newer SDE versions use JSON format
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass
    # Try YAML
    try:
        import yaml
        return yaml.safe_load(content)
    except ImportError:
        logger.warning("PyYAML not installed, trying simple YAML parser")
        # Basic fallback for simple YAML
        return _simple_yaml_parse(content)


def _simple_yaml_parse(content: str) -> dict:
    """Extremely simple YAML parser for SDE's structured format."""
    import re
    result = {}
    current_key = None
    current_block = []
    in_block = False

    for line in content.split("\n"):
        if re.match(r'^\d+:\s*$', line):
            if current_key is not None and current_block:
                result[current_key] = "\n".join(current_block)
            current_key = int(line.split(":")[0].strip())
            current_block = []
            in_block = True
        elif in_block:
            current_block.append(line)

    if current_key is not None and current_block:
        result[current_key] = "\n".join(current_block)
    return result


async def import_sde(
    db_session=None,
    sde_data: Optional[bytes] = None,
    progress_callback=None,
) -> dict:
    """Main import function. Downloads SDE, parses it, inserts into DB.

    Returns stats dict.
    """
    own_session = False
    if db_session is None:
        db_session = async_session_factory()
        own_session = True

    try:
        if sde_data is None:
            sde_data = await download_sde()

        stats = {"imported": 0, "skipped": 0, "errors": 0}

        logger.info("Extracting SDE zip ...")
        with zipfile.ZipFile(io.BytesIO(sde_data)) as zf:
            # List available files for debugging
            all_files = zf.namelist()
            logger.debug(f"SDE contains {len(all_files)} files")

            # Find the types file (new SDE format: fsd/types.yaml)
            type_file = _find_file(all_files, ["types.yaml", "types.json", "typeIDs.yaml", "typeIDs.json"])
            if not type_file:
                raise FileNotFoundError(
                    "Could not find types file in SDE archive"
                )

            logger.info(f"Found typeIDs file: {type_file}")
            raw = zf.read(type_file).decode("utf-8")
            data = _try_parse_yaml_or_json(raw)

            if not isinstance(data, dict):
                raise ValueError(
                    f"Parsed SDE data is {type(data).__name__}, expected dict"
                )

            logger.info(f"Parsed {len(data)} type IDs")

            # Also load groups and categories if available
            groups = _load_sde_file(zf, all_files, ["groups.yaml", "groups.json"])
            categories = _load_sde_file(
                zf, all_files, ["categories.yaml", "categories.json"]
            )
            meta_groups = _load_sde_file(
                zf, all_files, ["metaGroups.yaml", "metaGroups.json", "meta_groups.yaml"]
            )

            # Build lookup dicts
            group_names = {}
            group_categories = {}  # group_id → category_id
            if groups:
                for gid, ginfo in groups.items():
                    if isinstance(ginfo, dict):
                        gid_int = int(gid)
                        group_names[gid_int] = ginfo.get("name", {}).get("en", "")
                        # groups.yaml has categoryID for each group – use it
                        # if the type doesn't have categoryID directly (newer SDE format)
                        gc = ginfo.get("categoryID")
                        if gc is not None:
                            group_categories[gid_int] = int(gc)

            category_names = {}
            if categories:
                for cid, cinfo in categories.items():
                    if isinstance(cinfo, dict):
                        category_names[int(cid)] = cinfo.get("name", {}).get("en", "")

            meta_group_names = {}
            if meta_groups:
                for mgid, mginfo in meta_groups.items():
                    if isinstance(mginfo, dict):
                        meta_group_names[int(mgid)] = mginfo.get("name", {}).get(
                            "en", ""
                        )

            # Process each type
            type_id: int
            for type_id_str, info in data.items():
                try:
                    type_id = int(type_id_str)
                except (ValueError, TypeError):
                    stats["skipped"] += 1
                    continue

                if not isinstance(info, dict):
                    stats["skipped"] += 1
                    continue

                try:
                    name = info.get("name", {}).get("en", "")
                    if not name:
                        stats["skipped"] += 1
                        continue

                    group_id = info.get("groupID")
                    # Newer SDE format doesn't have categoryID in types.yaml;
                    # it lives in groups.yaml instead. Fall back to group_categories.
                    category_id = info.get("categoryID")
                    if category_id is None and group_id is not None:
                        category_id = group_categories.get(int(group_id))
                    group_name = group_names.get(group_id, "")
                    category_name = category_names.get(category_id, "")
                    meta_group_id = info.get("metaGroupID")
                    meta_group_name = meta_group_names.get(meta_group_id, "")

                    # Determine item category flags
                    is_bp = category_id == CATEGORY_BLUEPRINT
                    is_ship = category_id == CATEGORY_SHIP
                    is_module = category_id == CATEGORY_MODULE
                    is_charge = category_id == CATEGORY_CHARGE
                    is_drone = category_id == CATEGORY_Drone
                    is_implant = category_id == CATEGORY_IMPLANT
                    is_structure = category_id == CATEGORY_STRUCTURE
                    is_material = category_id == CATEGORY_MATERIAL
                    is_skill = group_id == 505  # Skill group

                    item = SDEItem(
                        type_id=type_id,
                        name=name,
                        description=info.get("description", {}).get("en", ""),
                        group_id=group_id,
                        group_name=group_name,
                        category_id=category_id,
                        category_name=category_name,
                        market_group_id=info.get("marketGroupID"),
                        meta_group_id=meta_group_id,
                        meta_group_name=meta_group_name,
                        mass=info.get("mass"),
                        volume=info.get("volume"),
                        capacity=info.get("capacity", info.get("capacitorCapacity")),
                        radius=info.get("radius"),
                        tech_level=info.get("techLevel", 1),
                        is_blueprint=is_bp,
                        is_skill=is_skill,
                        is_ship=is_ship,
                        is_module=is_module,
                        is_charge=is_charge,
                        is_drone=is_drone,
                        is_implant=is_implant,
                        is_structure=is_structure,
                        is_material=is_material,
                        icon_id=info.get("iconID"),
                        graphic_id=info.get("graphicID"),
                    )
                    await db_session.merge(item)
                    stats["imported"] += 1

                    if progress_callback and stats["imported"] % 1000 == 0:
                        progress_callback(stats["imported"])

                except Exception as e:
                    logger.warning(f"Error importing type_id {type_id_str}: {e}")
                    stats["errors"] += 1

            await db_session.commit()
            logger.info(
                f"SDE import complete: {stats['imported']} imported, "
                f"{stats['skipped']} skipped, {stats['errors']} errors"
            )
            return stats

    finally:
        if own_session:
            await db_session.close()


def _find_file(file_list: list[str], candidates: list[str]) -> Optional[str]:
    """Find a file in the archive by trying candidate names."""
    for cand in candidates:
        for f in file_list:
            if f.endswith(cand):
                return f
    return None


def _load_sde_file(zf, file_list, candidates: list[str]) -> dict:
    """Load and parse an SDE file from the zip."""
    filename = _find_file(file_list, candidates)
    if not filename:
        logger.warning(f"Could not find {candidates} in SDE archive")
        return {}
    try:
        raw = zf.read(filename).decode("utf-8")
        data = _try_parse_yaml_or_json(raw)
        if isinstance(data, dict):
            return data
        return {}
    except Exception as e:
        logger.warning(f"Failed to parse {filename}: {e}")
        return {}


async def run_import():
    """Run the SDE import as a standalone script."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    logger.info("Starting SDE import ...")
    await init_db()
    stats = await import_sde()
    logger.info(f"Done! Imported {stats['imported']} items.")


if __name__ == "__main__":
    asyncio.run(run_import())
