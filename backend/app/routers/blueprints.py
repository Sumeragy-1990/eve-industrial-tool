"""Blueprint routes – sync and query blueprints with ME/TE data (Phase 3A/3B)."""

import logging
from typing import Optional, List

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import select, func, or_, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.character import Character
from app.models.asset import Asset
from app.models.sde_blueprint import (
    SDEBlueprint,
    SDEBlueprintMaterial,
    SDEBlueprintProduct,
    SDEBlueprintSkill,
)
from app.models.sde_item import SDEItem
from app.models.cached_price import CachedPrice
from app.models.user_item_price import UserItemPrice
from app.routers.auth import (
    require_auth,
    require_account,
    assert_owns_character,
    assert_owns_corporation,
    get_owned_character_ids,
)
from app.services.blueprint_sync import (
    sync_character_blueprints,
    sync_corporation_blueprints,
)

# ── Request Models ──────────────────────────────────────────────────

class MaterialCheckItem(BaseModel):
    material_type_id: int
    quantity: int

class MaterialsCheckRequest(BaseModel):
    materials: List[MaterialCheckItem]
    location_flag: Optional[str] = None
    location_name: Optional[str] = None

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/blueprints", tags=["blueprints"])


async def _owned_corp_ids(db: AsyncSession, user_id: int) -> list[int]:
    """Return distinct corporation IDs the account's characters belong to."""
    result = await db.execute(
        select(Character.corporation_id)
        .where(Character.user_id == user_id, Character.corporation_id.isnot(None))
        .distinct()
    )
    return [row[0] for row in result.all()]


# ── Sync ────────────────────────────────────────────────────────


@router.post("/sync/character/{character_id}")
async def trigger_character_blueprint_sync(
    character_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Sync blueprints for a character from ESI."""
    await assert_owns_character(db, user_id, character_id)
    stmt = select(Character).where(Character.character_id == character_id)
    result = await db.execute(stmt)
    character = result.scalar_one_or_none()

    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    result = await sync_character_blueprints(db, character)
    return result


@router.post("/sync/corporation/{corporation_id}")
async def trigger_corporation_blueprint_sync(
    corporation_id: int,
    character_id: int = Query(..., description="Director character ID to auth with"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Sync blueprints for a corporation from ESI (requires Director role)."""
    await assert_owns_character(db, user_id, character_id)
    await assert_owns_corporation(db, user_id, corporation_id)
    stmt = select(Character).where(Character.character_id == character_id)
    result = await db.execute(stmt)
    character = result.scalar_one_or_none()

    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    result = await sync_corporation_blueprints(db, character, corporation_id)
    return result


# ── Query ────────────────────────────────────────────────────────


@router.get("/list")
async def get_blueprints(
    user_id: int = Depends(require_account),
    character_id: Optional[int] = Query(None, description="Filter by character"),
    corporation_id: Optional[int] = Query(None, description="Filter by corporation"),
    is_copy: Optional[bool] = Query(None, description="Filter BPO (false) vs BPC (true)"),
    is_corp: Optional[bool] = Query(None, description="Filter by corp vs personal"),
    search: Optional[str] = Query(None, description="Search by blueprint name"),
    min_me: Optional[int] = Query(None, description="Minimum ME level"),
    max_me: Optional[int] = Query(None, description="Maximum ME level"),
    min_te: Optional[int] = Query(None, description="Minimum TE level"),
    has_runs: Optional[bool] = Query(None, description="Only BPCs with remaining runs"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_session),
):
    """Query blueprints with filters. Returns blueprints from Asset table."""
    owned_ids = await get_owned_character_ids(db, user_id)
    owned_corps = await _owned_corp_ids(db, user_id)
    base = select(Asset).where(Asset.is_blueprint == True)

    # Ownership filters – restrict to the account's own data
    if character_id:
        await assert_owns_character(db, user_id, character_id)
        base = base.where(Asset.character_id == character_id)
    if corporation_id:
        await assert_owns_corporation(db, user_id, corporation_id)
        base = base.where(Asset.corporation_id == corporation_id)
    if not character_id and not corporation_id:
        base = base.where(
            or_(
                Asset.character_id.in_(owned_ids or [0]),
                Asset.corporation_id.in_(owned_corps or [0]),
            )
        )
    if is_corp is True:
        base = base.where(Asset.is_corp_asset == True)
    elif is_corp is False:
        base = base.where(Asset.is_corp_asset == False)

    # Blueprint type filters
    if is_copy is not None:
        base = base.where(Asset.is_blueprint_copy == is_copy)
    if search:
        base = base.where(Asset.type_name.ilike(f"%{search}%"))
    if min_me is not None:
        base = base.where(Asset.blueprint_me >= min_me)
    if max_me is not None:
        base = base.where(Asset.blueprint_me <= max_me)
    if min_te is not None:
        base = base.where(Asset.blueprint_te >= min_te)
    if has_runs:
        base = base.where(
            Asset.blueprint_runs.isnot(None),
            Asset.blueprint_runs > 0,
        )

    # Count total
    count_query = select(func.count()).select_from(base.subquery())
    total = await db.scalar(count_query) or 0

    # Fetch page (by name)
    offset = (page - 1) * per_page
    query = base.order_by(Asset.type_name).offset(offset).limit(per_page)
    result = await db.execute(query)
    blueprints = result.scalars().all()

    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": max(1, (total + per_page - 1) // per_page),
        "blueprints": [
            {
                "item_id": b.id,
                "type_id": b.type_id,
                "type_name": b.type_name,
                "character_id": b.character_id,
                "corporation_id": b.corporation_id,
                "is_corp_asset": b.is_corp_asset,
                "is_blueprint_copy": b.is_blueprint_copy,
                "blueprint_me": b.blueprint_me,
                "blueprint_te": b.blueprint_te,
                "blueprint_runs": b.blueprint_runs,
                "quantity": b.quantity,
                "location_id": b.location_id,
                "location_name": b.location_name,
                "location_flag": b.location_flag,
                "group_name": b.group_name,
                "category_name": b.category_name,
                "meta_group_name": b.meta_group_name,
                "synced_at": b.synced_at.isoformat() if b.synced_at else None,
            }
            for b in blueprints
        ],
    }


@router.get("/stats")
async def get_blueprint_stats(
    user_id: int = Depends(require_account),
    character_id: Optional[int] = Query(None),
    corporation_id: Optional[int] = Query(None),
    is_corp: Optional[bool] = Query(None),
    db: AsyncSession = Depends(get_session),
):
    """Get aggregated statistics about blueprints."""
    owned_ids = await get_owned_character_ids(db, user_id)
    owned_corps = await _owned_corp_ids(db, user_id)
    base = select(Asset).where(Asset.is_blueprint == True)

    if character_id:
        await assert_owns_character(db, user_id, character_id)
        base = base.where(Asset.character_id == character_id)
    if corporation_id:
        await assert_owns_corporation(db, user_id, corporation_id)
        base = base.where(Asset.corporation_id == corporation_id)
    if not character_id and not corporation_id:
        base = base.where(
            or_(
                Asset.character_id.in_(owned_ids or [0]),
                Asset.corporation_id.in_(owned_corps or [0]),
            )
        )
    if is_corp is True:
        base = base.where(Asset.is_corp_asset == True)
    elif is_corp is False:
        base = base.where(Asset.is_corp_asset == False)

    result = await db.execute(base)
    blueprints = result.scalars().all()

    total = len(blueprints)
    bpo_count = sum(1 for b in blueprints if not b.is_blueprint_copy)
    bpc_count = sum(1 for b in blueprints if b.is_blueprint_copy)
    
    # ME distribution
    me_levels = {}
    for b in blueprints:
        me = b.blueprint_me or 0
        me_levels[me] = me_levels.get(me, 0) + 1

    # TE distribution
    te_levels = {}
    for b in blueprints:
        te = b.blueprint_te or 0
        te_levels[te] = te_levels.get(te, 0) + 1

    # BPCs with limited runs
    limited_runs = sum(1 for b in blueprints if b.is_blueprint_copy and (b.blueprint_runs or 0) > 0 and (b.blueprint_runs or 0) < 1000)

    return {
        "total_blueprints": total,
        "bpo_count": bpo_count,
        "bpc_count": bpc_count,
        "limited_runs_bpc": limited_runs,
        "me_distribution": dict(sorted(me_levels.items())),
        "te_distribution": dict(sorted(te_levels.items())),
    }


# ── Shared Tree Building Helper ────────────────────────────

# Only subdivide by race for Ships (category_id = 6).
# The EVE in-game market browser uses this same convention.
_RACE_SUBDIVISION_CATEGORY_ID = 6

# CCP's SDE often assigns the wrong race to faction ships (e.g. Imperial Navy
# Slicer is listed as "Gallente").  This dict maps faction name prefixes to the
# correct in-game race so the catalog sidebar matches what players see.
_FACTION_RACE_CORRECTIONS = {
    "Imperial Navy": "Amarr",
    "Khanid Navy": "Amarr",
    "Blood Raiders": "Amarr",
    "True Sansha": "Amarr",
    "Dark Blood": "Amarr",
    "Federation Navy": "Gallente",
    "Serpentis": "Gallente",
    "Shadow Serpentis": "Gallente",
    "Guardian Angels": "Gallente",
    "Republic Fleet": "Minmatar",
    "Brutor Tribe": "Minmatar",
    "Angel Cartel": "Minmatar",
    "Archangels": "Minmatar",
    "Domination": "Minmatar",
    "State Prototype": "Caldari",
    "Caldari Navy": "Caldari",
    "Guristas": "Caldari",
    "Dread Guristas": "Caldari",
    "Mordu's Legion": "Caldari",
    "Sisters of EVE": "Gallente",
    "Concord": "Amarr",
    "CONCORD": "Amarr",
    "Society of Conscious Thought": "Amarr",
    "ORE": "Minmatar",
    "Outer Ring Excavations": "Minmatar",
    "Upwell": "Caldari",
    "InterBus": "Gallente",
    "Equilibrium of Mankind": "Amarr",
}

# CCP's SDE assigns race_id based on the designing corporation, not the lore race.
# For ships, this means:
#   race_id=4 (Gallente) → actually Amarr ships
#   race_id=NULL          → actually Gallente + ORE + pirate ships
#   race_id=1 (Caldari)   → correct
#   race_id=2 (Minmatar)  → correct
_SDE_RACE_ID_TO_LORE = {1: "Caldari", 2: "Minmatar", 4: "Amarr", None: "Gallente"}

# Special hull lines that belong to non-standard races (ORE, pirate factions, etc.)
# These override the default SDE race mapping for ships.
_HULL_LINE_RACE = {
    "ORE": "ORE",
    "Outer Ring Excavations": "ORE",
    "InterBus": "Gallente",
    "Upwell": "Upwell",
    "Mordu's Legion": "Caldari",
    "Society of Conscious Thought": "Amarr",
    "Equilibrium of Mankind": "Amarr",
    "Sisters of EVE": "Gallente",
}

