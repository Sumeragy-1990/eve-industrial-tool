import asyncio
from sqlalchemy import text
from app.database import engine
async def t():
    async with engine.connect() as c:
        rigs = ["m_basic_large_ship_mat_1","m_basic_medium_ship_mat_1","m_adv_component_mat_1"]
        for rig in rigs:
            r = await c.execute(text("SELECT material_bonus FROM rigs WHERE rig_id=:r"), {"r": rig})
            row = r.fetchone()
            if row:
                print(f"DB: {rig} = {row[0]}")
            else:
                print(f"DB: {rig} = NOT FOUND (use fallback 0.02)")
asyncio.run(t())
