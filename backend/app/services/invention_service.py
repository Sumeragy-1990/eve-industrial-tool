"""Invention Calculator Service – T2 invention cost/profit calculations (Phase 3C).

Calculates invention costs using cached market prices, skill levels,
and optional decryptors. Maps blueprint groups to required datacore types.
"""

import logging
import math
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cached_price import CachedPrice
from app.models.sde_item import SDEItem
from app.services.market_service import get_prices_batch

logger = logging.getLogger(__name__)

# ── Decryptor definitions ──────────────────────────────────────
# (type_id, name, probability_modifier, runs_modifier, me_modifier, te_modifier)

DECRYPTORS = [
    # EVE Decryptors — values from ESI dogma_attributes:
    # attr_1112 = probability multiplier, attr_1124 = max run modifier
    # attr_1113 = material efficiency, attr_1114 = time efficiency
    {"type_id": 34201, "name": "Accelerant Decryptor", "prob": 1.2, "runs": 1, "me": 2, "te": 10},
    {"type_id": 34202, "name": "Attainment Decryptor", "prob": 1.8, "runs": 4, "me": -1, "te": 4},
    {"type_id": 34203, "name": "Augmentation Decryptor", "prob": 0.6, "runs": 9, "me": -2, "te": 2},
    {"type_id": 34204, "name": "Parity Decryptor", "prob": 1.5, "runs": 3, "me": 1, "te": -2},
    {"type_id": 34205, "name": "Process Decryptor", "prob": 1.1, "runs": 0, "me": 3, "te": 6},
    {"type_id": 34206, "name": "Symmetry Decryptor", "prob": 1.0, "runs": 2, "me": 1, "te": 8},
    {"type_id": 34207, "name": "Optimized Attainment Decryptor", "prob": 1.9, "runs": 2, "me": 1, "te": -2},
    {"type_id": 34208, "name": "Optimized Augmentation Decryptor", "prob": 0.9, "runs": 7, "me": 2, "te": 0},
]

# ── Blueprint group → datacore mapping ─────────────────────────
# Each tuple: (group_name_match, datacore_1_type_id, datacore_1_name, datacore_2_type_id, datacore_2_name)
# Type IDs from EVE SDE

DATACORE_MAP = {
    # Racial Starship Engineering
    "amarr": {"dc1_id": 20414, "dc1_name": "Datacore - Amarr Starship Engineering",
              "dc2_id": 20415, "dc2_name": "Datacore - Mechanical Engineering"},
    "caldari": {"dc1_id": 20416, "dc1_name": "Datacore - Caldari Starship Engineering",
                "dc2_id": 20417, "dc2_name": "Datacore - Electronic Engineering"},
    "gallente": {"dc1_id": 20418, "dc1_name": "Datacore - Gallente Starship Engineering",
                 "dc2_id": 20419, "dc2_name": "Datacore - Mechanical Engineering"},
    "minmatar": {"dc1_id": 20420, "dc1_name": "Datacore - Minmatar Starship Engineering",
                 "dc2_id": 20421, "dc2_name": "Datacore - Electronic Engineering"},
    # Module Engineering
    "mechanical": {"dc1_id": 20415, "dc1_name": "Datacore - Mechanical Engineering",
                   "dc2_id": 20414, "dc2_name": "Datacore - Amarr Starship Engineering"},
    "electronic": {"dc1_id": 20417, "dc1_name": "Datacore - Electronic Engineering",
                   "dc2_id": 20416, "dc2_name": "Datacore - Caldari Starship Engineering"},
    "high_tech": {"dc1_id": 20423, "dc1_name": "Datacore - High Tech Engineering",
                  "dc2_id": 20424, "dc2_name": "Datacore - Nanite Engineering"},
    "graviton": {"dc1_id": 20422, "dc1_name": "Datacore - Graviton Physics",
                 "dc2_id": 20425, "dc2_name": "Datacore - Plasma Physics"},
    "laser": {"dc1_id": 20425, "dc1_name": "Datacore - Plasma Physics",
              "dc2_id": 20426, "dc2_name": "Datacore - Quantum Physics"},
    "magnetic": {"dc1_id": 20426, "dc1_name": "Datacore - Quantum Physics",
                 "dc2_id": 20427, "dc2_name": "Datacore - Electromagnetic Physics"},
    "rocket": {"dc1_id": 20424, "dc1_name": "Datacore - Nanite Engineering",
               "dc2_id": 20422, "dc2_name": "Datacore - Graviton Physics"},
}