RACE_SORT_ORDER = {"Caldari": 1, "Minmatar": 2, "Amarr": 3, "Gallente": 4, "ORE": 5, "Upwell": 6}


def _corrected_race_name(row):
    """Return the corrected race name for a product row.

    Corrects CCP SDE misclassifications at two levels:
    1. Base SDE race mapping: race_id=4 → Amarr, race_id=NULL → Gallente
    2. Faction prefix overrides for special cases (Imperial Navy → Amarr, etc.)
    Falls back to "Faction/Pirate" if no correction applies.

    Only called for Ships (category_id=6).
    """
    product_name = row.product_name or ""
    race_id = getattr(row, "race_id", None)

    # Step 1: Determine the base lore race from SDE race_id
    base_race = _SDE_RACE_ID_TO_LORE.get(race_id)

    # Step 2: Check for faction prefix overrides (takes priority over base race)
    for faction_prefix, race in _FACTION_RACE_CORRECTIONS.items():
        if product_name.startswith(faction_prefix + " ") or product_name == faction_prefix:
            return race

    # Step 3: Check for special hull-line races
    for hull_prefix, race in _HULL_LINE_RACE.items():
        if product_name.startswith(hull_prefix + " ") or product_name == hull_prefix:
            return race

    # Step 4: Fall back to base lore race, then Faction/Pirate
    return base_race or ("Faction/Pirate" if race_id else None)

def _build_blueprint_tree_from_rows(rows):
    """Convert SQL result rows into a nested Category → Group → [Race →] Product tree.

    Both the 'owned tree' and 'catalog' endpoints use the same tree structure,
    so this helper is shared between them.

    Only Ship groups (category_id=6) are subdivided by race, matching the EVE
    in-game market browser convention. Faction race names are corrected via
    _FACTION_RACE_CORRECTIONS.
    """
    tree: dict = {}

    for row in rows:
        cat_id = row.category_id
        cat_name = row.category_name
        grp_name = row.group_name
        race_name = _corrected_race_name(row) if cat_id == _RACE_SUBDIVISION_CATEGORY_ID else None
        prod_id = row.product_type_id

        # ── Category level ──
        cat = tree.setdefault(cat_name, {
            "category_name": cat_name,
            "category_id": cat_id,
            "groups": {},
        })

        # ── Group level ──
        # For Ships, always subdivide by race; _corrected_race_name()
        # handles the correct mapping even when SDE race_id is NULL.
        group_has_races = (cat_id == _RACE_SUBDIVISION_CATEGORY_ID)
        grp = cat["groups"].setdefault(grp_name, {
            "group_name": grp_name,
            "group_id": row.group_id,
            "has_races": group_has_races,
            "races": {} if group_has_races else None,
            "products": None if group_has_races else {},
        })

        # ── Race level (only for Ships with a race) ──
        if group_has_races and race_name:
            race = grp["races"].setdefault(race_name, {
                "race_name": race_name,
                "race_id": row.race_id,
                "products": {},
            })
            prod_container = race["products"]
        else:
            prod_container = grp["products"]
            if prod_container is None:
                grp["products"] = {}
                prod_container = grp["products"]

        # ── Product level ──
        prod = prod_container.setdefault(prod_id, {
            "product_type_id": prod_id,
            "product_name": row.product_name,
            "meta_group_name": getattr(row, "meta_group_name", None),
            "meta_group_id": getattr(row, "meta_group_id", None),
            "blueprint_type_id": row.blueprint_type_id,
            "blueprint_type_name": getattr(row, "blueprint_type_name", str(prod_id)),
            "bpo_count": 0,
            "bpc_count": 0,
            "best_me": None,
            "best_te": None,
            "total_bpc_runs": 0,
            "bpos": [],
            "bpcs": [],
        })

        # ── For owned tree: append specific blueprint items ──
        item_id = getattr(row, "item_id", None)
        if item_id is not None:
            item = {
                "item_id": item_id,
                "blueprint_me": row.blueprint_me,
                "blueprint_te": row.blueprint_te,
                "blueprint_runs": row.blueprint_runs,
                "location_name": row.location_name,
                "location_flag": row.location_flag,
                "character_id": getattr(row, "character_id", None),
                "character_name": getattr(row, "character_name", None),
                "corporation_name": getattr(row, "corporation_name", None),
            }
            if row.is_blueprint_copy:
                prod["bpcs"].append(item)
                prod["bpc_count"] += 1
                prod["total_bpc_runs"] += row.blueprint_runs or 0
            else:
                prod["bpos"].append(item)
                prod["bpo_count"] += 1
        else:
            # ── For catalog view: use aggregated counts ──
            prod["bpo_count"] = getattr(row, "bpo_count", 0) or 0
            prod["bpc_count"] = getattr(row, "bpc_count", 0) or 0
            prod["best_me"] = getattr(row, "best_me", None)
            prod["best_te"] = getattr(row, "best_te", None)
            prod["total_bpc_runs"] = getattr(row, "total_bpc_runs", 0) or 0

    # Convert dicts → sorted lists
    def sort_key_product(p):
        return p["product_name"]

    def sort_key_race(r):
        return RACE_SORT_ORDER.get(r["race_name"], 99)

    def sort_key_group(g):
        return g["group_name"]

    categories = []
    for cat_data in tree.values():
        groups = []
        for grp_data in cat_data["groups"].values():
            if grp_data["has_races"] and grp_data["races"] is not None:
                races = []
                for race_data in sorted(grp_data["races"].values(), key=sort_key_race):
                    race_data["products"] = sorted(
                        race_data["products"].values(), key=sort_key_product
                    )
                    races.append(race_data)
                grp_data["races"] = races
            else:
                grp_data["products"] = sorted(
                    (grp_data["products"] or {}).values(), key=sort_key_product
                )
            groups.append(grp_data)
        groups.sort(key=sort_key_group)
        cat_data["groups"] = groups
        categories.append(cat_data)

    return categories


# ── Blueprint Tree (owned only) ────────────────────────────


@router.get("/tree")
async def get_blueprint_tree(
    _user: int = Depends(require_auth),
    search: Optional[str] = Query(None, description="Filter by product name"),
    is_corp: Optional[bool] = Query(None, description="Filter by corp vs personal"),
    db: AsyncSession = Depends(get_session),
):
    """
    Return *owned* blueprints as a nested tree: Category → Group → [Race →] Product.

    Ships (category_id=6) include a Race level (Caldari/Minmatar/Amarr/Gallente/Faction).
    All other categories skip the Race level and go directly Group → Product.
    Only shows products for which the user owns at least one BPO/BPC.
    """
    from sqlalchemy import text

    sql = text("""
        SELECT
            COALESCE(si.category_id, a.category_id) AS category_id,
            COALESCE(si.category_name, a.category_name) AS category_name,
            COALESCE(si.group_id, a.group_id) AS group_id,
            COALESCE(si.group_name, a.group_name) AS group_name,
            si.race_id,
            si.race_name,
            sbp.product_type_id,
            sbp.product_name,
            a.meta_group_name,
            a.is_blueprint_copy,
            a.blueprint_me,
            a.blueprint_te,
            a.blueprint_runs,
            a.id AS item_id,
            a.type_id AS blueprint_type_id,
            a.type_name AS blueprint_type_name,
            a.location_name,
            a.location_flag,
            a.character_id,
            COALESCE(c.character_name, a.type_name) AS character_name,
            c.corporation_name
        FROM assets a
        JOIN sde_blueprint_products sbp ON sbp.type_id = a.type_id AND sbp.activity_id = 1
        LEFT JOIN sde_items si ON si.type_id = sbp.product_type_id
        LEFT JOIN characters c ON c.character_id = a.character_id
        WHERE a.is_blueprint = true
          AND (a.is_corp_asset = :is_corp OR :is_corp IS NULL)
          AND (sbp.product_name ILIKE :search OR :search IS NULL)
        ORDER BY
            CASE COALESCE(si.category_name, a.category_name)
                WHEN 'Ship' THEN 1
                WHEN 'Module' THEN 2
                WHEN 'Structure' THEN 3
                WHEN 'Charge' THEN 4
                WHEN 'Drone' THEN 5
                WHEN 'Implant' THEN 6
                WHEN 'Material' THEN 7
                ELSE 99
            END,
            COALESCE(si.group_name, a.group_name),
            CASE si.race_name
                WHEN 'Caldari' THEN 1
                WHEN 'Minmatar' THEN 2
                WHEN 'Amarr' THEN 3
                WHEN 'Gallente' THEN 4
                ELSE 99
            END,
            sbp.product_name
    """)

    params = {}
    if search:
        params["search"] = f"%{search}%"
    else:
        params["search"] = None
    params["is_corp"] = is_corp

    result = await db.execute(sql, params)
    rows = result.all()

    # Build tree using shared helper
    categories = _build_blueprint_tree_from_rows(rows)
    return {"categories": categories}


# ── Blueprint Catalog (all manufacturable products) ────────────


