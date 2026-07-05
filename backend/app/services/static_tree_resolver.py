"""
Static Market Tree Resolver – resolves item names to type_ids from the SDE DB
using the authoritative ESI market tree structure.

Key principles:
1. Tree structure comes from CCP's ESI API (static file, 100% reliable)
2. Items are found by NAME → type_id (NO market_group_id dependency)
3. BPO/BPC counts, meta_group, category info enriched from DB after tree placement
"""
import logging
from typing import Optional
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.data.esi_market_tree import MARKET_TREE

logger = logging.getLogger(__name__)


def _collect_all_item_names(nodes: list[dict]) -> set[str]:
    """Recursively collect all item names from the static tree."""
    names = set()
    for node in nodes:
        if node.get("items"):
            for item_name in node["items"]:
                if item_name:
                    names.add(item_name)
        if node.get("children"):
            names.update(_collect_all_item_names(node["children"]))
    return names


def _walk_and_resolve(
    nodes: list[dict],
    name_to_id: dict[str, int],
    sde_data: dict[int, dict],
    bp_data: dict[int, dict],
    require_blueprint: bool = True,
) -> list[dict]:
    """Walk the static tree and resolve item names to product entries.

    Args:
        nodes: Static tree nodes to resolve.
        name_to_id: Mapping of item name → type_id.
        sde_data: SDE metadata for each type_id.
        bp_data: Blueprint data for product_type_ids that have manufacturable BPs.
        require_blueprint: When True (default), only include items that have
            a manufacturable blueprint (exist in sde_blueprint_products).
            This mirrors the old catalog SQL which JOINed on blueprint_products.
    """
    result = []
    for node in nodes:
        resolved_node = {
            "market_group_id": node.get("esi_id"),
            "name": node["name"],
            "children": [],
            "products": None,
            "races": None,
        }

        if node.get("children"):
            resolved_node["children"] = _walk_and_resolve(
                node["children"], name_to_id, sde_data, bp_data, require_blueprint
            )

        if node.get("items"):
            products = []
            for item_name in node["items"]:
                type_id = name_to_id.get(item_name)
                if type_id is None:
                    logger.warning(f"Item '{item_name}' not found in sde_items – skipping")
                    continue

                sde = sde_data.get(type_id, {})
                bp = bp_data.get(type_id, {})

                # ── Crucial: only show items that have a manufacturable blueprint ──
                # The old catalog SQL joined sde_blueprint_products which naturally
                # excluded items without BPs (meta 2/3/4, faction, etc.).
                # If require_blueprint=True and this product_type_id is NOT in bp_data,
                # it has no manufacturable blueprint → skip it.
                if require_blueprint and type_id not in bp_data:
                    continue

                products.append({
                    "product_type_id": type_id,
                    "product_name": item_name,
                    "meta_group_name": sde.get("meta_group_name"),
                    "meta_group_id": sde.get("meta_group_id"),
                    "blueprint_type_id": bp.get("blueprint_type_id", type_id),
                    "blueprint_type_name": bp.get("blueprint_type_name") or item_name,
                    "bpo_count": bp.get("bpo_count", 0),
                    "bpc_count": bp.get("bpc_count", 0),
                    "best_me": bp.get("best_me"),
                    "best_te": bp.get("best_te"),
                    "total_bpc_runs": bp.get("total_bpc_runs", 0),
                    "bpos": [],
                    "bpcs": [],
                    "is_reaction": bp.get("is_reaction", False),
                    "tech_level": bp.get("tech_level"),
                    "group_name": sde.get("group_name"),
                    "category_name": sde.get("category_name"),
                    "category_id": sde.get("category_id"),
                    "race_name": sde.get("race_name"),
                    "race_id": sde.get("race_id"),
                })

            products.sort(key=lambda p: p["product_name"])
            resolved_node["products"] = products if products else None

        result.append(resolved_node)

    return result


