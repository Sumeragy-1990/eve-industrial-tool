"""Character Skills router – fetch and cache character skill levels for invention."""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.character import Character
from app.models.character_skill import CharacterSkill
from app.routers.auth import require_auth, require_account, assert_owns_character
from app.services.esi_client import ESIClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/skills", tags=["skills"])

# ── Known invention skill type_ids ───────────────────────────────
# Encryption, Datacore 1, Datacore 2
INVENTION_SKILL_IDS = {
    23121: "Encryption",       # Encryption Methods
    23122: "Datacore - Amarr Starship Engineering",
    23123: "Datacore - Caldari Starship Engineering",
    23124: "Datacore - Gallente Starship Engineering",
    23125: "Datacore - Minmatar Starship Engineering",
    23126: "Datacore - Mechanical Engineering",
    23127: "Datacore - Electronic Engineering",
    23128: "Datacore - High Tech Engineering",
    23129: "Datacore - Nanite Engineering",
    23130: "Datacore - Graviton Physics",
    23131: "Datacore - Plasma Physics",
    23132: "Datacore - Quantum Physics",
    23133: "Datacore - Electromagnetic Physics",
    3402: "Research Project Management",
    3406: "Metallurgy",
    3408: "Laboratory Operation",
    3413: "Scientific Networking",
}


@router.post("/sync/{character_id}")
async def sync_character_skills(
    character_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Fetch and cache character skills from ESI."""
    await assert_owns_character(db, user_id, character_id)

    stmt = select(Character).where(
        Character.character_id == character_id,
        Character.is_active == True,
    )
    result = await db.execute(stmt)
    char = result.scalar_one_or_none()
    if not char:
        raise HTTPException(status_code=404, detail="Character not found")

    client = ESIClient(db)
    try:
        skills_data = await client.get_character_skills(char)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ESI fetch failed: {e}")
    finally:
        await client.close()

    skills_list = skills_data.get("skills", [])

    # Filter to invention-relevant skills + all for flexibility
    known_ids = set(INVENTION_SKILL_IDS.keys())

    # Delete old skill entries for this character
    del_stmt = delete(CharacterSkill).where(CharacterSkill.character_id == character_id)
    await db.execute(del_stmt)

    # Insert new ones
    synced = 0
    for s in skills_list:
        skill_id = s.get("skill_id")
        level = s.get("active_skill_level", 0)
        cs = CharacterSkill(
            character_id=character_id,
            skill_type_id=skill_id,
            skill_level=level,
            last_synced=datetime.now(timezone.utc),
        )
        db.add(cs)
        synced += 1

    await db.flush()
    return {
        "character_id": character_id,
        "skills_synced": synced,
        "message": f"Synced {synced} skills for {char.character_name}",
    }


@router.get("/{character_id}")
async def get_character_skills(
    character_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get cached skills for a character."""
    await assert_owns_character(db, user_id, character_id)

    stmt = select(CharacterSkill).where(CharacterSkill.character_id == character_id)
    result = await db.execute(stmt)
    skills = result.scalars().all()

    skill_list = []
    for s in skills:
        skill_list.append({
            "skill_type_id": s.skill_type_id,
            "skill_level": s.skill_level,
            "name": INVENTION_SKILL_IDS.get(s.skill_type_id, None),
        })

    return {
        "character_id": character_id,
        "skills": skill_list,
        "last_synced": max((s.last_synced for s in skills), default=None),
    }


@router.get("/{character_id}/invention")
async def get_character_invention_skills(
    character_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get the three invention-relevant skill levels for a character.

    Returns encryption, datacore_1, datacore_2 levels for probability calc.
    The caller matches these to the T1 blueprint's required datacore types.
    """
    await assert_owns_character(db, user_id, character_id)

    # The three skill type_ids used in invention: encryption = 23121,
    # and two datacore skills. We need a generic lookup — let the caller
    # pass the specific skill_type_ids they need.
    stmt = select(CharacterSkill).where(
        CharacterSkill.character_id == character_id,
    )
    result = await db.execute(stmt)
    skills = result.scalars().all()

    return {
        "character_id": character_id,
        "skills": {s.skill_type_id: s.skill_level for s in skills},
    }
