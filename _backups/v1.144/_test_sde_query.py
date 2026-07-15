import asyncio
from sqlalchemy import text
from app.database import engine
async def t():
    async with engine.connect() as c:
        r=await c.execute(text("SELECT material_type_id, quantity FROM sde_blueprint_materials WHERE type_id=688 AND activity_id=1 ORDER BY material_type_id"))
        for row in r:
            print(f"  mat {row[0]}: qty={row[1]}")
asyncio.run(t())