async def resolve_static_tree(
    db: AsyncSession,
    user_id: int,
    search: Optional[str] = None,
    filter_mode: str = "all",
) -> list[dict]:
    """
    Resolve the static ESI market tree with blueprint data from the SDE database.

    This replaces the old _build_market_tree_from_rows() approach that relied on
    sde_items.market_group_id (which has NULL gaps). The static tree from ESI
    is the authoritative source for group structure – we only use the DB for
    resolving item names → type_ids and enriching with BPO/BPC data.

    Args:
        db: Database session
        user_id: Current user ID for BPO/BPC counts
        search: Optional product name filter
        filter_mode: 'all', 'bpo', 'bpc', 't2'

    Returns:
        List of market tree root node dicts (same format as old _build_market_tree_from_rows)
    """
    # Step 1: Collect all item names from the static tree
    all_names = _collect_all_item_names(MARKET_TREE)

    if not all_names:
        logger.error("Static market tree has no item names!")
        return []

    # Step 2: Build name → type_id lookup from sde_items
    # We query ONLY name/type_id mapping – NO market_group_id!
    # Using a large IN clause with parameterized query
    name_list = sorted(all_names)
    batch_size = 500

    name_to_type_id: dict[str, int] = {}
    sde_data: dict[int, dict] = {}

    for i in range(0, len(name_list), batch_size):
        batch_names = name_list[i:i + batch_size]

        # Build parameter placeholders
        placeholders = ",".join([f":n{j}" for j in range(len(batch_names))])
        params = {f"n{j}": name for j, name in enumerate(batch_names)}

        sql = text(f"""
            SELECT
                si.type_id,
                si.name,
                si.group_name,
                si.category_name,
                si.category_id,
                si.meta_group_name,
                si.meta_group_id,
                si.race_name,
                si.race_id
            FROM sde_items si
            WHERE si.name IN ({placeholders})
        """)

        result = await db.execute(sql, params)
        for row in result.all():
            tid = row.type_id
            name_to_type_id[row.name] = tid
            sde_data[tid] = {
                "group_name": row.group_name,
                "category_name": row.category_name,
                "category_id": row.category_id,
                "meta_group_name": row.meta_group_name,
                "meta_group_id": row.meta_group_id,
                "race_name": row.race_name,
                "race_id": row.race_id,
            }

    logger.info(f"Resolved {len(name_to_type_id)}/{len(all_names)} item names to type_ids")

    # Step 3: Get BPO/BPC data for resolved type_ids
    resolved_ids = list(name_to_type_id.values())
    bp_data: dict[int, dict] = {}

    for i in range(0, len(resolved_ids), batch_size):
        batch_ids = resolved_ids[i:i + batch_size]
        placeholders = ",".join([f":id{j}" for j in range(len(batch_ids))])
        params = {f"id{j}": tid for j, tid in enumerate(batch_ids)}
        params["user_id"] = user_id

        sql = text(f"""
            SELECT
                sbp.product_type_id,
                sbp.product_name,
                sbp.type_id AS blueprint_type_id,
                sb.tech_level,
                sb.is_reaction,
                COUNT(DISTINCT CASE WHEN a.is_blueprint_copy = false AND a.id IS NOT NULL THEN a.id END) AS bpo_count,
                COUNT(DISTINCT CASE WHEN a.is_blueprint_copy = true AND a.id IS NOT NULL THEN a.id END) AS bpc_count,
                MAX(a.blueprint_me) AS best_me,
                MAX(a.blueprint_te) AS best_te,
                COALESCE(SUM(CASE WHEN a.is_blueprint_copy = true AND a.character_id = :user_id
                    THEN a.blueprint_runs ELSE 0 END), 0) AS total_bpc_runs
            FROM sde_blueprint_products sbp
            JOIN sde_blueprints sb ON sb.type_id = sbp.type_id AND sb.activity_id IN (1, 11)
            LEFT JOIN assets a ON a.type_id = sb.type_id AND a.is_blueprint = true
            WHERE sbp.product_type_id IN ({placeholders})
            GROUP BY sbp.product_type_id, sbp.product_name, sbp.type_id, sb.tech_level, sb.is_reaction
        """)

        result = await db.execute(sql, params)
        for row in result.all():
            bp_data[row.product_type_id] = {
                "blueprint_type_id": row.blueprint_type_id,
                "blueprint_type_name": row.product_name,
                "is_reaction": row.is_reaction or False,
                "bpo_count": row.bpo_count or 0,
                "bpc_count": row.bpc_count or 0,
                "best_me": row.best_me,
                "best_te": row.best_te,
                "total_bpc_runs": row.total_bpc_runs or 0,
                "tech_level": row.tech_level,
            }

    logger.info(f"Found BPO/BPC data for {len(bp_data)}/{len(resolved_ids)} products")

    # Step 4: Walk the static tree and build resolved nodes
    tree = _walk_and_resolve(MARKET_TREE, name_to_type_id, sde_data, bp_data)

    # Step 5: Apply search filter if needed
    if search:
        tree = _filter_tree_by_search(tree, search.lower())

    # Step 6: Apply server-side sub-filter
    if filter_mode == "bpo":
        tree = _filter_tree_by_condition(tree, lambda p: (p.get("bpo_count") or 0) > 0)
    elif filter_mode == "bpc":
        tree = _filter_tree_by_condition(tree, lambda p: (p.get("bpc_count") or 0) > 0)
    elif filter_mode == "t2":
        # T2 filter: only Tech II items WITH owned BPC
        # (meta_group_id=2 is Tech II)
        tree = _filter_tree_by_condition(tree, lambda p: (p.get("meta_group_id") or 0) == 2 and (p.get("bpc_count") or 0) > 0)

    # Step 7: Add race subdivisions for ship groups
    _add_race_subdivisions(tree)

    # Step 8: Remove empty nodes
    tree = _remove_empty_nodes(tree)

    return tree


