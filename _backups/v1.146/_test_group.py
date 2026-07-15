import asyncio
from sqlalchemy import text
from app.database import engine
async def t():
    async with engine.connect() as c:
        r = await c.execute(text("SELECT type_id, name, group_id, group_name FROM sde_items WHERE type_id=638"))
        row = r.fetchone()
        if row: print(f"Raven: type_id={row[0]} name={row[1]} group_id={row[2]} group_name={row[3]}")
asyncio.run(t())
