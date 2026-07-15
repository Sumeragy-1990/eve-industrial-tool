import asyncio,math
from sqlalchemy import text
from app.database import engine
async def t():
    async with engine.connect() as c:
        tests=[(34,4540536),(35,2270268),(36,340541),(37,113514),(38,13622),(39,3406),(40,1703),(57479,1),(57486,66),(57478,131)]
        me=10
        for tid,eve in tests:
            r=await c.execute(text("SELECT quantity FROM sde_blueprint_materials WHERE type_id=688 AND activity_id=1 AND material_type_id=:tid"),{"tid":tid})
            row=r.fetchone()
            if row:
                base=row[0]
                res=math.ceil(base*(1-me/100)*0.98*0.99)
                ok="OK" if res==eve else f"DIFF={res-eve}"
                print(f"mat {tid}: base={base} -> {res} (EVE={eve}) {ok}")
            else:
                print(f"mat {tid}: NOT FOUND")
asyncio.run(t())
