"""Low-level ESI API client with automatic token refresh."""

import time
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.character import Character

logger = logging.getLogger(__name__)

ESI_BASE = "https://esi.evetech.net/latest"
SSO_TOKEN_URL = "https://login.eveonline.com/v2/oauth/token"
SSO_VERIFY_URL = "https://login.eveonline.com/oauth/verify"


class ESIError(Exception):
    """Raised when an ESI call fails."""


class ESIClient:
    """HTTP client for ESI endpoints with automatic auth handling."""

    def __init__(self, db_session: AsyncSession):
        self.db = db_session
        self._http = httpx.AsyncClient(
            headers={"User-Agent": settings.eve_useragent},
            timeout=30,
        )

    async def close(self):
        await self._http.aclose()

    # ── Token refresh ──────────────────────────────────────────

    async def _refresh_token(self, character: Character) -> str:
        """Use the refresh_token to get a new access_token."""
        logger.info(f"Refreshing token for {character.character_name}")
        data = {
            "grant_type": "refresh_token",
            "refresh_token": character.refresh_token,
        }
        auth = httpx.BasicAuth(settings.eve_client_id, settings.eve_secret_key)
        resp = await self._http.post(SSO_TOKEN_URL, data=data, auth=auth)
        if resp.is_error:
            raise ESIError(f"Token refresh failed: {resp.status_code} {resp.text}")

        token_data = resp.json()
        character.access_token = token_data["access_token"]
        character.refresh_token = token_data.get(
            "refresh_token", character.refresh_token
        )
        character.token_expires_at = datetime.now(timezone.utc) + timedelta(
            seconds=token_data.get("expires_in", 1200)
        )
        await self.db.merge(character)
        await self.db.commit()
        return character.access_token

    async def _get_valid_token(self, character: Character) -> str:
        """Return a valid access token, refreshing if needed."""
        if not character.access_token:
            raise ESIError(f"No token for {character.character_name}")

        expires = character.token_expires_at
        # Handle both datetime and legacy float (unix timestamp) values
        if expires is not None:
            if isinstance(expires, (int, float)):
                # Legacy: stored as unix timestamp float
                expires_ts = float(expires)
            else:
                expires_ts = expires.timestamp()
            if time.time() >= expires_ts - 60:
                return await self._refresh_token(character)
        else:
            # No expiry known – refresh to be safe
            return await self._refresh_token(character)
        return character.access_token

    # ── Authenticated request ──────────────────────────────────

    async def _auth_get(
        self, character: Character, path: str, params: Optional[dict] = None
    ) -> Any:
        """Make an authenticated GET request to ESI."""
        token = await self._get_valid_token(character)
        url = f"{ESI_BASE}{path}"
        headers = {"Authorization": f"Bearer {token}"}

        resp = await self._http.get(url, headers=headers, params=params)
        if resp.status_code == 401:
            # Try once with a fresh token
            token = await self._refresh_token(character)
            headers["Authorization"] = f"Bearer {token}"
            resp = await self._http.get(url, headers=headers, params=params)

        if resp.is_error:
            raise ESIError(
                f"ESI GET {path} failed: {resp.status_code} {resp.text[:200]}"
            )
        return resp.json()

    async def _auth_paginated(
        self, character: Character, path: str, params: Optional[dict] = None
    ) -> list:
        """Fetch all pages of a paginated ESI endpoint."""
        params = dict(params or {})
        params["page"] = 1
        all_items = []

        while True:
            try:
                data = await self._auth_get(character, path, params)
            except ESIError as exc:
                # ESI returns 404 when requesting a page beyond the last one.
                # Treat this as "no more pages" rather than a fatal error.
                if params["page"] > 1 and "404" in str(exc):
                    logger.debug(
                        "Got 404 on page %s for %s — no more pages.",
                        params["page"],
                        path,
                    )
                    break
                raise

            all_items.extend(data if isinstance(data, list) else [data])
            params["page"] += 1
            # ESI returns empty list when no more pages
            if not data or (isinstance(data, list) and len(data) == 0):
                break
            # Safety cap
            if params["page"] > 100:
                break

        return all_items

    # ── ESI Endpoints ──────────────────────────────────────────

    async def get_character_assets(
        self, character: Character
    ) -> list[dict]:
        """Fetch all assets for a character (paginated)."""
        return await self._auth_paginated(
            character, f"/characters/{character.character_id}/assets/"
        )

    async def get_corporation_assets(
        self, character: Character, corporation_id: int
    ) -> list[dict]:
        """Fetch all assets for a corporation (requires Director role)."""
        return await self._auth_paginated(
            character, f"/corporations/{corporation_id}/assets/"
        )

    async def get_character(
        self, character_id: int
    ) -> dict:
        """Public info about a character (no auth needed)."""
        resp = await self._http.get(f"{ESI_BASE}/characters/{character_id}/")
        if resp.is_error:
            raise ESIError(f"Failed to get character info: {resp.status_code}")
        return resp.json()

    async def get_corporation(
        self, corporation_id: int
    ) -> dict:
        """Public info about a corporation (no auth needed)."""
        resp = await self._http.get(
            f"{ESI_BASE}/corporations/{corporation_id}/"
        )
        if resp.is_error:
            raise ESIError(f"Failed to get corporation info: {resp.status_code}")
        return resp.json()

    async def get_corporation_divisions(
        self, character: Character, corporation_id: int
    ) -> dict:
        """Get hangar division names for a corporation."""
        return await self._auth_get(
            character,
            f"/corporations/{corporation_id}/divisions/",
        )

    async def get_universe_names(
        self, ids: list[int]
    ) -> list[dict]:
        """Resolve names for a batch of IDs (universe endpoint).

        ESI limits this endpoint to 1000 IDs per request, so large
        batches are split automatically.
        """
        results: list[dict] = []
        chunk_size = 1000
        for i in range(0, len(ids), chunk_size):
            chunk = ids[i : i + chunk_size]
            resp = await self._http.post(
                f"{ESI_BASE}/universe/names/",
                json=chunk,
            )
            if resp.is_error:
                raise ESIError(
                    f"Failed to resolve names (batch {i//chunk_size}): "
                    f"{resp.status_code}"
                )
            results.extend(resp.json())
        return results

    async def get_universe_types(
        self, type_id: int
    ) -> dict:
        """Get type info from ESI."""
        resp = await self._http.get(f"{ESI_BASE}/universe/types/{type_id}/")
        if resp.is_error:
            raise ESIError(f"Failed to get type {type_id}: {resp.status_code}")
        return resp.json()

    async def get_universe_groups(
        self, group_id: int
    ) -> dict:
        """Get group info from ESI (returns category_id among other fields)."""
        resp = await self._http.get(f"{ESI_BASE}/universe/groups/{group_id}/")
        if resp.is_error:
            raise ESIError(f"Failed to get group {group_id}: {resp.status_code}")
        return resp.json()

    async def get_universe_structure(
        self, character: Character, structure_id: int
    ) -> dict:
        """Get structure info from ESI (uses auth, returns name + solar system).

        ESI /universe/structures/{structure_id}/ requires authentication
        and returns the structure name, solar system ID, etc.
        """
        return await self._auth_get(
            character,
            f"/universe/structures/{structure_id}/",
        )

    async def get_character_roles(
        self, character: Character
    ) -> list[dict]:
        """Get corporation roles for a character."""
        return await self._auth_get(
            character,
            f"/characters/{character.character_id}/roles/",
        )

    async def get_character_blueprints(
        self, character: Character
    ) -> list[dict]:
        """Get blueprints for a character."""
        return await self._auth_paginated(
            character,
            f"/characters/{character.character_id}/blueprints/",
        )

    async def get_corporation_blueprints(
        self, character: Character, corporation_id: int
    ) -> list[dict]:
        """Get blueprints for a corporation."""
        return await self._auth_paginated(
            character,
            f"/corporations/{corporation_id}/blueprints/",
        )

    # ── Corp Member Endpoints ──────────────────────────────────

    async def get_corporation_members(
        self, character: Character, corporation_id: int
    ) -> list[int]:
        """Fetch member character IDs for a corporation."""
        return await self._auth_get(
            character,
            f"/corporations/{corporation_id}/members/",
        )

    async def get_corporation_members_online(
        self, character: Character, corporation_id: int
    ) -> list[dict]:
        """Fetch online status for all corporation members."""
        return await self._auth_get(
            character,
            f"/corporations/{corporation_id}/members/online/",
        )

    async def get_character_location(
        self, character: Character
    ) -> dict:
        """Fetch current location (solar system / station / structure) for a character."""
        return await self._auth_get(
            character,
            f"/characters/{character.character_id}/location/",
        )

    async def get_character_ship(
        self, character: Character
    ) -> dict:
        """Fetch current ship for a character."""
        return await self._auth_get(
            character,
            f"/characters/{character.character_id}/ship/",
        )

    # ── Character Skills Endpoints ──────────────────────────────

    async def get_character_skills(
        self, character: Character
    ) -> dict:
        """Fetch all skills for a character.

        Returns {'skills': [{'skill_id': int, 'active_skill_level': int, ...}]}
        """
        return await self._auth_get(
            character,
            f"/characters/{character.character_id}/skills/",
        )

    # ── Industry Job Endpoints ──────────────────────────────────

    async def get_character_industry_jobs(
        self, character: Character
    ) -> list[dict]:
        """Fetch industry jobs for a character (paginated)."""
        return await self._auth_paginated(
            character,
            f"/characters/{character.character_id}/industry/jobs/",
        )

    async def get_corporation_industry_jobs(
        self, character: Character, corporation_id: int
    ) -> list[dict]:
        """Fetch industry jobs for a corporation (paginated). Requires Director role."""
        return await self._auth_paginated(
            character,
            f"/corporations/{corporation_id}/industry/jobs/",
        )

    async def get_industry_systems(self) -> list[dict]:
        """Fetch cost indices for all solar systems (public endpoint)."""
        resp = await self._http.get(f"{ESI_BASE}/industry/systems/")
        if resp.is_error:
            raise ESIError(f"Failed to get industry systems: {resp.status_code}")
        return resp.json()
