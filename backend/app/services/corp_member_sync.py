"""Corp Member synchronisation service – fetches members from ESI and stores them."""

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.character import Character
from app.models.corp_member import CorpMember
from app.services.esi_client import ESIClient

logger = logging.getLogger(__name__)


async def _resolve_character_names(
    client: ESIClient, character_ids: list[int]
) -> dict[int, str]:
    """Resolve character names via ESI universe/names endpoint."""
    result: dict[int, str] = {}
    if not character_ids:
        return result

    try:
        names = await client.get_universe_names(character_ids)
        for entry in names:
            result[entry["id"]] = entry.get("name", str(entry["id"]))
    except Exception as e:
        logger.warning(f"Failed to resolve character names: {e}")

    return result


async def sync_corp_members(
    db: AsyncSession,
    character: Character,
    corporation_id: int,
) -> dict:
    """Full sync of corporation members (list + online status).

    Requires the authenticating character to have the
    esi-corporations.read_corporation_membership.v1 scope.
    """
    client = ESIClient(db)
    try:
        logger.info(
            f"Starting corp member sync for corp {corporation_id} "
            f"via {character.character_name}"
        )

        # ── 1. Fetch member character IDs ──────────────────────
        member_ids: list[int] = await client.get_corporation_members(
            character, corporation_id
        )
        logger.info(f"Got {len(member_ids)} member IDs from ESI")

        if not member_ids:
            return {
                "corporation_id": corporation_id,
                "members_found": 0,
            }

        # ── 2. Resolve character names ─────────────────────────
        name_map = await _resolve_character_names(client, member_ids)

        # ── 3. Fetch online status ──────────────────────────────
        online_data: list[dict] = await client.get_corporation_members_online(
            character, corporation_id
        )
        online_map: dict[int, dict] = {
            entry["character_id"]: entry for entry in online_data
        }
        logger.info(f"Got online status for {len(online_map)} members")

        # ── 4. Store in database ───────────────────────────────
        now = datetime.now(timezone.utc)
        tracked_ids: list[int] = []

        for cid in member_ids:
            tracked_ids.append(cid)
            char_name = name_map.get(cid, f"Character {cid}")
            online_info = online_map.get(cid, {})

            member = CorpMember(
                corporation_id=corporation_id,
                character_id=cid,
                character_name=char_name,
                is_online=online_info.get("online", False),
                last_login=(
                    datetime.fromisoformat(online_info["last_login"])
                    if online_info.get("last_login")
                    else None
                ),
                last_logout=(
                    datetime.fromisoformat(online_info["last_logout"])
                    if online_info.get("last_logout")
                    else None
                ),
                logins_since_start=online_info.get("logins"),
                synced_at=now,
            )
            await db.merge(member)

        # ── 5. Remove stale members (left the corp) ────────────
        if tracked_ids:
            delete_stmt = delete(CorpMember).where(
                CorpMember.corporation_id == corporation_id,
                CorpMember.character_id.notin_(tracked_ids),
            )
            await db.execute(delete_stmt)

        await db.commit()

        return {
            "corporation_id": corporation_id,
            "members_found": len(member_ids),
            "online_count": sum(
                1 for o in online_data if o.get("online")
            ),
        }
    finally:
        await client.close()
