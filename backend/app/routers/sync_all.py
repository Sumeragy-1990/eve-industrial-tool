"""Unified Sync Router – orchestrates a full sync across all domains.

Endpoints:
  POST /api/sync/all             – Trigger a full sync for selected characters
  GET  /api/sync/all/status      – Poll current sync progress
  GET  /api/sync/all/settings    – Get auto-sync settings
  POST /api/sync/all/settings    – Update auto-sync settings
"""

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.character import Character
from app.routers.auth import require_account, get_owned_character_ids
from app.services.sync_orchestrator import (
    run_full_sync,
    get_sync_status,
    get_auto_sync_settings,
    update_auto_sync_settings,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.post("/all")
async def trigger_full_sync(
    background_tasks: BackgroundTasks,
    character_ids: Optional[str] = Query(
        None,
        description="Comma-separated character IDs. If omitted, syncs all characters.",
    ),
    sync_corp: bool = Query(True, description="Also sync corporation-level data"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Trigger a full sync across all domains (assets, blueprints, members, industry, prices).

    This runs in the background – poll /api/sync/all/status for progress.
    Only the account's own characters may be synced.
    """
    # Check if sync is already running
    status = get_sync_status()
    if status["status"] == "running":
        raise HTTPException(
            status_code=409,
            detail="A sync is already in progress. Wait for it to complete or check its status.",
        )

    owned_ids = await get_owned_character_ids(db, user_id)

    # Resolve character IDs – restricted to the account's own characters
    ids = None
    if character_ids:
        try:
            ids = [int(x.strip()) for x in character_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail="Invalid character_ids format. Use comma-separated integers.",
            )

        # Reject any character that is not owned by this account
        not_owned = [cid for cid in ids if cid not in owned_ids]
        if not_owned:
            raise HTTPException(
                status_code=403,
                detail=f"Not authorized for characters: {not_owned}",
            )
    else:
        # No explicit selection → sync only the account's own characters
        ids = owned_ids
        if not ids:
            raise HTTPException(
                status_code=404,
                detail="No characters linked to this account.",
            )

    # Start sync in background
    background_tasks.add_task(
        run_full_sync,
        character_ids=ids,
        sync_corp=sync_corp,
    )

    return {
        "status": "started",
        "message": "Full sync started. Poll /api/sync/all/status for progress.",
        "character_ids": ids or "all",
    }


@router.get("/all/status")
async def get_sync_all_status():
    """Get the current status of the full sync orchestrator."""
    return get_sync_status()


@router.get("/all/settings")
async def api_get_auto_sync_settings():
    """Get current auto-sync configuration."""
    return get_auto_sync_settings()


@router.post("/all/settings")
async def api_update_auto_sync_settings(settings: dict):
    """Update auto-sync configuration.

    Accepted keys:
      enabled (bool)
      asset_interval_hours (int)
      blueprint_interval_hours (int)
      member_interval_hours (int)
      industry_interval_hours (int)
      price_interval_hours (int)
    """
    updated = update_auto_sync_settings(settings)
    return {
        "status": "ok",
        "settings": updated,
    }
