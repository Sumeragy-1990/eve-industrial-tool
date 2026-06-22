"""Industry routes – industry job tracking and management."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.character import Character
from app.models.industry_job import IndustryJob
from app.routers.auth import (
    require_account,
    assert_owns_character,
    assert_owns_corporation,
    get_owned_character_ids,
)
from app.services.industry_job_sync import (
    sync_character_industry_jobs,
    sync_corporation_industry_jobs,
)


async def _owned_corp_ids(db: AsyncSession, user_id: int) -> list[int]:
    rows = await db.execute(
        select(Character.corporation_id).where(
            Character.user_id == user_id,
            Character.corporation_id.isnot(None),
        )
    )
    return [cid for (cid,) in rows.all()]

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/industry", tags=["industry"])

# ── Sync ────────────────────────────────────────────────────────


@router.post("/sync/character/{character_id}")
async def trigger_character_job_sync(
    character_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Sync industry jobs for a character from ESI."""
    await assert_owns_character(db, user_id, character_id)
    stmt = select(Character).where(Character.character_id == character_id)
    result = await db.execute(stmt)
    character = result.scalar_one_or_none()

    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    result = await sync_character_industry_jobs(db, character)
    return result


@router.post("/sync/corporation/{corporation_id}")
async def trigger_corporation_job_sync(
    corporation_id: int,
    character_id: int = Query(..., description="Director character ID to auth with"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Sync industry jobs for a corporation from ESI (requires Director role)."""
    await assert_owns_character(db, user_id, character_id)
    await assert_owns_corporation(db, user_id, corporation_id)
    stmt = select(Character).where(Character.character_id == character_id)
    result = await db.execute(stmt)
    character = result.scalar_one_or_none()

    if not character:
        raise HTTPException(status_code=404, detail="Character not found")

    result = await sync_corporation_industry_jobs(db, character, corporation_id)
    return result


# ── List / Query ────────────────────────────────────────────────


@router.get("/jobs")
async def get_industry_jobs(
    character_id: Optional[int] = Query(None, description="Filter by character"),
    corporation_id: Optional[int] = Query(None, description="Filter by corporation"),
    status: Optional[str] = Query(None, description="Filter by status (active, delivered, cancelled, etc.)"),
    activity_id: Optional[int] = Query(None, description="Filter by activity (1=manufacturing, 3=invention, etc.)"),
    is_corp_job: Optional[bool] = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get industry jobs with optional filters (scoped to the current account)."""
    base = select(IndustryJob)

    owned_ids = await get_owned_character_ids(db, user_id)
    owned_corps = await _owned_corp_ids(db, user_id)

    if character_id:
        await assert_owns_character(db, user_id, character_id)
        base = base.where(IndustryJob.character_id == character_id)
    elif corporation_id:
        await assert_owns_corporation(db, user_id, corporation_id)
        base = base.where(IndustryJob.corporation_id == corporation_id)
    else:
        # No explicit filter -> only this account's own char/corp jobs.
        base = base.where(
            (IndustryJob.character_id.in_(owned_ids or [0]))
            | (IndustryJob.corporation_id.in_(owned_corps or [0]))
        )
    if status:
        base = base.where(IndustryJob.status == status)
    if activity_id:
        base = base.where(IndustryJob.activity_id == activity_id)
    if is_corp_job is not None:
        base = base.where(IndustryJob.is_corp_job == is_corp_job)

    # Count total
    count_query = select(func.count()).select_from(base.subquery())
    total = await db.scalar(count_query) or 0

    # Fetch page (most recent first)
    offset = (page - 1) * per_page
    query = base.order_by(IndustryJob.end_date.desc().nullsfirst()).offset(offset).limit(per_page)
    result = await db.execute(query)
    jobs = result.scalars().all()

    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": max(1, (total + per_page - 1) // per_page),
        "jobs": [
            {
                "id": j.id,
                "job_id": j.job_id,
                "character_id": j.character_id,
                "corporation_id": j.corporation_id,
                "blueprint_type_id": j.blueprint_type_id,
                "blueprint_type_name": j.blueprint_type_name,
                "product_type_id": j.product_type_id,
                "product_type_name": j.product_type_name,
                "activity_id": j.activity_id,
                "runs": j.runs,
                "status": j.status,
                "start_date": j.start_date.isoformat() if j.start_date else None,
                "end_date": j.end_date.isoformat() if j.end_date else None,
                "duration": j.duration,
                "location_id": j.location_id,
                "facility_id": j.facility_id,
                "cost": j.cost,
                "licensed_runs": j.licensed_runs,
                "probability": j.probability,
                "successful_runs": j.successful_runs,
                "installer_name": j.installer_name,
                "is_corp_job": j.is_corp_job,
                "last_synced": j.last_synced.isoformat() if j.last_synced else None,
            }
            for j in jobs
        ],
    }


@router.get("/jobs/active")
async def get_active_jobs(
    corporation_id: Optional[int] = Query(None),
    character_id: Optional[int] = Query(None),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get currently active (in-progress) industry jobs (scoped to the account)."""
    base = select(IndustryJob).where(IndustryJob.status.in_(["active", "paused"]))

    owned_ids = await get_owned_character_ids(db, user_id)
    owned_corps = await _owned_corp_ids(db, user_id)

    if character_id:
        await assert_owns_character(db, user_id, character_id)
        base = base.where(IndustryJob.character_id == character_id)
    elif corporation_id:
        await assert_owns_corporation(db, user_id, corporation_id)
        base = base.where(IndustryJob.corporation_id == corporation_id)
    else:
        base = base.where(
            (IndustryJob.character_id.in_(owned_ids or [0]))
            | (IndustryJob.corporation_id.in_(owned_corps or [0]))
        )

    base = base.order_by(IndustryJob.end_date.asc())
    result = await db.execute(base)
    jobs = result.scalars().all()

    return {
        "total": len(jobs),
        "jobs": [
            {
                "id": j.id,
                "job_id": j.job_id,
                "blueprint_type_name": j.blueprint_type_name,
                "product_type_name": j.product_type_name,
                "activity_id": j.activity_id,
                "runs": j.runs,
                "status": j.status,
                "end_date": j.end_date.isoformat() if j.end_date else None,
                "installer_name": j.installer_name,
                "is_corp_job": j.is_corp_job,
            }
            for j in jobs
        ],
    }


@router.get("/jobs/stats")
async def get_industry_stats(
    corporation_id: Optional[int] = Query(None),
    character_id: Optional[int] = Query(None),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get aggregated statistics about industry jobs (scoped to the account)."""
    base = select(IndustryJob)
    owned_ids = await get_owned_character_ids(db, user_id)
    owned_corps = await _owned_corp_ids(db, user_id)

    if character_id:
        await assert_owns_character(db, user_id, character_id)
        base = base.where(IndustryJob.character_id == character_id)
    elif corporation_id:
        await assert_owns_corporation(db, user_id, corporation_id)
        base = base.where(IndustryJob.corporation_id == corporation_id)
    else:
        base = base.where(
            (IndustryJob.character_id.in_(owned_ids or [0]))
            | (IndustryJob.corporation_id.in_(owned_corps or [0]))
        )

    result = await db.execute(base)
    jobs = result.scalars().all()

    total_jobs = len(jobs)
    active_jobs = sum(1 for j in jobs if j.status in ("active", "paused"))
    delivered_jobs = sum(1 for j in jobs if j.status == "delivered")
    cancelled_jobs = sum(1 for j in jobs if j.status == "cancelled")
    total_cost = sum(j.cost or 0 for j in jobs)

    # Count by activity
    by_activity = {}
    for j in jobs:
        act = j.activity_id or 0
        if act not in by_activity:
            by_activity[act] = 0
        by_activity[act] += 1

    return {
        "total_jobs": total_jobs,
        "active_jobs": active_jobs,
        "delivered_jobs": delivered_jobs,
        "cancelled_jobs": cancelled_jobs,
        "total_cost": total_cost,
        "by_activity": by_activity,
    }


@router.delete("/jobs/{job_id}", status_code=204)
async def delete_industry_job(
    job_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Delete a specific industry job record."""
    stmt = select(IndustryJob).where(IndustryJob.id == job_id)
    result = await db.execute(stmt)
    job = result.scalar_one_or_none()

    if not job:
        raise HTTPException(status_code=404, detail="Industry job not found")

    await db.delete(job)
    await db.flush()
    return None