@router.get("/catalog")
async def get_blueprint_catalog(
    _user: int = Depends(require_auth),
    search: Optional[str] = Query(None, description="Filter by product name"),
    filter: Optional[str] = Query("all", description="Sub-filter: all, bpo, bpc, t2, custom"),
    db: AsyncSession = Depends(get_session),
):
    """
    Return ALL manufacturable products (like in-game market) as a nested tree:
    Category → Group → [Race →] Product.

    Every product that has a blueprint is included, regardless of whether the
    user owns it. Products are annotated with aggregate BPO/BPC counts so the
    frontend can highlight owned items and dim unowned ones.

    Sub-filters (applied client-side could also be server-side):
      - all:     every product shown, owned highlighted
      - bpo:     only products with bpo_count > 0
      - bpc:     only products with bpc_count > 0
      - t2:      only Tech II products with owned BPC
      - custom:  Faction/Storyline/Officer meta-group items always visible
    """
    from sqlalchemy import text

    sql = text("""
        SELECT
            si.category_id,
            si.category_name,
            si.group_id,
            si.group_name,
            si.race_id,
            si.race_name,
            sbp.product_type_id,
            sbp.product_name,
            sbp.type_id AS blueprint_type_id,
            si.meta_group_name,
            si.meta_group_id,
            sb.tech_level,
            COUNT(DISTINCT CASE WHEN a.is_blueprint_copy = false AND a.id IS NOT NULL THEN a.id END) AS bpo_count,
            COUNT(DISTINCT CASE WHEN a.is_blueprint_copy = true AND a.id IS NOT NULL THEN a.id END) AS bpc_count,
            MAX(a.blueprint_me) AS best_me,
            MAX(a.blueprint_te) AS best_te,
            COALESCE(SUM(CASE WHEN a.is_blueprint_copy = true AND a.character_id = :user_id THEN a.blueprint_runs ELSE 0 END), 0) AS total_bpc_runs
        FROM sde_blueprints sb
        JOIN sde_blueprint_products sbp
            ON sbp.type_id = sb.type_id AND sbp.activity_id = 1
        LEFT JOIN sde_items si
            ON si.type_id = sbp.product_type_id
        LEFT JOIN assets a
            ON a.type_id = sb.type_id AND a.is_blueprint = true
        WHERE sb.activity_id = 1
          AND si.type_id IS NOT NULL
          -- Check market_group_id on the blueprint item itself, not the product,
          -- because some products (e.g. 1MN Afterburner) have no market_group
          -- but their blueprint does.
          AND EXISTS (
              SELECT 1 FROM sde_items si2
              WHERE si2.type_id = sb.type_id
                AND si2.market_group_id IS NOT NULL
          )
          AND (sbp.product_name ILIKE :search OR :search IS NULL)
        GROUP BY
            si.category_id, si.category_name,
            si.group_id, si.group_name,
            si.race_id, si.race_name,
            sbp.product_type_id, sbp.product_name,
            sbp.type_id, si.meta_group_name, si.meta_group_id, sb.tech_level
        ORDER BY
            CASE COALESCE(si.category_name, 'Ship')
                WHEN 'Ship' THEN 1
                WHEN 'Module' THEN 2
                WHEN 'Structure' THEN 3
                WHEN 'Charge' THEN 4
                WHEN 'Drone' THEN 5
                WHEN 'Implant' THEN 6
                WHEN 'Material' THEN 7
                ELSE 99
            END,
            COALESCE(si.group_name, ''),
            CASE si.race_name
                WHEN 'Caldari' THEN 1
                WHEN 'Minmatar' THEN 2
                WHEN 'Amarr' THEN 3
                WHEN 'Gallente' THEN 4
                ELSE 99
            END,
            sbp.product_name
    """)

    params = {"user_id": _user}
    if search:
        params["search"] = f"%{search}%"
    else:
        params["search"] = None

    result = await db.execute(sql, params)
    rows = result.all()

    # Apply server-side sub-filtering when requested
    if filter == "bpo":
        rows = [r for r in rows if (getattr(r, "bpo_count", 0) or 0) > 0]
    elif filter == "bpc":
        rows = [r for r in rows if (getattr(r, "bpc_count", 0) or 0) > 0]
    elif filter == "t2":
        rows = [r for r in rows if (getattr(r, "tech_level", 0) or 0) == 2
                and (getattr(r, "bpc_count", 0) or 0) > 0]

    categories = _build_blueprint_tree_from_rows(rows)
    return {"categories": categories, "total_products": len(rows)}


# ── Blueprint Locations (for hangar selection dropdown) ────────────


