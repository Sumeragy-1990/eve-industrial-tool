import asyncio
from sqlalchemy import text
from app.database import engine
async def t():
    async with engine.connect() as c:
        r = await c.execute(text("SELECT DISTINCT activity_id FROM sde_blueprint_materials WHERE type_id=688"))
        acts = [row[0] for row in r]
        print("Activities for bp 688:", acts)
        for act in acts:
            r = await c.execute(text("SELECT material_type_id, quantity FROM sde_blueprint_materials WHERE type_id=688 AND activity_id=:act AND material_type_id IN (34,35)"), {"act": act})
            for row in r:
                print(f"  activity {act}: mat={row[0]} qty={row[1]}")
asyncio.run(t())
