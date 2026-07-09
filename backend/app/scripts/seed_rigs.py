"""Seed the rigs table with all Engineering Complex rig data.
Run: python -m app.scripts.seed_rigs
"""
import asyncio
from app.database import get_session, engine
from app.models.rig import Rig
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

RIGS = []

# ── Helper to add rigs ──
def r(rig_id, name, size, tier, category, affects, mat_bonus=0.0, time_bonus=0.0, research_bonus=0.0):
    RIGS.append(dict(
        rig_id=rig_id, name=name, size=size, tier=tier,
        category=category, affects=affects,
        material_bonus=mat_bonus, time_bonus=time_bonus,
        research_bonus=research_bonus,
    ))

# ═══════════════════════════════════════════════════
#  M-SET — Raitaru (Medium Engineering Complex)
# ═══════════════════════════════════════════════════

# Basic Ship Manufacturing (T1 ships)
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    for size_affect in ["small_ship", "medium_ship", "large_ship"]:
        size_label = size_affect.replace("_ship", "").title()
        r(f"m_basic_{size_affect}_mat_{tier}", f"Standup M-Set Basic {size_label} Ship Manufacturing Material Efficiency {'I' if tier==1 else 'II'}", "M", tier, "manufacturing", size_affect, mat_bonus=mat_bonus)
        r(f"m_basic_{size_affect}_time_{tier}", f"Standup M-Set Basic {size_label} Ship Manufacturing Time Efficiency {'I' if tier==1 else 'II'}", "M", tier, "manufacturing", size_affect, time_bonus=time_bonus)

# Advanced Ship Manufacturing (T2 ships)
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    for size_affect in ["small_ship", "medium_ship", "large_ship"]:
        size_label = size_affect.replace("_ship", "").title()
        r(f"m_adv_{size_affect}_mat_{tier}", f"Standup M-Set Advanced {size_label} Ship Manufacturing Material Efficiency {'I' if tier==1 else 'II'}", "M", tier, "manufacturing", size_affect, mat_bonus=mat_bonus)
        r(f"m_adv_{size_affect}_time_{tier}", f"Standup M-Set Advanced {size_label} Ship Manufacturing Time Efficiency {'I' if tier==1 else 'II'}", "M", tier, "manufacturing", size_affect, time_bonus=time_bonus)

# Capital Ship Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"m_capital_ship_mat_{tier}", f"Standup M-Set Capital Ship Manufacturing Material Efficiency {'I' if tier==1 else 'II'}", "M", tier, "manufacturing", "capital_ship", mat_bonus=mat_bonus)
    r(f"m_capital_ship_time_{tier}", f"Standup M-Set Capital Ship Manufacturing Time Efficiency {'I' if tier==1 else 'II'}", "M", tier, "manufacturing", "capital_ship", time_bonus=time_bonus)

# Basic Capital Component Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"m_basic_cap_component_mat_{tier}", f"Standup M-Set Basic Capital Component Manufacturing Material Efficiency {'I' if tier==1 else 'II'}", "M", tier, "component", "capital_component", mat_bonus=mat_bonus)
    r(f"m_basic_cap_component_time_{tier}", f"Standup M-Set Basic Capital Component Manufacturing Time Efficiency {'I' if tier==1 else 'II'}", "M", tier, "component", "capital_component", time_bonus=time_bonus)

# Advanced Component Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"m_adv_component_mat_{tier}", f"Standup M-Set Advanced Component Manufacturing Material Efficiency {'I' if tier==1 else 'II'}", "M", tier, "component", "component", mat_bonus=mat_bonus)
    r(f"m_adv_component_time_{tier}", f"Standup M-Set Advanced Component Manufacturing Time Efficiency {'I' if tier==1 else 'II'}", "M", tier, "component", "component", time_bonus=time_bonus)

# Thukker Capital Component Manufacturing
r("m_thukker_cap_component_mat_1", "Standup M-Set Thukker Capital Component Manufacturing Material Efficiency I", "M", 1, "component", "capital_component", mat_bonus=0.02)
r("m_thukker_cap_component_time_1", "Standup M-Set Thukker Capital Component Manufacturing Time Efficiency I", "M", 1, "component", "capital_component", time_bonus=0.02)