def _filter_tree_by_search(nodes: list[dict], search: str) -> list[dict]:
    """Filter tree to only nodes matching the search term."""
    result = []
    for node in nodes:
        matched = False
        # Check if this node name matches
        if search in node.get("name", "").lower():
            matched = True

        # Check children
        filtered_children = []
        if node.get("children"):
            filtered_children = _filter_tree_by_search(node["children"], search)
            if filtered_children:
                matched = True

        # Check products
        filtered_products = []
        if node.get("products"):
            for prod in node["products"]:
                if search in prod.get("product_name", "").lower():
                    filtered_products.append(prod)
                    matched = True

        if not matched:
            continue

        new_node = dict(node)
        new_node["children"] = filtered_children
        new_node["products"] = filtered_products if filtered_products else node.get("products")
        result.append(new_node)

    return result


def _filter_tree_by_condition(nodes: list[dict], condition) -> list[dict]:
    """Filter tree to only nodes with products matching the condition."""
    result = []
    for node in nodes:
        # Check children recursively
        filtered_children = []
        if node.get("children"):
            filtered_children = _filter_tree_by_condition(node["children"], condition)
            if filtered_children:
                filtered_children = _remove_empty_nodes(filtered_children)

        # Check this node's products
        filtered_products = []
        if node.get("products"):
            filtered_products = [p for p in node["products"] if condition(p)]

        has_content = bool(filtered_products or filtered_children)

        if not has_content:
            continue

        new_node = dict(node)
        new_node["children"] = filtered_children
        new_node["products"] = filtered_products if filtered_products else None
        result.append(new_node)

    return result


def _remove_empty_nodes(nodes: list[dict]) -> list[dict]:
    """Remove nodes that have no content (no products, and no children with content)."""
    result = []
    for node in nodes:
        # Recursively clean children
        if node.get("children"):
            node["children"] = _remove_empty_nodes(node["children"])

        has_products = bool(node.get("products"))
        has_children_with_content = any(
            _node_has_content(c) for c in node.get("children", [])
        )

        if has_products or has_children_with_content:
            result.append(node)
    return result


def _node_has_content(node: dict) -> bool:
    """Check if a tree node has any products or children with products."""
    if node.get("products"):
        return True
    for child in node.get("children", []):
        if _node_has_content(child):
            return True
    return False


def _add_race_subdivisions(nodes: list[dict], parent_is_ship_parent: bool = False):
    """
    Add race subdivisions for ship groups.
    Ships in the ESI tree are organized as:
      Ships > Standard Frigates > Amarr / Caldari / Gallente / Minmatar
    Each race leaf group contains items that we need to subdivide by race.

    The ESI tree already has race groups as leaf nodes under ship parents.
    We just need to ensure the frontend recognizes the race structure.
    """
    SHIP_PARENT_NAMES = {
        "Standard Frigates", "Standard Destroyers", "Standard Cruisers",
        "Standard Battleships", "Standard Battlecruisers",
        "Assault Frigates", "Heavy Assault Cruisers", "Heavy Interdiction Cruisers",
        "Battlecruisers", "Logistics Frigates", "Command Destroyers",
        "Interceptors", "Interdictors", "Covert Ops",
        "Expedition Frigates", "Recon Ships", "Force Recon Ships",
        "Stealth Bombers", "Electronic Attack Ships", "Blockade Runners",
        "Bombers", "Attack Battlecruisers",
        "Haulers", "Freighters", "Transport Ships", "Deep Space Transport",
        "Industrial", "Capital Industrial Ships",
        "Shuttles",
    }

    RACE_SORT_ORDER = {"Amarr": 0, "Caldari": 1, "Gallente": 2, "Minmatar": 3, "Unknown": 99}
    RACE_NAMES = {"Amarr", "Caldari", "Gallente", "Minmatar"}

    for node in nodes:
        name = node.get("name", "")
        is_ship_parent = name in SHIP_PARENT_NAMES
        is_race_group = name in RACE_NAMES

        if is_ship_parent and node.get("children"):
            # This is a ship parent (e.g. "Standard Frigates")
            # Its children should be race groups
            race_children = node.get("children", [])
            for race_node in race_children:
                race_name = race_node.get("name", "")
                if race_name in RACE_NAMES and race_node.get("products"):
                    # Mark products with their race
                    for prod in race_node.get("products", []):
                        prod["_race_name"] = race_name
                    # Set races field for frontend
                    race_node["races"] = None  # Products are direct

            # Race groups are already in the tree from ESI structure
            # No need to modify the structure further

        elif node.get("products") and not node.get("children"):
            # Leaf node with products - check if this is a ship leaf
            group_name = node.get("name", "")
            if group_name in RACE_NAMES:
                # Mark products with correct race
                for prod in node["products"]:
                    prod["_race_name"] = group_name

        # Recurse into children
        if node.get("children"):
            _add_race_subdivisions(node["children"], is_ship_parent)