@router.get("/locations")
async def get_blueprint_locations(
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """
    Return distinct location names from blueprint assets.
    Used to populate the hangar selection dropdown.
    """
    from sqlalchemy import text

    sql = text("""
        SELECT DISTINCT a.location_name
        FROM assets a
        WHERE a.is_blueprint = true
          AND a.location_name IS NOT NULL
        ORDER BY a.location_name
    """)
    result = await db.execute(sql)
    rows = result.all()
    return {"locations": [row.location_name for row in rows]}


# ── Owned Assets Detail (BPO/BPC locations for detail panel) ──────

@router.get("/{blueprint_type_id}/owned-assets")
async def get_owned_blueprint_assets(
    blueprint_type_id: int,
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """
    Return individual BPO/BPC asset rows for a given blueprint type_id.
    Used by the detail panel to show location, ME, TE, runs, and owner
    for each owned copy of this blueprint.
    """
    sql = text("""
        SELECT
            a.id AS item_id,
            a.is_blueprint_copy,
            a.blueprint_me,
            a.blueprint_te,
            a.blueprint_runs,
            a.location_name,
            a.location_flag,
            a.character_id,
            COALESCE(c.character_name, a.type_name) AS character_name,
            c.corporation_name
        FROM assets a
        LEFT JOIN characters c ON c.character_id = a.character_id
        WHERE a.type_id = :bp_type_id
          AND a.is_blueprint = true
        ORDER BY a.is_blueprint_copy, a.blueprint_me DESC, a.blueprint_te DESC
    """)
    result = await db.execute(sql, {"bp_type_id": blueprint_type_id})
    rows = result.all()

    bpos = []
    bpcs = []
    for row in rows:
        item = {
            "item_id": row.item_id,
            "blueprint_me": row.blueprint_me,
            "blueprint_te": row.blueprint_te,
            "blueprint_runs": row.blueprint_runs,
            "location_name": row.location_name,
            "location_flag": row.location_flag,
            "character_id": row.character_id,
            "character_name": row.character_name,
            "corporation_name": row.corporation_name,
        }
        if row.is_blueprint_copy:
            bpcs.append(item)
        else:
            bpos.append(item)

    return {"bpos": bpos, "bpcs": bpcs}


# ── Blueprint Detail (materials, skills, description) ──────────────


@router.get("/{blueprint_type_id}/detail")
async def get_blueprint_detail(
    blueprint_type_id: int,
    me: int = Query(10, ge=0, le=10, description="Material Efficiency level"),
    te: int = Query(10, ge=0, le=20, description="Time Efficiency level (affects manufacturing time)"),
    runs: int = Query(1, ge=1, le=1000, description="Number of runs"),
    db: AsyncSession = Depends(get_session),
):
    """
    Return full blueprint detail for the shopping page:
    - Product info (name, description, meta group, group, category)
    - Materials with ME formula applied
    - Skill requirements
    - Manufacturing time (TE-adjusted)
    """
    # 1. Look up the blueprint -> product mapping
    prod_sql = text("""
        SELECT
            sb.product_type_id, sbp.quantity AS product_quantity,
            sb.manufacturing_time, sb.max_production_limit
        FROM sde_blueprints sb
        JOIN sde_blueprint_products sbp
            ON sbp.type_id = sb.type_id AND sbp.activity_id = 1
        WHERE sb.type_id = :bp_id AND sb.activity_id = 1
        LIMIT 1
    """)
    prod_result = await db.execute(prod_sql, {"bp_id": blueprint_type_id})
    prod_row = prod_result.first()

    if not prod_row:
        raise HTTPException(status_code=404, detail=f"Blueprint {blueprint_type_id} not found in SDE")

    product_type_id = prod_row.product_type_id

    # 2. Get product item description
    item_sql = text("""
        SELECT
            name, description, group_name, category_name,
            meta_group_name, tech_level, race_name,
            volume, mass
        FROM sde_items
        WHERE type_id = :type_id
    """)
    item_result = await db.execute(item_sql, {"type_id": product_type_id})
    item_row = item_result.first()

    # Fallback: also check the blueprint item itself (type_id = blueprint_type_id)
    # Some products may not be in sde_items directly but the BP item is.
    if not item_row:
        bp_item_sql = text("""
            SELECT
                name, description, group_name, category_name,
                meta_group_name, tech_level, race_name,
                volume, mass
            FROM sde_items
            WHERE type_id = :type_id
        """)
        bp_item_result = await db.execute(bp_item_sql, {"type_id": blueprint_type_id})
        item_row = bp_item_result.first()

    product_name = item_row.name if item_row else str(product_type_id)
    description = item_row.description if item_row else None
    group_name = item_row.group_name if item_row else None
    category_name = item_row.category_name if item_row else None
    meta_group_name = item_row.meta_group_name if item_row else None
    tech_level = item_row.tech_level if item_row else None
    race_name = item_row.race_name if item_row else None

    # 3. Get materials with ME applied
    mat_sql = text("""
        SELECT
            bm.material_type_id,
            bm.material_name,
            si.category_id,
            si.category_name,
            bm.quantity AS base_quantity,
            bm.is_optional,
            si.volume AS material_volume
        FROM sde_blueprint_materials bm
        LEFT JOIN sde_items si ON si.type_id = bm.material_type_id
        WHERE bm.type_id = :bp_id AND bm.activity_id = 1
        ORDER BY bm.material_name
    """)
    mat_result = await db.execute(mat_sql, {"bp_id": blueprint_type_id})
    mat_rows = mat_result.all()

    # ME formula: adjusted_qty = base_qty * runs * (1 - 0.01 * ME), minimum 1 per material
    materials = []
    for row in mat_rows:
        base_qty = row.base_quantity or 0
        adjusted = max(1, round(base_qty * runs * (1.0 - 0.01 * me)))
        materials.append({
            "material_type_id": row.material_type_id,
            "material_name": row.material_name or f"Unknown ({row.material_type_id})",
            "category_id": row.category_id,
            "category_name": row.category_name,
            "base_quantity": base_qty,
            "adjusted_quantity": adjusted,
            "is_optional": bool(row.is_optional),
            "volume": float(row.material_volume) if row.material_volume else None,
        })

    # 4. Get skill requirements
    skill_sql = text("""
        SELECT skill_type_id, skill_name, level
        FROM sde_blueprint_skills
        WHERE type_id = :bp_id AND activity_id = 1
        ORDER BY skill_name
    """)
    skill_result = await db.execute(skill_sql, {"bp_id": blueprint_type_id})
    skill_rows = skill_result.all()

    # Deduplicate skills: same skill can appear for multiple activities in sde_blueprint_skills
    # We only query activity_id=1 but Fuzzwork CSV may have duplicates within same activity.
    seen_skill_ids = {}
    skills = []
    for row in skill_rows:
        tid = row.skill_type_id
        if tid not in seen_skill_ids or row.level > seen_skill_ids[tid]:
            seen_skill_ids[tid] = row.level
    for tid, level in seen_skill_ids.items():
        # Find the skill name from our rows
        name = next((r.skill_name for r in skill_rows if r.skill_type_id == tid), f"Unknown ({tid})")
        skills.append({
            "skill_type_id": tid,
            "skill_name": name or f"Unknown ({tid})",
            "level": level,
        })
    skills.sort(key=lambda s: s["skill_name"])

    # 5. Get manufacturing time (TE-adjusted)
    base_time = prod_row.manufacturing_time or 0
    te_adjusted_time = round(base_time * runs * (1.0 - 0.02 * min(te, 20)))

    return {
        "blueprint_type_id": blueprint_type_id,
        "product_type_id": product_type_id,
        "product_name": product_name,
        "product_description": description,
        "group_name": group_name,
        "category_name": category_name,
        "meta_group_name": meta_group_name,
        "tech_level": tech_level,
        "race_name": race_name,
        "product_quantity_per_run": prod_row.product_quantity or 1,
        "base_manufacturing_time_sec": base_time,
        "te_adjusted_time_sec": te_adjusted_time,
        "materials": materials,
        "materials_total_volume": round(sum(m.get("volume", 0) or 0 for m in materials), 2),
        "skills": skills,
        "me_applied": me,
        "te_applied": te,
        "runs_applied": runs,
    }


# ── Materials Check (cart vs own assets) ───────────────────────────


@router.post("/materials-check")
async def check_materials(
    body: MaterialsCheckRequest,
    is_corp: Optional[bool] = Query(None, description="Check corp assets instead"),
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """
    Compare required materials from the shopping cart against
    owned assets (in a specific location/flag if provided).
    Returns a deficit/surplus for each material.
    """
    materials = body.materials
    if not materials:
        return {"materials": [], "total_deficit": 0}

    material_ids = [m.material_type_id for m in materials]

    # Sum owned quantities from assets table for these material type_ids
    base = select(
        Asset.type_id,
        func.coalesce(func.sum(Asset.quantity), 0).label("owned"),
    ).where(
        Asset.type_id.in_(material_ids),
        Asset.is_blueprint == False,
    )

    if is_corp is True:
        base = base.where(Asset.is_corp_asset == True)
    elif is_corp is False:
        base = base.where(Asset.is_corp_asset == False)

    if body.location_name:
        base = base.where(Asset.location_name == body.location_name)
    if body.location_flag:
        base = base.where(Asset.location_flag == body.location_flag)

    base = base.group_by(Asset.type_id)

    result = await db.execute(base)
    owned_map = {row.type_id: row.owned for row in result.all()}

    total_deficit = 0
    checked = []
    for m in materials:
        owned = int(owned_map.get(m.material_type_id, 0))
        needed = m.quantity
        deficit = max(0, needed - owned)
        total_deficit += deficit
        checked.append({
            "material_type_id": m.material_type_id,
            "needed": needed,
            "owned": owned,
            "deficit": deficit,
            "surplus": max(0, owned - needed),
        })

    return {
        "materials": checked,
        "total_deficit": total_deficit,
        "total_materials": len(materials),
        "location_filter": body.location_name or "All locations",
    }


# ── Ore Reprocessing (Mineral → Ore reverse lookup) ────────────────

# Hardcoded EVE Online ore→mineral reprocessing data (100% efficiency, batch=100 units)
# mineral_type_id → [(ore_type_id, ore_name, batch_size, mineral_per_batch), ...]
ORE_REPROCESSING_MAP = {
    34: [  # Tritanium
        (17470, "Arkonor", 100, 300), (17425, "Crimson Arkonor", 100, 350),
        (17426, "Prime Arkonor", 100, 400), (17463, "Bistot", 100, 170),
        (17428, "Triclinic Bistot", 100, 200), (17429, "Monoclinic Bistot", 100, 230),
        (17440, "Crokite", 100, 210), (17441, "Sharp Crokite", 100, 250),
        (17442, "Crystalline Crokite", 100, 290), (17455, "Dark Ochre", 100, 100),
        (17456, "Onyx Ochre", 100, 120), (17457, "Obsidian Ochre", 100, 140),
        (17448, "Gneiss", 100, 70), (17449, "Iridescent Gneiss", 100, 85),
        (17450, "Prismatic Gneiss", 100, 100), (17444, "Hedbergite", 100, 80),
        (17445, "Vitric Hedbergite", 100, 95), (17446, "Glazed Hedbergite", 100, 110),
        (17433, "Hemorphite", 100, 55), (17434, "Vivid Hemorphite", 100, 65),
        (17435, "Radiant Hemorphite", 100, 75), (17436, "Jaspet", 100, 50),
        (17437, "Pure Jaspet", 100, 60), (17438, "Pristine Jaspet", 100, 70),
        (17439, "Kernite", 100, 40), (17440, "Luminous Kernite", 100, 48),
        (17441, "Fiery Kernite", 100, 55), (17459, "Plagioclase", 100, 8),
        (17460, "Azure Plagioclase", 100, 10), (17461, "Rich Plagioclase", 100, 12),
        (17464, "Pyroxeres", 100, 8), (17465, "Solid Pyroxeres", 100, 10),
        (17466, "Viscous Pyroxeres", 100, 12), (17467, "Scordite", 100, 15),
        (17468, "Condensed Scordite", 100, 18), (17469, "Massive Scordite", 100, 21),
        (17452, "Veldspar", 100, 30), (17453, "Concentrated Veldspar", 100, 35),
        (17454, "Dense Veldspar", 100, 40),
    ],
    35: [  # Pyerite
        (17470, "Arkonor", 100, 80), (17425, "Crimson Arkonor", 100, 95),
        (17426, "Prime Arkonor", 100, 110), (17463, "Bistot", 100, 60),
        (17428, "Triclinic Bistot", 100, 70), (17429, "Monoclinic Bistot", 100, 80),
        (17440, "Crokite", 100, 70), (17441, "Sharp Crokite", 100, 85),
        (17442, "Crystalline Crokite", 100, 100), (17455, "Dark Ochre", 100, 60),
        (17456, "Onyx Ochre", 100, 70), (17457, "Obsidian Ochre", 100, 80),
        (17448, "Gneiss", 100, 40), (17449, "Iridescent Gneiss", 100, 48),
        (17450, "Prismatic Gneiss", 100, 55), (17444, "Hedbergite", 100, 50),
        (17445, "Vitric Hedbergite", 100, 60), (17446, "Glazed Hedbergite", 100, 70),
        (17433, "Hemorphite", 100, 35), (17434, "Vivid Hemorphite", 100, 42),
        (17435, "Radiant Hemorphite", 100, 50), (17436, "Jaspet", 100, 30),
        (17437, "Pure Jaspet", 100, 36), (17438, "Pristine Jaspet", 100, 42),
        (17439, "Kernite", 100, 25), (17440, "Luminous Kernite", 100, 30),
        (17441, "Fiery Kernite", 100, 35), (17459, "Plagioclase", 100, 5),
        (17460, "Azure Plagioclase", 100, 6), (17461, "Rich Plagioclase", 100, 7),
        (17464, "Pyroxeres", 100, 5), (17465, "Solid Pyroxeres", 100, 6),
        (17466, "Viscous Pyroxeres", 100, 7), (17467, "Scordite", 100, 10),
        (17468, "Condensed Scordite", 100, 12), (17469, "Massive Scordite", 100, 14),
        (17452, "Veldspar", 100, 8), (17453, "Concentrated Veldspar", 100, 10),
        (17454, "Dense Veldspar", 100, 12),
    ],
    36: [  # Mexallon
        (17470, "Arkonor", 100, 50), (17425, "Crimson Arkonor", 100, 60),
        (17426, "Prime Arkonor", 100, 70), (17463, "Bistot", 100, 40),
        (17428, "Triclinic Bistot", 100, 48), (17429, "Monoclinic Bistot", 100, 55),
        (17440, "Crokite", 100, 40), (17441, "Sharp Crokite", 100, 48),
        (17442, "Crystalline Crokite", 100, 55), (17455, "Dark Ochre", 100, 40),
        (17456, "Onyx Ochre", 100, 48), (17457, "Obsidian Ochre", 100, 55),
        (17448, "Gneiss", 100, 30), (17449, "Iridescent Gneiss", 100, 36),
        (17450, "Prismatic Gneiss", 100, 42), (17444, "Hedbergite", 100, 30),
        (17445, "Vitric Hedbergite", 100, 36), (17446, "Glazed Hedbergite", 100, 42),
        (17433, "Hemorphite", 100, 25), (17434, "Vivid Hemorphite", 100, 30),
        (17435, "Radiant Hemorphite", 100, 35), (17436, "Jaspet", 100, 20),
        (17437, "Pure Jaspet", 100, 24), (17438, "Pristine Jaspet", 100, 28),
        (17439, "Kernite", 100, 15), (17440, "Luminous Kernite", 100, 18),
        (17441, "Fiery Kernite", 100, 21), (17459, "Plagioclase", 100, 3),
        (17460, "Azure Plagioclase", 100, 4), (17461, "Rich Plagioclase", 100, 5),
    ],
    37: [  # Isogen
        (17470, "Arkonor", 100, 25), (17425, "Crimson Arkonor", 100, 30),
        (17426, "Prime Arkonor", 100, 35), (17463, "Bistot", 100, 20),
        (17428, "Triclinic Bistot", 100, 24), (17429, "Monoclinic Bistot", 100, 28),
        (17440, "Crokite", 100, 20), (17441, "Sharp Crokite", 100, 24),
        (17442, "Crystalline Crokite", 100, 28), (17455, "Dark Ochre", 100, 20),
        (17456, "Onyx Ochre", 100, 24), (17457, "Obsidian Ochre", 100, 28),
        (17448, "Gneiss", 100, 15), (17449, "Iridescent Gneiss", 100, 18),
        (17450, "Prismatic Gneiss", 100, 21), (17444, "Hedbergite", 100, 15),
        (17445, "Vitric Hedbergite", 100, 18), (17446, "Glazed Hedbergite", 100, 21),
        (17433, "Hemorphite", 100, 12), (17434, "Vivid Hemorphite", 100, 15),
        (17435, "Radiant Hemorphite", 100, 18),
    ],
    38: [  # Nocxium
        (17470, "Arkonor", 100, 15), (17425, "Crimson Arkonor", 100, 18),
        (17426, "Prime Arkonor", 100, 21), (17463, "Bistot", 100, 12),
        (17428, "Triclinic Bistot", 100, 15), (17429, "Monoclinic Bistot", 100, 18),
        (17440, "Crokite", 100, 12), (17441, "Sharp Crokite", 100, 15),
        (17442, "Crystalline Crokite", 100, 18),
    ],
    39: [  # Zydrine
        (17470, "Arkonor", 100, 10), (17425, "Crimson Arkonor", 100, 12),
        (17426, "Prime Arkonor", 100, 14), (17463, "Bistot", 100, 8),
        (17428, "Triclinic Bistot", 100, 10), (17429, "Monoclinic Bistot", 100, 12),
    ],
    40: [  # Megacyte
        (17470, "Arkonor", 100, 5), (17425, "Crimson Arkonor", 100, 6),
        (17426, "Prime Arkonor", 100, 7), (17463, "Bistot", 100, 4),
        (17428, "Triclinic Bistot", 100, 5), (17429, "Monoclinic Bistot", 100, 6),
    ],
    11399: [  # Morphite (for T2)
        (17471, "Mercoxit", 100, 30), (17472, "Magma Mercoxit", 100, 35),
        (17473, "Vitreous Mercoxit", 100, 40),
    ],
}


@router.get("/reprocessing/{blueprint_type_id}")
async def get_ore_reprocessing(
    blueprint_type_id: int,
    me: int = Query(10, ge=0, le=10, description="Material Efficiency level"),
    runs: int = Query(1, ge=1, le=1000, description="Number of runs"),
    reprocessing_efficiency: float = Query(50.0, ge=30.0, le=86.8, description="Reprocessing efficiency % (50% base NPC station, up to 86.8% max)"),
    db: AsyncSession = Depends(get_session),
):
    """
    Calculate the raw ore requirements for a blueprint's materials.
    Reverse-maps mineral quantities to source ores using EVE's reprocessing data.
    """
    # Fetch blueprint materials (same query as /detail endpoint)
    mat_sql = text("""
        SELECT bm.material_type_id, bm.material_name, bm.quantity AS base_quantity, si.volume
        FROM sde_blueprint_materials bm
        LEFT JOIN sde_items si ON si.type_id = bm.material_type_id
        WHERE bm.type_id = :bp_id AND bm.activity_id = 1 AND bm.is_optional = FALSE
        ORDER BY bm.material_name
    """)
    mat_result = await db.execute(mat_sql, {"bp_id": blueprint_type_id})
    mat_rows = mat_result.all()

    if not mat_rows:
        raise HTTPException(status_code=404, detail=f"No materials found for blueprint {blueprint_type_id}")

    eff_factor = reprocessing_efficiency / 100.0
    materials_with_ores = []
    total_ore_volume = 0.0

    for row in mat_rows:
        base_qty = row.base_quantity or 0
        adjusted = max(1, round(base_qty * runs * (1.0 - 0.01 * me)))
        mat_type_id = row.material_type_id

        ore_list = []
        ores_data = ORE_REPROCESSING_MAP.get(mat_type_id, [])
        for ore_type_id, ore_name, batch_size, mineral_per_batch in ores_data:
            if mineral_per_batch <= 0:
                continue
            # ore_needed = (material_needed / mineral_per_batch) * batch_size / efficiency
            raw_ore = max(1, round((adjusted / mineral_per_batch) * batch_size / eff_factor))
            ore_volume = float(row.volume) if row.volume else 0.0
            # Use a fixed ore volume of 0.01 m³ per unit for most ores (approximate)
            approx_ore_volume = raw_ore * 0.01
            ore_list.append({
                "ore_type_id": ore_type_id,
                "ore_name": ore_name,
                "batch_size": batch_size,
                "mineral_per_batch": mineral_per_batch,
                "ore_needed": raw_ore,
                "ore_volume_m3": round(approx_ore_volume, 2),
            })
            total_ore_volume += approx_ore_volume

        materials_with_ores.append({
            "material_type_id": mat_type_id,
            "material_name": row.material_name or f"Unknown ({mat_type_id})",
            "needed_quantity": adjusted,
            "ores": sorted(ore_list, key=lambda o: o["ore_needed"]),
        })

    return {
        "blueprint_type_id": blueprint_type_id,
        "me_applied": me,
        "runs_applied": runs,
        "reprocessing_efficiency": reprocessing_efficiency,
        "materials": sorted(materials_with_ores, key=lambda m: m["needed_quantity"], reverse=True),
        "total_ore_volume_m3": round(total_ore_volume, 2),
    }


# ── Build Cost Calculator (F3a) ──────────────────────────────────


class CartItem(BaseModel):
    blueprint_type_id: int
    runs: int = 1
    me: int = 10
    te: int = 20


class FacilityConfig(BaseModel):
    facility_type: str = "npc_station"
    station_id: Optional[int] = None
    system_id: Optional[int] = None
    rigs: str = "none"
    security_class: str = "highsec"  # highsec | lowsec | null | wh
    tax_rate: float = 5.0
    # 🌟 NEU: user-configurable system cost index (None = fallback to 0.05)
    system_cost_index: Optional[float] = None
    # 🌟 NEU: price source for material calculations
    price_source: str = "jita_sell"  # jita_sell | jita_buy | manual


class SkillConfig(BaseModel):
    industry: int = 5
    advanced_industry: int = 5
    supply_chain_management: int = 4
    # 🌟 NEU: additional skills for T2 / Capital manufacturing
    mass_production: int = 5
    advanced_mass_production: int = 4
    capital_ship_construction: int = 3


class BuildCostRequest(BaseModel):
    cart_items: List[CartItem]
    facility: Optional[FacilityConfig] = None
    skills: Optional[SkillConfig] = None
    character_id: int = 0
    # 🌟 NEU: implant configuration (slot7/slot8/slot10)
    implants: Optional[dict] = None
    # 🌟 NEU: use buy prices instead of sell prices
    use_buy_prices: bool = False


@router.post("/build-cost")
async def calculate_build_cost(
    body: BuildCostRequest,
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """
    Calculate full build cost for one or more blueprint cart items.

    For each item:
    1. Look up materials from SDE
    2. Apply ME formula to adjust quantities
    3. Fetch prices from Jita cache (cached_prices.sell_price_min)
    4. Apply user overrides from user_item_prices
    5. Calculate facility cost (system cost index × skills × rigs × tax)
    6. Return per-item cost breakdown + grand total
    """
    import math

    facility = body.facility or FacilityConfig()
    skills = body.skills or SkillConfig()

    # ---- 1. Collect all material type IDs first (for batch price lookup) ----
    all_material_ids = set()
    item_plans = []

    _RIG_MAT = {"none": 0.0, "t1": 0.02, "t2": 0.024}
    _SEC_MULT = {"highsec": 1.0, "lowsec": 1.9, "null": 2.1, "wh": 2.1}
    rig_mat_bonus = _RIG_MAT.get(facility.rigs, 0.0) * _SEC_MULT.get(facility.security_class, 1.0)

    for item in body.cart_items:
        mat_sql = text("""
            SELECT
                sbm.material_type_id,
                si.name AS material_name,
                si.category_id,
                si.category_name,
                sbm.quantity AS base_quantity,
                sbm.is_optional,
                sbp.product_type_id,
                sbp.product_name,
                sbp.quantity AS product_quantity,
                sb.manufacturing_time
            FROM sde_blueprint_materials sbm
            LEFT JOIN sde_items si ON si.type_id = sbm.material_type_id
            JOIN sde_blueprints sb ON sb.type_id = sbm.type_id AND sb.activity_id = 1
            JOIN sde_blueprint_products sbp ON sbp.type_id = sbm.type_id AND sbp.activity_id = 1
            WHERE sbm.type_id = :bp_id
              AND sbm.activity_id = 1
        """)
        result = await db.execute(mat_sql, {"bp_id": item.blueprint_type_id})
        mats = result.all()

        if not mats:
            # Try without the product join (might be a reaction)
            mat_sql2 = text("""
                SELECT
                    sbm.material_type_id,
                    si.name AS material_name,
                    si.category_id,
                    si.category_name,
                    sbm.quantity AS base_quantity,
                    sbm.is_optional,
                    NULL AS product_type_id,
                    NULL AS product_name,
                    NULL AS product_quantity,
                    sb.manufacturing_time
                FROM sde_blueprint_materials sbm
                LEFT JOIN sde_items si ON si.type_id = sbm.material_type_id
                JOIN sde_blueprints sb ON sb.type_id = sbm.type_id AND sb.activity_id = 1
                WHERE sbm.type_id = :bp_id
                  AND sbm.activity_id = 1
            """)
            result = await db.execute(mat_sql2, {"bp_id": item.blueprint_type_id})
            mats = result.all()

        materials = []
        seen_materials = {}  # material_type_id -> index in materials[]
        product_info = {
            "product_type_id": None,
            "product_name": f"Blueprint {item.blueprint_type_id}",
            "product_quantity_per_run": 1,
            "manufacturing_time": None,
        }

        for m in mats:
            # Extract product info from first row only
            if product_info["product_type_id"] is None and getattr(m, "product_type_id", None):
                product_info["product_type_id"] = m.product_type_id
                product_info["product_name"] = getattr(m, "product_name", None) or f"Product {m.product_type_id}"
                product_info["product_quantity_per_run"] = getattr(m, "product_quantity", 1) or 1
                product_info["manufacturing_time"] = getattr(m, "manufacturing_time", None)

            if not m.material_type_id:
                continue
            all_material_ids.add(m.material_type_id)

            # Apply ME formula
            base_qty = m.base_quantity or 0
            me_factor = 1.0 - item.me / 100.0
            adjusted = max(1, math.ceil(base_qty * me_factor * (1.0 - rig_mat_bonus)))

            # Deduplicate by material_type_id (SDE product JOIN can cause row multiplication)
            if m.material_type_id in seen_materials:
                # All duplicate rows carry the same base_qty from the cross-product;
                # just keep the first occurrence's values.
                if getattr(m, "is_optional", False):
                    idx = seen_materials[m.material_type_id]
                    materials[idx]["is_optional"] = True
                continue
            else:
                seen_materials[m.material_type_id] = len(materials)
                materials.append({
                    "material_type_id": m.material_type_id,
                    "material_name": getattr(m, "material_name", None) or f"Unknown ({m.material_type_id})",
                    "category_id": getattr(m, "category_id", None),
                    "category_name": getattr(m, "category_name", None),
                    "base_quantity": base_qty,
                    "adjusted_quantity": adjusted,
                    "total_quantity": adjusted * item.runs,
                    "is_optional": getattr(m, "is_optional", False),
                })

        item_plans.append({
            "blueprint_type_id": item.blueprint_type_id,
            "runs": item.runs,
            "me": item.me,
            "te": item.te,
            "product": product_info,
            "materials": materials,
        })

    # ---- 2. Batch fetch Jita prices ----
    price_map = {}
    if all_material_ids:
        price_sql = text("""
            SELECT type_id, sell_price_min, buy_price_max, average_price, adjusted_price, type_name
            FROM cached_prices
            WHERE type_id = ANY(:ids)
        """)
        price_result = await db.execute(
            price_sql,
            {"ids": list(all_material_ids)},
        )
        for row in price_result:
            price_map[row.type_id] = {
                "sell_price_min": row.sell_price_min,
                "buy_price_max": row.buy_price_max,
                "average_price": row.average_price,
                "adjusted_price": row.adjusted_price,
                "type_name": row.type_name,
            }

    # ---- 3. Batch fetch user price overrides ----
    user_price_map = {}
    if all_material_ids:
        up_sql = text("""
            SELECT type_id, override_price, weighted_average_price, price_source
            FROM user_item_prices
            WHERE type_id = ANY(:ids)
              AND character_id = :char_id
        """)
        up_result = await db.execute(
            up_sql,
            {"ids": list(all_material_ids), "char_id": body.character_id},
        )
        for row in up_result:
            user_price_map[row.type_id] = {
                "override_price": row.override_price,
                "weighted_average_price": row.weighted_average_price,
                "price_source": row.price_source,
            }

    # ---- 3.5. Batch fetch product Jita prices (for Buy vs Build comparison) ----
    product_price_map = {}
    all_product_ids = [p["product"]["product_type_id"] for p in item_plans if p["product"]["product_type_id"]]
    if all_product_ids:
        prod_price_sql = text("""
            SELECT type_id, sell_price_min, buy_price_max, average_price, type_name
            FROM cached_prices
            WHERE type_id = ANY(:ids)
        """)
        prod_price_result = await db.execute(
            prod_price_sql,
            {"ids": all_product_ids},
        )
        for row in prod_price_result:
            product_price_map[row.type_id] = {
                "sell_price_min": row.sell_price_min,
                "buy_price_max": row.buy_price_max,
                "average_price": row.average_price,
                "type_name": row.type_name,
            }

    # Also check for user price overrides on products
    if all_product_ids:
        prod_up_sql = text("""
            SELECT type_id, override_price, weighted_average_price
            FROM user_item_prices
            WHERE type_id = ANY(:ids)
              AND character_id = :char_id
        """)
        prod_up_result = await db.execute(
            prod_up_sql,
            {"ids": all_product_ids, "char_id": body.character_id},
        )
        for row in prod_up_result:
            if row.override_price is not None:
                product_price_map.setdefault(row.type_id, {})["override_price"] = row.override_price
            if row.weighted_average_price is not None:
                product_price_map.setdefault(row.type_id, {})["weighted_average_price"] = row.weighted_average_price

    # ---- 4. Calculate cost per item ----
    results = []
    grand_total_material = 0.0
    grand_total_facility = 0.0
    grand_total_job = 0.0
    grand_eiv = 0.0
    missing_prices = []

    for plan in item_plans:
        material_costs = []
        item_total_material = 0.0

        for mat in plan["materials"]:
            tid = mat["material_type_id"]
            price_info = price_map.get(tid, {})
            user_info = user_price_map.get(tid, {})

            # Determine unit price based on price_source setting
            # jita_sell: override > sell_price_min > average > weighted
            # jita_buy:  override > buy_price_max > average > weighted
            # manual:    override only
            unit_price = None
            price_source = "unknown"
            use_buy = body.use_buy_prices

            if user_info.get("override_price") is not None:
                unit_price = user_info["override_price"]
                price_source = "override"
            elif use_buy and price_info.get("buy_price_max") is not None:
                unit_price = price_info["buy_price_max"]
                price_source = "jita_buy"
            elif not use_buy and price_info.get("sell_price_min") is not None:
                unit_price = price_info["sell_price_min"]
                price_source = "jita_sell"
            elif price_info.get("sell_price_min") is not None:
                unit_price = price_info["sell_price_min"]
                price_source = "jita_sell"
            elif price_info.get("buy_price_max") is not None:
                unit_price = price_info["buy_price_max"]
                price_source = "jita_buy"
            elif price_info.get("average_price") is not None:
                unit_price = price_info["average_price"]
                price_source = "average"
            elif user_info.get("weighted_average_price") is not None:
                unit_price = user_info["weighted_average_price"]
                price_source = "weighted"

            total_cost = (unit_price or 0) * mat["total_quantity"]
            item_total_material += total_cost

            if unit_price is None:
                missing_prices.append(tid)

            material_costs.append({
                "material_type_id": tid,
                "material_name": mat["material_name"],
                "category_id": mat.get("category_id"),
                "category_name": mat.get("category_name"),
                "total_quantity": mat["total_quantity"],
                "sell_price_per_unit": round(price_info.get("sell_price_min"), 2) if price_info.get("sell_price_min") else None,
                "buy_price_per_unit": round(price_info.get("buy_price_max"), 2) if price_info.get("buy_price_max") else None,
                "unit_price": round(unit_price, 2) if unit_price else None,
                "total_cost": round(total_cost, 2),
                "price_source": price_source,
                "is_optional": mat["is_optional"],
            })

        # ---- Facility cost (EVE-korrekte Formel) ----
        system_cost_index = facility.system_cost_index / 100.0 if facility.system_cost_index is not None else 0.05
        facility_tax_rate = facility.tax_rate / 100.0 if facility.tax_rate else 0.0
        scc_surcharge_rate = 0.04
        structure_role_bonus = 0.0  # Default 0; erweiterbar via Facility-Config

        # Zeitreduktion durch TE + Skills (beeinflusst NUR Bauzeit, NICHT Job-Kosten)
        te = plan["te"]
        time_mult = 1.0
        if te > 0:
            time_mult -= 0.02 * te  # 2% pro TE-Level
        if skills:
            time_mult *= max(0.01, 1 - 0.04 * skills.industry)
            if skills.advanced_industry:
                time_mult *= max(0.01, 1 - 0.03 * skills.advanced_industry)

        # Implant-Zeitreduktion (Slot 8 = Gnome K-Implantat -1% Zeit)
        implants = body.implants or {}
        if implants.get("slot8") == "gnome":
            time_mult *= 0.99

        # Implant-Materialreduktion (Slot 7 = Beancounter Industry -1% Material)
        implant_material_mult = 1.0
        if implants.get("slot7") == "beancounter_industry":
            implant_material_mult = 0.99
        item_total_material *= implant_material_mult

        # EIV = runs ?? ??(base_quantity ?? adjusted_price) ??? Basis-Mengen VOR ME, nicht reduziert
        eiv = 0.0
        runs = plan["runs"]
        for mat in plan["materials"]:
            _pm = price_map.get(mat["material_type_id"], {})
            ap = _pm.get("adjusted_price") or _pm.get("average_price") or _pm.get("sell_price_min") or 0.0
            eiv += (mat.get("base_quantity") or 0) * runs * ap

        # Job-Kosten-Posten (alle EIV-basiert, unabh??ngig von ME/TE/Material-Marktpreisen)
        system_cost_amount = eiv * system_cost_index
        job_gross_cost = system_cost_amount * (1.0 - structure_role_bonus)
        facility_tax = eiv * facility_tax_rate
        scc_surcharge = eiv * scc_surcharge_rate
        total_job_cost = job_gross_cost + facility_tax + scc_surcharge

        item_total = item_total_material + total_job_cost
        grand_total_material += item_total_material
        grand_total_facility += job_gross_cost + facility_tax
        grand_total_job += scc_surcharge
        grand_eiv += eiv

        # ---- Market price for product (Buy vs Build) ----
        prod_tid = plan["product"]["product_type_id"]
        prod_price = product_price_map.get(prod_tid, {})
        market_unit_price = None
        market_price_source = "unknown"

        if prod_price.get("override_price") is not None:
            market_unit_price = prod_price["override_price"]
            market_price_source = "override"
        elif prod_price.get("sell_price_min") is not None:
            market_unit_price = prod_price["sell_price_min"]
            market_price_source = "jita_sell"
        elif prod_price.get("average_price") is not None:
            market_unit_price = prod_price["average_price"]
            market_price_source = "average"

        results.append({
            "blueprint_type_id": plan["blueprint_type_id"],
            "product_type_id": prod_tid,
            "product_name": plan["product"]["product_name"],
            "product_quantity_per_run": plan["product"]["product_quantity_per_run"],
            "total_product_quantity": plan["product"]["product_quantity_per_run"] * plan["runs"],
            "runs": plan["runs"],
            "me": plan["me"],
            "te": plan["te"],
            "materials": material_costs,
            "total_material_cost": round(item_total_material, 2),
            "eiv": round(eiv, 2),
            "system_cost_amount": round(system_cost_amount, 2),
            "job_gross_cost": round(job_gross_cost, 2),
            "facility_tax": round(facility_tax, 2),
            "scc_surcharge": round(scc_surcharge, 2),
            "total_job_cost": round(total_job_cost, 2),
            "facility_cost": round(job_gross_cost + facility_tax, 2),
            "job_cost": round(scc_surcharge, 2),
            "total_cost": round(item_total, 2),
            "cost_per_unit": round(item_total / max(plan["runs"], 1), 2),
            "product_sell_price": round(prod_price.get("sell_price_min"), 2) if prod_price.get("sell_price_min") else None,
            "product_buy_price": round(prod_price.get("buy_price_max"), 2) if prod_price.get("buy_price_max") else None,
            "market_price_per_unit": round(market_unit_price, 2) if market_unit_price else None,
            "market_price_source": market_price_source,
            # Build time with TE applied (seconds)
            "build_time_seconds": round(
                (plan["product"]["manufacturing_time"] or 0) * plan["runs"] * (1.0 - 0.02 * min(plan["te"], 20))
            ) if plan["product"].get("manufacturing_time") else None,
        })

    grand_total = grand_total_material + grand_total_facility + grand_total_job

    return {
        "items": results,
        "grand_total_material_cost": round(grand_total_material, 2),
        "grand_total_facility_cost": round(grand_total_facility, 2),
        "grand_total_job_cost": round(grand_total_job, 2),
        "grand_eiv": round(grand_eiv, 2),
        "grand_total": round(grand_total, 2),
        "pricing": {
            "source": "jita",
            "missing_prices": len(missing_prices),
            "missing_type_ids": missing_prices[:50],
            "overrides_applied": sum(
                1 for r in results
                for m in r["materials"]
                if m["price_source"] == "override"
            ),
        },
    }


# ── Build Steps / Recursive BOM (F3e) ─────────────────────────────


class BuildStepNode(BaseModel):
    """A single node in the recursive build chain."""
    blueprint_type_id: int
    blueprint_name: Optional[str] = None
    product_type_id: int
    product_name: Optional[str] = None
    product_quantity_per_run: int = 1
    runs_needed: int = 1
    me: int = 10
    te: int = 20
    depth: int = 0
    materials: List[dict] = []
    sub_steps: List["BuildStepNode"] = []


class BuildStepsResponse(BaseModel):
    blueprint_type_id: int
    blueprint_name: Optional[str] = None
    product_type_id: int
    product_name: Optional[str] = None
    runs: int = 1
    me: int = 10
    te: int = 20
    steps: List[BuildStepNode] = []
    aggregated_materials: List[dict] = []
    max_depth_reached: int = 0


@router.get("/{blueprint_type_id}/build-steps", response_model=BuildStepsResponse)
async def get_build_steps(
    blueprint_type_id: int,
    runs: int = Query(1, ge=1, le=1000, description="Number of runs"),
    me: int = Query(10, ge=0, le=10, description="Material Efficiency level"),
    te: int = Query(20, ge=0, le=20, description="Time Efficiency level"),
    max_depth: int = Query(5, ge=1, le=10, description="Max recursion depth"),
    rig_mat_bonus: float = Query(0.0, ge=0.0, le=0.2, description="Combined rig+security material bonus (0-0.2)"),
    db: AsyncSession = Depends(get_session),
):
    """
    Recursively resolve the full build chain for a blueprint.

    Starting from the top-level blueprint, each material that is itself
    a product of another manufacturing blueprint is expanded into its
    own sub-step. This continues until max_depth or until only raw
    (non-manufacturable) materials remain.

    Returns both a tree of nested build steps AND a flat aggregated
    list of all leaf materials with total quantities.
    """
    import math

    # ---- Resolve a single blueprint step ----
    async def resolve_step(
        bp_type_id: int,
        needed_runs: int,
        step_me: int,
        step_te: int,
        depth: int,
        visited: set,
    ) -> dict:
        """Return a dict representing one build step and its sub-steps."""
        if depth > max_depth:
            return None

        # Prevent infinite loops (circular dependencies don't exist in EVE
        # but safeguard anyway)
        cache_key = (bp_type_id, depth)
        if cache_key in visited:
            return None
        visited.add(cache_key)

        # Fetch blueprint info + materials + product
        sql = text("""
            SELECT
                sbm.material_type_id,
                si.name AS material_name,
                si.category_id,
                si.category_name,
                sbm.quantity AS base_quantity,
                sbm.is_optional,
                sbp.product_type_id,
                sbp.product_name,
                sbp.quantity AS product_quantity,
                sb.manufacturing_time,
                bpsi.name AS bp_name
            FROM sde_blueprint_materials sbm
            LEFT JOIN sde_items si ON si.type_id = sbm.material_type_id
            JOIN sde_blueprints sb ON sb.type_id = sbm.type_id AND sb.activity_id = 1
            JOIN sde_blueprint_products sbp ON sbp.type_id = sbm.type_id AND sbp.activity_id = 1
            LEFT JOIN sde_items bpsi ON bpsi.type_id = sbm.type_id
            WHERE sbm.type_id = :bp_id
              AND sbm.activity_id = 1
        """)
        result = await db.execute(sql, {"bp_id": bp_type_id})
        rows = result.all()

        if not rows:
            # Try without product join (reactions, etc.)
            sql2 = text("""
                SELECT
                    sbm.material_type_id,
                    si.name AS material_name,
                    si.category_id,
                    si.category_name,
                    sbm.quantity AS base_quantity,
                    sbm.is_optional,
                    NULL::int AS product_type_id,
                    NULL::varchar AS product_name,
                    NULL::int AS product_quantity,
                    sb.manufacturing_time,
                    bpsi.name AS bp_name
                FROM sde_blueprint_materials sbm
                LEFT JOIN sde_items si ON si.type_id = sbm.material_type_id
                JOIN sde_blueprints sb ON sb.type_id = sbm.type_id AND sb.activity_id = 1
                LEFT JOIN sde_items bpsi ON bpsi.type_id = sbm.type_id
                WHERE sbm.type_id = :bp_id
                  AND sbm.activity_id = 1
            """)
            result = await db.execute(sql2, {"bp_id": bp_type_id})
            rows = result.all()

        if not rows:
            return None

        product_type_id = None
        product_name = f"Blueprint {bp_type_id}"
        product_quantity_per_run = 1
        bp_name = None

        materials = []
        seen_materials = {}
        sub_steps = []

        for row in rows:
            if product_type_id is None and getattr(row, "product_type_id", None):
                product_type_id = row.product_type_id
                product_name = getattr(row, "product_name", None) or f"Product {row.product_type_id}"
                product_quantity_per_run = getattr(row, "product_quantity", 1) or 1
                bp_name = getattr(row, "bp_name", None)

            if not getattr(row, "material_type_id", None):
                continue

            base_qty = row.base_quantity or 0
            # EVE ME-Formel: me/100 Reduktion + Rig-Materialbonus
            adjusted = base_qty
            if base_qty > 0:
                me_factor = 1.0 - (step_me / 100.0)
                adjusted = max(1, math.ceil(base_qty * me_factor * (1.0 - rig_mat_bonus)))
            total_qty = adjusted * needed_runs

            # Deduplicate by material_type_id (SDE product JOIN can multiply rows)
            if row.material_type_id in seen_materials:
                if getattr(row, "is_optional", False):
                    idx = seen_materials[row.material_type_id]
                    materials[idx]["is_optional"] = True
                continue
            seen_materials[row.material_type_id] = len(materials)

            mat_entry = {
                "material_type_id": row.material_type_id,
                "material_name": getattr(row, "material_name", None) or f"Unknown ({row.material_type_id})",
                "category_id": getattr(row, "category_id", None),
                "category_name": getattr(row, "category_name", None),
                "base_quantity": base_qty,
                "adjusted_quantity": adjusted,
                "total_quantity": total_qty,
                "is_optional": getattr(row, "is_optional", False),
            }

            materials.append(mat_entry)

        # Check which materials are themselves manufacturable and recurse
        if depth < max_depth and materials:
            material_type_ids = [m["material_type_id"] for m in materials if not m["is_optional"]]

            if material_type_ids:
                # Find which of these material_type_ids are products of another blueprint
                manu_sql = text("""
                    SELECT
                        sbp.product_type_id,
                        sbp.type_id AS child_bp_type_id,
                        sbp.product_name,
                        sbp.quantity AS product_quantity,
                        bpsi2.name AS child_bp_name
                    FROM sde_blueprint_products sbp
                    JOIN sde_blueprints sb2 ON sb2.type_id = sbp.type_id AND sb2.activity_id = 1
                    LEFT JOIN sde_items bpsi2 ON bpsi2.type_id = sbp.type_id
                    WHERE sbp.activity_id = 1
                      AND sbp.product_type_id = ANY(:mat_ids)
                """)
                manu_result = await db.execute(
                    manu_sql,
                    {"mat_ids": material_type_ids},
                )
                manu_map = {}
                for mr in manu_result:
                    manu_map[mr.product_type_id] = {
                        "child_bp_type_id": mr.child_bp_type_id,
                        "child_bp_name": getattr(mr, "child_bp_name", None),
                        "product_quantity": mr.product_quantity,
                        "product_name": mr.product_name,
                    }

                # Now resolve sub-steps for each manufacturable material
                for mat in materials:
                    child_info = manu_map.get(mat["material_type_id"])
                    if child_info:
                        # How many runs of the child BP to produce enough?
                        child_per_run = child_info["product_quantity"] or 1
                        child_runs_needed = max(
                            1,
                            math.ceil(mat["total_quantity"] / child_per_run),
                        )

                        child_step = await resolve_step(
                            child_info["child_bp_type_id"],
                            child_runs_needed,
                            me,  # Use same ME for sub-steps (could use 10 for BPO default)
                            20,  # Sub-steps default TE (BPO = 20)
                            depth + 1,
                            visited,
                        )
                        if child_step:
                            sub_steps.append(child_step)

        return {
            "blueprint_type_id": bp_type_id,
            "blueprint_name": bp_name,
            "product_type_id": product_type_id,
            "product_name": product_name,
            "product_quantity_per_run": product_quantity_per_run,
            "runs_needed": needed_runs,
            "me": step_me,
            "te": step_te,
            "depth": depth,
            "materials": materials,
            "sub_steps": sub_steps,
        }

    # ---- Aggregate leaf materials from the tree ----
    def aggregate_leaves(step: dict, multiplier: int = 1, collector: dict = None) -> dict:
        """Walk the tree and collect only leaf (non-manufacturable) materials."""
        if collector is None:
            collector = {}

        for mat in step.get("materials", []):
            if mat.get("is_optional"):
                continue
            mid = mat["material_type_id"]
            # Check if this material has a sub_step (meaning it's manufacturable)
            has_sub = any(
                s.get("product_type_id") == mid
                for s in step.get("sub_steps", [])
            )
            if not has_sub:
                qty = mat["total_quantity"] * multiplier
                if mid in collector:
                    collector[mid]["total_quantity"] += qty
                else:
                    collector[mid] = {
                        "material_type_id": mid,
                        "material_name": mat["material_name"],
                        "total_quantity": qty,
                    }

        for sub in step.get("sub_steps", []):
            aggregate_leaves(sub, multiplier, collector)

        return collector

    # ---- Execute ----
    top_step = await resolve_step(blueprint_type_id, runs, me, te, 0, set())

    if not top_step:
        raise HTTPException(
            status_code=404,
            detail=f"Blueprint {blueprint_type_id} not found or has no manufacturing data",
        )

    # Collect leaf materials
    leaf_collector = aggregate_leaves(top_step)
    aggregated_materials = sorted(
        leaf_collector.values(),
        key=lambda m: m["material_name"] or "",
    )

    # Find max depth in the tree
    def max_depth_in_tree(step: dict) -> int:
        md = step.get("depth", 0)
        for sub in step.get("sub_steps", []):
            md = max(md, max_depth_in_tree(sub))
        return md

    return {
        "blueprint_type_id": blueprint_type_id,
        "blueprint_name": top_step.get("blueprint_name"),
        "product_type_id": top_step.get("product_type_id"),
        "product_name": top_step.get("product_name"),
        "runs": runs,
        "me": me,
        "te": te,
        "steps": [top_step],
        "aggregated_materials": aggregated_materials,
        "max_depth_reached": max_depth_in_tree(top_step),
    }


# ── Invention Options ──────────────────────────────────────────────────────
# What T2 BPCs can this T1 blueprint invent?


@router.get("/{t1_bp_id}/invention-options")
async def get_invention_options(
    t1_bp_id: int,
    user_id: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """Return invention data for a T1 blueprint: T2 BPC outcomes, datacore costs,
    required skills, and available decryptor options.

    Queries SDE activity_id=8 (Invention) data for the given blueprint type_id.
    """
    # ── 1. Get the T1 blueprint info ─────────────────────────────────────
    bp_stmt = select(SDEItem).where(
        SDEItem.type_id == t1_bp_id,
        SDEItem.is_blueprint == True,  # noqa: E712
    )
    bp_result = await db.execute(bp_stmt)
    t1_item = bp_result.scalars().first()

    if not t1_item:
        raise HTTPException(status_code=404, detail=f"Blueprint {t1_bp_id} not found")

    # ── 2. Get invention materials (datacores) ────────────────────────────
    mat_stmt = select(SDEBlueprintMaterial).where(
        SDEBlueprintMaterial.type_id == t1_bp_id,
        SDEBlueprintMaterial.activity_id == 8,
    )
    mat_result = await db.execute(mat_stmt)
    sde_materials = mat_result.scalars().all()

    if not sde_materials:
        return {
            "blueprint": {
                "type_id": t1_item.type_id,
                "name": t1_item.name,
                "group_name": t1_item.group_name,
            },
            "has_invention": False,
            "materials": [],
            "products": [],
            "skills": [],
            "decryptors": [],
        }

    # ── 2b. Material prices (buy/sell/custom columns) ─────────────────────
    material_type_ids = [m.material_type_id for m in sde_materials]
    price_stmt = select(CachedPrice).where(CachedPrice.type_id.in_(material_type_ids))
    price_result = await db.execute(price_stmt)
    cached_prices = {p.type_id: p for p in price_result.scalars().all()}

    # Fetch user override prices for this character if available
    user_price_stmt = select(UserItemPrice).where(
        UserItemPrice.character_id == user_id,
        UserItemPrice.type_id.in_(material_type_ids),
    )
    user_price_result = await db.execute(user_price_stmt)
    user_price_map = {p.type_id: p.override_price for p in user_price_result.scalars().all()}

    materials = []
    for m in sde_materials:
        cp = cached_prices.get(m.material_type_id)
        sell_price = cp.sell_price_min if cp else None
        buy_price = cp.buy_price_max if cp else None
        avg_price = cp.average_price if cp else None
        adj_price = cp.adjusted_price if cp else None
        custom_price = user_price_map.get(m.material_type_id)

        # Effective price cascade: custom > sell > buy > average > adjusted
        effective = custom_price or sell_price or buy_price or avg_price or adj_price
        materials.append({
            "material_type_id": m.material_type_id,
            "name": m.material_name,
            "quantity": m.quantity,
            "sell_price": round(sell_price, 2) if sell_price else None,
            "buy_price": round(buy_price, 2) if buy_price else None,
            "custom_price": round(custom_price, 2) if custom_price else None,
            "unit_price": round(effective, 2) if effective else None,
            "total_cost": round(effective * m.quantity, 2) if effective else None,
            "is_optional": m.is_optional or False,
        })

    # ── 3. Get invention products (T2 BPCs) ──────────────────────────────
    prod_stmt = select(SDEBlueprintProduct).where(
        SDEBlueprintProduct.type_id == t1_bp_id,
        SDEBlueprintProduct.activity_id == 8,
    )
    prod_result = await db.execute(prod_stmt)
    sde_products = prod_result.scalars().all()

    # Collect all product T2 BPC type_ids to find what they manufacture
    t2_bpc_ids = [p.product_type_id for p in sde_products]
    t2_bpcs_info = {}
    t2_items_info = {}
    t2_mfg_map = {}
    t2_price_map = {}

    if t2_bpc_ids:
        # Get the T2 BPC names from SDE items
        t2_bpc_stmt = select(SDEItem).where(SDEItem.type_id.in_(t2_bpc_ids))
        t2_bpc_result = await db.execute(t2_bpc_stmt)
        t2_bpcs_info = {item.type_id: item for item in t2_bpc_result.scalars().all()}

        # Get what each T2 BPC manufactures (activity_id=1 product for each BPC)
        mfg_prod_stmt = select(SDEBlueprint).where(
            SDEBlueprint.type_id.in_(t2_bpc_ids),
            SDEBlueprint.activity_id == 1,
        )
        mfg_prod_result = await db.execute(mfg_prod_stmt)
        t2_mfg_map = {}
        t2_item_type_ids = []
        for bp_row in mfg_prod_result.scalars().all():
            if bp_row.product_type_id:
                t2_mfg_map[bp_row.type_id] = bp_row.product_type_id
                t2_item_type_ids.append(bp_row.product_type_id)

        # Get T2 item names and prices
        if t2_item_type_ids:
            t2_item_stmt = select(SDEItem).where(SDEItem.type_id.in_(t2_item_type_ids))
            t2_item_result = await db.execute(t2_item_stmt)
            t2_items_info = {item.type_id: item for item in t2_item_result.scalars().all()}

            # Prices for T2 items
            t2_price_stmt = select(CachedPrice).where(CachedPrice.type_id.in_(t2_item_type_ids))
            t2_price_result = await db.execute(t2_price_stmt)
            t2_price_map = {p.type_id: (p.sell_price_min or p.average_price or p.adjusted_price)
                           for p in t2_price_result.scalars().all()}
        else:
            t2_price_map = {}

    # Deduplicate products by product_type_id (SDE can have duplicate rows)
    seen_products = {}
    for p in sde_products:
        if p.product_type_id not in seen_products:
            seen_products[p.product_type_id] = p

    products = []
    for prod_type_id, p in seen_products.items():
        bpc_info = t2_bpcs_info.get(p.product_type_id)
        t2_item_type_id = t2_mfg_map.get(p.product_type_id)
        t2_item = t2_items_info.get(t2_item_type_id) if t2_item_type_id else None
        t2_item_price = t2_price_map.get(t2_item_type_id) if t2_item_type_id else None

        products.append({
            "product_type_id": p.product_type_id,
            "product_name": bpc_info.name if bpc_info else p.product_name,
            "quantity": p.quantity,
            "probability": p.probability,
            "t2_item_type_id": t2_item_type_id,
            "t2_item_name": t2_item.name if t2_item else None,
            "t2_item_price": round(t2_item_price, 2) if t2_item_price else None,
        })

    # ── 4. Get invention skills ──────────────────────────────────────────
    skill_stmt = select(SDEBlueprintSkill).where(
        SDEBlueprintSkill.type_id == t1_bp_id,
        SDEBlueprintSkill.activity_id == 8,
    ).order_by(SDEBlueprintSkill.level, SDEBlueprintSkill.skill_name)
    skill_result = await db.execute(skill_stmt)
    sde_skills = skill_result.scalars().all()

    # Deduplicate skills by skill_type_id, keeping the highest level
    seen_skills = {}
    for s in sde_skills:
        if s.skill_type_id not in seen_skills or seen_skills[s.skill_type_id].level < s.level:
            seen_skills[s.skill_type_id] = s

    skills = [
        {
            "skill_type_id": s.skill_type_id,
            "name": s.skill_name,
            "level": s.level,
        }
        for s in seen_skills.values()
    ]

    # ── 5. Decryptors (buy/sell/custom columns) ───────────────────────────
    from app.services.invention_service import DECRYPTORS

    decryptor_type_ids = [d["type_id"] for d in DECRYPTORS]
    dec_price_stmt = select(CachedPrice).where(CachedPrice.type_id.in_(decryptor_type_ids))
    dec_price_result = await db.execute(dec_price_stmt)
    dec_cache_map = {p.type_id: p for p in dec_price_result.scalars().all()}

    # Fetch user override prices for decryptors
    user_dec_stmt = select(UserItemPrice).where(
        UserItemPrice.character_id == user_id,
        UserItemPrice.type_id.in_(decryptor_type_ids),
    )
    user_dec_result = await db.execute(user_dec_stmt)
    user_dec_map = {p.type_id: p.override_price for p in user_dec_result.scalars().all()}

    decryptors = []
    for d in DECRYPTORS:
        cp = dec_cache_map.get(d["type_id"])
        sell_price = cp.sell_price_min if cp else None
        buy_price = cp.buy_price_max if cp else None
        avg_price = cp.average_price if cp else None
        adj_price = cp.adjusted_price if cp else None
        custom_price = user_dec_map.get(d["type_id"])

        # Effective price cascade: custom > sell > buy > average > adjusted
        effective = custom_price or sell_price or buy_price or avg_price or adj_price
        decryptors.append({
            "type_id": d["type_id"],
            "name": d["name"],
            "prob": d["prob"],
            "runs": d["runs"],
            "me": d["me"],
            "te": d["te"],
            "sell_price": round(sell_price, 2) if sell_price else None,
            "buy_price": round(buy_price, 2) if buy_price else None,
            "custom_price": round(custom_price, 2) if custom_price else None,
            "price": round(effective, 2) if effective else None,
        })

    return {
        "blueprint": {
            "type_id": t1_item.type_id,
            "name": t1_item.name,
            "group_name": t1_item.group_name,
        },
        "has_invention": True,
        "materials": materials,
        "products": products,
        "skills": skills,
        "decryptors": decryptors,
    }


# ── Batch Price Lookup ──────────────────────────────────────────


class BatchPriceItem(BaseModel):
    type_id: int
    type_name: Optional[str] = None
    sell_price_min: Optional[float] = None
    buy_price_max: Optional[float] = None
    average_price: Optional[float] = None
    adjusted_price: Optional[float] = None
    override_price: Optional[float] = None
    weighted_average_price: Optional[float] = None
    price_source: Optional[str] = None


@router.get("/batch-prices")
async def batch_prices(
    type_ids: str = Query(..., description="Comma-separated type IDs"),
    character_id: int = Query(0, description="Optional character ID for user overrides"),
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """
    Batch-fetch prices for one or more type IDs.

    Returns cached market prices (sell, buy, average, adjusted)
    merged with user price overrides (override_price, weighted_average_price).

    Price priority (for frontend use):
    1. override_price (user override)
    2. sell_price_min (Jita lowest sell)
    3. buy_price_max (Jita highest buy)
    4. average_price
    5. weighted_average_price (user's historic average)
    """
    # Parse comma-separated type IDs
    ids = []
    for part in type_ids.split(","):
        part = part.strip()
        if part:
            try:
                ids.append(int(part))
            except ValueError:
                pass

    if not ids:
        return {"prices": [], "fetched_at": None, "missing_count": 0}

    # 1. Fetch cached_prices
    price_stmt = select(CachedPrice).where(CachedPrice.type_id.in_(ids))
    price_result = await db.execute(price_stmt)
    price_rows = price_result.scalars().all()
    price_map = {p.type_id: p for p in price_rows}

    # 2. Fetch user price overrides
    user_map = {}
    if character_id > 0:
        up_stmt = select(UserItemPrice).where(
            UserItemPrice.type_id.in_(ids),
            UserItemPrice.character_id == character_id,
        )
        up_result = await db.execute(up_stmt)
        for up in up_result.scalars().all():
            user_map[up.type_id] = up

    # 3. Build response
    prices = []
    from datetime import datetime, timezone

    for tid in ids:
        cp = price_map.get(tid)
        up = user_map.get(tid)

        entry = BatchPriceItem(type_id=tid)

        if cp:
            entry.type_name = cp.type_name
            entry.sell_price_min = round(cp.sell_price_min, 2) if cp.sell_price_min else None
            entry.buy_price_max = round(cp.buy_price_max, 2) if cp.buy_price_max else None
            entry.average_price = round(cp.average_price, 2) if cp.average_price else None
            entry.adjusted_price = round(cp.adjusted_price, 2) if cp.adjusted_price else None

        if up:
            entry.override_price = round(up.override_price, 2) if up.override_price else None
            entry.weighted_average_price = round(up.weighted_average_price, 2) if up.weighted_average_price else None
            entry.price_source = up.price_source or "jita"

        # Determine effective price_source if not set
        if not entry.price_source:
            if up and up.override_price:
                entry.price_source = "override"
            elif cp and cp.sell_price_min:
                entry.price_source = "jita_sell"
            else:
                entry.price_source = "jita"

        prices.append(entry)

    missing_count = sum(1 for p in prices if p.sell_price_min is None and p.override_price is None)

    return {
        "prices": [p.model_dump() for p in prices],
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "missing_count": missing_count,
    }


# ── User Price Override ──────────────────────────────────────────


class UserPriceRequest(BaseModel):
    type_id: int
    character_id: int
    override_price: Optional[float] = None
    price_source: Optional[str] = "override"


@router.put("/user-price")
async def set_user_price(
    body: UserPriceRequest,
    _user: int = Depends(require_auth),
    db: AsyncSession = Depends(get_session),
):
    """
    Set or clear a user price override for a specific type_id.

    If override_price is null, the override is cleared (price_source resets to 'jita').
    """
    # Check if a row already exists
    stmt = select(UserItemPrice).where(
        UserItemPrice.type_id == body.type_id,
        UserItemPrice.character_id == body.character_id,
    )
    result = await db.execute(stmt)
    existing = result.scalar_one_or_none()

    if existing:
        if body.override_price is not None:
            existing.override_price = body.override_price
            existing.price_source = body.price_source or "override"
        else:
            # Clear override: reset to jita default
            existing.override_price = None
            existing.price_source = "jita"
        existing.updated_at = func.now()
    else:
        if body.override_price is None:
            # No existing row and no override to set — nothing to do
            return {"success": True, "action": "noop"}
        new_row = UserItemPrice(
            character_id=body.character_id,
            type_id=body.type_id,
            override_price=body.override_price,
            price_source=body.price_source or "override",
        )
        db.add(new_row)

    await db.commit()
    return {"success": True, "action": "updated" if existing else "created"}