# Equipment Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"m_equipment_mat_{tier}", f"Standup M-Set Equipment Manufacturing Material Efficiency {'I' if tier==1 else 'II'}", "M", tier, "equipment", "equipment", mat_bonus=mat_bonus)
    r(f"m_equipment_time_{tier}", f"Standup M-Set Equipment Manufacturing Time Efficiency {'I' if tier==1 else 'II'}", "M", tier, "equipment", "equipment", time_bonus=time_bonus)

# Ammunition Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"m_ammo_mat_{tier}", f"Standup M-Set Ammunition Manufacturing Material Efficiency {'I' if tier==1 else 'II'}", "M", tier, "ammo", "ammo", mat_bonus=mat_bonus)
    r(f"m_ammo_time_{tier}", f"Standup M-Set Ammunition Manufacturing Time Efficiency {'I' if tier==1 else 'II'}", "M", tier, "ammo", "ammo", time_bonus=time_bonus)

# Drone and Fighter Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"m_drone_mat_{tier}", f"Standup M-Set Drone and Fighter Manufacturing Material Efficiency {'I' if tier==1 else 'II'}", "M", tier, "drone", "drone", mat_bonus=mat_bonus)
    r(f"m_drone_time_{tier}", f"Standup M-Set Drone and Fighter Manufacturing Time Efficiency {'I' if tier==1 else 'II'}", "M", tier, "drone", "drone", time_bonus=time_bonus)

# Structure Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"m_structure_mat_{tier}", f"Standup M-Set Structure Manufacturing Material Efficiency {'I' if tier==1 else 'II'}", "M", tier, "structure", "structure", mat_bonus=mat_bonus)
    r(f"m_structure_time_{tier}", f"Standup M-Set Structure Manufacturing Time Efficiency {'I' if tier==1 else 'II'}", "M", tier, "structure", "structure", time_bonus=time_bonus)

# ME Research
for tier, bonus in [(1, 0.2), (2, 0.24)]:
    r(f"m_me_research_accel_{tier}", f"Standup M-Set ME Research Accelerator {'I' if tier==1 else 'II'}", "M", tier, "research_me", None, research_bonus=bonus)
    r(f"m_me_research_cost_{tier}", f"Standup M-Set ME Research Cost Optimization {'I' if tier==1 else 'II'}", "M", tier, "research_me", None, research_bonus=bonus)

# TE Research
for tier, bonus in [(1, 0.2), (2, 0.24)]:
    r(f"m_te_research_accel_{tier}", f"Standup M-Set TE Research Accelerator {'I' if tier==1 else 'II'}", "M", tier, "research_te", None, research_bonus=bonus)
    r(f"m_te_research_cost_{tier}", f"Standup M-Set TE Research Cost Optimization {'I' if tier==1 else 'II'}", "M", tier, "research_te", None, research_bonus=bonus)

# Blueprint Copying
for tier, bonus in [(1, 0.2), (2, 0.24)]:
    r(f"m_copy_accel_{tier}", f"Standup M-Set Blueprint Copying Accelerator {'I' if tier==1 else 'II'}", "M", tier, "research_copy", None, research_bonus=bonus)
    r(f"m_copy_cost_{tier}", f"Standup M-Set Blueprint Copying Cost Optimization {'I' if tier==1 else 'II'}", "M", tier, "research_copy", None, research_bonus=bonus)

# Invention
for tier, bonus in [(1, 0.2), (2, 0.24)]:
    r(f"m_invention_accel_{tier}", f"Standup M-Set Invention Accelerator {'I' if tier==1 else 'II'}", "M", tier, "research_invention", None, research_bonus=bonus)
    r(f"m_invention_cost_{tier}", f"Standup M-Set Invention Cost Optimization {'I' if tier==1 else 'II'}", "M", tier, "research_invention", None, research_bonus=bonus)

# ═══════════════════════════════════════════════════
#  L-SET — Sotyo (Large Engineering Complex)
# ═══════════════════════════════════════════════════

# Ship Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"l_ship_mat_{tier}", f"Standup L-Set Ship Manufacturing Efficiency {'I' if tier==1 else 'II'}", "L", tier, "manufacturing", "all_ship", mat_bonus=mat_bonus, time_bonus=time_bonus)

