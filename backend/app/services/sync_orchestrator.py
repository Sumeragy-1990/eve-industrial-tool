"""Sync Orchestrator – coordinates multi-character full sync across all domains.

Runs asset sync, blueprint sync, corp member sync, industry job sync,
and market price refresh in sequence, with unified progress tracking.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

from app.database import async_session_factory
from app.models.character import Character
from sqlalchemy import select

logger = logging.getLogger(__name__)

# ── Unified sync status tracker ─────────────────────────────────

_sync_status: dict = {
    "status": "idle",          # idle | running | completed | error
    "progress": "",
    "steps": [],
    "current_step": 0,
    "total_steps": 0,
    "started_at": None,
    "completed_at": None,
    "errors": [],
}

# ── Auto-sync settings (in-memory, configurable via API) ────────

_auto_sync_settings = {
    "enabled": False,
    "asset_interval_hours": 4,
    "blueprint_interval_hours": 6,
    "member_interval_hours": 6,
    "industry_interval_hours": 4,
    "price_interval_hours": 4,
}

_auto_sync_task: Optional[asyncio.Task] = None


def _reset_status():
    _sync_status.update({
        "status": "running",
        "progress": "Starting...",
        "steps": [],
        "current_step": 0,
        "total_steps": 0,
        "started_at": datetime.utcnow().isoformat(),
        "completed_at": None,
        "errors": [],
    })


def _add_step(name: str):
    _sync_status["steps"].append({
        "name": name,
        "status": "pending",
        "progress": "",
    })
    _sync_status["total_steps"] = len(_sync_status["steps"])


def _update_step(idx: int, status: str, progress: str = ""):
    steps = _sync_status["steps"]
    if idx < len(steps):
        steps[idx]["status"] = status
        steps[idx]["progress"] = progress
    _sync_status["current_step"] = idx
    _sync_status["progress"] = f"[{idx + 1}/{len(steps)}] {steps[idx]['name']}: {progress}"


# ── Sync orchestration ──────────────────────────────────────────

STEP_ASSETS = "Assets"
STEP_BLUEPRINTS = "Blueprints"
STEP_CORP_MEMBERS = "Corp Members"
STEP_INDUSTRY_JOBS = "Industry Jobs"
STEP_MARKET_PRICES = "Market Prices"


async def run_full_sync(
    character_ids: list[int] = None,
    steps: list[str] = None,
    sync_corp: bool = True,
):
    """Run a full sync across all domains for given characters.

    Args:
        character_ids: List of character IDs to sync. If None, syncs all.
        steps: Which sync steps to run. If None, runs all.
        sync_corp: Whether to also sync corporation-level data.
    """
    _reset_status()

    if steps is None:
        steps = [STEP_ASSETS, STEP_BLUEPRINTS, STEP_CORP_MEMBERS,
                 STEP_INDUSTRY_JOBS, STEP_MARKET_PRICES]

    for step_name in steps:
        _add_step(step_name)

    try:
        async with async_session_factory() as db:
            # Resolve characters
            if character_ids:
                stmt = select(Character).where(
                    Character.character_id.in_(character_ids)
                )
            else:
                stmt = select(Character)
            result = await db.execute(stmt)
            characters = list(result.scalars().all())

            if not characters:
                _sync_status["status"] = "error"
                _sync_status["progress"] = "No characters found to sync"
                return

            char_ids = [c.character_id for c in characters]
            logger.info(f"Full sync starting for {len(characters)} character(s): {char_ids}")

            # ── Step 1: Assets ──────────────────────────────
            if STEP_ASSETS in steps:
                await _sync_assets_step(db, characters, sync_corp)

            # ── Step 2: Blueprints ──────────────────────────
            if STEP_BLUEPRINTS in steps:
                await _sync_blueprints_step(db, characters)

            # ── Step 3: Corp Members ────────────────────────
            if STEP_CORP_MEMBERS in steps:
                await _sync_corp_members_step(db, characters)

            # ── Step 4: Industry Jobs ────────────────────────
            if STEP_INDUSTRY_JOBS in steps:
                await _sync_industry_jobs_step(db, characters)

            # ── Step 5: Market Prices ────────────────────────
            if STEP_MARKET_PRICES in steps:
                await _sync_market_prices_step(db)

            _sync_status["status"] = "completed"
            _sync_status["completed_at"] = datetime.utcnow().isoformat()
            _sync_status["progress"] = "Full sync complete"

            logger.info(
                f"Full sync completed. "
                f"Errors: {len(_sync_status['errors'])}"
            )

    except Exception as e:
        logger.error(f"Full sync failed: {e}")
        _sync_status["status"] = "error"
        _sync_status["progress"] = str(e)


async def _sync_assets_step(db, characters, sync_corp: bool):
    """Sync personal (and optionally corp) assets for all characters."""
    from app.services.asset_sync import sync_character_assets, sync_corporation_assets

    step_idx = _sync_status["steps"].index(
        next(s for s in _sync_status["steps"] if s["name"] == STEP_ASSETS)
    )
    _update_step(step_idx, "running", f"Syncing assets for {len(characters)} character(s)...")

    for i, character in enumerate(characters):
        try:
            _update_step(step_idx, "running",
                         f"Personal assets: {character.character_name} ({i + 1}/{len(characters)})")
            await sync_character_assets(db, character)

            if sync_corp and character.corporation_id:
                _update_step(step_idx, "running",
                             f"Corp assets: {character.character_name} ({i + 1}/{len(characters)})")
                try:
                    await sync_corporation_assets(db, character, character.corporation_id)
                except Exception as e:
                    logger.warning(f"Corp asset sync failed for {character.character_name}: {e}")
                    _sync_status["errors"].append(
                        f"Corp asset sync ({character.character_name}): {e}"
                    )
        except Exception as e:
            logger.warning(f"Asset sync failed for {character.character_name}: {e}")
            _sync_status["errors"].append(
                f"Asset sync ({character.character_name}): {e}"
            )

    _update_step(step_idx, "completed", f"Assets synced for {len(characters)} character(s)")


async def _sync_blueprints_step(db, characters):
    """Sync blueprints for all characters (personal + corporation)."""
    from app.services.blueprint_sync import (
        sync_character_blueprints,
        sync_corporation_blueprints,
    )

    step_idx = _sync_status["steps"].index(
        next(s for s in _sync_status["steps"] if s["name"] == STEP_BLUEPRINTS)
    )
    _update_step(step_idx, "running", f"Syncing blueprints for {len(characters)} character(s)...")

    # ── Personal blueprints ─────────────────────────────────────
    for i, character in enumerate(characters):
        try:
            _update_step(step_idx, "running",
                         f"{character.character_name} ({i + 1}/{len(characters)})")
            await sync_character_blueprints(db, character)
        except Exception as e:
            logger.warning(f"Blueprint sync failed for {character.character_name}: {e}")
            _sync_status["errors"].append(
                f"Blueprint sync ({character.character_name}): {e}"
            )

    # ── Corporation blueprints ──────────────────────────────────
    for character in characters:
        if character.has_corp_roles and character.corporation_id:
            try:
                _update_step(step_idx, "running",
                             f"Corp blueprints via {character.character_name}")
                await sync_corporation_blueprints(
                    db, character, character.corporation_id
                )
            except Exception as e:
                logger.warning(
                    f"Corp blueprint sync failed for {character.character_name}: {e}"
                )
                _sync_status["errors"].append(
                    f"Corp blueprint sync ({character.character_name}): {e}"
                )

    _update_step(step_idx, "completed",
                 f"Blueprints synced (personal + corp) for {len(characters)} character(s)")


async def _sync_corp_members_step(db, characters):
    """Sync corp members for characters with Director roles."""
    from app.services.corp_member_sync import sync_corp_members

    step_idx = _sync_status["steps"].index(
        next(s for s in _sync_status["steps"] if s["name"] == STEP_CORP_MEMBERS)
    )
    _update_step(step_idx, "running", "Syncing corp members...")

    for character in characters:
        if not character.has_corp_roles or not character.corporation_id:
            continue
        try:
            _update_step(step_idx, "running",
                         f"Members for {character.character_name}")
            await sync_corp_members(db, character, character.corporation_id)
        except Exception as e:
            logger.warning(f"Member sync failed for {character.character_name}: {e}")
            _sync_status["errors"].append(
                f"Member sync ({character.character_name}): {e}"
            )

    _update_step(step_idx, "completed", "Corp members synced")


async def _sync_industry_jobs_step(db, characters):
    """Sync industry jobs for all characters."""
    from app.services.industry_job_sync import sync_character_industry_jobs

    step_idx = _sync_status["steps"].index(
        next(s for s in _sync_status["steps"] if s["name"] == STEP_INDUSTRY_JOBS)
    )
    _update_step(step_idx, "running", f"Syncing industry jobs for {len(characters)} character(s)...")

    for i, character in enumerate(characters):
        try:
            _update_step(step_idx, "running",
                         f"{character.character_name} ({i + 1}/{len(characters)})")
            await sync_character_industry_jobs(db, character)
        except Exception as e:
            logger.warning(f"Industry job sync failed for {character.character_name}: {e}")
            _sync_status["errors"].append(
                f"Industry job sync ({character.character_name}): {e}"
            )

    _update_step(step_idx, "completed", f"Industry jobs synced for {len(characters)} character(s)")


async def _sync_market_prices_step(db):
    """Refresh market prices."""
    from app.services.market_service import refresh_all_prices

    step_idx = _sync_status["steps"].index(
        next(s for s in _sync_status["steps"] if s["name"] == STEP_MARKET_PRICES)
    )
    _update_step(step_idx, "running", "Refreshing market prices...")

    try:
        stats = await refresh_all_prices(db)
        _update_step(step_idx, "completed",
                     f"Prices refreshed: {stats.get('updated', 0)} updated, "
                     f"{stats.get('errors', 0)} errors")
    except Exception as e:
        logger.warning(f"Market price refresh failed: {e}")
        _sync_status["errors"].append(f"Market price refresh: {e}")
        _update_step(step_idx, "error", str(e))


# ── Status query ────────────────────────────────────────────────


def get_sync_status() -> dict:
    """Return current sync orchestrator status."""
    return {
        ** _sync_status,
        "errors_count": len(_sync_status["errors"]),
    }


def get_auto_sync_settings() -> dict:
    """Return current auto-sync settings."""
    return _auto_sync_settings.copy()


def update_auto_sync_settings(settings: dict) -> dict:
    """Update auto-sync settings."""
    for key in ("enabled", "asset_interval_hours", "blueprint_interval_hours",
                "member_interval_hours", "industry_interval_hours", "price_interval_hours"):
        if key in settings:
            _auto_sync_settings[key] = settings[key]
    return _auto_sync_settings.copy()


# ── Auto-sync background loop ───────────────────────────────────


async def _auto_sync_loop():
    """Background loop that periodically triggers full syncs."""
    logger.info("Auto-sync loop started")

    while True:
        settings = _auto_sync_settings
        if not settings["enabled"]:
            await asyncio.sleep(60)
            continue

        # Determine shortest interval to wake up
        min_interval = min(
            settings["asset_interval_hours"],
            settings["blueprint_interval_hours"],
            settings["member_interval_hours"],
            settings["industry_interval_hours"],
            settings["price_interval_hours"],
        )

        # Wait for the minimum interval
        await asyncio.sleep(min_interval * 3600)

        if not _auto_sync_settings["enabled"]:
            continue

        # Don't start a new sync if one is already running
        if _sync_status["status"] == "running":
            logger.info("Auto-sync skipped: another sync is already running")
            continue

        logger.info("Auto-sync: starting full sync")
        try:
            await run_full_sync()
        except Exception as e:
            logger.error(f"Auto-sync failed: {e}")


def start_auto_sync():
    """Start the auto-sync background loop (called once on app startup)."""
    global _auto_sync_task
    if _auto_sync_task is None or _auto_sync_task.done():
        _auto_sync_task = asyncio.create_task(_auto_sync_loop())
        logger.info("Auto-sync background task created")


def stop_auto_sync():
    """Cancel the auto-sync background loop."""
    global _auto_sync_task
    if _auto_sync_task and not _auto_sync_task.done():
        _auto_sync_task.cancel()
        _auto_sync_task = None
        logger.info("Auto-sync background task cancelled")
