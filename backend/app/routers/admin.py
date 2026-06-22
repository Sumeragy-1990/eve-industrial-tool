"""Admin endpoints for bootstrap, SDE import, and system management.

Provides the /api/admin/bootstrap endpoint that triggers the initial
SDE PostgreSQL import and database setup. This is the first thing a
user runs after deploying the tool.
"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Bootstrap status tracker
_bootstrap_status = {
    "status": "idle",
    "progress": "",
    "stats": None,
}


@router.get("/bootstrap/status")
async def get_bootstrap_status():
    """Get the status of a running or completed bootstrap."""
    return _bootstrap_status


async def _run_bootstrap():
    """Run the complete bootstrap process in background."""
    _bootstrap_status["status"] = "running"
    _bootstrap_status["progress"] = "Starting bootstrap..."
    _bootstrap_status["stats"] = None

    try:
        from app.database import async_session_factory, init_db as init_database

        # Step 1: Initialize database tables
        _bootstrap_status["progress"] = "Initializing database tables..."
        logger.info("Bootstrap: initializing database tables")
        await init_database()
        _bootstrap_status["progress"] = "Database tables created."

        # Step 2: Run SDE import (this takes a while)
        _bootstrap_status["progress"] = "Starting SDE PostgreSQL import (this takes 10-20 minutes)..."
        logger.info("Bootstrap: starting SDE import")

        async with async_session_factory() as db:
            from app.services.sde_pg_importer import import_sde_pg

            def progress_callback(msg: str, pct: int):
                _bootstrap_status["progress"] = msg

            stats = await import_sde_pg(db_session=db, progress_callback=progress_callback)

            _bootstrap_status["stats"] = stats
            _bootstrap_status["status"] = "completed"
            _bootstrap_status["progress"] = (
                f"Bootstrap complete! "
                f"Items: {stats.get('types_imported', 0)}, "
                f"Blueprints: {stats.get('blueprints', 0)}, "
                f"Systems: {stats.get('systems', 0)}, "
                f"Stations: {stats.get('stations', 0)}"
            )
            logger.info(f"Bootstrap completed: {stats}")

    except Exception as e:
        logger.error(f"Bootstrap failed: {e}", exc_info=True)
        _bootstrap_status["status"] = "error"
        _bootstrap_status["progress"] = f"Bootstrap failed: {str(e)}"


@router.post("/bootstrap")
async def trigger_bootstrap(background_tasks: BackgroundTasks):
    """Trigger the initial bootstrap process (SDE import + DB setup).

    This is the FIRST endpoint to call after deploying the tool.
    It downloads the complete SDE from Fuzzwork (PostgreSQL dump)
    and imports everything into the local database.

    The process runs in the background. Poll /api/admin/bootstrap/status
    to check progress.
    """
    if _bootstrap_status["status"] == "running":
        raise HTTPException(status_code=409, detail="Bootstrap already running")

    _bootstrap_status["status"] = "pending"
    background_tasks.add_task(_run_bootstrap)

    return {
        "status": "started",
        "message": "Bootstrap process started. This will take 10-20 minutes.",
    }


# ── System Health ──────────────────────────────────────────────


@router.get("/health")
async def admin_health():
    """Extended health check with system info."""
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": "1.0.0",
        "bootstrap_status": _bootstrap_status["status"],
    }


@router.get("/db/stats")
async def get_db_stats(db: AsyncSession = Depends(get_session)):
    """Get database table statistics."""
    stats = {}
    tables = [
        "sde_items", "sde_blueprints", "sde_blueprint_materials",
        "sde_blueprint_products", "sde_blueprint_skills",
        "sde_solar_systems", "sde_regions", "sde_stations",
        "characters", "assets", "location_aliases",
        "corp_warehouse_configs",
    ]
    for table in tables:
        try:
            result = await db.execute(f"SELECT COUNT(*) FROM {table}")
            stats[table] = result.scalar() or 0
        except Exception:
            stats[table] = -1  # table doesn't exist yet
    return stats