# Guess datacore based on blueprint group name keywords
GROUP_DATACORE_GUESS = {
    "frigate": "amarr", "cruiser": "amarr", "battleship": "amarr",
    "destroyer": "amarr", "battlecruiser": "amarr",
    "armor": "amarr", "laser": "laser", "pulse": "laser", "beam": "laser",
    "shield": "caldari", "missile": "caldari", "hybrid": "caldari",
    "railgun": "caldari", "blaster": "caldari", "torpedo": "caldari",
    "drone": "gallente", "blaster": "gallente", "hybrid": "gallente",
    "projectile": "minmatar", "autocannon": "minmatar", "artillery": "minmatar",
    "afterburner": "mechanical", "armor repair": "mechanical", "capacitor": "mechanical",
    "sensor": "electronic", "ecm": "electronic", "warp": "electronic",
    "cynosural": "high_tech", "titan": "high_tech", "supercarrier": "high_tech",
    "bomb": "rocket", "bomber": "rocket",
}


async def invent_calculate(
    db: AsyncSession,
    t1_blueprint_type_id: int,
    skill_encryption: int = 5,
    skill_datacore_1: int = 5,
    skill_datacore_2: int = 5,
    decryptor_type_id: Optional[int] = None,
    system_cost_index: float = 0.01,
    runs: int = 1,
) -> dict:
    """Calculate invention cost and profit for a T1 blueprint.
    
    Returns detailed breakdown of costs, probability, and T2 BPC output.
    """
    # Get blueprint info from SDE
    stmt = select(SDEItem).where(SDEItem.type_id == t1_blueprint_type_id)
    result = await db.execute(stmt)
    bp_item = result.scalars().first()
    
    if not bp_item:
        return {"error": f"Blueprint type_id {t1_blueprint_type_id} not found in SDE"}
    
    # Find T2 product by name convention: "T1 Name Blueprint" → "T2 Name"
    t2_name = bp_item.name.replace(" Blueprint", "").replace("Civilian ", "")
    # Try "Navy" variant
    t2_candidates = []
    for suffix in ["Navy Issue", "Fleet Issue", "Covert Ops", "Assault", "Logistics",
                    "Interceptor", "Recon", "Heavy Assault", "Stealth Bomber",
                    "HIC", "Command", "Force Recon", "Combat Recon", "HAC", "AHAC",
                    "T2", "II"]:
        candidate = f"{t2_name} {suffix}"
        stmt2 = select(SDEItem).where(SDEItem.name == candidate)
        r2 = await db.execute(stmt2)
        item = r2.scalars().first()
        if item:
            t2_candidates.append({"type_id": item.type_id, "name": item.name})
    
    # Determine datacores based on group name
    group_name = (bp_item.group_name or "").lower()
    
    # Map group to datacore category
    dc_key = "amarr"  # default
    for keyword, key in GROUP_DATACORE_GUESS.items():
        if keyword in group_name:
            dc_key = key
            break
    
    dc_info = DATACORE_MAP.get(dc_key, DATACORE_MAP["amarr"])
    
    # Datacore quantities per attempt
    # (varies by item group; simplified: frigate=1, cruiser=2, battleship=3, module=1)
    dc_per_attempt = 1
    if any(kw in group_name for kw in ["frigate", "destroyer"]):
        dc_per_attempt = 1
    elif any(kw in group_name for kw in ["cruiser", "battlecruiser", "industrial"]):
        dc_per_attempt = 2
    elif any(kw in group_name for kw in ["battleship", "dreadnought", "carrier"]):
        dc_per_attempt = 3
    
    # Decryptor
    decryptor = None
    decryptor_price = 0
    if decryptor_type_id:
        for d in DECRYPTORS:
            if d["type_id"] == decryptor_type_id:
                decryptor = d
                break
        if decryptor:
            d_price = await _get_price(db, decryptor_type_id)
            decryptor_price = d_price or 0
    else:
        decryptor = {"prob": 1.0, "runs": 1, "me": 0, "te": 0}
    
    # Get datacore prices
    dc1_price = await _get_price(db, dc_info["dc1_id"]) or 0
    dc2_price = await _get_price(db, dc_info["dc2_id"]) or 0
    
    # Invention probability formula (EVE standard values)
    # Frigates/Destroyers: 30%, Cruisers/BC: 25%, Battleships: 20%, Capitals: 10%, Modules: 20%
    base_prob = 0.20  # Default for modules
    if any(kw in group_name for kw in ["frigate", "destroyer"]):
        base_prob = 0.30
    elif any(kw in group_name for kw in ["cruiser", "battlecruiser"]):
        base_prob = 0.25
    elif any(kw in group_name for kw in ["battleship"]):
        base_prob = 0.20
    elif any(kw in group_name for kw in ["capital", "dreadnought", "carrier"]):
        base_prob = 0.10
    
    # Skill effects
    enc_modifier = 1 + skill_encryption * 0.02  # +2% per level
    dc1_modifier = 1 + skill_datacore_1 * 0.02
    dc2_modifier = 1 + skill_datacore_2 * 0.02
    
    # Decryptor probability modifier
    dec_prob_mod = decryptor.get("prob", 1.0)
    
    # Final probability
    probability = base_prob * enc_modifier * dc1_modifier * dc2_modifier * dec_prob_mod
    probability = min(probability, 0.95)  # Cap at 95%
    
    # T2 BPC runs
    base_runs = 1  # Most things
    if any(kw in group_name for kw in ["frigate", "destroyer"]):
        base_runs = 10
    elif any(kw in group_name for kw in ["cruiser", "battlecruiser"]):
        base_runs = 5
    elif any(kw in group_name for kw in ["battleship"]):
        base_runs = 3
    
    dec_runs_mod = decryptor.get("runs", 1)
    t2_runs = base_runs * dec_runs_mod
    # Skills also give runs bonus for ship invention
    if any(kw in group_name for kw in ["frigate", "destroyer", "cruiser", "battlecruiser", "battleship"]):
        runs_skill_bonus = 1 + max(skill_datacore_1, skill_datacore_2) * 0.1
        t2_runs = math.floor(base_runs * dec_runs_mod * runs_skill_bonus)
    
    # ME/TE from decryptor
    t2_me = decryptor.get("me", 0)
    t2_te = decryptor.get("te", 0)
    
    # Per-attempt costs
    dc1_cost_total = dc1_price * dc_per_attempt
    dc2_cost_total = dc2_price * dc_per_attempt
    install_cost = 10000  # base installation fee for invention (not 250k like manufacturing)
    if system_cost_index:
        install_cost = 10000 * (1 + system_cost_index * 100)
    
    total_cost_per_attempt = dc1_cost_total + dc2_cost_total + decryptor_price + install_cost
    expected_cost = total_cost_per_attempt / max(probability, 0.01)
    
    # Try to get T2 product price
    t2_price = 0
    t2_item = None
    if t2_candidates:
        t2_item = t2_candidates[0]
        t2_price_data = await _get_price(db, t2_item["type_id"])
        t2_price = t2_price_data or 0
    
    # Profit estimate
    t2_revenue = t2_price * t2_runs
    profit_per_success = t2_revenue - total_cost_per_attempt
    expected_profit = (t2_price * t2_runs * probability) - total_cost_per_attempt
    
    return {
        "blueprint": {
            "type_id": bp_item.type_id,
            "name": bp_item.name,
            "group_name": bp_item.group_name,
        },
        "t2_product": t2_item,
        "probability": round(probability, 4),
        "base_probability": base_prob,
        "t2_bpc_runs": t2_runs,
        "t2_me": t2_me,
        "t2_te": t2_te,
        "datacores": {
            "type_1": {"type_id": dc_info["dc1_id"], "name": dc_info["dc1_name"],
                       "quantity": dc_per_attempt, "unit_price": round(dc1_price, 2)},
            "type_2": {"type_id": dc_info["dc2_id"], "name": dc_info["dc2_name"],
                       "quantity": dc_per_attempt, "unit_price": round(dc2_price, 2)},
        },
        "decryptor": decryptor,
        "costs": {
            "datacore_1": round(dc1_cost_total, 2),
            "datacore_2": round(dc2_cost_total, 2),
            "decryptor": round(decryptor_price, 2),
            "installation": round(install_cost, 2),
            "total_per_attempt": round(total_cost_per_attempt, 2),
            "expected_cost_per_success": round(expected_cost, 2),
        },
        "profit": {
            "t2_unit_price": round(t2_price, 2),
            "t2_revenue_per_success": round(t2_revenue, 2),
            "profit_per_success": round(profit_per_success, 2),
            "expected_profit_per_attempt": round(expected_profit, 2),
        },
        "skills": {
            "encryption": skill_encryption,
            "datacore_1": skill_datacore_1,
            "datacore_2": skill_datacore_2,
        },
        "system_cost_index": system_cost_index,
    }


async def _get_price(db: AsyncSession, type_id: int) -> Optional[float]:
    """Get cached sell price for a type."""
    stmt = select(CachedPrice).where(CachedPrice.type_id == type_id)
    result = await db.execute(stmt)
    price = result.scalars().first()
    if price:
        return price.sell_price_min or price.average_price or price.adjusted_price
    return None