# Component Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"l_component_mat_{tier}", f"Standup L-Set Component Manufacturing Efficiency {'I' if tier==1 else 'II'}", "L", tier, "component", "component", mat_bonus=mat_bonus, time_bonus=time_bonus)

# Equipment Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"l_equipment_mat_{tier}", f"Standup L-Set Equipment Manufacturing Efficiency {'I' if tier==1 else 'II'}", "L", tier, "equipment", "equipment", mat_bonus=mat_bonus, time_bonus=time_bonus)

# Consumable Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"l_consumable_mat_{tier}", f"Standup L-Set Consumable Manufacturing Efficiency {'I' if tier==1 else 'II'}", "L", tier, "ammo", "ammo", mat_bonus=mat_bonus, time_bonus=time_bonus)

# Drone and Fighter Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"l_drone_mat_{tier}", f"Standup L-Set Drone and Fighter Manufacturing Efficiency {'I' if tier==1 else 'II'}", "L", tier, "drone", "drone", mat_bonus=mat_bonus, time_bonus=time_bonus)

# Structure Manufacturing
for tier, mat_bonus, time_bonus in [(1, 0.02, 0.02), (2, 0.024, 0.024)]:
    r(f"l_structure_mat_{tier}", f"Standup L-Set Structure Manufacturing Efficiency {'I' if tier==1 else 'II'}", "L", tier, "structure", "structure", mat_bonus=mat_bonus, time_bonus=time_bonus)

# ME Research
for tier, bonus in [(1, 0.2), (2, 0.24)]:
    r(f"l_me_research_{tier}", f"Standup L-Set ME Research Optimization {'I' if tier==1 else 'II'}", "L", tier, "research_me", None, research_bonus=bonus)

# TE Research
for tier, bonus in [(1, 0.2), (2, 0.24)]:
    r(f"l_te_research_{tier}", f"Standup L-Set TE Research Optimization {'I' if tier==1 else 'II'}", "L", tier, "research_te", None, research_bonus=bonus)

# Invention
for tier, bonus in [(1, 0.2), (2, 0.24)]:
    r(f"l_invention_{tier}", f"Standup L-Set Invention Optimization {'I' if tier==1 else 'II'}", "L", tier, "research_invention", None, research_bonus=bonus)

# ═══════════════════════════════════════════════════
#  XL-SET — Azbel (Extra-Large Engineering Complex)
# ═══════════════════════════════════════════════════

# Ship Manufacturing (combined material+time per rig in XL)
for tier, bonus in [(1, 0.02), (2, 0.024)]:
    r(f"xl_ship_{tier}", f"Standup XL-Set Ship Manufacturing Efficiency {'I' if tier==1 else 'II'}", "XL", tier, "manufacturing", "all_ship", mat_bonus=bonus, time_bonus=bonus)

# Equipment and Consumable Manufacturing (combined)
for tier, bonus in [(1, 0.02), (2, 0.024)]:
    r(f"xl_equip_consumable_{tier}", f"Standup XL-Set Equipment and Consumable Manufacturing Efficiency {'I' if tier==1 else 'II'}", "XL", tier, "equipment", "equipment", mat_bonus=bonus, time_bonus=bonus)

# Structure and Component Manufacturing (combined)
for tier, bonus in [(1, 0.02), (2, 0.024)]:
    r(f"xl_struct_component_{tier}", f"Standup XL-Set Structure and Component Manufacturing Efficiency {'I' if tier==1 else 'II'}", "XL", tier, "structure", "structure", mat_bonus=bonus, time_bonus=bonus)

# Laboratory Optimization (covers ME/TE/Invention/Copying)
for tier, bonus in [(1, 0.2), (2, 0.24)]:
    r(f"xl_lab_{tier}", f"Standup XL-Set Laboratory Optimization {'I' if tier==1 else 'II'}", "XL", tier, "research", None, research_bonus=bonus)


async def seed():
    print(f"Seeding {len(RIGS)} rigs...")
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM rigs"))
        for r_data in RIGS:
            await conn.execute(
                text("""
                    INSERT INTO rigs (rig_id, name, size, tier, category, affects, material_bonus, time_bonus, research_bonus)
                    VALUES (:rig_id, :name, :size, :tier, :category, :affects, :material_bonus, :time_bonus, :research_bonus)
                """),
                r_data
            )
    print("Done!")

if __name__ == "__main__":
    asyncio.run(seed())
